"use client"

import { useEffect, useRef, useState } from "react"
import { Copy, ExternalLink } from "lucide-react"
import QRCode from "qrcode"

import { AdminButton, AdminModal, AdminPrimaryButton, AdminTextarea } from "@/app/admin/components/admin-controls"
import { orderCode } from "@/lib/admin/dispatch"
import { LOCAL_DELIVERY_REVERT_REASON_MAX, LOCAL_DELIVERY_REVERT_REASON_MIN } from "@/lib/shipping/local-delivery-outcome"

import { DispatchRequestError, dispatchRequest } from "./dispatch-request"

type CourierQr = { orderCode: string; url: string; courierCanAct: boolean; screen: string }

const SCREEN_HINTS: Record<string, string> = {
  preparing: "El cadete podrá registrar el resultado cuando el pedido esté En camino.",
  delivered: "El pedido ya figura como entregado: el QR sólo muestra ese estado.",
  incident: "Hay una incidencia abierta: resolvela en Entregas locales antes de que el cadete vuelva a registrar.",
  returning: "El pedido está regresando a BEYONIX: el QR ya no registra entregas.",
  returned: "El pedido volvió a BEYONIX: el QR ya no registra entregas.",
}

/**
 * QR del cadete (el mismo de las etiquetas BEYONIX) para escanearlo desde un
 * celular o compartir el enlace. Montar con `key` por pedido: cada apertura
 * consulta el QR vigente (nunca lo crea ni lo rota).
 */
export function CourierQrDialog({ orderId, onClose }: { orderId: number; onClose: () => void }) {
  const [qr, setQr] = useState<(CourierQr & { image: string }) | null>(null)
  const [error, setError] = useState("")
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const data = await dispatchRequest<CourierQr>(`/orders/${orderId}/courier-qr`, {})
        const image = await QRCode.toDataURL(data.url, { margin: 2, width: 320, errorCorrectionLevel: "M" })
        if (active) setQr({ ...data, image })
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : "No se pudo cargar el QR del pedido.")
      }
    })()
    return () => { active = false }
  }, [orderId])

  const copy = async () => {
    if (!qr) return
    try {
      await navigator.clipboard.writeText(qr.url)
      setCopied(true)
    } catch {
      setError("No se pudo copiar el enlace. Abrilo y copialo desde el navegador.")
    }
  }

  return (
    <AdminModal open compact title="QR del cadete" description={`${orderCode(orderId)} · QR vigente del pedido: el de las últimas etiquetas BEYONIX impresas. El cadete lo escanea con el celular para registrar Entregado, Cliente ausente o Problema con la entrega.`}
      onClose={onClose} footer={<div className="flex justify-end"><AdminButton onClick={onClose}>Cerrar</AdminButton></div>}>
      <div data-courier-qr-dialog="" className="grid justify-items-center gap-3">
        {error ? <p role="alert" className="text-sm font-bold text-red-300">{error}</p> : null}
        {!qr && !error ? <p role="status" className="text-sm text-white/70">Cargando…</p> : null}
        {qr ? <>
          {/* eslint-disable-next-line @next/next/no-img-element -- data URL generada en el navegador: no hay nada que optimizar */}
          <img src={qr.image} alt={`QR de entrega del pedido ${qr.orderCode}`} width={240} height={240} className="rounded-lg bg-white p-1" data-courier-qr-image="" />
          {!qr.courierCanAct && SCREEN_HINTS[qr.screen] ? <p className="text-center text-xs font-bold text-amber-200" data-courier-qr-hint="">{SCREEN_HINTS[qr.screen]}</p> : null}
          <div className="flex flex-wrap justify-center gap-2">
            <a href={qr.url} target="_blank" rel="noopener noreferrer" className="admin-ds-button admin-ds-button-secondary inline-flex min-h-8 cursor-pointer items-center justify-center gap-2 px-3 py-1.5 text-xs font-black">
              <ExternalLink className="size-4" aria-hidden />Abrir página del cadete
            </a>
            <AdminButton size="sm" icon={<Copy className="size-4" aria-hidden />} onClick={() => void copy()}>{copied ? "Enlace copiado" : "Copiar enlace"}</AdminButton>
          </div>
          <p className="text-center text-xs text-white/60">Compartilo sólo con el cadete: permite registrar el resultado de esta entrega.</p>
        </> : null}
      </div>
    </AdminModal>
  )
}

/**
 * Corrección de "Entregado al cadete" (Admin/Super Admin): confirmación
 * explícita con motivo. El servidor y la base vuelven a validar rol, estado y
 * resultado del cadete; reintentar usa la misma clave (nunca duplica).
 */
export function RevertHandoverDialog({ orderId, onClose, onReverted }: { orderId: number; onClose: () => void; onReverted: () => void }) {
  const [reason, setReason] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const requestKey = useRef<string | null>(null)
  const trimmed = reason.trim()
  const valid = trimmed.length >= LOCAL_DELIVERY_REVERT_REASON_MIN && trimmed.length <= LOCAL_DELIVERY_REVERT_REASON_MAX

  const submit = async () => {
    if (busy || !valid) return
    setBusy(true)
    setError("")
    try {
      requestKey.current ??= crypto.randomUUID()
      await dispatchRequest("/local", { orderId, action: "revert_in_transit", reason: trimmed, requestKey: requestKey.current })
      onReverted()
    } catch (cause) {
      // Sin respuesta del servidor se puede reintentar con la misma clave.
      if (!(cause instanceof DispatchRequestError && cause.retryable)) requestKey.current = null
      setError(cause instanceof Error ? cause.message : "No se pudo corregir la entrega al cadete.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <AdminModal open compact title="Corregir entrega al cadete" description={`${orderCode(orderId)} vuelve a preparación (Listo para el cadete). Usalo sólo si el pedido NO salió con el cadete. No cambia pagos, facturas, stock, bultos, etiquetas ni el QR: los mismos códigos y el QR vigente siguen sirviendo. Queda registrado con tu usuario y el motivo.`}
      onClose={onClose} footer={<div className="flex justify-end gap-2">
        <AdminButton disabled={busy} onClick={onClose}>Cancelar</AdminButton>
        <AdminPrimaryButton disabled={busy || !valid} onClick={() => void submit()}>{busy ? "Corrigiendo…" : "Confirmar corrección"}</AdminPrimaryButton>
      </div>}>
      <AdminTextarea title="Motivo obligatorio" value={reason} onChange={(value) => { setReason(value); requestKey.current = null }} rows={3} maxLength={LOCAL_DELIVERY_REVERT_REASON_MAX}
        placeholder={`Ej.: se marcó por error, el pedido sigue en el depósito (mínimo ${LOCAL_DELIVERY_REVERT_REASON_MIN} caracteres)`} />
      {error && <p role="alert" className="mt-2 text-sm font-bold text-red-300">{error}</p>}
    </AdminModal>
  )
}
