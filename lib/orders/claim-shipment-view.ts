/**
 * Logística de postventa de un reclamo (order_claim_shipments +
 * order_claim_units) para el cliente y para Admin. Pura: sólo deriva
 * presentación y acciones válidas; las reglas reales viven en las RPCs de
 * 20260928100000 y se vuelven a validar ahí. Toda la postventa es por
 * sucursal Andreani. El cliente nunca recibe costo, contrato, ambiente,
 * identificadores internos, errores técnicos ni la decisión interna del método.
 */

import {
  RETURNABLE_CLAIM_RESOLUTIONS,
  getClaimOperationalResolution,
  getClaimRequirements,
  getClaimResolutionLines,
  isMixedClaimResolution,
  type ClaimResolutionLinesSource,
} from "./claim-policy.ts"

export type ClaimShipmentDirection = "devolucion" | "cambio" | "reemplazo"
export type ClaimShipmentStatus = "pendiente" | "generada" | "en_transito" | "en_sucursal" | "entregada" | "cancelada"
export type ClaimShipmentModality = "despacho_sucursal" | "cambio_sucursal" | "entrega_sucursal"
export type ClaimShipmentCreationStatus = "not_started" | "processing" | "created" | "failed" | "manual_review"
export type ClaimExchangeOutcome = "completado" | "no_completado"
export type ClaimUnitRole = "original" | "reemplazo"
export type ClaimUnitLocation =
  | "con_cliente"
  | "en_andreani"
  | "recibida_beyonix"
  | "reincorporada_stock"
  | "baja"
  | "conservada_cliente"
  | "reservada"
  | "entregada_cliente"
export type ClaimIncidentType =
  | "producto_distinto"
  | "cantidad_incorrecta"
  | "faltantes_accesorios"
  | "paquete_vacio"
  | "dano_estado"
  | "otro"

/** Campos que puede recibir el cliente. */
export interface ClaimShipmentCustomerSource {
  id?: number
  direction: ClaimShipmentDirection
  attempt?: number | null
  status: ClaimShipmentStatus
  modality?: ClaimShipmentModality | null
  branch_name?: string | null
  branch_address?: string | null
  andreani_tracking?: string | null
  exchange_outcome?: ClaimExchangeOutcome | null
  incident_open?: boolean | null
  /** Fecha real informada por Andreani (nunca un vencimiento calculado). */
  branch_custody_since?: string | null
  delivered_at?: string | null
  closed_at?: string | null
  manual_status_override?: ClaimShipmentStatus | null
  /** Simulación QA o estado forzado por un super admin (20261020120000). */
  manual_status_override_kind?: "qa_simulation" | "admin_override" | null
}

/** Fila completa (sólo Admin). */
export interface ClaimShipmentAdminSource extends ClaimShipmentCustomerSource {
  id: number
  branch_id?: string | null
  creation_status?: ClaimShipmentCreationStatus | null
  creation_error?: string | null
  cost_amount?: number | string | null
  andreani_estado?: string | null
  andreani_last_event?: string | null
  incident_event?: string | null
  review_required?: boolean | null
  review_event?: string | null
  legacy?: boolean | null
  creation_started_at?: string | null
}

export interface ClaimUnitSource {
  id: number
  updated_at?: string | null
  order_item_id: number
  role: ClaimUnitRole
  location: ClaimUnitLocation
  shipment_id?: number | null
  incident_open?: boolean | null
  incident_type?: ClaimIncidentType | null
  incident_note?: string | null
}

/** Columnas del embed seguro para el cliente (API de Mis compras). */
export const CUSTOMER_CLAIM_SHIPMENT_COLUMNS =
  "id,direction,attempt,status,modality,branch_name,branch_address,andreani_tracking,exchange_outcome,incident_open,branch_custody_since,delivered_at,closed_at,manual_status_override,manual_status_override_kind"

export const CLAIM_RETURN_PACKING_INSTRUCTIONS =
  "Prepará el producto completo, con caja, bolsas, manuales, accesorios y todos los elementos recibidos, correctamente embalado y en el mejor estado posible."

/**
 * Devolución: nunca una sucursal fija ni la dirección de BEYONIX. Mismo texto
 * que el mensaje del reclamo (20261001170000_claim_return_dropoff_copy.sql).
 */
export const CLAIM_RETURN_DROPOFF_INSTRUCTIONS =
  "Cuando tengas el paquete listo, acercalo a una sucursal Andreani habilitada con la etiqueta de devolución. Al escanearla, Andreani identificará automáticamente los datos del envío y su destino."

export const CLAIM_INCIDENT_LABELS: Record<ClaimIncidentType, string> = {
  producto_distinto: "Producto distinto",
  cantidad_incorrecta: "Cantidad incorrecta",
  faltantes_accesorios: "Faltantes / accesorios",
  paquete_vacio: "Paquete vacío",
  dano_estado: "Daño / estado",
  otro: "Otra novedad",
}

const LEG_TITLES: Record<ClaimShipmentDirection, string> = {
  cambio: "Cambio en sucursal Andreani",
  devolucion: "Devolución por sucursal Andreani",
  reemplazo: "Envío del reemplazo a sucursal Andreani",
}

const CUSTOMER_STATUS_LABELS: Record<ClaimShipmentDirection, Record<ClaimShipmentStatus, string>> = {
  cambio: {
    pendiente: "Preparando el cambio",
    generada: "Cambio generado",
    en_transito: "Producto nuevo en camino a la sucursal",
    en_sucursal: "Disponible temporalmente en sucursal Andreani",
    entregada: "Cambio completado",
    cancelada: "Cambio cancelado",
  },
  devolucion: {
    pendiente: "Preparando la devolución",
    generada: "Devolución generada",
    en_transito: "En tránsito hacia BEYONIX",
    en_sucursal: "En tránsito hacia BEYONIX",
    entregada: "Entregado en BEYONIX",
    cancelada: "Devolución cancelada",
  },
  reemplazo: {
    pendiente: "Preparando el envío del reemplazo",
    generada: "Reemplazo despachado",
    en_transito: "Reemplazo en camino a la sucursal",
    en_sucursal: "Reemplazo disponible en la sucursal",
    entregada: "Reemplazo retirado",
    cancelada: "Envío cancelado",
  },
}

const ADMIN_STATUS_LABELS: Record<ClaimShipmentStatus, string> = {
  pendiente: "Pendiente de generar",
  generada: "Generada (preparada por BEYONIX)",
  en_transito: "En tránsito",
  en_sucursal: "En sucursal Andreani",
  entregada: "Entregada según Andreani",
  cancelada: "Cancelada",
}

const ADMIN_MODALITY_LABELS: Record<ClaimShipmentModality, string> = {
  cambio_sucursal: "CAMBIO sucursal",
  despacho_sucursal: "RETIRO sucursal (el cliente despacha)",
  entrega_sucursal: "VENTA sucursal (reenvío)",
}

export const CLAIM_UNIT_LOCATION_LABELS: Record<ClaimUnitLocation, string> = {
  con_cliente: "Con el cliente",
  en_andreani: "En Andreani",
  recibida_beyonix: "En BEYONIX, pendiente de inspección",
  reincorporada_stock: "Reincorporada a stock",
  baja: "Dada de baja",
  conservada_cliente: "Conservada por el cliente",
  reservada: "Reservada en BEYONIX (fuera de stock vendible)",
  entregada_cliente: "Entregada al cliente",
}

function text(value: string | null | undefined) {
  return typeof value === "string" ? value.trim() : ""
}

function rowsOf<T>(value: T | T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : value ? [value] : []
}

export function formatClaimDate(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? null
    : date.toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "America/Argentina/Buenos_Aires" })
}

function branchLabel(source:Pick<ClaimShipmentCustomerSource, "branch_name" | "branch_address">) {
  return [text(source.branch_name), text(source.branch_address)].filter(Boolean).join(" · ") || null
}

/** Tramo vigente: el abierto; si no hay, el último intento (nunca uno cancelado). */
export function pickCurrentClaimShipment<T extends ClaimShipmentCustomerSource>(value: T | T[] | null | undefined): T | null {
  const rows = rowsOf(value).filter((row) => row.status !== "cancelada")
  const open = rows.find((row) => !row.closed_at)
  if (open) return open
  return [...rows].sort((left, right) => Number(right.id ?? 0) - Number(left.id ?? 0))[0] ?? null
}

// ── Cliente ─────────────────────────────────────────────────────────────────

export interface CustomerClaimShipmentView {
  direction: ClaimShipmentDirection
  title: string
  statusLabel: string
  branchLabel: string | null
  tracking: string | null
  instructions: string[]
  /** Etiqueta de devolución para el cliente (sólo devoluciones generadas). */
  label: boolean
}

export function getCustomerClaimShipmentView(source: ClaimShipmentCustomerSource | null | undefined): CustomerClaimShipmentView | null {
  if (!source || source.status === "cancelada") return null
  const tracking = text(source.andreani_tracking) || null
  const branch = branchLabel(source)
  const where = branch ?? "la sucursal Andreani indicada"
  const instructions: string[] = []
  let statusLabel = CUSTOMER_STATUS_LABELS[source.direction][source.status]
  // Un estado forzado por BEYONIX (super admin) no es una simulación QA.
  const forced = Boolean(source.manual_status_override) && source.manual_status_override_kind === "admin_override"
  const simulated = Boolean(source.manual_status_override) && !forced

  if (source.direction === "cambio") {
    if (source.exchange_outcome === "no_completado") {
      statusLabel = "Cambio no completado"
      instructions.push("El cambio no se completó porque no se entregó el producto original. El producto nuevo vuelve a BEYONIX; te vamos a escribir por este medio para definir cómo seguimos.")
    } else if (source.exchange_outcome === "completado" || source.status === "entregada") {
      instructions.push(simulated
        ? "Estado simulado para pruebas QA. Cuando el original llegue a BEYONIX lo revisamos."
        : "Andreani te entregó el producto nuevo y recibió el original. Cuando el original llegue a BEYONIX lo revisamos.")
    } else {
      instructions.push(CLAIM_RETURN_PACKING_INSTRUCTIONS)
      instructions.push(source.status === "pendiente"
        ? "Estamos preparando el producto nuevo. Te avisamos por este medio cuando esté en camino."
        : source.status === "en_sucursal"
          ? `Tu producto nuevo está disponible temporalmente en ${where}. Acercate con el producto original completo y embalado y tu DNI: Andreani te entrega el nuevo al recibir el original.`
          : `Cuando Andreani te avise que el producto nuevo está en ${where}, acercate con el producto original completo y embalado y tu DNI.`)
      instructions.push("Si no se entrega el producto original, Andreani no entrega el nuevo: queda en la sucursal por un tiempo limitado y después vuelve a BEYONIX.")
    }
  } else if (source.direction === "devolucion") {
    if (source.status === "entregada") {
      instructions.push(simulated
        ? "Entrega simulada para pruebas QA. La recepción física y la inspección se registran por separado."
        : "Andreani informó la entrega en BEYONIX. Vamos a revisar el producto y te avisaremos por este medio cómo sigue.")
    } else {
      instructions.push(CLAIM_RETURN_PACKING_INSTRUCTIONS)
      instructions.push(source.status === "pendiente"
        ? "Estamos generando la devolución con Andreani. Te vamos a avisar por este medio cómo enviarlo."
        : "Descargá e imprimí la etiqueta de devolución y pegala en el paquete cerrado.")
      if (source.status !== "pendiente") instructions.push(CLAIM_RETURN_DROPOFF_INSTRUCTIONS)
    }
  } else if (source.status === "pendiente") {
    instructions.push("Estamos preparando el envío de tu producto de reemplazo.")
  } else if (source.status === "entregada") {
    instructions.push(simulated
      ? "Entrega simulada para pruebas QA."
      : forced
        ? "Registramos la entrega de tu producto de reemplazo."
        : "Andreani informó que retiraste tu producto de reemplazo.")
  } else {
    instructions.push(`Retiralo en ${where} cuando Andreani te avise que está disponible. Llevá tu DNI.`)
  }
  if (source.incident_open && source.status !== "entregada") {
    instructions.push("Andreani informó una novedad con el envío. Si necesitás ayuda, escribinos por este medio.")
  }
  // Sólo la fecha real informada por Andreani; ningún vencimiento calculado.
  const custodyDate = source.status === "en_sucursal" && source.branch_custody_since
    ? formatClaimDate(source.branch_custody_since)
    : null
  if (custodyDate) statusLabel = `${statusLabel} desde el ${custodyDate}`
  if (simulated) statusLabel = `${statusLabel} · Simulación QA`

  return {
    direction: source.direction,
    title: LEG_TITLES[source.direction],
    statusLabel,
    // En una devolución la sucursal no es un destino para el cliente: la
    // etiqueta define el envío y el destino (ver CLAIM_RETURN_DROPOFF_INSTRUCTIONS).
    branchLabel: source.direction === "devolucion" ? null : branch,
    tracking,
    instructions,
    label: source.direction === "devolucion" && source.status !== "pendiente" && source.status !== "entregada",
  }
}

/**
 * Estado del reclamo para el cliente en una frase ("Tu reemplazo está en
 * camino"): solución comercial + tramo vigente. Sin contratos, IDs ni estados
 * crudos de Andreani, y sin conceptos fiscales.
 */
export function getCustomerClaimHeadline(claim: {
  status: string
  resolution?: string | null
  cancelled_at?: string | null
  order_claim_shipments?: ClaimShipmentCustomerSource[] | ClaimShipmentCustomerSource | null
  affected_items?: ClaimResolutionLinesSource["affected_items"]
  order_claim_item_resolutions?: ClaimResolutionLinesSource["order_claim_item_resolutions"]
}): string {
  // Reclamo mixto: las frases físicas siguen su circuito (reemplazo o devolución).
  const mixed = isMixedClaimResolution(claim.resolution)
  const requirements = getClaimRequirements(getClaimOperationalResolution(claim.resolution, getClaimResolutionLines(claim)))
  const legs = rowsOf(claim.order_claim_shipments).filter((row) => row.status !== "cancelada")
  const delivered = (direction: ClaimShipmentDirection) => legs.some((row) => row.direction === direction && row.status === "entregada")
  if (claim.status === "cerrado") {
    if (claim.cancelled_at) return "Reclamo cancelado"
    if (mixed) return "Reclamo resuelto"
    if (requirements?.solution === "replacement" && (delivered("reemplazo") || delivered("cambio"))) return "Tu reemplazo fue entregado"
    if (requirements?.financialAction === "refund") return "Tu reintegro fue procesado"
    if (requirements?.financialAction === "customer_credit") return "Tu saldo a favor fue acreditado"
    return "Reclamo resuelto"
  }
  if (claim.status === "rechazado") return "Reclamo rechazado"
  if (claim.status === "falta_informacion") return "Esperando tu respuesta"
  if (!requirements || ["recibido", "en_revision"].includes(claim.status)) return "Recibimos tu reclamo"

  const current = pickCurrentClaimShipment(legs)
  if (current?.direction === "devolucion" && current.status !== "entregada") {
    return current.status === "pendiente" ? "Estamos preparando tu devolución"
      : current.status === "generada" ? "Esperamos que lleves el producto a Andreani"
        : "Tu producto está en camino a BEYONIX"
  }
  if (current?.direction === "cambio") {
    if (current.exchange_outcome === "no_completado") return "El cambio no se completó"
    return current.status === "pendiente" ? "Estamos preparando tu cambio"
      : current.status === "en_sucursal" ? "Tu reemplazo te espera en la sucursal"
        : current.status === "entregada" ? "Cambio realizado" : "Tu reemplazo está en camino"
  }
  if (current?.direction === "reemplazo") {
    return current.status === "pendiente" ? "Estamos preparando tu reemplazo"
      : current.status === "en_sucursal" ? "Tu reemplazo está en la sucursal"
        : current.status === "entregada" ? "Tu reemplazo fue entregado" : "Tu reemplazo está en camino"
  }
  if (current?.direction === "devolucion") {
    return requirements.solution === "replacement" ? "Recibimos tu producto: preparando tu reemplazo" : "Recibimos tu producto"
  }
  if (mixed) return "Estamos resolviendo cada producto de tu reclamo"
  if (requirements.financialAction === "refund") return "Estamos procesando tu reintegro"
  if (requirements.financialAction === "customer_credit") return "Estamos acreditando tu saldo a favor"
  if (requirements.solution === "replacement") return "Estamos preparando tu reemplazo"
  return "Estamos resolviendo tu reclamo"
}

// ── Admin ───────────────────────────────────────────────────────────────────

/**
 * cambio_directo: CAMBIO sucursal. retiro: RETIRO sucursal (reintegro/saldo).
 * retiro_y_reenvio: retiro -> inspección -> reenvío. reenvio_sin_devolucion:
 * el cliente conserva el original (decisión auditada) y sólo viaja el reemplazo.
 */
export type ClaimLogisticsPlan = "cambio_directo" | "retiro" | "retiro_y_reenvio" | "reenvio_sin_devolucion"
/**
 * Paso operativo vigente del wizard:
 *   logistics   -> la operación Andreani del método (cambio en sucursal / retiro);
 *   reception   -> lo que vuelve a BEYONIX (llegada, inspección, incidencias);
 *   replacement -> reenvío del reemplazo (retiro + revisión + reenvío);
 *   execution   -> reintegro / aplicación (retiro por sucursal de un reintegro);
 *   finish      -> logística resuelta: sólo falta finalizar.
 */
export type ClaimLogisticsWizardStep = "logistics" | "reception" | "replacement" | "execution" | "finish"

export type ClaimUnitAction =
  | "arrival_original"
  | "arrival_replacement"
  | "inspect_replacement"
  | "release_reservation"
  | "deliver_manual"
  | "waive_original"
  | "incident_open"
  | "incident_resolve"

export interface ClaimUnitActionOption {
  action: ClaimUnitAction
  orderItemId: number
  role: ClaimUnitRole
  max: number
  label: string
  /** Mínimo de caracteres del motivo (0 = opcional). */
  noteMin: number
}

export type ClaimLogisticsMethod = "cambio" | "devolucion" | "sin_devolucion"

export interface ClaimLogisticsMethodOption {
  direction: ClaimLogisticsMethod
  label: string
  description: string
}

export interface ClaimLogisticsMethodChoice extends ClaimLogisticsMethodOption {
  /** Método vigente (último tramo no cancelado). */
  current: boolean
  /** Se puede elegir ahora (la base vuelve a validarlo). */
  available: boolean
}

/**
 * Si el método ya elegido se puede corregir: "free" sin efectos reales,
 * "reason" con una operación Andreani previa (motivo + auditoría) y
 * "blocked" cuando hay efectos que primero se corrigen con su flujo auditado.
 */
export interface ClaimLogisticsMethodLock {
  status: "free" | "reason" | "blocked"
  effects: string[]
  correction: string | null
}

type UnitCounts = Partial<Record<ClaimUnitLocation, number>>

export interface ClaimLogisticsItemView {
  orderItemId: number
  original: UnitCounts
  replacement: UnitCounts
  incident: string | null
}

export interface AdminClaimLegView {
  id: number
  direction: ClaimShipmentDirection
  attempt: number
  title: string
  statusLabel: string
  outcomeLabel: string | null
  modalityLabel: string | null
  branchLabel: string | null
  tracking: string | null
  andreaniEstado: string | null
  costLabel: string
  /** Andreani informó el costo (si no, la UI no muestra la fila). */
  costKnown: boolean
  error: string | null
  incident: string | null
  /** Evento de Andreani que no se pudo clasificar: avance congelado hasta revisar. */
  review: string | null
  legacy: boolean
  custodySince: string | null
  manualReview: boolean
  canResolveReview: boolean
  canCreate: boolean
  canSync: boolean
  canReconcile: boolean
  canCancel: boolean
  canMarkNotCompleted: boolean
  labelAvailable: boolean
}

export interface ClaimLogisticsSummary {
  method: string
  branch: string
  andreani: string
  inspection: "No aplica" | "Pendiente" | "Completa"
  incidents: number
  manualIntervention: boolean
  /** Estado en lenguaje de negocio (Pendiente, En Andreani, Esperando al cliente, Recibido, ...). */
  status: string
}

export interface ClaimChecklistItem {
  key: string
  label: string
  done: boolean
}

/** Lo que el wizard muestra para guiar al Admin: checklist automático y qué falta ahora. */
export type ClaimProgressState = "done" | "current" | "pending"

/** Un tramo físico (devolución, cambio o reemplazo) con sus hitos, para el resumen. */
export interface ClaimLogisticsProgressGroup {
  key: ClaimShipmentDirection
  title: string
  steps: Array<{ key: string; label: string; state: ClaimProgressState }>
  /** Tramo Andreani vigente de este grupo (tracking / etiqueta). */
  shipmentId: number | null
  tracking: string | null
  labelAvailable: boolean
}

export interface ClaimLogisticsFlow {
  checklist: ClaimChecklistItem[]
  /** Progreso físico agrupado por tramo (un bloque por tramo, sin repetir estados). */
  groups: ClaimLogisticsProgressGroup[]
  /** Falta reservar el reemplazo antes de generar la operación (la base también lo exige). */
  needsReservation: boolean
  /** La operación vigente no requiere acción: sólo esperar (texto corto). */
  waiting: string | null
}

export interface AdminClaimLogisticsView {
  plan: ClaimLogisticsPlan | null
  planLabel: string | null
  /** Reclamo anterior al circuito por sucursal (sin unidades). */
  legacy: boolean
  summary: ClaimLogisticsSummary
  leg: AdminClaimLegView | null
  items: ClaimLogisticsItemView[]
  nextStep: string
  humanActionRequired: boolean
  /** Métodos que el Admin puede elegir ahora (vacío si ya hay uno vigente). */
  methodOptions: ClaimLogisticsMethodOption[]
  /** Todos los métodos de la resolución, con el vigente marcado. */
  methodChoices: ClaimLogisticsMethodChoice[]
  methodLock: ClaimLogisticsMethodLock
  /** Efectos reales de la logística (con o sin método elegido): Revisión los usa para bloquear correcciones. */
  realEffects: string[]
  /** Cambiar de método con una operación Andreani real previa: motivo obligatorio. */
  methodChangeRequiresReason: boolean
  /** Reintentar el cambio directo (misma sucursal, nuevo intento). */
  canRetryExchange: boolean
  /** Retiro + revisión: original inspeccionado y sin incidencias -> autorizar el reenvío. */
  canAuthorizeResend: boolean
  unitActions: ClaimUnitActionOption[]
  canClose: boolean
  wizardStep: ClaimLogisticsWizardStep
  flow: ClaimLogisticsFlow
}

const PLAN_LABELS: Record<ClaimLogisticsPlan, string> = {
  cambio_directo: "Cambio directo por sucursal",
  retiro: "Devolución por sucursal",
  retiro_y_reenvio: "Devolución, revisión y reenvío",
  reenvio_sin_devolucion: "Sin devolución: envío del reemplazo",
}

export const CLAIM_METHOD_OPTIONS: Record<ClaimLogisticsMethod, ClaimLogisticsMethodOption> = {
  devolucion: {
    direction: "devolucion",
    label: "Debe volver: devolución y reenvío",
    description: "El cliente despacha el producto en una sucursal Andreani. BEYONIX lo recibe, lo inspecciona y después envía el reemplazo.",
  },
  cambio: {
    direction: "cambio",
    label: "Cambio directo en sucursal",
    description: "Andreani entrega el reemplazo en la sucursal sólo si el cliente entrega el producto original, que vuelve a BEYONIX para inspección.",
  },
  sin_devolucion: {
    direction: "sin_devolucion",
    label: "No vuelve: enviar reemplazo",
    description: "El cliente conserva el producto (queda auditado con motivo). BEYONIX reserva y envía el reemplazo a la sucursal Andreani elegida.",
  },
}

const REFUND_METHOD: ClaimLogisticsMethodOption = {
  direction: "devolucion",
  label: "Debe volver: devolución por sucursal",
  description: "El cliente despacha el producto en una sucursal Andreani. BEYONIX lo recibe e inspecciona antes del reintegro o el saldo a favor.",
}

const ACCEPTED_STATUSES = ["aprobado", "reintegro_pendiente", "cambio_pendiente", "cupon_pendiente"]
const RETURNABLE_RESOLUTIONS: readonly string[] = RETURNABLE_CLAIM_RESOLUTIONS

function adminLegView(source: ClaimShipmentAdminSource, units: ClaimUnitSource[]): AdminClaimLegView {
  const creation = source.creation_status ?? "not_started"
  const created = creation === "created"
  const open = !source.closed_at
  const cost = source.cost_amount == null || source.cost_amount === "" ? null : Number(source.cost_amount)
  const legUnits = units.filter((unit) => unit.shipment_id === source.id)
  return {
    id: source.id,
    direction: source.direction,
    attempt: Number(source.attempt ?? 1),
    title: `${LEG_TITLES[source.direction]}${Number(source.attempt ?? 1) > 1 ? ` · intento ${source.attempt}` : ""}`,
    statusLabel: ADMIN_STATUS_LABELS[source.status],
    outcomeLabel: source.exchange_outcome === "completado"
      ? "Intercambio completado"
      : source.exchange_outcome === "no_completado"
        ? "Cambio no completado: el cliente no entregó el producto original."
        : null,
    // Filas heredadas del modelo inicial pueden conservar una modalidad vieja.
    modalityLabel: source.modality
      ? (ADMIN_MODALITY_LABELS as Record<string, string>)[source.modality] ?? `${source.modality} (operación heredada)`
      : null,
    branchLabel: [text(source.branch_id) && `Sucursal ${text(source.branch_id)}`, branchLabel(source)].filter(Boolean).join(" · ") || null,
    tracking: text(source.andreani_tracking) || null,
    andreaniEstado: text(source.andreani_estado) || null,
    costLabel: cost != null && Number.isFinite(cost) ? `$ ${cost.toLocaleString("es-AR")}` : "No informado por Andreani",
    costKnown: cost != null && Number.isFinite(cost),
    error: created ? null : text(source.creation_error) || null,
    incident: source.incident_open ? `Novedad de Andreani${source.incident_event ? `: ${source.incident_event}` : ""}` : null,
    review: source.review_required ? text(source.review_event) || "Evento de Andreani no clasificable" : null,
    legacy: Boolean(source.legacy),
    custodySince: source.branch_custody_since ?? null,
    manualReview: creation === "manual_review",
    canResolveReview: Boolean(source.review_required),
    canCreate: open && source.status === "pendiente" && (creation === "not_started" || creation === "failed"),
    canSync: open && created && source.status !== "cancelada",
    canReconcile: creation === "manual_review",
    canCancel: open && (
      (source.status === "pendiente" && (creation === "not_started" || creation === "failed")) ||
      (created && source.status === "generada" && legUnits.every((unit) => unit.location === "con_cliente" || unit.location === "reservada"))
    ),
    canMarkNotCompleted: open && created && source.direction === "cambio" && !source.exchange_outcome &&
      (source.status === "en_transito" || source.status === "en_sucursal"),
    labelAvailable: created && source.status !== "cancelada",
  }
}

function countBy(units: ClaimUnitSource[], role: ClaimUnitRole, predicate: (unit: ClaimUnitSource) => boolean = () => true) {
  return units.filter((unit) => unit.role === role && predicate(unit)).length
}

/**
 * Devolución dispensada antes del reemplazo: todo original quedó con el
 * cliente y nunca hubo retiro ni cambio vigente. Igual que order_claim_return_waived.
 */
export function isClaimReturnWaived(
  shipments: ReadonlyArray<Pick<ClaimShipmentCustomerSource, "direction" | "status">>,
  units: ReadonlyArray<Pick<ClaimUnitSource, "role" | "location">>,
) {
  const originals = units.filter((unit) => unit.role === "original")
  return originals.length > 0 && originals.every((unit) => unit.location === "conservada_cliente") &&
    !shipments.some((row) => row.status !== "cancelada" && (row.direction === "devolucion" || row.direction === "cambio"))
}

/** Mismas condiciones que guard_order_claim_logistics (la base las vuelve a exigir). */
export function canCloseClaimLogistics(shipments: ClaimShipmentAdminSource[], units: ClaimUnitSource[]) {
  if (shipments.some((row) => row.creation_status === "processing" || row.creation_status === "manual_review")) return false
  if (shipments.some((row) => !row.closed_at && row.creation_status === "created")) return false
  if (units.some((unit) => unit.incident_open)) return false
  if (units.some((unit) => unit.role === "reemplazo" && ["reservada", "en_andreani", "recibida_beyonix"].includes(unit.location))) return false
  if (units.some((unit) => unit.role === "original" && ["en_andreani", "recibida_beyonix"].includes(unit.location))) return false
  const itemIds = [...new Set(units.map((unit) => unit.order_item_id))]
  return itemIds.every((itemId) => {
    const itemUnits = units.filter((unit) => unit.order_item_id === itemId)
    const delivered = countBy(itemUnits, "reemplazo", (unit) => unit.location === "entregada_cliente")
    const settled = countBy(itemUnits, "original", (unit) => ["reincorporada_stock", "baja", "conservada_cliente"].includes(unit.location))
    return delivered <= settled
  })
}

export function getAdminClaimLogisticsView(input: {
  status: string
  resolution?: string | null
  shipments?: ClaimShipmentAdminSource[] | ClaimShipmentAdminSource | null
  units?: ClaimUnitSource[] | null
  /** order_claims.logistics_legacy */
  legacy?: boolean | null
  /** Nota de crédito del reclamo en proceso o autorizada (efecto financiero real). */
  creditNoteActive?: boolean
  /**
   * Cambio directo en sucursal (entrega una unidad por cada original que
   * retira). false en un reclamo mixto: sólo parte de las unidades se reemplaza.
   */
  allowExchange?: boolean
  /**
   * Reclamo mixto: la devolución se definió por producto. true: alguna unidad
   * debe volver (no se ofrece "sin devolución"). false: ninguna vuelve (no se
   * ofrece pedir la devolución). undefined: reclamo simple, decide la logística.
   */
  returnRequired?: boolean
}): AdminClaimLogisticsView | null {
  const shipments = rowsOf(input.shipments)
  const units = input.units ?? []
  const legacy = Boolean(input.legacy) && units.length === 0
  const closed = input.status === "cerrado" || input.status === "rechazado"
  const accepted = ACCEPTED_STATUSES.includes(input.status)
  const isChange = input.resolution === "cambio_producto"
  if (!shipments.length && !units.length && !(accepted && RETURNABLE_RESOLUTIONS.includes(input.resolution ?? ""))) return null

  const active = shipments.filter((row) => row.status !== "cancelada")
  const current = pickCurrentClaimShipment(shipments)
  const openLeg = shipments.find((row) => !row.closed_at) ?? null
  const lastActive = [...active].sort((left, right) => right.id - left.id)[0] ?? null
  const originals = units.filter((unit) => unit.role === "original")
  // Devolución dispensada antes de enviar el reemplazo (request_order_claim_resend_without_return).
  const returnWaived = isChange && isClaimReturnWaived(shipments, units)
  const plan: ClaimLogisticsPlan | null = returnWaived
    ? "reenvio_sin_devolucion"
    : !lastActive
      ? null
      : lastActive.direction === "cambio" ? "cambio_directo" : isChange ? "retiro_y_reenvio" : "retiro"

  const itemIds = [...new Set(units.map((unit) => unit.order_item_id))].sort((a, b) => a - b)
  const items = itemIds.map((orderItemId) => {
    const itemUnits = units.filter((unit) => unit.order_item_id === orderItemId)
    const tally = (role: ClaimUnitRole) => itemUnits.filter((unit) => unit.role === role)
      .reduce<UnitCounts>((acc, unit) => ({ ...acc, [unit.location]: (acc[unit.location] ?? 0) + 1 }), {})
    const open = itemUnits.find((unit) => unit.incident_open)
    return {
      orderItemId,
      original: tally("original"),
      replacement: tally("reemplazo"),
      incident: open ? CLAIM_INCIDENT_LABELS[open.incident_type ?? "otro"] : null,
    }
  })

  const has = (role: ClaimUnitRole, locations: ClaimUnitLocation[]) =>
    units.some((unit) => unit.role === role && locations.includes(unit.location))
  const reviewLeg = shipments.find((row) => row.review_required) ?? null
  const incidentOpen = units.some((unit) => unit.incident_open) || Boolean(reviewLeg)
  const unassignedReservations = units.filter((unit) => unit.role === "reemplazo" && unit.location === "reservada" && !unit.shipment_id)
  const legClosedFor = (unit: ClaimUnitSource) => !unit.shipment_id || shipments.find((row) => row.id === unit.shipment_id)?.closed_at
  const originalsWithCustomer = countBy(units, "original", (unit) => unit.location === "con_cliente")
  const originalsInspected = units.some((unit) => unit.role === "original") &&
    !has("original", ["con_cliente", "en_andreani", "recibida_beyonix"]) && !incidentOpen
  const pendingReservation = Math.max(0, originalsWithCustomer - unassignedReservations.length -
    countBy(units, "reemplazo", (unit) => unit.location === "reservada" && Boolean(openLeg) && unit.shipment_id === openLeg?.id))
  const realOperation = active.some((row) => ["processing", "created", "manual_review"].includes(row.creation_status ?? "not_started"))
  const openIsFree = !openLeg || (openLeg.status === "pendiente" && ["not_started", "failed"].includes(openLeg.creation_status ?? "not_started"))
  const deliveredOrMoving = has("reemplazo", ["entregada_cliente", "en_andreani"])
  const reservedReplacements = countBy(units, "reemplazo", (unit) => unit.location === "reservada")
  const creditNoteActive = Boolean(input.creditNoteActive)

  // Métodos que el Admin puede elegir: nunca automático, nunca el cliente.
  // Un cambio de método con stock reservado o nota de crédito vigente exige
  // corregir primero ese efecto con su propio flujo auditado (el servidor
  // vuelve a exigirlo).
  const methods: ClaimLogisticsMethod[] = !isChange ? ["devolucion"]
    : input.allowExchange === false ? ["devolucion", "sin_devolucion"] : ["devolucion", "cambio", "sin_devolucion"]
  const candidates = methods.filter((method) => input.returnRequired === undefined ||
      (input.returnRequired ? method !== "sin_devolucion" : method === "sin_devolucion"))
  const samePlanAs = (direction: ClaimLogisticsMethod) =>
    plan !== null && (direction === "cambio"
      ? plan === "cambio_directo"
      : direction === "sin_devolucion" ? plan === "reenvio_sin_devolucion" : plan === "retiro" || plan === "retiro_y_reenvio")
  const methodOptions: ClaimLogisticsMethodOption[] = []
  let methodChangeRequiresReason = false
  // Con el dinero ya en marcha (NC vigente) no se ofrece pedir la devolución:
  // sería una acción incompatible con el reintegro o el saldo en curso.
  if (accepted && !closed && openIsFree && !incidentOpen && (units.length === 0 || originalsWithCustomer > 0) && !deliveredOrMoving &&
    !creditNoteActive && !(plan !== null && reservedReplacements > 0)) {
    for (const direction of candidates) {
      // Dispensar la devolución sólo antes de cualquier operación Andreani real.
      if (direction === "sin_devolucion" && realOperation) continue
      if (!samePlanAs(direction)) methodOptions.push(isChange ? CLAIM_METHOD_OPTIONS[direction] : REFUND_METHOD)
    }
    methodChangeRequiresReason = plan !== null && realOperation
  }
  const methodChoices: ClaimLogisticsMethodChoice[] = accepted || plan !== null
    ? candidates.map((direction) => ({
        ...(isChange ? CLAIM_METHOD_OPTIONS[direction] : REFUND_METHOD),
        current: samePlanAs(direction),
        available: methodOptions.some((option) => option.direction === direction),
      }))
    : []

  // Efectos reales que impiden corregir el método "como si nada".
  const effects: string[] = []
  for (const row of active) {
    const creation = row.creation_status ?? "not_started"
    const title = LEG_TITLES[row.direction]
    if (creation === "created") effects.push(`Operación generada: ${title}${text(row.andreani_tracking) ? ` (${text(row.andreani_tracking)})` : ""}`)
    else if (creation === "processing") effects.push(`Operación en curso: ${title}`)
    else if (creation === "manual_review") effects.push(`Operación pendiente de conciliación: ${title}`)
  }
  const unitsLabel = (count: number) => `${count} ${count === 1 ? "unidad" : "unidades"}`
  const effectCount = (role: ClaimUnitRole, locations: ClaimUnitLocation[], label: string) => {
    const count = countBy(units, role, (unit) => locations.includes(unit.location))
    if (count > 0) effects.push(`${label}: ${unitsLabel(count)}`)
  }
  effectCount("reemplazo", ["reservada"], "Stock reservado para el reemplazo")
  effectCount("reemplazo", ["en_andreani", "entregada_cliente"], "Reemplazo despachado o entregado")
  effectCount("original", ["en_andreani"], "Producto original en viaje con Andreani")
  effectCount("original", ["recibida_beyonix"], "Recepción registrada")
  effectCount("original", ["reincorporada_stock", "baja"], "Inspección registrada")
  if (incidentOpen) effects.push(reviewLeg ? "Evento de Andreani pendiente de revisión" : "Problema de inspección abierto")
  if (creditNoteActive) effects.push("Nota de crédito emitida o en proceso")

  // Sin alternativa (reintegro: sólo retiro) no hay nada que corregir salvo efectos reales.
  const hasAlternative = candidates.some((direction) => !samePlanAs(direction))
  const methodLock: ClaimLogisticsMethodLock = plan === null || methodOptions.length > 0 || (!hasAlternative && effects.length === 0)
    ? { status: methodChangeRequiresReason ? "reason" : "free", effects: plan === null ? [] : effects, correction: null }
    : {
        status: "blocked",
        effects,
        correction: closed
          ? "El reclamo está finalizado."
          : incidentOpen
            ? "Resolvé primero el problema o el evento de Andreani (con motivo)."
            : openLeg && !openIsFree
              ? current && adminLegView(current, units).canCancel
                ? "Para cambiar de método, primero cancelá la operación Andreani con un motivo."
                : "La operación Andreani ya está en curso: seguí el circuito actual."
              : reservedReplacements > 0
                ? "Para cambiar de método, primero liberá la reserva del reemplazo con un motivo."
                : creditNoteActive
                  ? "Con una nota de crédito vigente el método no se cambia desde acá."
                  : "El producto ya está en el circuito: continuá con las acciones del paso actual.",
      }
  const canRetryExchange = accepted && !closed && plan === "cambio_directo" && !openLeg && originalsWithCustomer > 0 && !incidentOpen && !deliveredOrMoving
  const canAuthorizeResend = accepted && !closed && isChange && !openLeg && originalsInspected && !deliveredOrMoving && (
    (plan === "retiro_y_reenvio" && active.some((row) => row.direction === "devolucion" && row.creation_status === "created")) ||
    plan === "reenvio_sin_devolucion")

  // Acciones válidas sobre unidades (la base vuelve a validar cada una).
  const unitActions: ClaimUnitActionOption[] = []
  if (!closed) {
    for (const { orderItemId } of items) {
      const itemUnits = units.filter((unit) => unit.order_item_id === orderItemId)
      const push = (action: ClaimUnitAction, role: ClaimUnitRole, max: number, label: string, noteMin: number) => {
        if (max > 0) unitActions.push({ action, orderItemId, role, max, label, noteMin })
      }
      push("arrival_original", "original", countBy(itemUnits, "original", (unit) => ["con_cliente", "en_andreani"].includes(unit.location)),
        "Registrar llegada del producto original a BEYONIX", 0)
      push("arrival_replacement", "reemplazo", countBy(itemUnits, "reemplazo", (unit) => unit.location === "en_andreani"),
        "Registrar regreso del producto nuevo a BEYONIX", 0)
      const deliveredByExchange = countBy(itemUnits, "reemplazo", (unit) => unit.location === "entregada_cliente" &&
        shipments.some((row) => row.id === unit.shipment_id && row.direction === "cambio"))
      push("arrival_replacement", "reemplazo", deliveredByExchange, "Corregir: el producto nuevo volvió a BEYONIX aunque Andreani informó entrega", 10)
      push("inspect_replacement", "reemplazo", countBy(itemUnits, "reemplazo", (unit) => unit.location === "recibida_beyonix"),
        "Inspeccionar producto nuevo devuelto (stock o baja)", 0)
      const freeReserved = countBy(itemUnits, "reemplazo", (unit) => unit.location === "reservada" && !unit.shipment_id)
      push("release_reservation", "reemplazo", freeReserved, "Liberar reserva (vuelve al stock vendible)", 10)
      push("deliver_manual", "reemplazo", freeReserved, "Confirmar entrega del reemplazo fuera de Andreani", 10)
      // Sólo cuando bloquea el cierre: reemplazo entregado sin original devuelto.
      const unsettledDeliveries = countBy(itemUnits, "reemplazo", (unit) => unit.location === "entregada_cliente") -
        countBy(itemUnits, "original", (unit) => ["reincorporada_stock", "baja", "conservada_cliente"].includes(unit.location))
      push("waive_original", "original", Math.min(unsettledDeliveries,
        countBy(itemUnits, "original", (unit) => unit.location === "con_cliente" && Boolean(legClosedFor(unit)))),
        "Excepción: el cliente conserva el producto original", 10)
      for (const role of ["original", "reemplazo"] as ClaimUnitRole[]) {
        const roleUnits = itemUnits.filter((unit) => unit.role === role)
        // Un original que el cliente conserva nunca se inspecciona.
        if (!roleUnits.length || roleUnits.every((unit) => unit.location === "conservada_cliente" && !unit.incident_open)) continue
        const label = role === "original" ? "original" : "reemplazo"
        if (roleUnits.some((unit) => unit.incident_open)) push("incident_resolve", role, 1, `Resolver problema (${label})`, 10)
        else push("incident_open", role, 1, `Registrar problema de inspección (${label})`, 5)
      }
    }
  }

  const canClose = canCloseClaimLogistics(shipments, units)
  const legView = current ? adminLegView(current, units) : null

  let nextStep = ""
  let humanActionRequired = true
  if (closed) {
    nextStep = "Reclamo finalizado."
    humanActionRequired = false
  } else if (reviewLeg) {
    nextStep = `Andreani informó un evento que no podemos clasificar (${text(reviewLeg.review_event) || "sin detalle"}): el avance quedó congelado. Verificalo con Andreani y registrá la resolución.`
  } else if (legacy && plan === null) {
    nextStep = "Reclamo anterior al circuito por sucursal: seguí su flujo original. Si nunca tuvo movimientos, podés elegir un método logístico."
  } else if (plan === null && methodOptions.length) {
    nextStep = isChange
      ? "Elegí si el producto vuelve a BEYONIX antes de enviar el reemplazo."
      : "Si el producto tiene que volver, generá la devolución antes del reintegro o el saldo."
  } else if (shipments.some((row) => row.creation_status === "manual_review")) {
    nextStep = "Resultado incierto con Andreani: verificá la operación y conciliala antes de continuar. No se reintenta sola."
  } else if (incidentOpen) {
    nextStep = "Hay un problema de inspección abierto: nada se reenvía, reintegra ni cierra hasta resolverlo."
  } else if (has("reemplazo", ["recibida_beyonix"])) {
    nextStep = "El producto nuevo volvió a BEYONIX: inspeccionalo y decidí si vuelve a stock o se da de baja."
  } else if (has("original", ["recibida_beyonix"])) {
    nextStep = "El producto original está en BEYONIX pendiente de inspección: registrá la inspección en Recepción (stock o baja)."
  } else if (openLeg && openLeg.status === "pendiente") {
    if (openLeg.creation_status === "processing") {
      nextStep = "Generando la operación con Andreani."
      humanActionRequired = false
    } else if (openLeg.direction !== "devolucion" && (openLeg.direction === "cambio" ? pendingReservation > 0 : unassignedReservations.length === 0)) {
      nextStep = openLeg.direction === "cambio"
        ? `Reservá el producto de reemplazo (${pendingReservation} ${pendingReservation === 1 ? "unidad" : "unidades"}) para generar el cambio.`
        : "Reemplazo autorizado: reservá el producto (una sola vez) para generar el envío a la sucursal."
    } else {
      nextStep = openLeg.direction === "cambio"
        ? "Reserva completa: generá el cambio en sucursal."
        : openLeg.direction === "devolucion" ? "Generá el retiro por sucursal." : "Generá el envío del reemplazo a la sucursal."
    }
  } else if (openLeg && openLeg.direction === "cambio" && openLeg.exchange_outcome === "no_completado") {
    nextStep = "Cambio no completado: el cliente no entregó el producto original. Esperá el regreso del producto nuevo y registrá su llegada."
    humanActionRequired = false
  } else if (openLeg) {
    humanActionRequired = Boolean(openLeg.incident_open)
    nextStep = openLeg.direction === "cambio"
      ? openLeg.status === "en_sucursal"
        ? "Producto nuevo en custodia en la sucursal: esperando que el cliente entregue el original."
        : openLeg.status === "generada"
          ? "Andreani tiene que retirar el producto nuevo en BEYONIX."
          : "El producto nuevo va camino a la sucursal."
      : openLeg.direction === "devolucion"
        ? "Esperando que el cliente despache y Andreani traiga el producto a BEYONIX."
        : "Esperando que el cliente retire el reemplazo en la sucursal."
  } else if (has("original", ["en_andreani"])) {
    nextStep = "Andreani trae el producto original a BEYONIX: registrá su llegada cuando esté en el depósito."
  } else if (canAuthorizeResend) {
    nextStep = plan === "reenvio_sin_devolucion"
      ? "El producto no vuelve: elegí la sucursal y enviá el reemplazo."
      : "Original inspeccionado y sin problemas: autorizá el reemplazo para enviarlo a una sucursal, o finalizá con otra resolución."
  } else if (unassignedReservations.length > 0) {
    nextStep = "Hay una reserva de reemplazo sin operación: generala o liberala."
  } else if (canRetryExchange) {
    nextStep = "El cambio no se completó: reintentalo, cambiá el método con un motivo o finalizá el reclamo."
  } else if (canClose) {
    nextStep = "La logística está resuelta: podés finalizar el reclamo."
  }

  // Paso vigente: la operación Andreani mientras no exista (o esté incierta /
  // en revisión), después lo que vuelve a BEYONIX y recién después el reenvío,
  // el reintegro o la finalización.
  const uncertainLeg = shipments.some((row) => ["processing", "manual_review"].includes(row.creation_status ?? "not_started"))
  const receptionPending = (incidentOpen && !reviewLeg) ||
    has("original", ["en_andreani", "recibida_beyonix"]) || has("reemplazo", ["recibida_beyonix"]) ||
    (has("reemplazo", ["en_andreani"]) && openLeg?.exchange_outcome === "no_completado")
  let wizardStep: ClaimLogisticsWizardStep = "finish"
  if (plan === "cambio_directo") {
    const exchangeOpen = openLeg?.direction === "cambio" && openLeg.exchange_outcome !== "no_completado"
    wizardStep = reviewLeg || uncertainLeg || exchangeOpen ? "logistics"
      : receptionPending ? "reception"
        : canRetryExchange || unassignedReservations.length > 0 ? "logistics" : "finish"
  } else if (plan === "retiro" || plan === "retiro_y_reenvio") {
    const returnGenerated = shipments.some((row) => row.direction === "devolucion" && row.status !== "cancelada" && row.creation_status === "created")
    const afterInspection: ClaimLogisticsWizardStep = plan === "retiro" ? "execution"
      : has("reemplazo", ["entregada_cliente"]) && !openLeg && unassignedReservations.length === 0 ? "finish" : "replacement"
    wizardStep = reviewLeg || uncertainLeg || !returnGenerated ? "logistics"
      : receptionPending || !originalsInspected ? "reception" : afterInspection
  } else if (plan === "reenvio_sin_devolucion") {
    // Sólo viaja el reemplazo: su envío (y, si vuelve sin retirar, su revisión) vive en un paso.
    wizardStep = has("reemplazo", ["entregada_cliente"]) && !openLeg && unassignedReservations.length === 0 &&
      !has("reemplazo", ["en_andreani", "recibida_beyonix"]) && !reviewLeg && !uncertainLeg ? "finish" : "replacement"
  } else {
    wizardStep = isChange ? "logistics" : "reception"
  }

  // Checklist automático y estado humano: se derivan del paradero real de las
  // unidades y de las operaciones; el Admin no interpreta estados técnicos.
  const legDone = (direction: ClaimShipmentDirection) =>
    active.some((row) => row.direction === direction && row.creation_status === "created")
  const originalsReceived = originals.length > 0 &&
    originals.every((unit) => ["recibida_beyonix", "reincorporada_stock", "baja", "conservada_cliente"].includes(unit.location))
  const claimClosed = input.status === "cerrado"
  const check = (key: string, label: string, done: boolean): ClaimChecklistItem => ({ key, label, done })
  const checklist: ClaimChecklistItem[] = plan === "cambio_directo"
    ? [
        check("reserved", "Reemplazo reservado", units.some((unit) => unit.role === "reemplazo")),
        check("exchange", "Cambio generado", legDone("cambio")),
        check("swapped", "Intercambio realizado", shipments.some((row) => row.direction === "cambio" && row.exchange_outcome === "completado") ||
          has("reemplazo", ["entregada_cliente"])),
        check("received", "Producto recibido", originalsReceived),
        check("inspected", "Producto inspeccionado", originalsInspected),
        check("closed", "Reclamo finalizado", claimClosed),
      ]
    : plan === "retiro_y_reenvio"
      ? [
          check("return", "Retiro generado", legDone("devolucion")),
          check("received", "Producto recibido", originalsReceived),
          check("inspected", "Producto inspeccionado", originalsInspected),
          check("reserved", "Reemplazo reservado", units.some((unit) => unit.role === "reemplazo")),
          check("resend", "Reenvío generado", legDone("reemplazo")),
          check("closed", "Reclamo finalizado", claimClosed),
        ]
      : plan === "retiro"
        ? [
            check("return", "Retiro generado", legDone("devolucion")),
            check("received", "Producto recibido", originalsReceived),
            check("inspected", "Producto inspeccionado", originalsInspected),
            check("closed", "Reclamo finalizado", claimClosed),
          ]
        : plan === "reenvio_sin_devolucion"
          ? [
              check("reserved", "Reemplazo reservado", units.some((unit) => unit.role === "reemplazo")),
              check("resend", "Envío generado", legDone("reemplazo")),
              check("delivered", "Reemplazo entregado", has("reemplazo", ["entregada_cliente"])),
              check("closed", "Reclamo finalizado", claimClosed),
            ]
          : []

  // Progreso físico por tramo: un bloque por movimiento real, sin repetir el
  // estado del reclamo. El primer hito incompleto es el actual.
  const groupLeg = (direction: ClaimShipmentDirection) =>
    [...active].filter((row) => row.direction === direction).sort((left, right) => right.id - left.id)[0] ?? null
  const progressGroup = (key: ClaimShipmentDirection, title: string, steps: Array<[string, string, boolean]>): ClaimLogisticsProgressGroup => {
    const firstOpen = steps.findIndex(([, , done]) => !done)
    const row = groupLeg(key)
    const created = row?.creation_status === "created"
    return {
      key,
      title,
      steps: steps.map(([stepKey, label, done], index) => ({
        key: stepKey, label, state: done ? "done" : index === firstOpen && !closed ? "current" : "pending",
      })),
      shipmentId: row?.id ?? null,
      tracking: created ? text(row?.andreani_tracking) || null : null,
      labelAvailable: Boolean(created && row && row.status !== "cancelada"),
    }
  }
  const replacementReserved = units.some((unit) => unit.role === "reemplazo")
  const replacementDelivered = has("reemplazo", ["entregada_cliente"])
  const resendGroup = (sent: boolean) => progressGroup("reemplazo", "Reemplazo", [
    ["reserved", "Reservado", replacementReserved],
    ["sent", "Enviado", sent],
    ["delivered", "Entregado", replacementDelivered],
  ])
  const groups: ClaimLogisticsProgressGroup[] = []
  if (plan === "retiro" || plan === "retiro_y_reenvio") {
    groups.push(progressGroup("devolucion", "Devolución", [
      ["generated", "Generada", legDone("devolucion")],
      ["received", "Recibida", originalsReceived],
      ["inspected", "Inspeccionada", originalsInspected],
    ]))
  }
  if (plan === "cambio_directo") {
    groups.push(progressGroup("cambio", "Cambio en sucursal", [
      ["reserved", "Reemplazo reservado", replacementReserved],
      ["generated", "Generado", legDone("cambio")],
      ["swapped", "Intercambio", shipments.some((row) => row.direction === "cambio" && row.exchange_outcome === "completado") || replacementDelivered],
      ["received", "Original recibido", originalsReceived],
      ["inspected", "Inspeccionado", originalsInspected],
    ]))
  }
  if (plan === "retiro_y_reenvio" && (originalsInspected || replacementReserved || legDone("reemplazo"))) groups.push(resendGroup(legDone("reemplazo")))
  if (plan === "reenvio_sin_devolucion") groups.push(resendGroup(legDone("reemplazo")))
  const needsReservation = Boolean(openLeg) && openLeg?.status === "pendiente" && openLeg.direction !== "devolucion" &&
    (openLeg.direction === "cambio"
      ? pendingReservation > 0
      : unassignedReservations.length === 0 && !units.some((unit) => unit.role === "reemplazo" && unit.location === "reservada" && unit.shipment_id === openLeg.id))
  const processingLeg = shipments.some((row) => row.creation_status === "processing")
  const openCreated = openLeg && openLeg.creation_status === "created" ? openLeg : null
  const waiting = processingLeg
    ? "Generando en Andreani…"
    : !openCreated || reviewLeg
      ? null
      : openCreated.direction === "cambio"
        ? openCreated.exchange_outcome === "no_completado" ? "El producto nuevo vuelve a BEYONIX"
          : openCreated.status === "en_sucursal" ? "Esperando intercambio en la sucursal"
            : openCreated.status === "en_transito" ? "Reemplazo en camino a la sucursal" : "Esperando que Andreani retire el reemplazo"
        : openCreated.direction === "devolucion"
          ? openCreated.status === "generada" ? "Esperando que el cliente despache el producto" : "Producto en camino a BEYONIX"
          : openCreated.status === "en_sucursal" ? "Esperando que el cliente retire el reemplazo" : "Reemplazo en camino a la sucursal"
  const humanStatus = input.status === "cerrado" || input.status === "rechazado" ? "Finalizado"
    : reviewLeg || incidentOpen || shipments.some((row) => row.creation_status === "manual_review") ? "Requiere revisión"
      : plan === null ? "Pendiente"
        : processingLeg ? "En Andreani"
          : openCreated
            ? (openCreated.status === "en_sucursal" && openCreated.exchange_outcome !== "no_completado") ||
              (openCreated.direction === "devolucion" && openCreated.status === "generada") ? "Esperando al cliente" : "En Andreani"
            : openLeg ? "Pendiente"
              : has("original", ["en_andreani"]) || has("reemplazo", ["en_andreani"]) ? "En Andreani"
                : has("original", ["recibida_beyonix"]) || has("reemplazo", ["recibida_beyonix"]) ? "Recibido"
                  : originalsInspected ? (canClose ? "Listo" : "Inspeccionado") : "Pendiente"

  const incidents = units.filter((unit) => unit.incident_open).length + (reviewLeg ? 1 : 0)
  const summary: ClaimLogisticsSummary = {
    method: plan ? PLAN_LABELS[plan] : legacy ? "Flujo anterior (legacy)" : "Sin elegir",
    branch: current ? branchLabel(current) || legView?.branchLabel || "Sin sucursal" : "Sin sucursal",
    status: humanStatus,
    andreani: legView ? `${legView.statusLabel}${legView.andreaniEstado ? ` · ${legView.andreaniEstado}` : ""}` : "Sin operación",
    inspection: (returnWaived || !units.some((unit) => unit.role === "original")) && !units.some((unit) => unit.location === "recibida_beyonix")
      ? "No aplica"
      : has("original", ["con_cliente", "en_andreani", "recibida_beyonix"]) || has("reemplazo", ["recibida_beyonix"]) ? "Pendiente" : "Completa",
    incidents,
    manualIntervention: !closed && (incidents > 0 || shipments.some((row) => row.creation_status === "manual_review")),
  }

  return {
    plan,
    planLabel: plan ? PLAN_LABELS[plan] : null,
    legacy,
    summary,
    leg: legView,
    items,
    nextStep,
    humanActionRequired,
    methodOptions,
    methodChoices,
    methodLock,
    realEffects: effects,
    methodChangeRequiresReason,
    canRetryExchange,
    canAuthorizeResend,
    unitActions,
    canClose,
    wizardStep,
    flow: { checklist, groups, needsReservation, waiting },
  }
}
