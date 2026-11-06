import { NextResponse } from "next/server"

import { requireAdmin } from "@/app/api/admin/clientes/_auth"
import { claimErrorResponse, getClaimResult } from "@/lib/orders/claim-server"
import { CLAIM_INCIDENT_LABELS } from "@/lib/orders/claim-shipment-view"

export const runtime = "nodejs"

const KEY_PATTERN = /^[A-Za-z0-9._:-]{8,200}$/
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const INCIDENT_TYPES = Object.keys(CLAIM_INCIDENT_LABELS)
const MAX_ITEMS = 50

function positiveInteger(value: unknown) {
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 ? number : null
}

function note(value: unknown) {
  return typeof value === "string" ? value.trim().slice(0, 1000) : ""
}

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

type ReceptionItem = { order_item_id: number; quantity: number; incident_type?: string }

/** Cantidades enteras y productos del reclamo; la base vuelve a validar cada una contra lo autorizado. */
function receptionItems(value: unknown): ReceptionItem[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ITEMS) return null
  const seen = new Set<number>()
  const items: ReceptionItem[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return null
    const { orderItemId, quantity, incidentType } = entry as Record<string, unknown>
    const id = positiveInteger(orderItemId)
    if (!id || seen.has(id) || typeof quantity !== "number" || !Number.isSafeInteger(quantity) || quantity < 0 || quantity > 9999) return null
    if (incidentType !== undefined && incidentType !== null && incidentType !== "" &&
      (typeof incidentType !== "string" || !INCIDENT_TYPES.includes(incidentType))) return null
    seen.add(id)
    items.push({ order_item_id: id, quantity, ...(typeof incidentType === "string" && incidentType ? { incident_type: incidentType } : {}) })
  }
  return items.some((item) => item.quantity > 0 || item.incident_type) ? items : null
}

/**
 * Envío BEYONIX: devolución del reclamo por retiro de un cadete (sólo Admin;
 * la base vuelve a exigir rol admin y valida cada transición):
 *   { action: "request", notes? }            -> retiro pendiente de coordinación
 *   { action: "waive", notes }               -> no requiere devolución (auditado)
 *   { action: "schedule", agreedFor, notes? }-> fecha acordada con el cliente
 *   { action: "collected", notes? }          -> el cadete tiene el producto
 *   { action: "incident", notes }            -> retiro fallido / faltantes
 *   { action: "cancel", notes }              -> sólo antes de retirar
 *   { action: "receive", items, notes?, idempotencyKey } -> recepción en BEYONIX
 * Nunca crea envíos Andreani, etiquetas ni QR, ni mueve stock vendible.
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
  const actorId = auth.user.id
  const notes = note(body.notes)

  const call = (() => {
    switch (body.action) {
      case "request":
        return auth.admin.rpc("request_order_claim_local_pickup", { p_claim_id: claimId, p_actor_id: actorId, p_note: notes || null })
      case "waive":
        if (notes.length < 10) return { invalid: "Indicá por qué el producto no vuelve (mínimo 10 caracteres)." }
        return auth.admin.rpc("waive_order_claim_local_return", { p_claim_id: claimId, p_actor_id: actorId, p_note: notes })
      case "schedule":
        if (!validDate(body.agreedFor)) return { invalid: "Elegí la fecha acordada con el cliente." }
        return auth.admin.rpc("schedule_order_claim_local_pickup", { p_claim_id: claimId, p_actor_id: actorId, p_agreed_for: body.agreedFor, p_note: notes || null })
      case "collected":
        return auth.admin.rpc("mark_order_claim_local_pickup_collected", { p_claim_id: claimId, p_actor_id: actorId, p_note: notes || null })
      case "incident":
        if (notes.length < 5) return { invalid: "Contá brevemente qué pasó (mínimo 5 caracteres)." }
        return auth.admin.rpc("report_order_claim_local_pickup_incident", { p_claim_id: claimId, p_actor_id: actorId, p_note: notes })
      case "cancel":
        if (notes.length < 10) return { invalid: "Indicá el motivo de la cancelación (mínimo 10 caracteres)." }
        return auth.admin.rpc("cancel_order_claim_local_pickup", { p_claim_id: claimId, p_actor_id: actorId, p_note: notes })
      case "receive": {
        const items = receptionItems(body.items)
        if (!items) return { invalid: "Indicá las cantidades recibidas de cada producto." }
        const key = typeof body.idempotencyKey === "string" && KEY_PATTERN.test(body.idempotencyKey) ? body.idempotencyKey : null
        if (!key) return { invalid: "La operación no tiene una clave de idempotencia válida." }
        return auth.admin.rpc("confirm_order_claim_local_pickup_reception", {
          p_claim_id: claimId, p_actor_id: actorId, p_items: items, p_note: notes || null, p_idempotency_key: key,
        })
      }
      default:
        return { invalid: "Acción inválida." }
    }
  })()
  if ("invalid" in call) return NextResponse.json({ error: call.invalid }, { status: 400 })
  const { error } = await call
  if (error) return claimErrorResponse(error)
  return getClaimResult(auth.admin, claimId)
}
