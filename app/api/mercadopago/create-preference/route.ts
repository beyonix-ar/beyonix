import { MercadoPagoConfig, Preference } from "mercadopago"
import { NextResponse } from "next/server"

import { createClient } from "@/lib/supabase/server"
import {
  getProductDiscount,
} from "@/lib/store-config"
import { calculateCartTotals } from "@/lib/cart/cart-totals"
import { STOCK_CHANGED_MESSAGE } from "@/lib/cart/stock-status"
import { getShippingCost } from "@/lib/store-config"
import { getVariantIdFromValue } from "@/lib/products/product-variants"

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

const accessToken = process.env.MERCADOPAGO_ACCESS_TOKEN

const mercadoPagoClient = accessToken
  ? new MercadoPagoConfig({ accessToken })
  : null

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
    cp_destino: customer?.cpDestino?.trim() || null,
    localidad: customer?.localidad?.trim() || null,
    provincia: customer?.provincia?.trim() || null,
  }
}

function normalizePlaceName(value?: string | null) {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
}

function isRosarioCustomer(customer: CheckoutPayload["customer"]) {
  return normalizePlaceName(customer?.localidad) === "rosario"
}

function normalizeShipping(
  shipping: CheckoutPayload["shipping"],
  productsTotal: number,
  customer: CheckoutPayload["customer"]
) {
  if (isRosarioCustomer(customer)) {
    return {
      shipping_provider: "manual",
      shipping_type: "domicilio",
      shipping_cost_real: 0,
      shipping_cost_charged: 0,
      free_shipping_applied: true,
    }
  }

  const realCost = Number(shipping?.costReal)
  const fallbackCost = getShippingCost(productsTotal)
  const shippingCostReal =
    Number.isFinite(realCost) && realCost > 0 ? realCost : fallbackCost
  const freeShippingApplied = getShippingCost(productsTotal) === 0
  const chargedCost = freeShippingApplied ? 0 : shippingCostReal

  return {
    shipping_provider: shipping?.provider || "manual",
    shipping_type: shipping?.type === "sucursal" ? "sucursal" : "domicilio",
    shipping_cost_real: shippingCostReal,
    shipping_cost_charged: chargedCost,
    free_shipping_applied: freeShippingApplied,
  }
}

function getUnitPrice(product: ProductRow) {
  return Math.round(product.precio * (1 - getProductDiscount(product.id)))
}

function assertStock(item: NormalizedItem, product: ProductRow, variant?: VariantRow) {
  if (!product.activo) {
    throw new Error(STOCK_CHANGED_MESSAGE)
  }

  if (variant) {
    if (!variant.activo) {
      throw new Error(STOCK_CHANGED_MESSAGE)
    }

    if ((variant.stock ?? 0) < item.quantity) {
      throw new Error(STOCK_CHANGED_MESSAGE)
    }

    return
  }

  if (product.stock < item.quantity) {
    throw new Error(STOCK_CHANGED_MESSAGE)
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
    throw new Error(error.message || "No se pudieron crear los ítems de la orden.")
  }
}

function isSchemaCacheColumnError(error: { message?: string } | null) {
  return Boolean(
    error?.message?.includes("schema cache") ||
      error?.message?.includes("Could not find the") ||
      error?.message?.includes("column")
  )
}

export async function POST(request: Request) {
  try {
    if (!mercadoPagoClient) {
      return NextResponse.json(
        { error: "Mercado Pago no está configurado." },
        { status: 500 },
      )
    }

    const payload = (await request.json()) as CheckoutPayload
    const items = normalizeItems(payload.items)

    if (!items.length) {
      return NextResponse.json({ error: "El carrito está vacío." }, { status: 400 })
    }

    const supabase = await createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()

    if (!user) {
      return NextResponse.json(
        { error: "Debés iniciar sesión para pagar." },
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
      throw new Error("Hay productos que ya no están disponibles.")
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
        throw new Error(`Variante inválida para ${product.nombre}.`)
      }

      assertStock(item, product, variant)
    }

    const baseTotals = calculateCartTotals(
      items.map((item) => {
        const product = productRows.find((row) => row.id === item.productId)!

        return {
          product,
          quantity: item.quantity,
        }
      }),
    )
    const shipping = normalizeShipping(
      payload.shipping,
      baseTotals.productsTotal,
      payload.customer,
    )
    const totals = calculateCartTotals(
      items.map((item) => {
        const product = productRows.find((row) => row.id === item.productId)!

        return {
          product,
          quantity: item.quantity,
        }
      }),
      {
        shippingCost: shipping.shipping_cost_charged,
      },
    )

    const orderPayload = {
      usuario_id: user.id,
      total: totals.total,
      estado: "pendiente",
      payment_method_id: "mercadopago",
      payment_status: "pending_checkout",
      envio_proveedor: shipping.shipping_provider,
      ...shipping,
      ...normalizeCustomer(payload.customer),
    }

    let { data: order, error: orderError } = await supabase
      .from("ordenes")
      .insert(orderPayload as never)
      .select()
      .single()

    if (orderError && isSchemaCacheColumnError(orderError)) {
      const legacyCustomer = normalizeCustomer(payload.customer)

      const legacyPayload = {
        usuario_id: user.id,
        total: totals.total,
        estado: "pendiente",
        payment_method_id: "mercadopago",
        payment_status: "pending_checkout",
        cliente_nombre: legacyCustomer.cliente_nombre,
        cliente_email: legacyCustomer.cliente_email,
        cliente_telefono: legacyCustomer.cliente_telefono,
        cliente_direccion: legacyCustomer.cliente_direccion,
      }

      const fallbackOrder = await supabase
        .from("ordenes")
        .insert(legacyPayload as never)
        .select()
        .single()

      order = fallbackOrder.data
      orderError = fallbackOrder.error
    }

    if (orderError || !order) {
      throw new Error(orderError?.message || "No se pudo crear la orden.")
    }

    await insertOrderItems(supabase, order.id, items, productRows)

    const siteUrl =
      process.env.NEXT_PUBLIC_SITE_URL ||
      request.headers.get("origin") ||
      "http://localhost:3000"

    const preference = new Preference(mercadoPagoClient)
    const result = await preference.create({
      body: {
        external_reference: String(order.id),
        items: [
          ...items.map((item) => {
            const product = productRows.find((row) => row.id === item.productId)!

            return {
              id: String(product.id),
              title: product.nombre,
              quantity: item.quantity,
              unit_price: getUnitPrice(product),
              currency_id: "ARS",
            }
          }),
          ...(totals.shipping > 0
            ? [
                {
                  id: "shipping",
                  title: "Envío",
                  quantity: 1,
                  unit_price: totals.shipping,
                  currency_id: "ARS",
                },
              ]
            : []),
        ],
        payer: {
          name: payload.customer?.nombre,
          email: payload.customer?.email,
          phone: {
            number: payload.customer?.telefono,
          },
        },
        back_urls: {
          success: `${siteUrl}/checkout/success`,
          failure: `${siteUrl}/checkout/failure`,
          pending: `${siteUrl}/checkout/pending`,
        },
        notification_url: `${siteUrl}/api/mercadopago/webhook`,
      },
    })

    if (!result.init_point) {
      throw new Error("Mercado Pago no devolvió init_point.")
    }

    return NextResponse.json({
      init_point: result.init_point,
      order_id: order.id,
    })
  } catch (error) {
    console.error("Error creando preferencia de Mercado Pago", error)

    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "No pudimos iniciar el pago.",
      },
      { status: 500 },
    )
  }
}
