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
      .select("*, orden_items(*, productos(*), producto_variantes(*))")
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
        productos(*),
        producto_variantes(*)
      `)
      .eq("orden_id", pedidoId)

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
  usuario_id?: string | null

  estado?: string

  total: number

  cliente_nombre?: string | null

  cliente_email?: string | null

  cliente_telefono?: string | null

  cliente_direccion?: string | null
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
  orden_id: number

  producto_id: number

  variante_id?: number | null

  cantidad: number

  precio: number
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
  estado: string,
  tracking?: {
    tracking_number?: string | null
    tracking_url?: string | null
  }
) {
  const payload = {
    estado,
    ...(tracking ?? {}),
  }

  const { data, error } =
    await supabase
      .from("ordenes")
      .update(payload)
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
