"use client"

import { useRef, useState, type ReactNode } from "react"

import type { CourierDeliveryView } from "@/lib/orders/local-delivery-courier"
import {
  LOCAL_DELIVERY_INCIDENT_COMMENT_MAX,
  LOCAL_DELIVERY_INCIDENT_REASON_LABELS,
  LOCAL_DELIVERY_INCIDENT_REASONS,
  type LocalDeliveryCourierAction,
  type LocalDeliveryIncidentReason,
} from "@/lib/shipping/local-delivery-outcome"

type Step =
  | { kind: "home" }
  | { kind: "confirm"; action: "delivered" | "absent" }
  | { kind: "incident" }

const STATUS_SCREENS = {
  preparing: { title: "El pedido todavía no salió a reparto", detail: "Escaneá el código cuando lo estés entregando.", tone: "neutral" },
  delivered: { title: "Pedido ya entregado", detail: "No hace falta registrar nada más.", tone: "success" },
  incident: { title: "Problema registrado", detail: "BEYONIX está revisando la entrega. Esperá indicaciones antes de volver a intentarla.", tone: "warning" },
  returning: { title: "El pedido debe regresar a BEYONIX.", detail: "Ya se registraron los intentos de entrega. Llevá todos los bultos a BEYONIX.", tone: "warning" },
  returned: { title: "Devuelto a BEYONIX", detail: "El pedido ya fue recibido en BEYONIX.", tone: "neutral" },
  cancelled: { title: "Pedido cancelado", detail: "No lo entregues. Devolvé los bultos a BEYONIX.", tone: "danger" },
} as const

const TONE_CLASSES = {
  neutral: "border-neutral-300 bg-neutral-50",
  success: "border-emerald-600 bg-emerald-50",
  warning: "border-amber-500 bg-amber-50",
  danger: "border-red-600 bg-red-50",
}

/**
 * Marco de la página del cadete: fondo claro propio. Los colores van en `div`
 * (no en main/section): globals.css fuerza fondo transparente en
 * main/section con clases bg-* para la tienda oscura.
 */
export function CourierPageFrame({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh bg-white px-4 py-5 font-heading text-neutral-950" data-courier-page="">
      <main className="mx-auto w-full max-w-md">
        <p className="text-center text-lg font-black tracking-[0.3em]">BEYONIX</p>
        {children}
      </main>
    </div>
  )
}

const BIG_BUTTON = "flex min-h-16 w-full cursor-pointer items-center justify-center gap-3 rounded-2xl border-2 px-4 text-xl font-black transition active:scale-[0.99] disabled:cursor-wait disabled:opacity-60"

export function CourierDeliveryClient({ token, initialView }: { token: string; initialView: CourierDeliveryView }) {
  const [view, setView] = useState(initialView)
  const [step, setStep] = useState<Step>({ kind: "home" })
  const [reason, setReason] = useState<LocalDeliveryIncidentReason | null>(null)
  const [comment, setComment] = useState("")
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null)
  // Candado síncrono: un doble toque nunca envía dos pedidos.
  const sending = useRef(false)

  const secondAttempt = view.failedAttempts >= 1

  async function submit(action: LocalDeliveryCourierAction) {
    if (sending.current) return
    sending.current = true
    setBusy(true)
    setMessage(null)
    try {
      const response = await fetch(`/api/delivery/${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify(action === "incident"
          ? { action, expectedAttempts: view.failedAttempts, reason, comment: comment.trim() || null }
          : { action, expectedAttempts: view.failedAttempts }),
      })
      const payload = await response.json().catch(() => null) as { ok?: boolean; message?: string; view?: CourierDeliveryView } | null
      if (payload?.view) setView(payload.view)
      setMessage({ text: payload?.message ?? "No pudimos registrar el resultado. Probá de nuevo.", ok: Boolean(payload?.ok) })
      if (payload?.view || response.ok) {
        setStep({ kind: "home" })
        setReason(null)
        setComment("")
      }
    } catch {
      setMessage({ text: "Sin conexión. Revisá la señal y probá de nuevo.", ok: false })
    } finally {
      sending.current = false
      setBusy(false)
    }
  }

  const status = view.screen.kind === "actions" ? null : STATUS_SCREENS[view.screen.kind]

  return (
    <div className="mt-4 space-y-4">
      <section className="rounded-2xl border-2 border-neutral-200 p-4" aria-label="Datos de la entrega">
        <dl className="space-y-3 text-base">
          <div>
            <dt className="text-xs font-bold uppercase tracking-widest text-neutral-500">Pedido</dt>
            <dd className="text-2xl font-black tabular-nums" data-courier-order="">{view.orderCode}</dd>
          </div>
          <div>
            <dt className="text-xs font-bold uppercase tracking-widest text-neutral-500">Cliente</dt>
            <dd className="text-lg font-bold">{view.customerName}</dd>
          </div>
          <div>
            <dt className="text-xs font-bold uppercase tracking-widest text-neutral-500">Dirección</dt>
            <dd className="text-lg font-bold leading-snug">{view.address}</dd>
            {view.locality && <dd className="text-sm text-neutral-700">{view.locality}</dd>}
          </div>
          {view.reference && (
            <div>
              <dt className="text-xs font-bold uppercase tracking-widest text-neutral-500">Referencia</dt>
              <dd className="text-base leading-snug">{view.reference}</dd>
            </div>
          )}
          {view.parcels !== null && (
            <div>
              <dt className="text-xs font-bold uppercase tracking-widest text-neutral-500">Bultos</dt>
              <dd className="text-lg font-black" data-courier-parcels="">{view.parcels} {view.parcels === 1 ? "bulto" : "bultos"}</dd>
            </div>
          )}
        </dl>
      </section>

      {message && (
        <p role="status" data-courier-message="" className={`rounded-2xl border-2 p-3 text-base font-bold ${message.ok ? TONE_CLASSES.success : TONE_CLASSES.warning}`}>
          {message.text}
        </p>
      )}

      {status ? (
        <div role="status" className={`rounded-2xl border-2 p-5 text-center ${TONE_CLASSES[status.tone]}`} data-courier-screen={view.screen.kind}>
          <p className="text-xl font-black">{status.title}</p>
          <p className="mt-2 text-base text-neutral-800">{status.detail}</p>
        </div>
      ) : step.kind === "home" ? (
        <section className="space-y-3" data-courier-screen="actions">
          {secondAttempt && (
            <p className="rounded-2xl border-2 border-amber-500 bg-amber-50 p-3 text-center text-base font-black" data-courier-attempts="">
              1 intento de entrega fallido
            </p>
          )}
          <button type="button" className={`${BIG_BUTTON} border-emerald-700 bg-emerald-600 text-white`} onClick={() => setStep({ kind: "confirm", action: "delivered" })}>
            <span aria-hidden>✅</span> Entregado
          </button>
          <button type="button" className={`${BIG_BUTTON} border-amber-600 bg-amber-400 text-neutral-950`} onClick={() => setStep({ kind: "confirm", action: "absent" })}>
            <span aria-hidden>🏠</span> Cliente ausente
          </button>
          <button type="button" className={`${BIG_BUTTON} border-neutral-900 bg-white text-neutral-950`} onClick={() => setStep({ kind: "incident" })}>
            <span aria-hidden>⚠️</span> Problema con la entrega
          </button>
        </section>
      ) : step.kind === "confirm" ? (
        <section className="space-y-3 rounded-2xl border-2 border-neutral-900 p-4" data-courier-confirm={step.action}>
          <p className="text-xl font-black leading-snug">
            {step.action === "delivered" ? "¿Confirmar que el pedido fue entregado?" : "¿Confirmar que no había nadie en el domicilio?"}
          </p>
          {step.action === "absent" && secondAttempt && (
            <p className="text-base font-bold text-amber-800">Es el segundo intento: el pedido deberá regresar a BEYONIX.</p>
          )}
          <button type="button" disabled={busy} className={`${BIG_BUTTON} border-neutral-950 bg-neutral-950 text-white`} onClick={() => void submit(step.action)}>
            {busy ? "Registrando…" : "Confirmar"}
          </button>
          <button type="button" disabled={busy} className={`${BIG_BUTTON} border-neutral-300 bg-white text-neutral-950`} onClick={() => setStep({ kind: "home" })}>
            Volver
          </button>
        </section>
      ) : (
        <section className="space-y-3 rounded-2xl border-2 border-neutral-900 p-4" data-courier-incident="">
          <p className="text-xl font-black">¿Qué pasó?</p>
          <div className="space-y-2" role="radiogroup" aria-label="Problema con la entrega">
            {LOCAL_DELIVERY_INCIDENT_REASONS.map((option) => (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={reason === option}
                className={`flex min-h-14 w-full cursor-pointer items-center rounded-2xl border-2 px-4 text-left text-lg font-bold ${reason === option ? "border-neutral-950 bg-neutral-950 text-white" : "border-neutral-300 bg-white"}`}
                onClick={() => setReason(option)}
              >
                {LOCAL_DELIVERY_INCIDENT_REASON_LABELS[option]}
              </button>
            ))}
          </div>
          {reason === "other" && (
            <label className="block">
              <span className="text-sm font-bold text-neutral-700">Contanos brevemente qué pasó</span>
              <textarea
                value={comment}
                maxLength={LOCAL_DELIVERY_INCIDENT_COMMENT_MAX}
                rows={3}
                onChange={(event) => setComment(event.target.value)}
                className="mt-1 w-full rounded-xl border-2 border-neutral-300 p-3 text-base outline-none focus:border-neutral-950"
              />
            </label>
          )}
          <button
            type="button"
            disabled={busy || !reason || (reason === "other" && !comment.trim())}
            className={`${BIG_BUTTON} border-neutral-950 bg-neutral-950 text-white disabled:cursor-not-allowed`}
            onClick={() => void submit("incident")}
          >
            {busy ? "Registrando…" : "Confirmar"}
          </button>
          <button type="button" disabled={busy} className={`${BIG_BUTTON} border-neutral-300 bg-white text-neutral-950`} onClick={() => { setStep({ kind: "home" }); setReason(null); setComment("") }}>
            Volver
          </button>
        </section>
      )}
    </div>
  )
}
