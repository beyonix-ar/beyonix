import {
  getLocalDeliveryActionSourceEstados,
  getLocalDeliveryPreparationError,
  getLocalDeliveryRetryError,
  getLocalDeliveryStage,
  getLocalDeliveryTransitionError,
  type LocalDeliveryAction,
  type LocalDeliveryOrderState,
  type LocalDeliveryPreparation,
  type LocalDeliveryStage,
} from "./local-delivery-status.ts"

/**
 * Avance de Envío BEYONIX con efectos recuperables:
 *
 * 1. Transición: un único UPDATE condicional (estado de origen, proveedor,
 *    pago confirmado y sin cancelación en el mismo WHERE). Si otra operación
 *    ganó o el pedido se canceló/reintegró entre la lectura y la escritura, no
 *    actualiza nada y se responde conflicto sin disparar efectos.
 * 2. Efectos de la etapa alcanzada. Cada uno deja filas append-only en
 *    `order_audit_events` con `metadata.localDeliveryEffect` y un estado
 *    explícito en `metadata.localDeliveryEffectState`:
 *    - `completed`: el efecto terminó. Es lo ÚNICO que cuenta como hecho.
 *    - `reserved`: intento de email en curso (o interrumpido). Pasados
 *      STALE_EFFECT_RESERVATION_MS se puede reintentar.
 *    - `failed`: el intento falló; se puede reintentar.
 *    - `superseded`: aviso que una etapa posterior volvió obsoleto (email de
 *      En camino cuando el pedido ya fue entregado): nunca se envía.
 *    Auditoría del cambio de estado: una fila `completed`. Garantía (sólo
 *    Entregado): activación idempotente por ítem y una única auditoría
 *    `completed` cuando TODOS los ítems tienen garantía activa verificada.
 *    Email: reserva persistida → autorización condicional en base → envío →
 *    `completed`/`failed` explícitos, nunca borrando filas.
 * 3. Lo que falte se completa con "Reintentar avisos", que vuelve a leer el
 *    pedido, lo revalida (proveedor, pago, cancelación, reintegro) y sólo
 *    ejecuta los efectos de la etapa REAL actual.
 *
 * Un candado por pedido evita que dos pedidos al mismo proceso corran a la vez
 * (el segundo recibe conflicto, sin efectos). Entre procesos, sólo la reserva
 * vigente más vieja queda autorizada; sin un índice único (no existe) dos
 * reservas que se escriban y verifiquen exactamente a la vez siguen siendo
 * teóricamente posibles. Producción corre en una sola instancia.
 */
export type LocalDeliveryEffect =
  | "in_transit_status"
  | "in_transit_email"
  | "delivered_warranty"
  | "delivered_status"
  | "delivered_email"

export type LocalDeliveryEffectState = "reserved" | "completed" | "failed" | "superseded"

/** Estado resumido de un efecto a partir de todas sus filas. */
export type LocalDeliveryEffectStatus = "completed" | "superseded" | "in_progress" | "retryable"

export interface LocalDeliveryEffectRecord {
  effect: LocalDeliveryEffect
  state: LocalDeliveryEffectState | null
  createdAt: string
  /** Intento de email al que pertenece la fila (reserva y su cierre). */
  attemptId?: string | null
}

export const LOCAL_DELIVERY_EFFECTS_BY_STAGE: Record<LocalDeliveryStage, LocalDeliveryEffect[]> = {
  preparing: [],
  in_transit: ["in_transit_status", "in_transit_email"],
  delivered: ["delivered_warranty", "delivered_status", "delivered_email"],
}

const EFFECT_STAGE: Record<LocalDeliveryEffect, LocalDeliveryStage> = {
  in_transit_status: "in_transit",
  in_transit_email: "in_transit",
  delivered_warranty: "delivered",
  delivered_status: "delivered",
  delivered_email: "delivered",
}

export const LOCAL_DELIVERY_EFFECT_LABELS: Record<LocalDeliveryEffect, string> = {
  in_transit_status: "registro en el historial",
  in_transit_email: "email al cliente",
  delivered_warranty: "activación de la garantía",
  delivered_status: "registro en el historial",
  delivered_email: "email al cliente",
}

/** Una reserva de email sin cierre más vieja que esto se considera interrumpida. */
export const STALE_EFFECT_RESERVATION_MS = 5 * 60_000

const EFFECT_STATES = new Set<string>(["reserved", "completed", "failed", "superseded"])
const ALL_EFFECTS = new Set<string>(Object.keys(EFFECT_STAGE))

/** Lee la marca de efecto de una fila de `order_audit_events` (o `null`). */
export function parseLocalDeliveryEffectRecord(metadata: unknown, createdAt: string): LocalDeliveryEffectRecord | null {
  if (!metadata || typeof metadata !== "object") return null
  const { localDeliveryEffect, localDeliveryEffectState, attemptId } = metadata as Record<string, unknown>
  if (typeof localDeliveryEffect !== "string" || !ALL_EFFECTS.has(localDeliveryEffect)) return null
  const state = typeof localDeliveryEffectState === "string" && EFFECT_STATES.has(localDeliveryEffectState)
    ? localDeliveryEffectState as LocalDeliveryEffectState
    : null
  return {
    effect: localDeliveryEffect as LocalDeliveryEffect,
    state,
    createdAt,
    attemptId: typeof attemptId === "string" && attemptId ? attemptId : null,
  }
}

type ActiveReservation = { attemptId: string; createdAt: string }

/**
 * Reservas vigentes: `reserved` sin `failed`/`completed` del mismo intento y
 * todavía no vencidas. Orden estable (más vieja primero, desempate por id del
 * intento): la primera es la única autorizada a enviar.
 */
function activeReservations(rows: readonly LocalDeliveryEffectRecord[], nowMs: number): ActiveReservation[] {
  const closed = new Set(rows.filter((row) => row.attemptId && (row.state === "failed" || row.state === "completed")).map((row) => row.attemptId))
  return rows
    .filter((row): row is LocalDeliveryEffectRecord & { attemptId: string } =>
      row.state === "reserved" && Boolean(row.attemptId) && !closed.has(row.attemptId) &&
      nowMs - Date.parse(row.createdAt) < STALE_EFFECT_RESERVATION_MS)
    .map(({ attemptId, createdAt }) => ({ attemptId, createdAt }))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.attemptId.localeCompare(b.attemptId))
}

/**
 * Sólo una fila explícita `completed` cuenta como hecho. Sin `completed`: un
 * `superseded` lo descarta; si hay alguna reserva vigente está en curso; si
 * no (`failed`, reserva vencida o fila sin estado) es reintentable.
 * Un efecto sin filas no aparece en el mapa (= pendiente).
 */
export function summarizeLocalDeliveryEffects(
  records: readonly LocalDeliveryEffectRecord[],
  nowMs: number,
): Map<LocalDeliveryEffect, LocalDeliveryEffectStatus> {
  const byEffect = new Map<LocalDeliveryEffect, LocalDeliveryEffectRecord[]>()
  for (const record of records) byEffect.set(record.effect, [...(byEffect.get(record.effect) ?? []), record])
  const summary = new Map<LocalDeliveryEffect, LocalDeliveryEffectStatus>()
  for (const [effect, rows] of byEffect) {
    if (rows.some((row) => row.state === "completed")) summary.set(effect, "completed")
    else if (rows.some((row) => row.state === "superseded")) summary.set(effect, "superseded")
    else summary.set(effect, activeReservations(rows, nowMs).length ? "in_progress" : "retryable")
  }
  return summary
}

const isDone = (status: LocalDeliveryEffectStatus | undefined) => status === "completed" || status === "superseded"

/** Efectos de la etapa actual que todavía no se completaron. */
export function getMissingLocalDeliveryEffects(
  stage: LocalDeliveryStage,
  statuses: ReadonlyMap<LocalDeliveryEffect, LocalDeliveryEffectStatus>,
  pendingWarrantyItems: number,
): LocalDeliveryEffect[] {
  return LOCAL_DELIVERY_EFFECTS_BY_STAGE[stage].filter((effect) =>
    !isDone(statuses.get(effect)) || (effect === "delivered_warranty" && pendingWarrantyItems > 0))
}

export interface LocalDeliveryWarrantyItem {
  id: number
  warranty_started_at: string | null
  warranty_expires_at: string | null
  warranty_status: string | null
  warranty_months?: number | null
}

export function isPendingWarrantyItem(item: Pick<LocalDeliveryWarrantyItem, "warranty_started_at" | "warranty_expires_at" | "warranty_status">) {
  return !item.warranty_started_at && !item.warranty_expires_at &&
    (item.warranty_status === null || item.warranty_status === undefined || item.warranty_status === "pending_delivery")
}

/**
 * Verificación POSITIVA de garantía activa (no alcanza con "no está
 * pendiente"): estado `active`, inicio y vencimiento como fechas válidas, el
 * vencimiento posterior al inicio y meses de garantía enteros positivos.
 */
export function isActiveWarrantyItem(item: LocalDeliveryWarrantyItem) {
  const startedAt = item.warranty_started_at ? Date.parse(item.warranty_started_at) : Number.NaN
  const expiresAt = item.warranty_expires_at ? Date.parse(item.warranty_expires_at) : Number.NaN
  return item.warranty_status === "active" &&
    Number.isFinite(startedAt) && Number.isFinite(expiresAt) && expiresAt > startedAt &&
    Number.isInteger(item.warranty_months) && Number(item.warranty_months) > 0
}

export interface LocalDeliveryOrderRecord extends LocalDeliveryOrderState {
  id: number
  shipping_cost_real?: number | null
  cliente_email?: string | null
  cliente_nombre?: string | null
}

export interface LocalDeliveryServiceDeps {
  loadOrder(orderId: number): Promise<LocalDeliveryOrderRecord | null>
  /** UPDATE condicional atómico; `null` si no se actualizó ninguna fila. */
  transitionOrder(input: {
    orderId: number
    fromEstado: string
    action: LocalDeliveryAction
    deliveredAt: string | null
  }): Promise<LocalDeliveryOrderRecord | null>
  /** Filas de efectos registradas para el pedido. Lanza si no se pudo leer. */
  loadEffectRecords(orderId: number): Promise<LocalDeliveryEffectRecord[]>
  /** Agrega una fila de efecto (append-only) con su estado explícito. Lanza si falla. */
  recordEffect(
    orderId: number,
    effect: LocalDeliveryEffect,
    state: LocalDeliveryEffectState,
    metadata: Record<string, unknown>,
  ): Promise<void>
  /** Activa (idempotente por ítem) la garantía de los ítems pendientes, sin auditar. Lanza si no pudo leerlos. */
  activateWarranties(orderId: number, deliveredAt: string): Promise<void>
  /** Ítems del pedido con su garantía. Lanza si no se pudo leer. */
  loadWarrantyItems(orderId: number): Promise<LocalDeliveryWarrantyItem[]>
  /**
   * Autorización condicional EN BASE (una sola consulta con todo en el WHERE):
   * `true` sólo si el pedido sigue siendo Envío BEYONIX, en `expectedEstado`,
   * con evidencia real de pago y sin cancelación ni reintegro. Lanza si falla.
   */
  authorizeEmail(orderId: number, expectedEstado: string): Promise<boolean>
  /** `true` sólo si el proveedor de email confirmó el envío. */
  sendStateEmail(order: LocalDeliveryOrderRecord): Promise<boolean>
  /** Pickeo y bultos BX-PKG del intento vigente. Lanza si no se pudo leer. */
  loadPreparation(orderId: number): Promise<LocalDeliveryPreparation>
  now(): string
}

export interface LocalDeliveryResult {
  status: number
  body: {
    ok?: boolean
    error?: string
    order?: { id: number; estado: string; stage: LocalDeliveryStage }
    pendingEffects?: LocalDeliveryEffect[]
    warning?: string
  }
}

const lockedOrders = new Set<number>()
// Emails confirmados por el proveedor cuya marca `completed` no se pudo
// escribir: el reintento sólo escribe la marca, sin reenviar.
const sentWithoutCompletedMarker = new Set<string>()

async function withOrderLock(orderId: number, run: () => Promise<LocalDeliveryResult>): Promise<LocalDeliveryResult> {
  if (lockedOrders.has(orderId)) {
    return { status: 409, body: { error: "Otro operador está actualizando este pedido. Actualizá la lista." } }
  }
  lockedOrders.add(orderId)
  try {
    return await run()
  } finally {
    lockedOrders.delete(orderId)
  }
}

const STATUS_EFFECT_ESTADOS: Record<"in_transit_status" | "delivered_status", { previous: string; next: string }> = {
  in_transit_status: { previous: "pagado", next: "en_camino" },
  delivered_status: { previous: "en_camino", next: "entregado" },
}

/**
 * Después de persistir la reserva: (1) autorización condicional en base
 * contra el estado esperado y (2) la reserva tiene que ser la vigente más
 * vieja y no puede existir un `completed`. Como la reserva ya está escrita
 * cuando se evalúa (1), cualquier cancelación, reintegro o cambio de estado
 * confirmado ANTES de esa consulta se detecta y el email no sale.
 */
async function authorizeEmailAttempt(
  deps: LocalDeliveryServiceDeps,
  orderId: number,
  effect: "in_transit_email" | "delivered_email",
  attemptId: string,
  expectedEstado: string,
) {
  if (!await deps.authorizeEmail(orderId, expectedEstado)) return false
  const rows = (await deps.loadEffectRecords(orderId)).filter((row) => row.effect === effect)
  if (rows.some((row) => row.state === "completed" || row.state === "superseded")) return false
  return activeReservations(rows, Date.parse(deps.now()))[0]?.attemptId === attemptId
}

/**
 * Email de la etapa. Reserva persistida → autorización condicional en base →
 * envío → `completed` o `failed`; nunca se borra una fila. Si ni siquiera se
 * puede escribir `failed`, la reserva queda sin cierre: no cuenta como
 * enviado y vence a los STALE_EFFECT_RESERVATION_MS. `true` si quedó hecho.
 *
 * Ventana residual inevitable sin outbox/transacción distribuida: una
 * cancelación confirmada DESPUÉS de la autorización y antes de que el
 * proveedor acepte el email (milisegundos) no puede frenarlo.
 */
async function runEmailEffect(
  deps: LocalDeliveryServiceDeps,
  orderId: number,
  effect: "in_transit_email" | "delivered_email",
  status: LocalDeliveryEffectStatus | undefined,
): Promise<boolean> {
  if (isDone(status)) return true
  const key = `${orderId}:${effect}`
  if (sentWithoutCompletedMarker.has(key)) {
    await deps.recordEffect(orderId, effect, "completed", { recoveredMarker: true })
    sentWithoutCompletedMarker.delete(key)
    return true
  }
  if (status === "in_progress") return false

  // Corte temprano: un pedido ya inválido ni siquiera reserva.
  const fresh = await deps.loadOrder(orderId)
  if (!fresh || getLocalDeliveryRetryError(fresh) || getLocalDeliveryStage(fresh) !== EFFECT_STAGE[effect]) return false
  const expectedEstado = fresh.estado ?? ""

  const attemptId = globalThis.crypto.randomUUID()
  await deps.recordEffect(orderId, effect, "reserved", { attemptId, expectedEstado })
  let authorized = false
  try {
    authorized = await authorizeEmailAttempt(deps, orderId, effect, attemptId, expectedEstado)
  } catch {
    authorized = false
  }
  if (!authorized) {
    await deps.recordEffect(orderId, effect, "failed", { attemptId, reason: "not_authorized" }).catch(() => undefined)
    return false
  }

  let sent = false
  try {
    sent = await deps.sendStateEmail(fresh)
  } catch {
    sent = false
  }
  if (!sent) {
    await deps.recordEffect(orderId, effect, "failed", { attemptId }).catch(() => undefined)
    return false
  }
  try {
    await deps.recordEffect(orderId, effect, "completed", { attemptId })
  } catch (error) {
    sentWithoutCompletedMarker.add(key)
    throw error
  }
  return true
}

/**
 * Garantía: activa sólo los ítems faltantes (idempotente por ítem: nunca toca
 * uno con garantía iniciada), relee TODOS y exige garantía activa positiva en
 * cada uno (`isActiveWarrantyItem`). Recién entonces escribe la única
 * auditoría final `completed`. Si algún ítem sigue pendiente, tiene estado
 * incorrecto o fechas faltantes/inconsistentes, no audita nada y queda
 * pendiente.
 */
async function runWarrantyEffect(
  deps: LocalDeliveryServiceDeps,
  order: LocalDeliveryOrderRecord,
  status: LocalDeliveryEffectStatus | undefined,
): Promise<boolean> {
  if (status === "completed") return true
  const deliveredAt = order.delivered_at ?? deps.now()
  await deps.activateWarranties(order.id, deliveredAt)
  const items = await deps.loadWarrantyItems(order.id)
  if (!items.every(isActiveWarrantyItem)) return false
  await deps.recordEffect(order.id, "delivered_warranty", "completed", {
    delivered_at: deliveredAt,
    items: items.map(({ id, warranty_started_at, warranty_expires_at, warranty_months, warranty_status }) =>
      ({ id, warranty_started_at, warranty_expires_at, warranty_months: warranty_months ?? null, warranty_status })),
  })
  return true
}

/** Ejecuta sólo los efectos pendientes de la etapa actual. Devuelve los que siguen pendientes. */
export async function runLocalDeliveryEffects(
  deps: LocalDeliveryServiceDeps,
  order: LocalDeliveryOrderRecord,
  { previousEstado }: { previousEstado?: string | null } = {},
): Promise<LocalDeliveryEffect[]> {
  const stage = getLocalDeliveryStage(order)
  const effects = LOCAL_DELIVERY_EFFECTS_BY_STAGE[stage]
  let statuses: Map<LocalDeliveryEffect, LocalDeliveryEffectStatus>
  try {
    statuses = summarizeLocalDeliveryEffects(await deps.loadEffectRecords(order.id), Date.parse(deps.now()))
  } catch {
    return effects
  }

  // Entregado vuelve obsoleto el aviso de En camino que no llegó a salir:
  // se marca `superseded` y nunca se envía después.
  if (stage === "delivered" && !isDone(statuses.get("in_transit_email")) && statuses.get("in_transit_email") !== "in_progress") {
    await deps.recordEffect(order.id, "in_transit_email", "superseded", { supersededBy: "entregado" }).catch(() => undefined)
  }

  const pending: LocalDeliveryEffect[] = []
  for (const effect of effects) {
    const status = statuses.get(effect)
    try {
      if (effect === "delivered_warranty") {
        if (!await runWarrantyEffect(deps, order, status)) pending.push(effect)
        continue
      }
      if (effect === "in_transit_email" || effect === "delivered_email") {
        if (!await runEmailEffect(deps, order.id, effect, status)) pending.push(effect)
        continue
      }
      if (status === "completed") continue
      const estados = STATUS_EFFECT_ESTADOS[effect]
      await deps.recordEffect(order.id, effect, "completed", {
        previousEstado: previousEstado ?? estados.previous,
        newEstado: estados.next,
        // Entregado: el costo previsto pasa a ser el costo logístico
        // efectivo de esta entrega (lo que se le paga al cadete).
        ...(effect === "delivered_status" ? { localDeliveryCost: order.shipping_cost_real ?? null } : {}),
      })
    } catch {
      pending.push(effect)
    }
  }
  return pending
}

function pendingWarning(pending: LocalDeliveryEffect[]) {
  return pending.length
    ? `Quedó pendiente: ${[...new Set(pending.map((effect) => LOCAL_DELIVERY_EFFECT_LABELS[effect]))].join(", ")}. Tocá "Reintentar avisos".`
    : undefined
}

export function advanceLocalDelivery(
  deps: LocalDeliveryServiceDeps,
  orderId: number,
  action: LocalDeliveryAction,
): Promise<LocalDeliveryResult> {
  return withOrderLock(orderId, async () => {
    const order = await deps.loadOrder(orderId)
    if (!order) return { status: 404, body: { error: "No encontramos el pedido." } }
    const transitionError = getLocalDeliveryTransitionError(order, action)
    if (transitionError) return { status: 409, body: { error: transitionError } }
    // En camino = el cadete se lleva los bultos: tienen que estar todos
    // armados y con su etiqueta confirmada (la base lo vuelve a exigir).
    if (action === "en_camino") {
      const preparationError = getLocalDeliveryPreparationError(await deps.loadPreparation(orderId))
      if (preparationError) return { status: 409, body: { error: preparationError } }
    }

    const fromEstado = order.estado ?? ""
    if (!getLocalDeliveryActionSourceEstados(action).includes(fromEstado)) {
      return { status: 409, body: { error: "El pedido cambió. Actualizá la lista." } }
    }
    const updated = await deps.transitionOrder({
      orderId,
      fromEstado,
      action,
      deliveredAt: action === "entregado" ? deps.now() : null,
    })
    // Otro operador ganó, o el pedido se canceló/reintegró entre medio.
    if (!updated) {
      return { status: 409, body: { error: "El pedido cambió mientras lo actualizabas. Actualizá la lista." } }
    }

    const pending = await runLocalDeliveryEffects(deps, updated, { previousEstado: fromEstado })
    const stage = getLocalDeliveryStage(updated)
    return {
      status: 200,
      body: { ok: true, order: { id: orderId, estado: updated.estado ?? action, stage }, pendingEffects: pending, warning: pendingWarning(pending) },
    }
  })
}

/**
 * "Reintentar avisos": relee el pedido y lo revalida (Envío BEYONIX, pago
 * confirmado, sin cancelación ni reintegro pendiente/hecho). Si algo falla no
 * ejecuta ningún efecto. Si no, completa sólo los efectos pendientes de la
 * etapa real actual.
 */
export function retryLocalDeliveryEffects(
  deps: LocalDeliveryServiceDeps,
  orderId: number,
): Promise<LocalDeliveryResult> {
  return withOrderLock(orderId, async () => {
    const order = await deps.loadOrder(orderId)
    if (!order) return { status: 404, body: { error: "No encontramos el pedido." } }
    const retryError = getLocalDeliveryRetryError(order)
    if (retryError) return { status: 409, body: { error: retryError } }
    const stage = getLocalDeliveryStage(order)
    const pending = await runLocalDeliveryEffects(deps, order)
    return {
      status: 200,
      body: { ok: true, order: { id: orderId, estado: order.estado ?? "", stage }, pendingEffects: pending, warning: pendingWarning(pending) },
    }
  })
}
