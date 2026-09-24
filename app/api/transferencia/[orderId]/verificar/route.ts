import { NextResponse } from "next/server"

import { verifyGuestOrderAccessToken } from "@/lib/orders/guest-order-token"
import {
  attemptTransferAutoVerification,
  type TransferVerificationAttemptResult,
} from "@/lib/orders/transfer-verification-service"
import { canUploadTransferProof } from "@/lib/orders/transfer-verification-reasons"
import { validateTransferDeclaration } from "@/lib/payments/transfer-declaration"
import { createAdminClient } from "@/lib/supabase/admin"
import { createClient } from "@/lib/supabase/server"

/**
 * Respuesta MÍNIMA y explícitamente allowlisteada para el cliente: nunca
 * incluye la fila de la orden completa. En particular, nunca expone la
 * metadata interna de conciliación con Mercado Pago (identificación del
 * pagador original/derivada, payment.id, tipo de operación) -- eso sólo es
 * visible desde endpoints admin protegidos (el panel de pedidos ya lo lee
 * ahí con el rol correspondiente). Cualquier dato nuevo que el cliente
 * llegue a necesitar tiene que agregarse acá de forma explícita, nunca
 * reenviando la fila.
 */
function safeVerificationResponse(
  result: Extract<TransferVerificationAttemptResult, { status: "verified" | "manual_review" }>,
) {
  const verified = result.status === "verified"

  return {
    status: result.status,
    verified,
    manualReviewRequired: !verified,
    // El pago ya está confirmado -> nunca corresponde ofrecer comprobante.
    // Cualquier otro resultado (incluido manual_review por conflicto de
    // stock: la plata ya está identificada, pero el admin puede pedir
    // evidencia adicional) deja la puerta abierta.
    proofUploadAvailable: !verified,
    message: verified
      ? "Verificamos tu transferencia automáticamente."
      : "No pudimos validar tu transferencia automáticamente.",
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ orderId: string }> },
) {
  try {
    const supabase = await createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()

    const { orderId } = await params
    const pedidoId = Number(orderId)

    if (!Number.isFinite(pedidoId) || pedidoId <= 0) {
      return NextResponse.json(
        { error: "Pedido inválido.", proofUploadAvailable: true },
        { status: 400 },
      )
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json(
        { error: "Datos inválidos.", proofUploadAvailable: true },
        { status: 400 },
      )
    }

    const payload = (body ?? {}) as Record<string, unknown>

    const admin = createAdminClient()
    const { data: order, error: orderError } = await admin
      .from("ordenes")
      .select("id, usuario_id, payment_method_id, payment_status")
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

    if (order.payment_method_id !== "transferencia") {
      // Este pedido no pasa por el sistema de comprobantes de transferencia
      // en absoluto -- nunca corresponde ofrecer el uploader acá.
      return NextResponse.json(
        { error: "Este pedido no corresponde a transferencia bancaria.", proofUploadAvailable: false },
        { status: 400 },
      )
    }

    // P1 (segunda auditoría): un error de validación del formulario (ej.:
    // monto con coma decimal) nunca puede dejar al cliente sin la salida del
    // comprobante manual mientras el pago siga sin confirmarse -- mismo
    // criterio central que usa el resto del sistema (canUploadTransferProof).
    // Datos del TITULAR de la cuenta desde donde salió la transferencia:
    // nombre, apellido, DNI/CUIT y monto son obligatorios (misma validación
    // que el formulario, ver lib/payments/transfer-declaration.ts). El
    // matching automático usa DNI + monto; nombre y apellido quedan para la
    // conciliación manual del admin.
    const declaration = validateTransferDeclaration(payload)
    if (!declaration.ok) {
      const [field, message] = Object.entries(declaration.errors)[0] ?? []
      return NextResponse.json(
        {
          error: message ?? "Revisá los datos de la transferencia.",
          field,
          fieldErrors: declaration.errors,
          proofUploadAvailable: canUploadTransferProof(order.payment_status),
        },
        { status: 400 },
      )
    }

    const { firstName, lastName, document, amount } = declaration.value
    const result = await attemptTransferAutoVerification(admin, {
      orderId: pedidoId,
      declared: { firstName, lastName, dni: document, amount },
    })

    switch (result.status) {
      case "verified":
      case "manual_review":
        return NextResponse.json(safeVerificationResponse(result))
      case "rate_limited":
        // Fallo técnico transitorio: mientras el pago no esté confirmado, el
        // cliente nunca debe quedar sin salida -- ofrecemos igual el
        // comprobante como alternativa segura.
        return NextResponse.json(
          { error: result.message, proofUploadAvailable: true },
          { status: 429 },
        )
      case "checking_in_progress":
        return NextResponse.json(
          { error: result.message, proofUploadAvailable: true },
          { status: 409 },
        )
      case "rejected":
      default:
        return NextResponse.json(
          { error: result.message, proofUploadAvailable: true },
          { status: 409 },
        )
    }
  } catch (error) {
    console.error("transfer auto-verification error", error)

    // Error inesperado (500) o Mercado Pago caído: un fallo técnico nunca
    // debe bloquear al cliente -- el comprobante sigue disponible.
    return NextResponse.json(
      { error: "No pudimos verificar tu transferencia.", proofUploadAvailable: true },
      { status: 500 },
    )
  }
}
