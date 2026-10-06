import { requireOperator } from "@/app/api/admin/clientes/_auth"
import { dispatchBlockReason } from "@/lib/admin/dispatch"

export async function GET(request: Request) {
  const auth = await requireOperator(request)
  if ("error" in auth) return auth.error
  const alertsOnly = new URL(request.url).searchParams.has("alerts")
  const [ordersResult, batchesResult] = await Promise.all([
    alertsOnly ? Promise.resolve({ data: [], error: null }) : auth.admin.from("ordenes").select("id,estado,financial_status,payment_status,invoice_status,shipping_provider,envio_proveedor,cancelled_at,andreani_handed_over_at,andreani_handed_over_batch_id").eq("financial_status", "payment_confirmed").is("cancelled_at", null).is("andreani_handed_over_at", null).order("id", { ascending: false }).limit(100),
    auth.admin.from("dispatch_batches").select("id,code,status,created_at,closed_at,prepared_at,handed_over_at,handed_over_by").order("id", { ascending: false }).limit(100),
  ])
  if (ordersResult.error || batchesResult.error) return Response.json({ error: "No se pudieron cargar los despachos." }, { status: 500 })
  const orderIds = (ordersResult.data ?? []).map((order) => order.id)
  const batches = batchesResult.data ?? []
  const packageResult = orderIds.length ? await auth.admin.from("order_packages").select("id,order_id,status,attempt_number,prepared_at,prepared_by").in("order_id", orderIds) : { data: [], error: null }
  if (packageResult.error) return Response.json({ error: "No se pudieron cargar los bultos." }, { status: 500 })
  const packages = packageResult.data ?? []
  const memberships: { id: number; batch_id: number; order_id: number; package_id: number; added_at: string; removed_at: string | null }[] = []
  // PostgREST limita el tamaño de respuesta: recorrer todas las filas activas
  // mantiene exactos los contadores incluso cuando hay más de 500 bultos.
  const batchIds = batches.map((batch) => batch.id)
  if (batchIds.length) for (let offset = 0; ; offset += 1000) {
    const page = await auth.admin.from("dispatch_batch_items").select("id,batch_id,order_id,package_id,added_at,removed_at").is("removed_at", null).in("batch_id", batchIds).order("id").range(offset, offset + 999)
    if (page.error) return Response.json({ error: "No se pudieron cargar las tandas." }, { status: 500 })
    memberships.push(...(page.data ?? []))
    if ((page.data?.length ?? 0) < 1000) break
  }
  if (orderIds.length) {
    const memberOrders = await auth.admin.from("dispatch_batch_items").select("id,batch_id,order_id,package_id,added_at,removed_at").is("removed_at", null).in("order_id", orderIds)
    if (memberOrders.error) return Response.json({ error: "No se pudieron cargar los pedidos en tanda." }, { status: 500 })
    const seen = new Set(memberships.map((item) => item.id))
    for (const item of memberOrders.data ?? []) if (!seen.has(item.id)) memberships.push(item)
  }
  const packageByOrder = new Map(packages.map((item) => [item.order_id, item]))
  const membershipByOrder = new Map(memberships.map((item) => [item.order_id, item]))
  const orders = (ordersResult.data ?? []).filter((order) => (order.shipping_provider || order.envio_proveedor || "").toLowerCase() === "andreani" && !["cancelado", "enviado", "en_camino", "entregado"].includes(order.estado)).map((order) => ({ ...order, package: packageByOrder.get(order.id) ?? null, membership: membershipByOrder.get(order.id) ?? null }))
  // El resumen es una lectura; todas las transiciones vuelven a comprobarse en las RPC.
  const memberOrderIds = [...new Set(memberships.map((item) => item.order_id))]
  const blockedIds = new Set<number>()
  const blockedReasons = new Map<number, string>()
  const blockedAt = new Map<number, string>()
  for (let offset = 0; offset < memberOrderIds.length; offset += 100) {
    const ids = memberOrderIds.slice(offset, offset + 100)
    const [blocksResult, memberOrdersResult] = await Promise.all([
      auth.admin.from("dispatch_blocks").select("order_id,reason,created_at").in("order_id", ids).is("resolved_at", null),
      auth.admin.from("ordenes").select("id,cancelled_at,andreani_handed_over_at").in("id", ids),
    ])
    if (blocksResult.error || memberOrdersResult.error) return Response.json({ error: "No se pudieron cargar los bloqueos." }, { status: 500 })
    for (const block of blocksResult.data ?? []) { blockedIds.add(block.order_id); if (!blockedReasons.has(block.order_id)) { blockedReasons.set(block.order_id, dispatchBlockReason(block.reason)); blockedAt.set(block.order_id, block.created_at) } }
    for (const order of memberOrdersResult.data ?? []) if (order.cancelled_at && !order.andreani_handed_over_at) blockedIds.add(order.id)
  }
  const batchCards = batches.map((batch) => {
    const items = memberships.filter((item) => item.batch_id === batch.id)
    return { ...batch, orderCount: items.length, packageCount: items.length, blockedCount: items.filter((item) => blockedIds.has(item.order_id)).length,
      blockedOrders: items.filter((item) => blockedIds.has(item.order_id)).map((item) => ({ orderId: item.order_id, reason: blockedReasons.get(item.order_id) ?? "Revisión requerida", createdAt: blockedAt.get(item.order_id) ?? batch.created_at })) }
  })
  return Response.json(alertsOnly ? { batches: batchCards.filter((batch) => batch.blockedCount > 0) } : { orders, batches: batchCards }, { headers: { "Cache-Control": "no-store" } })
}
