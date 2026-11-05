"use client"

import { useCallback, useEffect, useState } from "react"
import { Bike, CheckCircle2, PackageCheck, RotateCcw, Truck, Undo2 } from "lucide-react"

import { AdminButton, AdminEmptyState, AdminPrimaryButton, AdminSection } from "@/app/admin/components/admin-controls"
import { orderCode } from "@/lib/admin/dispatch"
import { dispatchLocationHref } from "@/lib/admin/dispatch-location"
import {
  getNextLocalDeliveryAction,
  LOCAL_DELIVERY_STAGE_LABELS,
  type LocalDeliveryAction,
  type LocalDeliveryStage,
} from "@/lib/orders/local-delivery-status"
import { LOCAL_DELIVERY_EFFECT_LABELS, type LocalDeliveryEffect } from "@/lib/orders/local-delivery-service"
import { LOCAL_DELIVERY_NAME } from "@/lib/shipping/local-delivery"
import {
  describeAdminLocalDeliveryReservation,
  LOCAL_DELIVERY_INCIDENT_REASON_LABELS,
  LOCAL_DELIVERY_OUTCOME_LABELS,
  type AdminLocalDeliveryOutcome,
  type LocalDeliveryOutcomeStatus,
} from "@/lib/shipping/local-delivery-outcome"
import { dispatchRequest } from "./dispatch-request"
import { LocalDeliveryReturns } from "./local-delivery-returns"

interface LocalDeliveryRecord {
  id: number
  estado: string
  stage: LocalDeliveryStage
  cliente_nombre: string | null
  cliente_telefono: string | null
  cliente_direccion: string | null
  localidad: string | null
  cp_destino: string | null
  /** Auditoría, garantía o email que fallaron y se pueden reintentar. */
  pendingEffects?: LocalDeliveryEffect[]
  /** Preparando: qué falta (pickeo, bultos, etiquetas BEYONIX) para entregarlo al cadete. */
  preparationError?: string | null
  /** Resultado informado por el cadete (QR), retorno y reserva. */
  outcome?: AdminLocalDeliveryOutcome | null
}

type PanelAction = LocalDeliveryAction | "retry_effects" | "incident_retry" | "incident_return"

const STAGE_TONE: Record<LocalDeliveryStage, string> = {
  preparing: "border-amber-300/35 bg-amber-300/10 text-amber-100",
  in_transit: "border-sky-300/35 bg-sky-300/10 text-sky-100",
  delivered: "border-emerald-300/35 bg-emerald-300/10 text-emerald-100",
}
const OUTCOME_TONE: Partial<Record<LocalDeliveryOutcomeStatus, string>> = {
  first_attempt_failed: "border-amber-300/45 bg-amber-300/15 text-amber-100",
  incident: "border-red-300/45 bg-red-400/15 text-red-100",
  returning: "border-orange-300/45 bg-orange-300/15 text-orange-100",
  returned: "border-violet-300/45 bg-violet-300/15 text-violet-100",
}
/** Con el pedido regresando o devuelto ya no se entrega (la base también lo impide). */
const NO_DELIVERY_OUTCOMES = new Set<LocalDeliveryOutcomeStatus>(["returning", "returned"])

const CONFIRMATIONS: Partial<Record<PanelAction, (code: string) => string>> = {
  entregado: (code) => `¿Confirmás que ${code} fue entregado al cliente?`,
  incident_retry: (code) => `¿Reintentar la entrega de ${code}? El cadete podrá volver a registrar el resultado.`,
  incident_return: (code) => `¿Confirmás que ${code} debe regresar a BEYONIX?`,
}

/**
 * Envío BEYONIX: entregas locales propias, fuera del circuito de Andreani
 * (sin guía, etiqueta ni Bulto general Andreani; el pickeo, los bultos y la
 * etiqueta BEYONIX se hacen en Despachos). Preparando → En camino → Entregado,
 * con el resultado del cadete (QR): intento fallido, incidencia y retorno.
 */
export function LocalDeliveryPanel({ refreshSignal }: { refreshSignal?: unknown }) {
  const [orders, setOrders] = useState<LocalDeliveryRecord[] | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")

  const load = useCallback(async () => {
    try {
      const data = await dispatchRequest<{ orders?: unknown }>("/local")
      setOrders(Array.isArray(data.orders) ? data.orders as LocalDeliveryRecord[] : [])
      setError("")
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudieron cargar las entregas locales.")
    }
  }, [])

  // Se recarga con el mismo "Actualizar" (y las actualizaciones en vivo) de Despachos.
  useEffect(() => { void load() }, [load, refreshSignal])

  async function advance(order: LocalDeliveryRecord, action: PanelAction) {
    if (busyId !== null) return
    const confirmation = CONFIRMATIONS[action]
    if (confirmation && !window.confirm(confirmation(orderCode(order.id)))) return
    setBusyId(order.id)
    setError("")
    setNotice("")
    try {
      const result = await dispatchRequest<{ warning?: string }>("/local", { orderId: order.id, action })
      // El estado quedó guardado; si un aviso falló se informa para reintentar.
      if (result.warning) setNotice(`${orderCode(order.id)}: ${result.warning}`)
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo actualizar la entrega.")
    } finally {
      setBusyId(null)
    }
  }

  // Sin pedidos locales (ni error) no ocupa lugar en Despachos.
  if (orders !== null && orders.length === 0 && !error) return null

  const returning = (orders ?? []).filter((order) => order.outcome?.status === "returning")

  // Devueltos a BEYONIX: ya no están en reparto; se listan aparte (reserva y
  // coordinación con el cliente) y nunca se mezclan con el trabajo operativo.
  const returnedOrders = (orders ?? []).filter((order) => order.outcome?.status === "returned")
  const workOrders = (orders ?? []).filter((order) => order.outcome?.status !== "returned")

  const renderOrder = (order: LocalDeliveryRecord) => {
    const busy = busyId === order.id
    const outcome = order.outcome ?? null
    const blocked = outcome ? NO_DELIVERY_OUTCOMES.has(outcome.status) : false
    // Sólo el siguiente paso: Preparando → En camino → Entregado.
    const next = blocked ? null : getNextLocalDeliveryAction(order.stage)
    const pending = order.pendingEffects ?? []
    const incident = outcome?.status === "incident" ? outcome.incident : null
    const reservation = describeAdminLocalDeliveryReservation(outcome?.reservation ?? null)
    const outcomeTone = outcome ? OUTCOME_TONE[outcome.status] : undefined
    // En camino exige pickeo, bultos y etiquetas BEYONIX confirmadas (el servidor lo vuelve a validar).
    const notReady = next === "en_camino" ? order.preparationError ?? null : null
    return (
      <li key={order.id} data-local-delivery-order={order.id} data-local-delivery-stage={order.stage} data-local-delivery-outcome={outcome?.status}
        className="flex flex-col gap-2 rounded-xl border border-white/10 bg-black/20 p-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 text-sm font-black text-white">
            <span className="tabular-nums">{orderCode(order.id)}</span>
            {/* Con resultado del cadete, ese estado reemplaza a "En camino" (nunca dos estados a la vez). */}
            {!(outcome && outcomeTone) && (
              <span className={`rounded-full border px-2 py-0.5 text-10px font-black uppercase tracking-wide ${STAGE_TONE[order.stage]}`}>
                {LOCAL_DELIVERY_STAGE_LABELS[order.stage]}
              </span>
            )}
            {outcome && outcomeTone && (
              <span className={`rounded-full border px-2 py-0.5 text-10px font-black uppercase tracking-wide ${outcomeTone}`} data-local-delivery-outcome-label="">
                {LOCAL_DELIVERY_OUTCOME_LABELS[outcome.status]}
              </span>
            )}
          </p>
          <p className="mt-0.5 truncate text-xs text-white/70">
            {[order.cliente_nombre, order.cliente_direccion, order.localidad, order.cp_destino && `CP ${order.cp_destino}`, order.cliente_telefono]
              .filter(Boolean).join(" · ")}
          </p>
          {outcome && outcome.failedAttempts > 0 && (
            <p className="mt-0.5 text-xs font-bold text-amber-200" data-local-delivery-attempts={outcome.failedAttempts}>
              {outcome.failedAttempts === 1 ? "1 intento fallido (cliente ausente) · pendiente segundo intento" : "2 intentos fallidos (cliente ausente)"}
            </p>
          )}
          {incident && (
            <p className="mt-0.5 text-xs font-bold text-red-200" data-local-delivery-incident={incident.reason}>
              Incidencia: {LOCAL_DELIVERY_INCIDENT_REASON_LABELS[incident.reason]}{incident.comment ? ` — “${incident.comment}”` : ""}
            </p>
          )}
          {outcome?.status === "returning" && (
            <p className="mt-0.5 text-xs font-bold text-amber-200">El cadete debe traer los bultos: recibilos abajo, en “Recibir devolución local”.</p>
          )}
          {reservation && (
            <p className="mt-0.5 text-xs font-bold text-sky-200" data-local-delivery-reservation={outcome?.reservation?.status}>
              {reservation.label} · {reservation.detail}
            </p>
          )}
          {notReady && <p className="mt-0.5 text-xs font-bold text-amber-200" data-local-delivery-preparation="">{notReady}</p>}
          {pending.length > 0 && (
            <p className="mt-0.5 text-xs font-bold text-amber-200" data-local-delivery-pending={pending.join(",")}>
              Pendiente: {[...new Set(pending.map((effect) => LOCAL_DELIVERY_EFFECT_LABELS[effect]))].join(", ")}
            </p>
          )}
        </div>
        {(next || pending.length > 0 || incident) && (
          <div className="flex shrink-0 flex-wrap gap-2">
            {pending.length > 0 && (
              <AdminButton size="sm" disabled={busy} icon={<RotateCcw className="size-4" />} onClick={() => void advance(order, "retry_effects")}>
                Reintentar avisos
              </AdminButton>
            )}
            {next === "en_camino" && (
              // Mismo pickeo, bultos y etiqueta BEYONIX de Despachos (sin Andreani).
              <a href={dispatchLocationHref({ orderId: order.id, batchId: null })} className="admin-ds-button admin-ds-button-secondary inline-flex min-h-8 cursor-pointer items-center justify-center gap-2 px-3 py-1.5 text-xs font-black" data-local-delivery-prepare="">
                <PackageCheck className="size-4" />{notReady ? "Preparar" : "Ver preparación"}
              </a>
            )}
            {next === "en_camino" && (
              <AdminButton size="sm" disabled={busy || Boolean(notReady)} icon={<Truck className="size-4" />} onClick={() => void advance(order, "en_camino")}>
                Marcar en camino
              </AdminButton>
            )}
            {incident && (
              <AdminButton size="sm" disabled={busy} icon={<RotateCcw className="size-4" />} onClick={() => void advance(order, "incident_retry")}>
                Reintentar entrega
              </AdminButton>
            )}
            {incident && (
              <AdminButton size="sm" disabled={busy} icon={<Undo2 className="size-4" />} onClick={() => void advance(order, "incident_return")}>
                Regresar a BEYONIX
              </AdminButton>
            )}
            {next === "entregado" && (
              <AdminPrimaryButton size="sm" disabled={busy} onClick={() => void advance(order, "entregado")}>
                <CheckCircle2 className="size-4" />
                Marcar entregado
              </AdminPrimaryButton>
            )}
          </div>
        )}
      </li>
    )
  }

  return (
    <AdminSection
      compact
      className="dispatch-surface"
      title={`Entregas locales · ${LOCAL_DELIVERY_NAME}`}
      icon={<Bike className="size-4" />}
      data-local-delivery-panel=""
    >
      {error && <div role="alert" className="mb-3 rounded-xl border border-red-500/35 bg-red-950 p-3 text-sm text-white">{error}</div>}
      {notice && <p role="status" className="mb-3 text-sm font-bold text-amber-200" data-local-delivery-notice="">{notice}</p>}
      {orders === null ? (
        <p role="status" className="text-sm text-white/70">Cargando…</p>
      ) : orders.length === 0 ? (
        <AdminEmptyState title="No hay entregas locales pendientes" description="Los pedidos con Envío BEYONIX aparecen acá al confirmarse el pago." />
      ) : (
        <>
          <ul className="space-y-2" data-local-delivery-queue="operational">
            {workOrders.map((order) => renderOrder(order))}
          </ul>
          {/* Recepción física pendiente = trabajo operativo: antes de la lista de devueltos. */}
          {returning.length > 0 && (
            <LocalDeliveryReturns
              orders={returning.map((order) => ({ id: order.id, cliente_nombre: order.cliente_nombre, returnParcels: order.outcome?.returnParcels ?? [] }))}
              onChanged={load}
              onCompleted={setNotice}
            />
          )}
          {returnedOrders.length > 0 && (
            <div className="mt-3" data-local-delivery-returned="">
              <p className="mb-1.5 text-xs font-black uppercase tracking-wide text-white/70">Devueltos a BEYONIX · coordinación con el cliente</p>
              <ul className="space-y-2" data-local-delivery-queue="returned">
                {returnedOrders.map((order) => renderOrder(order))}
              </ul>
            </div>
          )}
        </>
      )}
    </AdminSection>
  )
}
