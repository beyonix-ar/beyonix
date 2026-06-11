import { NextResponse } from "next/server"

import { calculateCartTotals } from "@/lib/cart/cart-totals"
import {
  TRANSFER_ALIAS,
  TRANSFER_DISCOUNT_PERCENT,
  calculateTransferDiscount,
} from "@/lib/payments/transfer"
import { getVariantIdFromValue } from "@/lib/products/product-variants"
import { createClient } from "@/lib/supabase/server"
import { getProductDiscount, getShippingCost } from "@/lib/store-config"

interface CheckoutItemPayload {
  productId?: number
  quantity?: number
  variantId?: number | null
  color?: string | null
}

interface CheckoutPayload {
  items?: CheckoutItemPayload[]
  reservationSessionId?: string | null
  customer?: {
    nombre?: string
    email?: string
    telefono?: string
    direccion?: string
    cpDestino?: string
    localidad?: string
    provincia?: string
  }
  shipping?: {
    provider?: string
    type?: "sucursal" | "domicilio"
    costReal?: number
    costCharged?: number
    freeShippingApplied?: boolean
  }
}

interface ProductRow {
  id: number
  nombre: string
  precio: number
  stock: number
  activo: boolean
}

interface VariantRow {
  id: number
  producto_id: number
  nombre: string
  stock: number | null
  activo: boolean
  orden: number | null
}

interface NormalizedItem {
  productId: number
  quantity: number
  variantId: number | null
}

function normalizeItems(items: CheckoutPayload["items"]) {
  if (!Array.isArray(items)) return []

  return items
    .map((item) => ({
      productId: Number(item.productId),
      quantity: Math.trunc(Number(item.quantity)),
      variantId: Number(item.variantId) || getVariantIdFromValue(item.color) || null,
    }))
    .filter(
      (item) =>
        Number.isFinite(item.productId) &&
        Number.isFinite(item.quantity) &&
        item.quantity > 0,
    )
}

function normalizeCustomer(customer: CheckoutPayload["customer"]) {
  return {
    cliente_nombre: customer?.nombre?.trim() || null,
    cliente_email: customer?.email?.trim() || null,
    cliente_telefono: customer?.telefono?.trim() || null,
    cliente_direccion: customer?.direccion?.trim() || null,
    localidad: customer?.localidad?.trim() || null,
    provincia: customer?.provincia?.trim() || null,
  }
}

function normalizeShipping(
  shipping: CheckoutPayload["shipping"],
  productsTotal: number
) {
  const realCost = Number(shipping?.costReal)
  const fallbackCost = getShippingCost(productsTotal)
  const shippingCostReal =
    Number.isFinite(realCost) && realCost >= 0 ? realCost : fallbackCost
  const freeShippingApplied = getShippingCost(productsTotal) === 0
  const chargedCost = freeShippingApplied ? 0 : shippingCostReal
  const requestedChargedCost = Number(shipping?.costCharged)

  return {
    provider: shipping?.provider || "manual",
    type: shipping?.type === "sucursal" ? "sucursal" : "domicilio",
    costReal: shippingCostReal,
    costCharged:
      Number.isFinite(requestedChargedCost) && requestedChargedCost >= 0
        ? Math.min(requestedChargedCost, shippingCostReal)
        : chargedCost,
    freeShippingApplied,
  }
}

function getUnitPrice(product: ProductRow) {
  return Math.round(product.precio * (1 - getProductDiscount(product.id)))
}

function assertStock(item: NormalizedItem, product: ProductRow, variant?: VariantRow) {
  if (!product.activo) {
    throw new Error(`${product.nombre} no esta disponible.`)
  }

  if (variant) {
    if (!variant.activo) {
      throw new Error(`La variante ${variant.nombre} no esta disponible.`)
    }

    if ((variant.stock ?? 0) < item.quantity) {
      throw new Error(`Stock insuficiente para ${product.nombre} (${variant.nombre}).`)
    }

    return
  }

  if (product.stock < item.quantity) {
    throw new Error(`Stock insuficiente para ${product.nombre}.`)
  }
}

async function insertOrderItems(
  supabase: Awaited<ReturnType<typeof createClient>>,
  orderId: number,
  items: NormalizedItem[],
  products: ProductRow[],
) {
  const payload = items.map((item) => {
    const product = products.find((row) => row.id === item.productId)

    return {
      orden_id: orderId,
      producto_id: item.productId,
      variante_id: item.variantId,
      cantidad: item.quantity,
      precio: product ? getUnitPrice(product) : 0,
    }
  })

  const { error } = await supabase.from("orden_items").insert(payload as never)

  if (error) {
    throw new Error(error.message || "No se pudieron crear los items de la orden.")
  }
}

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as CheckoutPayload
    const items = normalizeItems(payload.items)

    if (!items.length) {
      return NextResponse.json({ error: "El carrito esta vacio." }, { status: 400 })
    }

    const supabase = await createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()

    if (!user) {
      return NextResponse.json(
        { error: "Debés iniciar sesión para registrar el pedido." },
        { status: 401 },
      )
    }

    const productIds = [...new Set(items.map((item) => item.productId))]

    const { data: products, error: productsError } = await supabase
      .from("productos")
      .select("id, nombre, precio, stock, activo")
      .in("id", productIds)

    if (productsError) {
      throw new Error("No se pudieron validar los productos.")
    }

    const productRows = (products ?? []) as ProductRow[]

    if (productRows.length !== productIds.length) {
      throw new Error("Hay productos que ya no estan disponibles.")
    }

    const { data: variants, error: variantsError } = await supabase
      .from("producto_variantes")
      .select("id, producto_id, nombre, stock, activo, orden")
      .in("producto_id", productIds)

    if (variantsError) {
      throw new Error("No se pudieron validar las variantes.")
    }

    const variantRows = (variants ?? []) as VariantRow[]
    const variantsById = new Map(variantRows.map((variant) => [variant.id, variant]))
    const variantsByProductId = new Map<number, VariantRow[]>()

    for (const variant of variantRows) {
      const list = variantsByProductId.get(variant.producto_id) ?? []
      list.push(variant)
      list.sort((a, b) => (a.orden ?? 0) - (b.orden ?? 0) || a.id - b.id)
      variantsByProductId.set(variant.producto_id, list)
    }

    for (const item of items) {
      if (!item.variantId) {
        item.variantId =
          variantsByProductId
            .get(item.productId)
            ?.find((variant) => variant.activo)?.id ?? null
      }

      const product = productRows.find((row) => row.id === item.productId)
      if (!product) throw new Error("Producto inexistente.")

      const variant = item.variantId ? variantsById.get(item.variantId) : undefined

      if (item.variantId && (!variant || variant.producto_id !== product.id)) {
        throw new Error(`Variante invalida para ${product.nombre}.`)
      }

      assertStock(item, product, variant)
    }

    const cartRows = items.map((item) => {
      const product = productRows.find((row) => row.id === item.productId)!

      return {
        product,
        quantity: item.quantity,
      }
    })
    const baseTotals = calculateCartTotals(cartRows)
    const shipping = normalizeShipping(payload.shipping, baseTotals.productsTotal)
    const totals = calculateCartTotals(cartRows, {
      shippingCost: shipping.costCharged,
    })
    const transferDiscountAmount = calculateTransferDiscount(totals.total)
    const transferTotal = Math.max(totals.total - transferDiscountAmount, 0)

    const orderPayload = {
      usuario_id: user.id,
      total: transferTotal,
      estado: "pendiente",
      envio_proveedor: shipping.provider,
      andreani_costo: shipping.costCharged,
      payment_method_id: "transferencia",
      payment_type_id: null,
      payment_status: "pendiente_comprobante",
      transfer_alias: TRANSFER_ALIAS,
      transfer_discount_percent: TRANSFER_DISCOUNT_PERCENT,
      transfer_discount_amount: transferDiscountAmount,
      ...normalizeCustomer(payload.customer),
    }

    const { data: order, error: orderError } = await supabase
      .from("ordenes")
      .insert(orderPayload as never)
      .select()
      .single()

    if (orderError || !order) {
      console.error("TRANSFER_CREATE_ORDER_SUPABASE_ERROR", {
        message: orderError?.message,
        details: orderError?.details,
        hint: orderError?.hint,
        code: orderError?.code,
      })

      throw new Error(orderError?.message || "No se pudo crear la orden.")
    }

    await insertOrderItems(supabase, order.id, items, productRows)

    return NextResponse.json({
      order_id: order.id,
      redirect_url: `/checkout/success?method=transferencia&order_id=${order.id}`,
    })
  } catch (error) {
    console.error("Error creando orden por transferencia", error)

    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "No pudimos registrar el pedido por transferencia.",
      },
      { status: 500 },
    )
  }
}
