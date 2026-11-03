import {
  getLocalDeliveryActionSourceEstados,
  getLocalDeliveryStage,
  getLocalDeliveryTransitionError,
  type LocalDeliveryAction,
  type LocalDeliveryOrderState,
  type LocalDeliveryStage,
} from "./local-delivery-status.ts"

/**
 * Avance de Envío BEYONIX con efectos recuperables, sin migraciones:
 *
 * 1. Transición: un único UPDATE condicional (estado de origen, proveedor,
 *    pago confirmado y sin cancelación en el mismo WHERE). Si otra operación
 *    ganó o el pedido se canceló/reintegró entre la lectura y la escritura, no
 *    actualiza nada y se responde conflicto sin disparar efectos.
 * 2. Efectos de la etapa alcanzada, cada uno con su marca en
 *    `order_audit_events` (metadata.localDeliveryEffect):
 *    - auditoría del cambio de estado: se registra una vez;
 *    - garantía (sólo Entregado): la activación ya es idempotente por ítem y
 *      se verifica releyendo los ítems pendientes;
 *    - email: se reserva la marca ANTES de enviar y se libera si el envío
 *      falla, así un reintento nunca duplica un email ya enviado.
 * 3. Lo que falle queda pendiente y se completa con "Reintentar avisos", que
 *    sólo ejecuta lo que todavía no tiene marca.
 *
 * Un candado por pedido evita que dos pedidos al mismo proceso corran a la vez
 * (el segundo recibe conflicto, sin efectos).
 */
export type LocalDeliveryEffect =
  | "in_transit_status"
  | "in_transit_email"
  | "delivered_warranty"
  | "delivered_status"
  | "delivered_email"

export const LOCAL_DELIVERY_EFFECTS_BY_STAGE: Record<LocalDeliveryStage, LocalDeliveryEffect[]> = {
  preparing: [],
  in_transit: ["in_transit_status", "in_transit_email"],
  delivered: ["delivered_warranty", "delivered_status", "delivered_email"],
}

export const LOCAL_DELIVERY_EFFECT_LABELS: Record<LocalDeliveryEffect, string> = {
  in_transit_status: "registro en el historial",
  in_transit_email: "email al cliente",
  delivered_warranty: "activación de la garantía",
  delivered_status: "registro en el historial",
  delivered_email: "email al cliente",
}

/** Efectos de la etapa actual que todavía no se completaron. */
export function getMissingLocalDeliveryEffects(
  stage: LocalDeliveryStage,
  completed: ReadonlySet<LocalDeliveryEffect>,
  pendingWarrantyItems: number,
): LocalDeliveryEffect[] {
  return LOCAL_DELIVERY_EFFECTS_BY_STAGE[stage].filter((effect) =>
    effect === "delivered_warranty" ? pendingWarrantyItems > 0 : !completed.has(effect))
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
  /** Marcas ya registradas para el pedido. Lanza si no se pudo leer. */
  loadEffectMarkers(orderId: number): Promise<Set<LocalDeliveryEffect>>
  /** Registra la marca (y su evento de auditoría). Devuelve su id. Lanza si falla. */
  recordEffect(orderId: number, effect: LocalDeliveryEffect, metadata: Record<string, unknown>): Promise<string>
  /** Libera una marca reservada (email no enviado). */
  removeEffect(markerId: string): Promise<void>
  activateWarranties(orderId: number, deliveredAt: string): Promise<void>
  /** Ítems con garantía todavía pendiente de activar. Lanza si no se pudo leer. */
  countPendingWarranties(orderId: number): Promise<number>
  /** `true` sólo si el proveedor de email confirmó el envío. */
  sendStateEmail(order: LocalDeliveryOrderRecord): Promise<boolean>
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

/** Ejecuta sólo los efectos pendientes de la etapa actual. Devuelve los que siguen pendientes. */
export async function runLocalDeliveryEffects(
  deps: LocalDeliveryServiceDeps,
  order: LocalDeliveryOrderRecord,
  { previousEstado }: { previousEstado?: string | null } = {},
): Promise<LocalDeliveryEffect[]> {
  const stage = getLocalDeliveryStage(order)
  const effects = LOCAL_DELIVERY_EFFECTS_BY_STAGE[stage]
  let markers: Set<LocalDeliveryEffect>
  try {
    markers = await deps.loadEffectMarkers(order.id)
  } catch {
    return effects
  }

  const pending: LocalDeliveryEffect[] = []
  for (const effect of effects) {
    try {
      if (effect === "delivered_warranty") {
        await deps.activateWarranties(order.id, order.delivered_at ?? deps.now())
        if (await deps.countPendingWarranties(order.id) > 0) pending.push(effect)
        continue
      }
      if (markers.has(effect)) continue
      if (effect === "in_transit_status" || effect === "delivered_status") {
        const estados = STATUS_EFFECT_ESTADOS[effect]
        await deps.recordEffect(order.id, effect, {
          previousEstado: previousEstado ?? estados.previous,
          newEstado: estados.next,
          // Entregado: el costo previsto pasa a ser el costo logístico
          // efectivo de esta entrega (lo que se le paga al cadete).
          ...(effect === "delivered_status" ? { localDeliveryCost: order.shipping_cost_real ?? null } : {}),
        })
        continue
      }
      // Email: se reserva la marca antes de enviar; si el envío falla se
      // libera para reintentar. Nunca dos emails por la misma etapa.
      const markerId = await deps.recordEffect(order.id, effect, {})
      let sent = false
      try {
        sent = await deps.sendStateEmail(order)
      } catch {
        sent = false
      }
      if (!sent) {
        await deps.removeEffect(markerId).catch(() => undefined)
        pending.push(effect)
      }
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

/** "Reintentar avisos": completa sólo los efectos pendientes de la etapa actual. */
export function retryLocalDeliveryEffects(
  deps: LocalDeliveryServiceDeps,
  orderId: number,
): Promise<LocalDeliveryResult> {
  return withOrderLock(orderId, async () => {
    const order = await deps.loadOrder(orderId)
    if (!order) return { status: 404, body: { error: "No encontramos el pedido." } }
    const stage = getLocalDeliveryStage(order)
    if (stage === "preparing" || order.estado === "cancelado" || order.cancelled_at) {
      return { status: 409, body: { error: "Este pedido no tiene avisos de entrega para reintentar." } }
    }
    const pending = await runLocalDeliveryEffects(deps, order)
    return {
      status: 200,
      body: { ok: true, order: { id: orderId, estado: order.estado ?? "", stage }, pendingEffects: pending, warning: pendingWarning(pending) },
    }
  })
}
