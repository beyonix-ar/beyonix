import { requireOperator } from "@/app/api/admin/clientes/_auth"
import { sendOrderStateEmail } from "@/lib/orders/order-status-notifications"
import { activatePendingItemWarranties } from "@/lib/orders/warranty-activation"
import { getLocalDeliveryStage, isLocalDeliveryAction } from "@/lib/orders/local-delivery-status"
import {
  advanceLocalDelivery,
  getMissingLocalDeliveryEffects,
  LOCAL_DELIVERY_EFFECTS_BY_STAGE,
  retryLocalDeliveryEffects,
  type LocalDeliveryEffect,
  type LocalDeliveryOrderRecord,
  type LocalDeliveryServiceDeps,
} from "@/lib/orders/local-delivery-service"
import { LOCAL_DELIVERY_PROVIDER } from "@/lib/shipping/local-delivery"

// Envío BEYONIX: circuito local mínimo, separado de Andreani (sin etiqueta,
// guía ni Bulto). Lo opera cualquier operador interno: a diferencia de
// Andreani, nadie más informa "en camino" o "entregado".
const LIST_COLUMNS =
  "id,estado,created_at,paid_at,delivered_at,cliente_nombre,cliente_telefono,cliente_direccion,localidad,cp_destino"
const ORDER_COLUMNS =
  "id,estado,shipping_provider,envio_proveedor,delivered_at,cancelled_at,financial_status,order_change_status,paid_at,payment_status,payment_confirmed_amount,shipping_cost_real,cliente_email,cliente_nombre"
const RECENTLY_DELIVERED_DAYS = 3
// Marcas de efectos en order_audit_events (metadata.localDeliveryEffect).
const EFFECT_ACTIONS = ["order_status_changed", "local_delivery_email_sent"]
const ALL_EFFECTS = new Set<string>(Object.values(LOCAL_DELIVERY_EFFECTS_BY_STAGE).flat())

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

function effectOf(metadata: unknown): LocalDeliveryEffect | null {
  const value = metadata && typeof metadata === "object" ? (metadata as Record<string, unknown>).localDeliveryEffect : null
  return typeof value === "string" && ALL_EFFECTS.has(value) ? value as LocalDeliveryEffect : null
}

function isPendingWarrantyItem(item: { warranty_status: string | null }) {
  return item.warranty_status === null || item.warranty_status === "pending_delivery"
}

function serviceDeps(admin: AdminClient, actorId: string): LocalDeliveryServiceDeps {
  return {
    async loadOrder(orderId) {
      const { data, error } = await admin.from("ordenes").select(ORDER_COLUMNS).eq("id", orderId).maybeSingle()
      if (error) throw new Error("ORDER_READ_FAILED")
      return data as LocalDeliveryOrderRecord | null
    },
    async transitionOrder({ orderId, fromEstado, action, deliveredAt }) {
      // Atómico: estado de origen, proveedor, pago confirmado y sin
      // cancelación tienen que seguir siendo ciertos al escribir.
      const { data, error } = await admin
        .from("ordenes")
        .update({ estado: action, ...(deliveredAt ? { delivered_at: deliveredAt } : {}) })
        .eq("id", orderId)
        .eq("estado", fromEstado)
        .eq("shipping_provider", LOCAL_DELIVERY_PROVIDER)
        .eq("financial_status", "payment_confirmed")
        .is("cancelled_at", null)
        .select(ORDER_COLUMNS)
        .maybeSingle()
      if (error) throw new Error("ORDER_TRANSITION_FAILED")
      return data as LocalDeliveryOrderRecord | null
    },
    async loadEffectMarkers(orderId) {
      const { data, error } = await admin
        .from("order_audit_events").select("metadata").eq("order_id", orderId).in("action", EFFECT_ACTIONS)
      if (error) throw new Error("EFFECT_MARKERS_READ_FAILED")
      return new Set((data ?? []).map((row) => effectOf(row.metadata)).filter((effect): effect is LocalDeliveryEffect => effect !== null))
    },
    async recordEffect(orderId, effect, metadata) {
      const isEmail = effect.endsWith("_email")
      const newEstado = typeof metadata.newEstado === "string" ? metadata.newEstado : null
      const { data, error } = await admin.from("order_audit_events").insert({
        order_id: orderId,
        actor_type: "admin",
        actor_id: actorId,
        action: isEmail ? "local_delivery_email_sent" : "order_status_changed",
        previous_status: isEmail ? null : (typeof metadata.previousEstado === "string" ? metadata.previousEstado : null),
        new_status: isEmail ? null : newEstado,
        metadata: { ...metadata, shippingProvider: LOCAL_DELIVERY_PROVIDER, localDeliveryEffect: effect },
      }).select("id").single()
      if (error || !data) throw new Error("EFFECT_RECORD_FAILED")
      return String(data.id)
    },
    async removeEffect(markerId) {
      const { error } = await admin.from("order_audit_events").delete().eq("id", markerId).eq("action", "local_delivery_email_sent")
      if (error) throw new Error("EFFECT_RELEASE_FAILED")
    },
    activateWarranties(orderId, deliveredAt) {
      return activatePendingItemWarranties(admin, { orderId, deliveredAt, actorType: "admin", actorId })
    },
    async countPendingWarranties(orderId) {
      const { data, error } = await admin.from("orden_items").select("warranty_status")
        .eq("orden_id", orderId).is("warranty_started_at", null).is("warranty_expires_at", null)
      if (error) throw new Error("WARRANTY_READ_FAILED")
      return (data ?? []).filter(isPendingWarrantyItem).length
    },
    sendStateEmail: (order) => sendOrderStateEmail(order),
    now: () => new Date().toISOString(),
  }
}

export async function GET(request: Request) {
  const auth = await requireOperator(request)
  if ("error" in auth) return auth.error

  const deliveredSince = new Date(Date.now() - RECENTLY_DELIVERED_DAYS * 86_400_000).toISOString()
  const base = () => auth.admin.from("ordenes").select(LIST_COLUMNS)
    .eq("shipping_provider", LOCAL_DELIVERY_PROVIDER)
    .eq("financial_status", "payment_confirmed")
    .is("cancelled_at", null)
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
        auth.admin.from("order_audit_events").select("order_id,metadata").in("order_id", ids).in("action", EFFECT_ACTIONS),
        auth.admin.from("orden_items").select("orden_id,warranty_status").in("orden_id", ids)
          .is("warranty_started_at", null).is("warranty_expires_at", null),
      ])
    : [{ data: [], error: null }, { data: [], error: null }]
  if (markers.error || warranties.error) {
    return Response.json({ error: "No se pudieron cargar las entregas locales." }, { status: 500 })
  }
  const completed = new Map<number, Set<LocalDeliveryEffect>>()
  for (const row of markers.data ?? []) {
    const effect = effectOf(row.metadata)
    if (!effect) continue
    const set = completed.get(row.order_id) ?? new Set<LocalDeliveryEffect>()
    set.add(effect)
    completed.set(row.order_id, set)
  }
  const pendingWarranties = new Map<number, number>()
  for (const item of warranties.data ?? []) {
    if (isPendingWarrantyItem(item)) pendingWarranties.set(item.orden_id, (pendingWarranties.get(item.orden_id) ?? 0) + 1)
  }

  return Response.json({
    orders: rows.map((row) => {
      const stage = getLocalDeliveryStage(row)
      return {
        ...row,
        stage,
        pendingEffects: getMissingLocalDeliveryEffects(stage, completed.get(row.id) ?? new Set(), pendingWarranties.get(row.id) ?? 0),
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
