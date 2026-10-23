import { requireOperator } from "@/app/api/admin/clientes/_auth"
import { blocksPacking, dispatchBlockReason, dispatchHold, HOLD_COLUMNS, ORDER_COLUMNS, type DispatchOrder } from "@/lib/admin/dispatch"
import { dispatchBatchName } from "@/lib/admin/dispatch-queue"

type PackageRow = { id: number; order_id: number; status: string; attempt_number: number; prepared_at: string | null; prepared_by: string | null; parcel_count: number | null; parcels_defined_at: string | null; identification_method: string | null }
type MembershipRow = { id: number; batch_id: number; order_id: number; package_id: number; added_at: string; removed_at: string | null; verified_at: string | null; verification_round: number | null }
type HoldRow = { id: number; order_id: number; attempt_number: number; batch_id: number | null; units: number; picked_units: number; prepared: boolean; items: unknown; detected_at: string }
const PACKAGE_COLUMNS = "id,order_id,status,attempt_number,prepared_at,prepared_by,parcel_count,parcels_defined_at,identification_method"
const MEMBERSHIP_COLUMNS = "id,batch_id,order_id,package_id,added_at,removed_at,verified_at,verification_round"
const BATCH_COLUMNS = "id,code,display_number,status,created_at,closed_at,prepared_at,handed_over_at,handed_over_by,verification_round"
const PAGE = 1000
const CHUNK = 100
// Estados en los que el pedido ya salió por fuera de Despachos (circuito anterior).
const OUT_OF_DISPATCH = ["cancelado", "enviado", "en_camino", "entregado"]

const chunks = <T,>(values: T[]) => Array.from({ length: Math.ceil(values.length / CHUNK) }, (_, index) => values.slice(index * CHUNK, (index + 1) * CHUNK))

export async function GET(request: Request) {
  const auth = await requireOperator(request)
  if ("error" in auth) return auth.error
  const alertsOnly = new URL(request.url).searchParams.has("alerts")
  const includeAmounts = auth.profile.rol === "admin" || auth.profile.rol === "super_admin"
  const fail = (message: string) => Response.json({ error: message }, { status: 500 })

  // Todos los pedidos pagos pendientes de despacho, sin importar la fecha:
  // la cola completa se recorre por páginas (sin tope artificial).
  const activeOrders: DispatchOrder[] = []
  if (!alertsOnly) for (let offset = 0; ; offset += PAGE) {
    const page = await auth.admin.from("ordenes").select(ORDER_COLUMNS).eq("financial_status", "payment_confirmed").is("cancelled_at", null).is("andreani_handed_over_at", null)
      .not("estado", "in", `(${OUT_OF_DISPATCH.join(",")})`).order("id", { ascending: false }).range(offset, offset + PAGE - 1)
    if (page.error) return fail("No se pudieron cargar los despachos.")
    activeOrders.push(...((page.data ?? []) as DispatchOrder[]))
    if ((page.data?.length ?? 0) < PAGE) break
  }
  const [historicalBatches, holdsResult] = await Promise.all([
    auth.admin.from("dispatch_batches").select(BATCH_COLUMNS).neq("status", "open").order("id", { ascending: false }).limit(100),
    auth.admin.from("order_cancellation_holds").select(HOLD_COLUMNS).is("resolved_at", null).order("detected_at"),
  ])
  if (historicalBatches.error || holdsResult.error) return fail("No se pudieron cargar los despachos.")
  const openBatches: NonNullable<typeof historicalBatches.data> = []
  for (let offset = 0; ; offset += PAGE) {
    const page = await auth.admin.from("dispatch_batches").select(BATCH_COLUMNS).eq("status", "open")
      .order("id", { ascending: false }).range(offset, offset + PAGE - 1)
    if (page.error) return fail("No se pudieron cargar los Bultos abiertos.")
    openBatches.push(...(page.data ?? []))
    if ((page.data?.length ?? 0) < PAGE) break
  }
  const orderIds = activeOrders.map((order) => order.id)
  const batches = [...openBatches, ...(historicalBatches.data ?? [])].sort((left, right) => right.id - left.id)
  const packages: PackageRow[] = []
  const unitsByOrder = new Map<number, { items: number; units: number }>()
  for (const ids of chunks(orderIds)) {
    const [packagePage, itemsPage] = await Promise.all([
      auth.admin.from("order_packages").select(PACKAGE_COLUMNS).in("order_id", ids),
      auth.admin.from("orden_items").select("orden_id,cantidad").in("orden_id", ids),
    ])
    if (packagePage.error || itemsPage.error) return fail("No se pudieron cargar los bultos.")
    packages.push(...((packagePage.data ?? []) as PackageRow[]))
    for (const item of itemsPage.data ?? []) {
      const current = unitsByOrder.get(item.orden_id) ?? { items: 0, units: 0 }
      unitsByOrder.set(item.orden_id, { items: current.items + 1, units: current.units + Number(item.cantidad) })
    }
  }
  const scannedByPackage = new Map<number, number>()
  for (const ids of chunks(packages.filter((pkg) => pkg.status === "preparing").map((pkg) => pkg.id))) {
    const lines = await auth.admin.from("order_preparation_lines").select("package_id,scanned_quantity").in("package_id", ids)
    if (lines.error) return fail("No se pudo cargar el progreso del armado.")
    for (const line of lines.data ?? []) scannedByPackage.set(line.package_id, (scannedByPackage.get(line.package_id) ?? 0) + Number(line.scanned_quantity))
  }
  const memberships: MembershipRow[] = []
  // PostgREST limita el tamaño de respuesta: recorrer todas las filas activas
  // mantiene exactos los contadores incluso cuando hay más de 500 pedidos.
  const batchIds = batches.map((batch) => batch.id)
  if (batchIds.length) for (let offset = 0; ; offset += PAGE) {
    const page = await auth.admin.from("dispatch_batch_items").select(MEMBERSHIP_COLUMNS).is("removed_at", null).in("batch_id", batchIds).order("id").range(offset, offset + PAGE - 1)
    if (page.error) return fail("No se pudieron cargar los lotes.")
    memberships.push(...(page.data ?? []))
    if ((page.data?.length ?? 0) < PAGE) break
  }
  const seen = new Set(memberships.map((item) => item.id))
  for (const ids of chunks(orderIds)) {
    const memberOrders = await auth.admin.from("dispatch_batch_items").select(MEMBERSHIP_COLUMNS).is("removed_at", null).in("order_id", ids)
    if (memberOrders.error) return fail("No se pudieron cargar los pedidos en lote.")
    for (const item of memberOrders.data ?? []) if (!seen.has(item.id)) { seen.add(item.id); memberships.push(item) }
  }
  const packageById = new Map(packages.map((item) => [item.id, item]))
  const missingPackageIds = [...new Set(memberships.map((item) => item.package_id))].filter((id) => !packageById.has(id))
  for (const ids of chunks(missingPackageIds)) {
    const page = await auth.admin.from("order_packages").select(PACKAGE_COLUMNS).in("id", ids)
    if (page.error) return fail("No se pudieron cargar los bultos.")
    for (const row of (page.data ?? []) as PackageRow[]) packageById.set(row.id, row)
  }
  const packageByOrder = new Map(packages.map((item) => [item.order_id, item]))
  const membershipByOrder = new Map(memberships.map((item) => [item.order_id, item]))
  const holdRows = (holdsResult.data ?? []) as HoldRow[]
  const heldIds = new Set(holdRows.map((hold) => hold.order_id))
  // El resumen es una lectura; todas las transiciones vuelven a comprobarse en las RPC.
  const watchedOrderIds = [...new Set([...memberships.map((item) => item.order_id), ...packages.map((item) => item.order_id)])]
  const blockedIds = new Set<number>(heldIds)
  const blockedReasons = new Map<number, string>()
  const blockedAt = new Map<number, string>()
  const packingBlockedIds = new Set<number>()
  const pendingBeforeDispatch = new Map<number, string[]>()
  for (const ids of chunks(watchedOrderIds)) {
    const [blocksResult, memberOrdersResult] = await Promise.all([
      auth.admin.from("dispatch_blocks").select("order_id,reason,source,created_at").in("order_id", ids).is("resolved_at", null),
      auth.admin.from("ordenes").select("id,cancelled_at,andreani_handed_over_at").in("id", ids),
    ])
    if (blocksResult.error || memberOrdersResult.error) return fail("No se pudieron cargar los bloqueos.")
    for (const block of blocksResult.data ?? []) {
      blockedIds.add(block.order_id)
      // Factura/envío pendientes no frenan el pickeo: sólo se informan.
      if (blocksPacking(block)) {
        packingBlockedIds.add(block.order_id)
        if (!blockedReasons.has(block.order_id)) { blockedReasons.set(block.order_id, dispatchBlockReason(block.reason)); blockedAt.set(block.order_id, block.created_at) }
      } else pendingBeforeDispatch.set(block.order_id, [...(pendingBeforeDispatch.get(block.order_id) ?? []), dispatchBlockReason(block.reason)])
    }
    for (const block of blocksResult.data ?? []) if (!blockedReasons.has(block.order_id)) { blockedReasons.set(block.order_id, dispatchBlockReason(block.reason)); blockedAt.set(block.order_id, block.created_at) }
    for (const order of memberOrdersResult.data ?? []) if (order.cancelled_at && !order.andreani_handed_over_at) blockedIds.add(order.id)
  }
  for (const hold of holdRows) { blockedReasons.set(hold.order_id, "Pedido cancelado dentro del Bulto general"); blockedAt.set(hold.order_id, hold.detected_at) }
  const batchById = new Map(batches.map((batch) => [batch.id, batch]))
  // Nombre visible del Bulto (Bulto - 0008); los DSP históricos conservan su código.
  const holdBatchLabel = (batchId: number | null) => {
    const batch = batchId ? batchById.get(batchId) : undefined
    return batch ? (batch.display_number ? dispatchBatchName(batch) : batch.code) : null
  }
  const holds = holdRows.map((row) => dispatchHold(row, holdBatchLabel(row.batch_id)))
  const orders = activeOrders.filter((order) => (order.shipping_provider || order.envio_proveedor || "").toLowerCase() === "andreani" && !OUT_OF_DISPATCH.includes(order.estado)).map((order) => {
    const pkg = packageByOrder.get(order.id) ?? null
    const totals = unitsByOrder.get(order.id) ?? { items: 0, units: 0 }
    return { ...order, total: includeAmounts && order.total != null ? Number(order.total) : null, package: pkg, membership: membershipByOrder.get(order.id) ?? null, blocked: blockedIds.has(order.id), blockReason: blockedReasons.get(order.id) ?? null,
      packingBlocked: packingBlockedIds.has(order.id), pendingBeforeDispatch: pendingBeforeDispatch.get(order.id) ?? [],
      itemCount: totals.items, units: totals.units, scannedUnits: !pkg ? 0 : pkg.status === "prepared" ? totals.units : scannedByPackage.get(pkg.id) ?? 0 }
  })
  const batchCards = batches.map((batch) => {
    const items = memberships.filter((item) => item.batch_id === batch.id)
    const round = batch.verification_round ?? 1
    return { ...batch, orderCount: items.length, verifiedCount: items.filter((item) => item.verified_at && item.verification_round === round).length, packageCount: items.reduce((sum, item) => sum + (packageById.get(item.package_id)?.parcel_count ?? 0), 0), blockedCount: items.filter((item) => blockedIds.has(item.order_id)).length,
      blockedOrders: items.filter((item) => blockedIds.has(item.order_id)).map((item) => ({ orderId: item.order_id, reason: blockedReasons.get(item.order_id) ?? "Revisión requerida", createdAt: blockedAt.get(item.order_id) ?? batch.created_at })) }
  }).filter((batch) => batch.orderCount > 0)
  // Un Bulto finalizado ya no requiere una entrega adicional.
  return Response.json(alertsOnly ? { batches: batchCards.filter((batch) => batch.blockedCount > 0), holds } : { orders, batches: batchCards, holds, viewerRole: auth.profile.rol }, { headers: { "Cache-Control": "no-store" } })
}
