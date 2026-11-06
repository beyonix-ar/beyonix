"use client"

import { useCallback, useEffect, useState } from "react"
import { AlertTriangle, Bike, CheckCircle2, Clock3, Eye, PackageCheck, RotateCcw, Truck, Undo2 } from "lucide-react"

import { AdminBadge, AdminButton, AdminEmptyState, AdminPrimaryButton, AdminSection } from "@/app/admin/components/admin-controls"
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
import { splitDeliveryAddress } from "@/lib/shipping/local-delivery-label"
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
  /** Historial, garantía o email todavía sin completar (se reintentan solos). */
  pendingEffects?: LocalDeliveryEffect[]
  /** Pendientes cuyo reintento automático se agotó: requieren atención. */
  exhaustedEffects?: LocalDeliveryEffect[]
  /** Preparando: qué falta (pickeo, bultos, etiquetas BEYONIX) para entregarlo al cadete. */
  preparationError?: string | null
  /** Resultado informado por el cadete (QR), retorno y reserva. */
  outcome?: AdminLocalDeliveryOutcome | null
}

type PanelAction = LocalDeliveryAction | "retry_effects" | "incident_retry" | "incident_return"

type BadgeTone = "neutral" | "info" | "success" | "warning" | "danger"

const STAGE_TONE: Record<LocalDeliveryStage, BadgeTone> = {
  preparing: "warning",
  in_transit: "info",
  delivered: "success",
}
const OUTCOME_TONE: Partial<Record<LocalDeliveryOutcomeStatus, BadgeTone>> = {
  first_attempt_failed: "warning",
  incident: "danger",
  returning: "warning",
  returned: "neutral",
}

const effectLabels = (effects: readonly LocalDeliveryEffect[]) =>
  [...new Set(effects.map((effect) => LOCAL_DELIVERY_EFFECT_LABELS[effect]))].join(", ")
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
    const code = orderCode(order.id)
    const outcome = order.outcome ?? null
    const blocked = outcome ? NO_DELIVERY_OUTCOMES.has(outcome.status) : false
    // Sólo el siguiente paso: Preparando → En camino → Entregado.
    const next = blocked ? null : getNextLocalDeliveryAction(order.stage)
    const pending = order.pendingEffects ?? []
    const exhausted = order.exhaustedEffects ?? []
    const pendingLabels = effectLabels(pending)
    const incident = outcome?.status === "incident" ? outcome.incident : null
    const reservation = describeAdminLocalDeliveryReservation(outcome?.reservation ?? null)
    // Con resultado del cadete, ese estado reemplaza a "En camino" (nunca dos estados a la vez).
    const outcomeTone = outcome ? OUTCOME_TONE[outcome.status] : undefined
    // En camino exige pickeo, bultos y etiquetas BEYONIX confirmadas (el servidor lo vuelve a validar).
    const notReady = next === "en_camino" ? order.preparationError ?? null : null
    // Vista principal: destinatario, calle y zona. Referencia y teléfono, en el
    // detalle del pedido (y en el title, sin ocupar lugar).
    const { address, reference } = splitDeliveryAddress(order.cliente_direccion)
    const zone = [order.localidad, order.cp_destino && `CP ${order.cp_destino}`].filter(Boolean).join(" · ")
    const recipient = [order.cliente_nombre, address, zone].filter(Boolean).join(" · ")
    const recipientDetail = [recipient, reference && `Ref.: ${reference}`, order.cliente_telefono && `Tel.: ${order.cliente_telefono}`].filter(Boolean).join(" · ")
    // Una sola línea operativa: lo que hay que hacer o saber ahora.
    const attempts = outcome && outcome.failedAttempts > 0
      ? (outcome.failedAttempts === 1 ? "1 intento fallido (cliente ausente) · pendiente segundo intento" : "2 intentos fallidos (cliente ausente)")
      : null
    return (
      <li key={order.id} data-local-delivery-order={order.id} data-local-delivery-stage={order.stage} data-local-delivery-outcome={outcome?.status}
        className="local-delivery-row grid gap-x-3 gap-y-2 rounded-xl border border-white/10 bg-black/20 px-3 py-2.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-1.5 text-sm font-black text-white">
            <span className="tabular-nums">{code}</span>
            {outcome && outcomeTone ? (
              <AdminBadge tone={outcomeTone} className="local-delivery-badge" data-tone={outcomeTone} data-local-delivery-outcome-label="">
                {LOCAL_DELIVERY_OUTCOME_LABELS[outcome.status]}
              </AdminBadge>
            ) : (
              <AdminBadge tone={STAGE_TONE[order.stage]} className="local-delivery-badge" data-tone={STAGE_TONE[order.stage]}>
                {LOCAL_DELIVERY_STAGE_LABELS[order.stage]}
              </AdminBadge>
            )}
            {pending.length > 0 && (
              <AdminBadge
                tone={exhausted.length ? "danger" : "neutral"}
                className="local-delivery-badge"
                data-tone={exhausted.length ? "danger" : "neutral"}
                data-local-delivery-pending={pending.join(",")}
                data-local-delivery-exhausted={exhausted.length ? exhausted.join(",") : undefined}
                title={exhausted.length
                  ? `No se pudo completar: ${pendingLabels}. Revisá la configuración y reintentá.`
                  : `Pendiente: ${pendingLabels}. Se reintenta automáticamente.`}
              >
                {exhausted.length ? <AlertTriangle className="size-3" aria-hidden /> : <Clock3 className="size-3" aria-hidden />}
                {exhausted.length ? "Avisos con error" : "Avisos en curso"}
              </AdminBadge>
            )}
          </p>
          <p className="mt-1 truncate text-xs text-white/70" title={recipientDetail || undefined} data-local-delivery-recipient="">
            {recipient || "—"}
          </p>
          {attempts && (
            <p className="mt-0.5 text-xs font-bold text-amber-200" data-local-delivery-attempts={outcome?.failedAttempts}>{attempts}</p>
          )}
          {incident && (
            <p className="mt-0.5 truncate text-xs font-bold text-red-200" data-local-delivery-incident={incident.reason}
              title={incident.comment ? `Incidencia: ${LOCAL_DELIVERY_INCIDENT_REASON_LABELS[incident.reason]} — “${incident.comment}”` : undefined}>
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
          {exhausted.length > 0 && (
            <p className="mt-0.5 text-xs font-bold text-red-200" data-local-delivery-effects-error="">
              Sin completar: {effectLabels(exhausted)}.
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5 sm:justify-end">
          <a href={`/admin/pedidos/${order.id}`} aria-label={`Ver pedido ${code}`} title="Ver pedido (datos completos)"
            className="admin-ds-button admin-ds-button-ghost inline-flex size-8 shrink-0 cursor-pointer items-center justify-center" data-local-delivery-detail="">
            <Eye className="size-4" aria-hidden />
          </a>
          {pending.length > 0 && (
            <AdminButton size="sm" variant="ghost" disabled={busy} className="size-8 shrink-0 px-0"
              aria-label="Reintentar avisos" title={`Reintentar ahora: ${pendingLabels}`}
              icon={<RotateCcw className="size-4" aria-hidden />} onClick={() => void advance(order, "retry_effects")} />
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
