import "server-only"

import type { createAdminClient } from "@/lib/supabase/admin"
import type { ArcaInvoiceGateway } from "@/lib/arca/invoice-automation"
import { emitCreditNote } from "@/lib/arca/credit-note-emission"
import { parseArcaEnvironment } from "@/lib/arca/environment"
import { allocateEffectiveOrderItemAmounts, roundCreditMoney } from "@/lib/orders/credit-note-calculations"
import { finalizeCreditNote } from "@/lib/orders/credit-note-finalization"
import { reconcileMercadoPagoOrderRefund, refundMercadoPagoOrderPayment } from "@/lib/mercadopago/order-refund"

type Admin = ReturnType<typeof createAdminClient>
type Order = {
  id: number; estado: string; financial_status: string | null; payment_method_id: string | null
  payment_confirmed_amount: number | null; credit_balance_used: number | null; total: number
  shipping_cost_charged: number | null; invoice_status: string | null; invoice_cae: string | null
  invoice_point: number | null; invoice_number: number | null; invoice_created_at: string | null
  invoice_arca_environment: string | null; invoice_queued_at: string | null; credit_note_required: boolean
  andreani_handed_over_at: string | null; andreani_envio_id: string | null; tracking_number: string | null
  andreani_tracking: string | null; auto_cancellation_attempts: number
}
type Note = {
  id: string; status: string; destination: string; cae: string | null; finalized_at: string | null
  external_amount: number | null; total_amount: number; voucher_number: number | null
  created_by: string | null; operation_type: string
}
type Result = { status: "completed" | "pending" | "manual"; reason?: string }

/** Efectos externos (ARCA, finalización, Mercado Pago). Los tests los reemplazan por simulaciones. */
export type AutomaticCancellationDependencies = {
  emitCreditNote: typeof emitCreditNote
  finalizeCreditNote: (admin: Admin, params: Parameters<typeof finalizeCreditNote>[1]) => Promise<unknown>
  refundMercadoPagoOrderPayment: typeof refundMercadoPagoOrderPayment
  reconcileMercadoPagoOrderRefund: typeof reconcileMercadoPagoOrderRefund
}

const defaultDependencies: AutomaticCancellationDependencies = {
  emitCreditNote, finalizeCreditNote, refundMercadoPagoOrderPayment, reconcileMercadoPagoOrderRefund,
}

const orderColumns = "id,estado,financial_status,payment_method_id,payment_confirmed_amount,credit_balance_used,total,shipping_cost_charged,invoice_status,invoice_cae,invoice_point,invoice_number,invoice_created_at,invoice_arca_environment,invoice_queued_at,credit_note_required,andreani_handed_over_at,andreani_envio_id,tracking_number,andreani_tracking,auto_cancellation_attempts"
const noteColumns = "id,status,destination,cae,finalized_at,external_amount,total_amount,voucher_number,created_by,operation_type"

function arcaDate(value: string | null) {
  const date = value?.slice(0, 10)
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("INVOICE_DATE_MISSING")
  return date.replaceAll("-", "")
}

async function loadOrder(admin: Admin, orderId: number) {
  const { data, error } = await admin.from("ordenes").select(orderColumns).eq("id", orderId).maybeSingle()
  if (error || !data) throw new Error(error?.message ?? "ORDER_NOT_FOUND")
  return data as Order
}

async function loadNotes(admin: Admin, orderId: number) {
  const { data, error } = await admin.from("order_credit_notes").select(noteColumns).eq("order_id", orderId).order("created_at")
  if (error) throw new Error(error.message)
  return (data ?? []) as Note[]
}

async function reserveCancellationNote(admin: Admin, order: Order, previousNotes: Note[]) {
  const [itemsResult, claimsResult] = await Promise.all([
    admin.from("orden_items").select("id,cantidad,precio,producto_id,variante_id,conditioned_name,productos(nombre),producto_variantes(nombre)").eq("orden_id", order.id).order("id"),
    admin.from("order_claims").select("id").eq("order_id", order.id).eq("failure_type", "cancelar_compra").in("status", ["aprobado", "reintegro_pendiente"]).order("id", { ascending: false }).limit(1),
  ])
  if (itemsResult.error || claimsResult.error) throw new Error(itemsResult.error?.message ?? claimsResult.error?.message)
  const items = itemsResult.data ?? []
  if (items.length === 0) throw new Error("AUTO_CREDIT_NOTE_WITHOUT_ITEMS")
  const allocations = allocateEffectiveOrderItemAmounts(order, items)
  if (allocations.length !== items.length) throw new Error("AUTO_CREDIT_NOTE_INVALID_ITEMS")
  const selectedItems = items.map((item, index) => {
    const allocation = allocations[index]
    const product = item.productos as unknown as { nombre?: string } | null
    const variant = item.producto_variantes as unknown as { nombre?: string } | null
    return {
      order_item_id: item.id, quantity: item.cantidad, unit_amount: allocation.effectiveUnitAmount,
      total_amount: allocation.effectiveLineAmount,
      product_name: product?.nombre ?? `Artículo #${item.producto_id}`,
      variant_name: item.conditioned_name || variant?.nombre || "",
    }
  })
  const itemsAmount = roundCreditMoney(selectedItems.reduce((sum, item) => sum + item.total_amount, 0))
  const manualAmount = roundCreditMoney(Number(order.total) - itemsAmount)
  if (manualAmount < 0 || roundCreditMoney(itemsAmount + manualAmount) !== roundCreditMoney(Number(order.total))) {
    throw new Error("AUTO_CREDIT_NOTE_AMOUNT_MISMATCH")
  }
  const { data, error } = await admin.rpc("begin_partial_credit_note", {
    p_order_id: order.id,
    p_claim_id: claimsResult.data?.[0]?.id ?? null,
    p_destination: "external_refund",
    p_reason: "Cancelación de pedido antes del despacho",
    p_items_amount: itemsAmount,
    p_manual_amount: manualAmount,
    p_total_amount: roundCreditMoney(Number(order.total)),
    p_invoice_point: order.invoice_point,
    p_invoice_number: order.invoice_number,
    p_created_by: null,
    p_items: selectedItems,
    p_operation_type: "cancelacion_antes_despacho",
    p_expected_note_ids: previousNotes.map((note) => note.id),
  }).maybeSingle()
  if (error || !data) throw new Error(error?.message ?? "AUTO_CREDIT_NOTE_RESERVATION_FAILED")
  const noteId = String((data as { id: string }).id)
  return noteId
}

async function setCancellationNoteMetadata(admin: Admin, order: Order, noteId: string) {
  const { error } = await admin.from("order_credit_notes").update({
    reason_code: "cancelacion_antes_despacho", resolution_type: "medio_pago", management_status: "reembolso_pendiente",
    reception_status: "no_requiere", stock_destination: "no_reingresar", settlement_status: "pendiente",
    original_shipping_paid: roundCreditMoney(Number(order.shipping_cost_charged ?? 0)),
    original_shipping_refunded: roundCreditMoney(Number(order.shipping_cost_charged ?? 0)),
  }).eq("id", noteId).eq("status", "processing")
  if (error) throw new Error(error.message)
}

export async function processAutomaticCancellation(
  admin: Admin, orderId: number, gateway: ArcaInvoiceGateway, pointOfSale: number,
  deps: AutomaticCancellationDependencies = defaultDependencies,
): Promise<Result> {
  const order = await loadOrder(admin, orderId)
  if (order.financial_status === "refunded") return { status: "completed" }
  if (order.estado !== "cancelado" || order.financial_status !== "refund_pending" || !order.invoice_queued_at ||
      order.andreani_handed_over_at || order.andreani_envio_id || order.tracking_number || order.andreani_tracking) {
    return { status: "manual", reason: "CANCELLED_ORDER_NOT_ELIGIBLE" }
  }
  if (order.invoice_status !== "authorized" || !order.invoice_cae || !order.invoice_point || !order.invoice_number) {
    return { status: "pending", reason: "INVOICE_PENDING" }
  }
  const environment = parseArcaEnvironment(order.invoice_arca_environment)
  if (environment !== gateway.environment) return { status: "manual", reason: "ARCA_ENVIRONMENT_MISMATCH" }

  const notes = await loadNotes(admin, orderId)
  if (notes.some((note) => note.destination !== "external_refund" || note.created_by !== null ||
      note.operation_type !== "cancelacion_antes_despacho" ||
      (note.status === "error" && note.voucher_number != null))) {
    return { status: "manual", reason: "CREDIT_NOTE_CONFLICT" }
  }
  const failedNotes = notes.filter((note) => note.status === "error")
  if (failedNotes.length >= 6) return { status: "manual", reason: "ARCA_CREDIT_NOTE_RETRIES_EXHAUSTED" }
  const activeNotes = notes.filter((note) => note.status !== "error")
  if (activeNotes.length > 1) return { status: "manual", reason: "CREDIT_NOTE_CONFLICT" }
  let note = activeNotes[0]
  if (!note) {
    if (!order.credit_note_required) return { status: "manual", reason: "CREDIT_NOTE_NOT_REQUIRED" }
    const noteId = await reserveCancellationNote(admin, order, notes)
    note = { id: noteId, status: "processing", destination: "external_refund", cae: null, finalized_at: null,
      external_amount: null, total_amount: Number(order.total), voucher_number: null,
      created_by: null, operation_type: "cancelacion_antes_despacho" }
  }
  if (note.status === "processing") {
    await setCancellationNoteMetadata(admin, order, note.id)
    const result = await deps.emitCreditNote(admin, {
      noteId: note.id, gateway, pointOfSale,
      associatedInvoice: { environment, pointOfSale: Number(order.invoice_point),
        voucherNumber: Number(order.invoice_number), voucherDate: arcaDate(order.invoice_created_at) },
    })
    if (result.status === "failed") return result.outcome === "manual_review"
      ? { status: "manual", reason: "ARCA_CREDIT_NOTE_MANUAL_REVIEW" }
      : { status: "pending", reason: result.outcome === "rejected" ? "ARCA_CREDIT_NOTE_RETRY" : "ARCA_CREDIT_NOTE_RECONCILIATION" }
    if (result.status !== "authorized") return { status: "pending", reason: "CREDIT_NOTE_PROCESSING" }
  }
  await deps.finalizeCreditNote(admin, { noteId: note.id, actorId: null })
  const refreshed = (await loadNotes(admin, orderId)).find((item) => item.id === note.id)
  if (!refreshed || refreshed.status !== "authorized" || !refreshed.finalized_at) {
    return { status: "pending", reason: "CREDIT_NOTE_FINALIZATION_PENDING" }
  }
  if (order.payment_method_id === "mercadopago") {
    const { data: refunds, error: refundError } = await admin.from("mercadopago_order_refunds")
      .select("status").eq("order_id", orderId).order("created_at", { ascending: false }).limit(1)
    if (refundError) throw new Error(refundError.message)
    if (["processing", "needs_reconciliation"].includes(refunds?.[0]?.status ?? "")) {
      const result = await deps.reconcileMercadoPagoOrderRefund(admin, { orderId })
      return result.kind === "confirmed" ? { status: "completed" } : { status: "pending", reason: "MP_RECONCILIATION" }
    }
    const result = await deps.refundMercadoPagoOrderPayment(admin, { orderId, adminId: null })
    if (["confirmed", "already_confirmed"].includes(result.kind)) return { status: "completed" }
    if (["in_progress", "unknown", "not_started"].includes(result.kind)) return { status: "pending", reason: "MP_RECONCILIATION" }
    if (result.kind === "rejected" && order.auto_cancellation_attempts < 6) {
      return { status: "pending", reason: "MP_REFUND_RETRY" }
    }
    return { status: "manual", reason: `MP_${result.kind.toUpperCase()}` }
  }
  if (Number(refreshed.external_amount ?? refreshed.total_amount) === 0) {
    const { error } = await admin.rpc("complete_zero_external_cancellation", { p_order_id: orderId })
    if (error) throw new Error(error.message)
    return { status: "completed" }
  }
  // No existe una API bancaria de salida. La NC y el saldo usado ya quedaron
  // procesados; el dinero de transferencia sigue pendiente hasta confirmar el pago real.
  return { status: "manual", reason: "BANK_TRANSFER_REFUND_REQUIRED" }
}

export const AUTO_CANCELLATION_MAX_ATTEMPTS = 12

export async function runAutomaticCancellationBatch(
  admin: Admin, gateway: ArcaInvoiceGateway, pointOfSale: number,
  { limit = 50, deadlineMs = 45_000, deps = defaultDependencies }:
    { limit?: number; deadlineMs?: number; deps?: AutomaticCancellationDependencies } = {},
) {
  const deadline = Date.now() + deadlineMs
  const summary = { checked: 0, completed: 0, pending: 0, manual: 0, errors: 0 }
  while (summary.checked < limit && Date.now() < deadline) {
    const { data, error } = await admin.rpc("claim_auto_cancellation", { p_lease: "5 minutes" })
    if (error) throw new Error(error.message)
    const claimed = (Array.isArray(data) ? data[0] : data) as Order | null
    if (!claimed) break
    summary.checked += 1
    let status: Result = { status: "pending", reason: "RETRY" }
    try {
      status = await processAutomaticCancellation(admin, claimed.id, gateway, pointOfSale, deps)
      summary[status.status] += 1
    } catch (cause) {
      summary.errors += 1
      status = { status: "pending", reason: cause instanceof Error ? cause.message : "UNEXPECTED_ERROR" }
      console.error("AUTO_CANCELLATION_FAILED", { orderId: claimed.id, reason: status.reason })
    }
    const attempts = Math.max(1, Number(claimed.auto_cancellation_attempts ?? 1))
    const retryMinutes = Math.min(60, 2 ** Math.min(attempts, 6))
    // Un fallo que se repite (~7 h de backoff) no queda "procesando" para
    // siempre: pasa a Admin ("Requiere acción") con el último motivo.
    const exhausted = status.status === "pending" && attempts >= AUTO_CANCELLATION_MAX_ATTEMPTS
    const { error: releaseError } = await admin.rpc("release_auto_cancellation", {
      p_order_id: claimed.id,
      p_delay: status.status === "pending" && !exhausted ? `${retryMinutes} minutes` : null,
      p_error: exhausted ? `RETRIES_EXHAUSTED: ${status.reason ?? "RETRY"}` : status.reason ?? null,
    })
    if (releaseError) throw new Error(releaseError.message)
  }
  return summary
}
