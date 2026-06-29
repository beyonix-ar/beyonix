"use server"

import { createClient } from "@/lib/supabase/server"
import { getVariantIdFromValue } from "@/lib/products/product-variants"
import { STOCK_CHANGED_MESSAGE } from "@/lib/cart/stock-status"

interface CreateOrderItem {
  productId: number
  quantity: number
  variantId?: number | null
  color?: string | null
}

interface CreateOrderPayload {
  items: CreateOrderItem[]
  reservationSessionId?: string | null
  customer?: {
    nombre?: string
    email?: string
    telefono?: string
    direccion?: string
  }
}

interface ProductRow {
  id: number
  nombre: string
  precio: number
  stock: number
}

interface VariantRow {
  id: number
  producto_id: number
  nombre: string
  stock: number | null
  activo: boolean
  orden: number | null
}

type NormalizedOrderItem = ReturnType<typeof normalizeItem>
type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>

function normalizeItem(item: CreateOrderItem) {
  const variantId =
    Number(item.variantId) ||
    getVariantIdFromValue(item.color) ||
    null

  return {
    productId: Number(item.productId),
    quantity: Math.trunc(Number(item.quantity)),
    variantId,
  }
}

function normalizeCustomer(customer: CreateOrderPayload["customer"]) {
  return {
    cliente_nombre: customer?.nombre?.trim() || null,
    cliente_email: customer?.email?.trim() || null,
    cliente_telefono: customer?.telefono?.trim() || null,
    cliente_direccion: customer?.direccion?.trim() || null,
  }
}

function getFriendlyOrderError(error: unknown) {
  const message =
    error instanceof Error
      ? error.message
      : "No pudimos completar la compra."

  const normalizedMessage = message.toLowerCase()

  if (
    (normalizedMessage.includes("stock") &&
      normalizedMessage.includes("insuficiente")) ||
    normalizedMessage.includes("no hay stock") ||
    normalizedMessage.includes("no está disponible") ||
    normalizedMessage.includes("no esta disponible")
  ) {
    return STOCK_CHANGED_MESSAGE
  }

  if (
    message.toLowerCase().includes("schema cache") ||
    message.toLowerCase().includes("column") ||
    message.toLowerCase().includes("orden_items")
  ) {
    return `No pudimos registrar los productos de la orden. Detalle: ${message}`
  }

  return message || "No pudimos completar la compra."
}

function isMissingReservationRpc(error: { code?: string; message?: string }) {
  return (
    error.code === "PGRST202" ||
    error.code === "42883" ||
    error.message?.toLowerCase().includes("reserve_cart_stock")
  )
}

async function reserveOrderStock(
  supabase: SupabaseServerClient,
  sessionId: string | null | undefined,
  items: NormalizedOrderItem[],
) {
  if (!sessionId) return false

  const { error } = await supabase.rpc("reserve_cart_stock", {
    p_session_id: sessionId,
    p_items: items.map((item) => ({
      productId: item.productId,
      quantity: item.quantity,
      variantId: item.variantId,
    })),
  })

  if (error) {
    if (isMissingReservationRpc(error)) return false

    throw new Error(
      error.message ||
        STOCK_CHANGED_MESSAGE,
    )
  }

  return true
}

async function completeOrderReservation(
  supabase: SupabaseServerClient,
  sessionId: string | null | undefined,
  orderId: number,
) {
  if (!sessionId) return

  await supabase.rpc("complete_cart_stock_reservation", {
    p_session_id: sessionId,
    p_order_id: orderId,
  })
}

async function releaseOrderReservation(
  supabase: SupabaseServerClient,
  sessionId: string | null | undefined,
) {
  if (!sessionId) return

  await supabase.rpc("release_cart_stock_reservation", {
    p_session_id: sessionId,
  })
}

async function deleteIncompleteOrder(
  supabase: SupabaseServerClient,
  orderId: number | null,
) {
  if (!orderId) return

  await supabase.from("orden_items").delete().eq("orden_id", orderId)
  await supabase.from("ordenes").delete().eq("id", orderId)
}

function isSchemaColumnError(error: { message?: string }) {
  const message = error.message?.toLowerCase() ?? ""

  return message.includes("schema cache") || message.includes("column")
}

async function insertOrderItems(
  supabase: SupabaseServerClient,
  orderId: number,
  items: NormalizedOrderItem[],
  products: ProductRow[],
) {
  const attempts: Array<Record<string, number>[]> = [
    items.map((item) => {
      const product = products.find((row) => row.id === item.productId)

      return {
        orden_id: orderId,
        producto_id: item.productId,
        ...(item.variantId ? { variante_id: item.variantId } : {}),
        cantidad: item.quantity,
        precio: product?.precio ?? 0,
      }
    }),
    items.map((item) => {
      const product = products.find((row) => row.id === item.productId)

      return {
        orden_id: orderId,
        producto_id: item.productId,
        cantidad: item.quantity,
        precio: product?.precio ?? 0,
      }
    }),
    items.map((item) => {
      const product = products.find((row) => row.id === item.productId)

      return {
        orden_id: orderId,
        producto_id: item.productId,
        ...(item.variantId ? { variante_id: item.variantId } : {}),
        cantidad: item.quantity,
        precio_unitario: product?.precio ?? 0,
      }
    }),
    items.map((item) => {
      const product = products.find((row) => row.id === item.productId)

      return {
        orden_id: orderId,
        producto_id: item.productId,
        cantidad: item.quantity,
        precio_unitario: product?.precio ?? 0,
      }
    }),
  ]

  let lastError: { message?: string } | null = null

  for (const payload of attempts) {
    const { error } = await supabase
      .from("orden_items")
      .insert(payload as never)

    if (!error) return

    lastError = error

    if (!isSchemaColumnError(error)) break
  }

  throw new Error(lastError?.message || "No se pudieron crear los ítems")
}

async function insertOrder(
  supabase: SupabaseServerClient,
  userId: string,
  total: number,
  customer: CreateOrderPayload["customer"],
) {
  const customerPayload = normalizeCustomer(customer)

  const attempts = [
    {
      usuario_id: userId,
      total,
      estado: "pendiente",
      ...customerPayload,
    },
    {
      usuario_id: userId,
      total,
      estado: "pendiente",
    },
  ]

  let lastError: { message?: string } | null = null

  for (const payload of attempts) {
    const { data, error } = await supabase
      .from("ordenes")
      .insert(payload as never)
      .select()
      .single()

    if (!error && data) return data

    lastError = error

    if (!error || !isSchemaColumnError(error)) break
  }

  throw new Error(lastError?.message || "No se pudo crear la orden")
}

function assertStock(
  item: NormalizedOrderItem,
  product: ProductRow,
  variant?: VariantRow,
) {
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

export async function createOrder({
  items,
  reservationSessionId,
  customer,
}: CreateOrderPayload) {
  const supabase = await createClient()
  let createdOrderId: number | null = null
  let hasActiveReservation = false

  try {
    const normalizedItems = items
      .map(normalizeItem)
      .filter(
        (item) =>
          Number.isFinite(item.productId) &&
          Number.isFinite(item.quantity) &&
          item.quantity > 0,
      )

    if (normalizedItems.length === 0) {
      throw new Error("El carrito está vacío")
    }

    const {
      data: { user },
    } = await supabase.auth.getUser()

    if (!user) {
      throw new Error("Debés iniciar sesión")
    }

    const productIds = [
      ...new Set(normalizedItems.map((item) => item.productId)),
    ]
    const { data: products, error: productsError } = await supabase
      .from("productos")
      .select("id, nombre, precio, stock")
      .in("id", productIds)

    if (productsError) {
      throw new Error("No se pudieron validar los productos")
    }

    const productRows = (products ?? []) as ProductRow[]

    if (!productRows.length) {
      throw new Error("Productos inexistentes")
    }

    const variantsById = new Map<number, VariantRow>()
    const variantsByProductId = new Map<number, VariantRow[]>()

    const { data: variants, error: variantsError } = await supabase
      .from("producto_variantes")
      .select("id, producto_id, nombre, stock, activo, orden")
      .in("producto_id", productIds)

    if (variantsError) {
      throw new Error("No se pudieron validar las variantes")
    }

    for (const variant of (variants ?? []) as VariantRow[]) {
      variantsById.set(variant.id, variant)

      const productVariants =
        variantsByProductId.get(variant.producto_id) ?? []

      productVariants.push(variant)
      productVariants.sort((a, b) => {
        if ((a.orden ?? 0) !== (b.orden ?? 0)) {
          return (a.orden ?? 0) - (b.orden ?? 0)
        }

        return a.id - b.id
      })

      variantsByProductId.set(variant.producto_id, productVariants)
    }

    for (const item of normalizedItems) {
      if (item.variantId) continue

      const productVariants =
        variantsByProductId.get(item.productId)?.filter(
          (variant) => variant.activo,
        ) ?? []

      if (productVariants.length > 0) {
        item.variantId = productVariants[0].id
      }
    }

    hasActiveReservation = await reserveOrderStock(
      supabase,
      reservationSessionId,
      normalizedItems,
    )

    for (const item of normalizedItems) {
      const product = productRows.find((row) => row.id === item.productId)

      if (!product) {
        throw new Error("Producto inexistente")
      }

      const variant = item.variantId
        ? variantsById.get(item.variantId)
        : undefined

      if (item.variantId && (!variant || variant.producto_id !== product.id)) {
        throw new Error(`Variante inválida para ${product.nombre}`)
      }

      assertStock(item, product, variant)
    }

    const total = normalizedItems.reduce((sum, item) => {
      const product = productRows.find((row) => row.id === item.productId)
      return sum + (product?.precio ?? 0) * item.quantity
    }, 0)

    const order = await insertOrder(supabase, user.id, total, customer)

    createdOrderId = order.id

    await insertOrderItems(supabase, order.id, normalizedItems, productRows)

    const productStockUpdates = new Map<number, number>()

    for (const item of normalizedItems) {
      productStockUpdates.set(
        item.productId,
        (productStockUpdates.get(item.productId) ?? 0) + item.quantity,
      )

      if (!item.variantId) continue

      const variant = variantsById.get(item.variantId)
      if (!variant) continue

      const { error: variantStockError } = await supabase
        .from("producto_variantes")
        .update({
          stock: Math.max((variant.stock ?? 0) - item.quantity, 0),
        })
        .eq("id", variant.id)

      if (variantStockError) {
        throw new Error(`No se pudo actualizar stock de ${variant.nombre}`)
      }
    }

    for (const [productId, quantity] of productStockUpdates) {
      const product = productRows.find((row) => row.id === productId)
      if (!product) continue

      const { error: stockError } = await supabase
        .from("productos")
        .update({
          stock: Math.max(product.stock - quantity, 0),
        })
        .eq("id", product.id)

      if (stockError) {
        throw new Error(`No se pudo actualizar stock de ${product.nombre}`)
      }
    }

    if (hasActiveReservation) {
      await completeOrderReservation(supabase, reservationSessionId, order.id)
    }

    return {
      success: true,
      orderId: order.id as number,
      error: null,
    }
  } catch (error) {
    await deleteIncompleteOrder(supabase, createdOrderId)

    if (hasActiveReservation) {
      await releaseOrderReservation(supabase, reservationSessionId)
    }

    return {
      success: false,
      orderId: null,
      error: getFriendlyOrderError(error),
    }
  }
}
