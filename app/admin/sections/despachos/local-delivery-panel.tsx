"use client"

import { useCallback, useEffect, useState } from "react"
import { Bike, CheckCircle2, RotateCcw, Truck } from "lucide-react"

import { AdminButton, AdminEmptyState, AdminPrimaryButton, AdminSection } from "@/app/admin/components/admin-controls"
import { orderCode } from "@/lib/admin/dispatch"
import {
  getNextLocalDeliveryAction,
  LOCAL_DELIVERY_STAGE_LABELS,
  type LocalDeliveryAction,
  type LocalDeliveryStage,
} from "@/lib/orders/local-delivery-status"
import { LOCAL_DELIVERY_EFFECT_LABELS, type LocalDeliveryEffect } from "@/lib/orders/local-delivery-service"
import { LOCAL_DELIVERY_NAME } from "@/lib/shipping/local-delivery"
import { dispatchRequest } from "./dispatch-request"

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
}

type PanelAction = LocalDeliveryAction | "retry_effects"

const STAGE_TONE: Record<LocalDeliveryStage, string> = {
  preparing: "border-amber-300/35 bg-amber-300/10 text-amber-100",
  in_transit: "border-sky-300/35 bg-sky-300/10 text-sky-100",
  delivered: "border-emerald-300/35 bg-emerald-300/10 text-emerald-100",
}

/**
 * Envío BEYONIX: entregas locales propias, fuera del circuito de Andreani
 * (sin etiqueta, guía ni Bulto). Preparando → En camino → Entregado.
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
    if (action === "entregado" && !window.confirm(`¿Confirmás que ${orderCode(order.id)} fue entregado al cliente?`)) return
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

  return (
    <AdminSection
      compact
      className="dispatch-surface"
      title={`Entregas locales · ${LOCAL_DELIVERY_NAME}`}
      icon={<Bike className="size-4" />}
      data-local-delivery-panel=""
    >
      {error && <div role="alert" className="mb-3 rounded-xl border border-red-500/35 bg-red-950 p-3 text-sm text-white">{error}</div>}
      {notice && <p role="status" className="mb-3 text-sm font-bold text-amber-200">{notice}</p>}
      {orders === null ? (
        <p role="status" className="text-sm text-white/70">Cargando…</p>
      ) : orders.length === 0 ? (
        <AdminEmptyState title="No hay entregas locales pendientes" description="Los pedidos con Envío BEYONIX aparecen acá al confirmarse el pago." />
      ) : (
        <ul className="space-y-2">
          {orders.map((order) => {
            const busy = busyId === order.id
            // Sólo el siguiente paso: Preparando → En camino → Entregado.
            const next = getNextLocalDeliveryAction(order.stage)
            const pending = order.pendingEffects ?? []
            return (
              <li key={order.id} data-local-delivery-order={order.id} data-local-delivery-stage={order.stage}
                className="flex flex-col gap-2 rounded-xl border border-white/10 bg-black/20 p-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-black text-white">
                    <span className="tabular-nums">{orderCode(order.id)}</span>
                    <span className={`rounded-full border px-2 py-0.5 text-10px font-black uppercase tracking-wide ${STAGE_TONE[order.stage]}`}>
                      {LOCAL_DELIVERY_STAGE_LABELS[order.stage]}
                    </span>
                  </p>
                  <p className="mt-0.5 truncate text-xs text-white/70">
                    {[order.cliente_nombre, order.cliente_direccion, order.localidad, order.cp_destino && `CP ${order.cp_destino}`, order.cliente_telefono]
                      .filter(Boolean).join(" · ")}
                  </p>
                  {pending.length > 0 && (
                    <p className="mt-0.5 text-xs font-bold text-amber-200" data-local-delivery-pending={pending.join(",")}>
                      Pendiente: {[...new Set(pending.map((effect) => LOCAL_DELIVERY_EFFECT_LABELS[effect]))].join(", ")}
                    </p>
                  )}
                </div>
                {(next || pending.length > 0) && (
                  <div className="flex shrink-0 flex-wrap gap-2">
                    {pending.length > 0 && (
                      <AdminButton size="sm" disabled={busy} icon={<RotateCcw className="size-4" />} onClick={() => void advance(order, "retry_effects")}>
                        Reintentar avisos
                      </AdminButton>
                    )}
                    {next === "en_camino" && (
                      <AdminButton size="sm" disabled={busy} icon={<Truck className="size-4" />} onClick={() => void advance(order, "en_camino")}>
                        Marcar en camino
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
          })}
        </ul>
      )}
    </AdminSection>
  )
}
