"use client"

import { useEffect, useLayoutEffect, useRef, useState } from "react"
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  CircleCheck,
  FileText,
  MessageCircle,
  Package,
  Paperclip,
  RefreshCcw,
  Send,
  Truck,
  Upload,
  X,
} from "lucide-react"

import {
  getClaimFileValidationError,
  getOrderClaimResolutionLabel,
} from "@/lib/order-claims"
import type {
  OrderClaimResolution,
  OrderClaimType,
  SupabaseOrderClaim,
  SupabaseOrderClaimFile,
  SupabasePedido,
} from "@/lib/supabase/types"

export type ClaimProblemId = "danado" | "incorrecto" | "falla" | "devolucion" | "no_llego" | "otro"
type ProblemId = ClaimProblemId

const PROBLEMS: Array<{
  id: ProblemId
  title: string
  description: string
  icon: typeof Package
  claimType: OrderClaimType
}> = [
  { id: "danado", title: "Llegó dañado", description: "El producto o paquete llegó roto", icon: Package, claimType: "transporte_48hs" },
  { id: "incorrecto", title: "Producto incorrecto", description: "Recibí algo diferente a lo comprado", icon: X, claimType: "transporte_48hs" },
  { id: "falla", title: "Producto con falla", description: "El producto dejó de funcionar", icon: AlertTriangle, claimType: "garantia_beyonix" },
  { id: "devolucion", title: "Quiero devolverlo", description: "Quiero solicitar una devolución", icon: RefreshCcw, claimType: "garantia_beyonix" },
  { id: "no_llego", title: "Nunca llegó el envío", description: "El pedido no llegó a destino", icon: Truck, claimType: "transporte_48hs" },
  { id: "otro", title: "Otro problema", description: "Necesito ayuda por otro motivo", icon: MessageCircle, claimType: "garantia_beyonix" },
]

const PROBLEM_LABELS: Record<string, string> = {
  danado: "Llegó dañado",
  incorrecto: "Producto incorrecto",
  falla: "Producto con falla",
  devolucion: "Solicitud de devolución",
  no_llego: "Nunca llegó el envío",
  otro: "Otro problema",
}

function getItemImage(item: NonNullable<SupabasePedido["orden_items"]>[number]) {
  return item.producto_variantes?.imagenes?.[0]
    || item.productos?.imagen_principal
    || item.productos?.imagenes_producto?.[0]?.url
    || ""
}

function getItemVariant(item: NonNullable<SupabasePedido["orden_items"]>[number]) {
  return item.producto_variantes?.nombre?.trim() || "Sin variante"
}

function formatPrice(value: number) {
  return new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    maximumFractionDigits: 0,
  }).format(value)
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("es-AR", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/Argentina/Buenos_Aires",
  }).format(new Date(value))
}

function statusInfo(status: SupabaseOrderClaim["status"]) {
  if (status === "falta_informacion") return { label: "Necesitamos información", dot: "bg-blue-400", style: "border-blue-300/25 bg-blue-400/10" }
  if (status === "aprobado") return { label: "Solución ofrecida", dot: "bg-blue-300", style: "border-blue-300/25 bg-[#112A43]" }
  if (status === "cerrado") return { label: "Cerrado", dot: "bg-emerald-400", style: "border-emerald-300/25 bg-emerald-400/10" }
  if (status === "rechazado") return { label: "Rechazado", dot: "bg-red-400", style: "border-red-300/25 bg-red-400/10" }
  return { label: "En revisión", dot: "bg-amber-400", style: "border-amber-300/25 bg-amber-400/10" }
}

function FilePreview({ file }: { file: SupabaseOrderClaimFile }) {
  const isImage = file.mime_type.startsWith("image/")
  const isVideo = file.mime_type.startsWith("video/")
  if (isImage && file.signedUrl) {
    return <a href={file.signedUrl} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-lg border border-blue-300/15 bg-[#181818]"><img src={file.signedUrl} alt={file.file_name} className="h-24 w-full object-cover" /><span className="block truncate px-2.5 py-1.5 text-xs font-bold text-white">{file.file_name}</span></a>
  }
  if (isVideo && file.signedUrl) {
    return <div className="overflow-hidden rounded-lg border border-blue-300/15 bg-[#181818]"><video src={file.signedUrl} controls className="h-28 w-full bg-black object-contain" /><span className="block truncate px-2.5 py-1.5 text-xs font-bold text-white">{file.file_name}</span></div>
  }
  return <a href={file.signedUrl ?? undefined} target="_blank" rel="noreferrer" className="flex items-center gap-2 rounded-lg border border-blue-300/15 bg-[#181818] px-2.5 py-2 text-xs font-bold text-white"><FileText className="size-4 text-blue-300" /><span className="truncate">{file.file_name}</span></a>
}

function EvidenceUploader({ files, onChange, disabled }: { files: File[]; onChange: (files: File[]) => void; disabled?: boolean }) {
  return (
    <div>
      <label className="flex min-h-16 cursor-pointer items-center justify-center gap-3 rounded-xl border border-dashed border-blue-300/30 bg-[#181818] px-3 py-2 text-left transition hover:border-blue-300/60">
        <Upload className="size-5 shrink-0 text-blue-300" />
        <span><span className="block text-xs font-black text-white">Adjuntar fotos, videos o archivos</span><span className="mt-0.5 block text-[11px] text-white/65">Las fotos nos ayudan a resolver tu caso más rápido.</span></span>
        <input type="file" multiple disabled={disabled} accept="image/*,video/*,.pdf,.doc,.docx,.txt" className="sr-only" onChange={(event) => onChange([...files, ...Array.from(event.target.files ?? [])])} />
      </label>
      {files.length > 0 && <div className="mt-2 flex flex-wrap gap-1.5">{files.map((file, index) => <span key={`${file.name}-${index}`} className="inline-flex max-w-64 items-center gap-1.5 rounded-lg border border-white/10 bg-[#181818] px-2.5 py-1.5 text-xs font-bold text-white"><Paperclip className="size-3.5 shrink-0 text-blue-300" /><span className="truncate">{file.name}</span><button type="button" aria-label={`Quitar ${file.name}`} onClick={() => onChange(files.filter((_, itemIndex) => itemIndex !== index))}><X className="size-3.5" /></button></span>)}</div>}
    </div>
  )
}

function appendFiles(formData: FormData, files: File[], role: string) {
  files.forEach((file) => {
    formData.append("files", file)
    formData.append("fileRoles", role)
  })
}

export function CustomerClaimExperience({ order, initialProblem }: { order: SupabasePedido; initialProblem?: ClaimProblemId }) {
  const orderItems = order.orden_items ?? []
  const wholeOrderDisabled = orderItems.length === 1
  const defaultAffectedItem = orderItems.length === 1 ? String(orderItems[0].id) : null
  const [claims, setClaims] = useState<SupabaseOrderClaim[]>(order.order_claims ?? [])
  const [step, setStep] = useState<1 | 2 | 3>(initialProblem ? 2 : 1)
  const [affectedItem, setAffectedItem] = useState<string | null>(defaultAffectedItem)
  const [problem, setProblem] = useState<ProblemId | null>(initialProblem ?? null)
  const [description, setDescription] = useState("")
  const [files, setFiles] = useState<File[]>([])
  const [reply, setReply] = useState("")
  const [replyFiles, setReplyFiles] = useState<File[]>([])
  const [selectedResolution, setSelectedResolution] = useState<OrderClaimResolution | null>(null)
  const [justCreated, setJustCreated] = useState<SupabaseOrderClaim | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const replyRef = useRef<HTMLTextAreaElement>(null)
  const chatRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let mounted = true
    fetch(`/api/orders/${order.id}/claims`).then(async (response) => {
      const data = (await response.json()) as { claims?: SupabaseOrderClaim[] }
      if (mounted && response.ok) setClaims(data.claims ?? [])
    })
    return () => { mounted = false }
  }, [order.id])

  useEffect(() => {
    if (!initialProblem || claims.length > 0) return
    setProblem(initialProblem)
    setStep(defaultAffectedItem ? 2 : 1)
  }, [claims.length, defaultAffectedItem, initialProblem])

  const activeClaim = claims.find((claim) => ["recibido", "en_revision", "falta_informacion", "aprobado"].includes(claim.status))
  const claim = activeClaim ?? claims[0]
  const messageCount = claim?.order_claim_messages?.length ?? 0

  useLayoutEffect(() => {
    const chat = chatRef.current
    if (!chat) return

    chat.scrollTop = chat.scrollHeight
  }, [claim?.id, messageCount])

  const validateFiles = (selectedFiles: File[]) => selectedFiles.map((file) => getClaimFileValidationError(file)).find(Boolean) ?? ""

  const createClaim = async () => {
    if (!affectedItem) return setError("Elegí el producto afectado o seleccioná todo el pedido.")
    if (!problem) return setError("Elegí el problema que mejor describe lo ocurrido.")
    if (description.trim().length < 20) return setError("Contanos un poco más. La descripción debe tener al menos 20 caracteres.")
    const fileError = validateFiles(files)
    if (fileError) return setError(fileError)
    setLoading(true); setError("")
    try {
      const selected = PROBLEMS.find((item) => item.id === problem)!
      const selectedOrderItem = orderItems.find((item) => String(item.id) === affectedItem)
      const affectedLabel = affectedItem === "order"
        ? "Todo el pedido"
        : `${selectedOrderItem?.productos?.nombre ?? "Producto"} · ${getItemVariant(selectedOrderItem!)}`
      const formData = new FormData()
      formData.set("claimType", selected.claimType)
      formData.set("problemType", problem)
      formData.set("description", `Producto afectado: ${affectedLabel}\n\n${description.trim()}`)
      appendFiles(formData, files, "evidencia_inicial")
      const response = await fetch(`/api/orders/${order.id}/claims`, { method: "POST", body: formData })
      const data = (await response.json()) as { claim?: SupabaseOrderClaim; error?: string }
      if (!response.ok || !data.claim) return setError(data.error || "No se pudo enviar el reclamo.")
      setClaims((current) => [data.claim!, ...current]); setJustCreated(data.claim)
    } catch { setError("No se pudo enviar el reclamo. Intentá nuevamente.") } finally { setLoading(false) }
  }

  const sendReply = async (currentClaim: SupabaseOrderClaim) => {
    if (reply.trim().length < 5 && replyFiles.length === 0) return setError("Escribí un mensaje o adjuntá un archivo.")
    const fileError = validateFiles(replyFiles)
    if (fileError) return setError(fileError)
    setLoading(true); setError("")
    try {
      const formData = new FormData()
      formData.set("claimId", String(currentClaim.id)); formData.set("message", reply.trim())
      appendFiles(formData, replyFiles, "evidencia_adicional")
      const response = await fetch(`/api/orders/${order.id}/claims`, { method: "POST", body: formData })
      const data = (await response.json()) as { claim?: SupabaseOrderClaim; error?: string }
      if (!response.ok || !data.claim) return setError(data.error || "No se pudo enviar el mensaje.")
      setClaims((current) => current.map((item) => item.id === data.claim!.id ? data.claim! : item)); setReply(""); setReplyFiles([])
    } catch { setError("No se pudo enviar el mensaje.") } finally { setLoading(false) }
  }

  const acceptResolution = async (currentClaim: SupabaseOrderClaim) => {
    if (!selectedResolution) return setError("Elegí una de las soluciones ofrecidas.")
    setLoading(true); setError("")
    try {
      const response = await fetch(`/api/orders/${order.id}/claims`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ claimId: currentClaim.id, selectedResolution }) })
      const data = (await response.json()) as { claim?: SupabaseOrderClaim; error?: string }
      if (!response.ok || !data.claim) return setError(data.error || "No se pudo aceptar la solución.")
      setClaims((current) => current.map((item) => item.id === data.claim!.id ? data.claim! : item))
    } catch { setError("No se pudo aceptar la solución.") } finally { setLoading(false) }
  }

  if (justCreated) {
    const info = statusInfo(justCreated.status)
    return <section className="mb-2 rounded-xl border border-blue-300/15 bg-black p-3"><div className="mx-auto max-w-3xl rounded-xl border border-blue-300/15 bg-[#141414] p-4 text-center"><CircleCheck className="mx-auto size-9 text-emerald-400" /><p className="mt-3 text-[11px] font-black uppercase tracking-[0.18em] text-blue-300">Reclamo creado</p><h3 className="mt-1 text-xl font-black text-white">Recibimos tu reclamo</h3><div className={`mx-auto mt-3 inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-black text-white ${info.style}`}><span className={`size-2 rounded-full ${info.dot}`} />{info.label}</div><p className="mx-auto mt-3 max-w-xl text-sm font-semibold leading-5 text-white/80">Nuestro equipo revisará la información y te responderá por este medio.</p><div className="mt-4 grid gap-2 text-left sm:grid-cols-3">{[["Número", `#${justCreated.id}`], ["Fecha", formatDate(justCreated.created_at)], ["Pedido", `BX-${1000 + order.id}`]].map(([label, value]) => <div key={label} className="rounded-lg bg-[#181818] px-3 py-2"><p className="text-[11px] font-bold text-white/60">{label}</p><p className="mt-0.5 text-xs font-black text-white">{value}</p></div>)}</div><button type="button" onClick={() => setJustCreated(null)} className="mt-4 h-10 rounded-lg bg-[#112A43] px-5 text-xs font-black text-white">Ver seguimiento</button></div></section>
  }

  if (claim) {
    const info = statusInfo(claim.status)
    const messages = [...(claim.order_claim_messages ?? [])].sort((a, b) => +new Date(a.created_at) - +new Date(b.created_at))
    const offered = claim.offered_resolutions ?? []
    const open = !["cerrado", "rechazado"].includes(claim.status)
    const evidenceSent = (claim.order_claim_files ?? []).length > 0
    const canUploadEvidence = !evidenceSent || claim.status === "falta_informacion"
    return <section className="mb-1 rounded-xl border border-blue-300/15 bg-[#141414] p-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/8 pb-2.5"><div><p className="text-[10px] font-black uppercase tracking-[0.16em] text-blue-300">Reclamo #{claim.id}</p><h3 className="text-base font-black text-white">Seguimiento del caso</h3></div><span className={`inline-flex w-fit items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-black text-white ${info.style}`}><span className={`size-2 rounded-full ${info.dot}`} />{info.label}</span></div><p className="mt-2 truncate text-[11px] text-white/55">Pedido BX-{1000 + order.id} · {PROBLEM_LABELS[claim.failure_type ?? ""] ?? "Solicitud de ayuda"}</p>
      {claim.rejection_reason && <div className="mt-2.5 rounded-xl border border-red-300/20 bg-red-500/8 p-3"><p className="text-xs font-black text-white">Motivo del rechazo</p><p className="mt-1 text-xs leading-5 text-white/85">{claim.rejection_reason}</p></div>}
      {offered.length > 0 && !claim.customer_selected_resolution && <div className="mt-2.5 rounded-xl border border-blue-300/20 bg-[#141414] p-3"><p className="text-[11px] font-black uppercase tracking-[0.16em] text-blue-300">BEYONIX te ofrece</p><div className="mt-2 flex flex-wrap gap-1.5">{offered.map((resolution) => <button type="button" key={resolution} onClick={() => setSelectedResolution(resolution)} className={`inline-flex min-h-8 items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-black text-white ${selectedResolution === resolution ? "border-blue-300/55 bg-[#112A43]" : "border-blue-300/15 bg-[#181818]"}`}><Check className="size-3.5 text-blue-300" />{getOrderClaimResolutionLabel(resolution)}</button>)}</div><div className="mt-2.5 flex flex-wrap gap-2"><button type="button" disabled={loading} onClick={() => void acceptResolution(claim)} className="h-9 rounded-lg bg-[#112A43] px-4 text-xs font-black text-white">Aceptar solución</button><button type="button" onClick={() => { replyRef.current?.focus(); replyRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }) }} className="h-9 rounded-lg border border-blue-300/15 bg-[#181818] px-4 text-xs font-black text-white">Necesito ayuda</button></div></div>}
      {claim.customer_selected_resolution && <div className="mt-2.5 rounded-xl border border-emerald-300/20 bg-[#141414] px-3 py-2 text-xs font-bold text-white">Aceptaste: {getOrderClaimResolutionLabel(claim.customer_selected_resolution)}.</div>}
      <div className="mt-2.5 overflow-hidden rounded-lg bg-[#181818]"><div className="border-b border-white/8 px-3 py-2"><p className="text-[10px] font-black uppercase tracking-[0.16em] text-blue-300">Chat</p></div><div ref={chatRef} className="max-h-[18rem] space-y-1.5 overflow-y-auto p-2.5">{messages.map((message) => { const customer = message.author_role === "cliente"; return <div key={message.id} className={`flex ${customer ? "justify-end" : "justify-start"}`}><div className={`max-w-[82%] rounded-lg px-2.5 py-1.5 ${customer ? "bg-[#112A43]" : "bg-black/45"}`}><p className="text-[10px] font-black text-blue-200">{customer ? "Vos" : "BEYONIX"}</p><p className="whitespace-pre-wrap text-xs leading-4 text-white">{message.message}</p><p className="mt-0.5 text-[9px] text-white/45">{formatDate(message.created_at)}</p></div></div> })}{messages.length === 0 && <p className="text-xs text-white/65">La conversación todavía no tiene mensajes.</p>}</div></div>
      {evidenceSent && <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-[#181818] px-3 py-2"><span className="text-xs font-bold text-emerald-300"><Check className="mr-1 inline size-3.5" />Evidencia enviada</span><details><summary className="cursor-pointer text-xs font-black text-blue-300">Ver archivos enviados ({claim.order_claim_files?.length})</summary><div className="mt-2.5 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">{claim.order_claim_files?.map((file) => <FilePreview key={file.id} file={file} />)}</div></details></div>}
      {open ? <div className="mt-2.5"><textarea ref={replyRef} value={reply} onChange={(event) => setReply(event.target.value)} rows={2} placeholder="Escribí tu mensaje" className="w-full resize-none rounded-lg border border-blue-300/15 bg-[#181818] px-3 py-2 text-xs leading-5 text-white outline-none placeholder:text-white/50 focus:border-blue-300/50" /><div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">{canUploadEvidence ? <div className="min-w-0 flex-1"><EvidenceUploader files={replyFiles} onChange={setReplyFiles} disabled={loading} /></div> : <p className="text-[11px] text-white/55">Podrás adjuntar nueva evidencia si BEYONIX solicita más información.</p>}<button type="button" disabled={loading} onClick={() => void sendReply(claim)} className="inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-lg bg-[#112A43] px-4 text-xs font-black text-white disabled:opacity-50"><Send className="size-3.5" />{loading ? "Enviando..." : "Enviar"}</button></div>{error && <p className="mt-2 text-xs font-bold text-red-300">{error}</p>}</div> : <p className="mt-2.5 rounded-lg bg-[#181818] px-3 py-2 text-xs text-white/70">Este caso está finalizado. Podés consultar la conversación cuando quieras.</p>}
    </section>
  }

  const selected = PROBLEMS.find((item) => item.id === problem)
  return <section className="customer-claim-experience rounded-2xl border border-blue-300/15 bg-[#0D1117] p-3 sm:p-5">
    <div className="mb-5 grid grid-cols-3 gap-2">
      {["Producto", "Motivo", "Detalle"].map((label, index) => { const number = index + 1; const active = step >= number; return <div key={label} className="flex items-center gap-2"><span className={`flex size-7 shrink-0 items-center justify-center rounded-full border text-xs font-black ${active ? "border-blue-300/45 bg-[#112A43] text-white" : "border-white/10 bg-[#1B2028] text-white/45"}`}>{number}</span><span className={`hidden text-xs font-black sm:block ${active ? "text-white" : "text-white/40"}`}>{label}</span>{number < 3 && <span className="ml-auto h-px flex-1 bg-white/10" />}</div> })}
    </div>

    {step === 1 && <div>
      <p className="text-11px font-black uppercase tracking-[0.16em] text-blue-300">Paso 1 de 3</p>
      <h3 className="mt-1 text-xl font-black text-white">¿Con qué producto tuviste el problema?</h3>
      <div className="mt-4 grid gap-2 md:grid-cols-2">
        {orderItems.map((item) => { const value = String(item.id); const image = getItemImage(item); const selectedItem = affectedItem === value; const name = item.productos?.nombre ?? `Producto #${item.producto_id}`; return <button key={item.id} type="button" onClick={() => { setAffectedItem(value); setError("") }} className={`flex min-h-24 items-center gap-3 rounded-xl border p-3 text-left transition ${selectedItem ? "border-blue-300/55 bg-[#112A43] shadow-[0_0_18px_rgba(17,42,67,0.35)]" : "border-white/9 bg-[#141820] hover:border-blue-300/30"}`}><span className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-white">{image ? <img src={image} alt={name} className="size-full object-contain" /> : <Package className="size-5 text-black/30" />}</span><span className="min-w-0"><strong className="block text-sm text-white">{name}</strong><span className="mt-1 block text-xs text-white/62">{getItemVariant(item)} · Cantidad: {item.cantidad}</span><span className="mt-1 block text-xs font-black text-white">{formatPrice(Number(item.precio))}</span></span></button> })}
        <button type="button" disabled={wholeOrderDisabled} onClick={() => { if (wholeOrderDisabled) return; setAffectedItem("order"); setError("") }} className={`flex min-h-24 items-center gap-3 rounded-xl border p-3 text-left transition ${wholeOrderDisabled ? "cursor-not-allowed border-white/7 bg-[#141820] opacity-45" : affectedItem === "order" ? "border-blue-300/55 bg-[#112A43] shadow-[0_0_18px_rgba(17,42,67,0.35)]" : "border-white/9 bg-[#141820] hover:border-blue-300/30"}`}><span className="flex size-16 shrink-0 items-center justify-center rounded-xl bg-[#1B2028]"><Truck className="size-6 text-blue-300" /></span><span><strong className="block text-sm text-white">Todo el pedido</strong><span className="mt-1 block text-xs leading-4 text-white/62">{wholeOrderDisabled ? "Disponible cuando hay más de un producto o problemas generales del envío." : "Para problemas con el envío, un envío incorrecto o el paquete completo."}</span></span></button>
      </div>
      <button type="button" disabled={!affectedItem} onClick={() => { if (affectedItem) setStep(2) }} className="mt-4 h-10 rounded-lg bg-[#112A43] px-5 text-xs font-black text-white disabled:cursor-not-allowed disabled:opacity-40">Continuar</button>
    </div>}

    {step === 2 && <div>
      <button type="button" onClick={() => setStep(1)} className="inline-flex items-center gap-1.5 text-xs font-bold text-white/65"><ArrowLeft className="size-3.5" />Cambiar producto</button>
      <p className="mt-3 text-11px font-black uppercase tracking-[0.16em] text-blue-300">Paso 2 de 3</p>
      <h3 className="mt-1 text-xl font-black text-white">¿Qué ocurrió?</h3>
      <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{PROBLEMS.map((item) => { const Icon = item.icon; return <button key={item.id} type="button" onClick={() => { setProblem(item.id); if (item.id === "no_llego" && !wholeOrderDisabled) setAffectedItem("order"); setError("") }} className={`flex min-h-20 items-center gap-3 rounded-xl border p-3 text-left transition ${problem === item.id ? "border-blue-300/55 bg-[#112A43] shadow-[0_0_18px_rgba(17,42,67,0.3)]" : "border-white/9 bg-[#141820] hover:border-blue-300/30"}`}><span className="rounded-lg bg-[#1B2028] p-2"><Icon className="size-5 text-blue-300" /></span><span><strong className="block text-sm text-white">{item.title}</strong><span className="mt-0.5 block text-xs leading-4 text-white/60">{item.description}</span></span></button>})}</div>
      <button type="button" disabled={!problem} onClick={() => { if (problem) setStep(3) }} className="mt-4 h-10 rounded-lg bg-[#112A43] px-5 text-xs font-black text-white disabled:cursor-not-allowed disabled:opacity-40">Continuar</button>
    </div>}

    {step === 3 && <div>
      <button type="button" onClick={() => setStep(2)} className="inline-flex items-center gap-1.5 text-xs font-bold text-white/65"><ArrowLeft className="size-3.5" />Cambiar motivo</button>
      <p className="mt-3 text-11px font-black uppercase tracking-[0.16em] text-blue-300">Paso 3 de 3</p>
      <h3 className="mt-1 text-xl font-black text-white">Contanos qué pasó</h3>
      <p className="mt-1 text-xs leading-5 text-white/65">Contanos brevemente qué ocurrió para poder ayudarte más rápido. Motivo: {selected?.title}.</p>
      <textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={5} maxLength={2000} placeholder="Describí el problema con el mayor detalle posible…" className="mt-3 w-full resize-none rounded-xl border border-blue-300/15 bg-[#141820] px-3 py-2.5 text-sm leading-6 text-white outline-none placeholder:text-white/40 focus:border-blue-300/50" />
      <p className="mt-1 text-right text-10px text-white/40">{description.length}/2000</p>
      <div className="mt-2"><EvidenceUploader files={files} onChange={setFiles} disabled={loading} /></div>
      {error && <p className="mt-3 rounded-lg border border-red-300/20 bg-red-500/10 px-3 py-2 text-xs font-bold text-red-200">{error}</p>}
      <button type="button" disabled={loading || description.trim().length < 20} onClick={() => void createClaim()} className="mt-4 h-10 rounded-lg bg-[#112A43] px-5 text-xs font-black text-white disabled:cursor-not-allowed disabled:opacity-40">{loading ? "Enviando..." : "Enviar solicitud"}</button>
    </div>}
  </section>
}
