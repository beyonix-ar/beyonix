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
  buildLegacyCreditNoteAmounts,
  buildLegacyCreditNoteItems,
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
    auth.admin.from("orden_items").select("id, producto_id, variante_id, conditioned_name, cantidad, precio").eq("orden_id", orderId),
    auth.admin.from("order_credit_notes").select("id, status").eq("order_id", orderId),
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

  const notes = notesResult.data ?? []
  const state = getLegacyCreditNoteState({ ...order, order_credit_notes: notes })
  if (state === "processing") {
    return NextResponse.json({ error: "La nota de crédito ya se está emitiendo. Esperá a que termine." }, { status: 409 })
  }
  if (state !== "pending") {
    return NextResponse.json({ error: "Este pedido no tiene una nota de crédito heredada pendiente." }, { status: 409 })
  }

  let configuration: ArcaConfiguration
  try {
    configuration = requireArcaConfiguration()
  } catch (error) {
    if (error instanceof ArcaConfigurationError) return arcaConfigurationErrorResponse(error)
    throw error
  }
  const invoiceEnvironment = parseArcaEnvironment(order.invoice_arca_environment)
  if (invoiceEnvironment !== configuration.environment) {
    return NextResponse.json(
      { error: "La factura de este pedido pertenece a otro ambiente de ARCA. No se puede emitir la nota de crédito desde este ambiente." },
      { status: 409 },
    )
  }

  const items = itemsResult.data ?? []
  const allocations = allocateEffectiveOrderItemAmounts(order, items)
  const productIds = [...new Set(items.map((item) => Number(item.producto_id)).filter((id) => Number.isSafeInteger(id) && id > 0))]
  const variantIds = [...new Set(items.map((item) => Number(item.variante_id)).filter((id) => Number.isSafeInteger(id) && id > 0))]
  const [snapshotsResult, productsResult, variantsResult] = await Promise.all([
    auth.admin.from("arca_invoice_item_snapshots").select("order_item_id, product_name, variant_name").eq("order_id", orderId),
    productIds.length
      ? auth.admin.from("productos").select("id, nombre").in("id", productIds)
      : Promise.resolve({ data: [], error: null }),
    variantIds.length
      ? auth.admin.from("producto_variantes").select("id, nombre").in("id", variantIds)
      : Promise.resolve({ data: [], error: null }),
  ])
  if (snapshotsResult.error || productsResult.error || variantsResult.error) {
    const detail = snapshotsResult.error?.message ?? productsResult.error?.message ?? variantsResult.error?.message ?? null
    await auditLegacyFailure(auth.admin, orderId, auth.user.id, order.financial_status, "reservation", "ITEM_SOURCE_UNAVAILABLE", detail, null)
    return NextResponse.json({ error: "No se pudo verificar el detalle histórico del pedido." }, { status: 500 })
  }
  const creditItemsResult = buildLegacyCreditNoteItems(
    items,
    allocations,
    snapshotsResult.data ?? [],
    new Map((productsResult.data ?? []).map((product) => [Number(product.id), product.nombre])),
    new Map((variantsResult.data ?? []).map((variant) => [Number(variant.id), variant.nombre])),
  )
  if (creditItemsResult.error) {
    const { code, orderItemId } = creditItemsResult.error
    await auditLegacyFailure(auth.admin, orderId, auth.user.id, order.financial_status, "reservation", code, `order_item_id=${orderItemId}`, null)
    return NextResponse.json({ error: code === "ITEM_NAME_MISSING"
      ? `El artículo ${orderItemId} no tiene un nombre real recuperable para la nota de crédito. Requiere revisión manual.`
      : `El artículo ${orderItemId} tiene datos incompletos o inválidos para la nota de crédito. Requiere revisión manual.` }, { status: 409 })
  }
  const amounts = buildLegacyCreditNoteAmounts(
    Number(order.total),
    allocations.map((allocation) => allocation.effectiveLineAmount),
  )
  if (!amounts) {
    await auditLegacyFailure(auth.admin, orderId, auth.user.id, order.financial_status, "reservation", "INVALID_AMOUNTS", null, null)
    return NextResponse.json({ error: "No se pudo calcular el importe de la nota de crédito. Requiere revisión manual." }, { status: 409 })
  }
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
      p_items: creditItemsResult.items,
      p_operation_type: "cancelacion_antes_despacho",
      p_expected_note_ids: expectedNoteIds,
    })
    .maybeSingle()
  if (reservationFailure || !reservedNote) {
    const message = reservationFailure?.message ?? ""
    console.error("LEGACY_CREDIT_NOTE_RESERVATION_ERROR", { orderId, message })
    const known = Object.entries(RESERVATION_ERRORS).find(([code]) => message.includes(code))
    await auditLegacyFailure(auth.admin, orderId, auth.user.id, order.financial_status, "reservation", known?.[0] ?? "RESERVATION_FAILED", message, null)
    return NextResponse.json({ error: known?.[1] ?? "No se pudo reservar la emisión de la nota de crédito." }, { status: 409 })
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
    await auditLegacyFailure(auth.admin, orderId, auth.user.id, order.financial_status, "preparation", "PREPARATION_FAILED", managementError.message, noteId)
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
    // El intento fallido de ARCA ya queda auditado por fail_credit_note_arca_attempt;
    // acá se deja además el resultado de la acción del Admin.
    await auditLegacyFailure(auth.admin, orderId, auth.user.id, order.financial_status, "arca",
      emission.status === "failed" ? `ARCA_${emission.outcome.toUpperCase()}` : `ARCA_${emission.status.toUpperCase()}`, null, noteId)
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
    await auditLegacyFailure(auth.admin, orderId, auth.user.id, order.financial_status, "finalization", "FINALIZATION_FAILED",
      error instanceof Error ? error.message : null, noteId)
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

/**
 * Toda falla de la NC heredada deja rastro en el historial del pedido
 * (código, etapa, NC, motivo técnico acotado) aunque la respuesta HTTP se
 * pierda. Nunca interrumpe la respuesta al Admin.
 */
async function auditLegacyFailure(
  admin: Parameters<typeof appendOrderAuditEvent>[0], orderId: number, actorId: string, financialStatus: string | null,
  stage: "reservation" | "preparation" | "arca" | "finalization", code: string,
  detail: string | null, noteId: string | null,
) {
  try {
    await appendOrderAuditEvent(admin, {
      orderId, actorType: "admin", actorId, action: "legacy_credit_note_failed",
      previousStatus: financialStatus, newStatus: financialStatus,
      metadata: { stage, code, orderCreditNoteId: noteId, detail: detail?.slice(0, 300) ?? null },
    })
  } catch (error) {
    console.error("LEGACY_CREDIT_NOTE_AUDIT_ERROR", { orderId, stage, message: error instanceof Error ? error.message : "UNEXPECTED_ERROR" })
  }
}
