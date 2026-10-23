import "server-only"

import type { createAdminClient } from "@/lib/supabase/admin"
import { createCustomerCreditMovement } from "@/lib/customer-credit/server"
import { finalizeCreditNote } from "@/lib/orders/credit-note-finalization"
import { appendOrderAuditEvent } from "@/lib/orders/order-audit"
import { getMercadoPagoPayment } from "@/lib/mercadopago/customer-credit-topups"
import { reconcileMercadoPagoOrderRefund, refundMercadoPagoOrderPayment, validateRefundablePayment } from "@/lib/mercadopago/order-refund"
import { requireArcaConfiguration } from "@/lib/arca/configuration"
import { processArcaInvoice, type ArcaInvoiceResult } from "@/lib/arca/invoice-automation"
import { createWsfeInvoiceGateway } from "@/lib/arca/wsfe-invoice-gateway"
import { isOrderDispatchCutoffReached } from "./dispatch-cutoff"
import { ensureSaleInvoiced, hasPendingInvoiceObligation } from "./fiscal-sequencing"
import {
  deriveFinancialReturnContext, financialHumanStatus, getEffectiveFinancialResolutionStatus, getFinancialResolutionMode, resolveOrderFinancialOptions,
  type FinancialChoice, type FinancialResolutionFacts,
} from "./financial-resolution"

type Admin = ReturnType<typeof createAdminClient>
type Resolution = { id: string; order_id: number; choice: FinancialChoice; amount: number; status: string; lease_key: string | null; lease_until: string | null; updated_at: string | null; note_id: string | null; last_error: string | null }
type Order = { id: number; usuario_id: string | null; financial_status: string | null; payment_method_id: string | null; payment_status: string | null; paid_at: string | null; payment_id: string | null; payment_confirmed_amount: number | null; external_amount_due: number | null; invoice_status: string | null; invoice_cae: string | null; credit_note_required: boolean | null; andreani_handed_over_at: string | null; tracking_number: string | null; andreani_tracking: string | null; andreani_envio_id: string | null; andreani_estado: string | null; estado: string | null; mercadopago_reference: string | null; mercadopago_reference_assigned_at: string | null; credit_balance_used: number | null; original_total: number | null; total: number | null; shipping_cost_charged: number | null; invoice_queued_at: string | null }

const orderColumns = "id,usuario_id,financial_status,payment_method_id,payment_status,paid_at,payment_id,payment_confirmed_amount,external_amount_due,invoice_status,invoice_cae,invoice_queued_at,credit_note_required,andreani_handed_over_at,tracking_number,andreani_tracking,andreani_envio_id,andreani_estado,estado,mercadopago_reference,mercadopago_reference_assigned_at,credit_balance_used,original_total,total,shipping_cost_charged"
const fail = (message: string): never => { throw new Error(message) }

async function one<T>(promise: PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await promise
  if (error) throw new Error(error.message)
  return (Array.isArray(data) ? data[0] : data) as T
}

export async function loadFinancialResolution(admin: Admin, orderId: number, verifyRemote = true) {
  const [orderResult, membershipResult, holdResult, claimsResult, notesResult, refundsResult, proofResult, resolutionResult, claimGateResult, adminCancellationResult, packageResult] = await Promise.all([
    admin.from("ordenes").select(orderColumns).eq("id", orderId).maybeSingle(),
    admin.from("dispatch_batch_items").select("removed_at,dispatch_batches(prepared_at)").eq("order_id", orderId),
    // Cancelación con pickeo (retención física, activa o resuelta): mismo corte
    // que un lote cerrado (order_was_prepared_for_dispatch), reintegro manual.
    admin.from("order_cancellation_holds").select("detected_at,resolved_at").eq("order_id", orderId).order("detected_at"),
    admin.from("order_claims").select("id,status,failure_type,resolution").eq("order_id", orderId),
    admin.from("order_credit_notes").select("id,status,destination,total_amount,external_amount,cae,finalized_at,settlement_status").eq("order_id", orderId),
    admin.from("mercadopago_order_refunds").select("status,mp_refund_id,created_at").eq("order_id", orderId).order("created_at"),
    admin.from("order_refund_proofs").select("id").eq("order_id", orderId).limit(1),
    admin.from("order_financial_resolutions").select("*").eq("order_id", orderId).maybeSingle(),
    admin.rpc("order_financial_claim_block", { p_order_id: orderId }),
    // Cancelación directa de Admin (sin reclamo): autoriza la NC de cancelación.
    admin.rpc("order_has_admin_direct_cancellation", { p_order_id: orderId }),
    // Armado en Despachos: con él, el envío Andreani creado no es "despachado" (corte = QR final del Bulto).
    admin.from("order_packages").select("id").eq("order_id", orderId).maybeSingle(),
  ])
  for (const result of [orderResult, membershipResult, holdResult, claimsResult, notesResult, refundsResult, proofResult, resolutionResult, claimGateResult, adminCancellationResult, packageResult]) {
    if (result.error) throw new Error(result.error.message)
  }
  const order = orderResult.data as Order | null
  if (!order) return null
  const memberships = (membershipResult.data ?? []) as unknown as Array<{ removed_at: string | null; dispatch_batches: { prepared_at: string | null } | null }>
  const claims = (claimsResult.data ?? []) as Array<{ id: number; status: string; failure_type: string; resolution: string | null }>
  const notes = (notesResult.data ?? []) as Array<{ id: string; status: string; destination: string; total_amount: number; external_amount: number | null; cae: string | null; finalized_at: string | null; settlement_status: string | null }>
  const refunds = (refundsResult.data ?? []) as Array<{ status: string; mp_refund_id: string | null }>
  const resolution = resolutionResult.data as Resolution | null
  const paidAmount = Number(order.payment_confirmed_amount || order.external_amount_due || 0)
  const externalNotes = notes.filter((note) => note.status === "authorized" && note.cae &&
    note.destination === "external_refund" && note.settlement_status !== "completado")
  // Dinero externo de las NC (no su total fiscal: en un pago combinado la NC
  // también cubre la parte pagada con saldo, que vuelve por otro camino).
  const noteMoney = (note: { total_amount: number; external_amount: number | null }) => Number(note.external_amount ?? note.total_amount)
  const externalNoteAmount = externalNotes.reduce((sum, note) => sum + noteMoney(note), 0)
  const amount = externalNoteAmount > 0 ? externalNoteAmount : paidAmount
  const fiscalDestinations = new Set(notes.filter((note) => ["processing", "authorized"].includes(note.status) &&
    note.destination !== "none").map((note) => note.destination))
  const fiscalDestination = fiscalDestinations.size === 1
    ? [...fiscalDestinations][0] as "external_refund" | "customer_balance" : null
  const holds = (holdResult.data ?? []) as Array<{ detected_at: string; resolved_at: string | null }>
  const pickedCancellationAt = holds[0]?.detected_at ?? null
  const physicalHoldActive = holds.some((hold) => !hold.resolved_at)
  // Mercadería recuperada por escaneo y fuera de todo Bulto (misma regla que la RPC de reserva).
  const pickedCancellationResolved = holds.length > 0 && !physicalHoldActive && !memberships.some((item) => !item.removed_at)
  const preparedAt = memberships.map((item) => item.dispatch_batches?.prepared_at).find(Boolean) ?? pickedCancellationAt
  const adminDirectCancellation = adminCancellationResult.data === true
  const canCreateCancellationNote = adminDirectCancellation || claims.some((claim) => claim.failure_type === "cancelar_compra" &&
    ["aprobado", "reintegro_pendiente"].includes(claim.status))
  const fiscalConflict = externalNoteAmount > paidAmount || fiscalDestinations.size > 1 ||
    notes.some((note) => note.status === "error" || (note.status === "processing" && !resolution)) ||
    (!!order.credit_note_required && !canCreateCancellationNote && !notes.some((note) => note.status === "authorized" && note.cae))
  const trackingInCircuit = ["enviado", "en_camino", "visita_fallida", "en_sucursal", "retiro_pendiente", "retiro_vencido", "en_devolucion", "devuelto_beyonix", "entregado"].includes(order.estado ?? "")
  // "Ya salió de BEYONIX" (QR final del Bulto); un envío creado y retirado del Bulto no cuenta.
  const shipmentCreated = isOrderDispatchCutoffReached(order, Boolean(packageResult.data))
  const openClaimIds = claims.filter((claim) => !["cerrado", "rechazado"].includes(claim.status)).map((claim) => claim.id)
  const [unitsResult, exceptionsResult] = openClaimIds.length
    ? await Promise.all([
        admin.from("order_claim_units").select("claim_id,role,location").in("claim_id", openClaimIds),
        admin.from("order_claim_financial_exceptions").select("claim_id").in("claim_id", openClaimIds),
      ])
    : [{ data: [], error: null }, { data: [], error: null }]
  if (unitsResult.error) throw new Error(unitsResult.error.message)
  if (exceptionsResult.error) throw new Error(exceptionsResult.error.message)
  const claimBlock = typeof claimGateResult.data === "string" ? claimGateResult.data : null
  const returnContext = deriveFinancialReturnContext({
    handedOverAt: order.andreani_handed_over_at, claimBlock,
    units: ((unitsResult.data ?? []) as Array<{ claim_id: number; role: string; location: string }>)
      .map((unit) => ({ claimId: unit.claim_id, role: unit.role, location: unit.location })),
    exceptionClaimIds: ((exceptionsResult.data ?? []) as Array<{ claim_id: number }>).map((row) => row.claim_id),
  })
  // Misma regla que assert_order_claim_money_released: la excepción registrada libera el bloqueo.
  const returnPending = claimBlock === "CLAIM_MONEY_RETURN_PENDING" && returnContext.reception !== "exception"
  const partial = Math.round(amount * 100) !== Math.round(paidAmount * 100) ||
    Number(order.credit_balance_used ?? 0) > 0 && Number(order.payment_confirmed_amount ?? 0) !== Number(order.total ?? 0)
  // Con pickeo o tanda cerrada, MP sólo por acción del Admin y con la mercadería
  // ya recuperada. El mismo clic emite antes la NC C (ensureCreditNote) y la
  // base exige la NC antes del refund. En un pago combinado se devuelve sólo
  // lo capturado por MP; el saldo vuelve con la NC.
  const mpRefundCandidate = preparedAt ? !physicalHoldActive : !partial
  let remotePaymentVerified = false
  let installments = false
  // Sin opción ofrecible (resolución elegida o pedido fuera de refund_pending) no se consulta MP.
  if (verifyRemote && !resolution && order.financial_status === "refund_pending" && mpRefundCandidate && !shipmentCreated && order.payment_method_id === "mercadopago" && order.payment_id && amount > 0 && !order.andreani_handed_over_at) {
    try {
      const payment = await getMercadoPagoPayment(order.payment_id)
      remotePaymentVerified = validateRefundablePayment(payment, { order, expectedPaymentId: order.payment_id, expectedAmount: amount }) === null
      installments = Number(payment.installments ?? 1) > 1
    } catch { /* Sin verificación remota no se ofrece MP. */ }
  }
  const facts: FinancialResolutionFacts = {
    paymentMethod: order.payment_method_id, paymentApproved: amount > 0 && !!order.paid_at && ["approved", "confirmed", "confirmado"].includes(order.payment_status ?? "") && order.financial_status === "refund_pending",
    paymentIdValid: !!order.payment_id && /^\d+$/.test(order.payment_id), amount, mpAmount: Number(order.payment_confirmed_amount ?? 0),
    financialStatus: order.financial_status, preparedAt, handedOverAt: order.andreani_handed_over_at,
    trackingInCircuit, shipmentCreated, priorRefund: (proofResult.data ?? []).length > 0 || refunds.some((refund) => refund.status === "confirmed"),
    refundInProgress: refunds.some((refund) => ["processing", "needs_reconciliation"].includes(refund.status)),
    fiscalConflict, receptionPending: returnPending, inspectionPending: returnPending,
    claimIncidentOpen: claimBlock === "CLAIM_MONEY_INCIDENT_OPEN" || claims.some((claim) => ["recibido", "en_revision", "falta_informacion"].includes(claim.status)),
    remotePaymentVerified, partial, installments, hasCustomerAccount: !!order.usuario_id, fiscalDestination,
    physicalHoldActive, pickedCancellationResolved,
  }
  const options = resolution ? [] : resolveOrderFinancialOptions(facts)
  // Opciones que quedarían disponibles al recibir el producto (o con una excepción auditada).
  const receptionOptions = resolution || !returnPending ? []
    : resolveOrderFinancialOptions({ ...facts, receptionPending: false, inspectionPending: false })
  const mpRefundId = [...refunds].reverse().find((refund) => refund.status === "confirmed")?.mp_refund_id ?? null
  return { order, claims, notes, refunds, resolution, amount, preparedAt, physicalHoldActive, pickedCancellationResolved, mpRefundId, options, receptionOptions, returnContext, adminDirectCancellation,
    mode: getFinancialResolutionMode({ financialStatus: order.financial_status, hasResolution: !!resolution, options, receptionOptions }),
    status: financialHumanStatus(resolution ? getEffectiveFinancialResolutionStatus(resolution) : null), requiresReturn: !!order.andreani_handed_over_at }
}

async function updateResolution(admin: Admin, resolution: Resolution, status: "requires_action" | "manual_pending" | "completed", actorId: string, error: string | null = null) {
  const values: Record<string, unknown> = { status, last_error: error?.slice(0, 300) ?? null, updated_at: new Date().toISOString(), lease_until: null, lease_key: null }
  if (status === "completed") { values.completed_at = new Date().toISOString(); values.completed_by = actorId }
  const { data, error: updateError } = await admin.from("order_financial_resolutions").update(values)
    .eq("id", resolution.id).eq("lease_key", resolution.lease_key).select("*").maybeSingle()
  if (updateError) throw new Error(updateError.message)
  if (!data) throw new Error("La resolución fue tomada por otra solicitud.")
  await appendOrderAuditEvent(admin, { orderId: resolution.order_id, actorType: "admin", actorId,
    action: "financial_resolution_status", previousStatus: resolution.status, newStatus: status,
    metadata: { resolutionId: resolution.id, choice: resolution.choice, amount: resolution.amount, error: error?.slice(0, 300) ?? null } })
  return data as Resolution
}

/** Venta con Factura C autorizada: el dinero vuelve sólo con NC, haya o no flag. */
const isInvoicedSale = (order: Order) => Boolean(order.invoice_cae) || order.invoice_status === "authorized"

async function ensureCreditNote(admin: Admin, context: NonNullable<Awaited<ReturnType<typeof loadFinancialResolution>>>, resolution: Resolution, actorId: string, authorization: string) {
  const creditNoteRequired = Boolean(context.order.credit_note_required) || isInvoicedSale(context.order)
  if (!creditNoteRequired && context.notes.length === 0) return
  const destination = resolution.choice === "beyonix_credit" ? "customer_balance" : "external_refund"
  const relevant = context.notes.filter((note) => note.destination === destination)
  const authorized = relevant.filter((note) => note.status === "authorized" && note.cae && note.settlement_status !== "completado")
  if (context.notes.some((note) => note.destination !== destination && note.destination !== "none")) fail("Existe otra resolución fiscal para este pedido. Requiere revisión.")
  if (authorized.length) {
    // resolution.amount es dinero externo: se compara con la parte externa de la NC.
    const authorizedAmount = authorized.reduce((sum, note) => sum + Number(note.external_amount ?? note.total_amount), 0)
    if (Math.round(authorizedAmount * 100) < Math.round(resolution.amount * 100)) fail("La nota de crédito no cubre el importe de la resolución.")
    for (const note of authorized) await finalizeCreditNote(admin, { noteId: note.id, actorId })
    return
  }
  const processing = relevant.find((note) => note.status === "processing")
  if (processing) {
    const { POST } = await import("@/app/api/admin/credit-notes/[noteId]/reconcile/route")
    const response = await POST(new Request("http://localhost/api/admin/credit-notes/reconcile", { method: "POST", headers: { authorization } }), { params: Promise.resolve({ noteId: processing.id }) })
    if (!response.ok) fail("La actualización fiscal está pendiente. Reintentá más tarde.")
    const refreshed = await one<{ status: string }>(admin.from("order_credit_notes").select("status").eq("id", processing.id).single())
    if (refreshed.status !== "authorized") fail("La actualización fiscal está pendiente. Reintentá más tarde.")
    return
  }
  if (relevant.some((note) => note.status === "error")) {
    fail("La nota de crédito anterior requiere revisión fiscal. No se emitió otra.")
  }
  if (!creditNoteRequired) return
  const claim = context.claims.find((item) => item.failure_type === "cancelar_compra" && ["aprobado", "reintegro_pendiente"].includes(item.status))
  // Cancelación directa de Admin: no hay reclamo; la auditoría la autoriza (también en la base).
  if (!claim && !context.adminDirectCancellation) throw new Error("La nota de crédito requiere una cancelación aprobada. Revisá el reclamo.")
  const { data: items, error } = await admin.from("orden_items").select("id,cantidad").eq("orden_id", context.order.id)
  if (error || !items?.length) throw new Error("No se pudieron verificar los artículos de la cancelación.")
  const { POST } = await import("@/app/api/admin/orders/[id]/credit-note/route")
  const response = await POST(new Request("http://localhost/api/admin/orders/credit-note", { method: "POST", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify({
    items: items.map((item) => ({ order_item_id: item.id, quantity: item.cantidad })),
    operation_type: "cancelacion_antes_despacho", destination, reason_code: "cancelacion_antes_despacho",
    reason: "Cancelación aprobada", claim_id: claim?.id ?? null, reception_status: "no_requiere", stock_destination: "no_reingresar",
    include_original_shipping: Number(context.order.shipping_cost_charged ?? 0) > 0, other_adjustment_amount: 0, return_shipping_cost: 0, new_shipping_cost: 0,
    expected_note_ids: context.notes.map((note) => note.id),
  }) }), { params: Promise.resolve({ id: String(context.order.id) }) })
  if (!response.ok) fail("La actualización fiscal está pendiente. Reintentá más tarde.")
}

/** Factura C por el servicio único de ARCA (mismo camino que el botón manual de Admin). */
async function issueSaleInvoice(admin: Admin, orderId: number): Promise<ArcaInvoiceResult> {
  const configuration = requireArcaConfiguration()
  return processArcaInvoice(admin, {
    gateway: createWsfeInvoiceGateway(configuration),
    pointOfSale: configuration.pointOfSale,
    orderId,
    manual: true,
  })
}

export async function executeFinancialResolution(
  admin: Admin, orderId: number, actorId: string, authorization: string, choice: FinancialChoice | null, retry = false,
  { issueInvoice = (id: number) => issueSaleInvoice(admin, id) }: { issueInvoice?: (orderId: number) => Promise<ArcaInvoiceResult> } = {},
) {
  const context = await loadFinancialResolution(admin, orderId)
  if (!context) throw new Error("Pedido no encontrado.")
  const selected = context.resolution
  if (!retry && (!choice || (!selected && !context.options.some((option) => option.type === choice)))) fail("La opción ya no está disponible. Actualizá el pedido.")
  if (retry && !selected) fail("No hay una actualización pendiente.")
  if (selected && choice && selected.choice !== choice) fail("Ya existe una resolución distinta para el pedido.")
  const resolution = selected ?? await one<Resolution>(admin.rpc("reserve_order_financial_resolution", { p_order_id: orderId, p_actor_id: actorId, p_choice: choice }))
  if (["completed", "manual_pending"].includes(resolution.status)) return resolution
  const leaseKey = crypto.randomUUID()
  const claimed = await one<Resolution>(admin.rpc("claim_order_financial_resolution", { p_resolution_id: resolution.id, p_actor_id: actorId, p_lease_key: leaseKey }))
  if (claimed.lease_key !== leaseKey) return claimed
  try {
    // Relee el estado fiscal dentro de la intención reservada: nunca emite una segunda NC.
    let fresh = await loadFinancialResolution(admin, orderId, false)
    if (!fresh || fresh.order.andreani_handed_over_at) throw new Error("El pedido requiere devolución y recepción antes de resolverlo.")
    if (fresh.physicalHoldActive) fail("Primero resolvé físicamente el pedido en Despachos.")
    // Con pickeo o tanda cerrada: saldo BEYONIX sólo con la mercadería ya recuperada.
    if (fresh.preparedAt && claimed.choice === "beyonix_credit" && !fresh.pickedCancellationResolved) fail("El pedido sigue en preparación física. Resolvé la mercadería en Despachos antes de acreditar saldo.")
    // Factura C antes que la NC y que mover dinero: una venta cobrada nunca
    // termina reintegrada sin comprobante (obligación nacida con el pago).
    if (hasPendingInvoiceObligation(fresh.order)) {
      const invoiced = await ensureSaleInvoiced(() => issueInvoice(orderId))
      if (!invoiced.ok) fail(invoiced.error)
      // Con la factura emitida sobre la venta cancelada, la base exige NC.
      fresh = await loadFinancialResolution(admin, orderId, false)
      if (!fresh) throw new Error("Pedido no encontrado.")
    }
    await ensureCreditNote(admin, fresh, claimed, actorId, authorization)
    if (claimed.choice === "manual_refund") return updateResolution(admin, claimed, "manual_pending", actorId)
    if (claimed.choice === "mercadopago_refund") {
      const current = await loadFinancialResolution(admin, orderId, false)
      if (!current) throw new Error("Pedido no encontrado.")
      const uncertain = current.refunds.some((refund) => ["processing", "needs_reconciliation"].includes(refund.status))
      if (uncertain) {
        const reconciled = await reconcileMercadoPagoOrderRefund(admin, { orderId })
        if (reconciled.kind !== "confirmed") fail("Mercado Pago aún no confirmó el reintegro. Reintentá la actualización.")
      } else {
        const result = await refundMercadoPagoOrderPayment(admin, { orderId, adminId: actorId })
        if (result.kind !== "confirmed" && result.kind !== "already_confirmed") fail("Mercado Pago no confirmó el reintegro. Reintentá la actualización.")
      }
      return updateResolution(admin, claimed, "completed", actorId)
    }
    const afterNote = await loadFinancialResolution(admin, orderId, false)
    if (!afterNote?.order.usuario_id) throw new Error("El pedido no tiene cuenta de cliente.")
    if (afterNote.notes.some((note) => note.destination === "customer_balance" && note.status === "authorized")) {
      return updateResolution(admin, claimed, "completed", actorId)
    }
    // Acreditación directa sólo para ventas sin factura: con Factura C el
    // saldo vuelve únicamente por la NC (customer_balance) de arriba.
    if (isInvoicedSale(afterNote.order)) fail("La venta está facturada: el saldo vuelve sólo con la nota de crédito. Reintentá la actualización.")
    await createCustomerCreditMovement(admin, { userId: afterNote.order.usuario_id, movementType: "credit", amount: claimed.amount,
      description: `Saldo por resolución del pedido BX-${1000 + orderId}`, sourceType: "admin_adjustment", sourceId: claimed.id,
      orderId, createdBy: actorId, sourceKey: `financial-resolution:${claimed.id}`, metadata: { financial_resolution_id: claimed.id } })
    const { data: updatedOrder, error: orderError } = await admin.from("ordenes").update({ financial_status: "refunded", refund_amount: claimed.amount, refund_method: "Saldo BEYONIX", refunded_at: new Date().toISOString(), refunded_by: actorId }).eq("id", orderId).eq("financial_status", "refund_pending").select("id").maybeSingle()
    if (orderError || !updatedOrder) throw new Error(orderError?.message ?? "El pedido cambió durante la acreditación.")
    const { error: notificationError } = await admin.from("customer_notifications").upsert({
      user_id: afterNote.order.usuario_id, type: "order_refunded", title: "Saldo acreditado",
      body: "El saldo de tu pedido ya está disponible en tu cuenta.", action_url: "/cuenta/saldo",
      order_id: orderId, source_key: `financial-resolution:${claimed.id}:credited`,
    }, { onConflict: "source_key", ignoreDuplicates: true })
    if (notificationError) throw new Error(notificationError.message)
    return updateResolution(admin, claimed, "completed", actorId)
  } catch (error) {
    const message = error instanceof Error ? error.message : "No se pudo completar la resolución."
    await updateResolution(admin, claimed, "requires_action", actorId, message)
    return { ...claimed, status: "requires_action", last_error: message }
  }
}
