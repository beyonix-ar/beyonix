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

interface ClientOrderSummaryRow {
  profile_id: string
  order_count: number | string
  total_spent: number | string
  last_order: SupabasePedido | null
}

function getApellido(nombre: string | null | undefined) {
  const parts = (nombre ?? "").trim().split(" ").filter(Boolean)
  if (parts.length <= 1) return null
  return parts.slice(1).join(" ")
}

export async function getClientes() {
  const [profilesResult, summariesResult, presenceResult, cartsResult] = await Promise.all([
    supabase.rpc("admin_get_client_profiles"),
    // Agregados (order_count, total_spent, last_order) ya calculados en
    // SQL vía GROUP BY: evita descargar la tabla `ordenes` completa al
    // navegador para recalcularlos en JS en cada carga del panel.
    supabase.rpc("admin_get_client_order_summaries"),
    supabase.rpc("admin_get_client_presence"),
    supabase.rpc("admin_get_client_carts"),
  ])

  if (profilesResult.error) throw profilesResult.error
  if (summariesResult.error) throw summariesResult.error

  const profiles = ((profilesResult.data ?? []) as SupabaseProfile[]).filter(
    (profile) => ["cliente", "admin", "super_admin"].includes(profile.rol ?? "")
  )
  const summaryRows = (summariesResult.data ?? []) as ClientOrderSummaryRow[]
  const presenceRows = presenceResult.error
    ? []
    : ((presenceResult.data ?? []) as PresenceRow[])
  const cartRows = cartsResult.error ? [] : ((cartsResult.data ?? []) as CartRow[])
  const activeSince = Date.now() - 5 * 60 * 1000
  const presenceByUser = new Map(presenceRows.map((row) => [row.user_id, row]))
  const cartsByUser = new Map(cartRows.map((row) => [row.user_id, row.payload]))
  const summaryByProfileId = new Map(summaryRows.map((row) => [row.profile_id, row]))

  return profiles.map<SupabaseCliente>((profile) => {
    const presence = presenceByUser.get(profile.id)
    const summary = summaryByProfileId.get(profile.id)
    const lastOrder = summary?.last_order ?? null
    const totalSpent = Number(summary?.total_spent ?? 0)
    const orderCount = Number(summary?.order_count ?? 0)

    return {
      id: profile.id,
      nombre: profile.nombre,
      apellido: getApellido(profile.nombre),
      username: profile.username,
      email: profile.email,
      telefono: profile.telefono,
      dni: profile.dni,
      direccion: profile.direccion,
      calle: profile.calle,
      numero: profile.numero,
      piso: profile.piso,
      departamento: profile.departamento,
      localidad: profile.localidad,
      codigo_postal: profile.codigo_postal,
      provincia: profile.provincia,
      referencias: profile.referencias,
      avatar_url: profile.avatar_url,
      rol: profile.rol,
      client_risk_status: profile.client_risk_status ?? "normal",
      admin_note: profile.admin_note,
      blocked_at: profile.blocked_at,
      blocked_reason: profile.blocked_reason,
      blocked_by: profile.blocked_by,
      created_at: profile.created_at,
      last_seen_at: presence?.last_seen_at ?? null,
      is_active: presence?.last_seen_at
        ? new Date(presence.last_seen_at).getTime() >= activeSince
        : false,
      current_cart: cartsByUser.get(profile.id) ?? null,
      last_order: lastOrder,
      total_spent: totalSpent,
      order_count: orderCount,
      status: orderCount ? "activo" : "sin_compras",
    }
  })
}
