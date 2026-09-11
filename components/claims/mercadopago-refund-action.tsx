"use client"

import { useState } from "react"
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw } from "lucide-react"

import { formatPrice } from "@/app/admin/sections/productos/helpers"
import { supabase } from "@/lib/supabase/client"
import type { SupabasePedido } from "@/lib/supabase/types"

const DISPATCHED_ESTADOS = new Set([
  "enviado",
  "en_camino",
  "visita_fallida",
  "en_sucursal",
  "retiro_pendiente",
  "retiro_vencido",
  "en_devolucion",
  "devuelto_beyonix",
  "entregado",
])

/**
 * Heurística SÓLO visual (mostrar/ocultar el botón antes de intentar nada).
 * La autoridad real de si el refund corresponde es
 * begin_mercadopago_order_refund (server-side) -- esta función nunca decide
 * si el refund se ejecuta, sólo si tiene sentido ofrecer el botón.
 */
export function isOrderDispatchedForDisplay(pedido: SupabasePedido) {
  return (
    DISPATCHED_ESTADOS.has((pedido.estado ?? "").toLowerCase()) ||
    Boolean(pedido.tracking_number || pedido.andreani_tracking || pedido.andreani_envio_id)
  )
}

interface Props {
  pedido: SupabasePedido
  onUpdated?: () => void | Promise<void>
}

/**
 * Acción admin para iniciar/seguir el refund REAL de Mercado Pago (Fase 1 +
 * Fase 2). Sólo aparece cuando tiene sentido mostrarla -- el backend
 * (begin_mercadopago_order_refund) es quien decide de verdad si corresponde;
 * esta UI nunca confía en su propio cálculo para autorizar nada, sólo para
 * no mostrar un botón que el backend rechazaría de entrada.
 */
export function MercadoPagoRefundAction({ pedido, onUpdated }: Props) {
  const [confirming, setConfirming] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [notice, setNotice] = useState("")

  if (pedido.payment_method_id !== "mercadopago") return null
  if (pedido.financial_status !== "refund_pending") return null

  const latestAttempt = (pedido.mercadopago_order_refunds ?? [])[0] ?? null
  const amount = pedido.payment_confirmed_amount ?? pedido.external_amount_due ?? null

  const authHeader = async () => {
    const {
      data: { session },
    } = await supabase.auth.getSession()
    if (!session?.access_token) throw new Error("La sesión administrativa venció.")
    return { Authorization: `Bearer ${session.access_token}` }
  }

  const initiateRefund = async () => {
    setSubmitting(true)
    setNotice("")
    try {
      const headers = await authHeader()
      const response = await fetch(`/api/admin/pedidos/${pedido.id}/mercadopago-refund`, {
        method: "POST",
        headers,
      })
      const data = (await response.json().catch(() => ({}))) as { error?: string }
      if (!response.ok && response.status !== 202) {
        setNotice(data.error || "No se pudo iniciar el reintegro.")
      }
      await onUpdated?.()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "No se pudo iniciar el reintegro.")
    } finally {
      setSubmitting(false)
      setConfirming(false)
    }
  }

  const retryReconciliation = async () => {
    setSubmitting(true)
    setNotice("")
    try {
      const headers = await authHeader()
      const response = await fetch(`/api/admin/pedidos/${pedido.id}/mercadopago-refund`, {
        method: "GET",
        headers,
      })
      const data = (await response.json().catch(() => ({}))) as { error?: string; status?: string }
      if (!response.ok && response.status !== 202) {
        setNotice(data.error || "No se pudo reconciliar el reintegro.")
      } else if (data.status === "requested") {
        setNotice("Mercado Pago no tiene registro del reintegro anterior -- ya se puede reintentar.")
      }
      await onUpdated?.()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "No se pudo reconciliar el reintegro.")
    } finally {
      setSubmitting(false)
    }
  }

  // Terminal para esta UI: ya confirmado por Mercado Pago -- nada para
  // iniciar, sólo informar.
  if (latestAttempt?.status === "confirmed") {
    return (
      <div className="rounded-lg border border-emerald-300/20 bg-emerald-950/20 p-2">
        <p className="flex items-center gap-1.5 text-xs font-black text-white">
          <CheckCircle2 className="size-3.5 text-emerald-300" />
          Reintegro de Mercado Pago confirmado
        </p>
        <p className="mt-1 text-10px font-semibold text-white/70">
          Mercado Pago devolvió {formatPrice(latestAttempt.amount)} al medio de pago original del cliente.
        </p>
      </div>
    )
  }

  if (latestAttempt && ["requested", "processing"].includes(latestAttempt.status)) {
    return (
      <div className="rounded-lg border border-sky-300/20 bg-sky-950/20 p-2">
        <p className="flex items-center gap-1.5 text-xs font-black text-white">
          <Loader2 className="size-3.5 animate-spin text-sky-300" />
          Reintegro de Mercado Pago en curso
        </p>
        <p className="mt-1 text-10px font-semibold text-white/70">
          Ya se envió a Mercado Pago. Esperá la confirmación antes de reintentar -- volver a hacer clic no envía un segundo pedido.
        </p>
      </div>
    )
  }

  if (latestAttempt?.status === "needs_reconciliation") {
    return (
      <div className="rounded-lg border border-amber-300/25 bg-amber-950/20 p-2">
        <p className="flex items-center gap-1.5 text-xs font-black text-white">
          <AlertTriangle className="size-3.5 text-amber-300" />
          Requiere revisión: sin confirmación de Mercado Pago
        </p>
        <p className="mt-1 text-10px font-semibold text-white/70">
          El pedido de reintegro se envió pero Mercado Pago no confirmó el resultado. Reconciliá antes de reintentar -- nunca se vuelve a enviar el reintegro sin confirmar primero qué pasó.
        </p>
        {notice && <p className="mt-2 text-10px font-bold text-red-200">{notice}</p>}
        <button
          type="button"
          disabled={submitting}
          onClick={retryReconciliation}
          className="admin-ds-button admin-ds-button-secondary mt-2 h-8 px-3 text-10px font-black disabled:opacity-45"
        >
          <RefreshCw className={`mr-1.5 inline size-3.5 ${submitting ? "animate-spin" : ""}`} />
          Reconciliar con Mercado Pago
        </button>
      </div>
    )
  }

  // Sin intento activo (nunca se intentó, o el último terminó en 'failed' --
  // un rechazo definitivo admite reintentar).
  if (isOrderDispatchedForDisplay(pedido)) return null

  return (
    <div className="rounded-lg border border-emerald-300/20 bg-emerald-950/20 p-2">
      <p className="text-xs font-black text-white">Devolución por Mercado Pago</p>
      {latestAttempt?.status === "failed" && (
        <p className="mt-1 text-10px font-bold text-red-200">
          El intento anterior no se pudo completar ({latestAttempt.error_code ?? "motivo no especificado"}). Podés reintentar.
        </p>
      )}
      {!confirming ? (
        <>
          <p className="mt-1 text-xs text-white/70">
            {amount != null
              ? `Mercado Pago devolverá ${formatPrice(amount)} al medio de pago original del cliente (tarjeta/cuotas incluidas).`
              : "Mercado Pago devolverá el importe cobrado al medio de pago original del cliente."}
            {" "}No se puede elegir una cuenta bancaria ni modificar el monto manualmente.
          </p>
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="admin-ds-button admin-ds-button-secondary mt-2 h-8 px-3 text-10px font-black"
          >
            Iniciar devolución por Mercado Pago
          </button>
        </>
      ) : (
        <div className="mt-2 rounded-md border border-white/10 bg-black/20 p-2">
          <p className="text-10px font-bold text-white/85">
            ¿Confirmás reembolsar {amount != null ? formatPrice(amount) : "el importe cobrado"} por Mercado Pago? El dinero
            vuelve automáticamente al medio de pago original del cliente. Esta acción no se puede deshacer desde acá.
          </p>
          {notice && <p className="mt-2 text-10px font-bold text-red-200">{notice}</p>}
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              disabled={submitting}
              onClick={initiateRefund}
              className="admin-ds-button admin-ds-button-primary h-8 px-3 text-10px font-black disabled:opacity-45"
            >
              {submitting ? <Loader2 className="mr-1.5 inline size-3.5 animate-spin" /> : null}
              Confirmar reintegro
            </button>
            <button
              type="button"
              disabled={submitting}
              onClick={() => {
                setConfirming(false)
                setNotice("")
              }}
              className="admin-ds-button admin-ds-button-secondary h-8 px-3 text-10px font-black disabled:opacity-45"
            >
              Cancelar
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
