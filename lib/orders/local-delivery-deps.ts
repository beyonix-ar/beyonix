import "server-only"

import type { createAdminClient } from "@/lib/supabase/admin"
import { sendOrderStateEmail } from "@/lib/orders/order-status-notifications"
import { startPendingItemWarranties } from "@/lib/orders/warranty-activation"
import { getLocalDeliveryStage, type LocalDeliveryOrderState, type LocalDeliveryPreparation } from "@/lib/orders/local-delivery-status"
import {
  getExhaustedLocalDeliveryEffects,
  getMissingLocalDeliveryEffects,
  isPendingWarrantyItem,
  parseLocalDeliveryEffectRecord,
  summarizeLocalDeliveryEffects,
  type LocalDeliveryEffect,
  type LocalDeliveryEffectRecord,
  type LocalDeliveryEffectState,
  type LocalDeliveryOrderRecord,
  type LocalDeliveryServiceDeps,
  type LocalDeliveryWarrantyItem,
} from "@/lib/orders/local-delivery-service"
import { LOCAL_DELIVERY_PROVIDER } from "@/lib/shipping/local-delivery"
import { isLocalDeliveryOutcomeStatus } from "@/lib/shipping/local-delivery-outcome"
import { CONFIRMED_PAYMENT_STATUSES } from "@/lib/orders/order-payment-status"

/**
 * Dependencias reales (Supabase) del servicio canónico de Envío BEYONIX
 * (lib/orders/local-delivery-service). Las comparten Despachos → Entregas
 * locales (operador) y la página del cadete (QR): "Entregado" es UNA sola
 * lógica (transición atómica + garantía, costo logístico, historial y email);
 * sólo cambia quién la dispara y cómo se autoriza la escritura.
 */
export type LocalDeliveryAdminClient = ReturnType<typeof createAdminClient>

/**
 * Operador autenticado de Despachos, el cadete identificado sólo por el token
 * del QR, o el proceso automático que completa efectos pendientes (nunca
 * cambia el estado de un pedido).
 */
export type LocalDeliveryActor = { type: "admin"; id: string } | { type: "courier"; token: string } | { type: "system" }

export const LOCAL_DELIVERY_ORDER_COLUMNS =
  "id,estado,shipping_provider,envio_proveedor,delivered_at,cancelled_at,financial_status,order_change_status,paid_at,payment_status,payment_confirmed_amount,shipping_cost_real,cliente_email,cliente_nombre"
// Filas de efectos en order_audit_events (metadata.localDeliveryEffect +
// metadata.localDeliveryEffectState). Append-only: nunca se borran.
const EMAIL_ACTION_BY_STATE: Record<LocalDeliveryEffectState, string> = {
  reserved: "local_delivery_email_reserved",
  completed: "local_delivery_email_sent",
  failed: "local_delivery_email_failed",
  superseded: "local_delivery_email_superseded",
}
const WARRANTY_ACTION = "order_item_warranty_started"
export const LOCAL_DELIVERY_EFFECT_ACTIONS = ["order_status_changed", WARRANTY_ACTION, ...Object.values(EMAIL_ACTION_BY_STATE)]
const WARRANTY_COLUMNS = "id,warranty_started_at,warranty_expires_at,warranty_status,warranty_months"
// Guardas de la base que significan "el pedido cambió" (conflicto), no un error técnico.
const CONFLICT_ERRORS = ["LOCAL_DELIVERY_PARCELS_NOT_READY", "LOCAL_DELIVERY_RETURN_IN_PROGRESS"]

type EligibilityFilterable<Q> = {
  eq(column: string, value: string): Q
  is(column: string, value: null): Q
  not(column: string, operator: string, value: null): Q
  gt(column: string, value: number): Q
  in(column: string, values: readonly string[]): Q
}

/**
 * Condiciones de `getLocalDeliveryEligibilityError` evaluadas por la base en
 * el mismo statement: Envío BEYONIX, evidencia real de pago
 * (hasConfirmedPaymentEvidence) y sin cancelación. refund_pending, refunded y
 * cancelled quedan afuera por `financial_status = payment_confirmed`.
 */
export function whereLocalDeliveryEligible<Q extends EligibilityFilterable<Q>>(query: Q): Q {
  return query
    .eq("shipping_provider", LOCAL_DELIVERY_PROVIDER)
    .eq("financial_status", "payment_confirmed")
    .is("cancelled_at", null)
    .not("paid_at", "is", null)
    .gt("payment_confirmed_amount", 0)
    .in("payment_status", CONFIRMED_PAYMENT_STATUSES)
}

export const NO_LOCAL_DELIVERY_PREPARATION: LocalDeliveryPreparation = { packageStatus: null, parcelCount: null, confirmedParcels: 0 }

/** Pickeo y bultos confirmados del intento vigente de cada pedido. Lanza si no se pudo leer. */
export async function loadLocalPreparations(admin: LocalDeliveryAdminClient, orderIds: number[]) {
  const preparations = new Map<number, LocalDeliveryPreparation>()
  if (!orderIds.length) return preparations
  const packages = await admin.from("order_packages").select("id,order_id,status,attempt_number,parcel_count").in("order_id", orderIds)
  if (packages.error) throw new Error("PREPARATION_READ_FAILED")
  const rows = (packages.data ?? []) as Array<{ id: number; order_id: number; status: "preparing" | "prepared"; attempt_number: number; parcel_count: number | null }>
  const defined = rows.filter((row) => row.parcel_count)
  const confirmed = new Map<number, number>()
  if (defined.length) {
    const parcels = await admin.from("order_package_parcels").select("package_id,attempt_number,parcel_count")
      .in("package_id", defined.map((row) => row.id)).not("label_confirmed_at", "is", null)
    if (parcels.error) throw new Error("PREPARATION_READ_FAILED")
    const current = new Map(defined.map((row) => [row.id, row]))
    for (const parcel of parcels.data ?? []) {
      const pkg = current.get(parcel.package_id)
      if (pkg && parcel.attempt_number === pkg.attempt_number && parcel.parcel_count === pkg.parcel_count) {
        confirmed.set(pkg.id, (confirmed.get(pkg.id) ?? 0) + 1)
      }
    }
  }
  for (const row of rows) {
    preparations.set(row.order_id, { packageStatus: row.status, parcelCount: row.parcel_count, confirmedParcels: confirmed.get(row.id) ?? 0 })
  }
  return preparations
}

export function localDeliveryEffectRecords(rows: Array<{ metadata: unknown; created_at: string }>) {
  return rows
    .map((row) => parseLocalDeliveryEffectRecord(row.metadata, row.created_at))
    .filter((record): record is LocalDeliveryEffectRecord => record !== null)
}

export interface LocalDeliveryEffectsSummary {
  /** Efectos de la etapa actual todavía sin completar. */
  pending: LocalDeliveryEffect[]
  /** Pendientes cuyo reintento automático se agotó: requieren atención de Despachos. */
  exhausted: LocalDeliveryEffect[]
}

/**
 * Efectos pendientes de cada pedido con dos lecturas (marcas de efectos e
 * ítems sin garantía). Lo comparten Despachos y el reintento automático.
 * `isInTransitEmailObsolete(id)`: el aviso En camino ya no corresponde (el
 * pedido regresa o regresó a BEYONIX) y no se informa como pendiente.
 * Lanza si no se pudo leer.
 */
export async function loadLocalDeliveryEffectsSummary(
  admin: LocalDeliveryAdminClient,
  orders: ReadonlyArray<LocalDeliveryOrderState & { id: number }>,
  isInTransitEmailObsolete: (orderId: number) => boolean = () => false,
): Promise<Map<number, LocalDeliveryEffectsSummary>> {
  const summaries = new Map<number, LocalDeliveryEffectsSummary>()
  const ids = orders.map((order) => order.id)
  if (!ids.length) return summaries
  const [markers, warranties] = await Promise.all([
    admin.from("order_audit_events").select("order_id,metadata,created_at").in("order_id", ids).in("action", LOCAL_DELIVERY_EFFECT_ACTIONS),
    admin.from("orden_items").select("orden_id,warranty_started_at,warranty_expires_at,warranty_status").in("orden_id", ids)
      .is("warranty_started_at", null).is("warranty_expires_at", null),
  ])
  if (markers.error || warranties.error) throw new Error("EFFECT_RECORDS_READ_FAILED")
  const rowsByOrder = new Map<number, Array<{ metadata: unknown; created_at: string }>>()
  for (const row of markers.data ?? []) rowsByOrder.set(row.order_id, [...(rowsByOrder.get(row.order_id) ?? []), row])
  const pendingWarranties = new Map<number, number>()
  for (const item of warranties.data ?? []) {
    if (isPendingWarrantyItem(item)) pendingWarranties.set(item.orden_id, (pendingWarranties.get(item.orden_id) ?? 0) + 1)
  }
  const nowMs = Date.now()
  for (const order of orders) {
    const records = localDeliveryEffectRecords(rowsByOrder.get(order.id) ?? [])
    const pending = getMissingLocalDeliveryEffects(
      getLocalDeliveryStage(order),
      summarizeLocalDeliveryEffects(records, nowMs),
      pendingWarranties.get(order.id) ?? 0,
    ).filter((effect) => effect !== "in_transit_email" || !isInTransitEmailObsolete(order.id))
    const exhausted = getExhaustedLocalDeliveryEffects(records)
    summaries.set(order.id, { pending, exhausted: pending.filter((effect) => exhausted.has(effect)) })
  }
  return summaries
}

function effectAction(effect: LocalDeliveryEffect, state: LocalDeliveryEffectState) {
  if (effect.endsWith("_email")) return EMAIL_ACTION_BY_STATE[state]
  return effect === "delivered_warranty" ? WARRANTY_ACTION : "order_status_changed"
}

const isConflict = (message: string | undefined) => CONFLICT_ERRORS.some((code) => message?.includes(code))

export function localDeliveryServiceDeps(admin: LocalDeliveryAdminClient, actor: LocalDeliveryActor): LocalDeliveryServiceDeps {
  const actorType = actor.type
  const actorId = actor.type === "admin" ? actor.id : null
  return {
    async loadOrder(orderId) {
      const { data, error } = await admin.from("ordenes").select(LOCAL_DELIVERY_ORDER_COLUMNS).eq("id", orderId).maybeSingle()
      if (error) throw new Error("ORDER_READ_FAILED")
      return data as LocalDeliveryOrderRecord | null
    },
    async transitionOrder({ orderId, fromEstado, action, deliveredAt }) {
      // El proceso automático sólo completa efectos: nunca avanza un pedido.
      if (actor.type === "system") return null
      if (action === "en_camino") {
        // Sólo Despachos saca un pedido a reparto (el cadete nunca).
        if (actor.type !== "admin") return null
        // Preparando → En camino en una sola operación de la base: bajo lock
        // del pedido y su preparación vuelve a exigir proveedor, estado, pago,
        // sin cancelación y TODOS los bultos del armado vigente confirmados.
        // Un rearmado o cambio de bultos entre la validación y el write => 0 filas.
        const { data, error } = await admin
          .rpc("mark_local_delivery_in_transit", { p_order_id: orderId, p_from_estado: fromEstado, p_actor_id: actor.id })
          .select(LOCAL_DELIVERY_ORDER_COLUMNS)
          .maybeSingle()
        if (isConflict(error?.message)) return null
        if (error) throw new Error("ORDER_TRANSITION_FAILED")
        return data as LocalDeliveryOrderRecord | null
      }
      if (actor.type === "courier") {
        // Cadete: misma transición, autorizada por el token bajo el lock del
        // pedido y de la entrega (sólo pendiente o tras el 1.er intento fallido).
        const { data, error } = await admin
          .rpc("mark_local_delivery_delivered_by_courier", { p_token: actor.token })
          .select(LOCAL_DELIVERY_ORDER_COLUMNS)
          .maybeSingle()
        if (isConflict(error?.message)) return null
        if (error) throw new Error("ORDER_TRANSITION_FAILED")
        const updated = data as LocalDeliveryOrderRecord | null
        return updated && updated.id === orderId ? updated : null
      }
      // Entregado: estado de origen, proveedor, evidencia de pago y sin
      // cancelación tienen que seguir siendo ciertos al escribir.
      const query = admin
        .from("ordenes")
        .update({ estado: action, ...(deliveredAt ? { delivered_at: deliveredAt } : {}) })
        .eq("id", orderId)
        .eq("estado", fromEstado)
      const { data, error } = await whereLocalDeliveryEligible<typeof query>(query)
        .select(LOCAL_DELIVERY_ORDER_COLUMNS)
        .maybeSingle()
      // Guardas de la base (bultos sin confirmar, pedido regresando o devuelto
      // a BEYONIX): conflicto, no error técnico. No avanza ni dispara efectos.
      if (isConflict(error?.message)) return null
      if (error) throw new Error("ORDER_TRANSITION_FAILED")
      return data as LocalDeliveryOrderRecord | null
    },
    async loadEffectRecords(orderId) {
      const { data, error } = await admin
        .from("order_audit_events").select("metadata,created_at").eq("order_id", orderId).in("action", LOCAL_DELIVERY_EFFECT_ACTIONS)
      if (error) throw new Error("EFFECT_RECORDS_READ_FAILED")
      return localDeliveryEffectRecords(data ?? [])
    },
    async recordEffect(orderId, effect, state, metadata) {
      const action = effectAction(effect, state)
      const isStatus = action === "order_status_changed"
      const isWarranty = action === WARRANTY_ACTION
      const { error } = await admin.from("order_audit_events").insert({
        order_id: orderId,
        actor_type: actorType,
        actor_id: actorId,
        action,
        previous_status: isStatus && typeof metadata.previousEstado === "string" ? metadata.previousEstado : isWarranty ? "pending_delivery" : null,
        new_status: isStatus && typeof metadata.newEstado === "string" ? metadata.newEstado : isWarranty ? "active" : null,
        metadata: {
          ...metadata,
          shippingProvider: LOCAL_DELIVERY_PROVIDER,
          localDeliveryEffect: effect,
          localDeliveryEffectState: state,
          ...(actor.type === "courier" ? { via: "qr" } : {}),
        },
      })
      if (error) throw new Error("EFFECT_RECORD_FAILED")
    },
    async activateWarranties(orderId, deliveredAt) {
      if (!await startPendingItemWarranties(admin, { orderId, deliveredAt })) throw new Error("WARRANTY_READ_FAILED")
    },
    async loadWarrantyItems(orderId) {
      const { data, error } = await admin.from("orden_items").select(WARRANTY_COLUMNS).eq("orden_id", orderId)
      if (error) throw new Error("WARRANTY_READ_FAILED")
      return (data ?? []) as LocalDeliveryWarrantyItem[]
    },
    async authorizeEmail(orderId, expectedEstado) {
      const query = admin.from("ordenes").select("id").eq("id", orderId).eq("estado", expectedEstado)
      const { data, error } = await whereLocalDeliveryEligible<typeof query>(query).maybeSingle()
      if (error) throw new Error("EMAIL_AUTHORIZATION_FAILED")
      return data !== null
    },
    sendStateEmail: (order) => sendOrderStateEmail(order),
    async loadPreparation(orderId) {
      return (await loadLocalPreparations(admin, [orderId])).get(orderId) ?? NO_LOCAL_DELIVERY_PREPARATION
    },
    async loadOutcomeStatus(orderId) {
      const { data, error } = await admin.from("local_delivery_shipments").select("outcome_status")
        .eq("order_id", orderId).order("shipment_number", { ascending: false }).limit(1).maybeSingle()
      if (error) throw new Error("LOCAL_DELIVERY_OUTCOME_READ_FAILED")
      const status = (data as { outcome_status: unknown } | null)?.outcome_status
      return isLocalDeliveryOutcomeStatus(status) ? status : null
    },
    now: () => new Date().toISOString(),
  }
}
