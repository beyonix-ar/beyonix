import { requireOperator } from "@/app/api/admin/clientes/_auth"
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
  retryLocalDeliveryEffects,
  summarizeLocalDeliveryEffects,
} from "@/lib/orders/local-delivery-service"
import {
  LOCAL_DELIVERY_EFFECT_ACTIONS,
  loadLocalPreparations,
  localDeliveryEffectRecords,
  localDeliveryServiceDeps,
  NO_LOCAL_DELIVERY_PREPARATION,
  whereLocalDeliveryEligible,
} from "@/lib/orders/local-delivery-deps"
import { loadAdminLocalDeliveryOutcomes } from "@/lib/orders/local-delivery-outcomes-server"
import { isInTransitEmailObsolete } from "@/lib/shipping/local-delivery-outcome"

// Envío BEYONIX: circuito local mínimo, separado de Andreani (sin guía ni
// Bulto general Andreani). Lo opera cualquier operador interno: a diferencia de
// Andreani, nadie más informa "en camino" o "entregado" (salvo el cadete desde
// el QR de la etiqueta, con la misma lógica canónica).
const LIST_COLUMNS =
  "id,estado,created_at,paid_at,delivered_at,cliente_nombre,cliente_telefono,cliente_direccion,localidad,cp_destino"
const RECENTLY_DELIVERED_DAYS = 3
// Cupos por cola: se aplican en la base DESPUÉS de separar por subestado de la
// entrega local (local_delivery_queue_order_ids). Un pedido Devuelto a BEYONIX
// sigue con ordenes.estado = 'en_camino' pero nunca ocupa el cupo operativo.
const OPERATIONAL_LIMIT = 200
const RETURNED_LIMIT = 100
const INCIDENT_ACTIONS = { incident_retry: "retry", incident_return: "return" } as const
type IncidentAction = keyof typeof INCIDENT_ACTIONS

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

const isIncidentAction = (value: unknown): value is IncidentAction =>
  typeof value === "string" && Object.hasOwn(INCIDENT_ACTIONS, value)

export async function GET(request: Request) {
  const auth = await requireOperator(request)
  if ("error" in auth) return auth.error

  const deliveredSince = new Date(Date.now() - RECENTLY_DELIVERED_DAYS * 86_400_000).toISOString()
  const base = () => {
    const query = auth.admin.from("ordenes").select(LIST_COLUMNS)
    return whereLocalDeliveryEligible<typeof query>(query)
  }
  const [operationalQueue, returnedQueue] = await Promise.all([
    auth.admin.rpc("local_delivery_queue_order_ids", { p_queue: "operational", p_limit: OPERATIONAL_LIMIT }),
    auth.admin.rpc("local_delivery_queue_order_ids", { p_queue: "returned", p_limit: RETURNED_LIMIT }),
  ])
  if (operationalQueue.error || returnedQueue.error) {
    return Response.json({ error: "No se pudieron cargar las entregas locales." }, { status: 500 })
  }
  const queueIds = (data: unknown) => (Array.isArray(data) ? data : []).map(Number).filter((id) => Number.isSafeInteger(id) && id > 0)
  const operationalIds = queueIds(operationalQueue.data)
  const returnedIds = queueIds(returnedQueue.data)
  const queuedIds = [...operationalIds, ...returnedIds]
  const [queued, delivered] = await Promise.all([
    // Misma elegibilidad otra vez al leer (las colas ya la aplican en la base).
    queuedIds.length ? base().in("id", queuedIds) : Promise.resolve({ data: [], error: null }),
    base().eq("estado", "entregado").gte("delivered_at", deliveredSince).order("delivered_at", { ascending: false }).limit(50),
  ])
  if (queued.error || delivered.error) {
    return Response.json({ error: "No se pudieron cargar las entregas locales." }, { status: 500 })
  }
  // Orden de las colas: operativos por pedido, devueltos con reserva activa primero.
  const queuedById = new Map(((queued.data ?? []) as LocalDeliveryRow[]).map((row) => [row.id, row]))
  const rows = [
    ...queuedIds.flatMap((id) => queuedById.get(id) ?? []),
    ...((delivered.data ?? []) as LocalDeliveryRow[]),
  ]
  const ids = rows.map((row) => row.id)
  // Efectos pendientes (auditoría, garantía, email) para "Reintentar avisos".
  const [markers, warranties] = ids.length
    ? await Promise.all([
        auth.admin.from("order_audit_events").select("order_id,metadata,created_at").in("order_id", ids).in("action", LOCAL_DELIVERY_EFFECT_ACTIONS),
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
  let loaded: [Map<number, LocalDeliveryPreparation>, Awaited<ReturnType<typeof loadAdminLocalDeliveryOutcomes>>]
  try {
    loaded = await Promise.all([
      loadLocalPreparations(auth.admin, rows.filter((row) => getLocalDeliveryStage(row) === "preparing").map((row) => row.id)),
      // Resultado del cadete, retorno y reserva: sólo de pedidos que ya salieron.
      loadAdminLocalDeliveryOutcomes(auth.admin, rows.filter((row) => row.estado === "en_camino").map((row) => row.id)),
    ])
  } catch {
    return Response.json({ error: "No se pudieron cargar las entregas locales." }, { status: 500 })
  }
  const [preparations, outcomes] = loaded

  return Response.json({
    orders: rows.map((row) => {
      const stage = getLocalDeliveryStage(row)
      const preparation = preparations.get(row.id) ?? NO_LOCAL_DELIVERY_PREPARATION
      return {
        ...row,
        stage,
        // Preparando: qué falta (pickeo, bultos, etiquetas) para entregarlo al cadete.
        ...(stage === "preparing" ? { preparation, preparationError: getLocalDeliveryPreparationError(preparation) } : {}),
        outcome: outcomes.get(row.id) ?? null,
        // El aviso "En camino" queda obsoleto si el pedido regresa o regresó a
        // BEYONIX: no se ofrece como pendiente (el reintento lo marca superseded).
        pendingEffects: getMissingLocalDeliveryEffects(
          stage,
          summarizeLocalDeliveryEffects(localDeliveryEffectRecords(rowsByOrder.get(row.id) ?? []), nowMs),
          pendingWarranties.get(row.id) ?? 0,
        ).filter((effect) => effect !== "in_transit_email" || !isInTransitEmailObsolete(outcomes.get(row.id)?.status)),
      }
    }),
  }, { headers: { "Cache-Control": "no-store" } })
}

const INCIDENT_ERRORS: Record<string, { status: number; message: string }> = {
  LOCAL_DELIVERY_STATE_CHANGED: { status: 409, message: "El pedido ya no tiene una incidencia abierta. Actualizá la lista." },
  DISPATCH_ORDER_NOT_FOUND: { status: 404, message: "No encontramos el pedido." },
}

export async function POST(request: Request) {
  const auth = await requireOperator(request)
  if ("error" in auth) return auth.error

  const body = await request.json().catch(() => null) as { orderId?: unknown; action?: unknown } | null
  const orderId = Number(body?.orderId)
  const action = body?.action
  if (!Number.isSafeInteger(orderId) || orderId <= 0 ||
      (!isLocalDeliveryAction(action) && action !== "retry_effects" && !isIncidentAction(action))) {
    return Response.json({ error: "La acción de entrega no es válida." }, { status: 400 })
  }

  try {
    if (isIncidentAction(action)) {
      const { error } = await auth.admin.rpc("resolve_local_delivery_incident", {
        p_order_id: orderId, p_actor_id: auth.user.id, p_resolution: INCIDENT_ACTIONS[action],
      })
      if (error) {
        const known = Object.entries(INCIDENT_ERRORS).find(([code]) => error.message?.includes(code))?.[1]
        return Response.json({ error: known?.message ?? "No se pudo resolver la incidencia." }, { status: known?.status ?? 500 })
      }
      return Response.json({ ok: true })
    }
    if (action === "entregado") {
      // Mensaje claro antes de intentar: la base igual lo rechaza (guard_local_delivery_outcome).
      const outcome = (await loadAdminLocalDeliveryOutcomes(auth.admin, [orderId])).get(orderId)
      if (outcome?.status === "returning" || outcome?.status === "returned") {
        return Response.json({ error: "El pedido está regresando o ya regresó a BEYONIX: no se puede marcar entregado." }, { status: 409 })
      }
    }
    const deps = localDeliveryServiceDeps(auth.admin, { type: "admin", id: auth.user.id })
    const result = action === "retry_effects"
      ? await retryLocalDeliveryEffects(deps, orderId)
      : await advanceLocalDelivery(deps, orderId, action)
    return Response.json(result.body, { status: result.status })
  } catch {
    return Response.json({ error: "No se pudo actualizar la entrega." }, { status: 500 })
  }
}
