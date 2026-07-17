import { NextResponse } from "next/server"

import { requireAdmin } from "@/app/api/admin/clientes/_auth"
import { buildArcaQrUrl } from "@/lib/arca/qr"
import {
  ArcaWsError,
  FACTURA_C_TYPE,
  NOTA_CREDITO_C_TYPE,
  feCompConsultar,
  fecaeSolicitar,
  feCompUltimoAutorizado,
} from "@/lib/arca/wsfe"
import { creditCustomerForOrderCreditNote } from "@/lib/customer-credit/server"
import { appendOrderAuditEvent } from "@/lib/orders/order-audit"
import type { createAdminClient } from "@/lib/supabase/admin"

export const runtime = "nodejs"

type AdminClient = ReturnType<typeof createAdminClient>

function getPointOfSale() {
  const pointOfSale = Number(process.env.ARCA_PTO_VTA)
  if (!Number.isInteger(pointOfSale) || pointOfSale <= 0) {
    throw new Error("ARCA_PTO_VTA debe ser un entero mayor que cero.")
  }

  return pointOfSale
}

function argentinaDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Argentina/Buenos_Aires",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date)
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]))

  return {
    arca: `${value.year}${value.month}${value.day}`,
    iso: `${value.year}-${value.month}-${value.day}`,
  }
}

function isoDateToArca(value?: string | null) {
  if (!value) return null

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null

  return argentinaDate(date).arca
}

function arcaDateToIso(value: string) {
  if (!/^\d{8}$/.test(value)) {
    throw new Error("ARCA devolvió una fecha de vencimiento de CAE inválida.")
  }

  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`
}

function validateIssueDateAfterLastAuthorized(
  issueDate: string,
  lastAuthorizedDate?: string | null,
) {
  if (!lastAuthorizedDate) return

  if (issueDate < lastAuthorizedDate) {
    throw new Error(
      "La fecha del comprobante no puede ser anterior a la última autorizada por ARCA.",
    )
  }
}

function creditNoteErrorMessage(error: unknown) {
  if (error instanceof ArcaWsError && error.details.length) {
    const details = error.details
      .map((detail) => `${detail.Code}: ${detail.Msg}`)
      .join(" | ")
    return `${error.message} ${details}`
  }

  return error instanceof Error
    ? error.message
    : "No se pudo emitir la Nota de Crédito C."
}

function creditNoteProcessingErrorResponse(message?: string) {
  if (message?.includes("CREDIT_NOTE_PROCESSING_IN_PROGRESS")) {
    return NextResponse.json(
      { error: "Ya hay una nota de crédito en proceso. Esperá a que termine antes de emitir otra." },
      { status: 409 },
    )
  }

  if (message?.includes("CREDIT_NOTE_ALREADY_AUTHORIZED")) {
    return NextResponse.json(
      { error: "La nota de crédito ya está emitida." },
      { status: 409 },
    )
  }

  if (message?.includes("CREDIT_NOTE_ALREADY_PROCESSING")) {
    return NextResponse.json(
      { error: "La nota de crédito ya se está procesando." },
      { status: 409 },
    )
  }

  return NextResponse.json(
    { error: "No se pudo iniciar la emisión de la nota de crédito." },
    { status: 500 },
  )
}

function isCancellationFlow(order: {
  estado?: string | null
  financial_status?: string | null
  return_status?: string | null
  credit_note_required?: boolean | null
}) {
  return (
    order.estado === "cancelado" ||
    ["cancelled", "cancellation_requested", "refund_pending", "refunded"].includes(
      order.financial_status ?? "",
    ) ||
    Boolean(order.return_status) ||
    Boolean(order.credit_note_required)
  )
}

async function getCreditNoteClaim(admin: AdminClient, orderId: number) {
  const { data, error } = await admin
    .from("order_claims")
    .select("id")
    .eq("order_id", orderId)
    .in("resolution", ["cupon_descuento", "saldo_a_favor"])
    .in("status", ["aprobado", "cupon_pendiente", "cerrado"])
    .limit(1)

  if (error) throw error

  return data?.[0] ?? null
}

function getCreditNoteAmount(order: {
  credit_note_amount?: number | string | null
  total?: number | string | null
  refund_amount?: number | string | null
  payment_confirmed_amount?: number | string | null
}) {
  const candidates = [
    Number(order.credit_note_amount ?? 0),
    Number(order.refund_amount ?? 0),
    Number(order.payment_confirmed_amount ?? 0),
    Number(order.total ?? 0),
  ]

  return candidates.find((amount) => Number.isFinite(amount) && amount > 0) ?? 0
}

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

  const { data: order, error: orderError } = await auth.admin
    .from("ordenes")
    .select(
      "id, usuario_id, total, estado, financial_status, return_status, payment_confirmed_amount, refund_amount, invoice_status, invoice_cae, invoice_number, invoice_point, invoice_created_at, credit_note_required, credit_note_status, credit_note_cae, credit_note_number, credit_note_amount",
    )
    .eq("id", orderId)
    .single()

  if (orderError || !order) {
    return NextResponse.json({ error: "Orden no encontrada." }, { status: 404 })
  }

  if (
    order.invoice_status !== "authorized" ||
    !order.invoice_cae ||
    !order.invoice_number ||
    !order.invoice_point
  ) {
    return NextResponse.json(
      { error: "La orden no tiene una Factura C autorizada para asociar." },
      { status: 409 },
    )
  }

  if (order.credit_note_status === "authorized" && order.credit_note_cae) {
    return NextResponse.json(
      { error: "La nota de crédito ya está emitida." },
      { status: 409 },
    )
  }

  const creditNoteClaim = await getCreditNoteClaim(auth.admin, orderId)

  if (!isCancellationFlow(order) && !creditNoteClaim) {
    return NextResponse.json(
      { error: "La nota de crédito solo corresponde a pedidos cancelados o con devolución activa." },
      { status: 409 },
    )
  }

  const amount = getCreditNoteAmount(order)
  if (!Number.isFinite(amount) || amount <= 0) {
    return NextResponse.json(
      { error: "El monto de la nota de crédito debe ser mayor que cero." },
      { status: 400 },
    )
  }

  const { data: lockedOrder, error: lockError } = await auth.admin
    .rpc("begin_arca_credit_note_processing", { p_order_id: orderId })
    .maybeSingle()

  if (lockError) {
    return creditNoteProcessingErrorResponse(lockError.message)
  }

  if (!lockedOrder) {
    return creditNoteProcessingErrorResponse()
  }

  try {
    const pointOfSale = getPointOfSale()
    const ultimoAutorizadoARCA = await feCompUltimoAutorizado(
      pointOfSale,
      NOTA_CREDITO_C_TYPE,
    )
    const lastAuthorizedVoucher = await feCompConsultar(
      pointOfSale,
      ultimoAutorizadoARCA,
      NOTA_CREDITO_C_TYPE,
    )
    const issueDate = argentinaDate()
    validateIssueDateAfterLastAuthorized(
      issueDate.arca,
      lastAuthorizedVoucher?.voucherDate,
    )

    const nextVoucherNumber = ultimoAutorizadoARCA + 1
    const authorization = await fecaeSolicitar({
      pointOfSale,
      voucherType: NOTA_CREDITO_C_TYPE,
      voucherNumber: nextVoucherNumber,
      voucherDate: issueDate.arca,
      total: amount,
      associatedVoucher: {
        voucherType: FACTURA_C_TYPE,
        pointOfSale: Number(order.invoice_point),
        voucherNumber: Number(order.invoice_number),
        voucherDate: isoDateToArca(order.invoice_created_at),
      },
    })
    const createdAt = new Date().toISOString()
    const creditNote = {
      credit_note_status: "authorized",
      credit_note_number: String(authorization.voucherNumber),
      credit_note_point: pointOfSale,
      credit_note_cae: authorization.cae,
      credit_note_cae_due: arcaDateToIso(authorization.caeDueDate),
      credit_note_created_at: createdAt,
      credit_note_amount: Number(amount.toFixed(2)),
      credit_note_error: null,
      credit_note_required: true,
      credit_note_issued: true,
      credit_note_issued_at: createdAt,
    }
    const { data: updatedOrder, error: updateError } = await auth.admin
      .from("ordenes")
      .update(creditNote)
      .eq("id", orderId)
      .eq("credit_note_status", "processing")
      .select()
      .single()

    if (updateError || !updatedOrder) {
      throw new Error(
        "ARCA autorizó la nota de crédito, pero no se pudo guardar en la orden.",
      )
    }

    const customerCreditMovement = creditNoteClaim
      ? await creditCustomerForOrderCreditNote(auth.admin, {
          userId: order.usuario_id,
          orderId,
          amount: creditNote.credit_note_amount,
          creditNoteNumber: creditNote.credit_note_number,
          creditNotePoint: creditNote.credit_note_point,
          creditNoteCae: creditNote.credit_note_cae,
          claimId: Number(creditNoteClaim.id),
          createdBy: auth.user.id,
          metadata: {
            associated_invoice_point: order.invoice_point,
            associated_invoice_number: order.invoice_number,
          },
        })
      : null

    await appendOrderAuditEvent(auth.admin, {
      orderId,
      actorType: "admin",
      actorId: auth.user.id,
      action: "credit_note_authorized",
      previousStatus: order.credit_note_status ?? null,
      newStatus: "authorized",
      metadata: {
        amount: creditNote.credit_note_amount,
        creditNoteNumber: creditNote.credit_note_number,
        creditNotePoint: pointOfSale,
        associatedInvoicePoint: order.invoice_point,
        associatedInvoiceNumber: order.invoice_number,
        customerCreditMovementId:
          customerCreditMovement && "movement_id" in customerCreditMovement
            ? customerCreditMovement.movement_id
            : null,
      },
    })

    return NextResponse.json({
      order: updatedOrder,
      credit_note: {
        voucher_type: NOTA_CREDITO_C_TYPE,
        credit_note_number: creditNote.credit_note_number,
        credit_note_point: creditNote.credit_note_point,
        credit_note_cae: creditNote.credit_note_cae,
        credit_note_cae_due: creditNote.credit_note_cae_due,
        issue_date: issueDate.iso,
        amount: creditNote.credit_note_amount,
        associated_invoice: {
          voucher_type: FACTURA_C_TYPE,
          point: order.invoice_point,
          number: order.invoice_number,
        },
        qr_url: buildArcaQrUrl({
          issueDate: issueDate.iso,
          cuit: process.env.ARCA_CUIT ?? "",
          pointOfSale,
          voucherType: NOTA_CREDITO_C_TYPE,
          voucherNumber: authorization.voucherNumber,
          total: amount,
          cae: authorization.cae,
        }),
        observations: authorization.observations,
      },
      customer_credit_movement: customerCreditMovement,
    })
  } catch (error) {
    const message = creditNoteErrorMessage(error)

    await auth.admin
      .from("ordenes")
      .update({
        credit_note_status: "error",
        credit_note_error: message,
      })
      .eq("id", orderId)
      .eq("credit_note_status", "processing")

    console.error("Error al emitir Nota de Crédito C", {
      orderId,
      error: message,
    })

    return NextResponse.json(
      { error: message },
      { status: error instanceof ArcaWsError ? 502 : 500 },
    )
  }
}
