import { NextResponse } from "next/server"

import { requireAdmin } from "@/app/api/admin/clientes/_auth"
import { PAYMENT_INCIDENT_RESOLUTIONS, type PaymentIncidentResolution } from "@/lib/orders/payment-incidents"

const ERRORS: Record<string, { status: number; message: string }> = {
  INCIDENT_RESOLUTION_FORBIDDEN: { status: 403, message: "No tenés permisos para resolver incidentes de pago." },
  INCIDENT_NOT_FOUND: { status: 404, message: "El incidente ya no existe." },
  NOT_A_PAYMENT_INCIDENT: { status: 409, message: "Este evento no es un incidente de pago." },
  INCIDENT_RESOLUTION_NOTE_REQUIRED: { status: 400, message: "Explicá brevemente por qué lo marcás así." },
}

/** Marca un incidente de pago como falso positivo o resuelto. El evento original no se toca. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; eventId: string }> },
) {
  const auth = await requireAdmin(request)
  if ("error" in auth) return auth.error

  const { id, eventId } = await params
  const orderId = Number(id)
  const auditEventId = Number(eventId)
  if (!Number.isInteger(orderId) || orderId <= 0 || !Number.isInteger(auditEventId) || auditEventId <= 0) {
    return NextResponse.json({ error: "Incidente inválido." }, { status: 400 })
  }

  let body: { resolution?: unknown; note?: unknown }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return NextResponse.json({ error: "Indicá la resolución del incidente." }, { status: 400 })
  }
  const resolution = (PAYMENT_INCIDENT_RESOLUTIONS as readonly unknown[]).includes(body.resolution)
    ? (body.resolution as PaymentIncidentResolution)
    : null
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 500) : ""
  if (!resolution) return NextResponse.json({ error: "Indicá la resolución del incidente." }, { status: 400 })
  if (note.length < 3) return NextResponse.json({ error: ERRORS.INCIDENT_RESOLUTION_NOTE_REQUIRED.message }, { status: 400 })

  // El incidente tiene que pertenecer a ESTE pedido: nunca se resuelve un
  // evento de otro pedido por un id cambiado en la URL.
  const { data: event, error: eventError } = await auth.admin
    .from("order_audit_events")
    .select("id, order_id")
    .eq("id", auditEventId)
    .maybeSingle()
  if (eventError) {
    console.error("AUDIT_INCIDENT_LOOKUP_ERROR", { orderId, auditEventId, message: eventError.message })
    return NextResponse.json({ error: "No se pudo consultar el incidente." }, { status: 500 })
  }
  if (!event || Number(event.order_id) !== orderId) {
    return NextResponse.json({ error: ERRORS.INCIDENT_NOT_FOUND.message }, { status: 404 })
  }

  const { data, error } = await auth.admin.rpc("resolve_order_audit_incident", {
    p_audit_event_id: auditEventId,
    p_resolution: resolution,
    p_note: note,
    p_actor: auth.user.id,
  })
  if (error) {
    console.error("AUDIT_INCIDENT_RESOLVE_ERROR", { orderId, auditEventId, message: error.message })
    const known = Object.entries(ERRORS).find(([code]) => error.message?.includes(code))?.[1]
    return NextResponse.json(
      { error: known?.message ?? "No se pudo registrar la resolución del incidente." },
      { status: known?.status ?? 500 },
    )
  }
  return NextResponse.json({ resolution: data })
}
