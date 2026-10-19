import type { SupabaseOrderClaim, SupabasePedido } from "../supabase/types.ts"

export interface ClaimShipmentTraceRow {
  key: string
  shipmentId: number | null
  title: string
  number: string | null
  tracking: string | null
  status: string
  date: string | null
  environment: "QA" | "PROD" | null
  simulated: boolean
  canSimulate: boolean
  currentStatus: string | null
  realStatus: string | null
}

export interface ClaimJourneyEvent { key: string; label: string; at: string }

const STATUS: Record<string, string> = {
  pendiente: "Pendiente",
  generada: "Creado",
  en_transito: "En tránsito",
  en_sucursal: "En sucursal",
  entregada: "Entregado",
  cancelada: "Cancelado",
}

const TITLE: Record<string, string> = {
  devolucion: "Devolución",
  cambio: "Cambio en sucursal",
  reemplazo: "Reemplazo / reenvío",
}

/** El pedido y cada tramo de postventa conservan identidad y tracking propios. */
export function buildClaimShipmentTrace(order: SupabasePedido, claim: SupabaseOrderClaim): ClaimShipmentTraceRow[] {
  const original: ClaimShipmentTraceRow = {
    key: `order-${order.id}`,
    shipmentId: null,
    title: "Envío original",
    number: order.andreani_envio_id ?? null,
    tracking: order.andreani_tracking || order.tracking_number || null,
    status: order.andreani_estado || (order.delivered_at ? "Entregado" : order.estado || "Sin generar"),
    date: order.delivered_at || order.andreani_created_at || order.created_at || null,
    environment: order.andreani_creation_environment ?? null,
    simulated: false,
    canSimulate: false,
    currentStatus: null,
    realStatus: null,
  }
  const legs = [...(claim.order_claim_shipments ?? [])].sort((a, b) => a.id - b.id).map((leg) => ({
    key: `claim-${leg.id}`,
    shipmentId: leg.id,
    title: `${TITLE[leg.direction] ?? leg.direction}${(leg.attempt ?? 1) > 1 ? ` · intento ${leg.attempt}` : ""}`,
    number: leg.andreani_envio_id ?? null,
    tracking: leg.andreani_tracking ?? null,
    status: STATUS[leg.status] ?? leg.status,
    date: leg.delivered_at || leg.created_at || leg.creation_started_at || null,
    environment: leg.environment ?? null,
    simulated: Boolean(leg.manual_status_override),
    canSimulate: leg.environment === "QA" && leg.creation_status === "created" && !leg.closed_at && leg.status !== "cancelada",
    currentStatus: leg.status,
    realStatus: leg.andreani_estado ?? null,
  }))
  return [original, ...legs]
}

export function buildClaimJourney(order: SupabasePedido, claim: SupabaseOrderClaim): ClaimJourneyEvent[] {
  const events: ClaimJourneyEvent[] = []
  const add = (key: string, label: string, at: string | null | undefined) => {
    if (at && Number.isFinite(Date.parse(at))) events.push({ key, label, at })
  }
  add("original-sent", "Pedido enviado", order.andreani_created_at)
  add("original-delivered", "Pedido entregado", order.delivered_at)
  add("claim-opened", "Reclamo abierto", claim.created_at)
  for (const leg of claim.order_claim_shipments ?? []) {
    const created = leg.direction === "devolucion" ? "Devolución creada" : leg.direction === "cambio" ? "Cambio en sucursal creado" : "Reenvío creado"
    const delivered = leg.direction === "devolucion" ? "Devolución entregada a BEYONIX" : leg.direction === "cambio" ? "Cambio completado" : "Reemplazo entregado al cliente"
    if (leg.creation_status === "created") add(`leg-${leg.id}-created`, created, leg.creation_started_at || leg.created_at)
    add(`leg-${leg.id}-delivered`, `${delivered}${leg.manual_status_override ? " (simulada QA)" : ""}`, leg.delivered_at)
  }
  const originalUnits = claim.order_claim_units ?? []
  const received = originalUnits.filter((unit) => unit.role === "original" && unit.location === "recibida_beyonix")
  const inspected = originalUnits.filter((unit) => unit.role === "original" && ["reincorporada_stock", "baja"].includes(unit.location))
  if (received.length) add("return-received", "Producto recibido en BEYONIX", received[0].updated_at)
  if (inspected.length) add("return-inspected", "Producto inspeccionado", inspected[0].updated_at)
  add("claim-closed", "Reclamo finalizado", claim.closed_at)
  return events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
}
