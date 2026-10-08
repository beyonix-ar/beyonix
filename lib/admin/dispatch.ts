import type { createAdminClient } from "@/lib/supabase/admin"
import { compareParcelQuote } from "../shipping/shipping-pricing.ts"

export type DispatchAdmin = ReturnType<typeof createAdminClient>
export type DispatchPackage = { id: number; order_id: number; status: "preparing" | "prepared"; attempt_number: number; prepared_at: string | null; prepared_by: string | null; parcel_count?: number | null; parcels_defined_at?: string | null }
/** Venta aleatoria: variante reservada en el checkout y variante física registrada en el armado vigente. */
export type DispatchRandomTrace = { reservedVariant: string | null; dispatchedVariant: string | null; manuallyConfirmed: boolean }
export type DispatchLine = { order_item_id: number; expected_sku: string | null; expected_barcode: string | null; expected_quantity: number; scanned_quantity: number; product_id: number; variant_id: number | null; conditioned_stock_id: string | null; name?: string; /** Venta aleatoria: el armado acepta cualquier variante elegible del grupo. */ random?: DispatchRandomTrace }
/** Código de grupo en un renglón aleatorio: el operador debe confirmar la variante física. */
export type DispatchVariantCandidate = { variantId: number; name: string | null; colorHex: string | null; colorHexSecondary: string | null; assigned: boolean; selectable: boolean }
export type DispatchScanResult =
  | { requiresVariant: false; orderItemId: number; scanned: number; expected: number; status: string; duplicate: boolean }
  | { requiresVariant: true; productId: number; productName: string | null; candidates: DispatchVariantCandidate[]; status: string }
export type DispatchParcel = { id: number; parcel_index: number; parcel_count: number; barcode: string; attempt_number: number; scanned?: boolean; weight_kg?: number | null; length_cm?: number | null; width_cm?: number | null; height_cm?: number | null }
export type DispatchEstimatedParcel = { lengthCm: number; widthCm: number; heightCm: number; volumeCm3: number; weightKg: number }
/** Estimación usada en checkout (referencia del operador) y recotización con bultos reales (sólo Admin). */
export type DispatchShippingInfo = {
  /** true sólo para Admin/Super Admin: el operador no ve importes. */
  costsVisible: boolean
  estimate: { parcels: DispatchEstimatedParcel[] } | null
  parcelQuote: { status: "quoted" | "failed"; current: boolean; amount: number | null; checkoutAmount: number | null; differenceAmount: number | null; differencePercent: number | null; alert: boolean } | null
}
export type DispatchBatch = { id: number; code: string; status: "open" | "closed" | "handed_over"; created_at: string; closed_at: string | null; prepared_at?: string | null; handed_over_at: string | null; handed_over_by: string | null }
export type DispatchMembership = { id: number; batch_id: number; order_id: number; package_id: number; added_at: string; removed_at: string | null }
export type DispatchOrder = { id: number; estado: string; financial_status: string | null; payment_status: string | null; invoice_status: string | null; shipping_provider: string | null; envio_proveedor: string | null; cancelled_at: string | null; andreani_handed_over_at: string | null; andreani_handed_over_batch_id: number | null }
export type DispatchStage = "pending" | "packing" | "packed" | "parcels_ready" | "in_batch" | "batch_closed" | "handed_over"
export type DispatchBatchItem = DispatchMembership & { blocked: boolean; blockReason: string | null; parcelCount: number | null; scannedParcels: number; parcels: DispatchParcel[] }

export const orderCode = (id: number) => `BX-${1000 + id}`

export const DISPATCH_STAGE_LABELS: Record<DispatchStage, string> = {
  pending: "Pendiente",
  packing: "En armado",
  packed: "Completo",
  parcels_ready: "Bultos listos",
  in_batch: "En lote",
  batch_closed: "Lote cerrado",
  handed_over: "Entregado a Andreani",
}

export function dispatchStage(input: { package: Pick<DispatchPackage, "status" | "parcel_count"> | null; batchStatus?: DispatchBatch["status"] | null; handedOver?: boolean }): DispatchStage {
  if (input.handedOver || input.batchStatus === "handed_over") return "handed_over"
  if (input.batchStatus === "closed") return "batch_closed"
  if (input.batchStatus === "open") return "in_batch"
  if (!input.package) return "pending"
  if (input.package.status === "preparing") return "packing"
  return input.package.parcel_count ? "parcels_ready" : "packed"
}

export function dispatchBlockReason(reason: string): string {
  const reasons: Record<string, string> = {
    cancelled: "Cancelación solicitada", claim: "Reclamo abierto",
    financial_conflict: "Pago en revisión", payment_reversed: "Pago revertido",
    not_paid: "Pago pendiente", invoice_pending: "Factura pendiente",
    change: "Cambio de pedido solicitado", return: "Devolución en curso",
    refund_in_progress: "Reintegro en curso",
    items_changed: "Cambios en los artículos", wrong_carrier: "Transporte incompatible",
    shipment_pending: "Envío pendiente", shipment_uncertain: "Envío en revisión",
    tracking_in_circuit: "Envío ya en curso", already_handed_over: "Ya entregado al transporte",
  }
  return reasons[reason] ?? "Revisión requerida"
}

export function parseOrderCode(value: string): number | null {
  const match = /^#?BX-(\d+)$/i.exec(value.trim())
  if (!match) return null
  const id = Number(match[1]) - 1000
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

export function validId(value: string): number | null {
  const id = Number(value)
  return /^\d+$/.test(value) && Number.isSafeInteger(id) && id > 0 ? id : null
}

export const isRequestKey = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value)

export function dispatchError(error: { message: string; details?: string | null } | null, fallback = "No se pudo completar la operación.") {
  if (!error) return fallback
  const messages: Record<string, string> = {
    DISPATCH_ORDER_BLOCKED: "Este pedido requiere revisión antes del despacho.",
    DISPATCH_WRONG_ITEM: "Este producto no pertenece al pedido.",
    DISPATCH_WRONG_SKU_OR_VARIANT: "Este producto no pertenece al pedido.",
    DISPATCH_CODE_UNKNOWN: "Código no reconocido.",
    DISPATCH_CODE_NOT_PRODUCT: "Ese código es de un bulto o lote, no de un producto.",
    DISPATCH_CODE_IS_PRODUCT: "Ese código es de un producto. Escaneá la etiqueta del bulto.",
    DISPATCH_CODE_IS_BATCH: "Ese código es de un lote. Escaneá la etiqueta del bulto.",
    DISPATCH_PARCEL_UNKNOWN: "Bulto no reconocido.",
    DISPATCH_PARCEL_STALE: "Etiqueta de bulto anterior. Reimprimí las etiquetas del pedido.",
    DISPATCH_PARCEL_OTHER_BATCH: "Este bulto pertenece a otro lote.",
    DISPATCH_PARCEL_COUNT_INVALID: "Indicá entre 1 y 50 bultos.",
    DISPATCH_PARCEL_MEASURES_INVALID: "Completá peso (hasta 1000 kg) y medidas (hasta 500 cm) mayores que 0 en cada bulto.",
    DISPATCH_PARCELS_PENDING: "Finalizá el armado indicando los bultos.",
    DISPATCH_PARCELS_MISSING: "Faltan escanear bultos del pedido.",
    DISPATCH_PARCELS_LOCKED: "Los bultos ya se escanearon en un lote. Retiralo y reiniciá el armado para cambiarlos.",
    DISPATCH_QUANTITY_EXCEEDED: "Cantidad requerida ya completada.",
    DISPATCH_ALREADY_PREPARED: "El armado de este pedido ya está completo.",
    DISPATCH_PREPARATION_NOT_STARTED: "Iniciá el armado primero.",
    DISPATCH_PACKAGE_NOT_PREPARED: "Este pedido todavía no está armado.",
    DISPATCH_SCAN_KEY_CONFLICT: "Este escaneo ya fue utilizado con otro código.",
    DISPATCH_SCAN_INVALID: "Escaneo inválido.",
    DISPATCH_RANDOM_VARIANT_NO_STOCK: "No hay stock libre de esa variante: está reservada o vendida a otro pedido.",
    DISPATCH_VARIANT_CONFIRMATION_MISMATCH: "El código escaneado corresponde a otra variante.",
    DISPATCH_BATCH_CLOSED: "El lote ya está cerrado.",
    DISPATCH_BATCH_EMPTY: "Seleccioná al menos un pedido completo.",
    DISPATCH_BATCH_NOT_CLOSED: "Cerrá el lote antes de confirmar la entrega.",
    DISPATCH_ALREADY_HANDED_OVER: "El lote ya fue entregado.",
    DISPATCH_RESET_REQUIRES_REMOVAL: "Retirá el pedido del lote para reiniciar su armado.",
    DISPATCH_REASON_REQUIRED: "Ingresá un motivo de al menos 10 caracteres.",
    DISPATCH_RESET_REASON_REQUIRED: "Ingresá un motivo de al menos 10 caracteres.",
    DISPATCH_ITEM_IDENTITY_MISSING: "Un artículo no tiene SKU ni código de barras. Revisá el catálogo.",
    DISPATCH_ORDER_EMPTY: "Este pedido no tiene artículos para armar.",
    DISPATCH_ORDER_NOT_FOUND: "No se encontró el pedido.",
    DISPATCH_BATCH_NOT_FOUND: "No se encontró el lote.",
    DISPATCH_FORBIDDEN: "No tenés permisos para operar despachos.",
  }
  const code = Object.keys(messages).sort((left, right) => right.length - left.length).find((key) => error.message.includes(key))
  let message = code ? messages[code] : error.message.includes("dispatch_batch_items_active_order_unique") ? "Este pedido ya pertenece a otro lote." : fallback
  if (code === "DISPATCH_PARCEL_OTHER_BATCH" && error.details && /^DSP-/.test(error.details)) message = `Este bulto pertenece al lote ${error.details}.`
  else if (error.details && /^\d+$/.test(error.details)) message = `${orderCode(Number(error.details))}: ${message}`
  return message
}

const PACKAGE_COLUMNS = "id,order_id,status,attempt_number,prepared_at,prepared_by,parcel_count,parcels_defined_at,parcels_request_key"
const ORDER_COLUMNS = "id,estado,financial_status,payment_status,invoice_status,shipping_provider,envio_proveedor,cancelled_at,andreani_handed_over_at,andreani_handed_over_batch_id"
const ORDER_SHIPPING_COLUMNS = "shipping_estimate,shipping_provider_quote_amount,shipping_parcel_quote_status,shipping_parcel_quote_amount,shipping_parcel_quote_request_key"
const BATCH_COLUMNS = "id,code,status,created_at,closed_at,prepared_at,handed_over_at,handed_over_by"

const optionalNumber = (value: unknown) => value === null || value === undefined ? null : Number(value)

async function currentParcels(admin: DispatchAdmin, packages: Pick<DispatchPackage, "id" | "attempt_number" | "parcel_count">[]) {
  const defined = packages.filter((pkg) => pkg.parcel_count)
  const byPackage = new Map<number, DispatchParcel[]>()
  for (let offset = 0; offset < defined.length; offset += 100) {
    const chunk = defined.slice(offset, offset + 100)
    const result = await admin.from("order_package_parcels").select("id,package_id,parcel_index,parcel_count,barcode,attempt_number,actual_weight_kg,actual_length_cm,actual_width_cm,actual_height_cm").in("package_id", chunk.map((pkg) => pkg.id)).order("parcel_index")
    if (result.error) throw result.error
    const attempts = new Map(chunk.map((pkg) => [pkg.id, pkg]))
    for (const row of result.data ?? []) {
      const pkg = attempts.get(row.package_id)
      if (!pkg || row.attempt_number !== pkg.attempt_number || row.parcel_count !== pkg.parcel_count) continue
      byPackage.set(row.package_id, [...(byPackage.get(row.package_id) ?? []), { id: row.id, parcel_index: row.parcel_index, parcel_count: row.parcel_count, barcode: row.barcode, attempt_number: row.attempt_number, weight_kg: optionalNumber(row.actual_weight_kg), length_cm: optionalNumber(row.actual_length_cm), width_cm: optionalNumber(row.actual_width_cm), height_cm: optionalNumber(row.actual_height_cm) }])
    }
  }
  return byPackage
}

export async function getOrderDispatch(admin: DispatchAdmin, orderId: number, options: { includeCosts?: boolean } = {}) {
  const [orderResult, packageResult, itemsResult, membershipResult, blocksResult] = await Promise.all([
    admin.from("ordenes").select(`${ORDER_COLUMNS},${ORDER_SHIPPING_COLUMNS}`).eq("id", orderId).maybeSingle(),
    admin.from("order_packages").select(PACKAGE_COLUMNS).eq("order_id", orderId).maybeSingle(),
    admin.from("orden_items").select("id,producto_id,variante_id,reserved_variant_id,conditioned_name,cantidad,random_fulfillment,productos(nombre),producto_variantes(nombre)").eq("orden_id", orderId).order("id"),
    admin.from("dispatch_batch_items").select("id,batch_id,order_id,package_id,added_at,removed_at").eq("order_id", orderId).is("removed_at", null).maybeSingle(),
    admin.from("dispatch_blocks").select("id,reason").eq("order_id", orderId).is("resolved_at", null),
  ])
  const failure = [orderResult, packageResult, itemsResult, membershipResult, blocksResult].find((result) => result.error)
  if (failure?.error) throw failure.error
  if (!orderResult.data) return null
  const pkg = packageResult.data as DispatchPackage | null
  const membership = membershipResult.data as DispatchMembership | null
  const randomItemRows = (itemsResult.data ?? []).filter((item) => item.random_fulfillment === true)
  const [linesResult, parcels, batchResult, scansResult] = await Promise.all([
    pkg ? admin.from("order_preparation_lines").select("order_item_id,expected_sku,expected_barcode,expected_quantity,scanned_quantity,product_id,variant_id,conditioned_stock_id").eq("package_id", pkg.id).order("order_item_id") : Promise.resolve(null),
    pkg ? currentParcels(admin, [pkg]) : Promise.resolve(new Map<number, DispatchParcel[]>()),
    membership ? admin.from("dispatch_batches").select(BATCH_COLUMNS).eq("id", membership.batch_id).maybeSingle() : Promise.resolve(null),
    pkg && randomItemRows.length ? admin.from("order_preparation_scans").select("order_item_id,physical_variant_id,variant_identification").eq("package_id", pkg.id).eq("attempt_number", pkg.attempt_number).order("id") : Promise.resolve(null),
  ])
  if (linesResult?.error) throw linesResult.error
  if (batchResult?.error) throw batchResult.error
  if (scansResult?.error) throw scansResult.error
  const randomTrace = await randomTraces(admin, randomItemRows, (scansResult?.data ?? []) as RandomScanRow[])
  const names = new Map<number, string>()
  for (const item of itemsResult.data ?? []) {
    const product = item.productos as unknown as { nombre?: string } | null
    const variant = item.producto_variantes as unknown as { nombre?: string } | null
    const variantLabel = item.random_fulfillment === true ? "Color aleatorio" : variant?.nombre
    names.set(item.id, [item.conditioned_name || product?.nombre || "Producto", variantLabel].filter(Boolean).join(" · "))
  }
  const lines = ((linesResult?.data ?? []) as DispatchLine[]).map((line) => {
    const random = randomTrace.get(line.order_item_id)
    return { ...line, name: names.get(line.order_item_id) ?? "Producto", ...(random ? { random } : {}) }
  })
  const batch = (batchResult?.data ?? null) as DispatchBatch | null
  const { shipping_estimate: estimate, shipping_provider_quote_amount: checkoutQuote, shipping_parcel_quote_status: quoteStatus, shipping_parcel_quote_amount: quoteAmount, shipping_parcel_quote_request_key: quoteKey, ...orderFields } = orderResult.data as unknown as DispatchOrder & DispatchOrderShippingRow
  const order: DispatchOrder = orderFields
  const shipping = dispatchShippingInfo({ estimate, checkoutQuote, quoteStatus, quoteAmount, quoteKey, requestKey: (pkg as { parcels_request_key?: string | null } | null)?.parcels_request_key ?? null, includeCosts: Boolean(options.includeCosts) })
  const stage = dispatchStage({ package: pkg, batchStatus: batch?.status ?? null, handedOver: Boolean(order.andreani_handed_over_at) })
  return { order, package: pkg, lines, parcels: pkg ? parcels.get(pkg.id) ?? [] : [], stage, itemCount: itemsResult.data?.length ?? 0, expectedUnits: (itemsResult.data ?? []).reduce((sum, item) => sum + Number(item.cantidad), 0), membership, batch, shipping, blocked: (blocksResult.data?.length ?? 0) > 0, blockReason: blocksResult.data?.[0] ? dispatchBlockReason(blocksResult.data[0].reason) : null }
}

type RandomScanRow = { order_item_id: number; physical_variant_id: number | null; variant_identification: string | null }

/**
 * Reservada vs despachada de cada renglón aleatorio. "Despachada" sale del
 * escaneo del armado vigente (nunca de la reserva): sin escaneo queda null.
 */
async function randomTraces(admin: DispatchAdmin, items: Array<{ id: number; reserved_variant_id?: number | null }>, scans: RandomScanRow[]) {
  const traces = new Map<number, DispatchRandomTrace>()
  if (!items.length) return traces
  const lastScan = new Map(scans.map((scan) => [scan.order_item_id, scan]))
  const ids = [...new Set([
    ...items.map((item) => item.reserved_variant_id),
    ...scans.map((scan) => scan.physical_variant_id),
  ].filter((id): id is number => typeof id === "number"))]
  const variantNames = new Map<number, string>()
  if (ids.length) {
    const result = await admin.from("producto_variantes").select("id,nombre").in("id", ids)
    if (result.error) throw result.error
    for (const row of result.data ?? []) variantNames.set(Number(row.id), row.nombre ?? `Variante #${row.id}`)
  }
  const nameOf = (id: number | null | undefined) => (typeof id === "number" ? variantNames.get(id) ?? `Variante #${id}` : null)
  for (const item of items) {
    const scan = lastScan.get(item.id)
    traces.set(item.id, {
      reservedVariant: nameOf(item.reserved_variant_id),
      dispatchedVariant: nameOf(scan?.physical_variant_id),
      manuallyConfirmed: scan?.variant_identification === "group_confirmed",
    })
  }
  return traces
}

type DispatchOrderShippingRow = {
  shipping_estimate: unknown
  shipping_provider_quote_amount: number | string | null
  shipping_parcel_quote_status: "quoted" | "failed" | null
  shipping_parcel_quote_amount: number | string | null
  shipping_parcel_quote_request_key: string | null
}

const isEstimatedParcel = (value: unknown): value is DispatchEstimatedParcel =>
  Boolean(value) && typeof value === "object" &&
  (["lengthCm", "widthCm", "heightCm", "volumeCm3", "weightKg"] as const)
    .every((field) => Number.isFinite((value as Record<string, unknown>)[field]))

export function dispatchShippingInfo(input: {
  estimate: unknown
  checkoutQuote: number | string | null
  quoteStatus: "quoted" | "failed" | null
  quoteAmount: number | string | null
  quoteKey: string | null
  requestKey: string | null
  includeCosts: boolean
}): DispatchShippingInfo {
  const rawParcels = (input.estimate as { parcels?: unknown } | null)?.parcels
  const parcels = Array.isArray(rawParcels) ? rawParcels.filter(isEstimatedParcel) : []
  let parcelQuote: DispatchShippingInfo["parcelQuote"] = null
  if (input.includeCosts && input.quoteStatus) {
    const amount = input.quoteAmount === null ? null : Number(input.quoteAmount)
    const checkoutAmount = input.checkoutQuote === null ? null : Number(input.checkoutQuote)
    const comparison = amount !== null && checkoutAmount !== null
      ? compareParcelQuote(Math.round(checkoutAmount * 100), Math.round(amount * 100))
      : null
    parcelQuote = {
      status: input.quoteStatus,
      current: Boolean(input.quoteKey && input.requestKey === input.quoteKey),
      amount,
      checkoutAmount,
      differenceAmount: comparison ? comparison.differenceCents / 100 : null,
      differencePercent: comparison?.differencePercent ?? null,
      alert: comparison?.alert ?? false,
    }
  }
  return { costsVisible: input.includeCosts, estimate: parcels.length ? { parcels } : null, parcelQuote }
}

export type OrderDispatchDetail = NonNullable<Awaited<ReturnType<typeof getOrderDispatch>>>
export type BatchDispatchDetail = NonNullable<Awaited<ReturnType<typeof getBatchDispatch>>>

export async function getBatchDispatch(admin: DispatchAdmin, batchId: number) {
  const [batchResult, itemsResult, scansResult] = await Promise.all([
    admin.from("dispatch_batches").select(BATCH_COLUMNS).eq("id", batchId).maybeSingle(),
    admin.from("dispatch_batch_items").select("id,batch_id,order_id,package_id,added_at,removed_at").eq("batch_id", batchId).is("removed_at", null).order("order_id"),
    admin.from("dispatch_batch_parcel_scans").select("batch_item_id,parcel_id").eq("batch_id", batchId),
  ])
  if (batchResult.error || itemsResult.error || scansResult.error) throw batchResult.error ?? itemsResult.error ?? scansResult.error
  if (!batchResult.data) return null
  const items = (itemsResult.data ?? []) as DispatchMembership[]
  const ids = items.map((item) => item.order_id)
  const [blocksResult, ordersResult, packagesResult] = ids.length ? await Promise.all([
    admin.from("dispatch_blocks").select("order_id,reason").in("order_id", ids).is("resolved_at", null),
    admin.from("ordenes").select("id,cancelled_at,andreani_handed_over_at").in("id", ids),
    admin.from("order_packages").select("id,attempt_number,parcel_count").in("id", items.map((item) => item.package_id)),
  ]) : [{ data: [], error: null }, { data: [], error: null }, { data: [], error: null }]
  if (blocksResult.error || ordersResult.error || packagesResult.error) throw blocksResult.error ?? ordersResult.error ?? packagesResult.error
  const packages = (packagesResult.data ?? []) as Pick<DispatchPackage, "id" | "attempt_number" | "parcel_count">[]
  const parcelsByPackage = await currentParcels(admin, packages)
  const packageById = new Map(packages.map((pkg) => [pkg.id, pkg]))
  const scanned = new Map<number, Set<number>>()
  for (const scan of scansResult.data ?? []) scanned.set(scan.batch_item_id, (scanned.get(scan.batch_item_id) ?? new Set()).add(scan.parcel_id))
  const blockReasons = new Map((blocksResult.data ?? []).map((block) => [block.order_id, dispatchBlockReason(block.reason)]))
  const blockedIds = new Set(blockReasons.keys())
  for (const order of ordersResult.data ?? []) if (order.cancelled_at && !order.andreani_handed_over_at) blockedIds.add(order.id)
  const batch = batchResult.data as DispatchBatch
  const operatorResult = batch.handed_over_by ? await admin.from("profiles").select("nombre,username,email").eq("id", batch.handed_over_by).maybeSingle() : null
  if (operatorResult?.error) throw operatorResult.error
  const operator = operatorResult?.data
  const detailed: DispatchBatchItem[] = items.map((item) => {
    const parcels = parcelsByPackage.get(item.package_id) ?? []
    const itemScans = scanned.get(item.id) ?? new Set<number>()
    return { ...item, blocked: blockedIds.has(item.order_id), blockReason: blockReasons.get(item.order_id) ?? (blockedIds.has(item.order_id) ? "Revisión requerida" : null), parcelCount: packageById.get(item.package_id)?.parcel_count ?? null, scannedParcels: parcels.filter((parcel) => itemScans.has(parcel.id)).length, parcels: parcels.map((parcel) => ({ ...parcel, scanned: itemScans.has(parcel.id) })) }
  })
  return { batch, items: detailed, blockedCount: blockedIds.size, parcelCount: detailed.reduce((sum, item) => sum + (item.parcelCount ?? 0), 0), scannedParcelCount: detailed.reduce((sum, item) => sum + item.scannedParcels, 0), operatorName: operator?.nombre || operator?.username || operator?.email || null }
}
