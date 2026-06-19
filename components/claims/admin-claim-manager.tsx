"use client"

import { useEffect, useState } from "react"
import { Check, Download, FileText, Send } from "lucide-react"

import { supabase } from "@/lib/supabase/client"
import { notifyOrderNotificationsChanged } from "@/lib/admin/order-notifications"
import {
  CUSTOMER_SELECTABLE_ORDER_CLAIM_RESOLUTIONS,
  getOrderClaimResolutionLabel,
  getOrderClaimStatusLabel,
} from "@/lib/order-claims"
import type { OrderClaimResolution, OrderClaimStatus, SupabaseOrderClaim, SupabasePedido } from "@/lib/supabase/types"

const PROBLEM_LABELS: Record<string, string> = {
  danado: "Llegó dañado",
  incorrecto: "Producto incorrecto",
  falla: "Producto con falla",
  devolucion: "Solicitud de devolución",
  otro: "Otro problema",
}

const STATUS_OPTIONS: Array<{ value: OrderClaimStatus; label: string; help: string }> = [
  { value: "en_revision", label: "🟡 En revisión", help: "Todavía estás revisando el caso." },
  { value: "falta_informacion", label: "🔵 Esperando respuesta del cliente", help: "Necesitás que el cliente envíe más datos." },
  { value: "aprobado", label: "🟣 Solución ofrecida", help: "Ya hay una propuesta para el cliente." },
  { value: "cerrado", label: "🟢 Cerrado", help: "El caso está terminado." },
  { value: "rechazado", label: "🔴 Rechazado", help: "El reclamo no corresponde." },
]

function formatDate(value: string) {
  return new Intl.DateTimeFormat("es-AR", { dateStyle: "short", timeStyle: "short", timeZone: "America/Argentina/Buenos_Aires" }).format(new Date(value))
}

function productName(order: SupabasePedido) {
  const names = (order.orden_items ?? []).map((item) => item.productos?.nombre).filter(Boolean)
  return names.length ? names.join(", ") : "Producto del pedido"
}

export function AdminClaimManager({ pedido, onClaimChange }: { pedido: SupabasePedido; onClaimChange: (claim: SupabaseOrderClaim) => void }) {
  const claims = pedido.order_claims ?? []
  const [claimId, setClaimId] = useState<number | null>(claims[0]?.id ?? null)
  const claim = claims.find((item) => item.id === claimId) ?? claims[0]
  const [status, setStatus] = useState<OrderClaimStatus>(claim?.status === "recibido" ? "en_revision" : claim?.status ?? "en_revision")
  const [response, setResponse] = useState("")
  const [rejectionReason, setRejectionReason] = useState("")
  const [solutions, setSolutions] = useState<OrderClaimResolution[]>([])
  const [otherSolution, setOtherSolution] = useState("")
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState("")

  useEffect(() => {
    if (!claim) return
    setStatus(claim.status === "recibido" ? "en_revision" : claim.status)
    setRejectionReason(claim.rejection_reason ?? "")
    setSolutions(claim.offered_resolutions ?? [])
    setResponse("")
    setNotice("")
  }, [claim?.id])

  const updateClaim = async (overrides: Record<string, unknown>, successMessage: string) => {
    if (!claim) return false
    setSaving(true); setNotice("")
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) { setNotice("La sesión administrativa venció."); return false }
      const payload = {
        status,
        resolution: claim.resolution ?? null,
        offered_resolutions: claim.offered_resolutions ?? [],
        admin_response: claim.admin_response ?? "",
        rejection_reason: claim.rejection_reason ?? "",
        ...overrides,
      }
      const request = await fetch(`/api/admin/order-claims/${claim.id}`, { method: "PATCH", headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" }, body: JSON.stringify(payload) })
      const data = (await request.json()) as { claim?: SupabaseOrderClaim; error?: string }
      if (!request.ok || !data.claim) { setNotice(data.error || "No se pudo actualizar el reclamo."); return false }
      onClaimChange(data.claim); setStatus(data.claim.status); setSolutions(data.claim.offered_resolutions ?? []); setRejectionReason(data.claim.rejection_reason ?? ""); setNotice(successMessage)
      notifyOrderNotificationsChanged()
      return true
    } catch { setNotice("No se pudo actualizar el reclamo."); return false } finally { setSaving(false) }
  }

  const sendResponse = async () => {
    if (response.trim().length < 2) return setNotice("Escribí una respuesta para el cliente.")
    const sent = await updateClaim({ admin_response: response.trim() }, "Respuesta enviada al cliente.")
    if (sent) setResponse("")
  }

  const changeStatus = async () => {
    if (status === "rechazado") {
      if (!rejectionReason.trim()) return setNotice("El motivo del rechazo es obligatorio.")
      return void updateClaim({ status: "rechazado", resolution: "rechazado", rejection_reason: rejectionReason.trim(), admin_response: rejectionReason.trim() }, "Reclamo rechazado y cliente notificado.")
    }
    await updateClaim({
      status,
      resolution:
        status === "cerrado"
          ? claim.resolution ?? claim.customer_selected_resolution ?? "otro"
          : claim.resolution ?? null,
    }, "Estado actualizado.")
  }

  const offerSolution = async () => {
    if (solutions.length === 0) return setNotice("Elegí al menos una solución para ofrecer.")
    if (solutions.includes("otro") && !otherSolution.trim()) return setNotice("Describí la otra solución.")
    const labels = solutions.map(getOrderClaimResolutionLabel).join(", ")
    const message = otherSolution.trim() ? `Te ofrecemos: ${labels}. Detalle: ${otherSolution.trim()}` : `Te ofrecemos: ${labels}.`
    const sent = await updateClaim({ status: "aprobado", offered_resolutions: solutions, resolution: null, admin_response: message }, "Solución enviada al cliente.")
    if (sent) setOtherSolution("")
  }

  if (!claim) return <section className="mt-4 rounded-2xl border border-white/10 bg-[#141414] p-5"><h3 className="text-lg font-black text-white">Gestión del reclamo</h3><p className="mt-2 text-sm text-white/65">Este pedido todavía no tiene reclamos.</p></section>

  const messages = [...(claim.order_claim_messages ?? [])].sort((a, b) => +new Date(a.created_at) - +new Date(b.created_at))
  const customer = pedido.cliente_nombre || pedido.cliente_username || pedido.cliente_email || "Cliente"

  return <section className="mt-4 rounded-3xl border border-blue-300/20 bg-black p-4 sm:p-5">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-xs font-black uppercase tracking-[0.18em] text-blue-300">Soporte BEYONIX</p><h3 className="mt-2 text-xl font-black text-white">Gestión del reclamo #{claim.id}</h3></div>{claims.length > 1 && <select value={claim.id} onChange={(event) => setClaimId(Number(event.target.value))} className="h-11 rounded-xl border border-white/15 bg-[#181818] px-3 text-sm font-bold text-white">{claims.map((item) => <option key={item.id} value={item.id}>Reclamo #{item.id}</option>)}</select>}</div>
    <div className="mt-5 grid gap-5 xl:grid-cols-[0.9fr_1.1fr]">
      <div className="space-y-4">
        <div className="rounded-2xl border border-white/10 bg-[#141414] p-4"><h4 className="text-base font-black text-white">Información del caso</h4><dl className="mt-4 grid gap-3 sm:grid-cols-2">{[["Cliente", customer], ["Pedido", `BX-${1000 + pedido.id}`], ["Fecha", formatDate(claim.created_at)], ["Producto", productName(pedido)], ["Motivo", PROBLEM_LABELS[claim.failure_type ?? ""] ?? claim.failure_type ?? "Solicitud de ayuda"], ["Estado", getOrderClaimStatusLabel(claim.status)]].map(([label, value]) => <div key={label} className="rounded-xl bg-[#181818] p-3"><dt className="text-xs font-bold text-white/60">{label}</dt><dd className="mt-1 text-sm font-black text-white">{value}</dd></div>)}</dl><div className="mt-3 rounded-xl bg-[#181818] p-3"><p className="text-xs font-bold text-white/60">Descripción del cliente</p><p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-white">{claim.description}</p></div></div>
        <div className="rounded-2xl border border-white/10 bg-[#141414] p-4"><h4 className="text-base font-black text-white">Evidencia</h4>{(claim.order_claim_files ?? []).length ? <div className="mt-3 grid gap-3 sm:grid-cols-2">{claim.order_claim_files?.map((file) => file.mime_type.startsWith("image/") && file.signedUrl ? <a key={file.id} href={file.signedUrl} target="_blank" rel="noreferrer" className="overflow-hidden rounded-xl border border-white/10 bg-[#181818]"><img src={file.signedUrl} alt={file.file_name} className="h-32 w-full object-cover" /><span className="block truncate px-3 py-2 text-xs font-bold text-white">{file.file_name}</span></a> : file.mime_type.startsWith("video/") && file.signedUrl ? <div key={file.id} className="overflow-hidden rounded-xl border border-white/10 bg-[#181818]"><video src={file.signedUrl} controls className="h-36 w-full bg-black object-contain" /><span className="block truncate px-3 py-2 text-xs font-bold text-white">{file.file_name}</span></div> : <a key={file.id} href={file.signedUrl ?? undefined} target="_blank" rel="noreferrer" className="flex items-center gap-2 rounded-xl border border-white/10 bg-[#181818] p-3 text-xs font-bold text-white"><FileText className="size-4 text-blue-300" /><span className="truncate">{file.file_name}</span><Download className="ml-auto size-4" /></a>)}</div> : <p className="mt-2 text-sm text-white/65">El cliente no adjuntó archivos.</p>}</div>
      </div>
      <div className="space-y-4">
        <div className="overflow-hidden rounded-2xl border border-white/10 bg-[#141414]"><div className="border-b border-white/10 px-4 py-3"><h4 className="text-base font-black text-white">Chat cliente ↔ BEYONIX</h4></div><div className="max-h-[28rem] space-y-3 overflow-y-auto p-4">{messages.map((message) => { const isCustomer = message.author_role === "cliente"; return <div key={message.id} className={`flex ${isCustomer ? "justify-start" : "justify-end"}`}><div className={`max-w-[85%] rounded-2xl px-4 py-3 ${isCustomer ? "border border-white/10 bg-[#181818]" : "bg-[#112A43]"}`}><p className="text-xs font-black text-blue-200">{isCustomer ? "Cliente" : "BEYONIX"}</p><p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-white">{message.message}</p><p className="mt-2 text-[10px] text-white/55">{formatDate(message.created_at)}</p></div></div>})}</div><div className="border-t border-white/10 p-4"><textarea value={response} onChange={(event) => setResponse(event.target.value)} rows={4} placeholder="Responder al cliente" className="w-full resize-none rounded-xl border border-white/15 bg-[#181818] px-4 py-3 text-sm text-white outline-none placeholder:text-white/50 focus:border-blue-300/60" /><button type="button" disabled={saving} onClick={() => void sendResponse()} className="mt-3 inline-flex h-11 items-center gap-2 rounded-xl bg-[#112A43] px-5 text-sm font-black text-white disabled:opacity-50"><Send className="size-4" />Enviar respuesta</button></div></div>
        <div className="rounded-2xl border border-white/10 bg-[#141414] p-4"><h4 className="text-base font-black text-white">1. Cambiar estado</h4><select value={status} onChange={(event) => setStatus(event.target.value as OrderClaimStatus)} className="mt-3 h-12 w-full rounded-xl border border-white/15 bg-[#181818] px-3 text-sm font-bold text-white">{STATUS_OPTIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select><p className="mt-2 text-xs text-white/65">{STATUS_OPTIONS.find((item) => item.value === status)?.help}</p>{status === "rechazado" && <textarea value={rejectionReason} onChange={(event) => setRejectionReason(event.target.value)} rows={3} placeholder="Motivo del rechazo (obligatorio). Ej: No se pudo validar el daño informado." className="mt-3 w-full resize-none rounded-xl border border-red-300/25 bg-[#181818] px-3 py-3 text-sm text-white outline-none placeholder:text-white/50" />}<button type="button" disabled={saving} onClick={() => void changeStatus()} className="mt-3 h-11 rounded-xl border border-white/15 bg-[#181818] px-5 text-sm font-black text-white disabled:opacity-50">Guardar estado</button></div>
        <div className="rounded-2xl border border-blue-300/15 bg-[#141414] p-4"><h4 className="text-base font-black text-white">2. Ofrecer solución</h4><div className="mt-3 grid gap-2 sm:grid-cols-2">{CUSTOMER_SELECTABLE_ORDER_CLAIM_RESOLUTIONS.map((solution) => <label key={solution} className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border px-3 text-sm font-bold text-white ${solutions.includes(solution) ? "border-blue-300/40 bg-[#112A43]" : "border-blue-300/10 bg-[#181818]"}`}><input type="checkbox" checked={solutions.includes(solution)} onChange={() => setSolutions((current) => current.includes(solution) ? current.filter((item) => item !== solution) : [...current, solution])} className="size-4 accent-blue-300" /><Check className="size-4 text-blue-300" />{getOrderClaimResolutionLabel(solution)}</label>)}</div>{solutions.includes("otro") && <textarea value={otherSolution} onChange={(event) => setOtherSolution(event.target.value)} rows={3} placeholder="Describí la otra solución" className="mt-3 w-full resize-none rounded-xl border border-white/15 bg-[#181818] px-3 py-3 text-sm text-white outline-none" />}<button type="button" disabled={saving} onClick={() => void offerSolution()} className="mt-3 h-11 rounded-xl bg-[#112A43] px-5 text-sm font-black text-white disabled:opacity-50">Ofrecer solución</button></div>
        {notice && <p className="rounded-xl border border-blue-300/20 bg-blue-400/10 px-4 py-3 text-sm font-bold text-white">{notice}</p>}
      </div>
    </div>
  </section>
}
