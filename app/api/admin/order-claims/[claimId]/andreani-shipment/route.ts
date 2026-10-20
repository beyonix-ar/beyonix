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
import { claimShipmentTestStatusEnabled } from "@/lib/andreani/claim-test-status"
import { claimErrorResponse, getClaimResult } from "@/lib/orders/claim-server"
import { CLAIM_INCIDENT_LABELS } from "@/lib/orders/claim-shipment-view"
import { CLAIM_FORCEABLE_STATUSES } from "@/lib/orders/claim-shipment-trace"
import type { createAdminClient } from "@/lib/supabase/admin"

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

type AdminClient = ReturnType<typeof createAdminClient>

/**
 * Cambiar de método (cambio directo <-> retiro) con stock reservado para el
 * reemplazo o nota de crédito vigente: primero se corrigen con su flujo
 * auditado. Chequeo previo sólo para responder rápido; la autoridad es
 * request_order_claim_logistics, que lo repite con el reclamo bloqueado
 * (CLAIM_LOGISTICS_RESERVATION_ACTIVE / CLAIM_LOGISTICS_CREDIT_NOTE_ACTIVE).
 */
async function getMethodChangeBlock(admin: AdminClient, claimId: number, direction: "cambio" | "devolucion") {
  const [legs, reserved, creditNotes] = await Promise.all([
    admin.from("order_claim_shipments").select("direction").eq("claim_id", claimId).neq("status", "cancelada")
      .order("id", { ascending: false }).limit(1),
    admin.from("order_claim_units").select("id", { count: "exact", head: true })
      .eq("claim_id", claimId).eq("role", "reemplazo").eq("location", "reservada"),
    admin.from("order_credit_notes").select("id", { count: "exact", head: true })
      .eq("claim_id", claimId).in("status", ["processing", "authorized"]),
  ])
  if (legs.error || reserved.error || creditNotes.error) {
    return { status: 500, error: "No se pudo verificar el estado del reclamo." }
  }
  const current = legs.data?.[0]?.direction
  const changesPlan = current !== undefined && (current === "cambio") !== (direction === "cambio")
  if (!changesPlan) return null
  if ((reserved.count ?? 0) > 0) {
    return { status: 409, error: "Hay stock reservado para el reemplazo: liberá la reserva (con motivo) antes de cambiar el método." }
  }
  if ((creditNotes.count ?? 0) > 0) {
    return { status: 409, error: "El reclamo tiene una nota de crédito vigente: el método no se puede cambiar." }
  }
  return null
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

  if (action === "test_status") {
    if (!claimShipmentTestStatusEnabled()) {
      return NextResponse.json({ error: "La simulación de envíos no está habilitada." }, { status: 403 })
    }
    const shipmentId = positiveInteger(body.shipmentId)
    const notes = note(body.notes)
    if (!shipmentId || notes.length < 10 ||
      !["generada", "en_transito", "en_sucursal", "entregada"].includes(String(body.status))) {
      return NextResponse.json({ error: "Elegí un estado y explicá la simulación (mínimo 10 caracteres)." }, { status: 400 })
    }
    const shipment = await loadClaimShipment(auth.admin, shipmentId).catch(() => null)
    if (!shipment || shipment.claim_id !== claimId) {
      return NextResponse.json({ error: "El reclamo no tiene ese envío." }, { status: 404 })
    }
    if (shipment.environment !== "QA") {
      return NextResponse.json({ error: "Sólo se pueden simular envíos Andreani de QA." }, { status: 403 })
    }
    const { error } = await auth.admin.rpc("simulate_order_claim_shipment_status", {
      p_shipment_id: shipmentId, p_actor_id: actorId,
      p_status: body.status,
      p_note: notes,
    })
    if (error) return claimErrorResponse(error)
    return getClaimResult(auth.admin, claimId)
  }

  // Estado operativo forzado del reenvío (super admin; nunca toca Andreani).
  // La base repite rol, tramo, motivo y guardas (force_order_claim_shipment_status).
  if (action === "force_status") {
    if (auth.profile.rol !== "super_admin") {
      return NextResponse.json({ error: "Sólo un superadministrador puede forzar el estado del reenvío." }, { status: 403 })
    }
    const shipmentId = positiveInteger(body.shipmentId)
    const notes = note(body.notes)
    if (!shipmentId || !(CLAIM_FORCEABLE_STATUSES as readonly string[]).includes(String(body.status))) {
      return NextResponse.json({ error: "Elegí el estado a forzar." }, { status: 400 })
    }
    if (notes.length < 10) {
      return NextResponse.json({ error: "Explicá el motivo del cambio (mínimo 10 caracteres)." }, { status: 400 })
    }
    const shipment = await loadClaimShipment(auth.admin, shipmentId).catch(() => null)
    if (!shipment || shipment.claim_id !== claimId) {
      return NextResponse.json({ error: "El reclamo no tiene ese envío." }, { status: 404 })
    }
    const { error } = await auth.admin.rpc("force_order_claim_shipment_status", {
      p_shipment_id: shipmentId, p_actor_id: actorId, p_status: body.status, p_note: notes,
    })
    if (error) return claimErrorResponse(error)
    return getClaimResult(auth.admin, claimId)
  }

  if (action === "request" || action === "request_without_return") {
    // Sin devolución: el cliente conserva el original y sólo viaja el reemplazo
    // (tramo "reemplazo"). Motivo obligatorio; la base lo vuelve a exigir.
    const withoutReturn = action === "request_without_return"
    const direction = withoutReturn ? "reemplazo" : body.direction
    if (!REQUESTABLE.includes(direction as (typeof REQUESTABLE)[number])) {
      return NextResponse.json({ error: "Acción inválida." }, { status: 400 })
    }
    if (withoutReturn && note(body.notes).length < 10) {
      return NextResponse.json({ error: "Indicá por qué el producto no vuelve (mínimo 10 caracteres)." }, { status: 400 })
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
    if (direction !== "reemplazo") {
      const blocked = await getMethodChangeBlock(auth.admin, claimId, direction as "cambio" | "devolucion")
      if (blocked) return NextResponse.json({ error: blocked.error }, { status: blocked.status })
    }
    const branchAddress = [branch.address, branch.locality, branch.province].filter(Boolean).join(", ") || null
    const { error } = withoutReturn
      ? await auth.admin.rpc("request_order_claim_resend_without_return", {
          p_claim_id: claimId, p_actor_id: actorId, p_note: note(body.notes),
          p_branch_id: branch.id, p_branch_name: branch.name, p_branch_address: branchAddress,
        })
      : await auth.admin.rpc("request_order_claim_logistics", {
          p_claim_id: claimId, p_actor_id: actorId, p_direction: direction, p_note: note(body.notes) || null,
          p_branch_id: branch.id, p_branch_name: branch.name, p_branch_address: branchAddress,
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
  if (claimId && new URL(request.url).searchParams.get("capabilities") === "1") {
    return NextResponse.json({ testStatusEnabled: claimShipmentTestStatusEnabled() }, {
      headers: { "Cache-Control": "private, no-store" },
    })
  }
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
