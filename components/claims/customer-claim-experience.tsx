"use client"

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import {
  AlertTriangle,
  Check,
  CircleCheck,
  Clock3,
  FileText,
  MessageCircle,
  Package,
  Paperclip,
  Send,
  Truck,
  Upload,
  X,
} from "lucide-react"

import { BEYONIX_SUPPORT_HOURS_DETAIL } from "@/lib/legal-contact"
import { getClaimFileValidationError, getOrderClaimResolutionLabel } from "@/lib/order-claims"
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
  | "consulta_pedido"

type ClaimProblemOption = {
  id: ClaimProblemId
  title: string
  description: string
  icon: typeof Package
  claimType: OrderClaimType
}

const CLAIM_DESCRIPTION_MIN_LENGTH = 10
const CLAIM_DESCRIPTION_MAX_LENGTH = 600
const CANCELLATION_REASON_MIN_LENGTH = 5
const CANCELLATION_REASON_MAX_LENGTH = 600
const HELP_MESSAGE_PROBLEM_TYPE: ClaimProblemId = "consulta_pedido"
const SUPPORT_EMAIL = "beyonix.ar@gmail.com"
const SUPPORT_EMAIL_URL = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(SUPPORT_EMAIL)}`

const POST_DELIVERY_PROBLEMS: ClaimProblemOption[] = [
  {
    id: "incorrecto",
    title: "Producto incorrecto",
    description: "Recibí otro producto.",
    icon: Package,
    claimType: "transporte_48hs",
  },
  {
    id: "danado",
    title: "Producto dañado",
    description: "Llegó roto o dañado.",
    icon: AlertTriangle,
    claimType: "transporte_48hs",
  },
  {
    id: "faltante",
    title: "Producto faltante",
    description: "El pedido llegó incompleto.",
    icon: Package,
    claimType: "transporte_48hs",
  },
  {
    id: "otro",
    title: "Otro problema",
    description: "Algo no coincide.",
    icon: MessageCircle,
    claimType: "garantia_beyonix",
  },
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
  consulta_pedido: "Mensaje de ayuda",
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
  const dispatchedStatuses = [
    "enviado",
    "en_camino",
    "visita_fallida",
    "en_sucursal",
    "retiro_pendiente",
    "retiro_vencido",
    "en_devolucion",
    "devuelto_beyonix",
    "entregado",
  ]

  return (
    dispatchedStatuses.includes(estado) ||
    Boolean(order.tracking_number || order.andreani_tracking || order.andreani_envio_id) ||
    ["camino", "tránsito", "transito", "distribución", "distribucion", "reparto", "visita", "entregado"].some(
      (status) => andreaniStatus.includes(status),
    )
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

function getOrderCode(orderId: number) {
  return `BX-${1000 + orderId}`
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

function CustomerClaimMessageBody({ message }: { message: string }) {
  const text = getCustomerClaimMessageText(message)
  const parts = text.split(SUPPORT_EMAIL)

  if (parts.length === 1) {
    return <>{text}</>
  }

  return (
    <>
      {parts.map((part, index) => (
        <span key={index}>
          {part}
          {index < parts.length - 1 && (
            <a
              href={SUPPORT_EMAIL_URL}
              target="_blank"
              rel="noreferrer"
              className="font-black text-blue-200 underline decoration-blue-200/45 underline-offset-2 hover:text-white"
            >
              {SUPPORT_EMAIL}
            </a>
          )}
        </span>
      ))}
    </>
  )
}

function getAffectedProductsFromDescription(description: string) {
  const match = description.match(/^Producto afectado:\s*(.+?)(?:\r?\n){2}/)
  return match?.[1]?.trim() || ""
}

function getItemImage(item: NonNullable<SupabasePedido["orden_items"]>[number]) {
  return item.conditioned_images?.[0]
    || item.producto_variantes?.imagenes?.[0]
    || item.productos?.imagen_principal
    || item.productos?.imagenes_producto?.[0]?.url
    || ""
}

function getItemVariant(item: NonNullable<SupabasePedido["orden_items"]>[number]) {
  return item.conditioned_name?.trim()
    || item.producto_variantes?.nombre?.trim()
    || "Sin variante"
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
      title: "Pedido en camino",
      detail: "Si tu pedido se demora o necesitás consultar algo, podés enviarnos un mensaje de ayuda.",
    }
  }

  return {
    title: "Pedido en preparación",
    detail: "Estamos preparando tu compra. Si necesitás consultar algo, podés enviarnos un mensaje de ayuda.",
  }
}

function getClaimStatusInfo(claim: SupabaseOrderClaim) {
  const cancellation = claim.failure_type === "cancelar_compra"
  const helpMessage = claim.failure_type === HELP_MESSAGE_PROBLEM_TYPE
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
    return { label: "Compra cancelada", dot: "bg-blue-300", style: base }
  }

  if (helpMessage) {
    if (claim.status === "rechazado") return { label: "Consulta cerrada", dot: "bg-[#77E6E2]", style: "border-[#77E6E2]/25 bg-[#77E6E2]/8" }
    if (claim.status === "cerrado") return { label: "Consulta resuelta", dot: "bg-[#77E6E2]", style: "border-[#77E6E2]/25 bg-[#77E6E2]/8" }
    if (claim.status === "falta_informacion") return { label: "Esperando tu respuesta", dot: "bg-blue-300", style: base }
    return { label: "Mensaje recibido", dot: "bg-blue-300", style: base }
  }

  if (claim.status === "recibido") {
    return {
      label: "Reclamo recibido",
      dot: "bg-emerald-200",
      style: "border-emerald-200/45 bg-emerald-300/12 text-emerald-50",
    }
  }
  if (claim.status === "en_revision") return { label: "En revisión por BEYONIX", dot: "bg-blue-300", style: base }
  if (claim.status === "falta_informacion") return { label: "Esperando tu respuesta", dot: "bg-blue-300", style: base }
  if (["aprobado", "reintegro_pendiente", "cambio_pendiente", "cupon_pendiente", "reemplazo_enviado"].includes(claim.status)) {
    return { label: "Solución en proceso", dot: "bg-[#77E6E2]", style: "border-[#77E6E2]/25 bg-[#77E6E2]/8" }
  }
  if (claim.status === "rechazado") return { label: "Reclamo rechazado", dot: "bg-red-300", style: "border-red-300/25 bg-red-400/8" }
  if (claim.status === "cerrado") return { label: "Reclamo finalizado", dot: "bg-[#77E6E2]", style: "border-[#77E6E2]/25 bg-[#77E6E2]/8" }

  return { label: "En revisión por BEYONIX", dot: "bg-blue-300", style: base }
}

function getCustomerResolutionSummary(claim: SupabaseOrderClaim) {
  const resolution = claim.resolution ?? claim.customer_selected_resolution

  if (resolution === "cambio_producto") {
    if (claim.status === "reemplazo_enviado") {
      const tracking = claim.replacement_tracking ? ` Seguimiento: ${claim.replacement_tracking}.` : ""
      return {
        title: "Solución: cambio de producto",
        body: `BEYONIX ya despachó el reemplazo.${tracking}`,
      }
    }

    if (claim.status === "cambio_pendiente" || claim.status === "cerrado") {
      return {
        title: "Solución: cambio de producto",
        body: "El cambio quedó registrado.",
      }
    }

    return {
      title: "Solución: cambio de producto",
      body: "BEYONIX aprobó el cambio del producto.",
    }
  }

  if (resolution === "envio_unidad_faltante") {
    if (claim.status === "reemplazo_enviado") {
      const tracking = claim.replacement_tracking ? ` Seguimiento: ${claim.replacement_tracking}.` : ""
      return {
        title: "Solución: envío de unidad faltante",
        body: `BEYONIX ya despachó la unidad pendiente.${tracking}`,
      }
    }

    if (claim.status === "cambio_pendiente" || claim.status === "cerrado") {
      return {
        title: "Solución: envío de unidad faltante",
        body: "La reposición de la unidad faltante quedó registrada.",
      }
    }

    return {
      title: "Solución: envío de unidad faltante",
      body: "BEYONIX aceptó el faltante y va a preparar el envío de la unidad pendiente.",
    }
  }

  if (resolution === "cupon_descuento") {
    return {
      title: "Solución: nota de crédito",
      body: "BEYONIX aprobó una nota de crédito a tu favor.",
    }
  }

  if (resolution === "reintegro_total" || resolution === "reintegro_parcial") {
    return {
      title: `Solución: ${getOrderClaimResolutionLabel(resolution).toLowerCase()}`,
      body: "BEYONIX aprobó la devolución del dinero correspondiente.",
    }
  }

  if (resolution === "otro") {
    return {
      title: "Solución en proceso",
      body: "BEYONIX está gestionando la solución del caso.",
    }
  }

  return null
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
  surface = "blue",
}: {
  files: File[]
  onChange: (files: File[]) => void
  disabled?: boolean
  surface?: "blue" | "neutral"
}) {
  const neutralSurface = surface === "neutral"
  const labelClassName = neutralSurface
    ? `customer-claim-evidence-dropzone flex min-h-[140px] w-full flex-col items-center justify-center gap-2.5 rounded-xl border border-dashed border-[#3B4E63] bg-[#151E28] px-4 py-4 text-center transition-all duration-200 focus-within:border-[#5CA9E6] focus-within:ring-2 focus-within:ring-[#5CA9E6]/18 ${disabled ? "cursor-not-allowed opacity-45" : "cursor-pointer hover:border-[#5CA9E6]/70 hover:bg-[#192633]"}`
    : `flex min-h-16 items-center justify-center gap-3 rounded-xl border border-dashed border-[#21476B] bg-[#2A313A] px-3 py-2 text-left transition-all duration-200 focus-within:border-[#2C6CA3] focus-within:ring-2 focus-within:ring-[#2C6CA3]/20 ${disabled ? "cursor-not-allowed opacity-45" : "cursor-pointer hover:border-[#2B5D8A] hover:bg-[#333B46]"}`
  const iconClassName = neutralSurface
    ? "flex size-11 shrink-0 items-center justify-center rounded-xl border border-[#5CA9E6]/35 bg-[#112A43]"
    : "flex size-9 shrink-0 items-center justify-center rounded-lg border border-[#21476B] bg-[#16304B]"
  const helperClassName = neutralSurface
    ? "mt-1 block text-xs leading-5 text-[#A9BACB]"
    : "mt-0.5 block text-[11px] text-[#7D8FA1]"
  const chipClassName = neutralSurface
    ? "inline-flex min-w-0 items-center gap-2 rounded-lg border border-[#34485C] bg-[#151F2A] px-3 py-2 text-xs font-bold text-white"
    : "inline-flex max-w-64 items-center gap-1.5 rounded-lg border border-[#21476B] bg-[#13263B] px-2.5 py-1.5 text-xs font-bold text-white"

  return (
    <div>
      <label className={labelClassName}>
        <span className={iconClassName}>
          <Upload className="size-4 text-white" />
        </span>
        <span>
          <span className={neutralSurface ? "block text-sm font-black text-white" : "block text-xs font-black text-white"}>
            Fotos o videos
          </span>
          <span className={helperClassName}>Imágenes, videos, PDF o documentos.</span>
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
        <div className={neutralSurface ? "mt-2 grid gap-1.5" : "mt-2 flex flex-wrap gap-1.5"}>
          {files.map((file, index) => (
            <span key={`${file.name}-${index}`} className={chipClassName}>
              <Paperclip className="size-3.5 shrink-0 text-white" />
              <span className="truncate">{file.name}</span>
              <button
                type="button"
                aria-label={`Quitar ${file.name}`}
                onClick={() => onChange(files.filter((_, itemIndex) => itemIndex !== index))}
                className="ml-auto flex size-6 shrink-0 items-center justify-center rounded-md text-white/60 transition-colors hover:bg-white/8 hover:text-white"
              >
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
  const stage = getOrderStage(order)

  return (
    <div className="rounded-xl border border-blue-300/12 bg-[#111820] p-3 shadow-[0_18px_50px_rgba(0,0,0,0.18)]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-10px font-black uppercase tracking-[0.16em] text-blue-300">Resumen del pedido</p>
          <p className="mt-1 text-base font-black text-white">Pedido {getOrderCode(order.id)}</p>
          <p className="mt-0.5 text-xs font-semibold text-white/55">{stage.title}</p>
        </div>
        <div className="rounded-lg border border-emerald-300/35 bg-emerald-400/12 px-3 py-2 text-left shadow-[0_0_24px_rgba(52,211,153,0.12)] sm:text-right">
          <p className="text-10px font-bold uppercase tracking-wide text-emerald-200">Total</p>
          <p className="text-lg font-black text-emerald-50">{formatPrice(Number(order.total ?? 0))}</p>
        </div>
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        <div className="rounded-lg border border-white/7 bg-[#18202A] px-3 py-2">
          <p className="text-10px font-bold uppercase tracking-wide text-white/45">Estado</p>
          <p className="mt-0.5 text-xs font-black text-white">{stage.title}</p>
        </div>
        <div className="rounded-lg border border-white/7 bg-[#18202A] px-3 py-2">
          <p className="text-10px font-bold uppercase tracking-wide text-white/45">Productos</p>
          <p className="mt-0.5 text-xs font-black text-white">{productCount} {productCount === 1 ? "producto" : "productos"}</p>
        </div>
        <div className="rounded-lg border border-white/7 bg-[#18202A] px-3 py-2">
          <p className="text-10px font-bold uppercase tracking-wide text-white/45">Seguimiento</p>
          <p className="mt-0.5 truncate text-xs font-black text-white">{order.tracking_number || order.andreani_tracking || "Disponible al despachar"}</p>
        </div>
      </div>
    </div>
  )
}

function CustomerClaimExperienceSkeleton() {
  return (
    <section
      className="customer-claim-followup-shell mb-1 rounded-xl border border-blue-300/15 p-2.5"
      style={{
        background: "#070C12",
        backgroundColor: "#070C12",
        backgroundImage: "none",
        opacity: 1,
        backdropFilter: "none",
        WebkitBackdropFilter: "none",
      }}
      aria-label="Cargando seguimiento"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/8 pb-2">
        <div className="space-y-2">
          <div className="h-3 w-36 rounded bg-[#112A43]" />
          <div className="h-5 w-44 rounded bg-white/10" />
          <div className="h-3 w-56 rounded bg-white/8" />
        </div>
        <div className="h-7 w-32 rounded-full border border-blue-300/20 bg-[#112A43]" />
      </div>
      <div className="mt-2.5 h-[21rem] rounded-lg border border-white/7 bg-[#181818]" />
      <div className="mt-2.5 h-9 rounded-lg border border-blue-300/15 bg-[#112A43]/25" />
      <div className="mt-2.5 h-9 w-56 rounded-lg border border-blue-300/25 bg-[#112A43]" />
    </section>
  )
}

export function CustomerClaimExperience({
  order,
  initialProblem,
  claimsVerified = false,
  onOrderCancelled,
}: {
  order: SupabasePedido
  initialProblem?: ClaimProblemId
  claimsVerified?: boolean
  onOrderCancelled?: () => void
}) {
  const router = useRouter()
  const orderItems = order.orden_items ?? []
  const delivered = isOrderDelivered(order)
  const dispatched = isOrderDispatched(order)
  const cancelled = isOrderCancelled(order)
  const [orderCancelled, setOrderCancelled] = useState(cancelled)
  const effectiveCancelled = cancelled || orderCancelled
  const canCancel = !delivered && !dispatched && !effectiveCancelled
  const canCreatePostDeliveryClaim = delivered && !effectiveCancelled
  const canCreateHelpMessage = !delivered && !effectiveCancelled
  const initialProblemAllowed = POST_DELIVERY_PROBLEMS.some((item) => item.id === initialProblem)
  const defaultAffectedItems = orderItems.length === 1 ? [String(orderItems[0].id)] : []
  const initialClaims = order.order_claims ?? []
  const initialClaimsReady = claimsVerified || initialClaims.length > 0

  const [claims, setClaims] = useState<SupabaseOrderClaim[]>(initialClaims)
  const [affectedItems, setAffectedItems] = useState<string[]>(defaultAffectedItems)
  const [problem, setProblem] = useState<ClaimProblemId | null>(
    initialProblemAllowed ? initialProblem ?? null : null,
  )
  const [description, setDescription] = useState("")
  const [files, setFiles] = useState<File[]>([])
  const [cancellationSuccess, setCancellationSuccess] = useState(false)
  const [cancellationReason, setCancellationReason] = useState("")
  const [cancellingOrder, setCancellingOrder] = useState(false)
  const [cancellationError, setCancellationError] = useState("")
  const [reply, setReply] = useState("")
  const [replyFiles, setReplyFiles] = useState<File[]>([])
  const [refundAccountHolder, setRefundAccountHolder] = useState("")
  const [refundAccountIdentifier, setRefundAccountIdentifier] = useState("")
  const [refundBank, setRefundBank] = useState("")
  const [refundAmountConfirmed, setRefundAmountConfirmed] = useState("")
  const [justCreated, setJustCreated] = useState<SupabaseOrderClaim | null>(null)
  const [claimsReady, setClaimsReady] = useState(initialClaimsReady)
  const [claimsReadyOrderId, setClaimsReadyOrderId] = useState<number | null>(order.id)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const shellRef = useRef<HTMLElement>(null)
  const chatRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setOrderCancelled(cancelled)
  }, [cancelled])

  const loadClaims = useCallback(async () => {
    try {
      const response = await fetch(`/api/orders/${order.id}/claims`)
      if (!response.ok) return
      const data = (await response.json()) as { claims?: SupabaseOrderClaim[] }
      if (Array.isArray(data.claims)) {
        setClaims(data.claims)
      }
    } catch {
      // Keep the already loaded order claims on screen if the background refresh fails.
    } finally {
      setClaimsReadyOrderId(order.id)
      setClaimsReady(true)
    }
  }, [order.id])

  useEffect(() => {
    setClaims(initialClaims)
    setClaimsReadyOrderId(order.id)
    setClaimsReady(initialClaimsReady)
    void loadClaims()
    const intervalId = window.setInterval(() => void loadClaims(), 5000)
    window.addEventListener("focus", loadClaims)
    return () => {
      window.clearInterval(intervalId)
      window.removeEventListener("focus", loadClaims)
    }
  }, [claimsVerified, initialClaims.length, loadClaims, order.id])

  const visibleClaims = claims.filter((claim) => claim.failure_type !== "cancelar_compra")
  const displayableClaims = canCreatePostDeliveryClaim
    ? visibleClaims.filter((claim) => claim.failure_type !== HELP_MESSAGE_PROBLEM_TYPE)
    : visibleClaims
  const activeClaim = displayableClaims.find((claim) =>
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
  const claim = activeClaim ?? displayableClaims[0]
  const messageCount = claim?.order_claim_messages?.length ?? 0
  const goToOrders = () => router.push("/cuenta?tab=ordenes")

  const scrollToPageTop = useCallback(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" })
    document.documentElement.scrollTop = 0
    document.body.scrollTop = 0
  }, [])

  useLayoutEffect(() => {
    const chat = chatRef.current
    if (!chat) return
    chat.scrollTop = chat.scrollHeight
  }, [claim?.id, messageCount])

  useLayoutEffect(() => {
    if (!justCreated) return

    scrollToPageTop()
    const frameId = window.requestAnimationFrame(scrollToPageTop)
    const timeoutId = window.setTimeout(scrollToPageTop, 60)

    return () => {
      window.cancelAnimationFrame(frameId)
      window.clearTimeout(timeoutId)
    }
  }, [justCreated, scrollToPageTop])

  if (!claimsReady || claimsReadyOrderId !== order.id) {
    return <CustomerClaimExperienceSkeleton />
  }

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
      formData.set("affectedWholeOrder", String(affectedItems.includes("order")))
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
      setDescription("")
      setFiles([])
      scrollToPageTop()
    } catch {
      setError("No se pudo enviar el reclamo. Intentá nuevamente.")
    } finally {
      setLoading(false)
    }
  }

  const createHelpMessage = async () => {
    if (!canCreateHelpMessage) {
      setError("Este canal de ayuda está disponible antes de que el pedido figure como entregado.")
      return
    }

    const trimmedDescription = description.trim()

    if (trimmedDescription.length < CLAIM_DESCRIPTION_MIN_LENGTH) {
      setError("Contanos un poco más para poder ayudarte.")
      return
    }

    setLoading(true)
    setError("")

    try {
      const formData = new FormData()
      formData.set("claimType", "transporte_48hs")
      formData.set("problemType", HELP_MESSAGE_PROBLEM_TYPE)
      formData.set("description", trimmedDescription)

      const response = await fetch(`/api/orders/${order.id}/claims`, {
        method: "POST",
        body: formData,
      })
      const data = (await response.json()) as { claim?: SupabaseOrderClaim; error?: string }

      if (!response.ok || !data.claim) {
        setError(data.error || "No se pudo enviar el mensaje de ayuda.")
        return
      }

      updateClaimInState(data.claim)
      setDescription("")
      scrollToPageTop()
    } catch {
      setError("No se pudo enviar el mensaje de ayuda. Intentá nuevamente.")
    } finally {
      setLoading(false)
    }
  }

  const cancelOrder = async () => {
    const trimmedReason = cancellationReason.trim()

    if (!canCancel) {
      setCancellationError("Esta compra ya no se puede cancelar desde tu cuenta.")
      return
    }

    if (trimmedReason.length < CANCELLATION_REASON_MIN_LENGTH) {
      setCancellationError("Contanos el motivo con al menos 5 caracteres.")
      return
    }

    setCancellingOrder(true)
    setCancellationError("")

    try {
      const response = await fetch(`/api/orders/${order.id}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: trimmedReason }),
      })
      const data = (await response.json()) as {
        order?: SupabasePedido
        error?: string
      }

      if (!response.ok || !data.order) {
        setCancellationError(data.error || "No se pudo cancelar la compra.")
        return
      }

      setOrderCancelled(true)
      setCancellationSuccess(true)
      setCancellationReason("")
      onOrderCancelled?.()
      scrollToPageTop()
    } catch {
      setCancellationError("No se pudo cancelar la compra. Intentá nuevamente.")
    } finally {
      setCancellingOrder(false)
    }
  }

  const sendReply = async (currentClaim: SupabaseOrderClaim) => {
    const currentMessages = sortUniqueMessages(currentClaim.order_claim_messages)

    if (
      currentMessages[currentMessages.length - 1]?.author_role === "cliente" &&
      replyFiles.length === 0
    ) {
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
      const nextSelection = withoutWholeOrder.includes(value)
        ? withoutWholeOrder.filter((item) => item !== value)
        : [...withoutWholeOrder, value]

      if (orderItems.length > 1 && nextSelection.length === orderItems.length) {
        return ["order"]
      }

      return nextSelection
    })
    setError("")
  }

  const selectWholeOrder = () => {
    setAffectedItems(["order"])
    setError("")
  }

  if (justCreated) {
    const cancellation = justCreated.failure_type === "cancelar_compra"
    const helpMessage = justCreated.failure_type === HELP_MESSAGE_PROBLEM_TYPE
    const info = getClaimStatusInfo(justCreated)

    return (
      <section ref={shellRef} className="customer-claim-followup-shell mb-2 rounded-xl border border-blue-300/15 bg-black p-3">
        <div className="mx-auto w-full rounded-xl border border-blue-300/15 bg-[#141414] p-4 text-center">
          <CircleCheck className="mx-auto size-9 text-blue-300" />
          <p className="mt-3 text-[11px] font-black uppercase tracking-[0.18em] text-blue-300">
            {cancellation ? "Compra cancelada" : helpMessage ? "Mensaje enviado" : "Reclamo creado"}
          </p>
          <h3 className="mt-1 text-xl font-black text-white">
            {cancellation
              ? "Tu compra fue cancelada correctamente."
              : helpMessage
                ? "Recibimos tu mensaje de ayuda"
                : "Recibimos tu reclamo"}
          </h3>
          <div className={`mx-auto mt-3 inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-black text-white ${info.style}`}>
            <span className={`size-2 rounded-full ${info.dot}`} />
            {info.label}
          </div>
          <p className="mx-auto mt-3 max-w-xl text-sm font-semibold leading-5 text-white/80">
            {cancellation
              ? "Tu compra fue cancelada correctamente."
              : helpMessage
                ? "BEYONIX revisará tu consulta y te responderá desde este chat."
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
    const helpMessage = claim.failure_type === HELP_MESSAGE_PROBLEM_TYPE
    const info = getClaimStatusInfo(claim)
    const messages = sortUniqueMessages(claim.order_claim_messages)
    const hideClosedHelpMetadata = helpMessage && claim.status === "cerrado"
    const visibleMessages = hideClosedHelpMetadata
      ? messages.filter((message) => {
          const text = message.message.trim()
          return !/^Esta conversación fue cerrada el .+ por BEYONIX\.$/.test(text)
        })
      : messages
    const customerTurnLocked = messages[messages.length - 1]?.author_role === "cliente"
    const open = !["cerrado", "rechazado"].includes(claim.status)
    const claimFiles = claim.order_claim_files ?? []
    const refundProof = claimFiles.find((file) => file.file_role === "comprobante_devolucion")
    const evidenceFiles = claimFiles.filter((file) => !["comprobante_devolucion", "comprobante_diferencia"].includes(file.file_role))
    const evidenceSent = evidenceFiles.length > 0
    const canUploadEvidence = !cancellation && open
    const closedHelp = helpMessage && claim.status === "cerrado"
    const refundPending =
      claim.status === "reintegro_pendiente" &&
      ["reintegro_total", "reintegro_parcial"].includes(claim.resolution ?? claim.customer_selected_resolution ?? "")
    const resolutionSummary = getCustomerResolutionSummary(claim)
    const refundDetailsSubmitted = Boolean(claim.refund_details_submitted_at)
    const affectedProductLabel = cancellation
      ? "Pedido completo"
      : helpMessage
        ? "Pedido completo"
      : getAffectedProductsFromDescription(claim.description) || "Producto del pedido"

    return (
      <section
        ref={shellRef}
        className="customer-claim-followup-shell claim-chat-shell mb-1 overflow-hidden rounded-2xl border border-[#21476B]"
        style={{
          background: "#070C12",
          backgroundColor: "#070C12",
          backgroundImage: "none",
          opacity: 1,
          backdropFilter: "none",
          WebkitBackdropFilter: "none",
        }}
      >
        <header className="customer-claim-chat-header flex flex-col gap-4 border-b border-[#18334D] bg-[#0B1724] px-5 py-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <p className="text-[11px] font-black uppercase tracking-[0.16em] text-blue-300">
              {getOrderCode(order.id)} · {hideClosedHelpMetadata ? "Ayuda" : (PROBLEM_LABELS[claim.failure_type ?? ""] ?? "Reclamo")}
            </p>
            <h3 className="mt-1.5 text-2xl font-black leading-7 text-white">
              {cancellation ? "Seguimiento de cancelación" : helpMessage ? "Chat de ayuda" : "Chat del reclamo"}
            </h3>
            {!hideClosedHelpMetadata && (
              <p className="mt-2 max-w-3xl text-sm font-semibold leading-5 text-[#9EB4C8]">
                {cancellation
                  ? "Este chat reúne el seguimiento de la cancelación."
                  : helpMessage
                    ? "BEYONIX te responderá por este mismo chat."
                    : `Producto afectado: ${affectedProductLabel}. BEYONIX revisará el caso y te responderá acá.`}
              </p>
            )}
          </div>
          {closedHelp ? (
            <div className="flex w-fit shrink-0 items-center gap-3 rounded-xl border border-emerald-200/55 bg-emerald-300/18 px-4 py-3 shadow-[0_0_0_1px_rgba(167,243,208,0.16),0_12px_28px_rgba(16,185,129,0.12)]">
              <span className="flex size-9 items-center justify-center rounded-full border border-emerald-100/45 bg-emerald-200/20">
                <Check className="size-5 text-emerald-50" />
              </span>
              <div>
                <p className="text-sm font-black leading-none text-emerald-50">Consulta resuelta</p>
                <p className="mt-1 text-xs font-bold leading-none text-emerald-50/78">Finalizado</p>
              </div>
            </div>
          ) : (
            <span className={`inline-flex w-fit shrink-0 items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-black text-white ${info.style}`}>
              <span className={`size-2 rounded-full ${info.dot}`} />
              {info.label}
            </span>
          )}
        </header>

        {claim.rejection_reason && (
          <div className="border-b border-white/8 bg-red-500/8 px-3.5 py-3">
            <p className="text-xs font-black text-red-100">Reclamo rechazado</p>
            <p className="mt-1 text-xs leading-5 text-white/75">{claim.rejection_reason}</p>
          </div>
        )}

        {closedHelp && !claim.rejection_reason && (
          <div className="border-b border-[#77E6E2]/20 bg-[#071C20] px-3.5 py-3">
            <div className="flex items-start gap-2.5">
              <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border border-[#77E6E2]/25 bg-[#77E6E2]/10">
                <Check className="size-3.5 text-[#D7FFFD]" />
              </span>
              <div className="min-w-0">
                <p className="text-xs font-black text-[#D7FFFD]">Consulta finalizada</p>
                <p className="mt-1 text-xs font-semibold leading-5 text-white/80">
                  La conversación de ayuda fue finalizada.
                </p>
              </div>
            </div>
          </div>
        )}

        {resolutionSummary && !helpMessage && !claim.rejection_reason && (
          <div className="border-b border-[#77E6E2]/20 bg-[#071C20] px-3.5 py-3">
            <div className="flex items-start gap-2.5">
              <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border border-[#77E6E2]/25 bg-[#77E6E2]/10">
                <Check className="size-3.5 text-[#D7FFFD]" />
              </span>
              <div className="min-w-0">
                <p className="text-xs font-black text-[#D7FFFD]">{resolutionSummary.title}</p>
                <p className="mt-1 text-xs font-semibold leading-5 text-white/80">{resolutionSummary.body}</p>
              </div>
            </div>
          </div>
        )}

        <div ref={chatRef} className="customer-claim-chat-thread min-h-[22rem] max-h-[34rem] space-y-4 overflow-y-auto bg-[#070C12] px-5 py-5">
          {visibleMessages.map((message) => {
            const customer = message.author_role === "cliente"
            return (
              <div key={message.id} className={`flex ${customer ? "justify-end" : "justify-start"}`}>
                <div className={`customer-claim-chat-message max-w-[86%] rounded-2xl px-4 py-3 shadow-[0_12px_30px_rgba(0,0,0,0.22)] sm:max-w-[72%] ${customer ? "rounded-br-md border border-[#2C6CA3]/35 bg-[#112A43]" : "rounded-bl-md border border-white/9 bg-[#101820]"}`}>
                  <p className="customer-claim-chat-author text-[11px] font-black uppercase tracking-wide text-blue-200/80">{customer ? "Tu mensaje" : "BEYONIX"}</p>
                  <p className="customer-claim-chat-message-body mt-1.5 whitespace-pre-wrap text-[15px] font-semibold leading-6 text-white">
                    <CustomerClaimMessageBody message={message.message} />
                  </p>
                  <p className="customer-claim-chat-timestamp mt-2 text-[11px] font-semibold text-white/42">{formatDate(message.created_at)}</p>
                </div>
              </div>
            )
          })}
          {visibleMessages.length === 0 && (
            <p className="rounded-xl border border-white/8 bg-[#101820] px-4 py-3 text-sm font-semibold text-white/65">
              La conversación todavía no tiene mensajes.
            </p>
          )}
        </div>

        <div className="customer-claim-chat-composer border-t border-[#18334D] bg-[#0B1724] px-5 py-4">
          {evidenceSent && (
            <details className="mb-2 rounded-lg border border-white/8 bg-[#101820] px-3 py-2">
              <summary className="cursor-pointer text-xs font-black text-blue-200">
                Evidencia enviada ({evidenceFiles.length})
              </summary>
              <div className="mt-2.5 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                {evidenceFiles.map((file) => <FilePreview key={file.id} file={file} />)}
              </div>
            </details>
          )}

          {claim.coupon_code && (
            <div className="mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-[#77E6E2]/20 bg-[#77E6E2]/5 px-3 py-2">
              <span className="text-xs font-bold text-[#D7FFFD]">Nota de crédito:</span>
              <code className="rounded-md border border-white/10 bg-black/30 px-2 py-1 text-xs font-black text-white">{claim.coupon_code}</code>
              <button type="button" onClick={() => void navigator.clipboard?.writeText(claim.coupon_code ?? "")} className="h-7 rounded-md border border-blue-300/20 px-2 text-10px font-black text-blue-200 hover:border-blue-300/45">
                Copiar
              </button>
            </div>
          )}

          {error && <p className="mb-2 rounded-lg border border-red-300/20 bg-red-500/10 px-3 py-2 text-xs font-bold text-red-200">{error}</p>}

          {open ? (
            <div className="space-y-2">
              {refundPending && !refundDetailsSubmitted ? (
                <div className="rounded-lg border border-[#77E6E2]/20 bg-[#77E6E2]/5 p-3">
                  <p className="text-xs font-black text-white">Datos para el reintegro</p>
                  <p className="mt-1 text-xs leading-5 text-white/65">Completalos para que podamos avanzar.</p>
                  <div className="mt-3 grid gap-2 sm:grid-cols-2">
                    <input value={refundAccountHolder} onChange={(event) => setRefundAccountHolder(event.target.value)} placeholder="Titular de la cuenta" className="h-9 rounded-lg border border-white/10 bg-[#101820] px-3 text-xs text-white outline-none placeholder:text-white/40 focus:border-[#77E6E2]/45" />
                    <input value={refundAccountIdentifier} onChange={(event) => setRefundAccountIdentifier(event.target.value)} placeholder="Alias o CBU/CVU" className="h-9 rounded-lg border border-white/10 bg-[#101820] px-3 text-xs text-white outline-none placeholder:text-white/40 focus:border-[#77E6E2]/45" />
                    <input value={refundBank} onChange={(event) => setRefundBank(event.target.value)} placeholder="Banco / billetera" className="h-9 rounded-lg border border-white/10 bg-[#101820] px-3 text-xs text-white outline-none placeholder:text-white/40 focus:border-[#77E6E2]/45" />
                    <input value={refundAmountConfirmed} onChange={(event) => setRefundAmountConfirmed(event.target.value)} placeholder="Importe a recibir" className="h-9 rounded-lg border border-white/10 bg-[#101820] px-3 text-xs text-white outline-none placeholder:text-white/40 focus:border-[#77E6E2]/45" />
                  </div>
                  <button type="button" disabled={loading} onClick={() => void submitRefundDetails(claim)} className="mt-3 h-9 rounded-lg bg-[#112A43] px-4 text-xs font-black text-white disabled:cursor-not-allowed disabled:opacity-45">
                    Enviar datos
                  </button>
                </div>
              ) : refundPending ? (
                <p className="rounded-lg border border-[#77E6E2]/20 bg-[#77E6E2]/5 px-3 py-2 text-xs font-bold text-[#D7FFFD]">
                  Datos recibidos. BEYONIX realizará el reintegro.
                </p>
              ) : customerTurnLocked ? (
                <p className="rounded-xl border border-emerald-400/30 bg-emerald-500/10 px-4 py-2.5 text-sm font-bold text-emerald-200">
                  Mensaje enviado con éxito!
                </p>
              ) : (
                <div className="flex flex-col gap-2 sm:flex-row">
                  <textarea
                    value={reply}
                    disabled={loading}
                    onChange={(event) => setReply(event.target.value)}
                    rows={2}
                    placeholder="Escribí tu mensaje"
                    className="min-h-12 flex-1 resize-none rounded-xl border border-[#21476B] bg-[#101820] px-3.5 py-2.5 text-sm leading-5 text-white outline-none placeholder:text-white/40 focus:border-blue-300/50 disabled:cursor-not-allowed disabled:opacity-45"
                  />
                  <button type="button" disabled={loading} onClick={() => void sendReply(claim)} className="inline-flex h-12 shrink-0 items-center justify-center gap-2 rounded-xl border border-beyonix-blue-light/35 bg-[#112A43] px-5 text-sm font-black text-white transition hover:border-beyonix-blue-light/65 hover:bg-[#183B5E] disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-[#112A43]">
                    <Send className="size-3.5" />
                    {loading ? "Enviando..." : "Enviar"}
                  </button>
                </div>
              )}
              {canUploadEvidence && (
                <details className="rounded-lg border border-white/8 bg-[#101820] px-3 py-2">
                  <summary className="cursor-pointer text-xs font-black text-white/70">Adjuntar evidencia</summary>
                  <div className="mt-2">
                    <EvidenceUploader files={replyFiles} onChange={setReplyFiles} disabled={loading} />
                    {(customerTurnLocked || refundPending) && (
                      <button
                        type="button"
                        disabled={loading || replyFiles.length === 0}
                        onClick={() => void sendReply(claim)}
                        className="mt-2 inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-beyonix-blue-light/35 bg-[#112A43] px-4 text-xs font-black text-white transition hover:border-beyonix-blue-light/65 hover:bg-[#183B5E] disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-[#112A43]"
                      >
                        <Send className="size-3.5" />
                        {loading ? "Enviando..." : "Enviar archivos"}
                      </button>
                    )}
                  </div>
                </details>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              {closedHelp ? (
                <div className="rounded-lg border border-[#77E6E2]/20 bg-[#77E6E2]/5 px-3 py-3">
                  <p className="text-xs font-black text-[#D7FFFD]">Chat de ayuda finalizado</p>
                  <p className="mt-1 text-xs font-semibold leading-5 text-white/70">
                    Si surge otra consulta previa a la entrega, escribinos por mail.
                  </p>
                  <a
                    href={SUPPORT_EMAIL_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-2 inline-flex h-8 items-center rounded-lg border border-blue-300/25 bg-[#112A43] px-3 text-xs font-black text-white hover:border-blue-300/55 hover:bg-[#183B5E]"
                  >
                    {SUPPORT_EMAIL}
                  </a>
                </div>
              ) : cancellation ? (
                <p className="rounded-lg border border-blue-300/15 bg-[#112A43]/25 px-3 py-2 text-xs font-bold text-blue-100">
                  La compra figura como cancelada.
                </p>
              ) : (
                <div className="rounded-lg border border-[#77E6E2]/20 bg-[#77E6E2]/5 px-3 py-3">
                  <p className="text-xs font-black text-[#D7FFFD]">Reclamo finalizado</p>
                  <p className="mt-1 text-xs font-semibold leading-5 text-white/70">
                    Este pedido ya tuvo un reclamo finalizado. Podés consultar la conversación cuando quieras. Si necesitás contactarnos por otro motivo, escribinos por mail.
                  </p>
                  <a
                    href={SUPPORT_EMAIL_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-2 inline-flex h-8 items-center rounded-lg border border-blue-300/25 bg-[#112A43] px-3 text-xs font-black text-white hover:border-blue-300/55 hover:bg-[#183B5E]"
                  >
                    {SUPPORT_EMAIL}
                  </a>
                </div>
              )}
              {refundProof?.signedUrl && (
                <a href={refundProof.signedUrl} target="_blank" rel="noreferrer" className="inline-flex h-9 items-center gap-2 rounded-lg border border-[#77E6E2]/25 bg-[#77E6E2]/5 px-3 text-xs font-black text-white hover:border-[#77E6E2]/45">
                  <FileText className="size-3.5 text-[#77E6E2]" />
                  Ver comprobante de devolución
                </a>
              )}
            </div>
          )}
        </div>
      </section>
    )
  }

  return (
    <section ref={shellRef} className="customer-claim-experience">
      {cancellationSuccess && (
        <div className="mt-3 flex flex-col gap-3 rounded-xl border border-emerald-400/22 bg-emerald-500/10 px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2.5">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-full border border-emerald-300/35 bg-emerald-400/15">
              <CircleCheck className="size-4 text-emerald-300" />
            </span>
            <p className="text-sm font-black text-emerald-100">
              Tu compra fue cancelada correctamente.
            </p>
          </div>
          <button
            type="button"
            onClick={goToOrders}
            className="inline-flex h-9 shrink-0 items-center justify-center rounded-lg border border-emerald-300/25 bg-emerald-400/10 px-4 text-xs font-black text-emerald-100 transition hover:border-emerald-300/45 hover:bg-emerald-400/15"
          >
            Volver a Mis compras
          </button>
        </div>
      )}

      {!canCancel && !canCreatePostDeliveryClaim && !canCreateHelpMessage && !cancelled && (
        <div className="rounded-xl border border-white/9 bg-[#141820] p-3">
          <div className="flex gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[#112A43]">
              <Truck className="size-5 text-blue-300" />
            </span>
            <div>
              <h4 className="text-sm font-black text-white">
                Reclamo no disponible todavía
              </h4>
              <p className="mt-1 text-xs leading-5 text-white/65">
                Cuando recibas tu compra, si hay algún problema, vas a poder reclamar desde esta sección.
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

      {canCreateHelpMessage && (
        <div className="customer-help-create-panel mt-3 rounded-xl border border-white/9 bg-[#141820] p-4 sm:p-5">
          <div className="flex items-start gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[#112A43]">
              <MessageCircle className="size-5 text-white" />
            </span>
            <div>
              <h4 className="text-sm font-black text-white">Enviar mensaje de ayuda</h4>
              <p className="mt-1 text-xs leading-5 text-white/65">
                Usá este chat si necesitás consultar el estado del pedido, si el envío se demora o si querés avisarnos algo antes de la entrega.
              </p>
            </div>
          </div>

          <div className="customer-help-form-panel mt-4 rounded-xl border border-[#18334D] bg-[#101923] p-4 sm:p-5">
            <div>
              <h4 className="border-l-4 border-[#2C6CA3] py-0.5 pl-3 text-base font-bold leading-5 text-white">Contanos qué necesitás</h4>
              <p className="mt-1.5 pl-4 text-xs font-medium leading-5 text-[#9EB4C8]">
                Tu mensaje llegará al equipo de BEYONIX y vas a poder seguir la respuesta desde esta misma sección.
              </p>
              <div className="mt-3">
                <textarea
                  value={description}
                  onChange={(event) => {
                    setDescription(event.target.value)
                    setError("")
                  }}
                  rows={4}
                  minLength={CLAIM_DESCRIPTION_MIN_LENGTH}
                  maxLength={CLAIM_DESCRIPTION_MAX_LENGTH}
                  placeholder="Ejemplo: mi pedido figura enviado, pero todavía no llegó y necesito ayuda con el seguimiento..."
                  className="customer-help-textarea w-full resize-none rounded-xl border border-[#21476B] bg-[#2A313A] px-3 py-2.5 text-sm font-medium leading-6 text-white outline-none placeholder:text-[#A8B3BE] transition-all duration-200 hover:border-[#2B5D8A] hover:bg-[#333B46] focus:border-[#2C6CA3] focus:ring-2 focus:ring-[#2C6CA3]/20"
                />
                <p className="mt-1.5 pr-1 text-right text-10px text-white/40">{description.length}/{CLAIM_DESCRIPTION_MAX_LENGTH}</p>
              </div>
            </div>

            <div className="customer-help-footer mt-5 border-t border-[#18334D]/85 pt-5">
              <div className="customer-help-notices grid gap-2.5 lg:grid-cols-2">
                <div className="flex items-start gap-2.5 rounded-xl border border-[#21476B] bg-[#13263B] px-3 py-2.5 text-xs font-semibold leading-5 text-[#9EB4C8]">
                  <CircleCheck className="mt-0.5 size-4 shrink-0 text-[#9EB4C8]" />
                  <span>Este mensaje no inicia un reclamo formal. Es un canal de ayuda para resolver consultas antes de la entrega.</span>
                </div>
                <div className="flex items-start gap-2.5 rounded-xl border border-[#21476B] bg-[#13263B] px-3 py-2.5 text-xs font-semibold leading-5 text-[#9EB4C8]">
                  <Clock3 className="mt-0.5 size-4 shrink-0 text-white" />
                  <span>
                    Recordá que la validación de pagos por transferencia se realiza de {BEYONIX_SUPPORT_HOURS_DETAIL.toLocaleLowerCase("es-AR")}
                  </span>
                </div>
              </div>
              {error && <p className="mb-3 rounded-lg border border-red-300/20 bg-red-500/10 px-3 py-2 text-xs font-bold text-red-200">{error}</p>}
              <div className="customer-help-submit mt-4 flex justify-end">
                <button
                  type="button"
                  aria-label="Enviar mensaje de ayuda"
                  disabled={loading || description.trim().length < CLAIM_DESCRIPTION_MIN_LENGTH}
                  onClick={() => void createHelpMessage()}
                  className="h-10 w-full rounded-lg border border-beyonix-blue-light/42 bg-[#112A43] px-5 text-xs font-black text-white shadow-[0_0_14px_rgba(47,111,163,0.16)] transition-all duration-200 hover:border-beyonix-blue-light/70 hover:bg-[#183B5E] hover:shadow-[0_0_18px_rgba(47,111,163,0.22)] disabled:cursor-not-allowed disabled:border-white/10 disabled:bg-[#111820] disabled:text-white/45 disabled:shadow-none disabled:hover:border-white/10 disabled:hover:bg-[#111820] sm:w-auto"
                >
                  {loading ? "Enviando..." : "Enviar mensaje de ayuda"}
                </button>
              </div>
            </div>
          </div>

          {canCancel && (
            <div className="mt-3 max-w-xl rounded-lg border border-red-300/15 bg-red-500/[0.04] px-3 py-2.5">
              <h4 className="text-xs font-medium text-white">
                ¿Necesitás cancelar tu compra?
              </h4>
              <label
                htmlFor={`cancellation-reason-${order.id}`}
                className="mt-0.5 block text-11px font-normal text-white/55"
              >
                Contanos el motivo para habilitar la cancelación.
              </label>
              <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                <input
                  id={`cancellation-reason-${order.id}`}
                  type="text"
                  value={cancellationReason}
                  onChange={(event) => {
                    setCancellationReason(event.target.value)
                    setCancellationError("")
                  }}
                  minLength={CANCELLATION_REASON_MIN_LENGTH}
                  maxLength={CANCELLATION_REASON_MAX_LENGTH}
                  placeholder="Motivo de la cancelación..."
                  className="h-8 min-w-0 flex-1 rounded-md border border-white/12 bg-[#0D1117] px-2.5 text-xs font-normal text-white outline-none placeholder:text-white/35 transition-colors hover:border-red-300/25 focus:border-red-300/45 focus:ring-2 focus:ring-red-400/10"
                />
                <button
                  type="button"
                  aria-label="Cancelar compra"
                  disabled={
                    cancellingOrder ||
                    cancellationReason.trim().length < CANCELLATION_REASON_MIN_LENGTH
                  }
                  onClick={() => void cancelOrder()}
                  className="inline-flex h-8 shrink-0 cursor-pointer items-center justify-center rounded-md border border-red-300/30 bg-red-500/10 px-3 text-11px font-normal text-red-100 transition-colors hover:border-red-300/50 hover:bg-red-500/15 disabled:cursor-not-allowed disabled:border-white/10 disabled:bg-[#111820] disabled:text-white/35"
                >
                  {cancellingOrder ? "Cancelando..." : "Cancelar compra"}
                </button>
              </div>
              {cancellationError && (
                <p className="mt-2 text-11px font-normal text-red-200">
                  {cancellationError}
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {canCreatePostDeliveryClaim && (
        <div className="customer-claim-create-form mt-3 space-y-3.5 [&_svg]:text-white">
          <div className="customer-claim-create-header flex items-center gap-3 border-l-2 border-[#5CA9E6]/70 px-3 py-1.5">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-full border border-[#5CA9E6]/30 bg-[#101923]">
              <MessageCircle className="size-4.5 text-white" />
            </span>
            <div className="min-w-0">
              <h1 className="text-xl font-black leading-6 tracking-tight text-white">
                Iniciar reclamo
              </h1>
              <p className="mt-0.5 max-w-3xl text-[13px] leading-5 text-[#A9BACB]">
                Contanos qué problema tuvo el producto recibido. BEYONIX revisará el caso.
              </p>
            </div>
          </div>

          <div className="customer-claim-step-panel rounded-xl border border-[#2A3037]/80 bg-[#080A0D] p-3.5 sm:p-4">
            <div className="flex items-center gap-2.5">
              <span className="flex size-7 shrink-0 items-center justify-center rounded-full border border-[#5CA9E6]/35 bg-[#112A43] text-[11px] font-black text-white">
                1
              </span>
              <div>
                <h2 className="text-base font-black text-white">Producto afectado</h2>
              </div>
            </div>

            <div className="mt-3 grid gap-3 md:grid-cols-2 lg:grid-cols-3">
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
                    className={`customer-claim-product-option relative flex min-h-[68px] min-w-0 items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-all duration-200 ${
                      selectedItem
                        ? "border-[#69B8F3]/70 bg-[#112A43]"
                        : "border-[#2A3A4B] bg-[#121B24] hover:border-[#5CA9E6]/50 hover:bg-[#16222D]"
                    }`}
                  >
                    {selectedItem && (
                      <span className="absolute right-2.5 top-2.5 flex size-5 items-center justify-center rounded-full border border-[#A9D9FA]/50 bg-[#2C6CA3]">
                        <Check className="size-3 text-white" />
                      </span>
                    )}
                    <span className={`flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-white/10 ${image ? "bg-white" : "bg-[#172635]"}`}>
                      {image ? <img src={image} alt={name} className="size-full object-contain" /> : <Package className="size-5 text-white" />}
                    </span>
                    <span className="min-w-0 pr-5">
                      <strong className="block truncate text-sm font-black leading-5 text-white">{name}</strong>
                      <span className="mt-0.5 block truncate text-xs leading-4 text-[#A9BACB]">{getItemVariant(item)} · Cantidad: {item.cantidad}</span>
                    </span>
                  </button>
                )
              })}
              {orderItems.length > 1 && (
                <button
                  type="button"
                  onClick={selectWholeOrder}
                  className={`customer-claim-product-option relative flex min-h-[68px] min-w-0 items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-all duration-200 ${
                    affectedItems.includes("order")
                      ? "border-[#69B8F3]/70 bg-[#112A43]"
                      : "border-[#2A3A4B] bg-[#121B24] hover:border-[#5CA9E6]/50 hover:bg-[#16222D]"
                  }`}
                >
                  {affectedItems.includes("order") && (
                    <span className="absolute right-2.5 top-2.5 flex size-5 items-center justify-center rounded-full border border-[#A9D9FA]/50 bg-[#2C6CA3]">
                      <Check className="size-3 text-white" />
                    </span>
                  )}
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-[#36516A] bg-[#172635]">
                    <Truck className="size-5 text-[#B9DEFA]" />
                  </span>
                  <span className="min-w-0 pr-5">
                    <strong className="block text-sm font-black leading-5 text-white">Todo el pedido</strong>
                    <span className="mt-0.5 block truncate text-xs leading-4 text-[#A9BACB]">Problema general</span>
                  </span>
                </button>
              )}
            </div>
          </div>

          <div className="customer-claim-step-panel rounded-xl border border-[#2A3037]/80 bg-[#080A0D] p-3.5 sm:p-4">
            <div className="flex items-center gap-2.5">
              <span className="flex size-7 shrink-0 items-center justify-center rounded-full border border-[#5CA9E6]/35 bg-[#112A43] text-[11px] font-black text-white">
                2
              </span>
              <div>
                <h2 className="text-base font-black text-white">Motivo del reclamo</h2>
              </div>
            </div>

            <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {POST_DELIVERY_PROBLEMS.map((item) => {
                const Icon = item.icon
                const selectedProblem = problem === item.id
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      setProblem(item.id)
                      setError("")
                    }}
                    className={`customer-claim-problem-option relative flex min-h-[72px] items-center gap-2 rounded-xl border px-2.5 py-2 text-left transition-all duration-200 ${
                      selectedProblem
                        ? "border-[#69B8F3]/70 bg-[#112A43]"
                        : "border-[#2A3A4B] bg-[#121B24] hover:border-[#5CA9E6]/50 hover:bg-[#16222D]"
                    }`}
                  >
                    {selectedProblem && (
                      <span className="absolute right-3 top-3 flex size-5 items-center justify-center rounded-full border border-[#A9D9FA]/50 bg-[#2C6CA3]">
                        <Check className="size-3 text-white" />
                      </span>
                    )}
                    <span className={`flex size-8 shrink-0 items-center justify-center rounded-lg border ${
                      selectedProblem
                        ? "border-[#5CA9E6]/45 bg-[#183B5E]"
                        : "border-white/8 bg-[#1B2530]"
                    }`}>
                      <Icon className="size-4 text-white" />
                    </span>
                    <span className="min-w-0 pr-6">
                      <strong className="block text-sm font-black leading-5 text-white">{item.title}</strong>
                      <span className="mt-0.5 block text-xs leading-4 text-[#A9BACB]">{item.description}</span>
                    </span>
                  </button>
                )
              })}
            </div>
          </div>

          <div className="customer-claim-step-panel rounded-xl border border-[#2A3037]/80 bg-[#080A0D] p-3.5 sm:p-4">
            <div className="flex items-center gap-2.5">
              <span className="flex size-7 shrink-0 items-center justify-center rounded-full border border-[#5CA9E6]/35 bg-[#112A43] text-[11px] font-black text-white">
                3
              </span>
              <div>
                <h2 className="text-base font-black text-white">Detalles y evidencia</h2>
              </div>
            </div>

            <div className="mt-3 grid gap-3 lg:grid-cols-2">
              <div className="customer-claim-details-column rounded-xl bg-[#111B25] p-3">
                <h3 className="text-sm font-black leading-5 text-white">Contanos qué pasó</h3>
                <p className="mt-0.5 text-xs font-medium leading-4 text-[#A9BACB]">
                  Describí el problema con el mayor detalle posible.
                </p>
                <div className="relative mt-2.5">
                  <textarea
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    rows={6}
                    minLength={CLAIM_DESCRIPTION_MIN_LENGTH}
                    maxLength={CLAIM_DESCRIPTION_MAX_LENGTH}
                    placeholder="Ejemplo: el producto enciende, pero se apaga después de unos segundos..."
                    className="customer-claim-description min-h-[140px] w-full resize-none rounded-xl border border-[#34485C] bg-[#151E28] px-3 pb-7 pt-2.5 text-sm font-medium leading-5 text-white outline-none placeholder:text-[#8FA1B2] transition-all duration-200 hover:border-[#4B6078] focus:border-[#5CA9E6] focus:ring-2 focus:ring-[#5CA9E6]/18"
                  />
                  <p className="pointer-events-none absolute bottom-2.5 right-3 text-[11px] font-semibold text-white/45">
                    {description.length}/{CLAIM_DESCRIPTION_MAX_LENGTH}
                  </p>
                </div>
              </div>

              <div className="customer-claim-details-column rounded-xl bg-[#111B25] p-3">
                <h3 className="text-sm font-black leading-5 text-white">Fotos o videos</h3>
                <p className="mt-0.5 text-xs font-medium leading-4 text-[#A9BACB]">
                  Podés adjuntar evidencia para ayudarnos a revisar el caso.
                </p>
                <div className="mt-2.5">
                  <EvidenceUploader files={files} onChange={setFiles} disabled={loading} surface="neutral" />
                </div>
              </div>
            </div>

            <div className="customer-claim-submit-row mt-3 border-t border-[#294157]/65 pt-3">
              {error && <p className="mb-3 rounded-lg border border-red-300/20 bg-red-500/10 px-3 py-2 text-xs font-bold text-red-200">{error}</p>}
              <div className="flex justify-center">
                <button
                  type="button"
                  aria-label="Enviar reclamo"
                  disabled={loading || description.trim().length < CLAIM_DESCRIPTION_MIN_LENGTH}
                  onClick={() => void createClaim()}
                  className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg border border-beyonix-blue-light/42 bg-[#112A43] px-6 text-sm font-black text-white transition-all duration-200 hover:border-beyonix-blue-light/70 hover:bg-[#183B5E] active:bg-[#0E2338] disabled:cursor-not-allowed disabled:border-white/10 disabled:bg-[#111820] disabled:text-white/45 sm:w-auto"
                >
                  <Send className="size-4" />
                  {loading ? "Enviando..." : "Enviar reclamo"}
                </button>
              </div>
            </div>
          </div>

        </div>
      )}

      {cancelled && (
        <div className="mt-3 rounded-xl border border-white/9 bg-[#141820] p-3 text-xs font-semibold leading-5 text-white/65">
          La compra figura como cancelada. Si necesitás consultar algo sobre esta orden, contactá a BEYONIX por los canales de atención.
        </div>
      )}

      {error && !canCreatePostDeliveryClaim && !canCreateHelpMessage && <p className="mt-3 rounded-lg border border-red-300/20 bg-red-500/10 px-3 py-2 text-xs font-bold text-red-200">{error}</p>}
    </section>
  )
}
