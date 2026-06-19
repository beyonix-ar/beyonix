"use client"
// @refresh reset

import { useCallback, useEffect, useRef, useState } from "react"
import type { InputHTMLAttributes } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import {
  Bell,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Camera,
  CreditCard,
  Download,
  Eye,
  EyeOff,
  ExternalLink,
  FileText,
  Hash,
  Lock,
  LogOut,
  Mail,
  MapPin,
  MessageCircle,
  Package,
  Paperclip,
  Phone,
  Send,
  Shield,
  ShoppingBag,
  Star,
  Truck,
  User,
} from "lucide-react"

import { useAuth } from "@/context/auth-context"
import { PaymentProofActionButton } from "@/components/payment-proof-uploader"
import { CustomerClaimExperience } from "@/components/claims/customer-claim-experience"
import type { ClaimProblemId } from "@/components/claims/customer-claim-experience"
import { PasswordRequirements } from "@/components/password-requirements"
import { ProvinceSelect } from "@/components/province-select"
import { supabase } from "@/lib/supabase/client"
import {
  getClaimDeadline,
  getClaimFileValidationError,
  getOrderClaimResolutionLabel,
  getOrderClaimStatusLabel,
  getOrderClaimTypeLabel,
  isClaimWindowOpen,
} from "@/lib/order-claims"
import type {
  OrderClaimType,
  SupabaseOrderClaim,
  SupabaseOrderClaimFile,
  SupabaseOrderClaimMessage,
  SupabasePedido,
} from "@/lib/supabase/types"
import {
  FIELD_LIMITS,
  meetsPasswordRequirements,
  onlyDigits,
  validatePassword,
  validateProfilePayload,
  validateRegisterPayload,
} from "@/lib/validation/account-fields"

function formatCuentaPrice(price: number) {
  return price.toLocaleString("es-AR", {
    style: "currency",
    currency: "ARS",
    minimumFractionDigits: 0,
  })
}

function formatCuentaOrderDate(value: string) {
  return new Intl.DateTimeFormat("es-AR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "America/Argentina/Buenos_Aires",
  }).format(new Date(value))
}

function formatPublicOrderId(id: number) {
  return `BX-${1000 + id}`
}

function formatCuentaInvoiceNumber(
  point?: number | null,
  number?: number | null,
) {
  return `${String(point ?? 0).padStart(4, "0")}-${String(number ?? 0).padStart(8, "0")}`
}

function formatOrderCardDate(value: string) {
  const parts = new Intl.DateTimeFormat("es-AR", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "America/Argentina/Buenos_Aires",
  }).formatToParts(new Date(value))
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? ""
  return `${part("day")}/${part("month")}/${part("year")} · ${part("hour")}:${part("minute")}`
}

function isInvoiceAvailable(order: SupabasePedido) {
  return order.invoice_status === "authorized"
}

const DOWNLOADED_INVOICES_STORAGE_KEY = "beyonix:downloaded-invoices"

function CustomerInvoiceBell() {
  return (
    <span
      title="Tu factura ya está disponible"
      className="inline-flex size-5 items-center justify-center rounded-full border border-red-300/45 bg-red-500 text-white shadow-lg shadow-red-950/35"
    >
      <Bell className="size-3" />
    </span>
  )
}

function getClientOrderStatusBadge(order: SupabasePedido) {
  const status = order.estado.toLowerCase()
  const paymentStatus = order.payment_status ?? ""

  if (paymentStatus === "rechazado") {
    return {
      label: "Comprobante inválido",
      className: "border-red-400/35 bg-red-400/12 text-red-200",
    }
  }

  if (
    paymentStatus === "confirmado" ||
    paymentStatus === "approved" ||
    status === "pagado"
  ) {
    return {
      label: "Pago confirmado",
      className: "border-emerald-400/35 bg-emerald-400/12 text-emerald-200",
    }
  }

  if (status === "enviado") {
    return {
      label: "Despachado",
      className: "border-beyonix-blue-light/35 bg-beyonix-blue/35 text-beyonix-sky",
    }
  }

  if (status === "en_camino") {
    return {
      label: "En camino",
      className: "border-beyonix-blue-light/35 bg-beyonix-blue/35 text-beyonix-sky",
    }
  }

  if (status === "entregado") {
    return {
      label: "Entregado",
      className: "border-emerald-400/35 bg-emerald-400/12 text-emerald-200",
    }
  }

  if (status === "cancelado") {
    return {
      label: "Cancelado/Rechazado",
      className: "border-red-400/35 bg-red-400/12 text-red-200",
    }
  }

  return {
    label: "Pendiente de confirmación",
    className: "border-amber-300/35 bg-amber-400/12 text-amber-200",
  }
}

function getCuentaItemColor(item: NonNullable<SupabasePedido["orden_items"]>[number]) {
  const itemColor = item as typeof item & {
    color?: string | null
    color_nombre?: string | null
  }

  return (
    item.producto_variantes?.nombre ||
    itemColor.color_nombre ||
    itemColor.color ||
    "Sin color"
  )
}

function getCuentaItemImage(item: NonNullable<SupabasePedido["orden_items"]>[number]) {
  return (
    item.producto_variantes?.imagenes?.[0] ||
    item.productos?.imagen_principal ||
    item.productos?.imagenes_producto?.[0]?.url ||
    ""
  )
}

type OrderProgressTone = "done" | "current" | "pending" | "danger" | "warning"

interface OrderProgressStep {
  label: string
  detail: string
  tone: OrderProgressTone
}

function getPaymentProgressLabel(order: SupabasePedido) {
  const paymentStatus = order.payment_status ?? ""

  if (order.payment_method_id !== "transferencia") {
    if (paymentStatus === "approved" || order.estado === "pagado") {
      return "Pago aprobado"
    }

    return "Esperando confirmación del pago"
  }

  if (paymentStatus === "confirmado" || order.estado === "pagado") {
    return "Transferencia confirmada"
  }

  if (paymentStatus === "en_revision") {
    return "Comprobante pendiente"
  }

  if (paymentStatus === "rechazado") {
    return "Comprobante inválido"
  }

  return "Comprobante pendiente"
}

function isAndreaniOrderInTransit(order: SupabasePedido) {
  const andreaniStatus = (order.andreani_estado ?? "").toLowerCase()

  return [
    "camino",
    "tránsito",
    "transito",
    "distribución",
    "distribucion",
    "reparto",
    "visita",
  ].some((status) => andreaniStatus.includes(status))
}

function getOrderProgressSteps(order: SupabasePedido): OrderProgressStep[] {
  const estado = order.estado.toLowerCase()
  const paymentStatus = order.payment_status ?? ""
  const isCanceled = estado === "cancelado"
  const isRejected = paymentStatus === "rechazado"
  const isPaid =
    estado === "pagado" ||
    estado === "enviado" ||
    estado === "en_camino" ||
    estado === "entregado" ||
    paymentStatus === "confirmado" ||
    paymentStatus === "approved"
  const isDispatched =
    estado === "enviado" ||
    estado === "en_camino" ||
    estado === "entregado" ||
    Boolean(order.tracking_number || order.andreani_tracking)
  const isDelivered = estado === "entregado"
  const isInTransit = estado === "en_camino" || isDelivered || isAndreaniOrderInTransit(order)
  if (isCanceled) {
    return [
      {
        label: "Pedido registrado",
        detail: formatCuentaOrderDate(order.created_at),
        tone: "done",
      },
      {
        label: "Pedido cancelado",
        detail: "La compra fue cancelada.",
        tone: "danger",
      },
    ]
  }

  if (isRejected) {
    return [
      {
        label: "Pedido registrado",
        detail: formatCuentaOrderDate(order.created_at),
        tone: "done",
      },
      {
        label: "Comprobante inválido",
        detail: "Pago no recibido. Podés subir un nuevo comprobante.",
        tone: "danger",
      },
    ]
  }

  return [
    {
      label: "Pedido registrado",
      detail: formatCuentaOrderDate(order.created_at),
      tone: "done",
    },
    {
      label: getPaymentProgressLabel(order),
      detail: isPaid
        ? "El pago ya fue confirmado."
        : "Te avisaremos cuando se haya aprobado.",
      tone: isPaid ? "done" : "warning",
    },
    {
      label: "Preparación",
      detail: isPaid
        ? "Estamos preparando tu pedido."
        : "Este paso empieza cuando se confirme el pago.",
      tone: isPaid ? (isDispatched ? "done" : "current") : "pending",
    },
    {
      label: "Despacho",
      detail: isDispatched
        ? "Tu pedido ya fue despachado."
        : "Te avisaremos cuando salga.",
      tone: isDispatched ? "done" : "pending",
    },
    {
      label: "En camino",
      detail: isInTransit
        ? "Andreani está llevando el pedido al domicilio indicado."
        : "Este paso se activa cuando Andreani inicia el transporte.",
      tone: isInTransit ? (isDelivered ? "done" : "current") : "pending",
    },
    {
      label: "Entregado",
      detail: isDelivered
        ? "El pedido figura como entregado."
        : "Último paso del recorrido.",
      tone: isDelivered ? "done" : "pending",
    },
  ]
}

function OrderProgressTimeline({ order }: { order: SupabasePedido }) {
  const steps = getOrderProgressSteps(order)
  const toneClassNames: Record<OrderProgressTone, string> = {
    done: "border-emerald-400/35 bg-emerald-400/12 text-emerald-200",
    current: "border-beyonix-blue-light/35 bg-beyonix-blue/35 text-beyonix-sky",
    pending: "border-white/10 bg-white/5 text-white/45",
    danger: "border-red-400/35 bg-red-400/12 text-red-200",
    warning: "border-amber-300/35 bg-amber-400/12 text-amber-200",
  }
  const gridClassName =
    steps.length >= 6
      ? "md:grid-cols-6"
      : steps.length === 2
        ? "md:grid-cols-2"
        : "md:grid-cols-5"

  return (
    <div className="mb-4 rounded-xl border border-white/8 bg-black/25 p-3">
      <p className="mb-3 text-11px font-black uppercase tracking-widest text-white/45">
        Estado del pedido
      </p>
      <div className={"grid gap-2 " + gridClassName}>
        {steps.map((step, index) => (
          <div
            key={step.label + "-" + index}
            className={"relative rounded-lg border p-3 " + toneClassNames[step.tone]}
          >
            <span className="mb-2 flex size-6 items-center justify-center rounded-full border border-current text-11px font-black">
              {step.tone === "done" ? <Check className="size-3.5" /> : index + 1}
            </span>
            <p className="text-xs font-black text-white">{step.label}</p>
            <p className="mt-1 text-11px leading-4 text-white/52">
              {step.detail}
            </p>
          </div>
        ))}
      </div>
    </div>
  )
}

function normalizeTrackingUrl(value?: string | null) {
  const trimmed = value?.trim()
  if (!trimmed) return ""

  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
}

function OrderTrackingPanel({ order }: { order: SupabasePedido }) {
  const trackingNumber = order.andreani_tracking || order.tracking_number || ""
  const trackingUrl = normalizeTrackingUrl(order.tracking_url)

  if (!trackingNumber && !trackingUrl) return null

  return (
    <div className="mb-4 rounded-xl border border-beyonix-blue-light/20 bg-beyonix-blue/12 p-3">
      <p className="text-11px font-black uppercase tracking-widest text-beyonix-cyan">
        Seguimiento del envío
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-stretch">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-white/45">
            Número de seguimiento
          </p>
          <p className="mt-1 break-all text-sm font-black text-white">
            {trackingNumber || "Pendiente"}
          </p>
        </div>
        {trackingUrl && (
          <a
            href={trackingUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-10 shrink-0 cursor-pointer self-center items-center justify-center rounded-lg border border-beyonix-blue-light/35 bg-beyonix-blue px-3 text-11px font-black uppercase tracking-wide text-beyonix-sky transition-colors hover:border-beyonix-blue-light hover:bg-beyonix-blue-hover"
          >
            Ver seguimiento
          </a>
        )}
      </div>
    </div>
  )
}

function formatClaimDeadline(value: Date) {
  return new Intl.DateTimeFormat("es-AR", {
    dateStyle: "short",
    timeZone: "America/Argentina/Buenos_Aires",
  }).format(value)
}

function formatClaimActivityDate(value: string) {
  return new Intl.DateTimeFormat("es-AR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "America/Argentina/Buenos_Aires",
  }).format(new Date(value))
}

function getClaimTitle(claim: SupabaseOrderClaim) {
  if (claim.claim_type === "transporte_48hs") return "Reclamo por entrega"
  if (claim.claim_type === "garantia_beyonix") return "Garantía del producto"
  return getOrderClaimTypeLabel(claim.claim_type)
}

function getClaimStatusBadge(status: SupabaseOrderClaim["status"]) {
  const styles: Record<SupabaseOrderClaim["status"], string> = {
    recibido: "border-sky-300/35 bg-[#112A43] text-white",
    en_revision: "border-amber-300/40 bg-amber-400/12 text-white",
    falta_informacion: "border-beyonix-blue-light/45 bg-[#112A43] text-white",
    aprobado: "border-emerald-300/35 bg-emerald-400/12 text-white",
    rechazado: "border-red-300/35 bg-red-500/12 text-white",
    cerrado: "border-emerald-300/35 bg-emerald-500/12 text-white",
  }

  return styles[status] ?? "border-white/10 bg-[#181818] text-white"
}

function getClaimStatusText(status: SupabaseOrderClaim["status"]) {
  if (status === "falta_informacion") return "Esperando respuesta del cliente"
  if (status === "aprobado" || status === "cerrado") return "Resuelto"
  return getOrderClaimStatusLabel(status)
}

function getClaimOrderProduct(order: SupabasePedido) {
  const items = order.orden_items ?? []

  if (!items.length) return "No informado"
  if (items.length === 1) {
    return items[0].productos?.nombre ?? `Producto #${items[0].producto_id}`
  }

  const firstName = items[0].productos?.nombre ?? `Producto #${items[0].producto_id}`
  return `${firstName} + ${items.length - 1} más`
}

function getClaimInitialFiles(claim: SupabaseOrderClaim) {
  const firstCustomerMessage = (claim.order_claim_messages ?? [])
    .filter((message) => message.author_role === "cliente")
    .sort(
      (a, b) =>
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    )[0]

  if (!firstCustomerMessage) return claim.order_claim_files ?? []

  return (claim.order_claim_files ?? []).filter(
    (file) =>
      new Date(file.created_at).getTime() <=
      new Date(firstCustomerMessage.created_at).getTime() + 60_000,
  )
}

function getReplyFilesList(files: Record<string, File[]>) {
  return Object.values(files).flat()
}

function ClaimAttachmentChip({
  file,
}: {
  file: SupabaseOrderClaimFile
}) {
  const isImage = file.mime_type?.startsWith("image/")
  const isVideo = file.mime_type?.startsWith("video/")

  return (
    <a
      href={file.signedUrl ?? undefined}
      target="_blank"
      rel="noreferrer"
      title={file.file_name}
      className="group inline-flex max-w-full items-center gap-2 rounded-xl border border-beyonix-blue-light/25 bg-black px-2.5 py-2 text-xs font-bold text-white transition-colors hover:border-beyonix-blue-light hover:bg-[#112A43]"
    >
      {isImage && file.signedUrl ? (
        <span
          className="size-8 shrink-0 rounded-lg border border-white/10 bg-cover bg-center"
          style={{ backgroundImage: `url(${file.signedUrl})` }}
        />
      ) : isVideo ? (
        <Camera className="size-4 shrink-0 text-beyonix-sky" />
      ) : (
        <FileText className="size-4 shrink-0 text-beyonix-sky" />
      )}
      <span className="min-w-0 truncate">{file.file_name}</span>
      <Download className="size-3.5 shrink-0 text-white/70 group-hover:text-white" />
    </a>
  )
}

function ClaimFilePicker({
  label,
  role,
  accept,
  required,
  onFiles,
}: {
  label: string
  role: string
  accept: string
  required?: boolean
  onFiles: (role: string, files: File[]) => void | Promise<void>
}) {
  return (
    <label className="inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-xl border border-beyonix-blue-light/35 bg-[#181818] px-3 text-xs font-black uppercase tracking-wide text-white transition-colors hover:border-beyonix-blue-light hover:bg-[#112A43]">
      <Paperclip className="size-4 text-beyonix-sky" />
      {label}
      {required ? "*" : ""}
      <input
        type="file"
        accept={accept}
        multiple={!accept.includes("video")}
        onChange={(event) =>
          onFiles(role, Array.from(event.target.files ?? []))
        }
        className="sr-only"
      />
    </label>
  )
}

function ClaimFileInput({
  label,
  role,
  accept,
  required,
  onFiles,
}: {
  label: string
  role: string
  accept: string
  required?: boolean
  onFiles: (role: string, files: File[]) => void | Promise<void>
}) {
  return (
    <label className="block rounded-xl border border-white/8 bg-[#111111] p-3 transition-colors hover:bg-[#141414]">
      <span className="text-10px font-black uppercase tracking-widest text-white/45">
        {label} {required ? "*" : ""}
      </span>
      <input
        type="file"
        accept={accept}
        multiple={!accept.includes("video")}
        onChange={(event) =>
          onFiles(role, Array.from(event.target.files ?? []))
        }
        className="mt-2 block w-full cursor-pointer text-xs font-semibold text-white/65 file:mr-3 file:cursor-pointer file:rounded-lg file:border-0 file:bg-beyonix-blue file:px-3 file:py-2 file:text-xs file:font-black file:uppercase file:tracking-wide file:text-beyonix-sky"
      />
    </label>
  )
}

function ClaimHeaderCard({
  claim,
  order,
  deliveredAt,
}: {
  claim: SupabaseOrderClaim
  order: SupabasePedido
  deliveredAt: string
}) {
  const isTransportClaim = claim.claim_type === "transporte_48hs"

  return (
    <div className="rounded-2xl border border-white/8 bg-[#141414] p-4">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
        <div className="min-w-0">
          <p className="text-11px font-black uppercase tracking-widest text-beyonix-cyan">
            Centro de reclamos
          </p>
          <h3 className="mt-2 text-2xl font-black text-white">
            {getClaimTitle(claim)}
          </h3>
          <div className="mt-3 flex flex-wrap gap-2">
            <span className={`rounded-full border px-3 py-1 text-10px font-black uppercase tracking-wide ${getClaimStatusBadge(claim.status)}`}>
              {getClaimStatusText(claim.status)}
            </span>
            <span className="rounded-full border border-beyonix-blue-light/25 bg-[#181818] px-3 py-1 text-10px font-black uppercase tracking-wide text-white">
              Reclamo #{claim.id}
            </span>
            <span className="rounded-full border border-white/8 bg-[#181818] px-3 py-1 text-10px font-black uppercase tracking-wide text-white">
              Pedido #{formatPublicOrderId(order.id)}
            </span>
          </div>
        </div>
        <div className="grid gap-2 text-sm font-bold text-white sm:grid-cols-2 xl:min-w-[25rem]">
          <div className="rounded-xl border border-white/8 bg-[#181818] p-3">
            <p className="text-10px font-black uppercase tracking-widest text-white/55">
              Producto
            </p>
            <p className="mt-1 truncate text-white" title={getClaimOrderProduct(order)}>
              {getClaimOrderProduct(order)}
            </p>
          </div>
          <div className="rounded-xl border border-white/8 bg-[#181818] p-3">
            <p className="text-10px font-black uppercase tracking-widest text-white/55">
              Tiempo estimado
            </p>
            <p className="mt-1 text-white">
              {isTransportClaim
                ? "Respuesta antes de 48hs hábiles"
                : `Garantía hasta ${formatClaimDeadline(
                    getClaimDeadline(deliveredAt, "garantia_beyonix"),
                  )}`}
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}

function ClaimSummaryCard({
  claim,
}: {
  claim: SupabaseOrderClaim
}) {
  const initialFiles = getClaimInitialFiles(claim)

  return (
    <aside className="space-y-3">
      <div className="rounded-2xl border border-white/8 bg-[#141414] p-4">
        <p className="text-11px font-black uppercase tracking-widest text-beyonix-cyan">
          Resumen del problema
        </p>
        <h4 className="mt-3 text-lg font-black text-white">
          Problema informado
        </h4>
        <p className="mt-2 text-sm font-semibold leading-6 text-white">
          {claim.description}
        </p>
        {claim.failure_type && (
          <div className="mt-3 rounded-xl border border-white/8 bg-[#181818] p-3">
            <p className="text-10px font-black uppercase tracking-widest text-white/55">
              Tipo de falla
            </p>
            <p className="mt-1 text-sm font-bold text-white">
              {claim.failure_type}
            </p>
          </div>
        )}
        {claim.started_at && (
          <div className="mt-3 rounded-xl border border-white/8 bg-[#181818] p-3">
            <p className="text-10px font-black uppercase tracking-widest text-white/55">
              Inicio informado
            </p>
            <p className="mt-1 text-sm font-bold text-white">
              {claim.started_at}
            </p>
          </div>
        )}
        {initialFiles.length > 0 && (
          <div className="mt-4">
            <p className="mb-2 text-10px font-black uppercase tracking-widest text-white/55">
              Evidencia inicial
            </p>
            <div className="grid gap-2">
              {initialFiles.map((file) => (
                <ClaimAttachmentChip key={file.id} file={file} />
              ))}
            </div>
          </div>
        )}
      </div>
      {(claim.offered_resolutions ?? []).length > 0 && (
        <div className="rounded-2xl border border-white/8 bg-[#141414] p-4">
          <p className="text-11px font-black uppercase tracking-widest text-beyonix-cyan">
            Solución
          </p>
          {claim.customer_selected_resolution ? (
            <p className="mt-3 text-sm font-semibold leading-6 text-white">
              Elegiste{" "}
              <span className="font-black">
                {getOrderClaimResolutionLabel(
                  claim.customer_selected_resolution,
                )}
              </span>
              . BEYONIX continuará la gestión desde el chat.
            </p>
          ) : (
            <p className="mt-3 text-sm font-semibold leading-6 text-white">
              BEYONIX te ofreció opciones de solución. Elegí una desde el chat
              para continuar.
            </p>
          )}
        </div>
      )}
    </aside>
  )
}

function ClaimMessageBubble({
  message,
}: {
  message: SupabaseOrderClaimMessage
}) {
  const isCustomer = message.author_role === "cliente"

  return (
    <div className={`flex ${isCustomer ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[min(42rem,92%)] rounded-2xl border px-4 py-3 ${
          isCustomer
            ? "border-beyonix-blue-light/35 bg-[#112A43] text-white"
            : "border-beyonix-blue-light/20 bg-[#181818] text-white"
        }`}
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-10px font-black uppercase tracking-widest text-white">
            {isCustomer ? "Vos" : "BEYONIX"}
          </p>
          <p className="text-10px font-semibold text-white/70">
            {formatCuentaOrderDate(message.created_at)}
          </p>
        </div>
        <p className="mt-2 whitespace-pre-wrap text-sm font-semibold leading-6 text-white">
          {message.message}
        </p>
      </div>
    </div>
  )
}

function ClaimChat({
  claim,
  onChooseResolution,
  loading,
}: {
  claim: SupabaseOrderClaim
  onChooseResolution: (claim: SupabaseOrderClaim, resolution: string) => void
  loading: boolean
}) {
  const messages = [...(claim.order_claim_messages ?? [])].sort(
    (a, b) =>
      new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  )

  return (
    <div className="rounded-2xl border border-white/8 bg-[#141414] p-4">
      <div className="flex items-center justify-between gap-3 border-b border-white/8 pb-3">
        <div>
          <p className="text-11px font-black uppercase tracking-widest text-beyonix-cyan">
            Chat de soporte
          </p>
          <h4 className="mt-1 text-lg font-black text-white">
            Conversación con BEYONIX
          </h4>
        </div>
        <span className="rounded-full border border-beyonix-blue-light/25 bg-[#181818] px-3 py-1 text-10px font-black uppercase tracking-wide text-white">
          {messages.length} mensajes
        </span>
      </div>
      <div className="mt-4 space-y-3">
        {messages.length ? (
          messages.map((message) => (
            <ClaimMessageBubble key={message.id} message={message} />
          ))
        ) : (
          <div className="rounded-2xl border border-white/8 bg-[#181818] p-4 text-sm font-semibold text-white">
            Todavía no hay mensajes en este reclamo.
          </div>
        )}
      </div>
      {(claim.offered_resolutions ?? []).length > 0 &&
        !claim.customer_selected_resolution && (
          <div className="mt-4 rounded-2xl border border-beyonix-blue-light/20 bg-[#181818] p-3">
            <p className="text-11px font-black uppercase tracking-widest text-beyonix-cyan">
              Soluciones disponibles
            </p>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {(claim.offered_resolutions ?? []).map((item) => (
                <button
                  key={item}
                  type="button"
                  onClick={() => onChooseResolution(claim, item)}
                  disabled={loading}
                  className="min-h-10 cursor-pointer rounded-xl border border-beyonix-blue-light/30 bg-[#112A43] px-3 py-2 text-left text-xs font-black uppercase tracking-wide text-white transition-colors hover:border-beyonix-blue-light hover:bg-beyonix-blue-hover disabled:cursor-wait disabled:opacity-50"
                >
                  {getOrderClaimResolutionLabel(item)}
                </button>
              ))}
            </div>
          </div>
        )}
    </div>
  )
}

function ClaimReplyBox({
  reply,
  replyFiles,
  loading,
  error,
  onReplyChange,
  onFiles,
  onSubmit,
}: {
  reply: string
  replyFiles: Record<string, File[]>
  loading: boolean
  error: string
  onReplyChange: (value: string) => void
  onFiles: (role: string, files: File[]) => void | Promise<void>
  onSubmit: () => void
}) {
  const files = getReplyFilesList(replyFiles)

  return (
    <div className="rounded-2xl border border-white/8 bg-[#141414] p-4">
      <p className="text-11px font-black uppercase tracking-widest text-beyonix-cyan">
        Responder
      </p>
      <textarea
        value={reply}
        onChange={(event) => onReplyChange(event.target.value)}
        rows={4}
        placeholder="Escribí tu mensaje..."
        className="mt-3 w-full resize-none rounded-2xl border border-beyonix-blue-light/25 bg-[#181818] px-4 py-3 text-sm font-semibold leading-6 text-white outline-none placeholder:text-white/55 focus:border-beyonix-blue-light"
      />
      {files.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {files.map((file) => (
            <span
              key={`${file.name}-${file.size}`}
              title={file.name}
              className="inline-flex max-w-56 items-center gap-2 rounded-xl border border-beyonix-blue-light/25 bg-[#181818] px-3 py-2 text-xs font-bold text-white"
            >
              <FileText className="size-4 shrink-0 text-beyonix-sky" />
              <span className="truncate">{file.name}</span>
            </span>
          ))}
        </div>
      )}
      {error && (
        <p className="mt-3 rounded-xl border border-red-300/25 bg-red-500/10 px-3 py-2 text-xs font-bold text-white">
          {error}
        </p>
      )}
      <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <ClaimFilePicker
          label="Adjuntar archivo"
          role="evidencia_adicional"
          accept="image/*,video/*"
          onFiles={onFiles}
        />
        <button
          type="button"
          onClick={onSubmit}
          disabled={loading}
          className="inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-xl border border-beyonix-blue-light/45 bg-[#112A43] px-5 text-xs font-black uppercase tracking-wide text-white transition-colors hover:border-beyonix-blue-light hover:bg-beyonix-blue-hover disabled:cursor-wait disabled:opacity-50"
        >
          <Send className="size-4" />
          {loading ? "Enviando..." : "Enviar respuesta"}
        </button>
      </div>
    </div>
  )
}

function ClaimActivityTimeline({ claim }: { claim: SupabaseOrderClaim }) {
  const sortedMessages = [...(claim.order_claim_messages ?? [])].sort(
    (a, b) =>
      new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  )
  const events = [
    {
      at: claim.created_at,
      label: "Reclamo creado",
    },
    ...sortedMessages
      .slice(1)
      .map((message) => ({
        at: message.created_at,
        label:
          message.author_role === "cliente"
            ? "Cliente respondió"
            : "BEYONIX respondió",
      })),
    ...(claim.order_claim_files ?? [])
      .filter(
        (file) =>
          new Date(file.created_at).getTime() >
          new Date(claim.created_at).getTime() + 60_000,
      )
      .map((file) => ({
        at: file.created_at,
        label: `Archivo agregado: ${file.file_name}`,
      })),
  ].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())

  if (events.length <= 1) return null

  return (
    <div className="rounded-2xl border border-white/8 bg-[#141414] p-4">
      <p className="text-11px font-black uppercase tracking-widest text-beyonix-cyan">
        Actividad del reclamo
      </p>
      <div className="mt-3 space-y-2">
        {events.map((event, index) => (
          <div
            key={`${event.at}-${index}`}
            className="flex gap-3 text-xs font-semibold leading-5 text-white"
          >
            <span className="mt-1 size-2 shrink-0 rounded-full bg-beyonix-sky" />
            <p className="min-w-0">
              <span className="text-white/70">
                {formatClaimActivityDate(event.at)}
              </span>{" "}
              — {event.label}
            </p>
          </div>
        ))}
      </div>
    </div>
  )
}

function ClaimsCenterPanel({ order }: { order: SupabasePedido }) {
  const deliveredAt = order.delivered_at || order.created_at
  const [claims, setClaims] = useState<SupabaseOrderClaim[]>(
    order.order_claims ?? [],
  )
  const [selectedType, setSelectedType] =
    useState<OrderClaimType>("transporte_48hs")
  const [description, setDescription] = useState("")
  const [failureType, setFailureType] = useState("")
  const [startedAt, setStartedAt] = useState("")
  const [fileMap, setFileMap] = useState<Record<string, File[]>>({})
  const [checks, setChecks] = useState({
    realInfo: false,
    keptPackaging: false,
    noMisuse: false,
  })
  const [reply, setReply] = useState("")
  const [replyFiles, setReplyFiles] = useState<Record<string, File[]>>({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const transportOpen = isClaimWindowOpen(deliveredAt, "transporte_48hs")
  const warrantyOpen = isClaimWindowOpen(deliveredAt, "garantia_beyonix")
  const activeClaim = claims.find((claim) =>
    ["recibido", "en_revision", "falta_informacion", "aprobado"].includes(
      claim.status,
    ),
  )
  const displayedClaim = activeClaim ?? claims[0]

  useEffect(() => {
    let active = true

    async function loadClaims() {
      const response = await fetch(`/api/orders/${order.id}/claims`)
      const data = (await response.json()) as {
        claims?: SupabaseOrderClaim[]
      }

      if (active && response.ok) {
        setClaims(data.claims ?? [])
      }
    }

    void loadClaims()
    return () => {
      active = false
    }
  }, [order.id])

  const validateEvidenceFiles = async (files: File[]) => {
    const sizeOrTypeError = files
      .map((file) => getClaimFileValidationError(file))
      .find(Boolean)

    if (sizeOrTypeError) return sizeOrTypeError

    for (const file of files) {
      if (!file.type.startsWith("video/")) continue

      const duration = await new Promise<number>((resolve) => {
        const video = document.createElement("video")
        const url = URL.createObjectURL(file)

        video.preload = "metadata"
        video.onloadedmetadata = () => {
          URL.revokeObjectURL(url)
          resolve(video.duration)
        }
        video.onerror = () => {
          URL.revokeObjectURL(url)
          resolve(Number.POSITIVE_INFINITY)
        }
        video.src = url
      })

      if (!Number.isFinite(duration) || duration > 30) {
        return "El video debe durar como máximo 30 segundos."
      }
    }

    return ""
  }

  const setFiles = async (role: string, files: File[]) => {
    setError("")
    const validationError = await validateEvidenceFiles(files)

    if (validationError) {
      setError(validationError)
      return
    }

    setFileMap((current) => ({ ...current, [role]: files }))
  }

  const setExtraFiles = async (role: string, files: File[]) => {
    setError("")
    const validationError = await validateEvidenceFiles(files)

    if (validationError) {
      setError(validationError)
      return
    }

    setReplyFiles((current) => ({ ...current, [role]: files }))
  }

  const appendFiles = (formData: FormData, source: Record<string, File[]>) => {
    Object.entries(source).forEach(([role, files]) => {
      files.forEach((file) => {
        formData.append("files", file)
        formData.append("fileRoles", role)
      })
    })
  }

  const submitClaim = async () => {
    setLoading(true)
    setError("")

    try {
      const formData = new FormData()
      formData.set("claimType", selectedType)
      formData.set("description", description)
      formData.set("failureType", failureType)
      formData.set("startedAt", startedAt)
      formData.set("confirm_real_info", String(checks.realInfo))
      formData.set("confirm_kept_packaging", String(checks.keptPackaging))
      formData.set("confirm_no_misuse", String(checks.noMisuse))
      appendFiles(formData, fileMap)

      const response = await fetch(`/api/orders/${order.id}/claims`, {
        method: "POST",
        body: formData,
      })
      const data = (await response.json()) as {
        claim?: SupabaseOrderClaim
        error?: string
      }

      if (!response.ok || !data.claim) {
        setError(data.error || "No se pudo enviar el reclamo.")
        return
      }

      setClaims((current) => [data.claim as SupabaseOrderClaim, ...current])
      setDescription("")
      setFailureType("")
      setStartedAt("")
      setFileMap({})
    } catch {
      setError("No se pudo enviar el reclamo.")
    } finally {
      setLoading(false)
    }
  }

  const submitExtraInfo = async (claim: SupabaseOrderClaim) => {
    setLoading(true)
    setError("")

    try {
      const formData = new FormData()
      formData.set("claimId", String(claim.id))
      formData.set("message", reply)
      appendFiles(formData, replyFiles)

      const response = await fetch(`/api/orders/${order.id}/claims`, {
        method: "POST",
        body: formData,
      })
      const data = (await response.json()) as {
        claim?: SupabaseOrderClaim
        error?: string
      }

      if (!response.ok || !data.claim) {
        setError(data.error || "No se pudo agregar información.")
        return
      }

      setClaims((current) =>
        current.map((currentClaim) =>
          currentClaim.id === data.claim?.id ? data.claim : currentClaim,
        ),
      )
      setReply("")
      setReplyFiles({})
    } catch {
      setError("No se pudo agregar información.")
    } finally {
      setLoading(false)
    }
  }

  const submitResolutionChoice = async (
    claim: SupabaseOrderClaim,
    selectedResolution: string,
  ) => {
    setLoading(true)
    setError("")

    try {
      const response = await fetch(`/api/orders/${order.id}/claims`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          claimId: claim.id,
          selectedResolution,
        }),
      })
      const data = (await response.json()) as {
        claim?: SupabaseOrderClaim
        error?: string
      }

      if (!response.ok || !data.claim) {
        setError(data.error || "No se pudo guardar la solución elegida.")
        return
      }

      setClaims((current) =>
        current.map((currentClaim) =>
          currentClaim.id === data.claim?.id ? data.claim : currentClaim,
        ),
      )
    } catch {
      setError("No se pudo guardar la solución elegida.")
    } finally {
      setLoading(false)
    }
  }

  if (displayedClaim) {
    const conversationOpen = Boolean(activeClaim)

    return (
      <section className="mb-4 space-y-4 rounded-2xl border border-beyonix-blue-light/20 bg-black p-4">
        <ClaimHeaderCard
          claim={displayedClaim}
          order={order}
          deliveredAt={deliveredAt}
        />
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(18rem,0.36fr)]">
          <div className="min-w-0 space-y-4">
            <ClaimChat
              claim={displayedClaim}
              loading={loading}
              onChooseResolution={(claim, resolution) =>
                void submitResolutionChoice(claim, resolution)
              }
            />
            {conversationOpen ? (
              <ClaimReplyBox
                reply={reply}
                replyFiles={replyFiles}
                loading={loading}
                error={error}
                onReplyChange={setReply}
                onFiles={setExtraFiles}
                onSubmit={() => void submitExtraInfo(displayedClaim)}
              />
            ) : (
              <div className="rounded-2xl border border-white/8 bg-[#141414] p-4 text-sm font-semibold leading-6 text-white">
                Este reclamo está finalizado. La conversación permanece
                disponible como referencia.
              </div>
            )}
          </div>
          <div className="min-w-0 space-y-4">
            <ClaimSummaryCard claim={displayedClaim} />
            <ClaimActivityTimeline claim={displayedClaim} />
          </div>
        </div>
      </section>
    )
  }

  return (
    <section className="mb-4 rounded-2xl border border-beyonix-blue-light/20 bg-black p-4">
      <div className="rounded-2xl border border-white/8 bg-[#141414] p-4">
        <p className="text-11px font-black uppercase tracking-widest text-beyonix-cyan">
          Centro de reclamos
        </p>
        <h3 className="mt-2 text-2xl font-black text-white">
          Solicitar revisión
        </h3>
        <p className="mt-2 max-w-3xl text-sm font-semibold leading-6 text-white">
          Elegí el motivo correcto para que podamos revisar la evidencia y darte
          una respuesta desde este mismo pedido.
        </p>
        <div className="mt-4 grid gap-3 lg:grid-cols-2">
          <button
            type="button"
            onClick={() => setSelectedType("transporte_48hs")}
            disabled={!transportOpen}
            className={`rounded-2xl border p-4 text-left transition-colors ${
              selectedType === "transporte_48hs"
                ? "border-beyonix-blue-light/45 bg-[#112A43]"
                : "border-white/8 bg-[#181818] hover:border-beyonix-blue-light/25"
            } disabled:cursor-not-allowed disabled:opacity-50`}
          >
            <p className="text-base font-black text-white">
              Mi producto llegó dañado
            </p>
            <p className="mt-2 text-sm font-semibold leading-6 text-white">
              Si el paquete llegó golpeado, abierto o el producto sufrió daños
              durante el envío, cargá la evidencia para iniciar la revisión.
            </p>
            <p className="mt-3 text-11px font-black uppercase tracking-wide text-white">
              Límite: {formatClaimDeadline(getClaimDeadline(deliveredAt, "transporte_48hs"))}
            </p>
          </button>
          <button
            type="button"
            onClick={() => setSelectedType("garantia_beyonix")}
            disabled={!warrantyOpen}
            className={`rounded-2xl border p-4 text-left transition-colors ${
              selectedType === "garantia_beyonix"
                ? "border-beyonix-blue-light/45 bg-[#112A43]"
                : "border-white/8 bg-[#181818] hover:border-beyonix-blue-light/25"
            } disabled:cursor-not-allowed disabled:opacity-50`}
          >
            <p className="text-base font-black text-white">
              Solicitar garantía BEYONIX
            </p>
            <p className="mt-2 text-sm font-semibold leading-6 text-white">
              Si el producto presenta una falla de funcionamiento, nuestro
              equipo revisará el caso y te ofrecerá una solución.
            </p>
            <p className="mt-3 text-11px font-black uppercase tracking-wide text-white">
              Límite: {formatClaimDeadline(getClaimDeadline(deliveredAt, "garantia_beyonix"))}
            </p>
          </button>
        </div>
      </div>

      {!transportOpen && (
        <p className="mt-4 rounded-xl border border-amber-300/25 bg-amber-400/10 px-3 py-2 text-xs font-semibold leading-5 text-white">
          El plazo de reclamo por transporte ya finalizó. Si el producto
          presenta una falla, podés solicitar garantía BEYONIX.
        </p>
      )}

      {warrantyOpen ? (
        <div className="mt-4 space-y-3 rounded-2xl border border-white/8 bg-[#141414] p-4">
          {selectedType === "garantia_beyonix" && (
            <div className="grid gap-3 sm:grid-cols-2">
              <input
                value={failureType}
                onChange={(event) => setFailureType(event.target.value)}
                placeholder="Tipo de falla"
                className="h-11 rounded-xl border border-beyonix-blue-light/25 bg-[#181818] px-3 text-sm font-semibold text-white outline-none placeholder:text-white/55"
              />
              <input
                value={startedAt}
                onChange={(event) => setStartedAt(event.target.value)}
                placeholder="Cuándo empezó la falla"
                className="h-11 rounded-xl border border-beyonix-blue-light/25 bg-[#181818] px-3 text-sm font-semibold text-white outline-none placeholder:text-white/55"
              />
            </div>
          )}
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            rows={4}
            placeholder="Describí brevemente qué pasó."
            className="w-full resize-none rounded-xl border border-beyonix-blue-light/25 bg-[#181818] px-3 py-3 text-sm font-semibold text-white outline-none placeholder:text-white/55 focus:border-beyonix-blue-light"
          />

          {selectedType === "transporte_48hs" ? (
            <div className="grid gap-3 lg:grid-cols-3">
              <ClaimFileInput label="Foto del embalaje exterior" role="embalaje_exterior" accept="image/*" required onFiles={setFiles} />
              <ClaimFileInput label="Foto del producto completo" role="producto_completo" accept="image/*" required onFiles={setFiles} />
              <ClaimFileInput label="Foto del daño" role="danio" accept="image/*" required onFiles={setFiles} />
              <ClaimFileInput label="Video opcional (máximo 30 segundos)" role="video" accept="video/*" onFiles={setFiles} />
            </div>
          ) : (
            <div className="grid gap-3 lg:grid-cols-2">
              <ClaimFileInput label="Fotos de referencia" role="funcionamiento_foto" accept="image/*" onFiles={setFiles} />
              <ClaimFileInput label="Video de funcionamiento (máximo 30 segundos)" role="video" accept="video/*" required onFiles={setFiles} />
            </div>
          )}

          <div className="space-y-2 rounded-xl border border-white/8 bg-[#181818] p-3">
            {[
              ["realInfo", "Confirmo que la información enviada es real y corresponde al producto recibido."],
              ["keptPackaging", "Confirmo que conservé el embalaje, accesorios y comprobantes disponibles."],
              ["noMisuse", "Confirmo que el producto no sufrió golpes, agua, manipulación indebida o mal uso."],
            ].map(([key, label]) => (
              <label key={key} className="flex gap-2 text-xs font-semibold leading-5 text-white">
                <input
                  type="checkbox"
                  checked={checks[key as keyof typeof checks]}
                  onChange={(event) =>
                    setChecks((current) => ({
                      ...current,
                      [key]: event.target.checked,
                    }))
                  }
                  className="mt-1 size-4 accent-[#112A43]"
                />
                {label}
              </label>
            ))}
          </div>

          {error && (
            <p className="rounded-xl border border-red-300/25 bg-red-500/10 px-3 py-2 text-xs font-semibold text-white">
              {error}
            </p>
          )}
          <button
            type="button"
            onClick={() => void submitClaim()}
            disabled={loading}
            className="inline-flex h-10 cursor-pointer items-center justify-center rounded-xl border border-beyonix-blue-light/45 bg-[#112A43] px-4 text-11px font-black uppercase tracking-wide text-white transition-colors hover:border-beyonix-blue-light hover:bg-beyonix-blue-hover disabled:cursor-wait disabled:opacity-50"
          >
            {loading ? "Enviando..." : "Enviar solicitud"}
          </button>
        </div>
      ) : null}
    </section>
  )
}

function InputField({
  label,
  type,
  value,
  onChange,
  placeholder,
  icon: Icon,
  rightElement,
  error,
  maxLength,
  inputMode,
}: {
  label: string
  type: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  icon: React.ElementType
  rightElement?: React.ReactNode
  error?: string
  maxLength?: number
  inputMode?: InputHTMLAttributes<HTMLInputElement>["inputMode"]
}) {
  return (
    <div className="space-y-1.5">
      <label className="block text-xs font-semibold uppercase tracking-widest text-white/60">
        {label}
      </label>
      <div
        className={`relative flex items-center rounded-xl border bg-white/5 transition-colors focus-within:border-beyonix-blue-light focus-within:ring-2 focus-within:ring-beyonix-blue/40 ${
          error ? "border-red-500/50" : "border-white/8 hover:border-white/14"
        }`}
      >
        <Icon className="absolute left-3.5 size-4 text-white/40 pointer-events-none" />
        <input
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          maxLength={maxLength}
          inputMode={inputMode}
          className="w-full bg-transparent py-2.5 pl-10 pr-10 text-sm text-white placeholder:text-white/25 outline-none"
        />
        {rightElement && <div className="absolute right-3">{rightElement}</div>}
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  )
}

function TextareaField({
  label,
  value,
  onChange,
  placeholder,
  icon: Icon,
  maxLength,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  icon: React.ElementType
  maxLength?: number
}) {
  return (
    <div className="space-y-1.5">
      <label className="block text-xs font-semibold uppercase tracking-widest text-white/60">
        {label}
      </label>
      <div className="relative rounded-xl border border-white/8 bg-white/5 transition-colors hover:border-white/14 focus-within:border-beyonix-blue-light focus-within:ring-2 focus-within:ring-beyonix-blue/40">
        <Icon className="pointer-events-none absolute left-3.5 top-3.5 size-4 text-white/40" />
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          maxLength={maxLength}
          rows={2}
          className="min-h-20 w-full resize-none bg-transparent py-2.5 pl-10 pr-4 text-sm text-white placeholder:text-white/25 outline-none"
        />
      </div>
    </div>
  )
}

function LoginForm({ onSwitch }: { onSwitch: () => void }) {
  const { login } = useAuth()
  const router = useRouter()
  const [identifier, setIdentifier] = useState("")
  const [password, setPassword] = useState("")
  const [showPass, setShowPass] = useState(false)
  const [error, setError] = useState("")
  const [success, setSuccess] = useState("")
  const [loading, setLoading] = useState(false)
  const [resetLoading, setResetLoading] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError("")
    setSuccess("")
    setLoading(true)

    const result = await login(identifier, password)
    setLoading(false)

    if (!result.ok) {
      setError(result.error || "Ocurrió un error.")
      return
    }

    router.push("/cuenta")
  }

  const handleForgotPassword = async () => {
    const normalizedEmail = identifier.trim().toLowerCase()

    if (!normalizedEmail || !normalizedEmail.includes("@")) {
      setError("Introduce tu email primero.")
      setSuccess("")
      return
    }

    setError("")
    setSuccess("")
    setResetLoading(true)

    try {
      localStorage.setItem("beyonix-password-recovery", "true")

      const { error: resetError } = await supabase.auth.resetPasswordForEmail(
        normalizedEmail,
        {
          redirectTo: `${window.location.origin}/reset-password`,
        }
      )

      if (resetError) {
        localStorage.removeItem("beyonix-password-recovery")
        setError("No se pudo enviar el email.")
        return
      }

      setSuccess("Te enviamos un email para restablecer tu contraseña.")
    } catch {
      setError("No se pudo enviar el email. Inténtalo de nuevo.")
    } finally {
      setResetLoading(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <InputField
        label="Email o usuario"
        type="text"
        value={identifier}
        onChange={setIdentifier}
        placeholder="usuario.tech o nombre@email.com"
        icon={Mail}
        maxLength={FIELD_LIMITS.loginIdentifier}
      />
      <InputField
        label="Contraseña"
        type={showPass ? "text" : "password"}
        value={password}
        onChange={setPassword}
        placeholder="••••••••"
        icon={Lock}
        maxLength={FIELD_LIMITS.password}
        rightElement={
          <button
            type="button"
            aria-label="Mostrar u ocultar contraseña"
            title="Mostrar u ocultar contraseña"
            onClick={() => setShowPass((value) => !value)}
            className="cursor-pointer text-slate-700 transition-colors hover:text-black"
          >
            {showPass ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        }
      />

      <div className="flex justify-end">
        <button
          type="button"
          aria-label="Recuperar contraseña"
          title="Recuperar contraseña"
          onClick={handleForgotPassword}
          disabled={resetLoading}
          className="text-sm font-medium text-beyonix-cyan transition-colors hover:text-white disabled:opacity-50 cursor-pointer"
        >
          {resetLoading ? "Enviando..." : "¿Olvidaste tu contraseña?"}
        </button>
      </div>

      {error && (
        <div className="rounded-xl border border-red-500/20 bg-red-500/8 px-4 py-3">
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}
      {success && (
        <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/8 px-4 py-3">
          <p className="text-sm text-emerald-400">{success}</p>
        </div>
      )}

      <button
        type="submit"
        aria-label="Iniciar sesión"
        title="Iniciar sesión"
        disabled={loading}
        className="w-full h-11 rounded-xl bg-white text-black text-sm font-semibold hover:bg-white/90 disabled:opacity-50 transition-all active:scale-95 cursor-pointer"
      >
        {loading ? "Ingresando..." : "Iniciar sesión"}
      </button>

      <p className="text-center text-sm text-white/50">
        ¿No tenés cuenta?{" "}
        <button
          type="button"
          aria-label="Ir a registro"
          title="Ir a registro"
          onClick={onSwitch}
          className="text-beyonix-cyan hover:text-white transition-colors cursor-pointer font-medium"
        >
          Registrate gratis
        </button>
      </p>
    </form>
  )
}

function RegisterForm({ onSwitch }: { onSwitch: () => void }) {
  const { register } = useAuth()
  const [username, setUsername] = useState("")
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [street, setStreet] = useState("")
  const [streetNumber, setStreetNumber] = useState("")
  const [floor, setFloor] = useState("")
  const [apartment, setApartment] = useState("")
  const [locality, setLocality] = useState("")
  const [province, setProvince] = useState("")
  const [postalCode, setPostalCode] = useState("")
  const [phone, setPhone] = useState("")
  const [references, setReferences] = useState("")
  const [password, setPassword] = useState("")
  const [showPass, setShowPass] = useState(false)
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)
  const [pendingUserId, setPendingUserId] = useState("")
  const [confirmationHandoff, setConfirmationHandoff] = useState("")
  const [confirmationValidated, setConfirmationValidated] = useState(false)
  const [confirmationMessage, setConfirmationMessage] = useState("")
  const confirmationPollInProgress = useRef(false)
  const confirmationCompletionStarted = useRef(false)

  useEffect(() => {
    if (!pendingUserId || !confirmationHandoff) return

    let cancelled = false
    let timeout: number | undefined

    const checkConfirmation = async () => {
      if (cancelled || confirmationPollInProgress.current) return

      confirmationPollInProgress.current = true

      try {
        const response = await fetch("/api/auth/confirmation-status", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            userId: pendingUserId,
            handoff: confirmationHandoff,
          }),
          cache: "no-store",
        })
        const data = (await response.json()) as {
          confirmed?: boolean
          tokenHash?: string
          error?: string
        }

        if (!cancelled && response.ok && data.confirmed) {
          setConfirmationValidated(true)

          if (!data.tokenHash) {
            setConfirmationMessage(
              data.error ||
                "Cuenta confirmada. Estamos preparando tu sesión..."
            )
            return
          }

          if (confirmationCompletionStarted.current) return

          confirmationCompletionStarted.current = true
          setConfirmationMessage("Email confirmado. Iniciando sesión...")

          localStorage.setItem(
            "beyonix-auth-last-activity",
            String(Date.now())
          )
          const { error: sessionError } = await supabase.auth.verifyOtp({
            token_hash: data.tokenHash,
            type: "magiclink",
          })

          if (cancelled) return

          if (!sessionError) {
            setConfirmationMessage(
              "Email confirmado. Te llevaremos al Home en un segundo..."
            )
            timeout = window.setTimeout(() => {
              window.location.assign("/")
            }, 1000)
            return
          }

          confirmationCompletionStarted.current = false
          setConfirmationMessage(
            "La cuenta fue confirmada, pero no pudimos iniciar sesión automáticamente."
          )
        } else if (!cancelled && !response.ok && data.error) {
          setConfirmationMessage(data.error)
        }
      } catch {
        // La pestaña seguirá consultando mientras permanezca abierta.
      } finally {
        confirmationPollInProgress.current = false
      }

      if (!cancelled && !confirmationCompletionStarted.current) {
        timeout = window.setTimeout(checkConfirmation, 1000)
      }
    }

    void checkConfirmation()

    return () => {
      cancelled = true
      if (timeout) window.clearTimeout(timeout)
    }
  }, [
    confirmationHandoff,
    pendingUserId,
  ])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError("")

    if (!meetsPasswordRequirements(password)) {
      setError("La contraseña no cumple los requisitos.")
      return
    }

    if (!street.trim()) {
      setError("Introduce la calle.")
      return
    }

    if (!streetNumber.trim()) {
      setError("Introduce el número de calle.")
      return
    }

    if (!locality.trim()) {
      setError("Introduce la localidad.")
      return
    }

    const deliveryAddress = formatDeliveryAddressForProfile(
      buildDeliveryAddressDraft({
        postalCode,
        street,
        streetNumber,
        floor,
        apartment,
        locality,
        province,
      })
    )

    const validationError = validateRegisterPayload({
      username,
      name,
      email,
      address: deliveryAddress,
      street,
      streetNumber,
      locality,
      province,
      postalCode,
      phone,
      password,
      references,
    })

    if (validationError) {
      setError(validationError)
      return
    }

    setLoading(true)
    const result = await register({
      username,
      name,
      email,
      password,
      address: deliveryAddress,
      street,
      streetNumber,
      floor,
      apartment,
      locality,
      province,
      postalCode,
      phone,
      references,
    })
    setLoading(false)

    if (!result.ok) {
      setError(result.error || "Ocurrió un error.")
      return
    }

    setPendingUserId(result.pendingUserId ?? "")
    setConfirmationHandoff(result.confirmationHandoff ?? "")
    setConfirmationValidated(false)
    setConfirmationMessage("")
    confirmationCompletionStarted.current = false
  }

  if (pendingUserId && confirmationHandoff) {
    return (
      <div className="space-y-5 text-center">
        <div className="mx-auto flex size-16 items-center justify-center rounded-full border border-emerald-400/25 bg-emerald-500/10">
          <Check className="size-9 text-emerald-400" />
        </div>

        <div>
          <h2 className="text-2xl font-bold text-white">
            {confirmationValidated ? "Cuenta confirmada" : "Revisá tu correo"}
          </h2>
          <p className="mt-2 text-sm leading-6 text-white/60">
            {confirmationValidated
              ? "Estamos iniciando tu sesión y te llevaremos al Home automáticamente."
              : "Dejá esta pestaña abierta. Cuando confirmes la cuenta desde Gmail, iniciaremos tu sesión automáticamente y te llevaremos al inicio."}
          </p>
        </div>

        {!confirmationValidated && (
          <p className="rounded-xl border border-white/10 bg-black px-4 py-3 text-sm font-semibold text-white">
            {email.trim().toLowerCase()}
          </p>
        )}

        {confirmationMessage && (
          <p className="text-sm text-emerald-400">{confirmationMessage}</p>
        )}

        <button
          type="button"
          onClick={onSwitch}
          className="h-11 w-full cursor-pointer rounded-xl bg-white text-sm font-semibold text-black transition-opacity hover:opacity-90"
        >
          Volver al inicio de sesión
        </button>
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <InputField label="Nombre de usuario" type="text" value={username} onChange={setUsername} placeholder="usuario.tech" icon={User} maxLength={FIELD_LIMITS.username} />
      <InputField label="Nombre y apellido" type="text" value={name} onChange={setName} placeholder="Nombre Apellido" icon={User} maxLength={FIELD_LIMITS.name} />
      <InputField label="Email" type="email" value={email} onChange={setEmail} placeholder="nombre@email.com" icon={Mail} maxLength={FIELD_LIMITS.email} />
      <div className="grid gap-3 md:grid-cols-2">
        <InputField label="Calle" type="text" value={street} onChange={setStreet} placeholder="San Martín" icon={MapPin} maxLength={60} />
        <InputField label="Número" type="tel" value={streetNumber} onChange={(value) => setStreetNumber(onlyDigits(value, 8))} placeholder="1234" icon={Hash} maxLength={8} inputMode="numeric" />
        <InputField label="Piso opcional" type="text" value={floor} onChange={setFloor} placeholder="3" icon={Hash} maxLength={12} />
        <InputField label="Departamento opcional" type="text" value={apartment} onChange={setApartment} placeholder="B" icon={Hash} maxLength={12} />
        <InputField label="Localidad" type="text" value={locality} onChange={setLocality} placeholder="Rosario" icon={MapPin} maxLength={60} />
      </div>
      <TextareaField
        label="Referencias"
        value={references}
        onChange={setReferences}
        placeholder="Entre calles, fachada blanca, porton negro, antes de llegar a la esquina."
        icon={MapPin}
        maxLength={FIELD_LIMITS.references}
      />
      <div className="space-y-1.5">
        <label className="block text-xs font-semibold uppercase tracking-widest text-white/60">
          Provincia
        </label>
        <ProvinceSelect value={province} onChange={setProvince} />
      </div>
      <InputField label="Código postal" type="tel" value={postalCode} onChange={(value) => setPostalCode(onlyDigits(value, FIELD_LIMITS.postalCode))} placeholder="1001" icon={Hash} maxLength={FIELD_LIMITS.postalCode} inputMode="numeric" />
      <InputField label="Teléfono móvil" type="tel" value={phone} onChange={(value) => setPhone(onlyDigits(value, FIELD_LIMITS.phone))} placeholder="1100000000" icon={Phone} maxLength={FIELD_LIMITS.phone} inputMode="numeric" />
      <InputField
        label="Contraseña"
        type={showPass ? "text" : "password"}
        value={password}
        onChange={setPassword}
        placeholder="Creá una contraseña segura"
        icon={Lock}
        maxLength={FIELD_LIMITS.password}
        rightElement={
          <button
            type="button"
            aria-label="Mostrar u ocultar contraseña"
            title="Mostrar u ocultar contraseña"
            onClick={() => setShowPass((value) => !value)}
            className="text-white/40 hover:text-white/70 transition-colors cursor-pointer"
          >
            {showPass ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        }
      />
      <PasswordRequirements password={password} />

      {error && (
        <div className="rounded-xl border border-red-500/20 bg-red-500/8 px-4 py-3">
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      <button
        type="submit"
        aria-label="Crear cuenta"
        title="Crear cuenta"
        disabled={loading}
        className="w-full h-11 rounded-xl bg-white text-black text-sm font-semibold hover:bg-white/90 disabled:opacity-50 transition-all active:scale-95 cursor-pointer"
      >
        {loading ? "Creando cuenta..." : "Crear cuenta"}
      </button>

      <p className="text-center text-sm text-white/50">
        ¿Ya tenés cuenta?{" "}
        <button
          type="button"
          aria-label="Ir a inicio de sesión"
          title="Ir a inicio de sesión"
          onClick={onSwitch}
          className="text-beyonix-cyan hover:text-white transition-colors cursor-pointer font-medium"
        >
          Iniciá sesión
        </button>
      </p>
    </form>
  )
}

type ProfileView = "home" | "ordenes" | "datos" | "seguridad"
type CustomerOrderDetailView = "detalle" | "factura" | "reclamo"
const PASSWORD_CHANGE_COOLDOWN_DAYS = 15
const PASSWORD_CHANGE_COOLDOWN_MS =
  PASSWORD_CHANGE_COOLDOWN_DAYS * 24 * 60 * 60 * 1000

function AccountViewFrame({
  onBack,
  kicker,
  title,
  children,
  maxWidth = "max-w-4xl",
  hideHeading = false,
}: {
  onBack: () => void
  kicker: string
  title: string
  children: React.ReactNode
  maxWidth?: string
  hideHeading?: boolean
}) {
  return (
    <div className={`mx-auto ${maxWidth} space-y-5`}>
      <button
        type="button"
        aria-label="Volver a mi cuenta"
        title="Volver a mi cuenta"
        onClick={onBack}
        className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-full border border-white/12 bg-white/6 px-4 text-sm font-semibold text-white/82 shadow-lg shadow-black/20 transition-all hover:border-beyonix-blue-light/45 hover:bg-beyonix-blue/35 hover:text-white"
      >
        <ChevronLeft className="size-4" />
        Volver a mi cuenta
      </button>

      {!hideHeading && (
        <div className="rounded-2xl border border-white/8 bg-beyonix-surface px-5 py-5 shadow-2xl shadow-black/25 sm:px-6">
          <p className="text-11px font-semibold uppercase tracking-widest text-beyonix-cyan">
            {kicker}
          </p>
          <h2 className="mt-2 text-2xl font-bold tracking-tight text-white">
            {title}
          </h2>
        </div>
      )}

      {children}
    </div>
  )
}

function getPasswordCooldownMessage(lastChangedAt: string) {
  const availableAt =
    new Date(
      new Date(lastChangedAt).getTime() +
        PASSWORD_CHANGE_COOLDOWN_MS
    )

  return `La contraseña se puede cambiar una vez cada 15 días. Vas a poder cambiarla nuevamente el ${availableAt.toLocaleDateString("es-AR")}.`
}

function PaymentProofViewButton({ order }: { order: SupabasePedido }) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")

  useEffect(() => {
    setError("")
  }, [order.id, order.payment_proof_uploaded_at])

  const handleOpenProof = async () => {
    setLoading(true)
    setError("")

    try {
      const response = await fetch(`/api/payment-proofs/${order.id}`)
      const data = (await response.json()) as {
        signedUrl?: string | null
        error?: string
      }

      if (!response.ok || !data.signedUrl) {
        throw new Error(data.error || "No se pudo abrir el comprobante.")
      }

      const anchor = document.createElement("a")
      anchor.href = data.signedUrl
      anchor.target = "_blank"
      anchor.rel = "noreferrer"
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
    } catch (proofError) {
      setError(
        proofError instanceof Error
          ? proofError.message
          : "No se pudo abrir el comprobante.",
      )
    } finally {
      setLoading(false)
    }
  }

  return (
    <span className="inline-flex flex-col items-stretch gap-1">
      <button
        type="button"
        aria-label={`Ver comprobante del pedido ${formatPublicOrderId(order.id)}`}
        title="Ver comprobante"
        disabled={loading}
        onClick={() => void handleOpenProof()}
        className="inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-lg border border-white/12 bg-[#181818] px-4 text-xs font-black text-white transition-colors hover:border-blue-300/30 hover:bg-[#112A43] disabled:cursor-wait disabled:opacity-60"
      >
        <ExternalLink className="size-4" />
        {loading ? "Abriendo..." : "Ver comprobante"}
      </button>
      {error && (
        <span className="max-w-52 text-left text-10px font-semibold leading-4 text-red-300 sm:text-right">
          {error}
        </span>
      )}
    </span>
  )
}

function OrderProductFeedback({ order }: { order: SupabasePedido }) {
  const items = order.orden_items ?? []
  const [ratings, setRatings] = useState<Record<number, number>>({})
  const [comments, setComments] = useState<Record<number, string>>({})
  const [activeProductId, setActiveProductId] = useState<number | null>(null)
  const [hoverRatings, setHoverRatings] = useState<Record<number, number>>({})
  const [submitted, setSubmitted] = useState<Set<number>>(() => new Set())
  const [submitting, setSubmitting] = useState<number | null>(null)
  const [feedbackMessage, setFeedbackMessage] = useState("")

  useEffect(() => {
    let active = true
    const loadOwnReviews = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      const response = await fetch(`/api/reviews?orderId=${order.id}`, {
        headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {},
        cache: "no-store",
      })
      const data = (await response.json()) as {
        ownProductReviews?: Array<{ product_id: number; rating: number; comment: string }>
      }
      if (!active || !response.ok) return
      const reviews = data.ownProductReviews ?? []
      setSubmitted(new Set(reviews.map((review) => Number(review.product_id))))
      setRatings(Object.fromEntries(reviews.map((review) => [Number(review.product_id), Number(review.rating)])))
      setComments(Object.fromEntries(reviews.map((review) => [Number(review.product_id), String(review.comment)])))
    }
    void loadOwnReviews()
    return () => { active = false }
  }, [order.id])

  const submitReview = async (productId: number) => {
    const rating = ratings[productId]
    const comment = comments[productId]?.trim() ?? ""
    if (!rating || !comment) {
      setFeedbackMessage("Elegí una puntuación y escribí una reseña breve.")
      return
    }

    setSubmitting(productId)
    setFeedbackMessage("")
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const response = await fetch("/api/reviews", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify({ orderId: order.id, productId, rating, comment }),
      })
      const data = (await response.json()) as { error?: string }
      if (!response.ok) {
        setFeedbackMessage(data.error || "No pudimos guardar la reseña.")
        return
      }
      setSubmitted((current) => new Set(current).add(productId))
      setActiveProductId(null)
      setFeedbackMessage("¡Gracias por compartir tu experiencia!")
    } catch {
      setFeedbackMessage("No pudimos guardar la reseña. Intentá nuevamente.")
    } finally {
      setSubmitting(null)
    }
  }

  return (
    <section className="rounded-xl border border-white/8 bg-[#141414] p-3 sm:p-4">
      <h4 className="text-sm font-black text-white">¿Qué te pareció tu compra?</h4>
      <div className="mt-3 space-y-2">
        {items.map((item) => {
          const productId = Number(item.producto_id)
          const productName = item.productos?.nombre ?? `Producto #${productId}`
          const image = getCuentaItemImage(item)
          const selectedRating = ratings[productId] ?? 0
          const visualRating = hoverRatings[productId] ?? selectedRating
          return (
            <div key={item.id} className="rounded-lg border border-white/8 bg-[#181818] p-3">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-white">{image ? <img src={image} alt={productName} className="size-full object-contain" /> : <Package className="size-4 text-black/30" />}</div>
                  <p className="truncate text-xs font-black text-white">{productName}</p>
                </div>
                {submitted.has(productId) ? <span className="inline-flex items-center gap-1.5 text-xs font-bold text-emerald-300"><Check className="size-3.5" />Reseña enviada</span> : <div className="flex items-center gap-1" aria-label={`Calificar ${productName}`} onMouseLeave={() => setHoverRatings((current) => { const next = { ...current }; delete next[productId]; return next })}>{[1, 2, 3, 4, 5].map((rating) => <button key={rating} type="button" aria-label={`${rating} estrellas`} onMouseEnter={() => setHoverRatings((current) => ({ ...current, [productId]: rating }))} onFocus={() => setHoverRatings((current) => ({ ...current, [productId]: rating }))} onBlur={() => setHoverRatings((current) => { const next = { ...current }; delete next[productId]; return next })} onClick={() => { setRatings((current) => ({ ...current, [productId]: rating })); setActiveProductId(productId); setFeedbackMessage("") }} className="cursor-pointer p-0.5"><Star className={`size-5 transition-colors ${rating <= visualRating ? "fill-amber-300 text-amber-300" : "text-white/25"}`} /></button>)}</div>}
              </div>
              {activeProductId === productId && !submitted.has(productId) && <div className="mt-3 flex flex-col gap-2 sm:flex-row"><input value={comments[productId] ?? ""} maxLength={150} onChange={(event) => setComments((current) => ({ ...current, [productId]: event.target.value }))} placeholder="Contanos brevemente tu experiencia" className="h-9 min-w-0 flex-1 rounded-lg border border-white/10 bg-black px-3 text-xs text-white outline-none placeholder:text-white/40 focus:border-blue-300/40" /><button type="button" disabled={submitting === productId} onClick={() => void submitReview(productId)} className="h-9 cursor-pointer rounded-lg bg-[#112A43] px-4 text-xs font-black text-white disabled:opacity-50">{submitting === productId ? "Enviando..." : "Enviar reseña"}</button></div>}
            </div>
          )
        })}
      </div>
      {feedbackMessage && <p className="mt-2 text-xs font-bold text-white/70">{feedbackMessage}</p>}
    </section>
  )
}

function DeliveredPurchaseHelp({ order, onClaim }: { order: SupabasePedido; onClaim: (problem: ClaimProblemId) => void }) {
  const helpOptions: Array<[string, ClaimProblemId]> = [
    ["Recibí el producto con un problema", "falla"],
    ["Recibí el paquete sin el producto", "incorrecto"],
    ["Nunca llegó el envío", "otro"],
    ["Quiero cambiar o devolver un producto", "devolucion"],
    ["Cómo cuidar el producto para devolverlo", "devolucion"],
  ]

  return (
    <div className="mt-4 grid gap-3 lg:grid-cols-2">
      <OrderProductFeedback order={order} />
      <div className="space-y-3">
        <section className="rounded-xl border border-white/8 bg-[#141414] p-3 sm:p-4">
          <h4 className="text-sm font-black text-white">Ayuda con la compra</h4>
          <div className="mt-2 divide-y divide-white/8">{helpOptions.map(([label, problem]) => <button key={label} type="button" onClick={() => onClaim(problem)} className="flex min-h-9 w-full cursor-pointer items-center justify-between gap-3 py-2 text-left text-xs font-bold text-white/80 hover:text-white"><span>{label}</span><ChevronRight className="size-3.5 shrink-0 text-blue-300" /></button>)}</div>
        </section>
        <section className="rounded-xl border border-blue-300/15 bg-[#141414] p-3 sm:p-4">
          <p className="text-xs font-bold leading-5 text-white/75">Podés solicitar cambio o devolución dentro del plazo disponible.</p>
          <div className="mt-3 flex flex-wrap gap-2"><button type="button" onClick={() => onClaim("devolucion")} className="h-9 cursor-pointer rounded-lg bg-[#112A43] px-4 text-xs font-black text-white">Cambiar producto</button><button type="button" onClick={() => onClaim("devolucion")} className="h-9 cursor-pointer rounded-lg border border-white/12 bg-[#181818] px-4 text-xs font-black text-white">Devolver producto</button></div>
        </section>
      </div>
    </div>
  )
}

function MisOrdenes({ onBack }: { onBack: () => void }) {
  const { user } = useAuth()
  const [orders, setOrders] = useState<SupabasePedido[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [downloadingInvoiceId, setDownloadingInvoiceId] = useState<number | null>(
    null,
  )
  const [invoiceError, setInvoiceError] = useState("")
  const [downloadedInvoiceIds, setDownloadedInvoiceIds] = useState<Set<number>>(
    () => new Set(),
  )
  const [expandedOrderIds, setExpandedOrderIds] = useState<Set<number>>(
    () => new Set(),
  )
  const [orderDetailViews, setOrderDetailViews] = useState<
    Record<number, CustomerOrderDetailView>
  >({})
  const [openMoreOptionsId, setOpenMoreOptionsId] = useState<number | null>(null)
  const [claimProblemByOrder, setClaimProblemByOrder] = useState<Record<number, ClaimProblemId | undefined>>({})

  useEffect(() => {
    if (openMoreOptionsId === null) return

    const closeOutside = (event: PointerEvent) => {
      const target = event.target
      if (target instanceof Element && target.closest(`[data-order-menu="${openMoreOptionsId}"]`)) return
      setOpenMoreOptionsId(null)
    }

    document.addEventListener("pointerdown", closeOutside)
    return () => document.removeEventListener("pointerdown", closeOutside)
  }, [openMoreOptionsId])

  const loadOrders = useCallback(
    async ({ silent = false }: { silent?: boolean } = {}) => {
      if (!user) {
        setOrders([])
        setLoading(false)
        return
      }

      if (!silent) setLoading(true)
      setError("")

      const { data, error: ordersError } = await supabase
        .from("ordenes")
        .select("*, orden_items(*, productos(*), producto_variantes(*))")
        .order("created_at", { ascending: false })

      if (ordersError) {
        setError("No se pudieron cargar tus compras.")
        if (!silent) setLoading(false)
        return
      }

      const normalizedUserValues = [
        user.id,
        user.email,
        user.username,
        user.name,
        user.phone,
      ]
        .filter(Boolean)
        .map((value) => String(value).trim().toLowerCase())

      const matchedOrders = ((data ?? []) as SupabasePedido[]).filter((order) => {
        const orderValues = [
          order.usuario_id,
          order.cliente_email,
          order.cliente_nombre,
          order.cliente_telefono,
        ]
          .filter(Boolean)
          .map((value) => String(value).trim().toLowerCase())

        return orderValues.some((orderValue) =>
          normalizedUserValues.includes(orderValue)
        )
      })

      setOrders(matchedOrders)
      if (!silent) setLoading(false)
    },
    [user],
  )

  useEffect(() => {
    void loadOrders()
  }, [loadOrders])

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(DOWNLOADED_INVOICES_STORAGE_KEY)
      const ids = raw ? (JSON.parse(raw) as unknown) : []

      if (Array.isArray(ids)) {
        setDownloadedInvoiceIds(
          new Set(ids.filter((id): id is number => typeof id === "number")),
        )
      }
    } catch {
      setDownloadedInvoiceIds(new Set())
    }
  }, [])

  useEffect(() => {
    if (!user) return

    const refreshOrders = () => {
      void loadOrders({ silent: true })
    }

    const channel = supabase
      .channel(`customer-orders-${user.id}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "ordenes",
        },
        refreshOrders,
      )
      .subscribe()

    const intervalId = window.setInterval(refreshOrders, 15000)
    window.addEventListener("focus", refreshOrders)
    document.addEventListener("visibilitychange", refreshOrders)

    return () => {
      window.clearInterval(intervalId)
      window.removeEventListener("focus", refreshOrders)
      document.removeEventListener("visibilitychange", refreshOrders)
      void supabase.removeChannel(channel)
    }
  }, [loadOrders, user])

  const handlePaymentProofUploaded = (updatedOrder: SupabasePedido) => {
    setOrders((currentOrders) =>
      currentOrders.map((order) =>
        order.id === updatedOrder.id
          ? {
              ...order,
              estado: updatedOrder.estado ?? order.estado,
              payment_status: updatedOrder.payment_status,
              payment_method_id:
                updatedOrder.payment_method_id ?? order.payment_method_id,
              payment_proof_url: updatedOrder.payment_proof_url,
              payment_proof_file_name: updatedOrder.payment_proof_file_name,
              payment_proof_uploaded_at: updatedOrder.payment_proof_uploaded_at,
              tracking_number:
                updatedOrder.tracking_number ?? order.tracking_number,
              tracking_url: updatedOrder.tracking_url ?? order.tracking_url,
              andreani_tracking:
                updatedOrder.andreani_tracking ?? order.andreani_tracking,
              andreani_estado:
                updatedOrder.andreani_estado ?? order.andreani_estado,
              invoice_status:
                updatedOrder.invoice_status ?? order.invoice_status,
              invoice_point: updatedOrder.invoice_point ?? order.invoice_point,
              invoice_number:
                updatedOrder.invoice_number ?? order.invoice_number,
            }
          : order
      )
    )
  }

  const toggleOrderDetails = (orderId: number) => {
    setExpandedOrderIds((currentIds) => {
      const nextIds = new Set(currentIds)

      if (nextIds.has(orderId)) {
        nextIds.delete(orderId)
      } else {
        nextIds.add(orderId)
      }

      return nextIds
    })
  }

  const showOrderDetailView = (
    orderId: number,
    view: CustomerOrderDetailView,
  ) => {
    setExpandedOrderIds((currentIds) => {
      const nextIds = new Set(currentIds)
      nextIds.add(orderId)
      return nextIds
    })
    setOrderDetailViews((currentViews) => ({
      ...currentViews,
      [orderId]: view,
    }))
  }

  const showClaimView = (orderId: number, problem?: ClaimProblemId) => {
    setClaimProblemByOrder((current) => ({ ...current, [orderId]: problem }))
    showOrderDetailView(orderId, "reclamo")
  }

  const handleDownloadInvoice = async (orderId: number) => {
    setDownloadingInvoiceId(orderId)
    setInvoiceError("")

    try {
      const response = await fetch(`/api/orders/${orderId}/invoice`)

      if (!response.ok) {
        const data = (await response.json()) as { error?: string }
        setInvoiceError(data.error || "No se pudo descargar la factura.")
        return
      }

      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement("a")
      anchor.href = url
      anchor.download = "Factura-BEYONIX.pdf"
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      URL.revokeObjectURL(url)
      setDownloadedInvoiceIds((currentIds) => {
        const nextIds = new Set(currentIds)
        nextIds.add(orderId)
        window.localStorage.setItem(
          DOWNLOADED_INVOICES_STORAGE_KEY,
          JSON.stringify([...nextIds]),
        )
        return nextIds
      })
    } catch {
      setInvoiceError("No se pudo descargar la factura. Inténtalo de nuevo.")
    } finally {
      setDownloadingInvoiceId(null)
    }
  }

  return (
    <AccountViewFrame
      onBack={onBack}
      kicker="Mis compras"
      title="Historial de compras"
      maxWidth="max-w-6xl"
      hideHeading
    >
      <div>
        <h1 className="text-2xl font-black tracking-tight text-white">Mis compras</h1>
        <p className="mt-1 text-sm text-[#A0A0A0]">
          Revisá el estado de tus pedidos, facturas y comprobantes.
        </p>
      </div>
      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 2 }).map((_, index) => (
            <div
              key={index}
              className="h-132px animate-pulse rounded-2xl border border-white/7 bg-beyonix-surface"
            />
          ))}
        </div>
      ) : error ? (
        <div className="rounded-2xl border border-red-500/20 bg-red-500/8 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      ) : orders.length === 0 ? (
        <div className="rounded-2xl border border-white/7 bg-beyonix-surface p-8 text-center">
          <ShoppingBag className="size-10 text-white/15 mx-auto mb-3" />
          <p className="text-sm font-medium text-white/60">Todavía no has realizado ningún pedido.</p>
          <p className="text-xs text-white/40 mt-1">Cuando compres algo aparecerá aquí.</p>
        </div>
      ) : (
        <div className="space-y-6">
          {invoiceError && (
            <div className="rounded-xl border border-red-400/20 bg-red-400/8 px-4 py-3 text-sm text-red-200">
              {invoiceError}
            </div>
          )}
          {[...orders]
            .sort(
              (first, second) =>
                new Date(second.created_at).getTime() -
                new Date(first.created_at).getTime(),
            )
            .map((order) => {
            const items = order.orden_items ?? []
            const hasProof = Boolean(order.payment_proof_url)
            const isTransferOrder = order.payment_method_id === "transferencia"
            const isExpanded = expandedOrderIds.has(order.id)
            const orderStatusBadge = getClientOrderStatusBadge(order)
            const activeOrderView = orderDetailViews[order.id] ?? "detalle"
            const invoiceAvailable = isInvoiceAvailable(order)
            const showInvoiceNotification =
              invoiceAvailable && !downloadedInvoiceIds.has(order.id)
            const firstItem = items[0]
            const firstProductImage = firstItem ? getCuentaItemImage(firstItem) : ""
            const firstProductName = firstItem?.productos?.nombre ?? "Productos del pedido"
            const productCount = items.reduce(
              (total, item) => total + Number(item.cantidad ?? 0),
              0,
            )
            const trackingUrl = normalizeTrackingUrl(order.tracking_url)
            const shippingLabel =
              order.estado === "entregado"
                ? "Entregado"
                : order.estado === "en_camino" || order.estado === "enviado"
                  ? "En camino"
                  : "Preparando envío"
            const shippingDetail =
              order.estado === "entregado" && order.delivered_at
                ? formatOrderCardDate(order.delivered_at).split(" · ")[0]
                : trackingUrl || order.andreani_tracking || order.tracking_number
                  ? "Andreani · Seguimiento disponible"
                  : "Te avisaremos cuando sea despachado"
            const hasMoreOptions =
              invoiceAvailable || (isTransferOrder && hasProof) || Boolean(trackingUrl)
            const detailIsOpen = isExpanded && activeOrderView === "detalle"

            return (
              <article
                key={order.id}
                className="relative overflow-visible rounded-[18px] border border-[#252525] bg-[#141414] shadow-xl shadow-black/20"
              >
                <div className="p-4 sm:p-6">
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex min-w-0 items-center gap-4">
                      <div className="flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-white/8 bg-white">
                        {firstProductImage ? (
                          <img src={firstProductImage} alt={firstProductName} className="size-full object-contain" />
                        ) : (
                          <ShoppingBag className="size-7 text-black/30" />
                        )}
                      </div>
                      <div className="min-w-0">
                        <p className="text-base font-black text-white">
                          Pedido #{formatPublicOrderId(order.id)}
                        </p>
                        <p className="mt-1 text-sm text-[#A0A0A0]">
                          {formatOrderCardDate(order.created_at)}
                        </p>
                        <span className={"mt-2 inline-flex w-fit rounded-full border px-2.5 py-1 text-[10px] font-black uppercase tracking-wide " + orderStatusBadge.className}>
                          {orderStatusBadge.label}
                        </span>
                      </div>
                    </div>
                    <div className="shrink-0 sm:text-right">
                      <p className="text-xs font-bold uppercase tracking-widest text-[#A0A0A0]">Total</p>
                      <p className="mt-1 text-2xl font-black text-white">{formatCuentaPrice(Number(order.total ?? 0))}</p>
                    </div>
                  </div>

                  <div className="mt-5 grid border-y border-white/8 py-4 sm:grid-cols-3 sm:divide-x sm:divide-white/8">
                    <div className="flex items-center gap-3 px-1 py-2 sm:px-4 sm:py-0 sm:first:pl-0">
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[#112A43]"><CreditCard className="size-5 text-blue-300" /></span>
                      <div><p className="text-[10px] font-black uppercase tracking-widest text-[#A0A0A0]">Pago</p><p className="mt-1 text-sm font-bold text-white">{isTransferOrder ? "Transferencia bancaria" : "Mercado Pago"}</p><p className="mt-0.5 text-xs text-[#A0A0A0]">{getPaymentProgressLabel(order)}</p></div>
                    </div>
                    <div className="flex items-center gap-3 border-t border-white/8 px-1 py-3 sm:border-0 sm:px-4 sm:py-0">
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[#112A43]"><Truck className="size-5 text-blue-300" /></span>
                      <div><p className="text-[10px] font-black uppercase tracking-widest text-[#A0A0A0]">Envío</p><p className="mt-1 text-sm font-bold text-white">{shippingLabel}</p><p className="mt-0.5 text-xs text-[#A0A0A0]">{shippingDetail}</p></div>
                    </div>
                    <div className="flex items-center gap-3 border-t border-white/8 px-1 pt-3 sm:border-0 sm:px-4 sm:py-0 sm:last:pr-0">
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[#112A43]"><Package className="size-5 text-blue-300" /></span>
                      <div><p className="text-[10px] font-black uppercase tracking-widest text-[#A0A0A0]">Productos</p><p className="mt-1 text-sm font-bold text-white">{productCount} {productCount === 1 ? "producto" : "productos"}</p></div>
                    </div>
                  </div>

                  <div className="mt-4 flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
                    <div className="flex flex-wrap gap-2">
                      <button type="button" aria-expanded={detailIsOpen} onClick={() => detailIsOpen ? toggleOrderDetails(order.id) : showOrderDetailView(order.id, "detalle")} className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-lg border border-[#112A43] bg-[#112A43] px-4 text-xs font-black text-white"><FileText className="size-4" />{detailIsOpen ? "Ocultar detalle" : "Ver detalle"}</button>
                      <button type="button" disabled={!invoiceAvailable} onClick={() => showOrderDetailView(order.id, "factura")} className="relative inline-flex h-10 items-center gap-2 rounded-lg border border-white/12 bg-[#181818] px-4 text-xs font-black text-white disabled:cursor-not-allowed disabled:text-[#A0A0A0]"><Download className="size-4" />{invoiceAvailable ? "Ver factura" : "Factura pendiente"}{showInvoiceNotification && <span className="absolute -right-1.5 -top-1.5"><CustomerInvoiceBell /></span>}</button>
                      {isTransferOrder && (hasProof ? <PaymentProofViewButton order={order} /> : <PaymentProofActionButton orderId={order.id} onUploaded={handlePaymentProofUploaded} className="inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-lg border border-white/12 bg-[#181818] px-4 text-xs font-black text-white disabled:opacity-60" />)}
                      {order.estado === "entregado" && <button type="button" aria-expanded={isExpanded && activeOrderView === "reclamo"} onClick={() => isExpanded && activeOrderView === "reclamo" ? toggleOrderDetails(order.id) : showClaimView(order.id)} className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-lg border border-white/12 bg-[#181818] px-4 text-xs font-black text-white"><MessageCircle className="size-4" />{isExpanded && activeOrderView === "reclamo" ? "Ocultar reclamo" : "Necesito ayuda"}</button>}
                    </div>
                    {hasMoreOptions && <div data-order-menu={order.id} className="relative z-10 w-fit lg:ml-auto"><button type="button" aria-expanded={openMoreOptionsId === order.id} onClick={() => setOpenMoreOptionsId((current) => current === order.id ? null : order.id)} className="inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-lg border border-white/12 bg-[#181818] px-4 text-xs font-black leading-none text-white"><span className="leading-none">Más opciones</span><span className="flex size-3.5 shrink-0 items-center justify-center"><ChevronDown className={`block size-3.5 transition-transform ${openMoreOptionsId === order.id ? "rotate-180" : ""}`} /></span></button>{openMoreOptionsId === order.id && <div className="absolute right-0 top-12 z-30 flex min-w-56 flex-col gap-1 rounded-xl border border-white/10 bg-[#181818] p-2 shadow-2xl shadow-black/60">{invoiceAvailable && <button type="button" disabled={downloadingInvoiceId === order.id} onClick={() => { setOpenMoreOptionsId(null); void handleDownloadInvoice(order.id) }} className="flex min-h-9 cursor-pointer items-center gap-2 rounded-lg px-3 text-left text-xs font-bold text-white hover:bg-[#112A43]"><Download className="size-4" />Descargar factura</button>}{isTransferOrder && hasProof && <PaymentProofActionButton orderId={order.id} initialUploaded onUploaded={(updatedOrder) => { setOpenMoreOptionsId(null); handlePaymentProofUploaded(updatedOrder) }} className="flex min-h-9 cursor-pointer items-center gap-2 rounded-lg px-3 text-left text-xs font-bold text-white hover:bg-[#112A43]" />}{trackingUrl && <a href={trackingUrl} target="_blank" rel="noreferrer" onClick={() => setOpenMoreOptionsId(null)} className="flex min-h-9 cursor-pointer items-center gap-2 rounded-lg px-3 text-xs font-bold text-white hover:bg-[#112A43]"><Truck className="size-4" />Seguimiento Andreani</a>}</div>}</div>}
                  </div>
                </div>

                {isExpanded && (
                  <div className="customer-order-detail border-t border-white/7 px-3 py-3 sm:px-4">
                    {activeOrderView === "factura" && (
                      <div className="mb-3 flex flex-col gap-3 rounded-xl border border-emerald-400/20 bg-emerald-400/8 p-3 sm:flex-row sm:items-center sm:justify-between">
                        <div>
                          <div className="flex items-center gap-2">
                            <p className="text-xs font-black uppercase tracking-widest text-emerald-300">
                              Factura electrónica
                            </p>
                          </div>
                          {order.invoice_status === "authorized" ? (
                            <>
                              <p className="mt-2 text-sm font-black text-white">
                                Tu factura ya está disponible.
                              </p>
                              <p className="mt-1 text-sm font-bold text-white/72">
                                Factura C{" "}
                                {formatCuentaInvoiceNumber(
                                  order.invoice_point,
                                  order.invoice_number,
                                )}
                              </p>
                            </>
                          ) : (
                            <p className="mt-1 text-sm font-bold text-white/68">
                              La factura todavía no está disponible para este pedido.
                            </p>
                          )}
                        </div>
                        {order.invoice_status === "authorized" && (
                          <button
                            type="button"
                            aria-label={"Descargar factura del pedido " + formatPublicOrderId(order.id)}
                            title="Descargar factura"
                            disabled={downloadingInvoiceId === order.id}
                            onClick={() => void handleDownloadInvoice(order.id)}
                            className="inline-flex h-9 cursor-pointer items-center justify-center gap-2 rounded-lg border border-emerald-400/30 bg-emerald-400/10 px-3 text-11px font-black uppercase tracking-wide text-emerald-200 transition-colors hover:bg-emerald-400/18 disabled:cursor-wait disabled:opacity-60"
                          >
                            <Download className="size-4" />
                            {downloadingInvoiceId === order.id
                              ? "Preparando..."
                              : "Descargar factura"}
                          </button>
                        )}
                      </div>
                    )}

                    {activeOrderView === "reclamo" && order.estado === "entregado" && (
                      <CustomerClaimExperience order={order} initialProblem={claimProblemByOrder[order.id]} />
                    )}

                    {activeOrderView === "detalle" && (
                      <>
                    <OrderProgressTimeline order={order} />
                    <OrderTrackingPanel order={order} />

                    <div className="mb-2 hidden grid-cols-account-order-item gap-4 px-3 xl:grid">
                      {[
                        "Producto",
                        "Color",
                        "Cantidad",
                        "Precio x un.",
                        "Subtotal",
                      ].map((label) => (
                        <span
                          key={label}
                          className={"text-11px font-bold uppercase tracking-widest text-white/38 " +
                            (label === "Producto" ? "text-left" : "text-center")}
                        >
                          {label}
                        </span>
                      ))}
                    </div>

                    <div className="space-y-3">
                      {items.map((item) => {
                        const quantity = Number(item.cantidad ?? 0)
                        const unitPrice = Number(item.precio ?? 0)
                        const subtotal = quantity * unitPrice
                        const productName =
                          item.productos?.nombre ?? "Producto #" + item.producto_id
                        const image = getCuentaItemImage(item)

                        return (
                          <div
                            key={item.id}
                            className="grid gap-4 rounded-xl border border-white/6 bg-black/35 p-3 sm:grid-cols-account-order-item sm:items-center"
                          >
                            <div className="flex items-center gap-3">
                              <div className="flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-white/8 bg-white">
                                {image ? (
                                  <img
                                    src={image}
                                    alt={productName}
                                    className="size-full object-contain"
                                  />
                                ) : (
                                  <ShoppingBag className="size-5 text-black/35" />
                                )}
                              </div>
                              <div className="min-w-0">
                                <p className="text-sm font-black text-white">
                                  {productName}
                                </p>
                                <p className="mt-1 text-xs text-white/48">
                                  Producto #{item.producto_id}
                                </p>
                              </div>
                            </div>

                            <div className="text-center">
                              <p className="text-11px font-bold uppercase tracking-widest text-white/38 xl:hidden">
                                Color
                              </p>
                              <p className="mt-1 text-sm font-black text-white">
                                {getCuentaItemColor(item)}
                              </p>
                            </div>

                            <div className="text-center">
                              <p className="text-11px font-bold uppercase tracking-widest text-white/38 xl:hidden">
                                Cantidad
                              </p>
                              <p className="mt-1 text-sm font-black text-white">
                                {quantity}
                              </p>
                            </div>

                            <div className="text-center">
                              <p className="text-11px font-bold uppercase tracking-widest text-white/38 xl:hidden">
                                Precio x un.
                              </p>
                              <p className="mt-1 text-sm font-black text-white">
                                {formatCuentaPrice(unitPrice)}
                              </p>
                            </div>

                            <div className="text-center">
                              <p className="text-11px font-bold uppercase tracking-widest text-white/38 xl:hidden">
                                Subtotal
                              </p>
                              <p className="mt-1 text-sm font-black text-white">
                                {formatCuentaPrice(subtotal)}
                              </p>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                    {order.estado === "entregado" && (
                      <DeliveredPurchaseHelp
                        order={order}
                        onClaim={(problem) => showClaimView(order.id, problem)}
                      />
                    )}
                      </>
                    )}
                  </div>
                )}
              </article>
            )
          })}
        </div>
      )}
    </AccountViewFrame>
  )
}

function ReadOnlyField({
  label,
  value,
  icon: Icon,
  help,
}: {
  label: string
  value: string
  icon: React.ElementType
  help?: string
}) {
  return (
    <div className="space-y-1.5">
      <label className="block text-xs font-semibold uppercase tracking-widest text-white/60">
        {label}
      </label>
      <div className="flex items-center gap-2 rounded-xl border border-white/5 bg-white/1 px-3.5 py-3">
        <Icon className="size-4 shrink-0 text-white/20" />
        <span className="truncate text-sm text-white/50">{value}</span>
      </div>
      {help && <p className="text-11px text-white/25">{help}</p>}
    </div>
  )
}

type DeliveryAddressDraft = {
  codigoPostal: string
  calle: string
  numero: string
  piso?: string
  departamento?: string
  localidad: string
  region: string
  pais: "Argentina"
  componentesDeDireccion: []
}

function splitLegacyAddress(value: string) {
  const cleanValue = value.trim()
  const match = cleanValue.match(/^(.*?)(\d+[a-zA-Z]?)\b(.*)$/)

  if (!match) {
    return {
      street: cleanValue,
      number: "",
    }
  }

  return {
    street: match[1].replace(/[,\s]+$/, "").trim(),
    number: match[2].trim(),
  }
}

function parseProfileAddress(
  value: string,
  province?: string,
  postalCode?: string
) {
  const parts = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
  const baseAddress = splitLegacyAddress(parts[0] ?? value)
  let floor = ""
  let apartment = ""
  let locality = ""

  for (const part of parts.slice(1)) {
    if (/^piso\s+/i.test(part)) {
      floor = part.replace(/^piso\s+/i, "").trim()
      continue
    }

    if (/^depto\s+/i.test(part)) {
      apartment = part.replace(/^depto\s+/i, "").trim()
      continue
    }

    if (province && part.toLowerCase() === province.toLowerCase()) {
      continue
    }

    if (postalCode && part.toLowerCase() === `cp ${postalCode}`.toLowerCase()) {
      continue
    }

    if (!locality) {
      locality = part
    }
  }

  return {
    ...baseAddress,
    floor,
    apartment,
    locality,
  }
}

function buildDeliveryAddressDraft({
  postalCode,
  street,
  streetNumber,
  floor,
  apartment,
  locality,
  province,
}: {
  postalCode: string
  street: string
  streetNumber: string
  floor: string
  apartment: string
  locality: string
  province: string
}): DeliveryAddressDraft {
  return {
    codigoPostal: postalCode.trim(),
    calle: street.trim(),
    numero: streetNumber.trim(),
    piso: floor.trim() || undefined,
    departamento: apartment.trim() || undefined,
    localidad: locality.trim(),
    region: province.trim(),
    pais: "Argentina",
    componentesDeDireccion: [],
  }
}

function formatDeliveryAddressForProfile(address: DeliveryAddressDraft) {
  const optionalParts = [
    address.piso ? `Piso ${address.piso}` : "",
    address.departamento ? `Depto ${address.departamento}` : "",
  ].filter(Boolean)

  return [
    `${address.calle} ${address.numero}`,
    ...optionalParts,
    address.localidad,
    address.region,
    `CP ${address.codigoPostal}`,
  ].join(", ")
}

function validateDeliveryAddress(address: DeliveryAddressDraft) {
  if (!address.calle) return "Introduce la calle."
  if (!address.numero) return "Introduce el número de calle."
  if (!/^\d{4,8}$/.test(address.codigoPostal)) {
    return "El código postal debe tener entre 4 y 8 números."
  }
  if (!address.localidad) return "Introduce la localidad."
  if (!address.region) return "Seleccioná una provincia válida."

  const commonPattern = /^[\p{L}\p{M}0-9\s.,'°/-]+$/u
  const values = [
    address.calle,
    address.numero,
    address.piso ?? "",
    address.departamento ?? "",
    address.localidad,
  ].filter(Boolean)

  if (values.some((value) => !commonPattern.test(value))) {
    return "La dirección contiene caracteres no permitidos."
  }

  return ""
}

function validateAccountPassword(password: string) {
  return validatePassword(password)
}

function ChangePasswordForm() {
  const { user } = useAuth()
  const [currentPassword, setCurrentPassword] = useState("")
  const [newPassword, setNewPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [showCurrent, setShowCurrent] = useState(false)
  const [showNew, setShowNew] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [success, setSuccess] = useState("")

  const handleSubmit = async () => {
    setError("")
    setSuccess("")

    if (!user?.email) {
      setError("No se pudo validar el email de la cuenta.")
      return
    }

    if (!currentPassword) {
      setError("Introduce tu contraseña actual.")
      return
    }

    const passwordError = validateAccountPassword(newPassword)

    if (passwordError) {
      setError(passwordError)
      return
    }

    if (newPassword !== confirmPassword) {
      setError("Las contraseñas nuevas no coinciden.")
      return
    }

    if (currentPassword === newPassword) {
      setError("La nueva contraseña debe ser distinta a la actual.")
      return
    }

    setLoading(true)

    const {
      data: authUserData,
      error: authUserError,
    } = await supabase.auth.getUser()

    if (authUserError) {
      setLoading(false)
      setError("No se pudo validar la sesión. Inténtalo de nuevo.")
      return
    }

    const lastPasswordChangedAt =
      authUserData.user?.user_metadata
        ?.last_password_change_at

    if (
      typeof lastPasswordChangedAt === "string" &&
      Number.isFinite(new Date(lastPasswordChangedAt).getTime()) &&
      Date.now() -
        new Date(lastPasswordChangedAt).getTime() <
        PASSWORD_CHANGE_COOLDOWN_MS
    ) {
      setLoading(false)
      setError(getPasswordCooldownMessage(lastPasswordChangedAt))
      return
    }

    const { error: verifyError } =
      await supabase.auth.signInWithPassword({
        email: user.email,
        password: currentPassword,
      })

    if (verifyError) {
      setLoading(false)
      setError("La contraseña actual no es correcta.")
      return
    }

    const { error: updateError } =
      await supabase.auth.updateUser({
        password: newPassword,
        data: {
          ...authUserData.user?.user_metadata,
          last_password_change_at: new Date().toISOString(),
        },
      })

    setLoading(false)

    if (updateError) {
      setError("No se pudo actualizar la contraseña. Inténtalo de nuevo.")
      return
    }

    setCurrentPassword("")
    setNewPassword("")
    setConfirmPassword("")
    setSuccess("Contraseña actualizada correctamente.")
    setTimeout(() => setSuccess(""), 3500)
  }

  return (
    <div className="space-y-4">
      <InputField
        label="Contraseña actual"
        type={showCurrent ? "text" : "password"}
        value={currentPassword}
        onChange={setCurrentPassword}
        placeholder="Contraseña actual"
        icon={Lock}
        maxLength={FIELD_LIMITS.password}
        rightElement={
          <button
            type="button"
            aria-label="Mostrar u ocultar contraseña actual"
            title="Mostrar u ocultar contraseña actual"
            onClick={() => setShowCurrent((value) => !value)}
            className="cursor-pointer text-white/40 transition-colors hover:text-white/70"
          >
            {showCurrent ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        }
      />

      <InputField
        label="Nueva contraseña"
        type={showNew ? "text" : "password"}
        value={newPassword}
        onChange={setNewPassword}
        placeholder="Mínimo 8 caracteres"
        icon={Lock}
        maxLength={FIELD_LIMITS.password}
        rightElement={
          <button
            type="button"
            aria-label="Mostrar u ocultar nueva contraseña"
            title="Mostrar u ocultar nueva contraseña"
            onClick={() => setShowNew((value) => !value)}
            className="cursor-pointer text-white/40 transition-colors hover:text-white/70"
          >
            {showNew ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        }
      />

      <InputField
        label="Confirmar nueva contraseña"
        type={showConfirm ? "text" : "password"}
        value={confirmPassword}
        onChange={setConfirmPassword}
        placeholder="Repetí la nueva contraseña"
        icon={Lock}
        maxLength={FIELD_LIMITS.password}
        rightElement={
          <button
            type="button"
            aria-label="Mostrar u ocultar confirmación"
            title="Mostrar u ocultar confirmación"
            onClick={() => setShowConfirm((value) => !value)}
            className="cursor-pointer text-white/40 transition-colors hover:text-white/70"
          >
            {showConfirm ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        }
      />

      <div className="rounded-xl border border-white/7 bg-white/2 px-4 py-3">
        <p className="text-xs font-semibold uppercase tracking-widest text-white/45">
          Requisitos
        </p>
        <p className="mt-2 text-sm leading-6 text-white/55">
          Mínimo 8 caracteres, una mayúscula y al menos un número. Puede cambiarse una vez cada 15 días.
        </p>
      </div>

      {error && (
        <div className="rounded-xl border border-red-500/20 bg-red-500/8 px-4 py-3">
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      {success && (
        <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/8 px-4 py-3">
          <p className="text-sm text-emerald-400">{success}</p>
        </div>
      )}

      <button
        type="button"
        aria-label="Cambiar contraseña"
        title="Cambiar contraseña"
        disabled={loading}
        onClick={handleSubmit}
        className="h-11 w-full cursor-pointer rounded-xl border border-beyonix-blue-light/60 bg-beyonix-blue text-sm font-semibold text-white transition-colors hover:bg-beyonix-blue-light disabled:opacity-50"
      >
        {loading ? "Validando..." : "Cambiar contraseña"}
      </button>
    </div>
  )
}

function Seguridad({ onBack }: { onBack: () => void }) {
  return (
    <AccountViewFrame
      onBack={onBack}
      kicker="Seguridad"
      title="Cambiar contraseña"
      maxWidth="max-w-4xl"
    >
      <div className="rounded-2xl border border-white/7 bg-beyonix-surface p-6">
        <ChangePasswordForm />
      </div>
    </AccountViewFrame>
  )
}

function uppercaseAccountText(value: string) {
  return value.toLocaleUpperCase("es-AR")
}

function nonEmptyAccountText(value: string | undefined) {
  const trimmed = value?.trim()

  return trimmed ? trimmed : undefined
}

function MisDatos({ onBack }: { onBack: () => void }) {
  const { user, updateUser } = useAuth()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [phone, setPhone] = useState(user?.phone ?? "")
  const [province, setProvince] = useState(
    uppercaseAccountText(nonEmptyAccountText(user?.province) ?? "")
  )
  const [postalCode, setPostalCode] = useState(user?.postalCode ?? "")
  const [street, setStreet] = useState(
    uppercaseAccountText(nonEmptyAccountText(user?.street) ?? "")
  )
  const [streetNumber, setStreetNumber] = useState(
    user?.streetNumber ?? ""
  )
  const [floor, setFloor] = useState(
    uppercaseAccountText(nonEmptyAccountText(user?.floor) ?? "")
  )
  const [apartment, setApartment] = useState(
    uppercaseAccountText(
      nonEmptyAccountText(user?.apartment) ?? ""
    )
  )
  const [locality, setLocality] = useState(
    uppercaseAccountText(nonEmptyAccountText(user?.city) ?? "")
  )
  const [references, setReferences] = useState(
    uppercaseAccountText(user?.references ?? "")
  )
  const [avatarUrl, setAvatarUrl] = useState(user?.avatarUrl ?? "")
  const [saved, setSaved] = useState(false)
  const [profileError, setProfileError] = useState("")
  const [avatarLoading, setAvatarLoading] = useState(false)
  const [avatarError, setAvatarError] = useState("")
  const formSignature = [
    phone,
    province,
    postalCode,
    street,
    streetNumber,
    floor,
    apartment,
    locality,
    references,
  ].join("|")
  const savedSignatureRef = useRef("")

  useEffect(() => {
    setPhone(user?.phone ?? "")
    setProvince(uppercaseAccountText(nonEmptyAccountText(user?.province) ?? ""))
    setPostalCode(user?.postalCode ?? "")
    setStreet(
      uppercaseAccountText(nonEmptyAccountText(user?.street) ?? "")
    )
    setStreetNumber(user?.streetNumber ?? "")
    setFloor(
      uppercaseAccountText(nonEmptyAccountText(user?.floor) ?? "")
    )
    setApartment(
      uppercaseAccountText(
        nonEmptyAccountText(user?.apartment) ?? ""
      )
    )
    setLocality(
      uppercaseAccountText(nonEmptyAccountText(user?.city) ?? "")
    )
    setReferences(uppercaseAccountText(user?.references ?? ""))
    setAvatarUrl(user?.avatarUrl ?? "")
  }, [user])

  useEffect(() => {
    if (saved && savedSignatureRef.current !== formSignature) {
      setSaved(false)
    }
  }, [formSignature, saved])

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    setProfileError("")

    const validationError = validateProfilePayload({
      name: user?.name ?? "",
      phone,
      calle: street,
      numero: streetNumber,
      piso: floor,
      departamento: apartment,
      localidad: locality,
      province,
      postalCode,
      references,
    })

    if (validationError) {
      setProfileError(validationError)
      return
    }

    const deliveryAddress = buildDeliveryAddressDraft({
      postalCode,
      street,
      streetNumber,
      floor,
      apartment,
      locality,
      province,
    })
    const deliveryError = validateDeliveryAddress(deliveryAddress)

    if (deliveryError) {
      setProfileError(deliveryError)
      return
    }

    try {
      const normalizedProvince = uppercaseAccountText(province.trim())
      const normalizedStreet = uppercaseAccountText(street.trim())
      const normalizedFloor = uppercaseAccountText(floor.trim())
      const normalizedApartment = uppercaseAccountText(apartment.trim())
      const normalizedLocality = uppercaseAccountText(locality.trim())
      const normalizedReferences = uppercaseAccountText(references.trim())
      await updateUser({
        phone,
        province: normalizedProvince,
        street: normalizedStreet,
        streetNumber,
        floor: normalizedFloor,
        apartment: normalizedApartment,
        city: normalizedLocality,
        postalCode,
        references: normalizedReferences,
      })
      savedSignatureRef.current = [
        phone,
        normalizedProvince,
        postalCode,
        normalizedStreet,
        streetNumber,
        normalizedFloor,
        normalizedApartment,
        normalizedLocality,
        normalizedReferences,
      ].join("|")
      setSaved(true)
    } catch {
      setProfileError("No hemos podido guardar tus datos. Inténtalo de nuevo.")
    }
  }

  const handleAvatarChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]

    if (!file || !user) return

    if (!file.type.startsWith("image/")) {
      setAvatarError("Sube una imagen válida.")
      return
    }

    if (file.size > 2 * 1024 * 1024) {
      setAvatarError("La imagen no puede superar los 2 MB.")
      return
    }

    setAvatarLoading(true)
    setAvatarError("")

    const fileExt = file.name.split(".").pop() || "jpg"
    const filePath = `${user.id}/avatar.${fileExt}`

    const { error: uploadError } = await supabase.storage
      .from("avatars")
      .upload(filePath, file, {
        cacheControl: "3600",
        upsert: true,
      })

    if (uploadError) {
      setAvatarLoading(false)
      setAvatarError(
        "No se pudo subir la foto. Revisá que el SQL 09-profile-avatar esté aplicado."
      )
      return
    }

    const {
      data: { publicUrl },
    } = supabase.storage.from("avatars").getPublicUrl(filePath)

    await updateUser({ avatarUrl: publicUrl })
    setAvatarUrl(publicUrl)
    setAvatarLoading(false)
  }

  return (
    <AccountViewFrame
      onBack={onBack}
      kicker="Mis datos"
      title="Datos de la cuenta"
      maxWidth="max-w-4xl"
    >
      <div className="rounded-2xl border border-white/7 bg-beyonix-surface p-4 sm:p-5">
        <form onSubmit={handleSave} className="space-y-4">
          <div className="flex items-center gap-3 rounded-xl border border-white/7 bg-white/2 p-3">
            <div className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-full border border-white/12 bg-white text-black">
              {avatarUrl ? (
                <img src={avatarUrl} alt="" className="size-full object-cover" />
              ) : (
                <User className="size-9" />
              )}
            </div>

            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-white">Foto de perfil</p>
              <p className="mt-0.5 text-xs text-white/45">
                JPG o PNG, hasta 2 MB.
              </p>
              {avatarError && (
                <p className="mt-2 text-xs text-red-400">{avatarError}</p>
              )}
            </div>

            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handleAvatarChange}
              className="hidden"
              title="Cambiar foto de perfil"
              aria-label="Cambiar foto de perfil"
            />

            <button
              type="button"
              aria-label="Subir foto de perfil"
              title="Subir foto de perfil"
              onClick={() => fileInputRef.current?.click()}
              disabled={avatarLoading}
              className="flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-white/10 text-white/70 transition-colors hover:border-white/22 hover:text-white disabled:opacity-50"
            >
              <Camera className="size-4" />
            </button>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <ReadOnlyField
              label="Nombre de usuario"
              value={uppercaseAccountText(user?.username ?? "")}
              icon={User}
              help="El nombre de usuario no se puede cambiar."
            />
            <ReadOnlyField
              label="Email"
              value={user?.email || ""}
              icon={Mail}
              help="El email no se puede cambiar."
            />

            <ReadOnlyField
              label="Nombre y apellido"
              value={uppercaseAccountText(user?.name ?? "")}
              icon={User}
              help="El nombre y apellido no se pueden cambiar."
            />
            <InputField label="Teléfono móvil" type="tel" value={phone} onChange={(value) => setPhone(onlyDigits(value, FIELD_LIMITS.phone))} placeholder="1100000000" icon={Phone} maxLength={FIELD_LIMITS.phone} inputMode="numeric" />
          </div>

          <div className="rounded-2xl border border-beyonix-blue-light/12 bg-black/30 p-3">
            <div className="mb-3">
              <p className="text-11px font-semibold uppercase tracking-widest text-beyonix-cyan">
                Dirección de entrega
              </p>
              <p className="mt-1 text-xs leading-5 text-white/42">
                Estos datos ayudan a preparar futuros envíos a domicilio con Andreani.
              </p>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <InputField label="Calle" type="text" value={street} onChange={(value) => setStreet(uppercaseAccountText(value))} placeholder="San Martín" icon={MapPin} maxLength={60} />
              <InputField label="Número" type="text" value={streetNumber} onChange={(value) => setStreetNumber(onlyDigits(value, 8))} placeholder="1234" icon={Hash} maxLength={8} inputMode="numeric" />
              <InputField label="Piso opcional" type="text" value={floor} onChange={(value) => setFloor(uppercaseAccountText(value))} placeholder="3" icon={Hash} maxLength={12} />
              <InputField label="Departamento opcional" type="text" value={apartment} onChange={(value) => setApartment(uppercaseAccountText(value))} placeholder="B" icon={Hash} maxLength={12} />
              <InputField label="Código postal" type="tel" value={postalCode} onChange={(value) => setPostalCode(onlyDigits(value, FIELD_LIMITS.postalCode))} placeholder="2000" icon={Hash} maxLength={FIELD_LIMITS.postalCode} inputMode="numeric" />
              <InputField label="Localidad" type="text" value={locality} onChange={(value) => setLocality(uppercaseAccountText(value))} placeholder="Rosario" icon={MapPin} maxLength={60} />
              <div className="space-y-1.5">
                <label className="block text-xs font-semibold uppercase tracking-widest text-white/60">
                  Provincia / Región
                </label>
                <ProvinceSelect value={province} onChange={(value) => setProvince(uppercaseAccountText(value))} />
              </div>
              <div className="md:col-span-2">
                <TextareaField
                  label="Referencias para llegar"
                  value={references}
                  onChange={(value) => setReferences(uppercaseAccountText(value))}
                  placeholder="Entre calles, fachada blanca, portón negro, antes de llegar a la esquina."
                  icon={MapPin}
                  maxLength={FIELD_LIMITS.references}
                />
              </div>
            </div>
          </div>

          {profileError && (
            <div className="rounded-xl border border-red-500/20 bg-red-500/8 px-4 py-3">
              <p className="text-sm text-red-400">{profileError}</p>
            </div>
          )}

          <button
            type="submit"
            aria-label="Guardar cambios"
            title="Guardar cambios"
            className={`flex h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-xl border text-sm font-semibold text-white transition-colors ${
              saved
                ? "border-emerald-400/60 bg-emerald-600 hover:bg-emerald-600"
                : "border-beyonix-blue-light/60 bg-beyonix-blue hover:bg-beyonix-blue-light"
            }`}
          >
            {saved ? (
              <>
                <Check className="size-4" />
                Guardado
              </>
            ) : (
              "Guardar cambios"
            )}
          </button>
        </form>
      </div>
    </AccountViewFrame>
  )
}

function ProfilePanel({ initialView }: { initialView: ProfileView }) {
  const { user, logout, isInternal } = useAuth()
  const router = useRouter()
  const [view, setView] = useState<ProfileView>(initialView)

  useEffect(() => {
    setView(initialView)
  }, [initialView])

  if (!user) return null

  const goToView = (nextView: ProfileView) => {
    setView(nextView)

    router.replace(
      nextView === "home"
        ? "/cuenta"
        : `/cuenta?tab=${nextView}`,
      { scroll: false }
    )
  }

  if (view === "ordenes") return <MisOrdenes onBack={() => goToView("home")} />
  if (view === "datos") return <MisDatos onBack={() => goToView("home")} />
  if (view === "seguridad") return <Seguridad onBack={() => goToView("home")} />

  const menuItems = [
    { icon: ShoppingBag, label: "Mis compras", sub: "Historial de compras", view: "ordenes" as ProfileView },
    { icon: User, label: "Mis datos", sub: "Nombre, email y dirección", view: "datos" as ProfileView },
    { icon: Lock, label: "Seguridad", sub: "Contraseña y acceso", view: "seguridad" as ProfileView },
  ]

  return (
    <div className="mx-auto max-w-md space-y-6">
      <div className="flex items-center gap-4 p-5 rounded-2xl border border-white/7 bg-white/2">
        <div className="flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-full border border-white/12 bg-white text-black">
          {user.avatarUrl ? (
            <img src={user.avatarUrl} alt="" className="size-full object-cover" />
          ) : (
            <User className="size-8" />
          )}
        </div>
        <div className="min-w-0">
          <p className="font-semibold text-white truncate">{user.name}</p>
          <p className="text-sm text-white/55 truncate">{user.email}</p>
          <p className="mt-1 text-11px text-beyonix-cyan font-medium">Cliente BEYONIX</p>
        </div>
      </div>

      <div className="space-y-2">
        {menuItems.map((item) => (
          <button
            key={item.label}
            type="button"
            aria-label={item.label}
            title={item.label}
            onClick={() => goToView(item.view)}
            className="w-full flex items-center gap-4 p-4 rounded-xl border border-white/6 bg-white/2 hover:bg-white/4 hover:border-white/10 transition-all group cursor-pointer text-left"
          >
            <div className="size-9 rounded-lg bg-beyonix-blue/50 border border-beyonix-blue-light/30 flex items-center justify-center shrink-0">
              <item.icon className="size-4 text-beyonix-cyan" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-white">{item.label}</p>
              <p className="text-xs text-white/50">{item.sub}</p>
            </div>
            <ChevronRight className="size-4 text-white/25 group-hover:text-white/60 transition-colors shrink-0" />
          </button>
        ))}
      </div>

      {isInternal && (
        <button
          type="button"
          aria-label="Ir al panel admin"
          title="Ir al panel admin"
          onClick={() => router.push("/admin")}
          className="w-full flex items-center gap-4 p-4 rounded-xl border border-beyonix-blue-light/25 bg-beyonix-account hover:bg-beyonix-blue hover:border-beyonix-blue-light/50 transition-all group cursor-pointer text-left"
        >
          <div className="size-9 rounded-lg bg-beyonix-blue/60 border border-beyonix-blue-light/40 flex items-center justify-center shrink-0">
            <Shield className="size-4 text-beyonix-cyan" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-white">Panel administrador</p>
            <p className="text-xs text-white/55">Gestión de tienda</p>
          </div>
          <ChevronRight className="size-4 text-white/25 group-hover:text-white/70 transition-colors shrink-0" />
        </button>
      )}

      <button
        type="button"
        aria-label="Cerrar sesión"
        title="Cerrar sesión"
        onClick={() => { logout(); router.push("/") }}
        className="w-full flex items-center justify-center gap-2 h-11 rounded-xl border border-white/8 text-sm font-medium text-white/60 hover:text-white hover:border-white/20 transition-all cursor-pointer"
      >
        <LogOut className="size-4" />
        Cerrar sesión
      </button>
    </div>
  )
}

export function CuentaClient() {
  const { user, isLoading } = useAuth()
  const [tab, setTab] = useState<"login" | "register">("login")
  const searchParams = useSearchParams()

  const tabParam = searchParams.get("tab") as ProfileView | null
  const initialView: ProfileView =
    tabParam === "ordenes" ||
    tabParam === "datos" ||
    tabParam === "seguridad"
      ? tabParam
      : "home"

  useEffect(() => {
    if (user) setTab("login")
  }, [user])

  useEffect(() => {
    if (isLoading || user) return

    window.location.replace("/login?redirect=/cuenta")
  }, [isLoading, user])

  if (isLoading) {
    return (
      <main className="min-h-screen bg-black flex items-center justify-center pt-20">
        <div className="size-8 rounded-full border-2 border-white/10 border-t-white/60 animate-spin" />
      </main>
    )
  }

  if (!user) {
    return (
      <main className="min-h-screen bg-black flex items-center justify-center pt-20">
        <div className="size-8 rounded-full border-2 border-white/10 border-t-white/60 animate-spin" />
      </main>
    )
  }

  return (
    <main className="min-h-screen bg-black pt-20">
      <div className="account-page container mx-auto max-w-7xl px-4 py-8 lg:py-10">
        {user ? (
          <>
            {initialView !== "ordenes" && <div className="account-welcome mb-8">
              <p className="text-11px font-semibold uppercase tracking-widest text-beyonix-cyan mb-2">
                Mi cuenta
              </p>
              <h1 className="text-2xl font-bold text-white tracking-tight">
                Hola, {(user.username || user.name.split(" ")[0]).toUpperCase()}
              </h1>
            </div>}
            <ProfilePanel initialView={initialView} />
          </>
        ) : null}
        {false && (
          <>
            <div className="mb-8 text-center">
              <p className="text-11px font-semibold uppercase tracking-widest text-beyonix-cyan mb-2">
                Mi cuenta
              </p>
              <h1 className="text-2xl font-bold text-white tracking-tight mb-1">
                {tab === "login" ? "Bienvenido de vuelta" : "Creá tu cuenta"}
              </h1>
              <p className="text-sm text-white/50">
                {tab === "login"
                  ? "Inicia sesión para ver tus compras y datos."
                  : "Registrate para comprar en BEYONIX."}
              </p>
            </div>

            <div className="flex rounded-xl border border-white/7 bg-white/2 p-1 mb-7">
              {(["login", "register"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-label={value === "login" ? "Iniciar sesión" : "Registrarse"}
                  title={value === "login" ? "Iniciar sesión" : "Registrarse"}
                  onClick={() => setTab(value)}
                  className={`flex-1 py-2.5 rounded-lg text-sm font-semibold transition-all cursor-pointer ${
                    tab === value
                      ? "bg-beyonix-blue border border-beyonix-blue-light/60 text-white shadow-sm"
                      : "text-white/50 hover:text-white/80"
                  }`}
                >
                  {value === "login" ? "Iniciar sesión" : "Registrarse"}
                </button>
              ))}
            </div>

            <div className="rounded-2xl border border-white/7 bg-beyonix-surface p-6">
              {tab === "login" ? (
                <LoginForm onSwitch={() => setTab("register")} />
              ) : (
                <RegisterForm onSwitch={() => setTab("login")} />
              )}
            </div>
          </>
        )}
      </div>
    </main>
  )
}
