"use client"

import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { Check, Download, FileText, Send } from "lucide-react"

import { supabase } from "@/lib/supabase/client"
import { notifyOrderNotificationsChanged } from "@/lib/admin/order-notifications"
import {
  CUSTOMER_SELECTABLE_ORDER_CLAIM_RESOLUTIONS,
  getOrderClaimResolutionLabel,
} from "@/lib/order-claims"
import type {
  OrderClaimResolution,
  OrderClaimStatus,
  SupabaseOrderClaim,
  SupabasePedido,
} from "@/lib/supabase/types"

const PROBLEM_LABELS: Record<string, string> = {
  danado: "Llegó dañado",
  incorrecto: "Producto incorrecto",
  falla: "Producto con falla",
  devolucion: "Solicitud de devolución",
  no_llego: "Nunca llegó el envío",
  otro: "Otro problema",
}

const STATUS_OPTIONS: Array<{
  value: OrderClaimStatus
  label: string
  tone: string
}> = [
  { value: "recibido", label: "Abierto", tone: "text-blue-200" },
  { value: "en_revision", label: "En revisión", tone: "text-amber-200" },
  { value: "falta_informacion", label: "Esperando cliente", tone: "text-blue-200" },
  { value: "aprobado", label: "Solución ofrecida", tone: "text-violet-200" },
  { value: "cerrado", label: "Resuelto", tone: "text-emerald-200" },
  { value: "rechazado", label: "Rechazado", tone: "text-red-200" },
]

function formatDate(value: string) {
  return new Intl.DateTimeFormat("es-AR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "America/Argentina/Buenos_Aires",
  }).format(new Date(value))
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
    product: match?.[1]?.trim() || productName(order),
    description: match?.[2]?.trim() || claim.description,
  }
}

function getStatusLabel(status: OrderClaimStatus) {
  return STATUS_OPTIONS.find((option) => option.value === status)?.label ?? status
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
  const [response, setResponse] = useState("")
  const [rejectionReason, setRejectionReason] = useState("")
  const [solutions, setSolutions] = useState<OrderClaimResolution[]>([])
  const [otherSolution, setOtherSolution] = useState("")
  const [solutionOpen, setSolutionOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState("")
  const chatRef = useRef<HTMLDivElement>(null)
  const messageCount = claim?.order_claim_messages?.length ?? 0

  useLayoutEffect(() => {
    const chat = chatRef.current
    if (chat) chat.scrollTop = chat.scrollHeight
  }, [claim?.id, messageCount])

  useEffect(() => {
    if (!claim) return
    setStatus(claim.status)
    setRejectionReason(claim.rejection_reason ?? "")
    setSolutions(claim.offered_resolutions ?? [])
    setResponse("")
    setNotice("")
    setSolutionOpen(false)
  }, [claim?.id])

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
        offered_resolutions: claim.offered_resolutions ?? [],
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
        setNotice(data.error || "No se pudo actualizar el reclamo.")
        return false
      }

      onClaimChange(data.claim)
      setStatus(data.claim.status)
      setSolutions(data.claim.offered_resolutions ?? [])
      setRejectionReason(data.claim.rejection_reason ?? "")
      setNotice(successMessage)
      notifyOrderNotificationsChanged()
      return true
    } catch {
      setNotice("No se pudo actualizar el reclamo.")
      return false
    } finally {
      setSaving(false)
    }
  }

  const sendResponse = async () => {
    if (!claim || response.trim().length < 2) {
      setNotice("Escribí una respuesta para el cliente.")
      return
    }

    const sent = await updateClaim(
      { status: claim.status, admin_response: response.trim() },
      "Respuesta enviada al cliente.",
    )
    if (sent) setResponse("")
  }

  const changeStatus = async () => {
    if (!claim) return
    if (status === "rechazado") {
      if (!rejectionReason.trim()) {
        setNotice("El motivo del rechazo es obligatorio.")
        return
      }
      await updateClaim(
        {
          status: "rechazado",
          resolution: "rechazado",
          rejection_reason: rejectionReason.trim(),
          admin_response: rejectionReason.trim(),
        },
        "Reclamo rechazado y cliente notificado.",
      )
      return
    }

    await updateClaim(
      {
        status,
        resolution:
          status === "cerrado"
            ? claim.resolution ?? claim.customer_selected_resolution ?? "otro"
            : claim.resolution ?? null,
      },
      "Estado actualizado.",
    )
  }

  const offerSolution = async () => {
    if (solutions.length === 0) {
      setNotice("Elegí al menos una solución para ofrecer.")
      return
    }
    if (solutions.includes("otro") && !otherSolution.trim()) {
      setNotice("Describí la otra solución.")
      return
    }

    const labels = solutions.map(getOrderClaimResolutionLabel).join(", ")
    const message = otherSolution.trim()
      ? `Te ofrecemos: ${labels}. Detalle: ${otherSolution.trim()}`
      : `Te ofrecemos: ${labels}.`
    const sent = await updateClaim(
      {
        status: "aprobado",
        offered_resolutions: solutions,
        resolution: null,
        admin_response: message,
      },
      "Solución enviada al cliente.",
    )

    if (sent) {
      setOtherSolution("")
      setSolutionOpen(false)
    }
  }

  if (!claim) {
    return <section className="admin-claim-manager mt-3 rounded-2xl border border-white/10 bg-[#0D1117] p-4"><h3 className="text-base font-black text-white">Gestión del reclamo</h3><p className="mt-1 text-sm text-[#C8C8C8]">Este pedido todavía no tiene reclamos.</p></section>
  }

  const messages = [...(claim.order_claim_messages ?? [])].sort(
    (a, b) => +new Date(a.created_at) - +new Date(b.created_at),
  )
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
  const offeredSolutions = claim.offered_resolutions ?? []
  const statusChanged = status !== claim.status
  const solutionState = claim.customer_selected_resolution
    ? "Aceptada por el cliente"
    : claim.status === "rechazado"
      ? "Rechazada"
      : "Pendiente de respuesta"

  return (
    <section className="admin-claim-manager mt-3 overflow-hidden rounded-2xl border border-blue-300/20 bg-[#0D1117] shadow-[0_0_24px_rgba(17,42,67,0.18)]">
      <header className="border-b border-white/8 bg-[#11161D] px-3 py-3 sm:px-4">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <h3 className="text-lg font-black text-white">Reclamo #{claim.id}</h3>
              <span className="text-xs font-bold text-amber-200">{getStatusLabel(claim.status)}</span>
              {claims.length > 1 && (
                <select value={claim.id} onChange={(event) => setClaimId(Number(event.target.value))} className="h-8 rounded-lg border border-white/12 bg-[#15191F] px-2 text-xs font-bold text-white outline-none">
                  {claims.map((item) => <option key={item.id} value={item.id}>Reclamo #{item.id}</option>)}
                </select>
              )}
            </div>
            <p className="mt-1 truncate text-xs text-[#C8C8C8]">Motivo: <strong className="text-white">{reason}</strong> · Producto: <strong className="text-white">{details.product}</strong> · Cliente: <strong className="text-white">{customer}</strong></p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <label className="flex h-9 items-center gap-2 rounded-lg border border-white/12 bg-[#15191F] px-2.5">
              <span className="text-10px font-black uppercase tracking-wide text-[#8EA0B5]">Estado</span>
              <select value={status} onChange={(event) => setStatus(event.target.value as OrderClaimStatus)} className={`cursor-pointer bg-transparent text-xs font-black outline-none ${STATUS_OPTIONS.find((option) => option.value === status)?.tone ?? "text-white"}`}>
                {STATUS_OPTIONS.map((option) => <option key={option.value} value={option.value} className="bg-[#15191F] text-white">{option.label}</option>)}
              </select>
            </label>
            {(statusChanged || status === "rechazado") && <button type="button" disabled={saving} onClick={() => void changeStatus()} className="h-9 rounded-lg border border-white/12 bg-[#1B2028] px-3 text-xs font-black text-white disabled:opacity-45">Guardar</button>}
            <button type="button" onClick={() => setSolutionOpen((current) => !current)} className="h-9 rounded-lg border border-blue-300/25 bg-[#112A43] px-3 text-xs font-black text-white">{solutionOpen ? "Cerrar soluciones" : "Ofrecer solución"}</button>
          </div>
        </div>

        {status === "rechazado" && (
          <div className="mt-2 flex flex-col gap-2 sm:flex-row">
            <input value={rejectionReason} onChange={(event) => setRejectionReason(event.target.value)} placeholder="Motivo del rechazo (obligatorio)" className="h-9 min-w-0 flex-1 rounded-lg border border-red-300/25 bg-[#15191F] px-3 text-xs text-white outline-none placeholder:text-white/40" />
          </div>
        )}

        {solutionOpen && (
          <div className="mt-3 rounded-xl border border-blue-300/15 bg-[#0D1117] p-3">
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
              {CUSTOMER_SELECTABLE_ORDER_CLAIM_RESOLUTIONS.map((solution) => (
                <label key={solution} className={`flex min-h-9 items-center gap-2 rounded-lg border px-2.5 text-xs font-bold text-white transition-colors ${solutions.includes(solution) ? "border-blue-300/45 bg-[#112A43]" : "border-white/9 bg-[#15191F] hover:border-blue-300/25"}`}>
                  <input type="checkbox" checked={solutions.includes(solution)} onChange={() => setSolutions((current) => current.includes(solution) ? current.filter((item) => item !== solution) : [...current, solution])} className="size-3.5 accent-blue-300" />
                  <Check className="size-3.5 shrink-0 text-blue-300" />
                  <span>{getOrderClaimResolutionLabel(solution)}</span>
                </label>
              ))}
            </div>
            {solutions.includes("otro") && <input value={otherSolution} onChange={(event) => setOtherSolution(event.target.value)} placeholder="Describí la otra solución" className="mt-2 h-9 w-full rounded-lg border border-white/12 bg-[#15191F] px-3 text-xs text-white outline-none" />}
            <div className="mt-2 flex justify-end"><button type="button" disabled={saving || solutions.length === 0} onClick={() => void offerSolution()} className="h-9 rounded-lg bg-[#112A43] px-4 text-xs font-black text-white disabled:opacity-45">Enviar solución al cliente</button></div>
          </div>
        )}
      </header>

      {offeredSolutions.length > 0 && !solutionOpen && (
        <div className="mx-3 mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-blue-300/15 bg-[#15191F] px-3 py-2 sm:mx-4">
          <div><p className="text-10px font-black uppercase tracking-widest text-blue-300">Solución ofrecida</p><p className="mt-0.5 text-xs font-bold text-white">{offeredSolutions.map(getOrderClaimResolutionLabel).join(" · ")}</p></div>
          <div className="text-right"><p className="text-10px text-[#8EA0B5]">{formatDate(claim.updated_at)}</p><p className={`mt-0.5 text-xs font-black ${claim.customer_selected_resolution ? "text-emerald-300" : "text-amber-200"}`}>{solutionState}</p></div>
        </div>
      )}

      <div className="grid gap-3 p-3 lg:grid-cols-[minmax(260px,0.7fr)_minmax(0,1.3fr)] sm:p-4">
        <aside className="space-y-3">
          <section className="rounded-xl border border-white/9 bg-[#15191F] p-3">
            <h4 className="text-sm font-black text-white">Información del caso</h4>
            <dl className="mt-2 divide-y divide-white/7">
              {[
                ["Cliente", customer],
                ["Pedido", `BX-${1000 + pedido.id}`],
                ["Producto afectado", details.product],
                ["Motivo", reason],
                ["Estado", getStatusLabel(claim.status)],
              ].map(([label, value]) => <div key={label} className="grid grid-cols-[105px_minmax(0,1fr)] gap-2 py-2"><dt className="text-10px font-bold uppercase tracking-wide text-[#8EA0B5]">{label}</dt><dd className="text-xs font-bold leading-5 text-white">{value}</dd></div>)}
            </dl>
            <div className="mt-2 rounded-lg bg-[#1B2028] p-2.5"><p className="text-10px font-bold uppercase tracking-wide text-[#8EA0B5]">Descripción del cliente</p><p className="mt-1 whitespace-pre-wrap text-xs leading-5 text-[#C8C8C8]">{details.description}</p></div>
          </section>

          <section className="rounded-xl border border-white/9 bg-[#15191F] p-3">
            <h4 className="text-sm font-black text-white">Evidencia</h4>
            {files.length === 0 ? <p className="mt-1.5 text-xs text-[#C8C8C8]">El cliente no adjuntó archivos.</p> : <div className="mt-2 space-y-1.5">{files.map((file) => <a key={file.id} href={file.signedUrl ?? undefined} target="_blank" rel="noreferrer" className="flex items-center gap-2 rounded-lg border border-white/8 bg-[#1B2028] p-2 text-xs font-bold text-white hover:border-blue-300/25">{file.mime_type.startsWith("image/") && file.signedUrl ? <img src={file.signedUrl} alt="" className="size-9 rounded-md object-cover" /> : <FileText className="size-4 shrink-0 text-blue-300" />}<span className="min-w-0 flex-1 truncate">{file.file_name}</span><span className="text-10px text-blue-300">Ver</span><Download className="size-3.5" /></a>)}</div>}
          </section>
        </aside>

        <section className="flex min-h-[30rem] flex-col overflow-hidden rounded-xl border border-blue-300/15 bg-[#15191F] lg:h-[clamp(30rem,58vh,40rem)]">
          <div className="border-b border-white/8 px-3 py-2.5"><h4 className="text-sm font-black text-white">Chat cliente ↔ BEYONIX</h4><p className="mt-0.5 text-10px text-[#8EA0B5]">{messages.length} mensaje{messages.length === 1 ? "" : "s"}</p></div>
          <div ref={chatRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
            {messages.length === 0 && <p className="rounded-lg bg-[#1B2028] px-3 py-2 text-xs text-[#C8C8C8]">Todavía no hay mensajes en esta conversación.</p>}
            {messages.map((message) => {
              const isCustomer = message.author_role === "cliente"
              return <div key={message.id} className={`flex ${isCustomer ? "justify-start" : "justify-end"}`}><div className={`max-w-[82%] rounded-xl px-3 py-2 ${isCustomer ? "border border-white/9 bg-[#1B2028]" : "bg-[#112A43]"}`}><p className="text-10px font-black text-blue-200">{isCustomer ? "Cliente" : "BEYONIX"}</p><p className="mt-0.5 whitespace-pre-wrap text-xs leading-5 text-white">{message.message}</p><p className="mt-1 text-[9px] text-white/45">{formatDate(message.created_at)}</p></div></div>
            })}
          </div>
          <div className="border-t border-white/8 bg-[#11161D] p-2.5">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <textarea value={response} onChange={(event) => setResponse(event.target.value)} rows={2} placeholder="Responder al cliente" className="min-h-16 min-w-0 flex-1 resize-none rounded-lg border border-white/12 bg-[#1B2028] px-3 py-2 text-xs leading-5 text-white outline-none placeholder:text-white/40 focus:border-blue-300/45" />
              <button type="button" disabled={saving || response.trim().length < 2} onClick={() => void sendResponse()} className="inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-lg bg-[#112A43] px-4 text-xs font-black text-white disabled:opacity-45"><Send className="size-3.5" />Enviar respuesta</button>
            </div>
          </div>
        </section>
      </div>

      {notice && <p className="mx-3 mb-3 rounded-lg border border-blue-300/20 bg-blue-400/10 px-3 py-2 text-xs font-bold text-white sm:mx-4 sm:mb-4">{notice}</p>}
    </section>
  )
}
