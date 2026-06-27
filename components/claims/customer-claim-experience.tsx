"use client"

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import {
  AlertTriangle,
  Check,
  CircleCheck,
  FileText,
  MessageCircle,
  Package,
  Paperclip,
  Send,
  Truck,
  Upload,
  X,
} from "lucide-react"

import { getClaimFileValidationError } from "@/lib/order-claims"
import { beyonixHoverBorder } from "@/lib/utils"
import type {
  OrderClaimType,
  SupabaseOrderClaim,
  SupabaseOrderClaimFile,
  SupabasePedido,
} from "@/lib/supabase/types"

export type ClaimProblemId =
  | "danado"
  | "incorrecto"
  | "falla"
  | "faltante"
  | "cantidad_menor"
  | "otro"
  | "cancelar_compra"
  | "devolucion"
  | "no_llego"
  | "cambio_producto"
  | "cambio_color"
  | "cambio_cantidad"
  | "modificar_envio"
  | "otro_pre_despacho"

type ClaimProblemOption = {
  id: ClaimProblemId
  title: string
  description: string
  icon: typeof Package
  claimType: OrderClaimType
}

const CLAIM_DESCRIPTION_MIN_LENGTH = 10
const CLAIM_DESCRIPTION_MAX_LENGTH = 600

const POST_DELIVERY_PROBLEMS: ClaimProblemOption[] = [
  {
    id: "incorrecto",
    title: "Recibí un producto incorrecto",
    description: "BEYONIX envió algo distinto a lo comprado.",
    icon: Package,
    claimType: "transporte_48hs",
  },
  {
    id: "danado",
    title: "Llegó roto o dañado",
    description: "El producto o el paquete llegó con daño visible.",
    icon: AlertTriangle,
    claimType: "transporte_48hs",
  },
  {
    id: "falla",
    title: "No funciona correctamente",
    description: "El producto recibido presenta una falla.",
    icon: AlertTriangle,
    claimType: "garantia_beyonix",
  },
  {
    id: "faltante",
    title: "Faltó un producto",
    description: "El pedido llegó incompleto.",
    icon: Package,
    claimType: "transporte_48hs",
  },
  {
    id: "cantidad_menor",
    title: "Recibí menos cantidad",
    description: "Llegaron menos unidades que las compradas.",
    icon: Package,
    claimType: "transporte_48hs",
  },
  {
    id: "otro",
    title: "Otro problema con el pedido recibido",
    description: "Algo no coincide con lo recibido.",
    icon: MessageCircle,
    claimType: "garantia_beyonix",
  },
]

const CANCELLATION_REASONS = [
  { value: "arrepentimiento", label: "Me arrepentí de la compra" },
  { value: "error", label: "Compré por error" },
  { value: "no_necesito", label: "Ya no necesito el producto" },
  { value: "otro", label: "Otro motivo" },
]

const PROBLEM_LABELS: Record<string, string> = {
  danado: "Producto dañado",
  incorrecto: "Producto incorrecto",
  falla: "Producto con falla",
  faltante: "Faltó un producto",
  cantidad_menor: "Menos cantidad recibida",
  otro: "Otro problema",
  cancelar_compra: "Cancelar compra",
  devolucion: "Solicitud anterior",
  no_llego: "Solicitud anterior",
  cambio_producto: "Solicitud anterior",
  cambio_color: "Solicitud anterior",
  cambio_cantidad: "Solicitud anterior",
  modificar_envio: "Solicitud anterior",
  otro_pre_despacho: "Solicitud anterior",
}

function isOrderDelivered(order: SupabasePedido) {
  const estado = (order.estado ?? "").toLowerCase()
  const andreaniStatus = (order.andreani_estado ?? "").toLowerCase()

  return (
    estado === "entregado" ||
    Boolean(order.delivered_at) ||
    andreaniStatus.includes("entregado")
  )
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

function isOrderCancelled(order: SupabasePedido) {
  return (order.estado ?? "").toLowerCase() === "cancelado"
}

function formatDate(value?: string | null) {
  if (!value) return "Sin fecha"

  return new Intl.DateTimeFormat("es-AR", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/Argentina/Buenos_Aires",
  }).format(new Date(value))
}

function formatPrice(value: number) {
  return new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    maximumFractionDigits: 0,
  }).format(value)
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

function getCustomerClaimMessageText(message: string) {
  const match = message.match(/^Producto afectado:\s*.+?(?:\r?\n){2}([\s\S]*)$/)
  return match?.[1]?.trim() || message
}

function getAffectedProductsFromDescription(description: string) {
  const match = description.match(/^Producto afectado:\s*(.+?)(?:\r?\n){2}/)
  return match?.[1]?.trim() || ""
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

function getOrderStage(order: SupabasePedido) {
  if (isOrderCancelled(order)) {
    return {
      title: "Pedido cancelado",
      detail: "La compra figura como cancelada.",
    }
  }

  if (isOrderDelivered(order)) {
    return {
      title: "Pedido entregado",
      detail: "Si tuviste un problema con algún producto recibido, podés iniciar un reclamo.",
    }
  }

  if (isOrderDispatched(order)) {
    return {
      title: "Pedido despachado",
      detail: "Tu pedido ya fue despachado. Cuando lo recibas, si hay algún problema con el producto, vas a poder iniciar un reclamo.",
    }
  }

  if (isOrderInvoiced(order)) {
    return {
      title: "Pedido facturado",
      detail: "Tu pedido ya fue facturado, por eso no es posible cancelarlo desde esta sección.",
    }
  }

  return {
    title: "Pedido en preparación",
    detail: "Podés solicitar la cancelación porque tu pedido todavía no fue facturado ni enviado. BEYONIX revisará la solicitud y te confirmará la resolución.",
  }
}

function getClaimStatusInfo(claim: SupabaseOrderClaim) {
  const cancellation = claim.failure_type === "cancelar_compra"
  const base = "border-blue-300/25 bg-[#112A43]/35"

  if (cancellation) {
    if (claim.status === "rechazado") {
      return { label: "Cancelación rechazada", dot: "bg-red-300", style: "border-red-300/25 bg-red-400/8" }
    }
    if (claim.status === "cerrado") {
      return { label: "Cancelación aprobada", dot: "bg-[#77E6E2]", style: "border-[#77E6E2]/25 bg-[#77E6E2]/8" }
    }
    if (claim.status === "falta_informacion") {
      return { label: "Esperando tu respuesta", dot: "bg-blue-300", style: base }
    }
    return { label: "Cancelación solicitada", dot: "bg-blue-300", style: base }
  }

  if (claim.status === "recibido") return { label: "Reclamo recibido", dot: "bg-blue-300", style: base }
  if (claim.status === "en_revision") return { label: "En revisión por BEYONIX", dot: "bg-blue-300", style: base }
  if (claim.status === "falta_informacion") return { label: "Esperando tu respuesta", dot: "bg-blue-300", style: base }
  if (["aprobado", "reintegro_pendiente", "cambio_pendiente", "cupon_pendiente", "reemplazo_enviado"].includes(claim.status)) {
    return { label: "Solución en proceso", dot: "bg-[#77E6E2]", style: "border-[#77E6E2]/25 bg-[#77E6E2]/8" }
  }
  if (claim.status === "rechazado") return { label: "Reclamo rechazado", dot: "bg-red-300", style: "border-red-300/25 bg-red-400/8" }
  if (claim.status === "cerrado") return { label: "Caso resuelto", dot: "bg-[#77E6E2]", style: "border-[#77E6E2]/25 bg-[#77E6E2]/8" }

  return { label: "En revisión por BEYONIX", dot: "bg-blue-300", style: base }
}

function FilePreview({ file }: { file: SupabaseOrderClaimFile }) {
  const isImage = file.mime_type.startsWith("image/")
  const isVideo = file.mime_type.startsWith("video/")

  if (isImage && file.signedUrl) {
    return (
      <a href={file.signedUrl} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-lg border border-blue-300/15 bg-[#181818]">
        <img src={file.signedUrl} alt={file.file_name} className="h-24 w-full object-cover" />
        <span className="block truncate px-2.5 py-1.5 text-xs font-bold text-white">{file.file_name}</span>
      </a>
    )
  }

  if (isVideo && file.signedUrl) {
    return (
      <div className="overflow-hidden rounded-lg border border-blue-300/15 bg-[#181818]">
        <video src={file.signedUrl} controls className="h-28 w-full bg-black object-contain" />
        <span className="block truncate px-2.5 py-1.5 text-xs font-bold text-white">{file.file_name}</span>
      </div>
    )
  }

  return (
    <a href={file.signedUrl ?? undefined} target="_blank" rel="noreferrer" className="flex items-center gap-2 rounded-lg border border-blue-300/15 bg-[#181818] px-2.5 py-2 text-xs font-bold text-white">
      <FileText className="size-4 text-blue-300" />
      <span className="truncate">{file.file_name}</span>
    </a>
  )
}

function EvidenceUploader({
  files,
  onChange,
  disabled,
}: {
  files: File[]
  onChange: (files: File[]) => void
  disabled?: boolean
}) {
  return (
    <div>
      <label className={`flex min-h-16 items-center justify-center gap-3 rounded-xl border border-dashed border-blue-300/30 bg-[#181818] px-3 py-2 text-left transition ${disabled ? "cursor-not-allowed opacity-45" : "cursor-pointer hover:border-blue-300/60"}`}>
        <Upload className="size-5 shrink-0 text-blue-300" />
        <span>
          <span className="block text-xs font-black text-white">Adjuntar fotos, videos o archivos</span>
          <span className="mt-0.5 block text-[11px] text-white/65">Opcional. La evidencia ayuda a revisar el caso más rápido.</span>
        </span>
        <input
          type="file"
          multiple
          disabled={disabled}
          accept="image/*,video/*,.pdf,.doc,.docx,.txt"
          className="sr-only"
          onChange={(event) => onChange([...files, ...Array.from(event.target.files ?? [])])}
        />
      </label>
      {files.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {files.map((file, index) => (
            <span key={`${file.name}-${index}`} className="inline-flex max-w-64 items-center gap-1.5 rounded-lg border border-white/10 bg-[#181818] px-2.5 py-1.5 text-xs font-bold text-white">
              <Paperclip className="size-3.5 shrink-0 text-blue-300" />
              <span className="truncate">{file.name}</span>
              <button type="button" aria-label={`Quitar ${file.name}`} onClick={() => onChange(files.filter((_, itemIndex) => itemIndex !== index))}>
                <X className="size-3.5" />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

function appendFiles(formData: FormData, files: File[], role: string) {
  files.forEach((file) => {
    formData.append("files", file)
    formData.append("fileRoles", role)
  })
}

function ProductSummary({ order }: { order: SupabasePedido }) {
  const items = order.orden_items ?? []
  const productCount = items.reduce((total, item) => total + Number(item.cantidad ?? 0), 0)

  return (
    <div className="rounded-xl border border-white/8 bg-[#15191F] p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-10px font-black uppercase tracking-[0.16em] text-blue-300">Resumen del pedido</p>
          <p className="mt-1 text-sm font-black text-white">Pedido #BX-{1000 + order.id}</p>
        </div>
        <div className="text-left sm:text-right">
          <p className="text-10px font-bold uppercase tracking-wide text-white/45">Total</p>
          <p className="text-base font-black text-white">{formatPrice(Number(order.total ?? 0))}</p>
        </div>
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        <div className="rounded-lg bg-[#1B2028] px-3 py-2">
          <p className="text-10px font-bold uppercase tracking-wide text-white/45">Estado</p>
          <p className="mt-0.5 text-xs font-black text-white">{getOrderStage(order).title}</p>
        </div>
        <div className="rounded-lg bg-[#1B2028] px-3 py-2">
          <p className="text-10px font-bold uppercase tracking-wide text-white/45">Productos</p>
          <p className="mt-0.5 text-xs font-black text-white">{productCount} {productCount === 1 ? "producto" : "productos"}</p>
        </div>
        <div className="rounded-lg bg-[#1B2028] px-3 py-2">
          <p className="text-10px font-bold uppercase tracking-wide text-white/45">Seguimiento</p>
          <p className="mt-0.5 truncate text-xs font-black text-white">{order.tracking_number || order.andreani_tracking || "No disponible"}</p>
        </div>
      </div>
    </div>
  )
}

export function CustomerClaimExperience({
  order,
  initialProblem,
}: {
  order: SupabasePedido
  initialProblem?: ClaimProblemId
}) {
  const orderItems = order.orden_items ?? []
  const delivered = isOrderDelivered(order)
  const dispatched = isOrderDispatched(order)
  const invoiced = isOrderInvoiced(order)
  const cancelled = isOrderCancelled(order)
  const canCancel = !cancelled && !delivered && !dispatched && !invoiced
  const canCreatePostDeliveryClaim = delivered && !cancelled
  const initialProblemAllowed = POST_DELIVERY_PROBLEMS.some((item) => item.id === initialProblem)
  const defaultAffectedItems = orderItems.length === 1 ? [String(orderItems[0].id)] : []

  const [claims, setClaims] = useState<SupabaseOrderClaim[]>(order.order_claims ?? [])
  const [affectedItems, setAffectedItems] = useState<string[]>(defaultAffectedItems)
  const [problem, setProblem] = useState<ClaimProblemId | null>(
    initialProblemAllowed ? initialProblem ?? null : null,
  )
  const [description, setDescription] = useState("")
  const [files, setFiles] = useState<File[]>([])
  const [cancellationReason, setCancellationReason] = useState("")
  const [cancellationMessage, setCancellationMessage] = useState("")
  const [reply, setReply] = useState("")
  const [replyFiles, setReplyFiles] = useState<File[]>([])
  const [refundAccountHolder, setRefundAccountHolder] = useState("")
  const [refundAccountIdentifier, setRefundAccountIdentifier] = useState("")
  const [refundBank, setRefundBank] = useState("")
  const [refundAmountConfirmed, setRefundAmountConfirmed] = useState("")
  const [justCreated, setJustCreated] = useState<SupabaseOrderClaim | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
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

  const activeClaim = claims.find((claim) =>
    [
      "recibido",
      "en_revision",
      "falta_informacion",
      "aprobado",
      "reintegro_pendiente",
      "cambio_pendiente",
      "cupon_pendiente",
      "reemplazo_enviado",
    ].includes(claim.status),
  )
  const claim = activeClaim ?? claims[0]
  const messageCount = claim?.order_claim_messages?.length ?? 0

  useLayoutEffect(() => {
    const chat = chatRef.current
    if (!chat) return
    chat.scrollTop = chat.scrollHeight
  }, [claim?.id, messageCount])

  const validateFiles = (selectedFiles: File[]) =>
    selectedFiles.map((file) => getClaimFileValidationError(file)).find(Boolean) ?? ""

  const updateClaimInState = (updatedClaim: SupabaseOrderClaim) => {
    setClaims((current) => {
      const exists = current.some((item) => item.id === updatedClaim.id)
      return exists
        ? current.map((item) => (item.id === updatedClaim.id ? updatedClaim : item))
        : [updatedClaim, ...current]
    })
  }

  const createCancellationRequest = async () => {
    if (!canCancel) {
      setError("No es posible solicitar la cancelación desde esta sección.")
      return
    }

    setLoading(true)
    setError("")

    try {
      const selectedReason = CANCELLATION_REASONS.find((item) => item.value === cancellationReason)?.label
      const detail = cancellationMessage.trim()
      const descriptionParts = [
        "Solicitud de cancelación",
        `Motivo: ${selectedReason || "No especificado"}`,
        detail ? `Mensaje del cliente: ${detail}` : "",
      ].filter(Boolean)
      const formData = new FormData()
      formData.set("claimType", "garantia_beyonix")
      formData.set("problemType", "cancelar_compra")
      formData.set("description", descriptionParts.join("\n\n"))

      const response = await fetch(`/api/orders/${order.id}/claims`, {
        method: "POST",
        body: formData,
      })
      const data = (await response.json()) as { claim?: SupabaseOrderClaim; error?: string }

      if (!response.ok || !data.claim) {
        setError(data.error || "No se pudo solicitar la cancelación.")
        return
      }

      updateClaimInState(data.claim)
      setJustCreated(data.claim)
      setCancellationReason("")
      setCancellationMessage("")
    } catch {
      setError("No se pudo solicitar la cancelación. Intentá nuevamente.")
    } finally {
      setLoading(false)
    }
  }

  const createClaim = async () => {
    if (!canCreatePostDeliveryClaim) {
      setError("Todavía no podés iniciar un reclamo porque el pedido no figura como entregado.")
      return
    }

    const selectedProblem = POST_DELIVERY_PROBLEMS.find((item) => item.id === problem)
    const trimmedDescription = description.trim()

    if (!affectedItems.length) {
      setError("Elegí el producto afectado.")
      return
    }

    if (!selectedProblem) {
      setError("Elegí el motivo que mejor describe el problema.")
      return
    }

    if (trimmedDescription.length < CLAIM_DESCRIPTION_MIN_LENGTH) {
      setError("Contanos un poco más para poder ayudarte.")
      return
    }

    const fileError = validateFiles(files)
    if (fileError) {
      setError(fileError)
      return
    }

    setLoading(true)
    setError("")

    try {
      const affectedLabel = affectedItems.includes("order")
        ? "Todo el pedido recibido"
        : affectedItems
            .map((affectedItem) => {
              const selectedOrderItem = orderItems.find((item) => String(item.id) === affectedItem)
              if (!selectedOrderItem) return null
              return `${selectedOrderItem.productos?.nombre ?? "Producto"} · ${getItemVariant(selectedOrderItem)}`
            })
            .filter(Boolean)
            .join(", ")

      const formData = new FormData()
      formData.set("claimType", selectedProblem.claimType)
      formData.set("problemType", selectedProblem.id)
      formData.set("affectedItemIds", affectedItems.filter((item) => item !== "order").join(","))
      formData.set("description", `Producto afectado: ${affectedLabel}\n\n${trimmedDescription}`)
      appendFiles(formData, files, "evidencia_inicial")

      const response = await fetch(`/api/orders/${order.id}/claims`, {
        method: "POST",
        body: formData,
      })
      const data = (await response.json()) as { claim?: SupabaseOrderClaim; error?: string }

      if (!response.ok || !data.claim) {
        setError(data.error || "No se pudo enviar el reclamo.")
        return
      }

      updateClaimInState(data.claim)
      setJustCreated(data.claim)
      setDescription("")
      setFiles([])
    } catch {
      setError("No se pudo enviar el reclamo. Intentá nuevamente.")
    } finally {
      setLoading(false)
    }
  }

  const sendReply = async (currentClaim: SupabaseOrderClaim) => {
    const currentMessages = sortUniqueMessages(currentClaim.order_claim_messages)

    if (currentMessages[currentMessages.length - 1]?.author_role === "cliente") {
      setError("Mensaje enviado. Esperá la respuesta de BEYONIX para continuar.")
      return
    }

    if (reply.trim().length < 5 && replyFiles.length === 0) {
      setError("Escribí un mensaje o adjuntá un archivo.")
      return
    }

    const fileError = validateFiles(replyFiles)
    if (fileError) {
      setError(fileError)
      return
    }

    setLoading(true)
    setError("")

    try {
      const formData = new FormData()
      formData.set("claimId", String(currentClaim.id))
      formData.set("message", reply.trim())
      appendFiles(formData, replyFiles, "evidencia_adicional")

      const response = await fetch(`/api/orders/${order.id}/claims`, {
        method: "POST",
        body: formData,
      })
      const data = (await response.json()) as { claim?: SupabaseOrderClaim; error?: string }

      if (!response.ok || !data.claim) {
        setError(data.error || "No se pudo enviar el mensaje.")
        return
      }

      updateClaimInState(data.claim)
      setReply("")
      setReplyFiles([])
    } catch {
      setError("No se pudo enviar el mensaje.")
    } finally {
      setLoading(false)
    }
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

    setLoading(true)
    setError("")

    try {
      const formData = new FormData()
      formData.set("claimId", String(currentClaim.id))
      formData.set("refundAccountHolder", holder)
      formData.set("refundAccountIdentifier", identifier)
      formData.set("refundBank", bank)
      formData.set("refundAmountConfirmed", amount)

      const response = await fetch(`/api/orders/${order.id}/claims`, {
        method: "POST",
        body: formData,
      })
      const data = (await response.json()) as { claim?: SupabaseOrderClaim; error?: string }

      if (!response.ok || !data.claim) {
        setError(data.error || "No se pudieron enviar los datos del reintegro.")
        return
      }

      updateClaimInState(data.claim)
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
    setAffectedItems(["order"])
    setError("")
  }

  if (justCreated) {
    const cancellation = justCreated.failure_type === "cancelar_compra"
    const info = getClaimStatusInfo(justCreated)

    return (
      <section className="mb-2 rounded-xl border border-blue-300/15 bg-black p-3">
        <div className="mx-auto w-full rounded-xl border border-blue-300/15 bg-[#141414] p-4 text-center">
          <CircleCheck className="mx-auto size-9 text-blue-300" />
          <p className="mt-3 text-[11px] font-black uppercase tracking-[0.18em] text-blue-300">
            {cancellation ? "Cancelación solicitada" : "Reclamo creado"}
          </p>
          <h3 className="mt-1 text-xl font-black text-white">
            {cancellation ? "Recibimos tu solicitud" : "Recibimos tu reclamo"}
          </h3>
          <div className={`mx-auto mt-3 inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-black text-white ${info.style}`}>
            <span className={`size-2 rounded-full ${info.dot}`} />
            {info.label}
          </div>
          <p className="mx-auto mt-3 max-w-xl text-sm font-semibold leading-5 text-white/80">
            {cancellation
              ? "BEYONIX revisará la cancelación y te confirmará la resolución por este medio."
              : "BEYONIX revisará el caso y te responderá desde este chat."}
          </p>
          <button
            type="button"
            onClick={() => setJustCreated(null)}
            className={`mt-4 h-10 rounded-lg bg-[#112A43] px-5 text-xs font-black text-white ${beyonixHoverBorder}`}
          >
            Ver seguimiento
          </button>
        </div>
      </section>
    )
  }

  if (claim) {
    const cancellation = claim.failure_type === "cancelar_compra"
    const info = getClaimStatusInfo(claim)
    const messages = sortUniqueMessages(claim.order_claim_messages)
    const customerTurnLocked = messages[messages.length - 1]?.author_role === "cliente"
    const open = !["cerrado", "rechazado"].includes(claim.status)
    const claimFiles = claim.order_claim_files ?? []
    const refundProof = claimFiles.find((file) => file.file_role === "comprobante_devolucion")
    const evidenceFiles = claimFiles.filter((file) => !["comprobante_devolucion", "comprobante_diferencia"].includes(file.file_role))
    const evidenceSent = evidenceFiles.length > 0
    const canUploadEvidence = !cancellation && (!evidenceSent || claim.status === "falta_informacion")
    const refundPending =
      claim.status === "reintegro_pendiente" &&
      ["reintegro_total", "reintegro_parcial"].includes(claim.resolution ?? claim.customer_selected_resolution ?? "")
    const refundDetailsSubmitted = Boolean(claim.refund_details_submitted_at)
    const affectedProductLabel = cancellation
      ? "Pedido completo"
      : getAffectedProductsFromDescription(claim.description) || "Producto del pedido"

    return (
      <section className="mb-1 rounded-xl border border-blue-300/15 bg-[#141414] p-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/8 pb-2">
          <div>
            <p className="text-[10px] font-black uppercase tracking-[0.16em] text-blue-300">Ayuda con tu compra</p>
            <h3 className="mt-0.5 text-base font-black text-white">
              {cancellation ? "Seguimiento de cancelación" : "Seguimiento del reclamo"}
            </h3>
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-white/55">
              <span>Pedido #BX-{1000 + order.id}</span>
              <span>Fecha: {formatDate(claim.created_at)}</span>
              <span>Motivo: {PROBLEM_LABELS[claim.failure_type ?? ""] ?? "Solicitud de ayuda"}</span>
              <span>{cancellation ? "Alcance" : "Producto"}: {affectedProductLabel}</span>
            </div>
          </div>
          <span className={`inline-flex w-fit items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-black text-white ${info.style}`}>
            <span className={`size-2 rounded-full ${info.dot}`} />
            {info.label}
          </span>
        </div>

        {claim.rejection_reason && (
          <div className="mt-2.5 rounded-xl border border-red-300/20 bg-red-500/8 p-3">
            <p className="text-xs font-black text-white">Motivo del rechazo</p>
            <p className="mt-1 text-xs leading-5 text-white/85">{claim.rejection_reason}</p>
          </div>
        )}

        <div className="mt-2.5 overflow-hidden rounded-lg border border-white/7 bg-[#181818]">
          <div className="border-b border-white/8 px-3 py-2">
            <p className="text-[10px] font-black uppercase tracking-[0.16em] text-blue-300">Conversación</p>
          </div>
          <div ref={chatRef} className="min-h-72 max-h-[32rem] space-y-2 overflow-y-auto p-2.5">
            {messages.map((message) => {
              const customer = message.author_role === "cliente"
              return (
                <div key={message.id} className={`flex ${customer ? "justify-end" : "justify-start"}`}>
                  <div className={`max-w-[82%] rounded-lg px-2.5 py-1.5 ${customer ? "bg-[#112A43]" : "bg-black/45"}`}>
                    <p className="text-[10px] font-black text-blue-200">{customer ? "Vos" : "BEYONIX"}</p>
                    <p className="whitespace-pre-wrap text-xs leading-4 text-white">{getCustomerClaimMessageText(message.message)}</p>
                    <p className="mt-0.5 text-[9px] text-white/45">{formatDate(message.created_at)}</p>
                  </div>
                </div>
              )
            })}
            {messages.length === 0 && <p className="text-xs text-white/65">La conversación todavía no tiene mensajes.</p>}
          </div>
        </div>

        {evidenceSent && (
          <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-[#181818] px-3 py-2">
            <span className="text-xs font-bold text-blue-200">
              <Check className="mr-1 inline size-3.5" />
              Evidencia enviada
            </span>
            <details>
              <summary className="cursor-pointer text-xs font-black text-blue-300">Ver archivos enviados ({evidenceFiles.length})</summary>
              <div className="mt-2.5 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                {evidenceFiles.map((file) => <FilePreview key={file.id} file={file} />)}
              </div>
            </details>
          </div>
        )}

        {["aprobado", "cambio_pendiente", "cupon_pendiente", "reemplazo_enviado"].includes(claim.status) && (
          <p className="mt-2.5 rounded-lg border border-blue-300/20 bg-[#112A43]/35 px-3 py-2 text-xs font-bold text-blue-100">
            BEYONIX está gestionando la solución del caso. Te avisaremos cualquier novedad por este chat.
          </p>
        )}

        {claim.coupon_code && (
          <div className="mt-2.5 flex flex-wrap items-center gap-2 rounded-lg border border-[#77E6E2]/20 bg-[#77E6E2]/5 px-3 py-2">
            <span className="text-xs font-bold text-[#D7FFFD]">Cupón disponible:</span>
            <code className="rounded-md border border-white/10 bg-black/30 px-2 py-1 text-xs font-black text-white">{claim.coupon_code}</code>
            <button type="button" onClick={() => void navigator.clipboard?.writeText(claim.coupon_code ?? "")} className="h-7 rounded-md border border-blue-300/20 px-2 text-10px font-black text-blue-200 hover:border-blue-300/45">
              Copiar
            </button>
          </div>
        )}

        {open ? (
          <div className="mt-2.5">
            {refundPending && !refundDetailsSubmitted ? (
              <div className="rounded-lg border border-[#77E6E2]/20 bg-[#77E6E2]/5 p-3">
                <p className="text-xs font-black text-white">Completá los datos para recibir el reintegro.</p>
                <p className="mt-1 text-xs leading-5 text-white/65">Mientras esperamos estos datos, la conversación queda pausada.</p>
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  <input value={refundAccountHolder} onChange={(event) => setRefundAccountHolder(event.target.value)} placeholder="Titular de la cuenta" className="h-9 rounded-lg border border-white/10 bg-[#181818] px-3 text-xs text-white outline-none placeholder:text-white/40 focus:border-[#77E6E2]/45" />
                  <input value={refundAccountIdentifier} onChange={(event) => setRefundAccountIdentifier(event.target.value)} placeholder="Alias o CBU/CVU" className="h-9 rounded-lg border border-white/10 bg-[#181818] px-3 text-xs text-white outline-none placeholder:text-white/40 focus:border-[#77E6E2]/45" />
                  <input value={refundBank} onChange={(event) => setRefundBank(event.target.value)} placeholder="Banco / billetera" className="h-9 rounded-lg border border-white/10 bg-[#181818] px-3 text-xs text-white outline-none placeholder:text-white/40 focus:border-[#77E6E2]/45" />
                  <input value={refundAmountConfirmed} onChange={(event) => setRefundAmountConfirmed(event.target.value)} placeholder="Importe a recibir" className="h-9 rounded-lg border border-white/10 bg-[#181818] px-3 text-xs text-white outline-none placeholder:text-white/40 focus:border-[#77E6E2]/45" />
                </div>
                <button type="button" disabled={loading} onClick={() => void submitRefundDetails(claim)} className="mt-3 h-9 rounded-lg bg-[#112A43] px-4 text-xs font-black text-white disabled:cursor-not-allowed disabled:opacity-45">
                  Enviar datos
                </button>
              </div>
            ) : refundPending ? (
              <p className="rounded-lg border border-[#77E6E2]/20 bg-[#77E6E2]/5 px-3 py-2 text-xs font-bold text-[#D7FFFD]">
                Datos recibidos. BEYONIX realizará el reintegro.
              </p>
            ) : (
              <>
                <textarea
                  value={reply}
                  disabled={customerTurnLocked || loading}
                  onChange={(event) => setReply(event.target.value)}
                  rows={2}
                  placeholder="Escribí tu mensaje"
                  className="w-full resize-none rounded-lg border border-blue-300/15 bg-[#181818] px-3 py-2 text-xs leading-5 text-white outline-none placeholder:text-white/50 focus:border-blue-300/50 disabled:cursor-not-allowed disabled:opacity-45"
                />
                {customerTurnLocked && (
                  <p className="mt-2 rounded-lg border border-blue-300/15 bg-[#112A43]/30 px-3 py-2 text-xs font-bold text-blue-100">
                    Mensaje enviado. Esperá la respuesta de BEYONIX para continuar.
                  </p>
                )}
                <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
                  {canUploadEvidence ? (
                    <div className={`min-w-0 flex-1 ${customerTurnLocked ? "opacity-45" : ""}`}>
                      <EvidenceUploader files={replyFiles} onChange={setReplyFiles} disabled={loading || customerTurnLocked} />
                    </div>
                  ) : (
                    <p className="text-[11px] text-white/55">Podrás adjuntar nueva evidencia si BEYONIX solicita más información.</p>
                  )}
                  <button type="button" disabled={loading || customerTurnLocked} onClick={() => void sendReply(claim)} className="inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-lg bg-[#112A43] px-4 text-xs font-black text-white disabled:cursor-not-allowed disabled:opacity-45">
                    <Send className="size-3.5" />
                    {loading ? "Enviando..." : "Enviar"}
                  </button>
                </div>
              </>
            )}
            {error && <p className="mt-2 text-xs font-bold text-red-300">{error}</p>}
          </div>
        ) : (
          <div className="mt-2.5 space-y-2">
            <p className="rounded-lg border border-blue-300/15 bg-[#112A43]/25 px-3 py-2 text-xs font-bold text-blue-100">
              {cancellation ? "La solicitud de cancelación ya fue cerrada." : "Caso finalizado. Podés consultar la conversación cuando quieras."}
            </p>
            {refundProof?.signedUrl && (
              <a href={refundProof.signedUrl} target="_blank" rel="noreferrer" className="inline-flex h-9 items-center gap-2 rounded-lg border border-[#77E6E2]/25 bg-[#77E6E2]/5 px-3 text-xs font-black text-white hover:border-[#77E6E2]/45">
                <FileText className="size-3.5 text-[#77E6E2]" />
                Ver comprobante de devolución
              </a>
            )}
          </div>
        )}
      </section>
    )
  }

  const stage = getOrderStage(order)

  return (
    <section className="customer-claim-experience rounded-2xl border border-blue-300/15 bg-[#0D1117] p-3 sm:p-5">
      <div className="flex flex-col gap-3 border-b border-white/8 pb-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <p className="text-11px font-black uppercase tracking-[0.16em] text-blue-300">Ayuda con tu compra</p>
          <h3 className="mt-1 text-xl font-black text-white">{stage.title}</h3>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-white/68">{stage.detail}</p>
        </div>
        <span className="inline-flex w-fit items-center gap-2 rounded-full border border-blue-300/20 bg-[#112A43]/35 px-3 py-1.5 text-xs font-black text-white">
          <span className="size-2 rounded-full bg-blue-300" />
          Pedido #BX-{1000 + order.id}
        </span>
      </div>

      <div className="mt-3">
        <ProductSummary order={order} />
      </div>

      {canCancel && (
        <div className="mt-3 rounded-xl border border-white/9 bg-[#141820] p-3">
          <div className="flex items-start gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[#112A43]">
              <X className="size-5 text-blue-300" />
            </span>
            <div>
              <h4 className="text-sm font-black text-white">Cancelar compra</h4>
              <p className="mt-1 text-xs leading-5 text-white/65">
                BEYONIX revisará la solicitud. La orden no se borra y la cancelación no se confirma automáticamente.
              </p>
            </div>
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {CANCELLATION_REASONS.map((reason) => (
              <button
                key={reason.value}
                type="button"
                onClick={() => setCancellationReason(reason.value)}
                className={`min-h-10 rounded-lg border px-3 text-left text-xs font-black transition ${
                  cancellationReason === reason.value
                    ? "border-blue-300/55 bg-[#112A43] text-white"
                    : "border-white/10 bg-[#1B2028] text-white/78 hover:border-blue-300/35"
                }`}
              >
                {reason.label}
              </button>
            ))}
          </div>
          <textarea
            value={cancellationMessage}
            onChange={(event) => setCancellationMessage(event.target.value)}
            rows={3}
            maxLength={CLAIM_DESCRIPTION_MAX_LENGTH}
            placeholder="Podés agregar un comentario si querés."
            className="mt-3 w-full resize-none rounded-xl border border-blue-300/15 bg-[#101820] px-3 py-2.5 text-sm leading-6 text-white outline-none placeholder:text-white/40 focus:border-blue-300/50"
          />
          <button type="button" disabled={loading} onClick={() => void createCancellationRequest()} className="mt-3 h-10 rounded-lg bg-[#112A43] px-5 text-xs font-black text-white disabled:cursor-not-allowed disabled:opacity-40">
            {loading ? "Enviando..." : "Solicitar cancelación"}
          </button>
        </div>
      )}

      {!canCancel && !canCreatePostDeliveryClaim && !cancelled && (
        <div className="mt-3 rounded-xl border border-white/9 bg-[#141820] p-3">
          <div className="flex gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[#112A43]">
              <Truck className="size-5 text-blue-300" />
            </span>
            <div>
              <h4 className="text-sm font-black text-white">
                {invoiced && !dispatched ? "Cancelación no disponible" : "Reclamo no disponible todavía"}
              </h4>
              <p className="mt-1 text-xs leading-5 text-white/65">
                {invoiced && !dispatched
                  ? "Tu pedido ya fue facturado, por eso no es posible cancelarlo desde esta sección."
                  : "Todavía no podés iniciar un reclamo porque el pedido no figura como entregado. Si cuando lo recibas hay algún problema, vas a poder reclamar desde esta sección."}
              </p>
              {(order.tracking_number || order.andreani_tracking) && (
                <p className="mt-2 text-xs font-bold text-white/75">
                  Seguimiento: {order.tracking_number || order.andreani_tracking}
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {canCreatePostDeliveryClaim && (
        <div className="mt-3 rounded-xl border border-white/9 bg-[#141820] p-3">
          <div className="flex items-start gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[#112A43]">
              <MessageCircle className="size-5 text-blue-300" />
            </span>
            <div>
              <h4 className="text-sm font-black text-white">Iniciar reclamo</h4>
              <p className="mt-1 text-xs leading-5 text-white/65">
                Contanos qué problema tuvo el producto recibido. BEYONIX revisará el caso y te responderá desde este chat.
              </p>
            </div>
          </div>

          <div className="mt-4">
            <p className="text-10px font-black uppercase tracking-[0.16em] text-blue-300">Producto afectado</p>
            <div className="mt-2 grid gap-2 md:grid-cols-2">
              {orderItems.map((item) => {
                const value = String(item.id)
                const image = getItemImage(item)
                const selectedItem = affectedItems.includes(value)
                const name = item.productos?.nombre ?? `Producto #${item.producto_id}`
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => toggleAffectedProduct(value)}
                    className={`flex min-h-20 items-center gap-3 rounded-xl border p-3 text-left transition ${
                      selectedItem
                        ? "border-blue-300/55 bg-[#112A43] shadow-[0_0_18px_rgba(17,42,67,0.35)]"
                        : "border-white/9 bg-[#101820] hover:border-blue-300/30"
                    }`}
                  >
                    <span className="flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-white">
                      {image ? <img src={image} alt={name} className="size-full object-contain" /> : <Package className="size-5 text-black/30" />}
                    </span>
                    <span className="min-w-0">
                      <strong className="block text-sm text-white">{name}</strong>
                      <span className="mt-1 block text-xs text-white/62">{getItemVariant(item)} · Cantidad: {item.cantidad}</span>
                    </span>
                  </button>
                )
              })}
              {orderItems.length > 1 && (
                <button
                  type="button"
                  onClick={selectWholeOrder}
                  className={`flex min-h-20 items-center gap-3 rounded-xl border p-3 text-left transition ${
                    affectedItems.includes("order")
                      ? "border-blue-300/55 bg-[#112A43] shadow-[0_0_18px_rgba(17,42,67,0.35)]"
                      : "border-white/9 bg-[#101820] hover:border-blue-300/30"
                  }`}
                >
                  <span className="flex size-14 shrink-0 items-center justify-center rounded-xl bg-[#1B2028]">
                    <Truck className="size-6 text-blue-300" />
                  </span>
                  <span>
                    <strong className="block text-sm text-white">Todo el pedido recibido</strong>
                    <span className="mt-1 block text-xs leading-4 text-white/62">Para faltantes o problemas generales del pedido recibido.</span>
                  </span>
                </button>
              )}
            </div>
          </div>

          <div className="mt-4">
            <p className="text-10px font-black uppercase tracking-[0.16em] text-blue-300">Motivo</p>
            <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {POST_DELIVERY_PROBLEMS.map((item) => {
                const Icon = item.icon
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      setProblem(item.id)
                      setError("")
                    }}
                    className={`flex min-h-20 items-center gap-3 rounded-xl border p-3 text-left transition ${
                      problem === item.id
                        ? "border-blue-300/55 bg-[#112A43] shadow-[0_0_18px_rgba(17,42,67,0.3)]"
                        : "border-white/9 bg-[#101820] hover:border-blue-300/30"
                    }`}
                  >
                    <span className="rounded-lg bg-[#1B2028] p-2">
                      <Icon className="size-5 text-blue-300" />
                    </span>
                    <span>
                      <strong className="block text-sm text-white">{item.title}</strong>
                      <span className="mt-0.5 block text-xs leading-4 text-white/60">{item.description}</span>
                    </span>
                  </button>
                )
              })}
            </div>
          </div>

          <div className="mt-4">
            <p className="text-10px font-black uppercase tracking-[0.16em] text-blue-300">Detalle</p>
            <textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={5}
              minLength={CLAIM_DESCRIPTION_MIN_LENGTH}
              maxLength={CLAIM_DESCRIPTION_MAX_LENGTH}
              placeholder="Describí qué recibiste y cuál fue el problema."
              className="mt-2 w-full resize-none rounded-xl border border-blue-300/15 bg-[#101820] px-3 py-2.5 text-sm leading-6 text-white outline-none placeholder:text-white/40 focus:border-blue-300/50"
            />
            <p className="mt-1 text-right text-10px text-white/40">{description.length}/{CLAIM_DESCRIPTION_MAX_LENGTH}</p>
            <div className="mt-2">
              <EvidenceUploader files={files} onChange={setFiles} disabled={loading} />
            </div>
            {error && <p className="mt-3 rounded-lg border border-red-300/20 bg-red-500/10 px-3 py-2 text-xs font-bold text-red-200">{error}</p>}
            <button type="button" disabled={loading || description.trim().length < CLAIM_DESCRIPTION_MIN_LENGTH} onClick={() => void createClaim()} className="mt-4 h-10 rounded-lg bg-[#112A43] px-5 text-xs font-black text-white disabled:cursor-not-allowed disabled:opacity-40">
              {loading ? "Enviando..." : "Enviar reclamo"}
            </button>
          </div>
        </div>
      )}

      {cancelled && (
        <div className="mt-3 rounded-xl border border-white/9 bg-[#141820] p-3 text-xs font-semibold leading-5 text-white/65">
          La compra figura como cancelada. Si necesitás consultar algo sobre esta orden, contactá a BEYONIX por los canales de atención.
        </div>
      )}

      {error && !canCreatePostDeliveryClaim && <p className="mt-3 rounded-lg border border-red-300/20 bg-red-500/10 px-3 py-2 text-xs font-bold text-red-200">{error}</p>}
    </section>
  )
}
