import { NextResponse } from "next/server"

import { requireAdmin } from "@/app/api/admin/clientes/_auth"
import { creditCustomerForOrderCreditNote } from "@/lib/customer-credit/server"
import { appendOrderAuditEvent } from "@/lib/orders/order-audit"

export const runtime = "nodejs"

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin(request)
  if ("error" in auth) return auth.error

  const { id } = await params
  const orderId = Number(id)
  const body = (await request.json().catch(() => ({}))) as {
    note_id?: unknown
  }
  const noteId = typeof body.note_id === "string" ? body.note_id : ""

  if (!Number.isInteger(orderId) || orderId <= 0 || !noteId) {
    return NextResponse.json({ error: "Gestión inválida." }, { status: 400 })
  }

  const [{ data: order }, { data: note }] = await Promise.all([
    auth.admin
      .from("ordenes")
      .select("id, usuario_id, estado, financial_status")
      .eq("id", orderId)
      .single(),
    auth.admin
      .from("order_credit_notes")
      .select("*")
      .eq("id", noteId)
      .eq("order_id", orderId)
      .eq("status", "authorized")
      .eq("destination", "customer_balance")
      .single(),
  ])

  if (!order || !note) {
    return NextResponse.json(
      { error: "No se encontró una acreditación pendiente válida." },
      { status: 404 },
    )
  }
  if (!order.usuario_id) {
    return NextResponse.json(
      { error: "El pedido no tiene una cuenta de cliente asociada." },
      { status: 409 },
    )
  }

  try {
    const movement = await creditCustomerForOrderCreditNote(auth.admin, {
      userId: order.usuario_id,
      orderId,
      amount: Number(note.total_amount),
      creditNoteNumber: Number(note.voucher_number),
      creditNotePoint: Number(note.voucher_point),
      creditNoteCae: note.cae,
      claimId: note.claim_id,
      createdBy: auth.user.id,
      metadata: {
        order_credit_note_id: note.id,
        retry: true,
        associated_invoice_point: note.invoice_point,
        associated_invoice_number: note.invoice_number,
      },
    })
    const completedAt = new Date().toISOString()

    await auth.admin
      .from("order_credit_notes")
      .update({
        management_status: "finalizada",
        settlement_status: "completado",
        settlement_date: completedAt.slice(0, 10),
        updated_at: completedAt,
        error: null,
      })
      .eq("id", noteId)

    if (
      order.estado === "cancelado" ||
      ["cancellation_requested", "refund_pending"].includes(
        order.financial_status ?? "",
      )
    ) {
      await auth.admin
        .from("ordenes")
        .update({
          financial_status: "refunded",
          refund_amount: Number(note.total_amount),
          refund_method: "Saldo en cuenta BEYONIX",
          refunded_at: completedAt,
          refunded_by: auth.user.id,
        })
        .eq("id", orderId)
    }

    await appendOrderAuditEvent(auth.admin, {
      orderId,
      actorType: "admin",
      actorId: auth.user.id,
      action: "credit_note_settlement_retried",
      previousStatus: note.settlement_status ?? "pendiente",
      newStatus: "completado",
      metadata: {
        orderCreditNoteId: noteId,
        customerCreditMovementId:
          movement && "movement_id" in movement ? movement.movement_id : null,
      },
    })

    const { data: updatedOrder } = await auth.admin
      .from("ordenes")
      .select()
      .eq("id", orderId)
      .single()
    const { data: notes } = await auth.admin
      .from("order_credit_notes")
      .select("*, order_credit_note_items(*)")
      .eq("order_id", orderId)
      .order("created_at", { ascending: false })

    return NextResponse.json({
      order: { ...updatedOrder, order_credit_notes: notes ?? [] },
      movement,
    })
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "No se pudo acreditar el saldo."
    await auth.admin
      .from("order_credit_notes")
      .update({
        management_status: "acreditacion_pendiente",
        settlement_status: "pendiente",
        error: message,
        updated_at: new Date().toISOString(),
      })
      .eq("id", noteId)
    return NextResponse.json(
      { error: "La nota sigue autorizada, pero la acreditación continúa pendiente." },
      { status: 500 },
    )
  }
}
