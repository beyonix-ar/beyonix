import type { createAdminClient } from "@/lib/supabase/admin"
import { compareParcelQuote } from "../shipping/shipping-pricing.ts"

export type DispatchAdmin = ReturnType<typeof createAdminClient>
/** Identificación física del pedido preparado: etiqueta Andreani impresa (o, histórico, BX-PREP impresa o escrita a mano). */
export type DispatchIdentificationMethod = "andreani" | "printed" | "manual"
export type DispatchPackage = { id: number; order_id: number; status: "preparing" | "prepared"; attempt_number: number; prepared_at: string | null; prepared_by: string | null; parcel_count?: number | null; parcels_defined_at?: string | null; identification_method?: DispatchIdentificationMethod | null; identified_at?: string | null }
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
/** Bulto general = dispatch_batches (código DSP). */
export type DispatchBatch = { id: number; code: string; display_number?: number | null; status: "open" | "closed" | "handed_over"; created_at: string; closed_at: string | null; prepared_at?: string | null; handed_over_at: string | null; handed_over_by: string | null; verification_round?: number; verification_required?: boolean }
export type DispatchMembership = { id: number; batch_id: number; order_id: number; package_id: number; added_at: string; removed_at: string | null }
/** Cómo se verificó un pedido dentro del Bulto general (mismo backend para todos). */
export type DispatchVerificationMethod = "scanner" | "camera" | "manual_code" | "manual_selection" | "legacy_parcels"
/** Lectura de un código: lector USB, cámara o tipeo/pegado. */
export type DispatchScanMethod = "scanner" | "camera" | "manual_code"
export const DISPATCH_VERIFICATION_METHOD_LABELS: Record<DispatchVerificationMethod, string> = {
  scanner: "Lector", camera: "Cámara", manual_code: "Código ingresado", manual_selection: "Confirmación manual", legacy_parcels: "Histórico · paquetes BX-PKG escaneados",
}
export type DispatchVerificationResult = { orderId: number; code: string; method: DispatchVerificationMethod; duplicate: boolean; expected: number; verified: number }
export type DispatchOrder = { id: number; estado: string; financial_status: string | null; payment_status: string | null; invoice_status: string | null; total?: number | null; shipping_provider: string | null; envio_proveedor: string | null; cancelled_at: string | null; andreani_handed_over_at: string | null; andreani_handed_over_batch_id: number | null; created_at: string; andreani_created_at?: string | null; cliente_nombre: string | null; andreani_envio_id: string | null; andreani_tracking: string | null; andreani_creation_status: string | null }
export type DispatchSaleItem = { orderItemId: number; sku: string | null; productName: string; variantName: string | null; orderedQuantity: number; unitPrice: number | null }
/** Orden operativo: pickeo → pedido completo → envío Andreani → etiqueta Andreani → Bulto general → DSP → entrega. */
export type DispatchStage = "pending" | "packing" | "shipment" | "label" | "ready" | "in_batch" | "batch_closed" | "handed_over"
/** Pedido esperado dentro del Bulto general: verificado con su etiqueta Andreani (o confirmación manual explícita). */
export type DispatchBatchItem = DispatchMembership & {
  blocked: boolean; blockReason: string | null; cancellationHold: boolean
  /** Código que identifica el pedido: seguimiento Andreani (o BX-PREP en pedidos históricos). */
  labelCode: string; verified: boolean; verifiedAt: string | null; verificationMethod: DispatchVerificationMethod | null
  /** Paquetes de envío BX-PKG (medidas Andreani): sólo informativos acá. */
  parcelCount: number | null; parcels: DispatchParcel[]
}

export const orderCode = (id: number) => `BX-${1000 + id}`

/** Código BX-PREP del pedido preparado (histórico; misma regla que order_preparation_barcode en la base). */
export const preparedOrderCode = (orderId: number, attempt: number) =>
  `BX-PREP-${1000 + orderId}${attempt > 1 ? `-R${attempt}` : ""}`

/**
 * Pedido cancelado con armado completo: el stock sigue retenido y el reintegro
 * en pausa hasta escanear el pedido (order_cancellation_holds).
 */
export type DispatchHold = {
  id: number
  orderId: number
  units: number
  /** Unidades ya pickeadas al cancelarse (la retención nace con el primer escaneo). */
  pickedUnits: number
  /** true = armado completo con etiquetas; false = pickeo parcial. */
  prepared: boolean
  itemCount: number
  detectedAt: string
  batchId: number | null
  batchCode: string | null
}

/** Resultado del escaneo de retiro físico (resolve_cancelled_order_preparation). */
export type CancellationResolutionResult = {
  orderId: number
  units: number
  pickedUnits: number
  batchId: number | null
  batchCode: string | null
  duplicate: boolean
  alreadyResolved: boolean
}

type HoldRow = { id: number; order_id: number; attempt_number: number; batch_id: number | null; units: number; picked_units: number; prepared: boolean; items: unknown; detected_at: string }
export const HOLD_COLUMNS = "id,order_id,attempt_number,batch_id,units,picked_units,prepared,items,detected_at"

export function dispatchHold(row: HoldRow, batchCode: string | null): DispatchHold {
  return {
    id: row.id, orderId: row.order_id, units: row.units, pickedUnits: row.picked_units, prepared: row.prepared,
    itemCount: Array.isArray(row.items) ? row.items.length : 0,
    detectedAt: row.detected_at, batchId: row.batch_id, batchCode,
  }
}

export const DISPATCH_STAGE_LABELS: Record<DispatchStage, string> = {
  pending: "Sin empezar",
  packing: "En pickeo",
  shipment: "Pedido completo",
  label: "Envío generado",
  ready: "Listo para Bulto",
  in_batch: "En Bulto",
  batch_closed: "Bulto finalizado",
  handed_over: "Bulto finalizado",
}

/** Envío Andreani creado y confirmado (misma condición que shipment_pending en la base). */
export const andreaniShipmentCreated = (order: Pick<DispatchOrder, "andreani_envio_id" | "andreani_creation_status">) =>
  Boolean(order.andreani_envio_id?.trim()) && order.andreani_creation_status === "created"

type StagePackage = Pick<DispatchPackage, "status" | "identification_method">

export function dispatchStage(input: { package: StagePackage | null; shipmentCreated: boolean; batchStatus?: DispatchBatch["status"] | null; handedOver?: boolean }): DispatchStage {
  if (input.handedOver || input.batchStatus === "handed_over") return "handed_over"
  if (input.batchStatus === "closed") return "batch_closed"
  if (input.batchStatus === "open") return "in_batch"
  if (!input.package) return "pending"
  if (input.package.status === "preparing") return "packing"
  if (!input.shipmentCreated) return "shipment"
  return input.package.identification_method ? "ready" : "label"
}

/** Listo para el Bulto general: pickeo completo, envío Andreani creado y etiqueta impresa. */
export const readyForGeneralBundle = (pkg: StagePackage | null, shipmentCreated: boolean) =>
  Boolean(pkg && pkg.status === "prepared" && pkg.identification_method && shipmentCreated)

/** Problemas que un operador resuelve durante el pickeo (order_preparation_adjustments). */
export const DISPATCH_ADJUSTMENT_PROBLEMS = {
  stock_shortage: "Faltante de stock",
  damaged: "Producto dañado",
  quantity_reduction: "Reducción acordada con el cliente",
  other: "Otro",
} as const
export type DispatchAdjustmentProblem = keyof typeof DISPATCH_ADJUSTMENT_PROBLEMS
/** Resolución de la diferencia de dinero: siempre manual, nunca automática. */
export const DISPATCH_ADJUSTMENT_SETTLEMENTS = {
  manual_refund: "Reintegro manual pendiente",
  customer_credit: "Saldo a favor (manual)",
  no_difference: "Sin diferencia de dinero (acordado)",
} as const
export type DispatchAdjustmentSettlement = keyof typeof DISPATCH_ADJUSTMENT_SETTLEMENTS
export type DispatchAdjustment = {
  id: number; orderItemId: number; problem: DispatchAdjustmentProblem; quantityBefore: number; quantityAfter: number
  settlement: DispatchAdjustmentSettlement; agreement: string; createdAt: string
  /** Sólo Admin/Super Admin: el operador no ve importes. */
  differenceAmount: number | null
}

/**
 * Pendientes que NO frenan el armado (misma excepción que begin/scan en la
 * base): la factura y la etiqueta Andreani pueden completarse mientras se
 * pickea; sólo son obligatorias para entrar al lote.
 */
export const PRE_DISPATCH_PENDING_REASONS: ReadonlySet<string> = new Set(["invoice_pending", "shipment_pending"])

export function blocksPacking(block: { reason: string; source?: string | null }) {
  return block.source === "manual" || !PRE_DISPATCH_PENDING_REASONS.has(block.reason)
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
    DISPATCH_CODE_NOT_PRODUCT: "Ese código es de un paquete de envío o de un Bulto general, no de un producto.",
    DISPATCH_CODE_IS_PRODUCT: "Ese código es de un producto, no de la etiqueta Andreani del pedido.",
    DISPATCH_CODE_IS_BATCH: "Ese código es de un Bulto general (DSP).",
    DISPATCH_PARCEL_UNKNOWN: "Paquete de envío no reconocido.",
    DISPATCH_PARCEL_STALE: "Etiqueta anterior del pedido. Reimprimí las etiquetas vigentes.",
    DISPATCH_PARCEL_OTHER_BATCH: "Este paquete pertenece a otro Bulto general.",
    DISPATCH_PARCEL_COUNT_INVALID: "Indicá entre 1 y 50 paquetes.",
    DISPATCH_PARCEL_MEASURES_INVALID: "Completá peso (hasta 1000 kg) y medidas (hasta 500 cm) mayores que 0 en cada paquete.",
    DISPATCH_PARCELS_PENDING: "Faltan las medidas del paquete de envío.",
    DISPATCH_PARCELS_MISSING: "Faltan escanear paquetes del pedido.",
    DISPATCH_PARCELS_LOCKED: "Los paquetes ya se escanearon en un Bulto general. Retiralo y reiniciá el armado para cambiarlos.",
    DISPATCH_QUANTITY_EXCEEDED: "Cantidad requerida ya completada.",
    DISPATCH_ALREADY_PREPARED: "El armado de este pedido ya está completo.",
    DISPATCH_PREPARATION_NOT_STARTED: "Iniciá el armado primero.",
    DISPATCH_PACKAGE_NOT_PREPARED: "Este pedido todavía no está armado.",
    DISPATCH_SCAN_KEY_CONFLICT: "Este escaneo ya fue utilizado con otro código.",
    DISPATCH_SCAN_INVALID: "Escaneo inválido.",
    DISPATCH_RANDOM_VARIANT_NO_STOCK: "No hay stock libre de esa variante: está reservada o vendida a otro pedido.",
    DISPATCH_VARIANT_CONFIRMATION_MISMATCH: "El código escaneado corresponde a otra variante.",
    DISPATCH_BATCH_CLOSED: "El Bulto general ya está cerrado.",
    DISPATCH_BATCH_EMPTY: "Seleccioná al menos un pedido completo.",
    DISPATCH_BATCH_NOT_CLOSED: "Cerrá el Bulto general antes de confirmar la entrega.",
    DISPATCH_ALREADY_HANDED_OVER: "El Bulto general ya fue entregado.",
    DISPATCH_RESET_REQUIRES_REMOVAL: "Retirá el pedido del Bulto general para reiniciar su armado.",
    DISPATCH_IDENTIFICATION_PENDING: "Falta imprimir la etiqueta Andreani del pedido.",
    DISPATCH_SHIPMENT_PENDING: "Primero generá el envío Andreani del pedido.",
    DISPATCH_ANDREANI_CODE_AMBIGUOUS: "Ese código Andreani corresponde a más de un pedido. Confirmá el pedido desde la lista.",
    DISPATCH_ADJUSTMENT_INVALID: "Revisá la diferencia: la cantidad nueva tiene que ser menor que la actual.",
    DISPATCH_ADJUSTMENT_AGREEMENT_REQUIRED: "Detallá el acuerdo con el cliente (mínimo 10 caracteres).",
    DISPATCH_ADJUSTMENT_BELOW_PICKED: "Ya pickeaste más unidades que esa cantidad. Reiniciá la preparación si sobran.",
    DISPATCH_ADJUSTMENT_EMPTY_ORDER: "El pedido no puede quedar sin unidades: eso es una cancelación.",
    DISPATCH_ADJUSTMENT_NOT_PICKING: "Las diferencias se resuelven durante el pickeo.",
    DISPATCH_IDENTIFICATION_IMMUTABLE: "La identificación física ya estaba registrada.",
    DISPATCH_PREP_STALE: "Código BX-PREP anterior. Usá el código vigente del pedido preparado.",
    DISPATCH_PREP_OTHER_BATCH: "Este pedido pertenece a otro Bulto general.",
    DISPATCH_VERIFY_PARCEL_CODE: "Esa es una etiqueta interna (BX-PKG). Escaneá la etiqueta Andreani del pedido.",
    DISPATCH_VERIFY_LABEL_REQUIRED: "Ese es el número de pedido. Escaneá la etiqueta Andreani o confirmalo desde la lista.",
    DISPATCH_VERIFY_NOT_EXPECTED: "Este pedido no está en este Bulto general.",
    DISPATCH_ORDERS_UNVERIFIED: "Faltan verificar pedidos del Bulto general.",
    DISPATCH_VERIFICATION_INVALID: "No se pudo registrar la verificación.",
    DISPATCH_REASON_REQUIRED: "Ingresá un motivo de al menos 10 caracteres.",
    DISPATCH_RESET_REASON_REQUIRED: "Ingresá un motivo de al menos 10 caracteres.",
    DISPATCH_ITEM_IDENTITY_MISSING: "Un artículo no tiene SKU ni código de barras. Revisá el catálogo.",
    DISPATCH_ORDER_EMPTY: "Este pedido no tiene artículos para armar.",
    DISPATCH_ORDER_NOT_FOUND: "No se encontró el pedido.",
    DISPATCH_BATCH_NOT_FOUND: "No se encontró el Bulto general.",
    DISPATCH_FORBIDDEN: "No tenés permisos para operar despachos.",
    DISPATCH_PHYSICAL_RESOLUTION_REQUIRED: "Primero escaneá el pedido cancelado en Despachos para confirmar el retiro físico.",
    DISPATCH_CANCELLATION_HOLD_ACTIVE: "El pedido está cancelado y armado: resolvé el retiro físico antes de rearmarlo.",
    DISPATCH_RESOLUTION_NOT_REQUIRED: "Este pedido no tiene una cancelación pendiente de retiro físico.",
    DISPATCH_RESOLUTION_WRONG_ORDER: "Ese código es de otro pedido.",
    DISPATCH_RESOLUTION_CODE_IS_PRODUCT: "Ese código es de un producto. Escaneá la etiqueta Andreani del pedido.",
    DISPATCH_RESOLUTION_LABEL_REQUIRED: "Este pedido ya estaba preparado: escaneá su etiqueta Andreani, no el número de pedido.",
    DISPATCH_HANDOVER_CODE_MISMATCH: "Ese código no corresponde a este Bulto general. Escaneá o ingresá su DSP.",
  }
  const code = Object.keys(messages).sort((left, right) => right.length - left.length).find((key) => error.message.includes(key))
  let message = code ? messages[code] : error.message.includes("dispatch_batch_items_active_order_unique") ? "Este pedido ya pertenece a otro Bulto general." : fallback
  if (code === "DISPATCH_PARCEL_OTHER_BATCH" && error.details && /^DSP-/.test(error.details)) message = `Este paquete pertenece al Bulto general ${error.details}.`
  else if (code === "DISPATCH_PREP_OTHER_BATCH" && error.details && /^DSP-/.test(error.details)) message = `Este pedido pertenece al Bulto general ${error.details}.`
  else if (code === "DISPATCH_RESOLUTION_WRONG_ORDER" && error.details && /^\d+$/.test(error.details)) message = `Ese código es de ${orderCode(Number(error.details))}, no de este pedido.`
  else if (error.details && /^\d+$/.test(error.details)) message = `${orderCode(Number(error.details))}: ${message}`
  return message
}

const PACKAGE_COLUMNS = "id,order_id,status,attempt_number,prepared_at,prepared_by,parcel_count,parcels_defined_at,parcels_request_key,identification_method,identified_at"
export const ORDER_COLUMNS = "id,estado,financial_status,payment_status,invoice_status,shipping_provider,envio_proveedor,cancelled_at,andreani_handed_over_at,andreani_handed_over_batch_id,created_at,andreani_created_at,cliente_nombre,andreani_envio_id,andreani_tracking,andreani_creation_status,total"
const ORDER_SHIPPING_COLUMNS = "shipping_estimate,shipping_provider_quote_amount,shipping_parcel_quote_status,shipping_parcel_quote_amount,shipping_parcel_quote_request_key"
const BATCH_COLUMNS = "id,code,display_number,status,created_at,closed_at,prepared_at,handed_over_at,handed_over_by,verification_round,verification_required"

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
  const [orderResult, packageResult, itemsResult, membershipResult, blocksResult, holdResult] = await Promise.all([
    admin.from("ordenes").select(`${ORDER_COLUMNS},${ORDER_SHIPPING_COLUMNS}`).eq("id", orderId).maybeSingle(),
    admin.from("order_packages").select(PACKAGE_COLUMNS).eq("order_id", orderId).maybeSingle(),
    admin.from("orden_items").select("id,producto_id,variante_id,reserved_variant_id,conditioned_name,cantidad,precio,random_fulfillment,productos(nombre,sku),producto_variantes(nombre,sku)").eq("orden_id", orderId).order("id"),
    admin.from("dispatch_batch_items").select("id,batch_id,order_id,package_id,added_at,removed_at").eq("order_id", orderId).is("removed_at", null).maybeSingle(),
    admin.from("dispatch_blocks").select("id,reason,source").eq("order_id", orderId).is("resolved_at", null),
    admin.from("order_cancellation_holds").select(HOLD_COLUMNS).eq("order_id", orderId).is("resolved_at", null).maybeSingle(),
  ])
  const failure = [orderResult, packageResult, itemsResult, membershipResult, blocksResult, holdResult].find((result) => result.error)
  if (failure?.error) throw failure.error
  if (!orderResult.data) return null
  const pkg = packageResult.data as DispatchPackage | null
  const membership = membershipResult.data as DispatchMembership | null
  const randomItemRows = (itemsResult.data ?? []).filter((item) => item.random_fulfillment === true)
  const [linesResult, parcels, batchResult, scansResult, adjustmentsResult] = await Promise.all([
    pkg ? admin.from("order_preparation_lines").select("order_item_id,expected_sku,expected_barcode,expected_quantity,scanned_quantity,product_id,variant_id,conditioned_stock_id").eq("package_id", pkg.id).order("order_item_id") : Promise.resolve(null),
    pkg ? currentParcels(admin, [pkg]) : Promise.resolve(new Map<number, DispatchParcel[]>()),
    membership ? admin.from("dispatch_batches").select(BATCH_COLUMNS).eq("id", membership.batch_id).maybeSingle() : Promise.resolve(null),
    pkg && randomItemRows.length ? admin.from("order_preparation_scans").select("order_item_id,physical_variant_id,variant_identification").eq("package_id", pkg.id).eq("attempt_number", pkg.attempt_number).order("id") : Promise.resolve(null),
    pkg ? admin.from("order_preparation_adjustments").select("id,order_item_id,problem,quantity_before,quantity_after,settlement,agreement,created_at,difference_amount").eq("package_id", pkg.id).eq("attempt_number", pkg.attempt_number).order("id") : Promise.resolve(null),
  ])
  if (adjustmentsResult?.error) throw adjustmentsResult.error
  if (linesResult?.error) throw linesResult.error
  if (batchResult?.error) throw batchResult.error
  if (scansResult?.error) throw scansResult.error
  const randomTrace = await randomTraces(admin, randomItemRows, (scansResult?.data ?? []) as RandomScanRow[])
  const names = new Map<number, string>()
  const ordered = new Map((itemsResult.data ?? []).map((item) => [item.id, { quantity: Number(item.cantidad), unitPrice: Number(item.precio ?? 0) }]))
  const saleItems: DispatchSaleItem[] = (itemsResult.data ?? []).map((item) => {
    const product = item.productos as unknown as { nombre?: string; sku?: string } | null
    const variant = item.producto_variantes as unknown as { nombre?: string; sku?: string } | null
    return { orderItemId: item.id, sku: variant?.sku ?? product?.sku ?? null,
      productName: item.conditioned_name || product?.nombre || "Producto",
      variantName: item.random_fulfillment === true ? "Color aleatorio" : variant?.nombre ?? null,
      orderedQuantity: Number(item.cantidad), unitPrice: options.includeCosts ? Number(item.precio ?? 0) : null }
  })
  for (const item of itemsResult.data ?? []) {
    const product = item.productos as unknown as { nombre?: string } | null
    const variant = item.producto_variantes as unknown as { nombre?: string } | null
    const variantLabel = item.random_fulfillment === true ? "Color aleatorio" : variant?.nombre
    names.set(item.id, [item.conditioned_name || product?.nombre || "Producto", variantLabel].filter(Boolean).join(" · "))
  }
  const lines = ((linesResult?.data ?? []) as DispatchLine[]).map((line) => {
    const random = randomTrace.get(line.order_item_id)
    const item = ordered.get(line.order_item_id)
    return { ...line, name: names.get(line.order_item_id) ?? "Producto", orderedQuantity: item?.quantity ?? line.expected_quantity,
      // Importes sólo para Admin: el operador no ve precios.
      unitPrice: options.includeCosts ? item?.unitPrice ?? null : null, ...(random ? { random } : {}) }
  })
  const adjustments: DispatchAdjustment[] = (adjustmentsResult?.data ?? []).map((row) => ({
    id: row.id, orderItemId: row.order_item_id, problem: row.problem as DispatchAdjustmentProblem,
    quantityBefore: row.quantity_before, quantityAfter: row.quantity_after,
    settlement: row.settlement as DispatchAdjustmentSettlement, agreement: row.agreement, createdAt: row.created_at,
    differenceAmount: options.includeCosts ? Number(row.difference_amount) : null,
  }))
  const batch = (batchResult?.data ?? null) as DispatchBatch | null
  const { shipping_estimate: estimate, shipping_provider_quote_amount: checkoutQuote, shipping_parcel_quote_status: quoteStatus, shipping_parcel_quote_amount: quoteAmount, shipping_parcel_quote_request_key: quoteKey, total, ...orderFields } = orderResult.data as unknown as DispatchOrder & DispatchOrderShippingRow
  const order: DispatchOrder = options.includeCosts ? { ...orderFields, total: total == null ? null : Number(total) } : orderFields
  const shipping = dispatchShippingInfo({ estimate, checkoutQuote, quoteStatus, quoteAmount, quoteKey, requestKey: (pkg as { parcels_request_key?: string | null } | null)?.parcels_request_key ?? null, includeCosts: Boolean(options.includeCosts) })
  const shipmentCreated = andreaniShipmentCreated(order)
  const stage = dispatchStage({ package: pkg, shipmentCreated, batchStatus: batch?.status ?? null, handedOver: Boolean(order.andreani_handed_over_at) })
  const shipment = { created: shipmentCreated, envioId: order.andreani_envio_id, tracking: order.andreani_tracking, creationStatus: order.andreani_creation_status }
  const cancelled = order.estado === "cancelado" || order.cancelled_at != null || ["cancellation_requested", "refund_pending", "refunded"].includes(order.financial_status ?? "")
  const holdRow = holdResult.data as HoldRow | null
  const hold = holdRow ? dispatchHold(holdRow, holdRow.batch_id && holdRow.batch_id === batch?.id ? batch.code : null) : null
  const blocks = blocksResult.data ?? []
  const packingBlock = blocks.find(blocksPacking)
  // Con diferencias registradas, lo que sale es lo esperado por renglón (no lo vendido).
  const expectedUnits = pkg ? lines.reduce((sum, line) => sum + line.expected_quantity, 0) : (itemsResult.data ?? []).reduce((sum, item) => sum + Number(item.cantidad), 0)
  return { order, package: pkg, lines, saleItems, parcels: pkg ? parcels.get(pkg.id) ?? [] : [], stage, itemCount: itemsResult.data?.length ?? 0, expectedUnits, membership, batch, shipping, hold, shipment, adjustments,
    blocked: cancelled || blocks.length > 0, blockReason: hold ? "Cancelado con pickeo iniciado — requiere resolución física" : cancelled ? "Pedido cancelado — no requiere preparación" : blocks[0] ? dispatchBlockReason((packingBlock ?? blocks[0]).reason) : null,
    // Lo que frena el pickeo. Factura y envío pendientes sólo se informan.
    packingBlocked: cancelled || Boolean(packingBlock),
    pendingBeforeDispatch: blocks.filter((block) => !blocksPacking(block)).map((block) => dispatchBlockReason(block.reason)) }
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

type BatchItemRow = DispatchMembership & { verified_at: string | null; verification_method: DispatchVerificationMethod | null; verification_round: number | null }

export async function getBatchDispatch(admin: DispatchAdmin, batchId: number) {
  const [batchResult, itemsResult] = await Promise.all([
    admin.from("dispatch_batches").select(BATCH_COLUMNS).eq("id", batchId).maybeSingle(),
    admin.from("dispatch_batch_items").select("id,batch_id,order_id,package_id,added_at,removed_at,verified_at,verification_method,verification_round").eq("batch_id", batchId).is("removed_at", null).order("order_id"),
  ])
  if (batchResult.error || itemsResult.error) throw batchResult.error ?? itemsResult.error
  if (!batchResult.data) return null
  const items = (itemsResult.data ?? []) as BatchItemRow[]
  const ids = items.map((item) => item.order_id)
  const [blocksResult, ordersResult, packagesResult, holdsResult] = ids.length ? await Promise.all([
    admin.from("dispatch_blocks").select("order_id,reason").in("order_id", ids).is("resolved_at", null),
    admin.from("ordenes").select("id,cancelled_at,andreani_handed_over_at,andreani_tracking,andreani_envio_id").in("id", ids),
    admin.from("order_packages").select("id,attempt_number,parcel_count").in("id", items.map((item) => item.package_id)),
    admin.from("order_cancellation_holds").select("order_id").in("order_id", ids).is("resolved_at", null),
  ]) : [{ data: [], error: null }, { data: [], error: null }, { data: [], error: null }, { data: [], error: null }]
  if (blocksResult.error || ordersResult.error || packagesResult.error || holdsResult.error) throw blocksResult.error ?? ordersResult.error ?? packagesResult.error ?? holdsResult.error
  const heldIds = new Set((holdsResult.data ?? []).map((hold) => hold.order_id))
  const packages = (packagesResult.data ?? []) as Pick<DispatchPackage, "id" | "attempt_number" | "parcel_count">[]
  const parcelsByPackage = await currentParcels(admin, packages)
  const packageById = new Map(packages.map((pkg) => [pkg.id, pkg]))
  const blockReasons = new Map((blocksResult.data ?? []).map((block) => [block.order_id, dispatchBlockReason(block.reason)]))
  const blockedIds = new Set(blockReasons.keys())
  for (const order of ordersResult.data ?? []) if (order.cancelled_at && !order.andreani_handed_over_at) blockedIds.add(order.id)
  const andreaniCodes = new Map((ordersResult.data ?? []).map((order) => [order.id, order.andreani_tracking?.trim() || order.andreani_envio_id?.trim() || null]))
  const batch = batchResult.data as DispatchBatch
  const operatorResult = batch.handed_over_by ? await admin.from("profiles").select("nombre,username,email").eq("id", batch.handed_over_by).maybeSingle() : null
  if (operatorResult?.error) throw operatorResult.error
  const operator = operatorResult?.data
  const round = batch.verification_round ?? 1
  const detailed: DispatchBatchItem[] = items.map(({ verified_at: verifiedAt, verification_method: method, verification_round: itemRound, ...item }) => {
    const pkg = packageById.get(item.package_id)
    const cancellationHold = heldIds.has(item.order_id)
    // Una verificación de una ronda anterior no cuenta: la composición cambió.
    const verified = Boolean(verifiedAt) && itemRound === round
    return { ...item, blocked: blockedIds.has(item.order_id) || cancellationHold, blockReason: cancellationHold ? "Pedido cancelado dentro del Bulto general" : blockReasons.get(item.order_id) ?? (blockedIds.has(item.order_id) ? "Revisión requerida" : null), cancellationHold,
      labelCode: andreaniCodes.get(item.order_id) ?? preparedOrderCode(item.order_id, pkg?.attempt_number ?? 1), verified, verifiedAt: verified ? verifiedAt : null, verificationMethod: verified ? method : null,
      parcelCount: pkg?.parcel_count ?? null, parcels: parcelsByPackage.get(item.package_id) ?? [] }
  })
  const verifiedCount = detailed.filter((item) => item.verified).length
  // false sólo en Bultos generales finalizados antes de la verificación por
  // pedido (20261016150000): sus pedidos sin escaneos no figuran como verificados ni faltantes.
  const verificationRequired = batch.verification_required ?? true
  const missingCount = verificationRequired ? detailed.length - verifiedCount : 0
  return { batch, items: detailed, blockedCount: blockedIds.size, cancelledCount: detailed.filter((item) => item.cancellationHold).length,
    expectedCount: detailed.length, verifiedCount, missingCount, verificationRequired,
    // Cerrado y con un pedido retirado: hay que volver a validar antes de entregar.
    requiresRevalidation: batch.status === "closed" && missingCount > 0,
    parcelCount: detailed.reduce((sum, item) => sum + (item.parcelCount ?? 0), 0), operatorName: operator?.nombre || operator?.username || operator?.email || null }
}
