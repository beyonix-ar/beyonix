/**
 * Retiro por cadete de la devolución de un reclamo (pedidos Envío BEYONIX):
 * estados, etiquetas y acciones válidas para Admin y para el cliente. Puro:
 * las reglas reales viven en las RPCs de 20261106120000_claim_local_pickups y
 * se vuelven a validar ahí. Sin sucursales, etiquetas, QR ni Andreani.
 *
 * "Retirado" = el cadete tiene el producto; BEYONIX todavía no lo recibió.
 * "Pendiente de inspección" no es un estado del retiro: son las unidades en
 * `recibida_beyonix` (order_claim_units), que se inspeccionan con el flujo
 * existente (stock o baja).
 */

export type ClaimLocalPickupStatus =
  | "pendiente_coordinacion"
  | "coordinado"
  | "retirado"
  | "recibido_parcial"
  | "recibido"
  | "incidencia"
  | "cancelado"

/** Campos que puede recibir el cliente (nunca notas internas ni actores). */
export interface ClaimLocalPickupCustomerSource {
  id?: number
  status: ClaimLocalPickupStatus
  agreed_for?: string | null
  picked_up_at?: string | null
  received_at?: string | null
  cancelled_at?: string | null
}

/** Fila completa (sólo Admin). */
export interface ClaimLocalPickupSource extends ClaimLocalPickupCustomerSource {
  id: number
  claim_id?: number
  pickup_note?: string | null
  incident_note?: string | null
  incident_at?: string | null
  cancel_reason?: string | null
  created_at?: string | null
}

export const CUSTOMER_CLAIM_LOCAL_PICKUP_COLUMNS = "id,status,agreed_for,picked_up_at,received_at,cancelled_at"

export const CLAIM_LOCAL_PICKUP_STATUS_LABELS: Record<ClaimLocalPickupStatus, string> = {
  pendiente_coordinacion: "Pendiente de coordinación",
  coordinado: "Retiro coordinado",
  retirado: "Retirado por cadete",
  recibido_parcial: "Recibido parcialmente",
  recibido: "Recibido en BEYONIX",
  incidencia: "Incidencia de retiro o recepción",
  cancelado: "Retiro cancelado",
}

export const CLAIM_LOCAL_PICKUP_TONES: Record<ClaimLocalPickupStatus, "neutral" | "info" | "warning" | "success" | "danger"> = {
  pendiente_coordinacion: "warning",
  coordinado: "info",
  retirado: "info",
  recibido_parcial: "warning",
  recibido: "success",
  incidencia: "danger",
  cancelado: "neutral",
}

export const CLAIM_LOCAL_PICKUP_CUSTOMER_MESSAGE = "Coordinaremos con vos el retiro del producto en tu domicilio."

function rowsOf<T>(value: T | T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : value ? [value] : []
}

/** Retiro vigente (no cancelado), el más reciente. */
export function pickActiveLocalPickup<T extends ClaimLocalPickupCustomerSource>(value: T | T[] | null | undefined): T | null {
  return [...rowsOf(value)].filter((row) => row.status !== "cancelado")
    .sort((left, right) => Number(right.id ?? 0) - Number(left.id ?? 0))[0] ?? null
}

/** Fecha acordada (YYYY-MM-DD) en formato argentino, sin hora (nunca se promete un horario). */
export function formatLocalPickupDate(value: string | null | undefined) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value ?? "")
  return match ? `${match[3]}/${match[2]}/${match[1]}` : null
}

export interface ClaimLocalPickupAdminView {
  status: ClaimLocalPickupStatus
  statusLabel: string
  tone: (typeof CLAIM_LOCAL_PICKUP_TONES)[ClaimLocalPickupStatus]
  agreedFor: string | null
  incident: string | null
  /** El cadete ya retiró el producto (puede seguir sin llegar a BEYONIX). */
  collected: boolean
  /** Coordinar o reprogramar la fecha acordada (antes de que el cadete lo retire). */
  canSchedule: boolean
  canMarkCollected: boolean
  /** Confirmar lo que el cadete entregó en BEYONIX (también lo que faltaba). */
  canReceive: boolean
  canReportIncident: boolean
  /** Sólo antes de que el cadete lo retire. */
  canCancel: boolean
  /** Unidades que todavía deben llegar (originales con el cliente o el cadete). */
  pendingUnits: number
}

export function getClaimLocalPickupAdminView(
  pickup: ClaimLocalPickupSource | null,
  units: ReadonlyArray<{ role: string; location: string; shipment_id?: number | null }>,
  { closed = false, received = false }: { closed?: boolean; received?: boolean } = {},
): ClaimLocalPickupAdminView | null {
  if (!pickup || pickup.status === "cancelado") return null
  const pendingUnits = units.filter((unit) => unit.role === "original" && unit.location === "con_cliente" && !unit.shipment_id).length
  const collected = Boolean(pickup.picked_up_at)
  const open = !closed
  return {
    status: pickup.status,
    statusLabel: CLAIM_LOCAL_PICKUP_STATUS_LABELS[pickup.status],
    tone: CLAIM_LOCAL_PICKUP_TONES[pickup.status],
    agreedFor: formatLocalPickupDate(pickup.agreed_for),
    incident: pickup.status === "incidencia" ? pickup.incident_note?.trim() || "Incidencia registrada" : null,
    collected,
    canSchedule: open && !collected && ["pendiente_coordinacion", "coordinado", "incidencia"].includes(pickup.status),
    canMarkCollected: open && !collected && ["pendiente_coordinacion", "coordinado", "incidencia"].includes(pickup.status),
    canReceive: open && collected && pendingUnits > 0 && ["retirado", "recibido_parcial", "incidencia"].includes(pickup.status),
    canReportIncident: open && ["pendiente_coordinacion", "coordinado", "retirado", "recibido_parcial"].includes(pickup.status),
    canCancel: open && !collected && !received && pickup.status !== "recibido",
    pendingUnits,
  }
}

/**
 * Frase para el cliente: simple, sin detalles internos ni horarios. La fecha
 * sólo aparece cuando ya se acordó con él.
 */
export function getCustomerLocalPickupView(source: ClaimLocalPickupCustomerSource | null | undefined) {
  if (!source || source.status === "cancelado") return null
  const date = formatLocalPickupDate(source.agreed_for)
  switch (source.status) {
    case "pendiente_coordinacion":
    case "incidencia":
      return { title: "Retiro en tu domicilio", statusLabel: "Coordinando el retiro", instructions: [CLAIM_LOCAL_PICKUP_CUSTOMER_MESSAGE] }
    case "coordinado":
      return {
        title: "Retiro en tu domicilio",
        statusLabel: date ? `Retiro coordinado para el ${date}` : "Retiro coordinado",
        instructions: ["Tené el producto listo, completo y embalado con sus accesorios. Si necesitás cambiar el día, escribinos por este medio."],
      }
    case "retirado":
      return { title: "Retiro en tu domicilio", statusLabel: "Producto retirado", instructions: ["Retiramos el producto. Te avisamos por este medio cuando llegue a BEYONIX."] }
    case "recibido_parcial":
    case "recibido":
      return { title: "Retiro en tu domicilio", statusLabel: "Recibido en BEYONIX", instructions: ["Recibimos tu producto. Lo vamos a revisar y te avisamos por este medio cómo sigue."] }
  }
}

export function getCustomerLocalPickupHeadline(source: ClaimLocalPickupCustomerSource | null | undefined) {
  if (!source || source.status === "cancelado") return null
  if (source.status === "pendiente_coordinacion" || source.status === "incidencia") return "Coordinaremos el retiro de tu producto"
  if (source.status === "coordinado") return "Retiro de tu producto coordinado"
  if (source.status === "retirado") return "Retiramos tu producto"
  return null
}
