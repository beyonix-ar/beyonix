import { NextResponse } from "next/server"

import { claimErrorResponse } from "@/lib/orders/claim-server"
import { authorizeCustomerClaimOrder } from "@/lib/orders/customer-claim-access"

/**
 * El cliente vio la conversación de SU reclamo: marca como leídas las
 * respuestas de BEYONIX hasta el mensaje que tenía en pantalla y las
 * notificaciones "BEYONIX respondió tu reclamo" de ese pedido.
 *
 * Nunca confía en el navegador: la titularidad del pedido y del reclamo se
 * valida server-side, y la fecha de lectura sale del mensaje en la base (no
 * de un timestamp enviado por el cliente). Un reclamo o mensaje ajeno o
 * inexistente responde lo mismo (sin enumeración).
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await authorizeCustomerClaimOrder((await params).id)
    if ("response" in auth) return auth.response

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return claimErrorResponse(new Error("CLAIM_INVALID"))
    }
    const payload = (body ?? {}) as Record<string, unknown>
    const claimId = Number(payload.claimId)
    const messageId = Number(payload.messageId)
    if (!Number.isSafeInteger(claimId) || claimId <= 0 || !Number.isSafeInteger(messageId) || messageId <= 0) {
      return claimErrorResponse(new Error("CLAIM_INVALID"))
    }

    const { data: claim } = await auth.admin
      .from("order_claims")
      .select("id")
      .eq("id", claimId)
      .eq("order_id", auth.order.id)
      .eq("user_id", auth.user.id)
      .maybeSingle()
    if (!claim) return claimErrorResponse(new Error("CLAIM_FORBIDDEN"))

    const { data: message } = await auth.admin
      .from("order_claim_messages")
      .select("id, created_at")
      .eq("id", messageId)
      .eq("claim_id", claimId)
      .maybeSingle()
    if (!message) return claimErrorResponse(new Error("CLAIM_FORBIDDEN"))

    const { data: lastReadAt, error } = await auth.admin.rpc("mark_order_claim_customer_read", {
      p_claim_id: claimId,
      p_user_id: auth.user.id,
      p_read_at: message.created_at,
    })
    if (error) return claimErrorResponse(error)

    return NextResponse.json({ claimId, lastReadAt })
  } catch (error) {
    return claimErrorResponse(error)
  }
}
