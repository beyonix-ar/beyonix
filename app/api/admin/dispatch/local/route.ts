import { requireOperator } from "@/app/api/admin/clientes/_auth"
import { sendOrderStateEmail } from "@/lib/orders/order-status-notifications"
import { startPendingItemWarranties } from "@/lib/orders/warranty-activation"
import {
  getLocalDeliveryPreparationError,
  getLocalDeliveryStage,
  isLocalDeliveryAction,
  type LocalDeliveryPreparation,
} from "@/lib/orders/local-delivery-status"
import {
  advanceLocalDelivery,
  getMissingLocalDeliveryEffects,
  isPendingWarrantyItem,
  parseLocalDeliveryEffectRecord,
  retryLocalDeliveryEffects,
  summarizeLocalDeliveryEffects,
  type LocalDeliveryEffect,
  type LocalDeliveryEffectRecord,
  type LocalDeliveryEffectState,
  type LocalDeliveryOrderRecord,
  type LocalDeliveryServiceDeps,
  type LocalDeliveryWarrantyItem,
} from "@/lib/orders/local-delivery-service"
import { LOCAL_DELIVERY_PROVIDER } from "@/lib/shipping/local-delivery"
import { CONFIRMED_PAYMENT_STATUSES } from "@/lib/orders/order-payment-status"

// Envío BEYONIX: circuito local mínimo, separado de Andreani (sin guía ni
// Bulto general Andreani). Lo opera cualquier operador interno: a diferencia de
// Andreani, nadie más informa "en camino" o "entregado".
const LIST_COLUMNS =
  "id,estado,created_at,paid_at,delivered_at,cliente_nombre,cliente_telefono,cliente_direccion,localidad,cp_destino"
const ORDER_COLUMNS =
  "id,estado,shipping_provider,envio_proveedor,delivered_at,cancelled_at,financial_status,order_change_status,paid_at,payment_status,payment_confirmed_amount,shipping_cost_real,cliente_email,cliente_nombre"
const RECENTLY_DELIVERED_DAYS = 3
// Filas de efectos en order_audit_events (metadata.localDeliveryEffect +
// metadata.localDeliveryEffectState). Append-only: nunca se borran.
const EMAIL_ACTION_BY_STATE: Record<LocalDeliveryEffectState, string> = {
  reserved: "local_delivery_email_reserved",
  completed: "local_delivery_email_sent",
  failed: "local_delivery_email_failed",
  superseded: "local_delivery_email_superseded",
}
const WARRANTY_ACTION = "order_item_warranty_started"
const EFFECT_ACTIONS = ["order_status_changed", WARRANTY_ACTION, ...Object.values(EMAIL_ACTION_BY_STATE)]
const WARRANTY_COLUMNS = "id,warranty_started_at,warranty_expires_at,warranty_status,warranty_months"

type AdminClient = Exclude<Awaited<ReturnType<typeof requireOperator>>, { error: unknown }>["admin"]

type LocalDeliveryRow = {
  id: number
  estado: string
  created_at: string
  paid_at: string | null
  delivered_at: string | null
  cliente_nombre: string | null
  cliente_telefono: string | null
  cliente_direccion: string | null
  localidad: string | null
  cp_destino: string | null
}

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
function whereLocalDeliveryEligible<Q extends EligibilityFilterable<Q>>(query: Q): Q {
  return query
    .eq("shipping_provider", LOCAL_DELIVERY_PROVIDER)
    .eq("financial_status", "payment_confirmed")
    .is("cancelled_at", null)
    .not("paid_at", "is", null)
    .gt("payment_confirmed_amount", 0)
    .in("payment_status", CONFIRMED_PAYMENT_STATUSES)
}

const NO_PREPARATION: LocalDeliveryPreparation = { packageStatus: null, parcelCount: null, confirmedParcels: 0 }

/** Pickeo y bultos confirmados del intento vigente de cada pedido. Lanza si no se pudo leer. */
async function loadLocalPreparations(admin: AdminClient, orderIds: number[]) {
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

function effectRecords(rows: Array<{ metadata: unknown; created_at: string }>) {
  return rows
    .map((row) => parseLocalDeliveryEffectRecord(row.metadata, row.created_at))
    .filter((record): record is LocalDeliveryEffectRecord => record !== null)
}

function effectAction(effect: LocalDeliveryEffect, state: LocalDeliveryEffectState) {
  if (effect.endsWith("_email")) return EMAIL_ACTION_BY_STATE[state]
  return effect === "delivered_warranty" ? WARRANTY_ACTION : "order_status_changed"
}

function serviceDeps(admin: AdminClient, actorId: string): LocalDeliveryServiceDeps {
  return {
    async loadOrder(orderId) {
      const { data, error } = await admin.from("ordenes").select(ORDER_COLUMNS).eq("id", orderId).maybeSingle()
      if (error) throw new Error("ORDER_READ_FAILED")
      return data as LocalDeliveryOrderRecord | null
    },
    async transitionOrder({ orderId, fromEstado, action, deliveredAt }) {
      if (action === "en_camino") {
        // Preparando → En camino en una sola operación de la base: bajo lock
        // del pedido y su preparación vuelve a exigir proveedor, estado, pago,
        // sin cancelación y TODOS los bultos del armado vigente confirmados.
        // Un rearmado o cambio de bultos entre la validación y el write => 0 filas.
        const { data, error } = await admin
          .rpc("mark_local_delivery_in_transit", { p_order_id: orderId, p_from_estado: fromEstado, p_actor_id: actorId })
          .select(ORDER_COLUMNS)
          .maybeSingle()
        if (error?.message?.includes("LOCAL_DELIVERY_PARCELS_NOT_READY")) return null
        if (error) throw new Error("ORDER_TRANSITION_FAILED")
        return data as LocalDeliveryOrderRecord | null
      }
      // Entregado: estado de origen, proveedor, evidencia de pago y sin
      // cancelación tienen que seguir siendo ciertos al escribir.
      const query = admin
        .from("ordenes")
        .update({ estado: action, ...(deliveredAt ? { delivered_at: deliveredAt } : {}) })
        .eq("id", orderId)
        .eq("estado", fromEstado)
      const { data, error } = await whereLocalDeliveryEligible<typeof query>(query)
        .select(ORDER_COLUMNS)
        .maybeSingle()
      // El guard de la base (bultos sin confirmar entre el chequeo y el UPDATE)
      // es un conflicto, no un error técnico: no avanza ni dispara efectos.
      if (error?.message?.includes("LOCAL_DELIVERY_PARCELS_NOT_READY")) return null
      if (error) throw new Error("ORDER_TRANSITION_FAILED")
      return data as LocalDeliveryOrderRecord | null
    },
    async loadEffectRecords(orderId) {
      const { data, error } = await admin
        .from("order_audit_events").select("metadata,created_at").eq("order_id", orderId).in("action", EFFECT_ACTIONS)
      if (error) throw new Error("EFFECT_RECORDS_READ_FAILED")
      return effectRecords(data ?? [])
    },
    async recordEffect(orderId, effect, state, metadata) {
      const action = effectAction(effect, state)
      const isStatus = action === "order_status_changed"
      const isWarranty = action === WARRANTY_ACTION
      const { error } = await admin.from("order_audit_events").insert({
        order_id: orderId,
        actor_type: "admin",
        actor_id: actorId,
        action,
        previous_status: isStatus && typeof metadata.previousEstado === "string" ? metadata.previousEstado : isWarranty ? "pending_delivery" : null,
        new_status: isStatus && typeof metadata.newEstado === "string" ? metadata.newEstado : isWarranty ? "active" : null,
        metadata: { ...metadata, shippingProvider: LOCAL_DELIVERY_PROVIDER, localDeliveryEffect: effect, localDeliveryEffectState: state },
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
      return (await loadLocalPreparations(admin, [orderId])).get(orderId) ?? NO_PREPARATION
    },
    now: () => new Date().toISOString(),
  }
}

export async function GET(request: Request) {
  const auth = await requireOperator(request)
  if ("error" in auth) return auth.error

  const deliveredSince = new Date(Date.now() - RECENTLY_DELIVERED_DAYS * 86_400_000).toISOString()
  const base = () => {
    const query = auth.admin.from("ordenes").select(LIST_COLUMNS)
    return whereLocalDeliveryEligible<typeof query>(query)
  }
  const [active, delivered] = await Promise.all([
    base().in("estado", ["pagado", "preparado", "en_camino"]).order("id", { ascending: true }).limit(200),
    base().eq("estado", "entregado").gte("delivered_at", deliveredSince).order("delivered_at", { ascending: false }).limit(50),
  ])
  if (active.error || delivered.error) {
    return Response.json({ error: "No se pudieron cargar las entregas locales." }, { status: 500 })
  }
  const rows = [...(active.data ?? []), ...(delivered.data ?? [])] as LocalDeliveryRow[]
  const ids = rows.map((row) => row.id)
  // Efectos pendientes (auditoría, garantía, email) para "Reintentar avisos".
  const [markers, warranties] = ids.length
    ? await Promise.all([
        auth.admin.from("order_audit_events").select("order_id,metadata,created_at").in("order_id", ids).in("action", EFFECT_ACTIONS),
        auth.admin.from("orden_items").select("orden_id,warranty_started_at,warranty_expires_at,warranty_status").in("orden_id", ids)
          .is("warranty_started_at", null).is("warranty_expires_at", null),
      ])
    : [{ data: [], error: null }, { data: [], error: null }]
  if (markers.error || warranties.error) {
    return Response.json({ error: "No se pudieron cargar las entregas locales." }, { status: 500 })
  }
  const rowsByOrder = new Map<number, Array<{ metadata: unknown; created_at: string }>>()
  for (const row of markers.data ?? []) rowsByOrder.set(row.order_id, [...(rowsByOrder.get(row.order_id) ?? []), row])
  const nowMs = Date.now()
  const pendingWarranties = new Map<number, number>()
  for (const item of warranties.data ?? []) {
    if (isPendingWarrantyItem(item)) pendingWarranties.set(item.orden_id, (pendingWarranties.get(item.orden_id) ?? 0) + 1)
  }
  let preparations: Map<number, LocalDeliveryPreparation>
  try {
    preparations = await loadLocalPreparations(auth.admin, rows.filter((row) => getLocalDeliveryStage(row) === "preparing").map((row) => row.id))
  } catch {
    return Response.json({ error: "No se pudieron cargar las entregas locales." }, { status: 500 })
  }

  return Response.json({
    orders: rows.map((row) => {
      const stage = getLocalDeliveryStage(row)
      const preparation = preparations.get(row.id) ?? NO_PREPARATION
      return {
        ...row,
        stage,
        // Preparando: qué falta (pickeo, bultos, etiquetas) para entregarlo al cadete.
        ...(stage === "preparing" ? { preparation, preparationError: getLocalDeliveryPreparationError(preparation) } : {}),
        pendingEffects: getMissingLocalDeliveryEffects(
          stage,
          summarizeLocalDeliveryEffects(effectRecords(rowsByOrder.get(row.id) ?? []), nowMs),
          pendingWarranties.get(row.id) ?? 0,
        ),
      }
    }),
  }, { headers: { "Cache-Control": "no-store" } })
}

export async function POST(request: Request) {
  const auth = await requireOperator(request)
  if ("error" in auth) return auth.error

  const body = await request.json().catch(() => null) as { orderId?: unknown; action?: unknown } | null
  const orderId = Number(body?.orderId)
  const action = body?.action
  if (!Number.isSafeInteger(orderId) || orderId <= 0 || (!isLocalDeliveryAction(action) && action !== "retry_effects")) {
    return Response.json({ error: "La acción de entrega no es válida." }, { status: 400 })
  }

  const deps = serviceDeps(auth.admin, auth.user.id)
  try {
    const result = action === "retry_effects"
      ? await retryLocalDeliveryEffects(deps, orderId)
      : await advanceLocalDelivery(deps, orderId, action)
    return Response.json(result.body, { status: result.status })
  } catch {
    return Response.json({ error: "No se pudo actualizar la entrega." }, { status: 500 })
  }
}
