import { requireOperator } from "@/app/api/admin/clientes/_auth"
import { blocksPacking, dispatchBlockReason, dispatchHold, HOLD_COLUMNS, ORDER_COLUMNS, type DispatchOrder } from "@/lib/admin/dispatch"
import { DISPATCH_BOARD_PAGE_SIZE, dispatchDefaultDate, type DispatchBoardTab } from "@/lib/admin/dispatch-board-filters"

const TABS = new Set<DispatchBoardTab>(["armado", "ready", "open", "delivered"])
const validDate = (value: string | null) => {
  if (!value) return true
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000")) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}
const numberOrNull = (value: string | null) => value === null || value === "" ? null : /^\d{1,7}$/.test(value) ? Number(value) : NaN
const textOrNull = (value: string | null) => value?.trim().slice(0, 80) || null
const flagOrNull = (value: string | null) => value === "true" ? true : value === "false" ? false : null
const chunks = <T,>(rows: T[], size = 100) => Array.from({ length: Math.ceil(rows.length / size) }, (_, i) => rows.slice(i * size, (i + 1) * size))

export async function GET(request: Request) {
  const auth = await requireOperator(request)
  if ("error" in auth) return auth.error
  const params = new URL(request.url).searchParams
  const tab = params.get("tab") as DispatchBoardTab
  const page = numberOrNull(params.get("page")) ?? 1
  const min = numberOrNull(params.get("quantityMin"))
  const max = numberOrNull(params.get("quantityMax"))
  if (!TABS.has(tab) || !Number.isSafeInteger(page) || page < 1 || page > 100000 ||
    !validDate(params.get("dateFrom")) || !validDate(params.get("dateTo")) ||
    Number.isNaN(min) || Number.isNaN(max) || (min !== null && max !== null && min > max)) {
    return Response.json({ error: "Filtros inválidos." }, { status: 400 })
  }
  const operator = textOrNull(params.get("operator"))
  let operatorIds: string[] | null = null
  if (operator) {
    const safe = operator.replace(/[(),.]/g, " ").trim()
    const result = await auth.admin.from("profiles").select("id")
      .or(`nombre.ilike.%${safe}%,username.ilike.%${safe}%,email.ilike.%${safe}%`).limit(100)
    if (result.error) return Response.json({ error: "No se pudo buscar el operador." }, { status: 500 })
    operatorIds = (result.data ?? []).map((row) => row.id)
  }
  // Pendientes, Confirmados y Bultos son trabajo abierto: nunca se limitan a hoy por defecto.
  const defaultDate = dispatchDefaultDate(tab, params.get("allDates") === "true")
  const searched = await auth.admin.rpc("search_dispatch_board", {
    p_tab: tab, p_page: page, p_search: textOrNull(params.get("search")),
    p_date_from: params.get("dateFrom") || defaultDate, p_date_to: params.get("dateTo") || defaultDate,
    p_batch: textOrNull(params.get("batch")), p_operator_ids: operatorIds,
    p_state: textOrNull(params.get("state")), p_quantity_kind: textOrNull(params.get("quantityKind")),
    p_quantity_min: min, p_quantity_max: max, p_sku: textOrNull(params.get("sku")),
    p_tracking: textOrNull(params.get("tracking")), p_has_cancelled: flagOrNull(params.get("hasCancelled")),
    p_has_removed: flagOrNull(params.get("hasRemoved")), p_invoiced: flagOrNull(params.get("invoiced")),
  })
  if (searched.error) return Response.json({ error: "No se pudieron filtrar los despachos." }, { status: 500 })
  const result = searched.data as { ids: number[]; total: number }
  const ids = result.ids ?? []
  const fail = () => Response.json({ error: "No se pudieron cargar los despachos." }, { status: 500 })
  const holdsResult = await auth.admin.from("order_cancellation_holds").select(HOLD_COLUMNS)
    .is("resolved_at", null).order("detected_at", { ascending: false }).limit(50)
  if (holdsResult.error) return fail()
  const holds = (holdsResult.data ?? []).map((row) => dispatchHold(row, null))
  if (!ids.length) return Response.json({ orders: [], batches: [], holds, total: result.total, page, pageSize: DISPATCH_BOARD_PAGE_SIZE, viewerRole: auth.profile.rol }, { headers: { "Cache-Control": "no-store" } })

  if (tab === "armado" || tab === "ready") {
    const [ordersResult, packagesResult, itemsResult, blocksResult, membershipsResult] = await Promise.all([
      auth.admin.from("ordenes").select(ORDER_COLUMNS).in("id", ids),
      auth.admin.from("order_packages").select("id,order_id,status,attempt_number,prepared_at,prepared_by,parcel_count,parcels_defined_at,identification_method").in("order_id", ids),
      auth.admin.from("orden_items").select("orden_id,cantidad").in("orden_id", ids),
      auth.admin.from("dispatch_blocks").select("order_id,reason,source").in("order_id", ids).is("resolved_at", null),
      auth.admin.from("dispatch_batch_items").select("id,batch_id,order_id,package_id,added_at,removed_at").in("order_id", ids).is("removed_at", null),
    ])
    if ([ordersResult, packagesResult, itemsResult, blocksResult, membershipsResult].some((r) => r.error)) return fail()
    const ordersById = new Map(((ordersResult.data ?? []) as DispatchOrder[]).map((row) => [row.id, row]))
    const packages = new Map((packagesResult.data ?? []).map((row) => [row.order_id, row]))
    const memberships = new Map((membershipsResult.data ?? []).map((row) => [row.order_id, row]))
    const units = new Map<number, { items: number; units: number }>()
    for (const item of itemsResult.data ?? []) {
      const current = units.get(item.orden_id) ?? { items: 0, units: 0 }
      units.set(item.orden_id, { items: current.items + 1, units: current.units + Number(item.cantidad) })
    }
    const blocks = new Map<number, Array<{ reason: string; source: string }>>()
    for (const block of blocksResult.data ?? []) blocks.set(block.order_id, [...(blocks.get(block.order_id) ?? []), block])
    const preparingIds = [...packages.values()].filter((pkg) => pkg.status === "preparing").map((pkg) => pkg.id)
    const lineResults = await Promise.all(chunks(preparingIds).map((part) => auth.admin.from("order_preparation_lines").select("package_id,scanned_quantity").in("package_id", part)))
    if (lineResults.some((r) => r.error)) return fail()
    const scanned = new Map<number, number>()
    for (const lines of lineResults) for (const line of lines.data ?? []) scanned.set(line.package_id, (scanned.get(line.package_id) ?? 0) + Number(line.scanned_quantity))
    const held = new Set(holds.map((item) => item.orderId))
    const preparerIds = [...new Set([...packages.values()].map((pkg) => pkg.prepared_by).filter((id): id is string => Boolean(id)))]
    const preparersResult = preparerIds.length ? await auth.admin.from("profiles").select("id,nombre,username,email").in("id", preparerIds) : { data: [], error: null }
    if (preparersResult.error) return fail()
    const preparers = new Map((preparersResult.data ?? []).map((profile) => [profile.id, profile.nombre || profile.username || profile.email || profile.id]))
    const orders = ids.flatMap((id) => {
      const order = ordersById.get(id)
      if (!order) return []
      const pkg = packages.get(id) ?? null
      const relatedBlocks = blocks.get(id) ?? []
      const packingBlock = relatedBlocks.find(blocksPacking)
      const totals = units.get(id) ?? { items: 0, units: 0 }
      return [{ ...order, total: auth.profile.rol === "admin" || auth.profile.rol === "super_admin" ? order.total : null,
        package: pkg, membership: memberships.get(id) ?? null,
        blocked: held.has(id) || relatedBlocks.length > 0,
        blockReason: held.has(id) ? "Pedido cancelado dentro del Bulto" : relatedBlocks[0] ? dispatchBlockReason(relatedBlocks[0].reason) : null,
        packingBlocked: Boolean(packingBlock), pendingBeforeDispatch: relatedBlocks.filter((block) => !blocksPacking(block)).map((block) => dispatchBlockReason(block.reason)),
        itemCount: totals.items, units: totals.units, scannedUnits: pkg?.status === "prepared" ? totals.units : pkg ? scanned.get(pkg.id) ?? 0 : 0,
        preparedByName: pkg?.prepared_by ? preparers.get(pkg.prepared_by) ?? null : null }]
    })
    return Response.json({ orders, batches: [], holds, total: result.total, page, pageSize: DISPATCH_BOARD_PAGE_SIZE, viewerRole: auth.profile.rol }, { headers: { "Cache-Control": "no-store" } })
  }

  const batchResult = await auth.admin.from("dispatch_batches").select("id,code,display_number,status,created_at,closed_at,prepared_at,handed_over_at,handed_over_by,created_by,closed_by,verification_round,verification_required").in("id", ids)
  if (batchResult.error) return fail()
  type Member = { id: number; batch_id: number; order_id: number; package_id: number; removed_at: string | null; verified_at: string | null; verification_round: number | null; added_by: string; verified_by: string | null; removed_by: string | null }
  const members: Member[] = []
  for (let offset = 0; ; offset += 1000) {
    const pageResult = await auth.admin.from("dispatch_batch_items").select("id,batch_id,order_id,package_id,removed_at,verified_at,verification_round,added_by,verified_by,removed_by")
      .in("batch_id", ids).order("id").range(offset, offset + 999)
    if (pageResult.error) return fail()
    members.push(...((pageResult.data ?? []) as Member[]))
    if ((pageResult.data?.length ?? 0) < 1000) break
  }
  const packageIds = [...new Set(members.map((row) => row.package_id))]
  const orderIds = [...new Set(members.map((row) => row.order_id))]
  const [packageResults, orderResults, blockResults] = await Promise.all([
    Promise.all(chunks(packageIds).map((part) => auth.admin.from("order_packages").select("id,parcel_count,prepared_by").in("id", part))),
    Promise.all(chunks(orderIds).map((part) => auth.admin.from("ordenes").select("id,cancelled_at").in("id", part))),
    Promise.all(chunks(orderIds).map((part) => auth.admin.from("dispatch_blocks").select("order_id").in("order_id", part).is("resolved_at", null))),
  ])
  if ([...packageResults, ...orderResults, ...blockResults].some((r) => r.error)) return fail()
  const packages = new Map(packageResults.flatMap((r) => r.data ?? []).map((row) => [row.id, row]))
  const cancelled = new Set(orderResults.flatMap((r) => r.data ?? []).filter((row) => row.cancelled_at).map((row) => row.id))
  const blocked = new Set(blockResults.flatMap((r) => r.data ?? []).map((row) => row.order_id))
  const batchesById = new Map((batchResult.data ?? []).map((row) => [row.id, row]))
  const batches = ids.flatMap((id) => {
    const batch = batchesById.get(id)
    if (!batch) return []
    const active = members.filter((item) => item.batch_id === id && !item.removed_at)
    const removed = members.filter((item) => item.batch_id === id && item.removed_at)
    return [{ ...batch, orderCount: active.length, verifiedCount: active.filter((item) => item.verified_at && item.verification_round === batch.verification_round).length,
      packageCount: active.reduce((sum, item) => sum + (packages.get(item.package_id)?.parcel_count ?? 0), 0),
      blockedCount: active.filter((item) => cancelled.has(item.order_id) || blocked.has(item.order_id)).length,
      removedCount: removed.length }]
  })
  return Response.json({ orders: [], batches, holds, total: result.total, page, pageSize: DISPATCH_BOARD_PAGE_SIZE, viewerRole: auth.profile.rol }, { headers: { "Cache-Control": "no-store" } })
}
