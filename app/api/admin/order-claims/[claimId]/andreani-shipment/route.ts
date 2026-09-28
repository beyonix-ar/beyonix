import { NextResponse } from "next/server"

import { requireAdmin } from "@/app/api/admin/clientes/_auth"
import {
  CLAIM_SHIPMENT_SELECT,
  createAndreaniReplacementShipmentForClaim,
  createAndreaniReturnForClaim,
  getClaimShipmentLabel,
  reconcileClaimShipment,
  syncClaimShipmentTracking,
  type ClaimShipmentDirection,
  type ClaimShipmentRow,
} from "@/lib/andreani/claim-shipments"
import { normalizeAndreaniError } from "@/lib/andreani/client"
import { getClaimResult } from "@/lib/orders/claim-server"

export const runtime = "nodejs"

const DIRECTIONS: readonly ClaimShipmentDirection[] = ["devolucion", "reemplazo"]

function parseClaimId(value: string) {
  const claimId = Number(value)
  return Number.isSafeInteger(claimId) && claimId > 0 ? claimId : null
}

function errorStatus(code: string) {
  return ["VALIDATION_ERROR", "CONFIGURATION_ERROR", "PROVIDER_DISABLED", "PRODUCTION_BLOCKED"].includes(code) ? 409 : 502
}

async function loadShipment(admin: Parameters<typeof getClaimResult>[0], claimId: number, direction: ClaimShipmentDirection) {
  const { data, error } = await admin
    .from("order_claim_shipments")
    .select(CLAIM_SHIPMENT_SELECT)
    .eq("claim_id", claimId)
    .eq("direction", direction)
    .maybeSingle()
  if (error) throw new Error("CLAIM_SHIPMENT_READ")
  return data as ClaimShipmentRow | null
}

/**
 * Envíos Andreani del cambio (Admin):
 *   { direction, action: "create" }    -> genera (o reutiliza) el tramo. Idempotente.
 *   { direction, action: "sync" }      -> consulta el seguimiento (sólo GET).
 *   { direction, action: "reconcile", resolution: "created"|"not_created", envioId?, notes }
 *                                      -> tras un resultado incierto. Nunca reintenta el POST.
 * Nunca modifica stock.
 */
export async function POST(request: Request, { params }: { params: Promise<{ claimId: string }> }) {
  const auth = await requireAdmin(request)
  if ("error" in auth) return auth.error
  const claimId = parseClaimId((await params).claimId)
  if (!claimId) return NextResponse.json({ error: "Reclamo inválido." }, { status: 400 })

  let body: Record<string, unknown>
  try {
    const parsed: unknown = await request.json()
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("INVALID")
    body = parsed as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: "Solicitud inválida." }, { status: 400 })
  }
  const direction = body.direction as ClaimShipmentDirection
  const action = body.action
  if (!DIRECTIONS.includes(direction) || !["create", "sync", "reconcile"].includes(String(action))) {
    return NextResponse.json({ error: "Acción inválida." }, { status: 400 })
  }

  try {
    if (action === "create") {
      await (direction === "devolucion"
        ? createAndreaniReturnForClaim(auth.admin, claimId)
        : createAndreaniReplacementShipmentForClaim(auth.admin, claimId))
    } else if (action === "sync") {
      const shipment = await loadShipment(auth.admin, claimId, direction)
      if (!shipment) return NextResponse.json({ error: "El reclamo no tiene ese envío." }, { status: 404 })
      await syncClaimShipmentTracking(auth.admin, shipment)
    } else {
      const resolution = body.resolution
      const notes = typeof body.notes === "string" ? body.notes.trim() : ""
      if ((resolution !== "created" && resolution !== "not_created") || notes.length < 5 || notes.length > 1000) {
        return NextResponse.json({ error: "Indicá si la orden existe en Andreani y cómo lo confirmaste (mínimo 5 caracteres)." }, { status: 400 })
      }
      await reconcileClaimShipment(auth.admin, {
        claimId,
        direction,
        actorId: auth.user.id,
        resolution,
        envioId: typeof body.envioId === "string" ? body.envioId : undefined,
        notes,
      })
    }
  } catch (error) {
    const safe = normalizeAndreaniError(error)
    return NextResponse.json({ error: safe.message }, { status: errorStatus(safe.code) })
  }
  return getClaimResult(auth.admin, claimId)
}

/** GET ?direction=devolucion|reemplazo -> etiqueta PDF del tramo (sólo Admin). */
export async function GET(request: Request, { params }: { params: Promise<{ claimId: string }> }) {
  const auth = await requireAdmin(request)
  if ("error" in auth) return auth.error
  const claimId = parseClaimId((await params).claimId)
  const direction = new URL(request.url).searchParams.get("direction") as ClaimShipmentDirection
  if (!claimId || !DIRECTIONS.includes(direction)) {
    return NextResponse.json({ error: "Solicitud inválida." }, { status: 400 })
  }
  try {
    const shipment = await loadShipment(auth.admin, claimId, direction)
    if (!shipment) return NextResponse.json({ error: "El reclamo no tiene ese envío." }, { status: 404 })
    const label = await getClaimShipmentLabel(shipment)
    return new NextResponse(Buffer.from(label.data), {
      headers: {
        "Content-Type": label.contentType,
        "Content-Disposition": `inline; filename="andreani-${direction}-${shipment.andreani_envio_id}.pdf"`,
        "Cache-Control": "private, no-store",
      },
    })
  } catch (error) {
    const safe = normalizeAndreaniError(error)
    return NextResponse.json({ error: safe.message }, { status: errorStatus(safe.code) })
  }
}
