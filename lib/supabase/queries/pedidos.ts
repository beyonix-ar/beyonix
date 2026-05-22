import { supabase } from "@/lib/supabase/client"

import type {
  SupabasePedido,
  SupabasePedidoItem,
} from "@/lib/supabase/types"

// ─────────────────────────────────────────────────────────────────────────────
// Get pedidos
// ─────────────────────────────────────────────────────────────────────────────

export async function getPedidos() {
  const { data, error } =
    await supabase
      .from("ordenes")
      .select("*")
      .order("created_at", {
        ascending: false,
      })

  if (error) {
    throw error
  }

  return (data ??
    []) as SupabasePedido[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Get pedido
// ─────────────────────────────────────────────────────────────────────────────

export async function getPedido(
  id: number
) {
  const { data, error } =
    await supabase
      .from("ordenes")
      .select("*")
      .eq("id", id)
      .single()

  if (error) {
    throw error
  }

  return data as SupabasePedido
}

// ─────────────────────────────────────────────────────────────────────────────
// Get pedido items
// ─────────────────────────────────────────────────────────────────────────────

export async function getPedidoItems(
  pedidoId: number
) {
  const { data, error } =
    await supabase
      .from("orden_items")
      .select(`
        *,
        productos(*)
      `)
      .eq("pedido_id", pedidoId)

  if (error) {
    throw error
  }

  return (data ??
    []) as SupabasePedidoItem[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Create pedido
// ─────────────────────────────────────────────────────────────────────────────

interface CreatePedidoPayload {
  user_id?: string | null

  estado?: string

  total: number
}

export async function createPedido(
  payload: CreatePedidoPayload
) {
  const { data, error } =
    await supabase
      .from("ordenes")
      .insert({
        estado: "pendiente",
        ...payload,
      })
      .select()
      .single()

  if (error) {
    throw error
  }

  return data as SupabasePedido
}

// ─────────────────────────────────────────────────────────────────────────────
// Create pedido item
// ─────────────────────────────────────────────────────────────────────────────

interface CreatePedidoItemPayload {
  pedido_id: number

  producto_id: number

  cantidad: number

  precio_unitario: number
}

export async function createPedidoItem(
  payload: CreatePedidoItemPayload
) {
  const { data, error } =
    await supabase
      .from("orden_items")
      .insert(payload)
      .select()
      .single()

  if (error) {
    throw error
  }

  return data
}

// ─────────────────────────────────────────────────────────────────────────────
// Update pedido estado
// ─────────────────────────────────────────────────────────────────────────────

export async function updatePedidoEstado(
  id: number,
  estado: string
) {
  const { data, error } =
    await supabase
      .from("ordenes")
      .update({ estado })
      .eq("id", id)
      .select()
      .single()

  if (error) {
    throw error
  }

  return data as SupabasePedido
}

// ─────────────────────────────────────────────────────────────────────────────
// Delete pedido
// ─────────────────────────────────────────────────────────────────────────────

export async function deletePedido(
  id: number
) {
  const { error } =
    await supabase
      .from("ordenes")
      .delete()
      .eq("id", id)

  if (error) {
    throw error
  }

  return true
}