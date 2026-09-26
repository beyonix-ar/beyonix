import { NextResponse } from "next/server"

import { CheckoutReservationExpiredError } from "@/lib/orders/checkout-inventory"
import { verifyGuestOrderAccessToken } from "@/lib/orders/guest-order-token"
import { decideTransferPayerDeclaration } from "@/lib/orders/transfer-payer-declaration"
import {
  isTransferReservationActive,
  loadTransferReservationDeadline,
} from "@/lib/orders/transfer-reservation-window"
import { getTransferBankDetails } from "@/lib/payments/transfer-bank-details"
import { createAdminClient } from "@/lib/supabase/admin"
import { createClient } from "@/lib/supabase/server"

const ORDER_FIELDS =
  "id, usuario_id, estado, payment_method_id, payment_status, payment_proof_url, payment_proof_uploaded_at, transfer_verification_status, external_amount_due, total"

/**
 * Guarda y valida los datos del titular que va a transferir y RECIÉN
 * ENTONCES entrega alias/CVU: una transferencia hecha sin esos datos no
 * podría atribuirse al pedido (ni siquiera por la conciliación tardía).
 * Sólo mientras siga vigente la reserva de 20 minutos del Paso 3.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ orderId: string }> },
) {
  try {
    const { orderId } = await params
    const pedidoId = Number(orderId)
    if (!Number.isSafeInteger(pedidoId) || pedidoId <= 0) {
      return NextResponse.json({ error: "Pedido inválido." }, { status: 400 })
    }

    let payload: Record<string, unknown>
    try {
      payload = ((await request.json()) ?? {}) as Record<string, unknown>
    } catch {
      return NextResponse.json({ error: "Datos inválidos." }, { status: 400 })
    }

    const supabase = await createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()
    const admin = createAdminClient()
    const { data: order, error: orderError } = await admin
      .from("ordenes")
      .select(ORDER_FIELDS)
      .eq("id", pedidoId)
      .maybeSingle()

    if (orderError || !order) {
      return NextResponse.json({ error: "No encontramos el pedido." }, { status: 404 })
    }
    if (order.usuario_id) {
      if (order.usuario_id !== user?.id) {
        return NextResponse.json({ error: "No autorizado." }, { status: 403 })
      }
    } else if (!verifyGuestOrderAccessToken(request.headers.get("x-guest-order-token"), pedidoId)) {
      return NextResponse.json({ error: "No autorizado." }, { status: 403 })
    }

    if (!isTransferReservationActive(await loadTransferReservationDeadline(admin, pedidoId))) {
      return NextResponse.json(
        { code: "RESERVATION_EXPIRED", error: new CheckoutReservationExpiredError().message },
        { status: 409 },
      )
    }

    const decision = decideTransferPayerDeclaration(order, {
      nombre: payload.nombre,
      apellido: payload.apellido,
      dni: payload.dni,
    })
    if (!decision.ok) {
      switch (decision.reason) {
        case "invalid_fields": {
          const [field, message] = Object.entries(decision.errors)[0] ?? []
          return NextResponse.json(
            { error: message ?? "Revisá los datos del titular.", field, fieldErrors: decision.errors },
            { status: 400 },
          )
        }
        case "checking":
          return NextResponse.json(
            { error: "Estamos verificando tu transferencia. Esperá unos segundos.", retryable: true },
            { status: 409 },
          )
        case "not_transfer":
          return NextResponse.json({ error: "Este pedido no corresponde a transferencia bancaria." }, { status: 400 })
        case "invalid_amount":
          console.error("TRANSFER_PAYER_DECLARATION_INVALID_AMOUNT", { orderId: pedidoId })
          return NextResponse.json({ error: "No pudimos calcular el importe a transferir." }, { status: 500 })
        default:
          return NextResponse.json({ error: "Este pedido ya no admite cambiar los datos del titular." }, { status: 409 })
      }
    }

    const { firstName, lastName, document, amount } = decision.value
    // UPDATE condicional: nunca pisa un pedido que mientras tanto se pagó,
    // recibió comprobante o entró en una verificación en curso.
    const { data: saved, error: saveError } = await admin
      .from("ordenes")
      .update({
        transfer_payer_first_name: firstName,
        transfer_payer_last_name: lastName,
        transfer_payer_dni: document,
        transfer_amount_declared: amount,
      })
      .eq("id", pedidoId)
      .eq("payment_method_id", "transferencia")
      .eq("estado", "pendiente")
      .eq("payment_status", "pendiente_comprobante")
      .is("payment_proof_url", null)
      .or("transfer_verification_status.is.null,transfer_verification_status.neq.checking")
      .select("id")
      .maybeSingle()

    if (saveError) throw saveError
    if (!saved) {
      return NextResponse.json(
        { error: "Tu pedido cambió mientras guardábamos los datos. Intentá nuevamente.", retryable: true },
        { status: 409 },
      )
    }

    return NextResponse.json({ saved: true, amount, bankTransfer: getTransferBankDetails() })
  } catch (error) {
    console.error("TRANSFER_PAYER_DECLARATION_ERROR", error)
    return NextResponse.json(
      { error: "No pudimos guardar los datos del titular. Intentá nuevamente." },
      { status: 500 },
    )
  }
}
