"use client"

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
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
import { beyonixHoverBorder } from "@/lib/utils"
import type {
  OrderClaimResolution,
  OrderClaimType,
  SupabaseOrderClaim,
  SupabaseOrderClaimFile,
  SupabasePedido,
} from "@/lib/supabase/types"

export type ClaimProblemId = "danado" | "incorrecto" | "falla" | "devolucion" | "no_llego" | "otro"
type ProblemId = ClaimProblemId
const CLAIM_DESCRIPTION_MIN_LENGTH = 10
const CLAIM_DESCRIPTION_MAX_LENGTH = 300

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

function getCustomerClaimMessageText(message: string) {
  const match = message.match(/^Producto afectado:\s*.+?(?:\r?\n){2}([\s\S]*)$/)
  return match?.[1]?.trim() || message
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
  if (status === "recibido") return { label: "Reclamo recibido", dot: "bg-blue-400", style: "border-blue-300/25 bg-blue-400/10" }
  if (status === "falta_informacion") return { label: "Esperando tu respuesta", dot: "bg-orange-400", style: "border-orange-300/25 bg-orange-400/10" }
  if (status === "aprobado") return { label: "Solución ofrecida", dot: "bg-blue-300", style: "border-blue-300/25 bg-[#112A43]" }
  if (status === "reintegro_pendiente") return { label: "Reintegro pendiente", dot: "bg-[#77E6E2]", style: "border-[#77E6E2]/25 bg-[#77E6E2]/10" }
  if (status === "cerrado") return { label: "Resuelto", dot: "bg-emerald-400", style: "border-emerald-300/25 bg-emerald-400/10" }
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
  const defaultAffectedItems = orderItems.length === 1 ? [String(orderItems[0].id)] : []
  const [claims, setClaims] = useState<SupabaseOrderClaim[]>(order.order_claims ?? [])
  const [step, setStep] = useState<1 | 2 | 3>(initialProblem ? 2 : 1)
  const [affectedItems, setAffectedItems] = useState<string[]>(defaultAffectedItems)
  const [problem, setProblem] = useState<ProblemId | null>(initialProblem ?? null)
  const [description, setDescription] = useState("")
  const [files, setFiles] = useState<File[]>([])
  const [reply, setReply] = useState("")
  const [replyFiles, setReplyFiles] = useState<File[]>([])
  const [selectedResolution, setSelectedResolution] = useState<OrderClaimResolution | null>(null)
  const [refundAccountHolder, setRefundAccountHolder] = useState("")
  const [refundAccountIdentifier, setRefundAccountIdentifier] = useState("")
  const [refundBank, setRefundBank] = useState("")
  const [refundAmountConfirmed, setRefundAmountConfirmed] = useState("")
  const [justCreated, setJustCreated] = useState<SupabaseOrderClaim | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const replyRef = useRef<HTMLTextAreaElement>(null)
  const chatRef = useRef<HTMLDivElement>(null)

  const loadClaims = useCallback(async () => {
    const response = await fetch(`/api/orders/${order.id}/claims`)
    const data = (await response.json()) as { claims?: SupabaseOrderClaim[] }
    if (response.ok) setClaims(data.claims ?? [])
  }, [order.id])

  useEffect(() => {
    void loadClaims()
    const intervalId = window.setInterval(() => void loadClaims(), 5000)
    window.addEventListener("focus", loadClaims)
    return () => {
      window.clearInterval(intervalId)
      window.removeEventListener("focus", loadClaims)
    }
  }, [loadClaims])

  useEffect(() => {
    if (!initialProblem || claims.length > 0) return
    setProblem(initialProblem)
    setStep(defaultAffectedItems.length > 0 ? 2 : 1)
  }, [claims.length, defaultAffectedItems.length, initialProblem])

  const activeClaim = claims.find((claim) => ["recibido", "en_revision", "falta_informacion", "aprobado", "reintegro_pendiente"].includes(claim.status))
  const claim = activeClaim ?? claims[0]
  const messageCount = claim?.order_claim_messages?.length ?? 0

  useLayoutEffect(() => {
    const chat = chatRef.current
    if (!chat) return

    chat.scrollTop = chat.scrollHeight
  }, [claim?.id, messageCount])

  const validateFiles = (selectedFiles: File[]) => selectedFiles.map((file) => getClaimFileValidationError(file)).find(Boolean) ?? ""
  const trimmedDescription = description.trim()
  const hasAffectedSelection = affectedItems.length > 0
  const wholeOrderSelected = affectedItems.includes("order")

  const toggleAffectedProduct = (value: string) => {
    setAffectedItems((current) => {
      const withoutWholeOrder = current.filter((item) => item !== "order")
      return withoutWholeOrder.includes(value)
        ? withoutWholeOrder.filter((item) => item !== value)
        : [...withoutWholeOrder, value]
    })
    setError("")
  }

  const selectWholeOrder = () => {
    if (wholeOrderDisabled) return
    setAffectedItems(["order"])
    setError("")
  }

  const createClaim = async () => {
    if (!hasAffectedSelection) return setError("Elegí el producto afectado o seleccioná todo el pedido.")
    if (!problem) return setError("Elegí el problema que mejor describe lo ocurrido.")
    if (trimmedDescription.length < CLAIM_DESCRIPTION_MIN_LENGTH) return setError("Contanos un poco más para poder ayudarte.")
    const fileError = validateFiles(files)
    if (fileError) return setError(fileError)
    setLoading(true); setError("")
    try {
      const selected = PROBLEMS.find((item) => item.id === problem)!
      const affectedLabel = wholeOrderSelected
        ? "Todo el pedido"
        : affectedItems
            .map((affectedItem) => {
              const selectedOrderItem = orderItems.find((item) => String(item.id) === affectedItem)
              if (!selectedOrderItem) return null
              return `${selectedOrderItem.productos?.nombre ?? "Producto"} · ${getItemVariant(selectedOrderItem)}`
            })
            .filter(Boolean)
            .join(", ")
      const formData = new FormData()
      formData.set("claimType", selected.claimType)
      formData.set("problemType", problem)
      formData.set("description", `Producto afectado: ${affectedLabel}\n\n${trimmedDescription}`)
      appendFiles(formData, files, "evidencia_inicial")
      const response = await fetch(`/api/orders/${order.id}/claims`, { method: "POST", body: formData })
      const data = (await response.json()) as { claim?: SupabaseOrderClaim; error?: string }
      if (!response.ok || !data.claim) return setError(data.error || "No se pudo enviar el reclamo.")
      setClaims((current) => [data.claim!, ...current]); setJustCreated(data.claim)
    } catch { setError("No se pudo enviar el reclamo. Intentá nuevamente.") } finally { setLoading(false) }
  }

  const sendReply = async (currentClaim: SupabaseOrderClaim) => {
    const currentMessages = [...(currentClaim.order_claim_messages ?? [])].sort((a, b) => +new Date(a.created_at) - +new Date(b.created_at))
    if (currentMessages[currentMessages.length - 1]?.author_role === "cliente") return setError("Mensaje enviado. Esperá la respuesta de BEYONIX para continuar.")
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
      const response = await fetch(`/api/orders/${order.id}/claims`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ claimId: currentClaim.id, selectedResolution, decision: "accept" }) })
      const data = (await response.json()) as { claim?: SupabaseOrderClaim; error?: string }
      if (!response.ok || !data.claim) return setError(data.error || "No se pudo aceptar la solución.")
      setClaims((current) => current.map((item) => item.id === data.claim!.id ? data.claim! : item))
    } catch { setError("No se pudo aceptar la solución.") } finally { setLoading(false) }
  }

  const rejectResolution = async (currentClaim: SupabaseOrderClaim) => {
    setLoading(true); setError("")
    try {
      const response = await fetch(`/api/orders/${order.id}/claims`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ claimId: currentClaim.id, decision: "reject" }) })
      const data = (await response.json()) as { claim?: SupabaseOrderClaim; error?: string }
      if (!response.ok || !data.claim) return setError(data.error || "No se pudo rechazar la solución.")
      setClaims((current) => current.map((item) => item.id === data.claim!.id ? data.claim! : item)); setSelectedResolution(null)
    } catch { setError("No se pudo rechazar la solución.") } finally { setLoading(false) }
  }

  const submitRefundDetails = async (currentClaim: SupabaseOrderClaim) => {
    const holder = refundAccountHolder.trim()
    const identifier = refundAccountIdentifier.trim()
    const bank = refundBank.trim()
    const amount = refundAmountConfirmed.trim()
    if (!holder || !identifier || !bank || !amount) {
      setError("Completá todos los datos para avanzar con el reintegro.")
      return
    }

    setLoading(true); setError("")
    try {
      const formData = new FormData()
      formData.set("claimId", String(currentClaim.id))
      formData.set("refundAccountHolder", holder)
      formData.set("refundAccountIdentifier", identifier)
      formData.set("refundBank", bank)
      formData.set("refundAmountConfirmed", amount)
      const response = await fetch(`/api/orders/${order.id}/claims`, { method: "POST", body: formData })
      const data = (await response.json()) as { claim?: SupabaseOrderClaim; error?: string }
      if (!response.ok || !data.claim) return setError(data.error || "No se pudieron enviar los datos del reintegro.")
      setClaims((current) => current.map((item) => item.id === data.claim!.id ? data.claim! : item))
      setRefundAccountHolder("")
      setRefundAccountIdentifier("")
      setRefundBank("")
      setRefundAmountConfirmed("")
    } catch {
      setError("No se pudieron enviar los datos del reintegro.")
    } finally {
      setLoading(false)
    }
  }

  if (justCreated) {
    const info = statusInfo(justCreated.status)
    return <section className="mb-2 rounded-xl border border-blue-300/15 bg-black p-3"><div className="mx-auto w-full rounded-xl border border-blue-300/15 bg-[#141414] p-4 text-center"><CircleCheck className="mx-auto size-9 text-emerald-400" /><p className="mt-3 text-[11px] font-black uppercase tracking-[0.18em] text-blue-300">Reclamo creado</p><h3 className="mt-1 text-xl font-black text-white">Recibimos tu reclamo</h3><div className={`mx-auto mt-3 inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-black text-white ${info.style}`}><span className={`size-2 rounded-full ${info.dot}`} />{info.label}</div><p className="mx-auto mt-3 max-w-xl text-sm font-semibold leading-5 text-white/80">Nuestro equipo revisará la información y te responderá por este medio.</p><div className="mt-4 grid gap-2 text-left sm:grid-cols-3">{[["Fecha", formatDate(justCreated.created_at)], ["Pedido", `#BX-${1000 + order.id}`], ["Motivo", PROBLEM_LABELS[justCreated.failure_type ?? ""] ?? "Solicitud de ayuda"]].map(([label, value]) => <div key={label} className="rounded-lg bg-[#181818] px-3 py-2"><p className="text-[11px] font-bold text-white/60">{label}</p><p className="mt-0.5 text-xs font-black text-white">{value}</p></div>)}</div><button type="button" onClick={() => setJustCreated(null)} className={`mt-4 h-10 rounded-lg bg-[#112A43] px-5 text-xs font-black text-white ${beyonixHoverBorder}`}>Ver reclamo</button></div></section>
  }

  if (claim) {
    const info = statusInfo(claim.status)
    const messages = [...(claim.order_claim_messages ?? [])].sort((a, b) => +new Date(a.created_at) - +new Date(b.created_at))
    const customerTurnLocked = messages[messages.length - 1]?.author_role === "cliente"
    const offered = claim.offered_resolutions ?? []
    const offerMessage = offered.length > 0
      ? [...messages].reverse().find((message) => message.author_role !== "cliente" && message.message.startsWith("Te ofrecemos:"))
      : undefined
    const visibleMessages = offerMessage
      ? messages.filter((message) => message.id !== offerMessage.id)
      : messages
    const open = !["cerrado", "rechazado"].includes(claim.status)
    const claimFiles = claim.order_claim_files ?? []
    const refundProof = claimFiles.find((file) => file.file_role === "comprobante_devolucion")
    const evidenceFiles = claimFiles.filter((file) => file.file_role !== "comprobante_devolucion")
    const evidenceSent = evidenceFiles.length > 0
    const canUploadEvidence = !evidenceSent || claim.status === "falta_informacion"
    const solutionPending = claim.status === "aprobado" && offered.length > 0 && !claim.customer_selected_resolution
    const isRefundResolution =
      claim.customer_selected_resolution === "reintegro_total" ||
      claim.customer_selected_resolution === "reintegro_parcial"
    const refundPending = claim.status === "reintegro_pendiente" && isRefundResolution
    const refundDetailsSubmitted = Boolean(claim.refund_details_submitted_at)
    return <section className="mb-1 rounded-xl border border-blue-300/15 bg-[#141414] p-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/8 pb-2"><div><h3 className="text-base font-black text-white">Seguimiento del reclamo</h3><p className="mt-0.5 text-[11px] text-white/55">Pedido #BX-{1000 + order.id} · {PROBLEM_LABELS[claim.failure_type ?? ""] ?? "Solicitud de ayuda"}</p></div><span className={`inline-flex w-fit items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-black text-white ${info.style}`}><span className={`size-2 rounded-full ${info.dot}`} />Estado: {info.label}</span></div>
      {claim.rejection_reason && <div className="mt-2.5 rounded-xl border border-red-300/20 bg-red-500/8 p-3"><p className="text-xs font-black text-white">Motivo del rechazo</p><p className="mt-1 text-xs leading-5 text-white/85">{claim.rejection_reason}</p></div>}
      <div className="mt-2.5 overflow-hidden rounded-lg border border-white/7 bg-[#181818]"><div className="border-b border-white/8 px-3 py-2"><p className="text-[10px] font-black uppercase tracking-[0.16em] text-blue-300">Conversación</p></div><div ref={chatRef} className="min-h-72 max-h-[32rem] space-y-2 overflow-y-auto p-2.5">{visibleMessages.map((message) => { const customer = message.author_role === "cliente"; return <div key={message.id} className={`flex ${customer ? "justify-end" : "justify-start"}`}><div className={`max-w-[82%] rounded-lg px-2.5 py-1.5 ${customer ? "bg-[#112A43]" : "bg-black/45"}`}><p className="text-[10px] font-black text-blue-200">{customer ? "Vos" : "BEYONIX"}</p><p className="whitespace-pre-wrap text-xs leading-4 text-white">{getCustomerClaimMessageText(message.message)}</p><p className="mt-0.5 text-[9px] text-white/45">{formatDate(message.created_at)}</p></div></div> })}{visibleMessages.length === 0 && offered.length === 0 && <p className="text-xs text-white/65">La conversación todavía no tiene mensajes.</p>}{offered.length > 0 && <div className="flex justify-start"><div className="w-full max-w-[88%] rounded-xl border border-blue-300/18 bg-[#101820] p-2.5"><p className="text-xs font-black text-white"><span className="text-blue-300">BEYONIX</span> te ofreció una solución</p><p className="mt-1.5 text-[10px] font-bold uppercase tracking-wide text-white/50">Opciones</p><div className="mt-1.5 flex flex-wrap gap-1.5">{offered.map((resolution) => { const selected = selectedResolution === resolution || claim.customer_selected_resolution === resolution; return <button type="button" key={resolution} disabled={Boolean(claim.customer_selected_resolution)} onClick={() => setSelectedResolution(resolution)} className={`inline-flex h-8 items-center gap-1.5 rounded-full border px-2.5 text-left text-[11px] font-black text-white transition-colors ${claim.customer_selected_resolution === resolution ? "border-emerald-400/55 bg-emerald-700/65" : selected ? "border-blue-300/45 bg-[#162D43]" : "border-white/10 bg-[#121A22] hover:border-blue-300/35"} disabled:cursor-default disabled:opacity-100`}><Check className={`size-3 ${selected ? "text-emerald-300" : "text-blue-300"}`} />{getOrderClaimResolutionLabel(resolution)}</button> })}</div>{claim.customer_selected_resolution ? <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-emerald-400/35 bg-emerald-700/35 px-2.5 py-2"><span className="size-2 rounded-full bg-emerald-400" /><span className="text-[10px] font-bold uppercase tracking-wide text-emerald-100">Elegiste</span><strong className="text-xs text-white">{getOrderClaimResolutionLabel(claim.customer_selected_resolution)}</strong></div> : <div className="mt-2.5 flex flex-wrap gap-2"><button type="button" disabled={loading || !selectedResolution} onClick={() => void acceptResolution(claim)} className="h-9 rounded-lg bg-[#16A34A] px-3.5 text-xs font-black text-white shadow-[0_0_10px_rgba(22,163,74,0.24)] transition-colors hover:bg-[#15803D] disabled:cursor-not-allowed disabled:opacity-45">Aceptar solución</button><button type="button" disabled={loading} onClick={() => void rejectResolution(claim)} className="h-9 rounded-lg border border-red-400/45 bg-red-950/55 px-3.5 text-xs font-black text-white transition-colors hover:border-red-300 hover:bg-red-900/65 disabled:cursor-not-allowed disabled:opacity-45">Rechazar solución</button></div>}<p className="mt-1.5 text-[9px] text-white/40">{offerMessage ? formatDate(offerMessage.created_at) : formatDate(claim.updated_at)}</p></div></div>}</div></div>
      {evidenceSent && <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-[#181818] px-3 py-2"><span className="text-xs font-bold text-emerald-300"><Check className="mr-1 inline size-3.5" />Evidencia enviada</span><details><summary className="cursor-pointer text-xs font-black text-blue-300">Ver archivos enviados ({evidenceFiles.length})</summary><div className="mt-2.5 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">{evidenceFiles.map((file) => <FilePreview key={file.id} file={file} />)}</div></details></div>}
      {open ? <div className="mt-2.5">{solutionPending ? <p className="rounded-lg border border-blue-300/20 bg-[#112A43]/40 px-3 py-2 text-xs font-bold text-blue-100">BEYONIX te ofreció una solución. Aceptala o rechazala para continuar.</p> : refundPending && !refundDetailsSubmitted ? <div className="rounded-lg border border-[#77E6E2]/20 bg-[#77E6E2]/5 p-3"><p className="text-xs font-black text-white">Completá los datos para recibir el reintegro.</p><p className="mt-1 text-xs leading-5 text-white/65">Mientras esperamos estos datos, la conversación queda pausada.</p><div className="mt-3 grid gap-2 sm:grid-cols-2"><input value={refundAccountHolder} onChange={(event) => setRefundAccountHolder(event.target.value)} placeholder="Titular de la cuenta" className="h-9 rounded-lg border border-white/10 bg-[#181818] px-3 text-xs text-white outline-none placeholder:text-white/40 focus:border-[#77E6E2]/45" /><input value={refundAccountIdentifier} onChange={(event) => setRefundAccountIdentifier(event.target.value)} placeholder="Alias o CBU/CVU" className="h-9 rounded-lg border border-white/10 bg-[#181818] px-3 text-xs text-white outline-none placeholder:text-white/40 focus:border-[#77E6E2]/45" /><input value={refundBank} onChange={(event) => setRefundBank(event.target.value)} placeholder="Banco / billetera" className="h-9 rounded-lg border border-white/10 bg-[#181818] px-3 text-xs text-white outline-none placeholder:text-white/40 focus:border-[#77E6E2]/45" /><input value={refundAmountConfirmed} onChange={(event) => setRefundAmountConfirmed(event.target.value)} placeholder="Importe a recibir" className="h-9 rounded-lg border border-white/10 bg-[#181818] px-3 text-xs text-white outline-none placeholder:text-white/40 focus:border-[#77E6E2]/45" /></div><button type="button" disabled={loading} onClick={() => void submitRefundDetails(claim)} className="mt-3 h-9 rounded-lg bg-[#112A43] px-4 text-xs font-black text-white disabled:cursor-not-allowed disabled:opacity-45">Enviar datos</button></div> : refundPending ? <p className="rounded-lg border border-[#77E6E2]/20 bg-[#77E6E2]/5 px-3 py-2 text-xs font-bold text-[#D7FFFD]">Datos recibidos. BEYONIX realizará el reintegro.</p> : <><textarea ref={replyRef} value={reply} disabled={customerTurnLocked || loading} onChange={(event) => setReply(event.target.value)} rows={2} placeholder="Escribí tu mensaje" className="w-full resize-none rounded-lg border border-blue-300/15 bg-[#181818] px-3 py-2 text-xs leading-5 text-white outline-none placeholder:text-white/50 focus:border-blue-300/50 disabled:cursor-not-allowed disabled:opacity-45" />{customerTurnLocked && <p className="mt-2 rounded-lg border border-orange-300/15 bg-orange-400/8 px-3 py-2 text-xs font-bold text-orange-100">Mensaje enviado. Esperá la respuesta de BEYONIX para continuar.</p>}<div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">{canUploadEvidence ? <div className={`min-w-0 flex-1 ${customerTurnLocked ? "opacity-45" : ""}`}><EvidenceUploader files={replyFiles} onChange={setReplyFiles} disabled={loading || customerTurnLocked} /></div> : <p className="text-[11px] text-white/55">Podrás adjuntar nueva evidencia si BEYONIX solicita más información.</p>}<button type="button" disabled={loading || customerTurnLocked} onClick={() => void sendReply(claim)} className="inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-lg bg-[#112A43] px-4 text-xs font-black text-white disabled:cursor-not-allowed disabled:opacity-45"><Send className="size-3.5" />{loading ? "Enviando..." : "Enviar"}</button></div></>}{error && <p className="mt-2 text-xs font-bold text-red-300">{error}</p>}</div> : <div className="mt-2.5 space-y-2"><p className="rounded-lg border border-emerald-300/15 bg-emerald-500/8 px-3 py-2 text-xs font-bold text-emerald-100">{claim.customer_selected_resolution ? `Caso finalizado. Solución aceptada: ${getOrderClaimResolutionLabel(claim.customer_selected_resolution)}.` : "Caso finalizado. Podés consultar la conversación cuando quieras."}</p>{refundProof?.signedUrl && <a href={refundProof.signedUrl} target="_blank" rel="noreferrer" className="inline-flex h-9 items-center gap-2 rounded-lg border border-[#77E6E2]/25 bg-[#77E6E2]/5 px-3 text-xs font-black text-white hover:border-[#77E6E2]/45"><FileText className="size-3.5 text-[#77E6E2]" />Ver comprobante de devolución</a>}</div>}
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
        {orderItems.map((item) => { const value = String(item.id); const image = getItemImage(item); const selectedItem = affectedItems.includes(value); const name = item.productos?.nombre ?? `Producto #${item.producto_id}`; return <button key={item.id} type="button" onClick={() => toggleAffectedProduct(value)} className={`flex min-h-24 items-center gap-3 rounded-xl border p-3 text-left transition ${selectedItem ? "border-blue-300/55 bg-[#112A43] shadow-[0_0_18px_rgba(17,42,67,0.35)]" : "border-white/9 bg-[#141820] hover:border-blue-300/30"}`}><span className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-white">{image ? <img src={image} alt={name} className="size-full object-contain" /> : <Package className="size-5 text-black/30" />}</span><span className="min-w-0"><strong className="block text-sm text-white">{name}</strong><span className="mt-1 block text-xs text-white/62">{getItemVariant(item)} · Cantidad: {item.cantidad}</span><span className="mt-1 block text-xs font-black text-white">{formatPrice(Number(item.precio))}</span></span></button> })}
        <button type="button" disabled={wholeOrderDisabled} onClick={selectWholeOrder} className={`flex min-h-24 items-center gap-3 rounded-xl border p-3 text-left transition ${wholeOrderDisabled ? "cursor-not-allowed border-white/7 bg-[#141820] opacity-45" : wholeOrderSelected ? "border-blue-300/55 bg-[#112A43] shadow-[0_0_18px_rgba(17,42,67,0.35)]" : "border-white/9 bg-[#141820] hover:border-blue-300/30"}`}><span className="flex size-16 shrink-0 items-center justify-center rounded-xl bg-[#1B2028]"><Truck className="size-6 text-blue-300" /></span><span><strong className="block text-sm text-white">Todo el pedido</strong><span className="mt-1 block text-xs leading-4 text-white/62">{wholeOrderDisabled ? "Disponible cuando hay más de un producto o problemas generales del envío." : "Para problemas con el envío, un envío incorrecto o el paquete completo."}</span></span></button>
      </div>
      <button type="button" disabled={!hasAffectedSelection} onClick={() => { if (hasAffectedSelection) setStep(2) }} className="mt-4 h-10 rounded-lg bg-[#112A43] px-5 text-xs font-black text-white disabled:cursor-not-allowed disabled:opacity-40">Continuar</button>
    </div>}

    {step === 2 && <div>
      <button type="button" onClick={() => setStep(1)} className="inline-flex items-center gap-1.5 text-xs font-bold text-white/65"><ArrowLeft className="size-3.5" />Cambiar producto</button>
      <p className="mt-3 text-11px font-black uppercase tracking-[0.16em] text-blue-300">Paso 2 de 3</p>
      <h3 className="mt-1 text-xl font-black text-white">¿Qué ocurrió?</h3>
      <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{PROBLEMS.map((item) => { const Icon = item.icon; return <button key={item.id} type="button" onClick={() => { setProblem(item.id); if (item.id === "no_llego" && !wholeOrderDisabled) setAffectedItems(["order"]); setError("") }} className={`flex min-h-20 items-center gap-3 rounded-xl border p-3 text-left transition ${problem === item.id ? "border-blue-300/55 bg-[#112A43] shadow-[0_0_18px_rgba(17,42,67,0.3)]" : "border-white/9 bg-[#141820] hover:border-blue-300/30"}`}><span className="rounded-lg bg-[#1B2028] p-2"><Icon className="size-5 text-blue-300" /></span><span><strong className="block text-sm text-white">{item.title}</strong><span className="mt-0.5 block text-xs leading-4 text-white/60">{item.description}</span></span></button>})}</div>
      <button type="button" disabled={!problem} onClick={() => { if (problem) setStep(3) }} className="mt-4 h-10 rounded-lg bg-[#112A43] px-5 text-xs font-black text-white disabled:cursor-not-allowed disabled:opacity-40">Continuar</button>
    </div>}

    {step === 3 && <div>
      <button type="button" onClick={() => setStep(2)} className="inline-flex items-center gap-1.5 text-xs font-bold text-white/65"><ArrowLeft className="size-3.5" />Cambiar motivo</button>
      <p className="mt-3 text-11px font-black uppercase tracking-[0.16em] text-blue-300">Paso 3 de 3</p>
      <h3 className="mt-1 text-xl font-black text-white">Contanos qué pasó</h3>
      <p className="mt-1 text-xs leading-5 text-white/65">Contanos brevemente qué ocurrió para poder ayudarte más rápido. Motivo: {selected?.title}.</p>
      <textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={5} minLength={CLAIM_DESCRIPTION_MIN_LENGTH} maxLength={CLAIM_DESCRIPTION_MAX_LENGTH} placeholder="Describí el problema con el mayor detalle posible…" className="mt-3 w-full resize-none rounded-xl border border-blue-300/15 bg-[#141820] px-3 py-2.5 text-sm leading-6 text-white outline-none placeholder:text-white/40 focus:border-blue-300/50" />
      <p className="mt-1 text-right text-10px text-white/40">{description.length}/{CLAIM_DESCRIPTION_MAX_LENGTH}</p>
      <div className="mt-2"><EvidenceUploader files={files} onChange={setFiles} disabled={loading} /></div>
      {error && <p className="mt-3 rounded-lg border border-red-300/20 bg-red-500/10 px-3 py-2 text-xs font-bold text-red-200">{error}</p>}
      <button type="button" disabled={loading || trimmedDescription.length < CLAIM_DESCRIPTION_MIN_LENGTH} onClick={() => void createClaim()} className="mt-4 h-10 rounded-lg bg-[#112A43] px-5 text-xs font-black text-white disabled:cursor-not-allowed disabled:opacity-40">{loading ? "Enviando..." : "Enviar solicitud"}</button>
    </div>}
  </section>
}
