import { NextResponse } from "next/server"

import { PAYMENT_PROOF_BUCKET } from "@/lib/payments/transfer"
import { getTransferBankDetails } from "@/lib/payments/transfer-bank-details"
import { expireTransferOrderIfNeeded } from "@/lib/orders/transfer-expiration"
import {
  isTransferReservationActive,
  loadTransferReservationDeadline,
} from "@/lib/orders/transfer-reservation-window"
import { isAwaitingTransferPayment } from "@/lib/orders/transfer-verification-reasons"
import { verifyGuestOrderAccessToken } from "@/lib/orders/guest-order-token"
import { createAdminClient } from "@/lib/supabase/admin"
import { createClient } from "@/lib/supabase/server"
import type { SupabasePedido } from "@/lib/supabase/types"

const ORDER_PROOF_FIELDS =
  "id, usuario_id, created_at, estado, payment_method_id, payment_status, payment_proof_url, payment_proof_uploaded_at, payment_proof_file_name, financial_status, paid_at, payment_confirmed_amount, total, external_amount_due, transfer_verification_status, transfer_payer_first_name, transfer_payer_last_name, transfer_payer_dni, transfer_amount_declared"

function stripBucket(path: string) {
  return path.startsWith(`${PAYMENT_PROOF_BUCKET}/`)
    ? path.slice(PAYMENT_PROOF_BUCKET.length + 1)
    : path
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ orderId: string }> },
) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  const { orderId } = await params
  const pedidoId = Number(orderId)

  if (!Number.isFinite(pedidoId) || pedidoId <= 0) {
    return NextResponse.json({ error: "Pedido inválido." }, { status: 400 })
  }

  const admin = createAdminClient()
  const { data: order, error: orderError } = await admin
    .from("ordenes")
    .select(ORDER_PROOF_FIELDS)
    .eq("id", pedidoId)
    .maybeSingle()

  if (orderError || !order) {
    return NextResponse.json({ error: "No encontramos el pedido." }, { status: 404 })
  }

  if (order.usuario_id) {
    if (order.usuario_id !== user?.id) {
      return NextResponse.json({ error: "No autorizado." }, { status: 403 })
    }
  } else {
    const guestToken = request.headers.get("x-guest-order-token")
    if (!verifyGuestOrderAccessToken(guestToken, pedidoId)) {
      return NextResponse.json({ error: "No autorizado." }, { status: 403 })
    }
  }

  const currentOrder = await expireTransferOrderIfNeeded(
    admin,
    order as SupabasePedido,
  )

  if (currentOrder.payment_method_id !== "transferencia") {
    return NextResponse.json(
      { error: "Este pedido no corresponde a transferencia bancaria." },
      { status: 400 },
    )
  }

  // Contador de la pantalla de transferencia: el expires_at ORIGINAL de la
  // reserva del Paso 3 más la hora del servidor. Leerlo nunca lo renueva.
  let reservation: { expiresAt: string | null; serverNow: string }
  try {
    reservation = {
      expiresAt: await loadTransferReservationDeadline(admin, pedidoId),
      serverNow: new Date().toISOString(),
    }
  } catch (reservationError) {
    console.error("TRANSFER_RESERVATION_DEADLINE_LOAD_ERROR", {
      orderId: pedidoId,
      message: reservationError instanceof Error ? reservationError.message : String(reservationError),
    })
    return NextResponse.json(
      { error: "No pudimos comprobar la reserva de tu pedido. Intentá nuevamente." },
      { status: 500 },
    )
  }

  // Alias/CVU sólo después de guardar los datos del titular y mientras la
  // reserva siga vigente (ver /api/transferencia/[orderId]/titular).
  const bankTransfer =
    currentOrder.transfer_payer_dni &&
    isAwaitingTransferPayment(currentOrder) &&
    isTransferReservationActive(reservation.expiresAt)
      ? getTransferBankDetails()
      : null

  if (!currentOrder.payment_proof_url) {
    return NextResponse.json({ order: currentOrder, signedUrl: null, reservation, bankTransfer })
  }

  const { data, error } = await admin.storage
    .from(PAYMENT_PROOF_BUCKET)
    .createSignedUrl(stripBucket(currentOrder.payment_proof_url), 300)

  if (error || !data?.signedUrl) {
    console.error("customer payment proof signed URL error", {
      orderId: pedidoId,
      message: error?.message || "No se generó la URL firmada.",
    })

    return NextResponse.json(
      { error: "No se pudo abrir el comprobante." },
      { status: 500 },
    )
  }

  return NextResponse.json({
    order: currentOrder,
    signedUrl: data.signedUrl,
    fileName: currentOrder.payment_proof_file_name,
    reservation,
    bankTransfer,
  })
}
