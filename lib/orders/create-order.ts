"use server"

import { createClient } from "@/lib/supabase/server"

interface CreateOrderItem {
  productId: number
  quantity: number
  price: number
}

interface CreateOrderPayload {
  items: CreateOrderItem[]
}

export async function createOrder({
  items,
}: CreateOrderPayload) {
  const supabase =
    await createClient()

  // ─────────────────────────────────────
  // Usuario autenticado
  // ─────────────────────────────────────

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    throw new Error(
      "Debes iniciar sesión"
    )
  }

  // ─────────────────────────────────────
  // IDs productos
  // ─────────────────────────────────────

  const productIds = items.map(
    (item) => item.productId
  )

  // ─────────────────────────────────────
  // Obtener productos reales
  // ─────────────────────────────────────

  const {
    data: products,
    error,
  } = await supabase
    .from("productos")
    .select(`
      id,
      nombre,
      precio,
      stock
    `)
    .in("id", productIds)

  if (error) {
    console.error(
      "SUPABASE ERROR:",
      error
    )

    throw new Error(
      JSON.stringify(error)
    )
  }

  if (!products?.length) {
    throw new Error(
      "Productos inexistentes"
    )
  }

  // ─────────────────────────────────────
  // Validar stock
  // ─────────────────────────────────────

  for (const item of items) {
    const product = products.find(
      (p) =>
        p.id === item.productId
    )

    if (!product) {
      throw new Error(
        "Producto inexistente"
      )
    }

    if (
      product.stock <
      item.quantity
    ) {
      throw new Error(
        `Stock insuficiente para ${product.nombre}`
      )
    }
  }

  // ─────────────────────────────────────
  // Total real
  // ─────────────────────────────────────

  const total = items.reduce(
    (sum, item) => {
      const product = products.find(
        (p) =>
          p.id === item.productId
      )

      if (!product) {
        return sum
      }

      return (
        sum +
        product.precio *
          item.quantity
      )
    },
    0
  )

  // ─────────────────────────────────────
  // Crear orden
  // ─────────────────────────────────────

  const {
    data: order,
    error: orderError,
  } = await supabase
    .from("ordenes")
    .insert({
      usuario_id: user.id,
      total,
      estado: "pendiente",
    })
    .select()
    .single()

  if (orderError || !order) {
    console.error(orderError)

    throw new Error(
      "No se pudo crear la orden"
    )
  }

  // ─────────────────────────────────────
  // Crear items
  // ─────────────────────────────────────

  const orderItems = items.map(
    (item) => {
      const product =
        products.find(
          (p) =>
            p.id ===
            item.productId
        )

      return {
        orden_id: order.id,
        producto_id:
          item.productId,
        cantidad:
          item.quantity,
        precio:
          product?.precio || 0,
      }
    }
  )

  const {
    error: itemsError,
  } = await supabase
    .from("orden_items")
    .insert(orderItems)

  if (itemsError) {
    console.error(itemsError)

    throw new Error(
      "No se pudieron crear los items"
    )
  }

  // ─────────────────────────────────────
  // Actualizar stock
  // ─────────────────────────────────────

  for (const item of items) {
    const product = products.find(
      (p) =>
        p.id === item.productId
    )

    if (!product) {
      continue
    }

    const newStock =
      product.stock -
      item.quantity

    const {
      error: stockError,
    } = await supabase
      .from("productos")
      .update({
        stock: newStock,
      })
      .eq("id", product.id)

    if (stockError) {
      console.error(stockError)

      throw new Error(
        `No se pudo actualizar stock de ${product.nombre}`
      )
    }
  }

  return {
    success: true,
    orderId: order.id,
  }
}