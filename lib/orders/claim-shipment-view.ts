/**
 * Logística de postventa de un reclamo (order_claim_shipments +
 * order_claim_units) para el cliente y para Admin. Pura: sólo deriva
 * presentación y acciones válidas; las reglas reales viven en las RPCs de
 * 20260928100000 y se vuelven a validar ahí. Toda la postventa es por
 * sucursal Andreani. El cliente nunca recibe costo, contrato, ambiente,
 * identificadores internos, errores técnicos ni la decisión interna del método.
 */

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
  "id,direction,attempt,status,modality,branch_name,branch_address,andreani_tracking,exchange_outcome,incident_open,branch_custody_since,delivered_at,closed_at"

export const CLAIM_RETURN_PACKING_INSTRUCTIONS =
  "Prepará el producto completo, con caja, bolsas, manuales, accesorios y todos los elementos recibidos, correctamente embalado y en el mejor estado posible."

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

  if (source.direction === "cambio") {
    if (source.exchange_outcome === "no_completado") {
      statusLabel = "Cambio no completado"
      instructions.push("El cambio no se completó porque no se entregó el producto original. El producto nuevo vuelve a BEYONIX; te vamos a escribir por este medio para definir cómo seguimos.")
    } else if (source.exchange_outcome === "completado" || source.status === "entregada") {
      instructions.push("Andreani te entregó el producto nuevo y recibió el original. Cuando el original llegue a BEYONIX lo revisamos.")
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
      instructions.push("Andreani informó la entrega en BEYONIX. Vamos a revisar el producto y te avisaremos por este medio cómo sigue.")
    } else {
      instructions.push(CLAIM_RETURN_PACKING_INSTRUCTIONS)
      instructions.push(source.status === "pendiente"
        ? "Estamos generando la devolución con Andreani. Te vamos a avisar por este medio cómo enviarlo."
        : `Descargá e imprimí la etiqueta de devolución, pegala en el paquete cerrado y llevalo a ${where}.`)
    }
  } else if (source.status === "pendiente") {
    instructions.push("Estamos preparando el envío de tu producto de reemplazo.")
  } else if (source.status === "entregada") {
    instructions.push("Andreani informó que retiraste tu producto de reemplazo.")
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

  return {
    direction: source.direction,
    title: LEG_TITLES[source.direction],
    statusLabel,
    branchLabel: branch,
    tracking,
    instructions,
    label: source.direction === "devolucion" && source.status !== "pendiente" && source.status !== "entregada",
  }
}

// ── Admin ───────────────────────────────────────────────────────────────────

export type ClaimLogisticsPlan = "cambio_directo" | "retiro" | "retiro_y_reenvio"
export type ClaimLogisticsWizardStep = "replacement" | "execution" | "reception"

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

export interface ClaimLogisticsMethodOption {
  direction: "cambio" | "devolucion"
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
  /** Cambiar de método con una operación Andreani real previa: motivo obligatorio. */
  methodChangeRequiresReason: boolean
  /** Reintentar el cambio directo (misma sucursal, nuevo intento). */
  canRetryExchange: boolean
  /** Retiro + revisión: original inspeccionado y sin incidencias -> autorizar el reenvío. */
  canAuthorizeResend: boolean
  unitActions: ClaimUnitActionOption[]
  canClose: boolean
  wizardStep: ClaimLogisticsWizardStep
}

const PLAN_LABELS: Record<ClaimLogisticsPlan, string> = {
  cambio_directo: "Cambio directo por sucursal",
  retiro: "Retiro por sucursal + revisión",
  retiro_y_reenvio: "Retiro + revisión + reenvío",
}

export const CLAIM_METHOD_OPTIONS: Record<"cambio" | "devolucion", ClaimLogisticsMethodOption> = {
  cambio: {
    direction: "cambio",
    label: "Cambio directo por sucursal",
    description: "Se reserva el reemplazo y Andreani lo entrega en la sucursal solo si el cliente entrega el producto original. El producto devuelto vuelve a BEYONIX para inspección.",
  },
  devolucion: {
    direction: "devolucion",
    label: "Retiro + revisión + reenvío",
    description: "El cliente entrega el producto en una sucursal Andreani. BEYONIX lo recibe e inspecciona y recién después se decide y envía el reemplazo.",
  },
}

const REFUND_METHOD: ClaimLogisticsMethodOption = {
  direction: "devolucion",
  label: "Retiro por sucursal + revisión",
  description: "El cliente entrega el producto en una sucursal Andreani. BEYONIX lo recibe e inspecciona antes de habilitar la nota de crédito o el reintegro.",
}

const ACCEPTED_STATUSES = ["aprobado", "reintegro_pendiente", "cambio_pendiente", "cupon_pendiente"]
const RETURNABLE_RESOLUTIONS = ["cambio_producto", "reintegro_total", "reintegro_parcial", "saldo_a_favor", "cupon_descuento"]

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
  const plan: ClaimLogisticsPlan | null = !lastActive
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
  const candidates: Array<"cambio" | "devolucion"> = isChange ? ["cambio", "devolucion"] : ["devolucion"]
  const samePlanAs = (direction: "cambio" | "devolucion") =>
    plan !== null && (direction === "cambio" ? plan === "cambio_directo" : plan !== "cambio_directo")
  const methodOptions: ClaimLogisticsMethodOption[] = []
  let methodChangeRequiresReason = false
  if (accepted && !closed && openIsFree && !incidentOpen && (units.length === 0 || originalsWithCustomer > 0) && !deliveredOrMoving &&
    !(plan !== null && (reservedReplacements > 0 || creditNoteActive))) {
    for (const direction of candidates) {
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
  if (incidentOpen) effects.push(reviewLeg ? "Evento de Andreani pendiente de revisión" : "Incidencia de inspección abierta")
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
            ? "Resolvé primero la incidencia o el evento de Andreani (con motivo)."
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
  const canAuthorizeResend = accepted && !closed && isChange && plan === "retiro_y_reenvio" && !openLeg && originalsInspected &&
    !deliveredOrMoving && active.some((row) => row.direction === "devolucion" && row.creation_status === "created")

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
        if (!roleUnits.length) continue
        const label = role === "original" ? "original" : "reemplazo"
        if (roleUnits.some((unit) => unit.incident_open)) push("incident_resolve", role, 1, `Resolver incidencia (${label})`, 10)
        else push("incident_open", role, 1, `Registrar incidencia de inspección (${label})`, 5)
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
      ? "Elegí el método logístico del cambio: cambio directo por sucursal o retiro + revisión + reenvío."
      : "Si el producto tiene que volver a BEYONIX, elegí el retiro por sucursal antes de la nota de crédito o el reintegro."
  } else if (shipments.some((row) => row.creation_status === "manual_review")) {
    nextStep = "Resultado incierto con Andreani: verificá la operación y conciliala antes de continuar. No se reintenta sola."
  } else if (incidentOpen) {
    nextStep = "Hay una incidencia de inspección abierta: nada se reenvía, reintegra ni cierra hasta resolverla."
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
    nextStep = "Original inspeccionado y sin incidencias: autorizá el reemplazo para enviarlo a una sucursal, o finalizá con otra resolución."
  } else if (unassignedReservations.length > 0) {
    nextStep = "Hay una reserva de reemplazo sin operación: generala o liberala."
  } else if (canRetryExchange) {
    nextStep = "El cambio no se completó: reintentalo, cambiá el método con un motivo o finalizá el reclamo."
  } else if (canClose) {
    nextStep = "La logística está resuelta: podés finalizar el reclamo."
  }

  let wizardStep: ClaimLogisticsWizardStep = "execution"
  if (plan === "cambio_directo") {
    const exchangeGenerated = shipments.some((row) => row.direction === "cambio" && row.creation_status === "created")
    wizardStep = !exchangeGenerated && pendingReservation > 0
      ? "replacement"
      : has("original", ["recibida_beyonix", "en_andreani"]) && !openLeg ? "reception" : "execution"
  } else if (plan === "retiro_y_reenvio") {
    wizardStep = !originalsInspected && !deliveredOrMoving
      ? "reception"
      : openLeg?.direction === "reemplazo" && openLeg.status === "pendiente" && unassignedReservations.length === 0 ? "replacement" : "execution"
  } else if (plan === "retiro") {
    wizardStep = originalsInspected ? "execution" : "reception"
  } else {
    wizardStep = isChange ? "replacement" : "reception"
  }

  const incidents = units.filter((unit) => unit.incident_open).length + (reviewLeg ? 1 : 0)
  const summary: ClaimLogisticsSummary = {
    method: plan ? PLAN_LABELS[plan] : legacy ? "Flujo anterior (legacy)" : "Sin elegir",
    branch: legView?.branchLabel ?? "Sin sucursal",
    andreani: legView ? `${legView.statusLabel}${legView.andreaniEstado ? ` · ${legView.andreaniEstado}` : ""}` : "Sin operación",
    inspection: !units.some((unit) => unit.role === "original") && !units.some((unit) => unit.location === "recibida_beyonix")
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
    methodChangeRequiresReason,
    canRetryExchange,
    canAuthorizeResend,
    unitActions,
    canClose,
    wizardStep,
  }
}
