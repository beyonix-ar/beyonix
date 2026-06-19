import { supabase } from "@/lib/supabase/client"

import type {
  SupabasePedido,
  SupabasePedidoItem,
} from "@/lib/supabase/types"

export async function getPedidos() {
  const {
    data: { session },
  } = await supabase.auth.getSession()

  if (!session?.access_token) {
    throw new Error("La sesión administrativa venció.")
  }

  const response = await fetch("/api/admin/pedidos", {
    headers: {
      Authorization: `Bearer ${session.access_token}`,
    },
  })
  const data = (await response.json()) as {
    pedidos?: SupabasePedido[]
    error?: string
  }

  if (!response.ok) {
    throw new Error(data.error || "No se pudieron cargar los pedidos.")
  }

  return data.pedidos ?? []
}

export async function getPedido(id: number) {
  const { data, error } = await supabase
    .from("ordenes")
    .select("*")
    .eq("id", id)
    .single()

  if (error) throw error
  return data as SupabasePedido
}

export async function getPedidoItems(pedidoId: number) {
  const { data, error } = await supabase
    .from("orden_items")
    .select("*, productos(*), producto_variantes(*)")
    .eq("orden_id", pedidoId)

  if (error) throw error
  return (data ?? []) as SupabasePedidoItem[]
}

interface CreatePedidoPayload {
  usuario_id?: string | null
  estado?: string
  total: number
  cliente_nombre?: string | null
  cliente_email?: string | null
  cliente_telefono?: string | null
  cliente_direccion?: string | null
}

export async function createPedido(payload: CreatePedidoPayload) {
  const { data, error } = await supabase
    .from("ordenes")
    .insert({
      estado: "pendiente",
      ...payload,
    })
    .select()
    .single()

  if (error) throw error
  return data as SupabasePedido
}

interface CreatePedidoItemPayload {
  orden_id: number
  producto_id: number
  variante_id?: number | null
  cantidad: number
  precio: number
}

export async function createPedidoItem(payload: CreatePedidoItemPayload) {
  const { data, error } = await supabase
    .from("orden_items")
    .insert(payload)
    .select()
    .single()

  if (error) throw error
  return data
}

export async function updatePedidoEstado(
  id: number,
  estado: string,
  tracking?: {
    tracking_number?: string | null
    tracking_url?: string | null
  }
) {
  const {
    data: { session },
  } = await supabase.auth.getSession()

  if (!session?.access_token) {
    throw new Error("La sesión administrativa venció.")
  }

  const response = await fetch(`/api/admin/pedidos/${id}/status`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      estado,
      ...(tracking ?? {}),
    }),
  })
  const data = (await response.json()) as {
    order?: SupabasePedido
    error?: string
  }

  if (!response.ok || !data.order) {
    throw new Error(data.error || "No se pudo actualizar el estado del pedido.")
  }

  return data.order
}

export async function deletePedido(id: number) {
  const { error } = await supabase.from("ordenes").delete().eq("id", id)

  if (error) throw error
  return true
}
