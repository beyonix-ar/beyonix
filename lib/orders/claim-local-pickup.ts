/**
 * Retiro por cadete de la devolución de un reclamo (pedidos Envío BEYONIX):
 * estados, etiquetas y acciones válidas para Admin y para el cliente. Puro:
 * las reglas reales viven en las RPCs de 20261106120000_claim_local_pickups y
 * se vuelven a validar ahí. Sin sucursales, etiquetas, QR ni Andreani.
 *
 * "Retirado" = el cadete tiene el producto; BEYONIX todavía no lo recibió.
 * "Recepción parcial" = llegó una parte; el resto todavía puede llegar.
 * "Pérdida confirmada en traslado" = decisión administrativa explícita sobre
 * unidades retiradas que nunca llegarán (order_claim_units 'perdida_traslado'):
 * no es una recepción ni una inspección y nunca vuelve a stock.
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
  | "resuelto_con_perdida"
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
  loss_confirmed_at?: string | null
  created_at?: string | null
}

export const CUSTOMER_CLAIM_LOCAL_PICKUP_COLUMNS = "id,status,agreed_for,picked_up_at,received_at,cancelled_at"

export const CLAIM_LOCAL_PICKUP_STATUS_LABELS: Record<ClaimLocalPickupStatus, string> = {
  pendiente_coordinacion: "Pendiente de coordinación",
  coordinado: "Retiro coordinado",
  retirado: "Retirado por cadete",
  recibido_parcial: "Recepción parcial",
  recibido: "Recibido en BEYONIX",
  resuelto_con_perdida: "Pérdida confirmada en traslado",
  incidencia: "Incidencia de retiro o traslado",
  cancelado: "Retiro cancelado",
}

export const CLAIM_LOCAL_PICKUP_TONES: Record<ClaimLocalPickupStatus, "neutral" | "info" | "warning" | "success" | "danger"> = {
  pendiente_coordinacion: "warning",
  coordinado: "info",
  retirado: "info",
  recibido_parcial: "warning",
  recibido: "success",
  resuelto_con_perdida: "warning",
  incidencia: "danger",
  cancelado: "neutral",
}

/** Novedades sobre unidades RECIBIDAS (lo que no llegó queda pendiente, nunca como novedad de otra unidad). */
export const CLAIM_LOCAL_RECEPTION_INCIDENT_TYPES = ["producto_distinto", "faltantes_accesorios", "paquete_vacio", "dano_estado", "otro"] as const
export type ClaimLocalReceptionIncidentType = (typeof CLAIM_LOCAL_RECEPTION_INCIDENT_TYPES)[number]

/** Mínimo del motivo de una pérdida confirmada en traslado (igual que la base). */
export const CLAIM_LOCAL_LOSS_NOTE_MIN = 10

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
  /** Después del retiro: confirmar que unidades pendientes nunca llegarán (excepción auditada). */
  canConfirmLoss: boolean
  /** Unidades que todavía deben llegar (originales con el cliente o el cadete). */
  pendingUnits: number
  /** Unidades con pérdida confirmada en traslado (nunca recibidas ni inspeccionadas). */
  lostUnits: number
}

export function getClaimLocalPickupAdminView(
  pickup: ClaimLocalPickupSource | null,
  units: ReadonlyArray<{ role: string; location: string; shipment_id?: number | null }>,
  { closed = false, received = false }: { closed?: boolean; received?: boolean } = {},
): ClaimLocalPickupAdminView | null {
  if (!pickup || pickup.status === "cancelado") return null
  const originals = units.filter((unit) => unit.role === "original")
  const pendingUnits = originals.filter((unit) => unit.location === "con_cliente" && !unit.shipment_id).length
  const lostUnits = originals.filter((unit) => unit.location === "perdida_traslado").length
  const collected = Boolean(pickup.picked_up_at)
  const open = !closed
  const afterCollection = open && collected && pendingUnits > 0 && ["retirado", "recibido_parcial", "incidencia"].includes(pickup.status)
  return {
    status: pickup.status,
    statusLabel: pickup.status === "incidencia"
      ? collected ? "Incidencia durante el traslado" : "Retiro con inconveniente"
      : CLAIM_LOCAL_PICKUP_STATUS_LABELS[pickup.status],
    tone: CLAIM_LOCAL_PICKUP_TONES[pickup.status],
    agreedFor: formatLocalPickupDate(pickup.agreed_for),
    incident: pickup.status === "incidencia" ? pickup.incident_note?.trim() || "Incidencia registrada" : null,
    collected,
    canSchedule: open && !collected && ["pendiente_coordinacion", "coordinado", "incidencia"].includes(pickup.status),
    canMarkCollected: open && !collected && ["pendiente_coordinacion", "coordinado", "incidencia"].includes(pickup.status),
    canReceive: afterCollection,
    canReportIncident: open && ["pendiente_coordinacion", "coordinado", "retirado", "recibido_parcial"].includes(pickup.status),
    canCancel: open && !collected && !received && pickup.status !== "recibido",
    canConfirmLoss: afterCollection,
    pendingUnits,
    lostUnits,
  }
}

const PICKUP_TITLE = "Retiro en tu domicilio"
const LOSS_FOLLOW_UP = "No tenés que hacer nada: ya lo estamos resolviendo y te avisamos por este medio cómo sigue."

/**
 * Frase para el cliente: simple, verdadera y sin detalles internos ni
 * horarios. La fecha sólo aparece cuando ya se acordó con él. Nunca dice
 * "recibido" de algo que no llegó (recepción parcial o pérdida en traslado).
 */
export function getCustomerLocalPickupView(source: ClaimLocalPickupCustomerSource | null | undefined) {
  if (!source || source.status === "cancelado") return null
  const date = formatLocalPickupDate(source.agreed_for)
  switch (source.status) {
    case "pendiente_coordinacion":
      return { title: PICKUP_TITLE, statusLabel: "Pendiente de coordinación", instructions: [CLAIM_LOCAL_PICKUP_CUSTOMER_MESSAGE] }
    case "incidencia":
      return source.picked_up_at
        ? { title: PICKUP_TITLE, statusLabel: "Incidencia durante el traslado", instructions: ["Hubo un inconveniente durante el traslado de tu producto. Lo estamos revisando y te avisamos por este medio cómo sigue."] }
        : { title: PICKUP_TITLE, statusLabel: "Retiro con inconveniente", instructions: ["No pudimos retirar el producto. Te vamos a escribir por este medio para coordinar nuevamente."] }
    case "coordinado":
      return {
        title: PICKUP_TITLE,
        statusLabel: date ? `Retiro coordinado para el ${date}` : "Retiro coordinado",
        instructions: ["Tené el producto listo, completo y embalado con sus accesorios. Si necesitás cambiar el día, escribinos por este medio."],
      }
    case "retirado":
      return { title: PICKUP_TITLE, statusLabel: "Producto retirado", instructions: ["Retiramos el producto. Te avisamos por este medio cuando llegue a BEYONIX."] }
    case "recibido_parcial":
      return { title: PICKUP_TITLE, statusLabel: "Recepción parcial", instructions: ["Recibimos parte de tu devolución. Te avisamos por este medio cuando llegue el resto."] }
    case "recibido":
      return { title: PICKUP_TITLE, statusLabel: "Recibido en BEYONIX", instructions: ["Recibimos tu producto. Lo vamos a revisar y te avisamos por este medio cómo sigue."] }
    case "resuelto_con_perdida":
      return {
        title: PICKUP_TITLE,
        statusLabel: "Incidencia durante el traslado",
        instructions: [source.received_at
          ? `Recibimos parte de tu devolución y hubo un inconveniente durante el traslado del resto. ${LOSS_FOLLOW_UP}`
          : `Hubo un inconveniente durante el traslado de tu producto. ${LOSS_FOLLOW_UP}`],
      }
  }
}

export function getCustomerLocalPickupHeadline(source: ClaimLocalPickupCustomerSource | null | undefined) {
  if (!source || source.status === "cancelado") return null
  if (source.status === "pendiente_coordinacion") return "Coordinaremos el retiro de tu producto"
  if (source.status === "incidencia") return source.picked_up_at ? "Incidencia durante el traslado" : "Retiro con inconveniente"
  if (source.status === "coordinado") return "Retiro de tu producto coordinado"
  if (source.status === "retirado") return "Retiramos tu producto"
  if (source.status === "recibido_parcial") return "Recibimos parte de tu devolución"
  if (source.status === "resuelto_con_perdida") return "Resolución en proceso"
  return null
}
