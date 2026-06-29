"use client"

import { useEffect, useLayoutEffect, useRef, useState } from "react"
import {
  Check,
  Download,
  FileText,
  Send,
  ShieldCheck,
  X,
} from "lucide-react"

import { AdminSelect } from "@/app/admin/components/admin-controls"
import { ADMIN_SENSITIVE_DANGER } from "@/lib/admin/admin-sensitive-visuals"
import { notifyOrderNotificationsChanged } from "@/lib/admin/order-notifications"
import { getOrderClaimResolutionLabel } from "@/lib/order-claims"
import { supabase } from "@/lib/supabase/client"
import type {
  OrderClaimResolution,
  OrderClaimStatus,
  SupabaseOrderClaim,
  SupabasePedido,
} from "@/lib/supabase/types"

const PROBLEM_LABELS: Record<string, string> = {
  danado: "Producto dañado",
  incorrecto: "Producto incorrecto",
  falla: "Producto con falla",
  faltante: "Faltó un producto",
  cantidad_menor: "Menos cantidad recibida",
  cancelar_compra: "Cancelar compra",
  devolucion: "Solicitud anterior",
  no_llego: "Solicitud anterior",
  cambio_producto: "Solicitud anterior",
  cambio_color: "Solicitud anterior",
  cambio_cantidad: "Solicitud anterior",
  modificar_envio: "Solicitud anterior",
  otro_pre_despacho: "Solicitud anterior",
  otro: "Otro problema",
}

const STATUS_OPTIONS: Array<{ value: OrderClaimStatus; label: string }> = [
  { value: "recibido", label: "Reclamo recibido" },
  { value: "en_revision", label: "En revisión por BEYONIX" },
  { value: "falta_informacion", label: "Esperando respuesta del cliente" },
  { value: "aprobado", label: "Solución en proceso" },
  { value: "reintegro_pendiente", label: "Reintegro pendiente" },
  { value: "cambio_pendiente", label: "Solución en proceso" },
  { value: "cupon_pendiente", label: "Cupón pendiente" },
  { value: "reemplazo_enviado", label: "Solución en proceso" },
  { value: "rechazado", label: "Rechazado" },
  { value: "cerrado", label: "Caso resuelto" },
]

const RESOLUTION_OPTIONS: OrderClaimResolution[] = [
  "reintegro_total",
  "reintegro_parcial",
  "cupon_descuento",
  "otro",
  "rechazado",
]

function formatDate(value?: string | null) {
  if (!value) return "Sin fecha"

  return new Intl.DateTimeFormat("es-AR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "America/Argentina/Buenos_Aires",
  }).format(new Date(value))
}

function sortUniqueMessages(messages: SupabaseOrderClaim["order_claim_messages"] = []) {
  const seen = new Set<number>()

  return [...messages]
    .sort((a, b) => +new Date(a.created_at) - +new Date(b.created_at))
    .filter((message) => {
      if (seen.has(message.id)) return false
      seen.add(message.id)
      return true
    })
}

function productName(order: SupabasePedido) {
  const names = (order.orden_items ?? [])
    .map((item) => {
      const name = item.productos?.nombre
      const variant = item.producto_variantes?.nombre
      return name ? [name, variant].filter(Boolean).join(" · ") : null
    })
    .filter(Boolean)

  return names.length ? names.join(", ") : "Producto del pedido"
}

function getClaimDescription(claim: SupabaseOrderClaim, order: SupabasePedido) {
  const match = claim.description.match(/^Producto afectado:\s*(.+?)(?:\r?\n){2}([\s\S]*)$/)

  return {
    product: claim.failure_type === "cancelar_compra"
      ? "Pedido completo"
      : match?.[1]?.trim() || productName(order),
    description: match?.[2]?.trim() || claim.description,
  }
}

function getClaimMessageText(message: string) {
  const match = message.match(/^Producto afectado:\s*.+?(?:\r?\n){2}([\s\S]*)$/)
  return match?.[1]?.trim() || message
}

function getFileTypeLabel(mimeType: string) {
  if (mimeType.startsWith("image/")) return "Imagen"
  if (mimeType.startsWith("video/")) return "Video"
  if (mimeType === "application/pdf") return "PDF"
  return "Archivo"
}

function isOrderDelivered(order: SupabasePedido) {
  const estado = (order.estado ?? "").toLowerCase()
  const andreaniStatus = (order.andreani_estado ?? "").toLowerCase()
  return estado === "entregado" || Boolean(order.delivered_at) || andreaniStatus.includes("entregado")
}

function isOrderDispatched(order: SupabasePedido) {
  const estado = (order.estado ?? "").toLowerCase()
  const andreaniStatus = (order.andreani_estado ?? "").toLowerCase()

  return (
    ["enviado", "en_camino", "entregado"].includes(estado) ||
    Boolean(order.tracking_number || order.andreani_tracking || order.andreani_envio_id) ||
    ["camino", "tránsito", "transito", "distribución", "distribucion", "reparto", "visita", "entregado"].some(
      (status) => andreaniStatus.includes(status),
    )
  )
}

function isOrderInvoiced(order: SupabasePedido) {
  return (
    order.invoice_status === "authorized" ||
    order.invoice_status === "processing" ||
    Boolean(order.invoice_cae) ||
    Boolean(order.invoice_number && order.invoice_point)
  )
}

function getStatusLabel(claim: SupabaseOrderClaim) {
  if (claim.failure_type === "cancelar_compra") {
    if (claim.status === "rechazado") return "Cancelación rechazada"
    if (claim.status === "cerrado") return "Cancelación aprobada"
    if (claim.status === "falta_informacion") return "Esperando cliente"
    return "Cancelación solicitada"
  }

  if (["cambio_pendiente", "reemplazo_enviado"].includes(claim.status)) {
    return "Solución en proceso"
  }

  return STATUS_OPTIONS.find((option) => option.value === claim.status)?.label ?? claim.status
}

export function AdminClaimManager({
  pedido,
  onClaimChange,
}: {
  pedido: SupabasePedido
  onClaimChange: (claim: SupabaseOrderClaim) => void
}) {
  const claims = pedido.order_claims ?? []
  const [claimId, setClaimId] = useState<number | null>(claims[0]?.id ?? null)
  const claim = claims.find((item) => item.id === claimId) ?? claims[0]
  const [status, setStatus] = useState<OrderClaimStatus>(claim?.status ?? "recibido")
  const [resolution, setResolution] = useState<OrderClaimResolution>(claim?.resolution ?? "otro")
  const [response, setResponse] = useState("")
  const [rejectionReason, setRejectionReason] = useState("")
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState("")
  const chatRef = useRef<HTMLDivElement>(null)
  const firstReviewAttemptedRef = useRef<Set<number>>(new Set())
  const messageCount = claim?.order_claim_messages?.length ?? 0

  const cancellation = claim?.failure_type === "cancelar_compra"
  const invoiced = isOrderInvoiced(pedido)
  const dispatched = isOrderDispatched(pedido)
  const delivered = isOrderDelivered(pedido)
  const cancellationCanBeApproved = cancellation && !invoiced && !dispatched && !delivered

  useLayoutEffect(() => {
    const chat = chatRef.current
    if (chat) chat.scrollTop = chat.scrollHeight
  }, [claim?.id, messageCount])

  useEffect(() => {
    if (!claim) return
    setStatus(claim.status)
    setResolution(claim.resolution ?? "otro")
    setRejectionReason(claim.rejection_reason ?? "")
    setResponse("")
    setNotice("")
  }, [claim?.id])

  useEffect(() => {
    if (!claim) return
    let active = true

    const refreshClaim = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) return
      const response = await fetch(`/api/admin/order-claims/${claim.id}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      const data = (await response.json()) as { claim?: SupabaseOrderClaim }
      if (!active || !response.ok || !data.claim) return

      const nextMessageCount = data.claim.order_claim_messages?.length ?? 0
      if (
        data.claim.updated_at !== claim.updated_at ||
        nextMessageCount !== messageCount
      ) {
        onClaimChange(data.claim)
      }
    }

    const intervalId = window.setInterval(() => void refreshClaim(), 5000)
    window.addEventListener("focus", refreshClaim)
    return () => {
      active = false
      window.clearInterval(intervalId)
      window.removeEventListener("focus", refreshClaim)
    }
  }, [claim?.id, claim?.updated_at, messageCount, onClaimChange])

  const updateClaim = async (
    overrides: Record<string, unknown>,
    successMessage: string,
  ) => {
    if (!claim) return false
    setSaving(true)
    setNotice("")

    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) {
        setNotice("La sesión administrativa venció.")
        return false
      }

      const payload = {
        status,
        resolution: claim.resolution ?? null,
        offered_resolutions: [],
        admin_response: claim.admin_response ?? "",
        rejection_reason: claim.rejection_reason ?? "",
        ...overrides,
      }
      const request = await fetch(`/api/admin/order-claims/${claim.id}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      })
      const data = (await request.json()) as {
        claim?: SupabaseOrderClaim
        error?: string
      }

      if (!request.ok || !data.claim) {
        setNotice(data.error || "No se pudo actualizar el caso.")
        return false
      }

      onClaimChange(data.claim)
      setStatus(data.claim.status)
      setResolution(data.claim.resolution ?? "otro")
      setRejectionReason(data.claim.rejection_reason ?? "")
      setNotice(successMessage)
      notifyOrderNotificationsChanged()
      return true
    } catch {
      setNotice("No se pudo actualizar el caso.")
      return false
    } finally {
      setSaving(false)
    }
  }

  useEffect(() => {
    if (!claim || claim.status !== "recibido") return
    if (firstReviewAttemptedRef.current.has(claim.id)) return

    firstReviewAttemptedRef.current.add(claim.id)
    void updateClaim(
      { status: "en_revision" },
      cancellation
        ? "Solicitud abierta. Estado actualizado a En revisión."
        : "Reclamo abierto. Estado actualizado a En revisión.",
    ).then((updated) => {
      if (!updated) firstReviewAttemptedRef.current.delete(claim.id)
    })
  }, [claim?.id, claim?.status])

  const sendResponse = async () => {
    if (!claim || response.trim().length < 2) {
      setNotice("Escribí una respuesta para el cliente.")
      return
    }

    const sent = await updateClaim(
      {
        status: "falta_informacion",
        admin_response: response.trim(),
        append_message: true,
      },
      "Respuesta enviada al cliente.",
    )
    if (sent) setResponse("")
  }

  const approveCancellation = async () => {
    const sent = await updateClaim(
      {
        action: "approve_cancellation",
        admin_response: response.trim(),
      },
      "Cancelación aprobada y pedido marcado como cancelado.",
    )
    if (sent) setResponse("")
  }

  const rejectCancellation = async () => {
    const message = response.trim() || rejectionReason.trim()
    if (message.length < 5) {
      setNotice("Escribí el motivo del rechazo para que el cliente lo vea claro.")
      return
    }

    const sent = await updateClaim(
      {
        action: "reject_cancellation",
        admin_response: message,
      },
      "Cancelación rechazada. El cliente verá el motivo.",
    )
    if (sent) {
      setResponse("")
      setRejectionReason("")
    }
  }

  const approveSolution = async () => {
    if (!claim) return
    const message = response.trim()
    const sent = await updateClaim(
      {
        status: "aprobado",
        resolution,
        admin_response: message || claim.admin_response || "",
        append_message: Boolean(message),
      },
      "Solución aprobada por BEYONIX.",
    )
    if (sent) setResponse("")
  }

  const rejectClaim = async () => {
    const message = rejectionReason.trim() || response.trim()
    if (message.length < 5) {
      setNotice("El motivo del rechazo es obligatorio.")
      return
    }

    const sent = await updateClaim(
      {
        status: "rechazado",
        resolution: "rechazado",
        rejection_reason: message,
        admin_response: message,
        append_message: true,
      },
      cancellation ? "Cancelación rechazada." : "Reclamo rechazado y cliente notificado.",
    )
    if (sent) {
      setResponse("")
      setRejectionReason("")
    }
  }

  const markResolved = async () => {
    if (!claim) return
    const sent = await updateClaim(
      {
        status: "cerrado",
        resolution: resolution === "rechazado" ? "otro" : resolution,
        admin_response: response.trim() || claim.admin_response || "",
        append_message: Boolean(response.trim()),
      },
      "Caso marcado como resuelto.",
    )
    if (sent) setResponse("")
  }

  const changeStatus = async () => {
    if (!claim) return
    if (status === "rechazado") {
      await rejectClaim()
      return
    }
    if (status === "cerrado") {
      await markResolved()
      return
    }

    await updateClaim(
      {
        status,
        resolution: status === "aprobado" ? resolution : claim.resolution ?? null,
      },
      "Estado actualizado.",
    )
  }

  if (!claim) {
    return (
      <section className="admin-claim-manager mt-3 rounded-2xl border border-white/10 bg-[#0D1117] p-4">
        <h3 className="text-base font-black text-white">Gestión de ayuda</h3>
        <p className="mt-1 text-sm text-[#C8C8C8]">Este pedido todavía no tiene solicitudes ni reclamos.</p>
      </section>
    )
  }

  const messages = sortUniqueMessages(claim.order_claim_messages)
  const customer =
    pedido.cliente_nombre ||
    pedido.cliente_username ||
    pedido.cliente_email ||
    "Cliente"
  const details = getClaimDescription(claim, pedido)
  const reason =
    PROBLEM_LABELS[claim.failure_type ?? ""] ||
    claim.failure_type ||
    "Solicitud de ayuda"
  const files = claim.order_claim_files ?? []
  const evidenceFiles = files.filter((file) => !["comprobante_devolucion", "comprobante_diferencia"].includes(file.file_role))
  const statusChanged = status !== claim.status
  const closed = ["cerrado", "rechazado"].includes(claim.status)

  return (
    <section className={`admin-claim-manager mt-3 overflow-hidden rounded-2xl border shadow-[0_22px_55px_rgba(0,0,0,0.28)] ${ADMIN_SENSITIVE_DANGER.panel}`}>
      <header className="border-b border-[#7f2d3a]/45 p-3 sm:p-4">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0">
            <p className={`text-10px font-black uppercase tracking-[0.18em] ${ADMIN_SENSITIVE_DANGER.label}`}>
              {cancellation ? "Solicitud de cancelación" : "Reclamo post-entrega"}
            </p>
            <h3 className="mt-1 text-lg font-black text-white">
              Pedido BX-{1000 + pedido.id}
            </h3>
            <p className={`mt-1 text-xs font-semibold leading-5 ${ADMIN_SENSITIVE_DANGER.textMuted}`}>
              {cancellation
                ? "Revisá si el pedido no fue facturado ni despachado antes de aprobar."
                : "El cliente reportó un problema con un producto recibido."}
            </p>
          </div>

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center xl:justify-end">
            {claims.length > 1 && (
              <div className="w-full sm:w-56">
                <AdminSelect
                  title="Seleccionar caso"
                  value={String(claim.id)}
                  compact
                  onChange={(value) => setClaimId(Number(value))}
                >
                  {claims.map((item) => (
                    <option key={item.id} value={String(item.id)}>
                      #{item.id} · {PROBLEM_LABELS[item.failure_type ?? ""] ?? "Ayuda"}
                    </option>
                  ))}
                </AdminSelect>
              </div>
            )}
            <span className={`inline-flex h-8 w-fit items-center gap-2 rounded-full border px-3 text-10px font-black uppercase tracking-wide ${ADMIN_SENSITIVE_DANGER.badge}`}>
              <span className={`size-2 rounded-full ${ADMIN_SENSITIVE_DANGER.dot}`} />
              {getStatusLabel(claim)}
            </span>
          </div>
        </div>

        <div className="mt-3 grid gap-2 sm:grid-cols-3">
          {[
            ["Pedido", pedido.estado || "-"],
            ["Facturación", invoiced ? "Facturado / en proceso" : "Sin factura emitida"],
            ["Envío", dispatched ? "Despachado" : "No despachado"],
          ].map(([label, value]) => (
            <div key={label} className={`rounded-xl border px-3 py-2 ${ADMIN_SENSITIVE_DANGER.panelSoft}`}>
              <p className={`text-10px font-bold uppercase tracking-wide ${ADMIN_SENSITIVE_DANGER.label}`}>{label}</p>
              <p className="mt-0.5 text-xs font-black text-white">{value}</p>
            </div>
          ))}
        </div>

        {cancellation && !cancellationCanBeApproved && !closed && (
          <p className="mt-3 rounded-lg border border-red-300/20 bg-red-500/8 px-3 py-2 text-xs font-bold text-red-100">
            Esta orden ya está facturada, despachada o entregada. No se puede aprobar la cancelación desde esta acción.
          </p>
        )}
      </header>

      <div className="grid gap-3 p-3 lg:grid-cols-[minmax(260px,0.75fr)_minmax(0,1.25fr)] sm:px-4 sm:py-3">
        <aside className="space-y-3">
          <section className={`rounded-xl border p-3 ${ADMIN_SENSITIVE_DANGER.panelSoft}`}>
            <h4 className="text-sm font-black text-white">Información del caso</h4>
            <dl className="mt-2 divide-y divide-white/7">
              {[
                ["Cliente", customer],
                ["Pedido", `BX-${1000 + pedido.id}`],
                [cancellation ? "Alcance" : "Producto afectado", details.product],
                ["Motivo", reason],
                ["Estado", getStatusLabel(claim)],
                ["Fecha de creación", formatDate(claim.created_at)],
              ].map(([label, value]) => (
                <div key={label} className="grid grid-cols-[112px_minmax(0,1fr)] gap-2 py-2">
                  <dt className={`text-10px font-bold uppercase tracking-wide ${ADMIN_SENSITIVE_DANGER.label}`}>{label}</dt>
                  <dd className="text-xs font-bold leading-5 text-white">{value}</dd>
                </div>
              ))}
            </dl>
            <div className="mt-2 rounded-lg bg-[#241217] p-2.5">
              <p className={`text-10px font-bold uppercase tracking-wide ${ADMIN_SENSITIVE_DANGER.label}`}>
                {cancellation ? "Mensaje de cancelación" : "Mensaje inicial del cliente"}
              </p>
              <p className="mt-1 whitespace-pre-wrap text-xs leading-5 text-[#C8C8C8]">{details.description}</p>
            </div>
          </section>

          <section className={`rounded-xl border p-3 ${ADMIN_SENSITIVE_DANGER.panelSoft}`}>
            <h4 className="text-sm font-black text-white">Evidencia</h4>
            {evidenceFiles.length === 0 ? (
              <p className="mt-1.5 text-xs text-[#C8C8C8]">El cliente no adjuntó archivos.</p>
            ) : (
              <div className="mt-2 space-y-1.5">
                {evidenceFiles.map((file) => (
                  <div key={file.id} className="flex items-center gap-2 rounded-lg border border-white/8 bg-[#1B2028] p-2 text-xs font-bold text-white">
                    {file.mime_type.startsWith("image/") && file.signedUrl ? (
                      <img src={file.signedUrl} alt={file.file_name} className="size-10 rounded-md object-cover" />
                    ) : (
                      <FileText className="size-4 shrink-0 text-[#ffb4bd]" />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate">{file.file_name}</p>
                      <p className={`mt-0.5 text-10px font-bold ${ADMIN_SENSITIVE_DANGER.textMuted}`}>{getFileTypeLabel(file.mime_type)}</p>
                    </div>
                    <a href={file.signedUrl ?? undefined} target="_blank" rel="noreferrer" className="rounded-md border border-[#9f3546] px-2 py-1 text-10px text-[#ffc2c8] hover:border-[#bf4a5b]">Ver</a>
                    <a href={file.signedUrl ?? undefined} download={file.file_name} className="rounded-md border border-white/10 px-2 py-1 text-10px text-white/70 hover:border-[#9f3546]">
                      <Download className="size-3.5" />
                    </a>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className={`rounded-xl border p-3 ${ADMIN_SENSITIVE_DANGER.panelSoft}`}>
            <h4 className="text-sm font-black text-white">Acciones</h4>

            {cancellation ? (
              <div className="mt-2 grid gap-2">
                <button
                  type="button"
                  disabled={saving || closed || !cancellationCanBeApproved}
                  onClick={() => void approveCancellation()}
                  className={`inline-flex h-9 items-center justify-center gap-2 rounded-lg border px-3 text-xs font-black transition disabled:cursor-not-allowed disabled:opacity-45 ${ADMIN_SENSITIVE_DANGER.action}`}
                >
                  <ShieldCheck className="size-3.5" />
                  Aprobar cancelación
                </button>
                <button
                  type="button"
                  disabled={saving || closed}
                  onClick={() => void rejectCancellation()}
                  className={`inline-flex h-9 items-center justify-center gap-2 rounded-lg border px-3 text-xs font-black transition disabled:cursor-not-allowed disabled:opacity-45 ${ADMIN_SENSITIVE_DANGER.action}`}
                >
                  <X className="size-3.5" />
                  Rechazar cancelación
                </button>
              </div>
            ) : (
              <div className="mt-2 space-y-2">
                <AdminSelect
                  title="Estado del reclamo"
                  value={status}
                  compact
                  disabled={closed}
                  onChange={(value) => setStatus(value as OrderClaimStatus)}
                >
                  {STATUS_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </AdminSelect>
                <AdminSelect
                  title="Resolución definida por BEYONIX"
                  value={resolution}
                  compact
                  disabled={closed}
                  onChange={(value) => setResolution(value as OrderClaimResolution)}
                >
                  {RESOLUTION_OPTIONS.map((option) => (
                    <option key={option} value={option}>{getOrderClaimResolutionLabel(option)}</option>
                  ))}
                </AdminSelect>
                {statusChanged && (
                  <button type="button" disabled={saving || closed} onClick={() => void changeStatus()} className={`h-9 w-full rounded-lg border px-3 text-xs font-black transition disabled:opacity-45 ${ADMIN_SENSITIVE_DANGER.action}`}>
                    Guardar estado
                  </button>
                )}
                <button type="button" disabled={saving || closed} onClick={() => void approveSolution()} className={`h-9 w-full rounded-lg border px-3 text-xs font-black transition disabled:opacity-45 ${ADMIN_SENSITIVE_DANGER.action}`}>
                  Aprobar solución
                </button>
                <button type="button" disabled={saving || closed} onClick={() => void markResolved()} className={`h-9 w-full rounded-lg border px-3 text-xs font-black transition disabled:opacity-45 ${ADMIN_SENSITIVE_DANGER.action}`}>
                  Marcar como resuelto
                </button>
                <input
                  value={rejectionReason}
                  onChange={(event) => setRejectionReason(event.target.value)}
                  placeholder="Motivo de rechazo"
                  className="h-9 w-full rounded-lg border border-white/10 bg-[#1B2028] px-3 text-xs text-white outline-none placeholder:text-white/40 focus:border-red-300/45"
                />
                <button type="button" disabled={saving || closed} onClick={() => void rejectClaim()} className={`h-9 w-full rounded-lg border px-3 text-xs font-black transition disabled:opacity-45 ${ADMIN_SENSITIVE_DANGER.action}`}>
                  Rechazar reclamo
                </button>
              </div>
            )}
          </section>
        </aside>

        <section className={`flex min-h-[30rem] flex-col overflow-hidden rounded-xl border lg:h-[clamp(30rem,58vh,40rem)] ${ADMIN_SENSITIVE_DANGER.panelSoft}`}>
          <div className="border-b border-[#7f2d3a]/45 px-3 py-2.5">
            <h4 className="text-sm font-black text-white">Chat Cliente / BEYONIX</h4>
            <p className="mt-0.5 text-10px text-[#8EA0B5]">{messages.length} mensaje{messages.length === 1 ? "" : "s"}</p>
          </div>
          <div ref={chatRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
            {messages.length === 0 && <p className="rounded-lg bg-[#1B2028] px-3 py-2 text-xs text-[#C8C8C8]">Todavía no hay mensajes en esta conversación.</p>}
            {messages.map((message) => {
              const isCustomer = message.author_role === "cliente"
              return (
                <div key={message.id} className={`flex ${isCustomer ? "justify-start" : "justify-end"}`}>
                  <div className={`max-w-[82%] rounded-xl px-3 py-2 ${isCustomer ? "border border-[#7f2d3a]/55 bg-[#241217]" : "bg-[#2a1117]"}`}>
                    <p className={`text-10px font-black ${ADMIN_SENSITIVE_DANGER.label}`}>{isCustomer ? "Cliente" : "BEYONIX"}</p>
                    <p className="mt-0.5 whitespace-pre-wrap text-xs leading-5 text-white">{getClaimMessageText(message.message)}</p>
                    <p className="mt-1 text-[9px] text-white/45">{formatDate(message.created_at)}</p>
                  </div>
                </div>
              )
            })}
          </div>
          <div className="border-t border-white/8 bg-[#11161D] p-2.5">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <textarea
                value={response}
                disabled={closed}
                onChange={(event) => setResponse(event.target.value)}
                rows={2}
                placeholder={closed ? "Caso cerrado" : cancellation ? "Responder o escribir motivo para aprobar/rechazar" : "Responder al cliente"}
                className="min-h-16 min-w-0 flex-1 resize-none rounded-lg border border-[#7f2d3a]/55 bg-[#241217] px-3 py-2 text-xs leading-5 text-white outline-none placeholder:text-white/40 focus:border-[#bf4a5b] disabled:cursor-not-allowed disabled:opacity-45"
              />
              <button type="button" disabled={saving || closed || response.trim().length < 2} onClick={() => void sendResponse()} className={`inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-lg border px-4 text-xs font-black disabled:opacity-45 ${ADMIN_SENSITIVE_DANGER.actionSolid}`}>
                <Send className="size-3.5" />
                Enviar respuesta
              </button>
            </div>
          </div>
        </section>
      </div>

      {notice && <p className={`mx-3 mb-3 rounded-lg border px-3 py-2 text-xs font-bold text-white sm:mx-4 sm:mb-4 ${ADMIN_SENSITIVE_DANGER.panelSoft}`}>{notice}</p>}
    </section>
  )
}
