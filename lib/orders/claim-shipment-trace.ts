import type { SupabaseOrderClaim, SupabasePedido } from "../supabase/types.ts"

/** Estados que un super admin puede forzar en el reenvío (force_order_claim_shipment_status). */
export const CLAIM_FORCEABLE_STATUSES = ["en_transito", "en_sucursal", "entregada", "cancelada"] as const
export type ClaimForceableStatus = (typeof CLAIM_FORCEABLE_STATUSES)[number]

/** Quién fija hoy el estado operativo del tramo. */
export type ClaimShipmentOverride = "qa" | "forced" | null

export interface ClaimShipmentTraceRow {
  key: string
  shipmentId: number | null
  title: string
  number: string | null
  tracking: string | null
  /** Estado operativo en BEYONIX. */
  status: string
  date: string | null
  environment: "QA" | "PROD" | null
  /** Simulación QA (compatibilidad: equivale a override === "qa"). */
  simulated: boolean
  override: ClaimShipmentOverride
  overrideNote: string | null
  canSimulate: boolean
  /** Reenvío con estado operativo forzable por un super admin. */
  canForce: boolean
  forceOptions: ClaimForceableStatus[]
  currentStatus: string | null
  /** Último estado informado por Andreani (nunca se modifica desde BEYONIX). */
  realStatus: string | null
}

export interface ClaimJourneyEvent { key: string; label: string; at: string }

export const CLAIM_SHIPMENT_STATUS_LABELS: Record<string, string> = {
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

const RANK: Record<string, number> = { pendiente: 0, generada: 1, en_transito: 2, en_sucursal: 3, entregada: 4 }

type ClaimShipment = NonNullable<SupabaseOrderClaim["order_claim_shipments"]>[number]

export function getClaimShipmentOverride(leg: Pick<ClaimShipment, "manual_status_override" | "manual_status_override_kind">): ClaimShipmentOverride {
  if (!leg.manual_status_override) return null
  return leg.manual_status_override_kind === "admin_override" ? "forced" : "qa"
}

/**
 * Estados a los que se puede forzar el reenvío: sólo hacia adelante y, para
 * cancelar, sólo mientras el envío todavía no salió (la base lo repite).
 */
export function getClaimForceOptions(leg: Pick<ClaimShipment, "direction" | "status" | "creation_status" | "closed_at" | "review_required">): ClaimForceableStatus[] {
  if (leg.direction !== "reemplazo" || leg.creation_status !== "created" || leg.closed_at ||
    leg.status === "cancelada" || leg.review_required) return []
  const current = RANK[leg.status] ?? -1
  return CLAIM_FORCEABLE_STATUSES.filter((status) =>
    status === "cancelada" ? leg.status === "generada" : RANK[status] > current)
}

/** Qué dispara en BEYONIX forzar cada estado del reenvío (para advertir antes de confirmar). */
export function getClaimForceEffects(status: ClaimForceableStatus): string[] {
  switch (status) {
    case "en_transito":
    case "en_sucursal":
      return [
        "El producto de reemplazo reservado pasa a figurar en manos de Andreani.",
        "El seguimiento automático deja de mover este envío: el estado lo controla BEYONIX hasta que lo vuelvas a forzar.",
      ]
    case "entregada":
      return [
        "Marca el producto de reemplazo como entregado al cliente. No se puede deshacer.",
        "Avisa al cliente por el chat del reclamo y cierra este envío.",
        "Puede habilitar el siguiente paso y la finalización del reclamo.",
      ]
    case "cancelada":
      return [
        "Cancela el envío en BEYONIX; la reserva del reemplazo queda para un nuevo envío.",
        "No cancela nada en Andreani: si la etiqueta ya existe, anulala también allí.",
      ]
  }
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
    override: null,
    overrideNote: null,
    canSimulate: false,
    canForce: false,
    forceOptions: [],
    currentStatus: null,
    realStatus: null,
  }
  const legs = [...(claim.order_claim_shipments ?? [])].sort((a, b) => a.id - b.id).map((leg): ClaimShipmentTraceRow => {
    const override = getClaimShipmentOverride(leg)
    const forceOptions = getClaimForceOptions(leg)
    return {
      key: `claim-${leg.id}`,
      shipmentId: leg.id,
      title: `${TITLE[leg.direction] ?? leg.direction}${(leg.attempt ?? 1) > 1 ? ` · intento ${leg.attempt}` : ""}`,
      number: leg.andreani_envio_id ?? null,
      tracking: leg.andreani_tracking ?? null,
      status: CLAIM_SHIPMENT_STATUS_LABELS[leg.status] ?? leg.status,
      date: leg.delivered_at || leg.created_at || leg.creation_started_at || null,
      environment: leg.environment ?? null,
      simulated: override === "qa",
      override,
      overrideNote: override ? leg.manual_status_override_note ?? null : null,
      canSimulate: leg.environment === "QA" && leg.creation_status === "created" && !leg.closed_at && leg.status !== "cancelada",
      canForce: forceOptions.length > 0,
      forceOptions,
      currentStatus: leg.status,
      realStatus: leg.andreani_estado ?? null,
    }
  })
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
    const override = getClaimShipmentOverride(leg)
    const suffix = override === "qa" ? " (simulada QA)" : override === "forced" ? " (forzado por BEYONIX)" : ""
    if (leg.creation_status === "created") add(`leg-${leg.id}-created`, created, leg.creation_started_at || leg.created_at)
    add(`leg-${leg.id}-delivered`, `${delivered}${suffix}`, leg.delivered_at)
  }
  const originalUnits = claim.order_claim_units ?? []
  const received = originalUnits.filter((unit) => unit.role === "original" && unit.location === "recibida_beyonix")
  const inspected = originalUnits.filter((unit) => unit.role === "original" && ["reincorporada_stock", "baja"].includes(unit.location))
  if (received.length) add("return-received", "Producto recibido en BEYONIX", received[0].updated_at)
  if (inspected.length) add("return-inspected", "Producto inspeccionado", inspected[0].updated_at)
  add("claim-closed", "Reclamo finalizado", claim.closed_at)
  return events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
}
