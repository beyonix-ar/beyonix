import { NextResponse } from "next/server"

import {
  CLAIM_SHIPMENT_SELECT,
  getClaimShipmentLabel,
  type ClaimShipmentRow,
} from "@/lib/andreani/claim-shipments"
import { normalizeAndreaniError } from "@/lib/andreani/client"
import { authorizeCustomerClaimOrder } from "@/lib/orders/customer-claim-access"

export const runtime = "nodejs"

/**
 * Etiqueta de DEVOLUCIÓN del reclamo para el cliente dueño del pedido. Nunca
 * pública (sesión + dueño), nunca la de un cambio o reemplazo, siempre en el
 * ambiente donde se creó la orden y sin caché.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string; claimId: string }> }) {
  const { id, claimId: rawClaimId } = await params
  const auth = await authorizeCustomerClaimOrder(id)
  if ("response" in auth) return auth.response
  const claimId = Number(rawClaimId)
  if (!Number.isSafeInteger(claimId) || claimId <= 0) {
    return NextResponse.json({ error: "Reclamo inválido." }, { status: 400 })
  }

  const [{ data: claim, error: claimError }, { data: shipments, error: shipmentError }] = await Promise.all([
    auth.admin.from("order_claims").select("id").eq("id", claimId).eq("order_id", auth.order.id).maybeSingle(),
    auth.admin.from("order_claim_shipments").select(CLAIM_SHIPMENT_SELECT)
      .eq("claim_id", claimId).eq("order_id", auth.order.id).eq("direction", "devolucion")
      .eq("creation_status", "created").neq("status", "cancelada")
      .order("attempt", { ascending: false }).limit(1),
  ])
  if (claimError || shipmentError) {
    return NextResponse.json({ error: "No pudimos obtener la etiqueta." }, { status: 500 })
  }
  const shipment = ((shipments ?? []) as ClaimShipmentRow[])[0]
  if (!claim || !shipment) {
    return NextResponse.json({ error: "La etiqueta de devolución todavía no está disponible." }, { status: 404 })
  }

  try {
    const label = await getClaimShipmentLabel(shipment)
    return new NextResponse(Buffer.from(label.data), {
      headers: {
        "Content-Type": label.contentType,
        "Content-Disposition": `inline; filename="etiqueta-devolucion-BX-${1000 + auth.order.id}.pdf"`,
        "Cache-Control": "private, no-store",
      },
    })
  } catch (error) {
    console.error("CLAIM_RETURN_LABEL_ERROR", { claimId, ...normalizeAndreaniError(error) })
    return NextResponse.json({ error: "No pudimos obtener la etiqueta. Intentá de nuevo en unos minutos." }, { status: 502 })
  }
}
