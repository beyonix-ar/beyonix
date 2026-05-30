import { supabase } from "@/lib/supabase/client"

import type {
  SupabaseCliente,
  SupabasePedido,
  SupabaseProfile,
} from "@/lib/supabase/types"

interface PresenceRow {
  user_id: string
  last_seen_at: string | null
  current_path?: string | null
  updated_at?: string | null
}

interface CartRow {
  user_id: string
  payload: Record<string, unknown> | unknown[] | null
  updated_at?: string | null
  expires_at?: string | null
}

function getApellido(nombre: string | null | undefined) {
  const parts = (nombre ?? "").trim().split(" ").filter(Boolean)
  if (parts.length <= 1) return null
  return parts.slice(1).join(" ")
}

function isPaidOrder(order: SupabasePedido) {
  return (
    order.estado === "pagado" ||
    order.estado === "enviado" ||
    order.estado === "entregado" ||
    order.payment_status === "approved"
  )
}

export async function getClientes() {
  const [profilesResult, ordersResult, presenceResult, cartsResult] = await Promise.all([
    supabase.rpc("admin_get_client_profiles"),
    supabase
      .from("ordenes")
      .select("*, orden_items(*, productos(*), producto_variantes(*))")
      .order("created_at", { ascending: false }),
    supabase.rpc("admin_get_client_presence"),
    supabase.rpc("admin_get_client_carts"),
  ])

  if (profilesResult.error) throw profilesResult.error
  if (ordersResult.error) throw ordersResult.error

  const profiles = ((profilesResult.data ?? []) as SupabaseProfile[]).filter(
    (profile) => profile.rol === "cliente"
  )
  const orders = (ordersResult.data ?? []) as SupabasePedido[]
  const presenceRows = presenceResult.error
    ? []
    : ((presenceResult.data ?? []) as PresenceRow[])
  const cartRows = cartsResult.error ? [] : ((cartsResult.data ?? []) as CartRow[])
  const activeSince = Date.now() - 5 * 60 * 1000
  const presenceByUser = new Map(presenceRows.map((row) => [row.user_id, row]))
  const cartsByUser = new Map(cartRows.map((row) => [row.user_id, row.payload]))

  return profiles.map<SupabaseCliente>((profile) => {
    const presence = presenceByUser.get(profile.id)
    const clientOrders = orders.filter(
      (order) =>
        order.usuario_id === profile.id ||
        Boolean(profile.email && order.cliente_email === profile.email)
    )
    const paidOrders = clientOrders.filter(isPaidOrder)
    const lastOrder = clientOrders[0] ?? null
    const totalSpent = paidOrders.reduce(
      (total, order) => total + Number(order.total ?? 0),
      0
    )

    return {
      id: profile.id,
      nombre: profile.nombre,
      apellido: getApellido(profile.nombre),
      username: profile.username,
      email: profile.email,
      telefono: profile.telefono,
      direccion: profile.direccion,
      codigo_postal: profile.codigo_postal,
      provincia: profile.provincia,
      referencias: profile.referencias,
      avatar_url: profile.avatar_url,
      rol: profile.rol,
      created_at: profile.created_at,
      last_seen_at: presence?.last_seen_at ?? null,
      is_active: presence?.last_seen_at
        ? new Date(presence.last_seen_at).getTime() >= activeSince
        : false,
      current_cart: cartsByUser.get(profile.id) ?? null,
      last_order: lastOrder,
      total_spent: totalSpent,
      order_count: clientOrders.length,
      status: clientOrders.length ? "activo" : "sin_compras",
    }
  })
}
