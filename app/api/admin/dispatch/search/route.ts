import { requireOperator } from "@/app/api/admin/clientes/_auth"
import { dispatchHold, HOLD_COLUMNS } from "@/lib/admin/dispatch"
import { DISPATCH_RECORDS_PAGE_SIZE, isDispatchRecordState, type DispatchRecord, type DispatchUser } from "@/lib/admin/dispatch-records"

const validDate = (value: string | null) => {
  if (!value) return true
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000")) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const textOrNull = (value: string | null) => value?.trim().slice(0, 80) || null
const profileName = (profile: { id: string; nombre: string | null; username: string | null; email: string | null }) => profile.nombre || profile.username || profile.email || profile.id

type RecordRow = Omit<DispatchRecord, "actorName" | "total"> & { total: number | string | null }

/** Tabla única de Despachos: una consulta (search_dispatch_records) + nombres de usuario. */
export async function GET(request: Request) {
  const auth = await requireOperator(request)
  if ("error" in auth) return auth.error
  const params = new URL(request.url).searchParams
  const page = /^\d{1,6}$/.test(params.get("page") ?? "1") ? Number(params.get("page") ?? "1") : NaN
  const date = params.get("date")
  const user = params.get("user")
  const state = params.get("state")
  if (!Number.isSafeInteger(page) || page < 1 || page > 100000 || !validDate(date) ||
    (user && !UUID.test(user)) || (state && !isDispatchRecordState(state))) {
    return Response.json({ error: "Filtros inválidos." }, { status: 400 })
  }
  const [searched, holdsResult, usersResult] = await Promise.all([
    auth.admin.rpc("search_dispatch_records", { p_page: page, p_date: date || null, p_order: textOrNull(params.get("order")),
      p_batch: textOrNull(params.get("batch")), p_actor_id: user || null, p_state: state || null,
      p_open_all_dates: params.get("openAllDates") === "true" }),
    auth.admin.from("order_cancellation_holds").select(HOLD_COLUMNS).is("resolved_at", null).order("detected_at", { ascending: false }).limit(50),
    auth.admin.from("profiles").select("id,nombre,username,email").in("rol", ["operador", "admin", "super_admin"]).limit(200),
  ])
  if (searched.error) return Response.json({ error: "No se pudieron filtrar los despachos." }, { status: 500 })
  if (holdsResult.error || usersResult.error) return Response.json({ error: "No se pudieron cargar los despachos." }, { status: 500 })
  const result = searched.data as { rows: RecordRow[]; total: number }
  const names = new Map((usersResult.data ?? []).map((profile) => [profile.id, profileName(profile)]))
  // Un actor que ya no es operador (rol cambiado) igual se muestra por nombre.
  const missing = [...new Set(result.rows.map((row) => row.actorId).filter((id): id is string => typeof id === "string" && !names.has(id)))]
  if (missing.length) {
    const extra = await auth.admin.from("profiles").select("id,nombre,username,email").in("id", missing)
    if (extra.error) return Response.json({ error: "No se pudieron cargar los despachos." }, { status: 500 })
    for (const profile of extra.data ?? []) names.set(profile.id, profileName(profile))
  }
  const seesAmounts = auth.profile.rol === "admin" || auth.profile.rol === "super_admin"
  const rows: DispatchRecord[] = result.rows.map((row) => ({ ...row, total: seesAmounts && row.total !== null ? Number(row.total) : null,
    actorName: row.actorId ? names.get(row.actorId) ?? null : null }))
  const users: DispatchUser[] = (usersResult.data ?? []).map((profile) => ({ id: profile.id, name: profileName(profile) }))
    .sort((left, right) => left.name.localeCompare(right.name, "es"))
  return Response.json({ rows, total: result.total, page, pageSize: DISPATCH_RECORDS_PAGE_SIZE, holds: (holdsResult.data ?? []).map((row) => dispatchHold(row, null)), users },
    { headers: { "Cache-Control": "no-store" } })
}
