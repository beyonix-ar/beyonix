import { supabase } from "@/lib/supabase/client"

import type {
  SupabasePedido,
} from "@/lib/supabase/types"

export async function getPedidos({
  notificationView = false,
  limit = 50,
  offset = 0,
  orderId,
}: {
  notificationView?: boolean
  limit?: number
  offset?: number
  orderId?: number
} = {}) {
  const {
    data: { session },
  } = await supabase.auth.getSession()

  if (!session?.access_token) {
    throw new Error("La sesión administrativa venció.")
  }

  const params = new URLSearchParams()
  if (notificationView) {
    params.set("view", "notifications")
  } else if (orderId) {
    params.set("id", String(orderId))
  } else {
    params.set("limit", String(limit))
    params.set("offset", String(offset))
  }

  const response = await fetch(
    `/api/admin/pedidos?${params.toString()}`,
    {
    headers: {
      Authorization: `Bearer ${session.access_token}`,
    },
    cache: "no-store",
  })
  const data = (await response.json()) as {
    pedidos?: SupabasePedido[]
    total?: number
    error?: string
  }

  if (!response.ok) {
    throw new Error(data.error || "No se pudieron cargar los pedidos.")
  }

  return {
    pedidos: data.pedidos ?? [],
    total: Number(data.total ?? data.pedidos?.length ?? 0),
  }
}

export interface UpdatePedidoStatusDetails {
  tracking_number?: string | null
  tracking_url?: string | null
  envio_proveedor?: string | null
}

export async function updatePedidoEstado(
  id: number,
  estado: string,
  details?: UpdatePedidoStatusDetails
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
      ...(details ?? {}),
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
