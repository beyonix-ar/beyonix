import { NextResponse } from "next/server"

import { requireAdmin } from "@/app/api/admin/clientes/_auth"
import {
  arcaConfigurationErrorResponse,
  requireArcaConfiguration,
  type ArcaConfiguration,
} from "@/lib/arca/configuration"
import { ArcaConfigurationError, parseArcaEnvironment } from "@/lib/arca/environment"
import { emitCreditNote } from "@/lib/arca/credit-note-emission"
import { createWsfeInvoiceGateway } from "@/lib/arca/wsfe-invoice-gateway"
import { allocateEffectiveOrderItemAmounts } from "@/lib/orders/credit-note-calculations"
import { creditNoteEmissionFailureResponse } from "@/lib/orders/credit-note-emission-response"
import { finalizeCreditNote } from "@/lib/orders/credit-note-finalization"
import {
  LEGACY_CREDIT_NOTE_REASON,
  LEGACY_CREDIT_NOTE_REJECTED_ACTION,
  buildLegacyCreditNoteAmounts,
  getLegacyCreditNoteState,
} from "@/lib/orders/legacy-credit-note"
import { appendOrderAuditEvent } from "@/lib/orders/order-audit"

export const runtime = "nodejs"

const RESERVATION_ERRORS: Record<string, string> = {
  CREDIT_NOTE_SNAPSHOT_CONFLICT: "La gestión fiscal cambió mientras confirmabas. Actualizá el pedido antes de volver a intentar.",
  CREDIT_NOTE_PROCESSING_IN_PROGRESS: "Ya hay una nota de crédito comunicándose con ARCA. Esperá un momento.",
  CREDIT_NOTE_EXCEEDS_INVOICE: "La factura ya tiene notas de crédito por su total.",
  CLAIM_REQUIRED: "No hay una cancelación de Admin ni un reclamo que respalde esta nota. Requiere revisión manual.",
  CREDIT_NOTE_ACTOR_FORBIDDEN: "No tenés permisos para emitir esta nota de crédito.",
  AUTHORIZED_INVOICE_REQUIRED: "La orden no tiene una Factura C autorizada para asociar.",
}

function arcaDate(value?: string | null) {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Argentina/Buenos_Aires",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date)
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? ""
  return `${part("year")}${part("month")}${part("day")}`
}

/**
 * NC de caso heredado: pedido facturado, ya reintegrado y con la NC
 * obligatoria pendiente. Reutiliza la reserva canónica (permisos, topes,
 * snapshot e idempotencia en la base), la emisión idempotente contra ARCA y
 * la finalización existente. Destino "none": sólo anula la factura; no
 * acredita saldo ni dispara otro reintegro porque el dinero ya volvió.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin(request)
  if ("error" in auth) return auth.error

  const { id } = await params
  const orderId = Number(id)
  if (!Number.isInteger(orderId) || orderId <= 0) {
    return NextResponse.json({ error: "Orden inválida." }, { status: 400 })
  }

  const [orderResult, itemsResult, notesResult] = await Promise.all([
    auth.admin
      .from("ordenes")
      .select("id, total, estado, financial_status, credit_note_required, refunded_at, shipping_cost_charged, invoice_status, invoice_cae, invoice_number, invoice_point, invoice_created_at, invoice_arca_environment")
      .eq("id", orderId)
      .maybeSingle(),
    auth.admin.from("orden_items").select("id, cantidad, precio").eq("orden_id", orderId),
    auth.admin.from("order_credit_notes").select("id, status, total_amount").eq("order_id", orderId),
  ])
  if (orderResult.error || itemsResult.error || notesResult.error) {
    console.error("LEGACY_CREDIT_NOTE_LOAD_ERROR", {
      orderId,
      message: orderResult.error?.message ?? itemsResult.error?.message ?? notesResult.error?.message,
    })
    return NextResponse.json({ error: "No se pudo consultar el pedido." }, { status: 500 })
  }
  const order = orderResult.data
  if (!order) return NextResponse.json({ error: "Orden no encontrada." }, { status: 404 })

  // Todo rechazo previo a la reserva queda auditado: así el panel muestra por
  // qué falta la NC y un intento fallido nunca desaparece sin rastro.
  const reject = async (code: string, message: string, status: number, response?: Response) => {
    await appendOrderAuditEvent(auth.admin, {
      orderId,
      actorType: "admin",
      actorId: auth.user.id,
      action: LEGACY_CREDIT_NOTE_REJECTED_ACTION,
      previousStatus: order.financial_status,
      newStatus: order.financial_status,
      metadata: { code, message },
    })
    return response ?? NextResponse.json({ error: message, code }, { status })
  }

  const notes = notesResult.data ?? []
  const state = getLegacyCreditNoteState({ ...order, order_credit_notes: notes })
  if (state === "processing") {
    return NextResponse.json({ error: "La nota de crédito ya se está emitiendo. Esperá a que termine." }, { status: 409 })
  }
  if (state === "manual_review") {
    return NextResponse.json(
      { error: "Las notas de crédito autorizadas no cubren el total facturado. Requiere revisión manual: no se emite otra nota automáticamente." },
      { status: 409 },
    )
  }
  if (state !== "pending") {
    return NextResponse.json({ error: "Este pedido no tiene una nota de crédito heredada pendiente." }, { status: 409 })
  }

  let configuration: ArcaConfiguration
  try {
    configuration = requireArcaConfiguration()
  } catch (error) {
    if (error instanceof ArcaConfigurationError) {
      return reject("ARCA_CONFIGURATION", "La configuración de ARCA está incompleta en este entorno.", 503, arcaConfigurationErrorResponse(error))
    }
    throw error
  }
  const invoiceEnvironment = parseArcaEnvironment(order.invoice_arca_environment)
  if (invoiceEnvironment !== configuration.environment) {
    return reject(
      "ARCA_ENVIRONMENT_MISMATCH",
      `La factura de este pedido pertenece a otro ambiente de ARCA (${order.invoice_arca_environment ?? "sin dato"}). No se puede emitir la nota de crédito desde este ambiente.`,
      409,
    )
  }

  const items = itemsResult.data ?? []
  const allocations = allocateEffectiveOrderItemAmounts(order, items)
  const amounts = buildLegacyCreditNoteAmounts(
    Number(order.total),
    allocations.map((allocation) => allocation.effectiveLineAmount),
  )
  if (!amounts) {
    return reject("AMOUNT_UNAVAILABLE", "No se pudo calcular el importe de la nota de crédito. Requiere revisión manual.", 409)
  }
  const creditItems = allocations.map((allocation) => ({
    order_item_id: allocation.orderItemId,
    quantity: allocation.soldQuantity,
    unit_amount: allocation.effectiveUnitAmount,
    total_amount: allocation.effectiveLineAmount,
  }))
  const expectedNoteIds = notes
    .filter((note) => note.status === "processing" || note.status === "authorized")
    .map((note) => note.id)

  const { data: reservedNote, error: reservationFailure } = await auth.admin
    .rpc("begin_partial_credit_note", {
      p_order_id: orderId,
      p_claim_id: null,
      p_destination: "none",
      p_reason: LEGACY_CREDIT_NOTE_REASON,
      p_items_amount: amounts.itemsAmount,
      p_manual_amount: amounts.manualAmount,
      p_total_amount: amounts.totalAmount,
      p_invoice_point: Number(order.invoice_point),
      p_invoice_number: Number(order.invoice_number),
      p_created_by: auth.user.id,
      p_items: creditItems,
      p_operation_type: "cancelacion_antes_despacho",
      p_expected_note_ids: expectedNoteIds,
    })
    .maybeSingle()
  if (reservationFailure || !reservedNote) {
    const message = reservationFailure?.message ?? ""
    console.error("LEGACY_CREDIT_NOTE_RESERVATION_ERROR", { orderId, message })
    const known = Object.entries(RESERVATION_ERRORS).find(([code]) => message.includes(code))
    return reject(
      known?.[0] ?? "RESERVATION_FAILED",
      known?.[1] ?? "No se pudo reservar la emisión de la nota de crédito.",
      409,
    )
  }

  const noteId = String((reservedNote as { id: string }).id)
  // El dinero ya se devolvió antes de la factura: la NC nace liquidada y sin
  // movimiento de stock (el pedido se canceló antes del despacho).
  const { error: managementError } = await auth.admin
    .from("order_credit_notes")
    .update({
      reason_code: "cancelacion_antes_despacho",
      reason_detail: LEGACY_CREDIT_NOTE_REASON,
      resolution_type: "medio_pago",
      management_status: "finalizada",
      reception_status: "no_requiere",
      stock_destination: "no_reingresar",
      settlement_status: "completado",
    })
    .eq("id", noteId)
    .eq("status", "processing")
  if (managementError) {
    await auth.admin
      .from("order_credit_notes")
      .update({ status: "error", error: "No se pudo guardar la gestión antes de contactar a ARCA." })
      .eq("id", noteId)
    return NextResponse.json({ error: "No se pudo preparar la nota. ARCA no fue contactada." }, { status: 500 })
  }

  await appendOrderAuditEvent(auth.admin, {
    orderId,
    actorType: "admin",
    actorId: auth.user.id,
    action: "legacy_credit_note_requested",
    previousStatus: order.financial_status,
    newStatus: order.financial_status,
    metadata: { orderCreditNoteId: noteId, amount: amounts.totalAmount, reason: "refund_before_invoice" },
  })

  const emission = await emitCreditNote(auth.admin, {
    noteId,
    gateway: createWsfeInvoiceGateway(configuration),
    pointOfSale: configuration.pointOfSale,
    associatedInvoice: {
      environment: invoiceEnvironment,
      pointOfSale: Number(order.invoice_point),
      voucherNumber: Number(order.invoice_number),
      voucherDate: arcaDate(order.invoice_created_at),
    },
  })
  if (emission.status !== "authorized") {
    return creditNoteEmissionFailureResponse(emission, orderId, noteId)
  }

  try {
    const finalized = await finalizeCreditNote(auth.admin, { noteId, actorId: auth.user.id })
    return NextResponse.json({
      order: { ...finalized.order, order_credit_notes: finalized.authorizedNotes },
      note: finalized.note,
    })
  } catch (error) {
    console.error("LEGACY_CREDIT_NOTE_FINALIZATION_ERROR", {
      orderId,
      noteId,
      message: error instanceof Error ? error.message : "UNEXPECTED_ERROR",
    })
    return NextResponse.json(
      {
        error: "ARCA autorizó la nota de crédito, pero falló una acción posterior. El comprobante es válido: usá “Conciliar con ARCA” para completar la gestión sin emitir otra nota.",
        note_authorized: true,
        note_id: noteId,
      },
      { status: 500 },
    )
  }
}
