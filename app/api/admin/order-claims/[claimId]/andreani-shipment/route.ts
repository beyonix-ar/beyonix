import { NextResponse } from "next/server"

import { requireAdmin } from "@/app/api/admin/clientes/_auth"
import {
  createClaimShipment,
  getClaimShipmentLabel,
  loadClaimShipment,
  reconcileClaimShipment,
  resolveClaimBranch,
  resolveDefaultClaimBranch,
  syncClaimShipmentTracking,
  type ClaimBranch,
} from "@/lib/andreani/claim-shipments"
import { normalizeAndreaniError } from "@/lib/andreani/client"
import { claimErrorResponse, getClaimResult } from "@/lib/orders/claim-server"
import { CLAIM_INCIDENT_LABELS } from "@/lib/orders/claim-shipment-view"

export const runtime = "nodejs"

const LEG_ACTIONS = ["create", "sync", "reconcile", "cancel", "exchange_not_completed", "review_resolve"] as const
const UNIT_ACTIONS = [
  "arrival_original",
  "arrival_replacement",
  "inspect_replacement",
  "release_reservation",
  "deliver_manual",
  "waive_original",
  "incident_open",
  "incident_resolve",
] as const
const REQUESTABLE = ["devolucion", "cambio", "reemplazo"] as const
const INCIDENT_TYPES = Object.keys(CLAIM_INCIDENT_LABELS)
const KEY_PATTERN = /^[A-Za-z0-9._:-]{8,200}$/

function positiveInteger(value: unknown) {
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 ? number : null
}

function note(value: unknown) {
  return typeof value === "string" ? value.trim().slice(0, 1000) : ""
}

function andreaniErrorStatus(code: string) {
  return ["VALIDATION_ERROR", "CONFIGURATION_ERROR", "PROVIDER_DISABLED", "PRODUCTION_BLOCKED"].includes(code) ? 409 : 502
}

/**
 * Logística del reclamo (sólo Admin; la base vuelve a exigir rol admin y
 * valida cada transición):
 *   { action: "request", direction }                         -> abre el tramo (plan explícito).
 *   { action: "create"|"sync"|"cancel"|"exchange_not_completed"|"reconcile", shipmentId, ... }
 *   { action: <acción de unidades>, orderItemId, quantity, notes, idempotencyKey }
 * Nunca acepta contrato, ambiente, modalidad ni orden Andreani del navegador
 * (salvo el número a conciliar, que se verifica contra Andreani y la base).
 */
export async function POST(request: Request, { params }: { params: Promise<{ claimId: string }> }) {
  const auth = await requireAdmin(request)
  if ("error" in auth) return auth.error
  const claimId = positiveInteger((await params).claimId)
  if (!claimId) return NextResponse.json({ error: "Reclamo inválido." }, { status: 400 })

  let body: Record<string, unknown>
  try {
    const parsed: unknown = await request.json()
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("INVALID")
    body = parsed as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: "Solicitud inválida." }, { status: 400 })
  }
  const action = String(body.action ?? "")
  const actorId = auth.user.id

  if (action === "request") {
    const direction = body.direction
    if (!REQUESTABLE.includes(direction as (typeof REQUESTABLE)[number])) {
      return NextResponse.json({ error: "Acción inválida." }, { status: 400 })
    }
    // Sucursal: siempre validada ahora contra el catálogo real de Andreani;
    // nombre/dirección salen del catálogo, nunca del navegador. Sin id, la
    // sugerida (tramo anterior o compra a sucursal), también revalidada.
    let branch: ClaimBranch | null
    try {
      branch = typeof body.branchId === "string" && body.branchId.trim()
        ? await resolveClaimBranch(body.branchId)
        : await resolveDefaultClaimBranch(auth.admin, claimId, direction as (typeof REQUESTABLE)[number])
    } catch (error) {
      const safe = normalizeAndreaniError(error)
      return NextResponse.json({ error: safe.message }, { status: andreaniErrorStatus(safe.code) })
    }
    if (!branch) {
      return NextResponse.json({ error: "Elegí una sucursal Andreani para la operación." }, { status: 400 })
    }
    const { error } = await auth.admin.rpc("request_order_claim_logistics", {
      p_claim_id: claimId, p_actor_id: actorId, p_direction: direction, p_note: note(body.notes) || null,
      p_branch_id: branch.id, p_branch_name: branch.name,
      p_branch_address: [branch.address, branch.locality, branch.province].filter(Boolean).join(", ") || null,
    })
    if (error) return claimErrorResponse(error)
    return getClaimResult(auth.admin, claimId)
  }

  if ((LEG_ACTIONS as readonly string[]).includes(action)) {
    const shipmentId = positiveInteger(body.shipmentId)
    if (!shipmentId) return NextResponse.json({ error: "Operación inválida." }, { status: 400 })
    const shipment = await loadClaimShipment(auth.admin, shipmentId).catch(() => null)
    // Un tramo de otro reclamo nunca se opera desde este.
    if (!shipment || shipment.claim_id !== claimId) {
      return NextResponse.json({ error: "El reclamo no tiene esa operación Andreani." }, { status: 404 })
    }
    if (action === "cancel" || action === "exchange_not_completed" || action === "review_resolve") {
      const notes = note(body.notes)
      const rpcName = action === "cancel"
        ? "cancel_order_claim_leg"
        : action === "review_resolve" ? "resolve_order_claim_shipment_review" : "mark_order_claim_exchange_not_completed"
      const { error } = await auth.admin.rpc(rpcName, {
        p_shipment_id: shipmentId, p_actor_id: actorId, p_note: notes,
      })
      if (error) return claimErrorResponse(error)
      return getClaimResult(auth.admin, claimId)
    }
    try {
      if (action === "create") {
        await createClaimShipment(auth.admin, shipmentId)
      } else if (action === "sync") {
        await syncClaimShipmentTracking(auth.admin, shipment)
      } else {
        const resolution = body.resolution
        const notes = note(body.notes)
        if ((resolution !== "created" && resolution !== "not_created") || notes.length < 5) {
          return NextResponse.json({ error: "Indicá si la orden existe en Andreani y cómo lo confirmaste (mínimo 5 caracteres)." }, { status: 400 })
        }
        await reconcileClaimShipment(auth.admin, {
          shipmentId,
          actorId,
          resolution,
          envioId: typeof body.envioId === "string" ? body.envioId.slice(0, 80) : undefined,
          notes,
        })
      }
    } catch (error) {
      const safe = normalizeAndreaniError(error)
      return NextResponse.json({ error: safe.message }, { status: andreaniErrorStatus(safe.code) })
    }
    return getClaimResult(auth.admin, claimId)
  }

  if ((UNIT_ACTIONS as readonly string[]).includes(action)) {
    const orderItemId = positiveInteger(body.orderItemId)
    const quantity = positiveInteger(body.quantity)
    const notes = note(body.notes)
    const key = typeof body.idempotencyKey === "string" && KEY_PATTERN.test(body.idempotencyKey) ? body.idempotencyKey : null
    const role = body.role === "reemplazo" ? "reemplazo" : "original"
    const incidentType = typeof body.incidentType === "string" && (INCIDENT_TYPES as readonly string[]).includes(body.incidentType)
      ? body.incidentType : null
    if (!orderItemId || (!quantity && !action.startsWith("incident"))) {
      return NextResponse.json({ error: "Revisá el producto y la cantidad." }, { status: 400 })
    }
    if (!key && !action.startsWith("incident")) {
      return NextResponse.json({ error: "La operación no tiene una clave de idempotencia válida." }, { status: 400 })
    }
    const call = (() => {
      switch (action) {
        case "arrival_original":
        case "arrival_replacement":
          return auth.admin.rpc("register_order_claim_units_arrival", {
            p_claim_id: claimId, p_actor_id: actorId, p_role: action === "arrival_original" ? "original" : "reemplazo",
            p_order_item_id: orderItemId, p_quantity: quantity, p_note: notes || null,
            p_incident_type: incidentType, p_idempotency_key: key,
          })
        case "inspect_replacement": {
          const restock = Number(body.restock)
          const writeOff = Number(body.writeOff)
          if (!Number.isSafeInteger(restock) || !Number.isSafeInteger(writeOff) || restock < 0 || writeOff < 0 || restock + writeOff !== quantity) {
            return null
          }
          return auth.admin.rpc("inspect_order_claim_replacement_units", {
            p_claim_id: claimId, p_actor_id: actorId, p_order_item_id: orderItemId,
            p_restock: restock, p_write_off: writeOff, p_note: notes || null, p_idempotency_key: key,
          })
        }
        case "release_reservation":
          return auth.admin.rpc("release_order_claim_replacement_reservation", {
            p_claim_id: claimId, p_actor_id: actorId, p_order_item_id: orderItemId, p_quantity: quantity, p_note: notes, p_idempotency_key: key,
          })
        case "deliver_manual":
          return auth.admin.rpc("confirm_order_claim_replacement_delivered_manually", {
            p_claim_id: claimId, p_actor_id: actorId, p_order_item_id: orderItemId, p_quantity: quantity, p_note: notes, p_idempotency_key: key,
          })
        case "waive_original":
          return auth.admin.rpc("waive_order_claim_original_return", {
            p_claim_id: claimId, p_actor_id: actorId, p_order_item_id: orderItemId, p_quantity: quantity, p_note: notes, p_idempotency_key: key,
          })
        default:
          if (action === "incident_open" && !incidentType) return null
          return auth.admin.rpc("set_order_claim_units_incident", {
            p_claim_id: claimId, p_actor_id: actorId, p_role: role, p_order_item_id: orderItemId,
            p_incident_type: action === "incident_open" ? incidentType : null, p_note: notes,
          })
      }
    })()
    if (!call) {
      return NextResponse.json({ error: action === "incident_open"
        ? "Elegí el resultado de la inspección."
        : "Indicá cuántas unidades vuelven a stock y cuántas se dan de baja." }, { status: 400 })
    }
    const { error } = await call
    if (error) return claimErrorResponse(error)
    return getClaimResult(auth.admin, claimId)
  }

  return NextResponse.json({ error: "Acción inválida." }, { status: 400 })
}

/** GET ?shipmentId= -> etiqueta PDF del tramo (sólo Admin, sin caché). */
export async function GET(request: Request, { params }: { params: Promise<{ claimId: string }> }) {
  const auth = await requireAdmin(request)
  if ("error" in auth) return auth.error
  const claimId = positiveInteger((await params).claimId)
  const shipmentId = positiveInteger(new URL(request.url).searchParams.get("shipmentId"))
  if (!claimId || !shipmentId) {
    return NextResponse.json({ error: "Solicitud inválida." }, { status: 400 })
  }
  try {
    const shipment = await loadClaimShipment(auth.admin, shipmentId)
    if (!shipment || shipment.claim_id !== claimId) {
      return NextResponse.json({ error: "El reclamo no tiene esa operación Andreani." }, { status: 404 })
    }
    const label = await getClaimShipmentLabel(shipment)
    return new NextResponse(Buffer.from(label.data), {
      headers: {
        "Content-Type": label.contentType,
        "Content-Disposition": `inline; filename="andreani-${shipment.direction}-${shipment.andreani_envio_id}.pdf"`,
        "Cache-Control": "private, no-store",
      },
    })
  } catch (error) {
    const safe = normalizeAndreaniError(error)
    return NextResponse.json({ error: safe.message }, { status: andreaniErrorStatus(safe.code) })
  }
}
