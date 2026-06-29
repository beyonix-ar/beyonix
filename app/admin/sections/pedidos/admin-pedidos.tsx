"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  CheckCircle2,
  ChevronDown,
  Clock3,
  CreditCard,
  Download,
  Eye,
  FileText,
  Info,
  LoaderCircle,
  Printer,
  RefreshCw,
  Search,
  ShoppingCart,
  Truck,
  Trash2,
  X,
} from "lucide-react"

import { useAuth } from "@/context/auth-context"
import { usePedidos } from "@/hooks/use-pedidos"
import { AdminClaimManager } from "@/components/claims/admin-claim-manager"
import { parseDeliveryAddress } from "@/lib/delivery-address"
import {
  getOrderClaimResolutionLabel,
  getOrderClaimStatusLabel,
  getOrderClaimTypeLabel,
} from "@/lib/order-claims"
import {
  getAdminOrderLastSeenAt,
  getSupabaseErrorDetails,
  hasOrderAttentionAfter,
  isOrderNewerThanLastSeen,
  orderHasPendingClaimAction,
  markOrdersSeenAndGetPreviousLastSeen,
  notifyOrderNotificationsChanged,
} from "@/lib/admin/order-notifications"
import { supabase } from "@/lib/supabase/client"
import {
  isAdminPaymentProofSeen,
  markAdminPaymentProofSeen,
} from "@/lib/admin/order-event-views"
import { markAdminClaimNotificationsRead } from "@/lib/admin/admin-notifications"
import {
  ADMIN_SENSITIVE_DANGER,
  isAdminSensitiveStatus,
} from "@/lib/admin/admin-sensitive-visuals"
import type {
  OrderClaimResolution,
  OrderClaimStatus,
  SupabaseOrderClaim,
  SupabasePedido,
} from "@/lib/supabase/types"
import { AdminSelect, AdminTextInput } from "../../components/admin-controls"
import { formatPrice } from "../productos/helpers"

type StatusFilter =
  | "todos"
  | "pendiente"
  | "pagado"
  | "enviado"
  | "en_camino"
  | "entregado"
  | "cancelado"
  | "refund_pending"
  | "refunded"
  | "rechazado"
type AndreaniAction = "crear-envio" | "tracking"
type AdminNotice = { type: "ok" | "error"; message: string } | null
type ForcedStatusRequest = {
  pedido: SupabasePedido
  nextEstado: "en_camino" | "entregado"
} | null
type TrackingStatusRequest = {
  pedido: SupabasePedido
  nextEstado: string
} | null
type AdminOrderDetailView =
  | "resumen"
  | "pago"
  | "envio"
  | "facturacion"
  | "reclamos"
  | "cancelacion"

type PaymentStatusValue =
  | "pendiente_comprobante"
  | "en_revision"
  | "confirmado"
  | "rechazado"

const PAYMENT_STATUS_OPTIONS: Array<{
  value: PaymentStatusValue
  label: string
  tone: string
  dot: string
}> = [
  {
    value: "pendiente_comprobante",
    label: "Pendiente",
    tone: "text-white/82",
    dot: "bg-amber-300/70",
  },
  {
    value: "en_revision",
    label: "En revisión",
    tone: "text-white/82",
    dot: "bg-blue-300/70",
  },
  {
    value: "confirmado",
    label: "Confirmado",
    tone: "text-white/82",
    dot: "bg-emerald-300/70",
  },
  {
    value: "rechazado",
    label: "Comprobante rechazado",
    tone: "text-white/82",
    dot: "bg-red-300/70",
  },
]

const ADMIN_ORDER_DETAIL_VIEWS: AdminOrderDetailView[] = [
  "resumen",
  "pago",
  "envio",
  "facturacion",
  "reclamos",
  "cancelacion",
]

function getAdminOrderDetailView(value: string | null): AdminOrderDetailView {
  return ADMIN_ORDER_DETAIL_VIEWS.includes(value as AdminOrderDetailView)
    ? (value as AdminOrderDetailView)
    : "resumen"
}

function formatOrderDate(value: string) {
  return new Intl.DateTimeFormat("es-AR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "America/Argentina/Buenos_Aires",
  }).format(new Date(value))
}

function formatOrderDateParts(value: string) {
  const date = new Date(value)

  return {
    date: new Intl.DateTimeFormat("es-AR", {
      dateStyle: "short",
      timeZone: "America/Argentina/Buenos_Aires",
    }).format(date),
    time: new Intl.DateTimeFormat("es-AR", {
      timeStyle: "short",
      timeZone: "America/Argentina/Buenos_Aires",
    }).format(date),
  }
}

function formatPublicOrderId(id: number) {
  return `BX-${1000 + id}`
}

function formatPublicOrderNumber(id: number) {
  return String(1000 + id)
}

function getOrderUsername(pedido: SupabasePedido) {
  if (pedido.cliente_username?.trim()) return pedido.cliente_username.trim()

  const emailUsername = pedido.cliente_email?.split("@")[0]?.trim()
  if (emailUsername) return emailUsername

  return "Usuario"
}

function getPedidoClientKey(pedido: SupabasePedido) {
  return (
    pedido.cliente_email ||
    pedido.cliente_telefono ||
    pedido.usuario_id ||
    pedido.cliente_nombre ||
    `pedido-${pedido.id}`
  )
    .trim()
    .toLowerCase()
}

function getItemColor(item: NonNullable<SupabasePedido["orden_items"]>[number]) {
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

function getItemImage(item: NonNullable<SupabasePedido["orden_items"]>[number]) {
  return (
    item.producto_variantes?.imagenes?.[0] ||
    item.productos?.imagen_principal ||
    item.productos?.imagenes_producto?.[0]?.url ||
    ""
  )
}

function getShippingProvider(pedido: SupabasePedido) {
  const provider = pedido.envio_proveedor?.trim() || "Andreani"

  return provider.replace(/andreani/gi, "Andreani")
}

function normalizePlaceName(value?: string | null) {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
}

function isRosarioOrder(pedido: SupabasePedido) {
  return normalizePlaceName(pedido.localidad) === "rosario"
}

function isAndreaniShippingOrder(pedido: SupabasePedido) {
  const provider = normalizePlaceName(
    pedido.envio_proveedor ?? pedido.shipping_provider
  )

  return (
    provider.includes("andreani") ||
    Boolean(
      pedido.andreani_envio_id ||
        pedido.andreani_tracking ||
        pedido.andreani_etiqueta_url
    )
  )
}

function isLocalRosarioDeliveryOrder(pedido: SupabasePedido) {
  return isRosarioOrder(pedido) && !isAndreaniShippingOrder(pedido)
}

function getAndreaniStatus(pedido: SupabasePedido) {
  return pedido.andreani_estado || "Sin envío generado"
}

function getPaymentMethodLabel(pedido: SupabasePedido) {
  if (pedido.payment_method_id === "transferencia") {
    return "Transferencia bancaria"
  }

  if (pedido.payment_method_id === "mercadopago") {
    return "Mercado Pago"
  }

  if (pedido.payment_method_id || pedido.payment_type_id) return "Otro"

  return "No informado"
}

function getCompactPaymentMethodLabel(pedido: SupabasePedido) {
  if (pedido.payment_method_id === "transferencia") return "Transferencia"
  if (pedido.payment_method_id === "mercadopago" || pedido.payment_id) {
    return "Mercado Pago"
  }

  return getPaymentMethodLabel(pedido)
}

function isTransferOrder(pedido: SupabasePedido) {
  return pedido.payment_method_id === "transferencia"
}

function isOrderPaymentConfirmed(pedido: SupabasePedido) {
  return (
    Boolean(pedido.paid_at) ||
    Number(pedido.payment_confirmed_amount ?? 0) > 0 ||
    pedido.payment_status === "confirmado" ||
    pedido.payment_status === "approved" ||
    pedido.payment_status === "confirmed" ||
    ["pagado", "enviado", "en_camino", "entregado"].includes(pedido.estado)
  )
}

function isRefundPaymentAttentionOrder(pedido: SupabasePedido) {
  if (pedido.financial_status === "refunded") return false
  if (pedido.financial_status === "refund_pending") return true

  if (pedido.financial_status === "cancellation_requested") {
    return isOrderPaymentConfirmed(pedido)
  }

  return pedido.estado === "cancelado" && isOrderPaymentConfirmed(pedido)
}

function needsInvoiceReminder(pedido: SupabasePedido) {
  return (
    pedido.estado !== "cancelado" &&
    !["cancelled", "cancellation_requested", "refund_pending", "refunded"].includes(
      pedido.financial_status ?? "",
    ) &&
    !isRejectedPayment(pedido.payment_status) &&
    isOrderPaymentConfirmed(pedido) &&
    pedido.invoice_status !== "authorized" &&
    Number(pedido.total ?? 0) > 0
  )
}

function needsShippingReminder(pedido: SupabasePedido) {
  if (isRefundPaymentAttentionOrder(pedido)) return false

  return (
    !["cancelled", "cancellation_requested", "refund_pending", "refunded"].includes(
      pedido.financial_status ?? "",
    ) &&
    pedido.invoice_status === "authorized" &&
    Boolean(pedido.invoice_cae) &&
    ![
      "preparado",
      "enviado",
      "en_camino",
      "entregado",
      "cancelado",
      "rechazado",
    ].includes(pedido.estado ?? "")
  )
}

function isVisibleAdminOrder(pedido: SupabasePedido) {
  return Number.isFinite(pedido.id)
}

function getPaymentStatusLabel(status?: string | null) {
  const labels: Record<string, string> = {
    pendiente_comprobante: "Falta comprobante",
    en_revision: "Comprobante en revisión",
    confirmado: "Confirmado",
    rechazado: "Comprobante rechazado",
    approved: "Aprobado",
    pending: "Pendiente",
    rejected: "Comprobante rechazado",
  }

  return status ? labels[status] ?? status : "Sin estado"
}

function isRejectedPayment(status?: string | null) {
  return status === "rechazado" || status === "rejected"
}

function getDisplayedOrderStatus(pedido: SupabasePedido) {
  if (pedido.financial_status === "refund_pending") return "refund_pending"
  if (pedido.financial_status === "refunded") return "refunded"
  if (!isTransferOrder(pedido)) return pedido.estado
  if (isRejectedPayment(pedido.payment_status)) return "rechazado"
  if (
    pedido.payment_status === "confirmado" ||
    pedido.payment_status === "approved"
  ) {
    return "pagado"
  }
  return "pendiente"
}

function getCurrentOrderStatusForHeader(pedido: SupabasePedido) {
  if (pedido.estado === "cancelado" && pedido.financial_status === "refunded") {
    return "cancelado_refunded"
  }
  if (
    pedido.estado === "cancelado" &&
    ["refund_pending", "cancellation_requested"].includes(pedido.financial_status ?? "")
  ) {
    return "cancelado_refund_pending"
  }

  return getDisplayedOrderStatus(pedido)
}

function isApprovedPayment(pedido: SupabasePedido) {
  if (
    pedido.estado === "cancelado" ||
    ["cancelled", "cancellation_requested", "refund_pending", "refunded"].includes(
      pedido.financial_status ?? "",
    )
  ) {
    return false
  }

  return (
    pedido.estado === "pagado" ||
    pedido.payment_status === "confirmado" ||
    pedido.payment_status === "approved"
  )
}

function isRefundPendingOrder(pedido: SupabasePedido) {
  return isRefundPaymentAttentionOrder(pedido)
}

function isRefundedOrder(pedido: SupabasePedido) {
  return pedido.financial_status === "refunded"
}

function isOrderInvoicedForCreditNote(pedido: SupabasePedido) {
  return (
    pedido.invoice_status === "authorized" ||
    pedido.invoice_status === "processing" ||
    Boolean(pedido.invoice_cae) ||
    Boolean(pedido.invoice_number && pedido.invoice_point)
  )
}

function isCancellationFlowOrder(pedido: SupabasePedido) {
  return (
    pedido.estado === "cancelado" ||
    ["cancelled", "cancellation_requested", "refund_pending", "refunded"].includes(
      pedido.financial_status ?? "",
    ) ||
    Boolean(pedido.return_status)
  )
}

function needsCreditNoteReminder(pedido: SupabasePedido) {
  return (
    isCancellationFlowOrder(pedido) &&
    isOrderInvoicedForCreditNote(pedido) &&
    pedido.credit_note_status !== "authorized" &&
    !pedido.credit_note_cae &&
    !pedido.credit_note_issued
  )
}

function shouldShowClaimsTab(pedido: SupabasePedido) {
  return (
    (pedido.order_claims ?? []).length > 0 ||
    Boolean(pedido.return_status && pedido.return_status !== "resuelta")
  )
}

type AdminOrderTabBadgeState =
  | { kind: "badge"; label: string; title: string; className: string }
  | { kind: "check"; label: string; title: string; className: string }
  | null

function getAdminOrderTabState(
  pedido: SupabasePedido,
  {
    paymentProofPending,
    pendingClaim,
  }: {
    paymentProofPending: boolean
    pendingClaim: boolean
  },
) {
  const refundPending = isRefundPaymentAttentionOrder(pedido)
  const refunded = isRefundedOrder(pedido)
  const creditNotePending = needsCreditNoteReminder(pedido)

  return {
    visible: {
      reclamos: shouldShowClaimsTab(pedido),
      cancelacion: isCancellationFlowOrder(pedido),
    },
    badges: {
      pago: paymentProofPending
        ? {
            kind: "badge",
            label: "Revisión",
            title: "Comprobante nuevo pendiente de revisión",
            className:
              "border-blue-300/30 bg-blue-400/10 text-blue-100",
          }
        : isOrderPaymentConfirmed(pedido)
          ? {
              kind: "check",
              label: "OK",
              title: "Pago confirmado",
              className:
                "border-emerald-300/35 bg-emerald-400/12 text-emerald-100",
            }
          : null,
      envio: needsShippingReminder(pedido)
        ? {
            kind: "badge",
            label: "Pendiente",
            title: "Envío pendiente",
            className:
              "border-[#77E6E2]/30 bg-[#77E6E2]/8 text-[#D7FFFD]",
          }
        : null,
      facturacion: creditNotePending
        ? {
            kind: "badge",
            label: "Falta NC",
            title: "Falta registrar nota de crédito",
            className: ADMIN_SENSITIVE_DANGER.badge,
          }
        : pedido.invoice_status === "authorized" && !creditNotePending
          ? {
              kind: "check",
              label: "OK",
              title: "Facturación al día",
              className:
                "border-emerald-300/35 bg-emerald-400/12 text-emerald-100",
            }
          : needsInvoiceReminder(pedido)
            ? {
                kind: "badge",
                label: "Pendiente",
                title: "Factura pendiente",
                className:
                  "border-cyan-300/30 bg-cyan-400/10 text-cyan-100",
              }
            : null,
      reclamos: pendingClaim
        ? {
            kind: "badge",
            label: "Reclamo",
            title: "Reclamo pendiente de gestión",
            className: ADMIN_SENSITIVE_DANGER.badge,
          }
        : null,
      cancelacion: refundPending
        ? {
            kind: "badge",
            label: "Pendiente",
            title: "Reintegro pendiente",
            className: ADMIN_SENSITIVE_DANGER.badge,
          }
        : refunded
          ? {
              kind: "badge",
              label: "Reintegrado",
              title: "Reintegro completado",
              className:
                "border-emerald-300/35 bg-emerald-400/12 text-emerald-100",
            }
          : isCancellationFlowOrder(pedido)
            ? {
                kind: "badge",
                label: "En curso",
                title: "Cancelación en curso",
                className: ADMIN_SENSITIVE_DANGER.badge,
              }
            : null,
    } satisfies Record<Exclude<AdminOrderDetailView, "resumen">, AdminOrderTabBadgeState>,
  }
}

type SummaryBadge = {
  label: string
  value: string
  className: string
}

type RecommendedAction = {
  title: string
  description: string
  target: AdminOrderDetailView
  buttonLabel: string
  tone: "urgent" | "warning" | "info" | "success"
}

function getShippingSummary(pedido: SupabasePedido) {
  if (isCancellationFlowOrder(pedido)) return "Cancelado"
  if (pedido.estado === "entregado" || pedido.delivered_at) return "Entregado"
  if (
    pedido.estado === "enviado" ||
    pedido.estado === "en_camino" ||
    Boolean(pedido.tracking_number || pedido.tracking_url || pedido.andreani_tracking)
  ) {
    return "Despachado"
  }

  return "No despachado"
}

function getInvoiceSummary(pedido: SupabasePedido) {
  if (needsCreditNoteReminder(pedido)) return "Falta nota de crédito"
  if (pedido.invoice_status === "authorized" || pedido.invoice_cae) return "Factura emitida"
  return "Falta factura"
}

function getClaimSummary(pedido: SupabasePedido) {
  const claims = pedido.order_claims ?? []
  if (!claims.length) return "Sin reclamos"
  if (claims.some((claim) => claim.admin_needs_action)) return "Reclamo abierto"
  if (claims.some((claim) => !["cerrado", "rechazado"].includes(claim.status ?? ""))) {
    return "Reclamo abierto"
  }
  return "Reclamo cerrado"
}

function getCancellationSummary(pedido: SupabasePedido) {
  if (!isCancellationFlowOrder(pedido)) return "No aplica"
  if (isRefundedOrder(pedido)) return "Reintegro completado"
  if (isRefundPaymentAttentionOrder(pedido)) return "Reintegro pendiente"
  if (pedido.financial_status === "cancellation_requested") return "Solicitada"
  return "Cancelación cerrada"
}

function getPaymentSummary(pedido: SupabasePedido) {
  if (isRejectedPayment(pedido.payment_status)) return "Rechazado"
  if (isOrderPaymentConfirmed(pedido)) return "Confirmado"
  return "Pendiente"
}

function getExecutiveOrderStatus(pedido: SupabasePedido) {
  if (pedido.estado === "cancelado" && isRefundedOrder(pedido)) return "Cancelado · Reintegrado"
  if (pedido.estado === "cancelado" && isRefundPaymentAttentionOrder(pedido)) {
    return "Cancelado · Reintegro pendiente"
  }
  if (isRefundedOrder(pedido)) return "Reintegrado"
  if (isRefundPaymentAttentionOrder(pedido)) return "Reintegro pendiente"
  if (pedido.financial_status === "cancellation_requested") return "Cancelación solicitada"
  if ((pedido.order_claims ?? []).some((claim) => claim.admin_needs_action)) return "Reclamo abierto"
  if (isRejectedPayment(pedido.payment_status)) return "Pago rechazado"
  if (needsCreditNoteReminder(pedido)) return "Falta nota de crédito"
  if (needsInvoiceReminder(pedido)) return "Factura pendiente"
  if (needsShippingReminder(pedido)) return "Envío pendiente"
  return getDisplayedOrderStatus(pedido) === "pagado" ? "Pago confirmado" : getDisplayedOrderStatus(pedido)
}

function getSummaryBadgeClass(value: string) {
  if (isAdminSensitiveStatus(value) || ["Cancelado", "Solicitada", "Cancelación cerrada"].includes(value)) {
    return ADMIN_SENSITIVE_DANGER.badge
  }
  if (
    [
      "Confirmado",
      "Despachado",
      "Entregado",
      "Factura emitida",
      "Sin reclamos",
      "Reintegrado",
      "Reintegro completado",
    ].includes(value)
  ) {
    return "border-emerald-300/18 bg-emerald-400/7 text-emerald-100"
  }
  if (["Rechazado"].includes(value)) {
    return ADMIN_SENSITIVE_DANGER.badge
  }
  if (
    ["Pendiente", "No despachado", "Falta factura", "Falta nota de crédito"].includes(value)
  ) {
    return "border-amber-300/18 bg-amber-400/7 text-amber-100"
  }
  return "border-white/10 bg-white/5 text-white/72"
}

function getOrderSummaryBadges(pedido: SupabasePedido): SummaryBadge[] {
  const badges = [
    { label: "Pago", value: getPaymentSummary(pedido) },
    { label: "Envío", value: getShippingSummary(pedido) },
    { label: "Facturación", value: getInvoiceSummary(pedido) },
    { label: "Reclamos", value: getClaimSummary(pedido) },
    ...(isCancellationFlowOrder(pedido)
      ? [{ label: "Devolución", value: isRefundedOrder(pedido) ? "Reintegrado" : getCancellationSummary(pedido) }]
      : []),
  ]

  return badges.map((badge) => ({
    ...badge,
    className: getSummaryBadgeClass(badge.value),
  }))
}

function getOrderRecommendedAction(pedido: SupabasePedido): RecommendedAction {
  const openClaim = (pedido.order_claims ?? []).some(
    (claim) =>
      claim.admin_needs_action ||
      !["cerrado", "rechazado"].includes(claim.status ?? ""),
  )

  if (openClaim) {
    return {
      title: "Resolver reclamo abierto",
      description: "Hay una gestión de reclamo que requiere revisión administrativa.",
      target: "reclamos",
      buttonLabel: "Ir a Reclamos",
      tone: "urgent",
    }
  }

  if (isRefundPaymentAttentionOrder(pedido)) {
    return {
      title: "Cargar comprobante de reintegro",
      description: "El pedido está cancelado y falta cerrar la devolución al cliente.",
      target: "cancelacion",
      buttonLabel: "Ir a Cancelación",
      tone: "urgent",
    }
  }

  if (
    isTransferOrder(pedido) &&
    pedido.payment_status === "en_revision" &&
    Boolean(pedido.payment_proof_url)
  ) {
    return {
      title: "Revisar comprobante de pago",
      description: "El cliente subió un comprobante y falta confirmar o rechazar el pago.",
      target: "pago",
      buttonLabel: "Ir a Pago",
      tone: "warning",
    }
  }

  if (needsCreditNoteReminder(pedido)) {
    return {
      title: "Registrar nota de crédito",
      description: "El pedido cancelado tenía factura emitida y falta registrar la nota de crédito.",
      target: "facturacion",
      buttonLabel: "Ir a Facturación",
      tone: "urgent",
    }
  }

  if (needsInvoiceReminder(pedido)) {
    return {
      title: "Emitir factura",
      description: "El pago está confirmado y la factura electrónica todavía no fue emitida.",
      target: "facturacion",
      buttonLabel: "Ir a Facturación",
      tone: "info",
    }
  }

  if (needsShippingReminder(pedido)) {
    return {
      title: "Preparar despacho",
      description: "El pedido está facturado y listo para generar o actualizar el envío.",
      target: "envio",
      buttonLabel: "Ir a Envío",
      tone: "info",
    }
  }

  return {
    title: "Pedido cerrado, sin acciones pendientes",
    description: "No hay tareas críticas pendientes para este pedido.",
    target: "resumen",
    buttonLabel: "Ver resumen",
    tone: "success",
  }
}

function getOrderLatestActivity(pedido: SupabasePedido) {
  const latestClaim = (pedido.order_claims ?? [])[0]
  const candidates = [
    {
      at: latestClaim?.updated_at || latestClaim?.created_at,
      label:
        latestClaim?.status === "cerrado"
          ? "Reclamo cerrado."
          : latestClaim
            ? "Reclamo abierto por el cliente."
            : "",
    },
    {
      at: pedido.credit_note_issued_at,
      label: "Nota de crédito registrada.",
    },
    {
      at: pedido.refund_uploaded_at || pedido.refunded_at,
      label: "Se cargó comprobante de reintegro.",
    },
    {
      at: pedido.invoice_created_at,
      label: "Factura emitida.",
    },
    {
      at: pedido.cancellation_requested_at || pedido.cancelled_at,
      label: "El cliente canceló el pedido.",
    },
    {
      at: pedido.payment_confirmed_at || pedido.paid_at,
      label: "Pago confirmado por el administrador.",
    },
    {
      at: pedido.payment_proof_uploaded_at,
      label: "El cliente subió comprobante de pago.",
    },
    {
      at: pedido.created_at,
      label: "El cliente creó el pedido.",
    },
  ]
    .filter((item): item is { at: string; label: string } => Boolean(item.at && item.label))
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())

  return candidates[0] ?? { at: pedido.created_at, label: "El cliente creó el pedido." }
}

function needsPaymentProof(status?: string | null) {
  return status === "pendiente_comprobante"
}

function AdminOrderTabBadge({ state }: { state: AdminOrderTabBadgeState }) {
  if (!state) return null

  return (
    <span
      title={state.title}
      className={`ml-2 inline-flex h-5 items-center gap-1 rounded-full border px-1.5 text-9px font-black uppercase tracking-wide ${state.className}`}
    >
      {state.kind === "check" && <Check className="size-2.5" strokeWidth={3} />}
      {state.label}
    </span>
  )
}

function getTransferPaymentStatusBadge(status?: string | null) {
  const badges: Record<string, { label: string; className: string }> = {
    pendiente_comprobante: {
      label: "Falta comprobante",
      className: "border-amber-400/25 bg-amber-400/10 text-amber-200",
    },
    en_revision: {
      label: "En revisión",
      className: "border-blue-400/25 bg-blue-500/10 text-blue-200",
    },
    confirmado: {
      label: "Pago confirmado",
      className: "border-emerald-400/25 bg-emerald-400/10 text-emerald-300",
    },
    rechazado: {
      label: "Comprobante rechazado",
      className: "border-red-400/25 bg-red-400/10 text-red-300",
    },
  }

  return (
    badges[status ?? ""] ?? {
      label: getPaymentStatusLabel(status),
      className: "border-white/10 bg-white/5 text-white/60",
    }
  )
}

function formatOptionalOrderDate(value?: string | null) {
  return value ? formatOrderDate(value) : "Sin fecha"
}

function formatInvoiceDate(value?: string | null) {
  if (!value) return "Sin fecha"
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split("-")
    return `${day}/${month}/${year}`
  }

  return formatOrderDate(value)
}

function formatInvoiceNumber(point?: number | null, number?: number | null) {
  return `${String(point ?? 0).padStart(4, "0")}-${String(number ?? 0).padStart(8, "0")}`
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

function TransferPaymentBadges({ pedido }: { pedido: SupabasePedido }) {
  const paymentBadge = getTransferPaymentStatusBadge(pedido.payment_status)
  const proofUploaded = Boolean(pedido.payment_proof_url)

  return (
    <div className="flex flex-wrap justify-center gap-1.5">
      <span className="inline-flex w-fit items-center gap-1.5 rounded-full border border-beyonix-blue-light/35 bg-black px-2.5 py-1 text-10px font-black uppercase tracking-wide text-beyonix-sky">
        <CreditCard className="size-3" />
        Transferencia
      </span>
      <span
        title={paymentBadge.label}
        className={`inline-flex w-fit items-center rounded-full border px-2.5 py-1 text-10px font-black uppercase tracking-wide ${paymentBadge.className}`}
      >
        {paymentBadge.label}
      </span>
      <span
        title={proofUploaded ? "Comprobante subido" : "Sin comprobante"}
        className={`inline-flex w-fit items-center rounded-full border px-2.5 py-1 text-10px font-black uppercase tracking-wide ${
          proofUploaded
            ? "border-emerald-400/25 bg-emerald-400/10 text-emerald-300"
            : "border-white/10 bg-white/5 text-white/52"
        }`}
      >
        {proofUploaded ? "Con comprobante" : "Sin comprobante"}
      </span>
    </div>
  )
}

type AdminNotificationTone =
  | "order"
  | "message"
  | "payment"
  | "invoice"
  | "shipping"
  | "cancellation"
  | "claim"

function getOrderNotificationTone(pedido: SupabasePedido): AdminNotificationTone {
  if (isRefundPaymentAttentionOrder(pedido)) return "cancellation"
  if (pedido.estado === "cancelado") return "cancellation"
  if (needsShippingReminder(pedido)) return "shipping"

  const hasIssue =
    orderHasPendingClaimAction(pedido) ||
    Boolean(pedido.return_requested_at && !pedido.return_resolved_at) ||
    isRejectedPayment(pedido.payment_status) ||
    getDispatchAlert(pedido).label === "Urgente"

  if (hasIssue) return "claim"

  const hasPaymentProofToReview =
    Boolean(pedido.payment_proof_url) &&
    pedido.payment_status === "en_revision"

  if (hasPaymentProofToReview) return "payment"

  if (needsInvoiceReminder(pedido)) return "invoice"

  const hasCustomerMessage = (pedido.order_claims ?? []).some(
    (claim) =>
      Boolean(claim.last_customer_message_at) &&
      !claim.admin_needs_action,
  )

  if (hasCustomerMessage) return "claim"

  return "order"
}

function orderMatchesNotificationTone(
  pedido: SupabasePedido,
  tone: AdminNotificationTone,
  lastSeenAt: string | null,
) {
  if (tone === "claim") {
    return (
      orderHasPendingClaimAction(pedido) ||
      isOrderNewerThanLastSeen(pedido.return_requested_at, lastSeenAt)
    )
  }

  if (tone === "cancellation") {
    return (
      isRefundPaymentAttentionOrder(pedido) ||
      (pedido.estado === "cancelado" ||
        ["cancelled", "cancellation_requested"].includes(
          pedido.financial_status ?? "",
        )) &&
      !isRefundPaymentAttentionOrder(pedido)
    )
  }

  if (tone === "payment") {
    return (
      (Boolean(pedido.payment_proof_url) &&
        pedido.payment_status === "en_revision" &&
        !isRefundPaymentAttentionOrder(pedido))
    )
  }

  if (tone === "message") {
    return (pedido.order_claims ?? []).some(
      (claim) =>
        Boolean(claim.first_reviewed_at) &&
        isOrderNewerThanLastSeen(claim.last_customer_message_at, lastSeenAt),
    )
  }

  if (tone === "invoice") return needsInvoiceReminder(pedido)
  if (tone === "shipping") return needsShippingReminder(pedido)

  return isOrderNewerThanLastSeen(pedido.created_at, lastSeenAt)
}

async function runAndreaniAction(action: AndreaniAction, pedidoId: number) {
  const response = await fetch(`/api/andreani/${action}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ pedidoId }),
  })
  const data = (await response.json()) as {
    ok?: boolean
    message?: string
    error?: string
  }

  return {
    ok: Boolean(response.ok && data.ok),
    message:
      data.message || data.error || "Andreani todavía no está configurado",
  }
}

function handlePrintAndreaniLabel(pedido: SupabasePedido) {
  if (!pedido.andreani_etiqueta_url) {
    return false
  }

  window.open(pedido.andreani_etiqueta_url, "_blank", "noopener,noreferrer")
  return true
}

function getDispatchAlert(pedido: SupabasePedido) {
  if (isRefundPendingOrder(pedido)) {
    return {
      label: "Reintegro",
      className: "border-amber-400/25 bg-amber-500/12 text-amber-200",
    }
  }

  if (isRefundedOrder(pedido)) {
    return {
      label: "Reintegrado",
      className: "border-emerald-400/25 bg-emerald-500/12 text-emerald-200",
    }
  }

  const dispatched =
    pedido.estado === "enviado" ||
    pedido.estado === "entregado" ||
    Boolean(pedido.tracking_number || pedido.tracking_url)

  if (dispatched || pedido.estado === "cancelado") {
    return {
      label: "Enviado",
      className: "border-beyonix-blue-light/35 bg-beyonix-blue text-beyonix-sky",
    }
  }

  const hours = (Date.now() - new Date(pedido.created_at).getTime()) / 36e5

  if (hours > 24) {
    return {
      label: "Urgente",
      className: "border-red-400/25 bg-red-400/10 text-red-300",
    }
  }

  if (hours > 12) {
    return {
      label: "Atención",
      className: "border-amber-400/25 bg-amber-400/10 text-amber-200",
    }
  }

  return {
    label: "A tiempo",
    className: "border-emerald-400/25 bg-emerald-400/10 text-emerald-300",
  }
}

function EstadoBadge({ estado }: { estado: string }) {
  const styles: Record<string, string> = {
    pendiente: "border-amber-500/20 bg-amber-500/10 text-amber-300",
    pagado: "border-emerald-500/20 bg-emerald-500/10 text-emerald-300",
    enviado: "border-beyonix-blue-light/35 bg-beyonix-blue text-beyonix-sky",
    en_camino: "border-beyonix-blue-light/35 bg-beyonix-blue text-beyonix-sky",
    entregado: "border-emerald-500/20 bg-emerald-500/10 text-emerald-300",
    cancelado: ADMIN_SENSITIVE_DANGER.badge,
    cancelado_refund_pending: ADMIN_SENSITIVE_DANGER.badge,
    cancelado_refunded: "border-emerald-400/25 bg-emerald-500/12 text-emerald-200",
    refund_pending: ADMIN_SENSITIVE_DANGER.badge,
    refunded: "border-emerald-400/25 bg-emerald-500/12 text-emerald-200",
    rechazado: "border-red-500/20 bg-red-500/10 text-red-300",
  }
  const labels: Record<string, string> = {
    pendiente: "Pendiente",
    pagado: "Pago confirmado",
    enviado: "Enviado",
    en_camino: "En camino",
    entregado: "Entregado",
    cancelado: "Cancelado",
    cancelado_refund_pending: "Cancelado · Reintegro pendiente",
    cancelado_refunded: "Cancelado · Reintegrado",
    refund_pending: "Reintegro pendiente",
    refunded: "Reintegrado",
    rechazado: "Comprobante rechazado",
  }

  return (
    <span
      className={`inline-flex w-fit items-center rounded-full border px-3 py-1 text-11px font-black uppercase tracking-wide ${
        styles[estado] ?? "border-white/10 bg-white/5 text-white/60"
      }`}
    >
      {labels[estado] ?? estado}
    </span>
  )
}

function PaymentStatusBadge({ status }: { status?: string | null }) {
  const value: PaymentStatusValue =
    status === "confirmado" || status === "approved"
      ? "confirmado"
      : isRejectedPayment(status)
        ? "rechazado"
        : status === "en_revision"
          ? "en_revision"
          : "pendiente_comprobante"
  const option = PAYMENT_STATUS_OPTIONS.find((item) => item.value === value)!
  const label =
    value === "confirmado"
      ? "Pago confirmado"
      : value === "en_revision"
        ? "Comprobante en revisión"
        : option.label

  return (
    <span
      className={`inline-flex w-fit items-center gap-1.5 rounded-full border px-3 py-1 text-11px font-black uppercase tracking-wide ${
        value === "confirmado"
          ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-300"
          : value === "rechazado"
            ? "border-red-500/20 bg-red-500/10 text-red-300"
            : value === "en_revision"
              ? "border-blue-400/25 bg-blue-500/10 text-blue-200"
            : "border-amber-500/20 bg-amber-500/10 text-amber-300"
      }`}
    >
      <span className={`size-2 rounded-full ${option.dot}`} />
      {label}
    </span>
  )
}

function PaymentStatusDropdown({
  value,
  onChange,
}: {
  value: PaymentStatusValue
  onChange: (value: PaymentStatusValue) => void
}) {
  const [open, setOpen] = useState(false)
  const [mounted, setMounted] = useState(false)
  const [menuPosition, setMenuPosition] = useState({
    left: 0,
    top: 0,
    width: 176,
  })
  const dropdownRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const selected =
    PAYMENT_STATUS_OPTIONS.find((option) => option.value === value) ??
    PAYMENT_STATUS_OPTIONS[0]

  useEffect(() => {
    setMounted(true)
  }, [])

  useEffect(() => {
    if (!open) return

    const handleOutside = (event: MouseEvent) => {
      const target = event.target as Node
      if (
        !dropdownRef.current?.contains(target) &&
        !menuRef.current?.contains(target)
      ) {
        setOpen(false)
      }
    }
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false)
    }

    document.addEventListener("mousedown", handleOutside)
    document.addEventListener("keydown", handleEscape)
    return () => {
      document.removeEventListener("mousedown", handleOutside)
      document.removeEventListener("keydown", handleEscape)
    }
  }, [open])

  useEffect(() => {
    if (!open) return

    function updateMenuPosition() {
      const rect = dropdownRef.current?.getBoundingClientRect()
      if (!rect) return

      const menuHeight = Math.min(PAYMENT_STATUS_OPTIONS.length * 34 + 8, 220)
      const width = Math.max(176, rect.width)
      const spaceBelow = window.innerHeight - rect.bottom
      const openAbove = spaceBelow < menuHeight && rect.top > menuHeight
      const left = Math.min(
        Math.max(8, rect.left),
        Math.max(8, window.innerWidth - width - 8),
      )

      setMenuPosition({
        left,
        top: openAbove
          ? Math.max(8, rect.top - menuHeight - 4)
          : Math.min(window.innerHeight - menuHeight - 8, rect.bottom + 4),
        width,
      })
    }

    updateMenuPosition()
    window.addEventListener("resize", updateMenuPosition)
    window.addEventListener("scroll", updateMenuPosition, true)

    return () => {
      window.removeEventListener("resize", updateMenuPosition)
      window.removeEventListener("scroll", updateMenuPosition, true)
    }
  }, [open])

  return (
    <div ref={dropdownRef} className="relative w-fit">
      <button
        type="button"
        title="Estado del pago"
        aria-label="Estado del pago"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="flex h-8 min-w-40 cursor-pointer items-center gap-2 rounded-lg border border-[rgba(148,197,255,0.18)] bg-[#0B111A] px-2.5 text-left shadow-sm transition-all duration-200 hover:border-[rgba(191,228,255,0.28)] hover:bg-[rgba(17,42,67,0.45)] hover:shadow-[0_0_18px_rgba(96,165,250,0.18)]"
      >
        <span className={`size-1.5 rounded-full ${selected.dot}`} />
        <span className={`min-w-0 flex-1 text-xs font-semibold ${selected.tone}`}>
          {selected.label}
        </span>
        <ChevronDown
          className={`size-3.5 text-white/50 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {mounted && open && createPortal(
        <div
          ref={menuRef}
          role="listbox"
          aria-label="Estado del pago"
          className="fixed z-100 overflow-hidden rounded-xl border border-[rgba(148,197,255,0.18)] bg-[#080D14] p-1 shadow-[0_18px_45px_rgba(0,0,0,0.45)]"
          style={{
            left: menuPosition.left,
            top: menuPosition.top,
            width: menuPosition.width,
          }}
        >
          {PAYMENT_STATUS_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={value === option.value}
              onClick={() => {
                onChange(option.value)
                setOpen(false)
              }}
              className={`flex min-h-8 w-full cursor-pointer items-center gap-2 rounded-lg px-2 text-left transition-all duration-200 ${
                value === option.value
                  ? "bg-[rgba(17,42,67,0.9)] shadow-[inset_0_0_0_1px_rgba(191,228,255,0.16)]"
                  : "hover:bg-[rgba(17,42,67,0.75)]"
              }`}
            >
              <span className={`size-1.5 rounded-full ${option.dot}`} />
              <span className={`text-xs font-semibold ${option.tone}`}>
                {option.label}
              </span>
              {value === option.value && (
                <Check className="ml-auto size-3 text-white/45" />
              )}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  )
}

function formatRefundAmountInput(value: number | string | null | undefined) {
  const parsed = Number(value ?? 0)
  if (!Number.isFinite(parsed) || parsed <= 0) return ""

  return new Intl.NumberFormat("es-AR", {
    maximumFractionDigits: 2,
  }).format(parsed)
}

function parseRefundAmountInput(value: string) {
  const normalized = value
    .trim()
    .replace(/\./g, "")
    .replace(",", ".")
  const parsed = Number(normalized)

  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function getAdminDisplayName(value?: string | null) {
  const candidate = value?.trim()
  if (!candidate) return "Administrador"

  const looksLikeUuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      candidate,
    )
  const looksLikeTechnicalId =
    !candidate.includes("@") &&
    /^[a-z0-9_-]{20,}$/i.test(candidate)

  return looksLikeUuid || looksLikeTechnicalId ? "Administrador" : candidate
}

type OrderTimelineType = "success" | "pending" | "danger" | "info"

type OrderTimelineEvent = {
  key: string
  title: string
  at: string
  description?: string
  type: OrderTimelineType
}

type OrderAuditTimelineEvent = {
  action: string
  previous_status?: string | null
  new_status?: string | null
  metadata?: Record<string, unknown> | null
  created_at: string
}

type OrderWithTimelineSources = SupabasePedido & {
  order_audit_events?: OrderAuditTimelineEvent[] | null
}

function buildOrderTimeline(order: SupabasePedido): OrderTimelineEvent[] {
  const pedido = order as OrderWithTimelineSources
  const auditEvents = pedido.order_audit_events ?? []
  const events: OrderTimelineEvent[] = []
  const addEvent = (event: OrderTimelineEvent | null) => {
    if (!event?.at) return
    if (Number.isNaN(new Date(event.at).getTime())) return
    events.push(event)
  }
  const findAuditEvent = (
    predicate: (event: OrderAuditTimelineEvent) => boolean,
  ) => auditEvents.find((event) => event.created_at && predicate(event))
  const statusAuditDate = (statuses: string[]) =>
    findAuditEvent((event) =>
      statuses.includes(event.new_status ?? "") ||
      statuses.includes(String(event.metadata?.newEstado ?? "")),
    )?.created_at

  const dispatchedAt = statusAuditDate(["enviado", "en_camino", "shipped", "in_transit"])
  const deliveredAt =
    pedido.delivered_at || statusAuditDate(["entregado", "delivered"])
  const cancellationAuditEvent = findAuditEvent((event) =>
    [
      "cancellation_requested",
      "cancellation_requested_refund_pending",
      "order_cancelled_refund_pending",
      "order_status_changed",
    ].includes(event.action) &&
    (
      event.new_status === "cancelled" ||
      event.new_status === "refund_pending" ||
      event.new_status === "cancelado" ||
      event.metadata?.newEstado === "cancelado"
    ),
  )
  const cancelledAt =
    pedido.cancellation_requested_at ||
    pedido.cancelled_at ||
    cancellationAuditEvent?.created_at
  const refundProofAt =
    pedido.refund_uploaded_at ||
    pedido.order_refund_proofs?.[0]?.created_at ||
    findAuditEvent((event) => event.action === "refund_proof_uploaded")?.created_at
  const refundedAt =
    pedido.refunded_at ||
    findAuditEvent((event) => event.action === "order_refunded")?.created_at
  const creditNoteAt =
    pedido.credit_note_created_at ||
    pedido.credit_note_issued_at ||
    findAuditEvent((event) =>
      ["credit_note_registered", "credit_note_authorized"].includes(event.action),
    )?.created_at
  const productReturnedAt = findAuditEvent((event) =>
    ["product_return_received", "return_product_received", "returned_product_received"].includes(
      event.action,
    ),
  )?.created_at
  const productReviewAt = findAuditEvent((event) =>
    ["product_review_started", "return_product_review_started", "product_condition_reviewed"].includes(
      event.action,
    ),
  )?.created_at
  const refundApprovedAt = findAuditEvent((event) =>
    ["refund_approved", "return_refund_approved"].includes(event.action),
  )?.created_at
  const refundRejectedAt = findAuditEvent((event) =>
    ["refund_rejected", "return_refund_rejected"].includes(event.action),
  )?.created_at
  const hasPhysicalReturn =
    Boolean(pedido.return_status || pedido.return_requested_at) &&
    Boolean(deliveredAt || dispatchedAt || pedido.tracking_number || pedido.andreani_tracking)
  const returnStatus = pedido.return_status ?? null
  const refundCanBeCompleted =
    !hasPhysicalReturn || returnStatus === "aprobada" || returnStatus === "resuelta"
  const cancellationOrigin =
    cancellationAuditEvent?.actor_type === "customer" ||
    cancellationAuditEvent?.action.startsWith("cancellation_requested")
      ? "cliente"
      : cancellationAuditEvent?.actor_type === "admin" ||
          cancellationAuditEvent?.action === "order_cancelled_refund_pending"
        ? "administrador"
        : cancellationAuditEvent?.actor_type === "system"
          ? "automático"
          : pedido.cancellation_requested_by
            ? "cliente"
          : null
  const cancellationTitle =
    cancellationOrigin === "cliente"
      ? "Pedido cancelado por el cliente"
      : cancellationOrigin === "administrador"
        ? "Pedido cancelado por el administrador"
        : cancellationOrigin === "automático"
          ? "Pedido cancelado automáticamente"
          : "Pedido cancelado"
  const cancellationDescription =
    cancellationOrigin === "cliente"
      ? "El cliente solicitó la cancelación del pedido."
      : cancellationOrigin === "administrador"
        ? "Un administrador canceló el pedido."
        : cancellationOrigin === "automático"
          ? "El sistema interrumpió el flujo del pedido."
          : "La compra fue cancelada."

  addEvent({
    key: "order-created",
    title: "Pedido registrado",
    at: pedido.created_at,
    description: "La compra ingresó al sistema.",
    type: "success",
  })
  addEvent({
    key: "payment-confirmed",
    title: "Pago confirmado",
    at: pedido.payment_confirmed_at || pedido.paid_at || "",
    description: "El pago quedó validado.",
    type: "success",
  })
  addEvent({
    key: "invoice-issued",
    title: "Factura emitida",
    at: pedido.invoice_created_at || "",
    description: "El comprobante fiscal fue generado.",
    type: "success",
  })
  addEvent({
    key: "shipping-dispatched",
    title: "Envío despachado",
    at: dispatchedAt || "",
    description: "El pedido salió a distribución.",
    type: "success",
  })
  addEvent({
    key: "shipping-delivered",
    title: "Envío entregado",
    at: deliveredAt || "",
    description: "El cliente recibió el pedido.",
    type: "success",
  })
  addEvent({
    key: "order-cancelled",
    title: cancellationTitle,
    at: cancelledAt || pedido.return_requested_at || "",
    description: hasPhysicalReturn
      ? `${cancellationDescription} Se inició el flujo de devolución del producto.`
      : cancellationDescription,
    type: "danger",
  })

  if (
    hasPhysicalReturn &&
    pedido.return_requested_at &&
    (!returnStatus || returnStatus === "solicitada")
  ) {
    addEvent({
      key: "return-waiting-product",
      title: "A la espera de devolución del producto por parte del cliente",
      at: pedido.return_requested_at,
      description: "El reintegro depende de recibir y revisar el producto.",
      type: "pending",
    })
  }

  addEvent({
    key: "return-product-received",
    title: "Producto devuelto por el cliente",
    at: productReturnedAt || "",
    description: "BEYONIX recibió el producto devuelto.",
    type: "success",
  })

  if (hasPhysicalReturn && (productReviewAt || (pedido.return_requested_at && returnStatus === "en_revision"))) {
    addEvent({
      key: "return-product-review",
      title: "Producto en revisión",
      at: productReviewAt || pedido.return_requested_at || "",
      description: "El estado del producto está siendo evaluado.",
      type: "pending",
    })
  }

  if (returnStatus === "aprobada" || refundApprovedAt) {
    addEvent({
      key: "refund-approved",
      title: "Reintegro aprobado",
      at: refundApprovedAt || pedido.return_resolved_at || pedido.return_requested_at || "",
      description: "La devolución fue aprobada administrativamente.",
      type: "success",
    })
  }

  if (returnStatus === "rechazada" || refundRejectedAt) {
    addEvent({
      key: "refund-rejected",
      title: "Reintegro rechazado",
      at: refundRejectedAt || pedido.return_resolved_at || pedido.return_requested_at || "",
      description: "La devolución no fue aprobada por el estado del producto.",
      type: "danger",
    })
  }

  if (!refundedAt && (pedido.financial_status === "refund_pending" || pedido.refund_pending_at)) {
    addEvent({
      key: "refund-pending",
      title: hasPhysicalReturn ? "Reintegro pendiente de aprobación" : "Reintegro pendiente",
      at: pedido.refund_pending_at || cancelledAt || "",
      description: hasPhysicalReturn
        ? "Falta cerrar la revisión antes de reintegrar el dinero."
        : "Falta cargar el comprobante de reintegro.",
      type: "danger",
    })
  }
  addEvent({
    key: "refund-proof-uploaded",
    title: "Comprobante de reintegro cargado",
    at: refundProofAt || "",
    description: "El comprobante quedó asociado al pedido.",
    type: "success",
  })
  addEvent({
    key: "refund-completed",
    title: "Reintegro completado",
    at: refundCanBeCompleted ? refundedAt || "" : "",
    description: "La devolución de dinero quedó finalizada.",
    type: "success",
  })
  addEvent({
    key: "credit-note-issued",
    title: "Nota de crédito emitida",
    at: creditNoteAt || "",
    description: "La documentación contable quedó registrada.",
    type: "success",
  })

  for (const claim of pedido.order_claims ?? []) {
    const claimIsCancellation = claim.failure_type === "cancelar_compra"
    addEvent({
      key: `claim-opened-${claim.id}`,
      title: claimIsCancellation ? "Solicitud de cancelación registrada" : "Reclamo iniciado",
      at: claim.created_at,
      description: claimIsCancellation
        ? "El cliente inició una solicitud sensible de cancelación."
        : "El cliente inició un reclamo que requiere seguimiento administrativo.",
      type: "danger",
    })

    if (claim.last_customer_message_at) {
      addEvent({
        key: `claim-customer-message-${claim.id}`,
        title: claimIsCancellation ? "Mensaje en cancelación" : "Mensaje en reclamo",
        at: claim.last_customer_message_at,
        description: "Hay actividad del cliente dentro del caso.",
        type: "danger",
      })
    }

    if (claim.status === "rechazado") {
      addEvent({
        key: `claim-rejected-${claim.id}`,
        title: claimIsCancellation ? "Cancelación rechazada" : "Reclamo rechazado",
        at: claim.updated_at,
        description: "El caso fue rechazado administrativamente.",
        type: "danger",
      })
    }

    if (claim.status === "cerrado") {
      addEvent({
        key: `claim-closed-${claim.id}`,
        title: claimIsCancellation ? "Cancelación cerrada" : "Reclamo cerrado",
        at: claim.closed_at || claim.updated_at,
        description: "El caso quedó cerrado.",
        type: "success",
      })
    }
  }

  const closedAt =
    creditNoteAt ||
    (refundCanBeCompleted ? refundedAt : null) ||
    (returnStatus === "resuelta" ? pedido.return_resolved_at : null) ||
    (pedido.financial_status === "cancelled" ? cancelledAt : null)

  addEvent({
    key: "order-closed",
    title: "Pedido cerrado",
    at: closedAt || "",
    description: "No quedan acciones pendientes en este flujo.",
    type: "success",
  })

  const uniqueEvents = new Map<string, OrderTimelineEvent>()
  for (const event of events) {
    const dedupeKey = `${event.key}:${event.at}`
    if (!uniqueEvents.has(dedupeKey)) uniqueEvents.set(dedupeKey, event)
  }

  return [...uniqueEvents.values()].sort(
    (a, b) => new Date(a.at).getTime() - new Date(b.at).getTime(),
  )
}

function OrderTimeline({ pedido }: { pedido: SupabasePedido }) {
  const timeline = buildOrderTimeline(pedido)
  const typeStyles = {
    success: {
      Icon: Check,
      dotClass: "border-emerald-300/28 bg-emerald-400/8 text-emerald-100",
      connectorClass: "bg-emerald-300/12",
    },
    pending: {
      Icon: Clock3,
      dotClass: "border-amber-300/24 bg-amber-400/8 text-amber-100",
      connectorClass: "bg-amber-300/12",
    },
    danger: {
      Icon: X,
      dotClass: ADMIN_SENSITIVE_DANGER.icon,
      connectorClass: "bg-[#9f3546]/28",
    },
    info: {
      Icon: Info,
      dotClass: "border-sky-300/20 bg-sky-400/7 text-sky-100",
      connectorClass: "bg-sky-300/10",
    },
  } satisfies Record<
    OrderTimelineType,
    {
      Icon: typeof Check
      dotClass: string
      connectorClass: string
    }
  >

  const getConnectorClass = (type: OrderTimelineType, nextType?: OrderTimelineType) => {
    if (type === nextType) return typeStyles[type].connectorClass
    return "bg-white/8"
  }

  return (
    <section className="mt-4 rounded-xl border border-white/8 bg-black/18 p-3">
      <p className="text-10px font-black uppercase tracking-widest text-white/42">
        Historial del pedido
      </p>
      <div className="mt-3 space-y-3">
        {timeline.map((item, index) => {
          const visual = typeStyles[item.type]
          const Icon = visual.Icon
          const nextType = timeline[index + 1]?.type

          return (
            <div key={`${item.key}-${item.at}`} className="relative flex gap-3">
              {index < timeline.length - 1 && (
                <span
                  className={`absolute left-2 top-5 h-[calc(100%+0.25rem)] w-px ${getConnectorClass(item.type, nextType)}`}
                />
              )}
              <span
                className={`relative mt-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-full border ${visual.dotClass}`}
              >
                <Icon className="size-2.5" strokeWidth={3} />
              </span>
              <div className="min-w-0 pb-1">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <p className="text-sm font-black text-white/86">{item.title}</p>
                  <p className="text-10px font-bold uppercase tracking-wide text-white/40">
                    {formatOptionalOrderDate(item.at)}
                  </p>
                </div>
                {item.description && (
                  <p className="mt-0.5 text-xs leading-5 text-white/50">
                    {item.description}
                  </p>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}

function RefundManagementPanel({
  pedido,
  canEditRefundAmount,
  onRefundUpdated,
}: {
  pedido: SupabasePedido
  canEditRefundAmount: boolean
  onRefundUpdated: (order: SupabasePedido) => void
}) {
  const shouldShow =
    isCancellationFlowOrder(pedido)

  const paidAmount = Number(pedido.payment_confirmed_amount ?? pedido.total ?? 0)
  const [file, setFile] = useState<File | null>(null)
  const [amount, setAmount] = useState(formatRefundAmountInput(pedido.refund_amount ?? paidAmount))
  const [method, setMethod] = useState(pedido.refund_method ?? "")
  const [observation, setObservation] = useState(pedido.refund_observation ?? "")
  const [internalNote, setInternalNote] = useState(pedido.refund_internal_note ?? "")
  const [saving, setSaving] = useState(false)
  const [openingRefundProof, setOpeningRefundProof] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    setAmount(formatRefundAmountInput(pedido.refund_amount ?? paidAmount))
    setMethod(pedido.refund_method ?? "")
    setObservation(pedido.refund_observation ?? "")
    setInternalNote(pedido.refund_internal_note ?? "")
    setFile(null)
    setMessage(null)
  }, [
    paidAmount,
    pedido.id,
    pedido.refund_amount,
    pedido.refund_internal_note,
    pedido.refund_method,
    pedido.refund_observation,
  ])

  if (!shouldShow) return null

  const refunded = isRefundedOrder(pedido)
  const refundPending = isRefundPendingOrder(pedido)
  const refundStatusLabel = refunded
    ? "Reintegro completado"
    : refundPending
      ? "Reintegro pendiente"
      : "Cancelación cerrada"
  const refundCompactStatus = refunded ? "Finalizado" : refundStatusLabel
  const cancellationTitle = refunded
    ? "Reintegro completado"
    : refundPending
      ? "Reintegro pendiente"
      : pedido.financial_status === "cancellation_requested"
        ? "Cancelación pendiente"
        : "Cancelación cerrada"
  const cancellationCopy = refunded
    ? "El comprobante fue registrado correctamente y la devolución quedó finalizada."
    : refundPending
      ? "El pedido fue cancelado con dinero recibido. Cargá el comprobante de reintegro para cerrar la devolución."
      : "El pedido está cancelado y no tiene un reintegro pendiente registrado."
  const parsedRefundAmount = parseRefundAmountInput(amount)
  const maxRefundAmount = Math.max(paidAmount, Number(pedido.total ?? 0))
  const refundAmountIsValid =
    parsedRefundAmount !== null &&
    (maxRefundAmount <= 0 || parsedRefundAmount <= maxRefundAmount)
  const canUploadRefund =
    !refunded &&
    refundPending &&
    Boolean(file) &&
    refundAmountIsValid &&
    method.trim().length > 0 &&
    !saving
  const refundDisplayAmount = formatPrice(Number(pedido.refund_amount ?? paidAmount ?? 0))
  const refundRegisteredBy = getAdminDisplayName(pedido.refund_uploaded_by || pedido.refunded_by)

  const openRefundProof = async () => {
    setOpeningRefundProof(true)
    setMessage(null)

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession()

      if (!session?.access_token) {
        setMessage({ ok: false, text: "La sesión administrativa venció." })
        return
      }

      const response = await fetch(`/api/admin/pedidos/${pedido.id}/refund`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      const data = (await response.json()) as {
        signedUrl?: string | null
        error?: string
      }

      if (!response.ok || !data.signedUrl) {
        throw new Error(data.error || "No se pudo abrir el comprobante de reintegro.")
      }

      window.open(data.signedUrl, "_blank", "noopener,noreferrer")
    } catch (error) {
      setMessage({
        ok: false,
        text:
          error instanceof Error
            ? error.message
            : "No se pudo abrir el comprobante de reintegro.",
      })
    } finally {
      setOpeningRefundProof(false)
    }
  }

  const uploadRefundProof = async () => {
    if (!file) {
      setMessage({ ok: false, text: "Subí el comprobante de reintegro." })
      return
    }

    setSaving(true)
    setMessage(null)

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession()

      if (!session?.access_token) {
        setMessage({ ok: false, text: "La sesión administrativa venció." })
        return
      }

      const formData = new FormData()
      formData.set("file", file)
      formData.set("amount", String(parsedRefundAmount ?? ""))
      formData.set("method", method)
      formData.set("observation", observation)
      formData.set("internalNote", internalNote)

      const response = await fetch(`/api/admin/pedidos/${pedido.id}/refund`, {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}` },
        body: formData,
      })
      const data = (await response.json()) as {
        order?: SupabasePedido
        error?: string
      }

      if (!response.ok || !data.order) {
        setMessage({
          ok: false,
          text: data.error || "No se pudo registrar el reintegro.",
        })
        return
      }

      onRefundUpdated(data.order)
      setFile(null)
      setMessage({ ok: true, text: "Reintegro registrado con comprobante." })
      notifyOrderNotificationsChanged()
    } catch {
      setMessage({ ok: false, text: "No se pudo registrar el reintegro." })
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className={`rounded-2xl border p-4 sm:p-5 ${ADMIN_SENSITIVE_DANGER.panel}`}>
      <div className="border-b border-[#7f2d3a]/45 pb-4">
        <p className={`text-11px font-bold uppercase tracking-widest ${ADMIN_SENSITIVE_DANGER.label}`}>
          Gestión de cancelación
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <h3 className="text-lg font-black text-white">{cancellationTitle}</h3>
        </div>
        <p className={`mt-1 max-w-2xl text-sm leading-6 ${ADMIN_SENSITIVE_DANGER.textMuted}`}>
          {cancellationCopy}
        </p>
      </div>

      <div className="mt-4 grid gap-3 lg:grid-cols-3">
        <section className={`rounded-xl border p-3 ${ADMIN_SENSITIVE_DANGER.panelSoft}`}>
          <p className={`text-10px font-black uppercase tracking-widest ${ADMIN_SENSITIVE_DANGER.label}`}>
            Información
          </p>
          <div className="mt-3 space-y-2">
            <DetailValue label="Pedido" value={`#${formatPublicOrderId(pedido.id)}`} />
            <DetailValue label="Cliente" value={pedido.cliente_nombre || "Cliente sin nombre"} />
            <DetailValue
              label="Contacto"
              value={[pedido.cliente_email, pedido.cliente_telefono].filter(Boolean).join(" · ") || "No informado"}
            />
          </div>
        </section>
        <section className={`rounded-xl border p-3 ${ADMIN_SENSITIVE_DANGER.panelSoft}`}>
          <p className={`text-10px font-black uppercase tracking-widest ${ADMIN_SENSITIVE_DANGER.label}`}>
            Fechas
          </p>
          <div className="mt-3 space-y-2">
            <DetailValue
              label="Pago confirmado"
              value={formatOptionalOrderDate(pedido.payment_confirmed_at || pedido.paid_at)}
            />
            <DetailValue
              label="Cancelación solicitada"
              value={formatOptionalOrderDate(pedido.cancellation_requested_at || pedido.cancelled_at)}
            />
          </div>
        </section>
        <section className={`rounded-xl border p-3 ${ADMIN_SENSITIVE_DANGER.panelSoft}`}>
          <p className={`text-10px font-black uppercase tracking-widest ${ADMIN_SENSITIVE_DANGER.label}`}>
            Reintegro
          </p>
          <div className="mt-3 space-y-2">
            <DetailValue label="Monto" value={refundDisplayAmount} />
            <DetailValue label="Método" value={pedido.refund_method || "Pendiente"} />
            <DetailValue label="Estado" value={refundCompactStatus} />
          </div>
        </section>
      </div>

      <div className="mt-4 grid min-w-0 gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(280px,0.75fr)]">
        <div className={`min-w-0 rounded-xl border p-3 ${ADMIN_SENSITIVE_DANGER.panelSoft}`}>
          <p className={`text-10px font-black uppercase tracking-widest ${ADMIN_SENSITIVE_DANGER.label}`}>
            {refunded ? "Reintegro registrado" : "Cargar comprobante de reintegro"}
          </p>
          {!refundPending ? (
            <p className="mt-3 rounded-lg border border-white/8 bg-[#141820] px-3 py-2 text-xs font-bold leading-5 text-white/62">
              {refunded
                ? "No hay acciones pendientes para esta devolución."
                : "No hay una acción de reintegro pendiente para este pedido."}
            </p>
          ) : (
            <>
              <div className="mt-3 grid min-w-0 gap-2 sm:grid-cols-2">
                <div className="min-w-0">
                  <p className="mb-1 text-10px font-bold uppercase tracking-widest text-white/45">
                    Archivo del comprobante de reintegro
                  </p>
                  <label className="flex min-h-10 w-full cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed border-[#9f3546] bg-[#241217] px-3 text-xs font-bold text-white/78 transition hover:border-[#bf4a5b]">
                    {file ? file.name : "⬇️ Seleccionar archivo"}
                    <input
                      type="file"
                      accept="image/jpeg,image/png,application/pdf"
                      className="sr-only"
                      onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                    />
                  </label>
                </div>
                <label className="min-w-0">
                  <span className="mb-1 block text-10px font-bold uppercase tracking-widest text-white/45">
                    Monto reintegrado
                  </span>
                  <span className="flex h-10 w-full items-center overflow-hidden rounded-lg border border-[#7f2d3a]/55 bg-[#241217] focus-within:border-[#bf4a5b]">
                    <span className="flex h-full items-center border-r border-white/10 px-3 text-xs font-black text-white/55">
                      $
                    </span>
                    <input
                      value={amount}
                      onChange={(event) => setAmount(event.target.value)}
                      onBlur={() => {
                        const parsed = parseRefundAmountInput(amount)
                        if (parsed !== null) setAmount(formatRefundAmountInput(parsed))
                      }}
                      inputMode="decimal"
                      readOnly={!canEditRefundAmount}
                      disabled={!canEditRefundAmount}
                      placeholder="Monto reintegrado"
                      className="h-full min-w-0 flex-1 bg-transparent px-3 text-xs font-bold text-white outline-none placeholder:text-white/38 disabled:cursor-not-allowed disabled:text-white/55"
                    />
                  </span>
                </label>
                <label className="min-w-0">
                  <span className="mb-1 block text-10px font-bold uppercase tracking-widest text-white/45">
                    Método de reintegro
                  </span>
                  <input
                    value={method}
                    onChange={(event) => setMethod(event.target.value)}
                    placeholder="Transferencia, Mercado Pago, otro"
                    className="h-10 w-full rounded-lg border border-[#7f2d3a]/55 bg-[#241217] px-3 text-xs font-bold text-white outline-none placeholder:text-white/38 focus:border-[#bf4a5b]"
                  />
                </label>
                <label className="min-w-0">
                  <span className="mb-1 block text-10px font-bold uppercase tracking-widest text-white/45">
                    Observación visible para el cliente
                  </span>
                  <input
                    value={observation}
                    onChange={(event) => setObservation(event.target.value)}
                    placeholder="Opcional"
                    className="h-10 w-full rounded-lg border border-[#7f2d3a]/55 bg-[#241217] px-3 text-xs font-bold text-white outline-none placeholder:text-white/38 focus:border-[#bf4a5b]"
                  />
                </label>
              </div>
              <label className="mt-2 block min-w-0">
                <span className="mb-1 block text-10px font-bold uppercase tracking-widest text-white/45">
                  Observación interna, solo admin
                </span>
                <textarea
                  value={internalNote}
                  onChange={(event) => setInternalNote(event.target.value)}
                  rows={3}
                  placeholder="Notas internas sobre la devolución"
                  className="w-full resize-none rounded-lg border border-[#7f2d3a]/55 bg-[#241217] px-3 py-2 text-xs font-bold leading-5 text-white outline-none placeholder:text-white/38 focus:border-[#bf4a5b]"
                />
              </label>
              {!refundAmountIsValid && amount.trim() && (
                <p className="mt-2 text-xs font-bold text-red-200">
                  Ingresá un monto válido, mayor a cero y no superior al monto pagado.
                </p>
              )}
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={!canUploadRefund}
                  onClick={() => void uploadRefundProof()}
                  className={`inline-flex min-h-9 cursor-pointer items-center justify-center gap-2 rounded-lg border px-3 py-2 text-11px font-black uppercase tracking-wide transition disabled:cursor-not-allowed disabled:opacity-45 ${ADMIN_SENSITIVE_DANGER.action}`}
                >
                  {saving ? <LoaderCircle className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}
                  {saving ? "Guardando..." : "Subir comprobante y marcar como reintegrado"}
                </button>
              </div>
            </>
          )}
          {pedido.refund_proof_url && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={openingRefundProof}
                onClick={() => void openRefundProof()}
                className={`inline-flex h-9 cursor-pointer items-center justify-center gap-2 rounded-lg border px-3 text-11px font-black uppercase tracking-wide transition disabled:cursor-wait disabled:opacity-60 ${ADMIN_SENSITIVE_DANGER.action}`}
              >
                <Download className="size-4" />
                {openingRefundProof ? "Abriendo..." : "Ver comprobante"}
              </button>
            </div>
          )}
        </div>

        <div className={`min-w-0 rounded-xl border p-3 ${ADMIN_SENSITIVE_DANGER.panelSoft}`}>
          <p className={`text-10px font-black uppercase tracking-widest ${ADMIN_SENSITIVE_DANGER.label}`}>
            Comprobante de reintegro
          </p>
          {pedido.refund_proof_url ? (
            <div className="mt-3 space-y-2">
              <DetailValue label="Estado" value={refundCompactStatus} />
              <DetailValue
                label="Archivo cargado"
                value={pedido.refund_proof_file_name || "Comprobante registrado"}
              />
              <DetailValue
                label="Fecha de carga"
                value={formatOptionalOrderDate(pedido.refund_uploaded_at)}
              />
              <DetailValue
                label="Registrado por"
                value={refundRegisteredBy}
              />
              <DetailValue
                label="Monto reintegrado"
                value={refundDisplayAmount}
              />
            </div>
          ) : (
            <p className="mt-3 rounded-lg border border-white/8 bg-[#141820] px-3 py-2 text-xs font-bold leading-5 text-white/62">
              Todavía no hay comprobante de reintegro cargado.
            </p>
          )}
        </div>
      </div>

      <OrderTimeline pedido={pedido} />

      {message && (
        <p
          role="status"
          className={`mt-3 rounded-lg border px-3 py-2 text-xs font-bold ${
            message.ok
              ? "border-emerald-300/20 bg-emerald-400/8 text-emerald-100"
              : "border-red-300/20 bg-red-500/8 text-red-100"
          }`}
        >
          {message.text}
        </p>
      )}
    </section>
  )
}

function BillingManagementPanel({
  pedido,
  invoiceLoading,
  invoiceDownloading,
  invoiceNotice,
  onIssueInvoice,
  onDownloadInvoice,
  onDownloadCreditNote,
  onBillingUpdated,
}: {
  pedido: SupabasePedido
  invoiceLoading: boolean
  invoiceDownloading: boolean
  invoiceNotice: { ok: boolean; message: string } | null
  onIssueInvoice: () => void
  onDownloadInvoice: () => void
  onDownloadCreditNote: () => void
  onBillingUpdated: (order: SupabasePedido) => void
}) {
  const invoiceIssued = isOrderInvoicedForCreditNote(pedido)
  const creditNoteNeeded = needsCreditNoteReminder(pedido)
  const [creditSaving, setCreditSaving] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const creditNoteIssued =
    pedido.credit_note_status === "authorized" ||
    Boolean(pedido.credit_note_cae || pedido.credit_note_issued)
  const creditNoteAmount = Number(
    pedido.credit_note_amount ??
      pedido.refund_amount ??
      pedido.payment_confirmed_amount ??
      pedido.total ??
      0,
  )
  const creditNoteProcessing = pedido.credit_note_status === "processing" || creditSaving
  const creditNoteNumberLabel =
    pedido.credit_note_point && pedido.credit_note_number
      ? `NC C ${formatInvoiceNumber(pedido.credit_note_point, Number(pedido.credit_note_number))}`
      : pedido.credit_note_number || "Emitida"
  const creditNoteStatusLabel = creditNoteIssued
    ? creditNoteNumberLabel
    : pedido.credit_note_status === "processing"
      ? "Procesando"
      : pedido.credit_note_status === "error"
        ? "Error"
        : creditNoteNeeded
          ? "Pendiente"
          : "No requerida"

  useEffect(() => {
    setMessage(null)
  }, [pedido.id])

  const issueCreditNote = async () => {
    setCreditSaving(true)
    setMessage(null)

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession()

      if (!session?.access_token) {
        setMessage({ ok: false, text: "La sesión administrativa venció." })
        return
      }

      const response = await fetch(`/api/admin/orders/${pedido.id}/credit-note`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
      })
      const data = (await response.json()) as {
        order?: SupabasePedido
        error?: string
      }

      if (!response.ok || !data.order) {
        setMessage({
          ok: false,
          text: data.error || "No se pudo emitir la nota de crédito.",
        })
        return
      }

      onBillingUpdated(data.order)
      setMessage({ ok: true, text: "Nota de crédito emitida por ARCA." })
      notifyOrderNotificationsChanged()
    } catch {
      setMessage({ ok: false, text: "No se pudo emitir la nota de crédito." })
    } finally {
      setCreditSaving(false)
    }
  }

  return (
    <section className="rounded-2xl border border-beyonix-blue-light/20 bg-[#0B1118] p-4 sm:p-5">
      <div className="flex flex-col gap-4 border-b border-white/8 pb-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-11px font-bold uppercase tracking-widest text-beyonix-cyan">
            Facturación
          </p>
          <h3 className="mt-2 flex items-center gap-2 text-lg font-black text-white">
            <FileText className={`size-5 ${invoiceIssued ? "text-emerald-300" : "text-beyonix-sky"}`} />
            {invoiceIssued ? "Factura electrónica emitida" : "Emitir comprobante fiscal"}
          </h3>
          <p className="mt-1 max-w-xl text-sm leading-6 text-white/55">
            {invoiceIssued
              ? "Factura, CAE y datos contables asociados a este pedido."
              : "La Factura C se solicitará a ARCA y quedará asociada a este pedido."}
          </p>
        </div>

        {pedido.invoice_status === "authorized" ? (
          <button
            type="button"
            onClick={() => void onDownloadInvoice()}
            disabled={invoiceDownloading}
            className="inline-flex h-10 shrink-0 cursor-pointer items-center justify-center gap-2 rounded-xl border border-beyonix-blue-light/35 bg-beyonix-blue px-4 text-11px font-black uppercase tracking-wide text-beyonix-sky transition-colors hover:border-beyonix-blue-light disabled:cursor-wait disabled:opacity-60"
          >
            {invoiceDownloading ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : (
              <Download className="size-4" />
            )}
            {invoiceDownloading ? "Preparando..." : "Descargar factura"}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void onIssueInvoice()}
            disabled={invoiceLoading || !isApprovedPayment(pedido)}
            className="inline-flex h-10 shrink-0 cursor-pointer items-center justify-center gap-2 rounded-xl border border-beyonix-blue-light/45 bg-beyonix-blue px-4 text-11px font-black uppercase tracking-wide text-white transition-colors hover:border-beyonix-cyan hover:bg-beyonix-blue-hover disabled:cursor-not-allowed disabled:opacity-45"
          >
            {invoiceLoading ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : (
              <FileText className="size-4" />
            )}
            {invoiceLoading ? "Emitiendo factura..." : "Emitir Factura C"}
          </button>
        )}
      </div>

      {creditNoteNeeded && (
        <div className={`mt-4 rounded-xl border px-3 py-2 ${ADMIN_SENSITIVE_DANGER.panelSoft}`}>
          <p className={`text-xs font-black uppercase tracking-wide ${ADMIN_SENSITIVE_DANGER.label}`}>
            Nota de crédito requerida
          </p>
          <p className={`mt-0.5 text-xs font-medium ${ADMIN_SENSITIVE_DANGER.textMuted}`}>
            La Factura C ya fue emitida y el pedido tiene una cancelación o devolución activa.
          </p>
        </div>
      )}

      {invoiceIssued ? (
        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          <div className="admin-order-info-card rounded-xl border border-white/8 p-3">
            <DetailValue
              label="Tipo y número"
              value={`Factura C ${formatInvoiceNumber(pedido.invoice_point, pedido.invoice_number)}`}
            />
          </div>
          <div className="admin-order-info-card rounded-xl border border-white/8 p-3">
            <DetailValue label="CAE" value={pedido.invoice_cae || "No informado"} />
          </div>
          <div className="admin-order-info-card rounded-xl border border-white/8 p-3">
            <DetailValue
              label="Vencimiento CAE"
              value={formatInvoiceDate(pedido.invoice_cae_due)}
            />
          </div>
          <div className="admin-order-info-card rounded-xl border border-white/8 p-3">
            <DetailValue
              label="Fecha de emisión"
              value={formatOptionalOrderDate(pedido.invoice_created_at)}
            />
          </div>
          <div className="admin-order-info-card rounded-xl border border-white/8 p-3">
            <DetailValue
              label="Nota de crédito"
              value={creditNoteStatusLabel}
            />
          </div>
        </div>
      ) : !isApprovedPayment(pedido) ? (
        <p className="mt-4 rounded-xl border border-amber-400/20 bg-amber-400/8 px-3 py-2 text-xs font-medium text-amber-200">
          Confirmá el pago antes de emitir la factura.
        </p>
      ) : null}

      {invoiceIssued && isCancellationFlowOrder(pedido) && (
        <div className={`mt-4 rounded-xl border p-3 ${ADMIN_SENSITIVE_DANGER.panelSoft}`}>
          <p className={`text-10px font-black uppercase tracking-widest ${ADMIN_SENSITIVE_DANGER.label}`}>
            Nota de crédito
          </p>
          {creditNoteIssued ? (
            <div className="mt-3 space-y-3">
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
                <div className="admin-order-info-card rounded-xl border border-white/8 p-3">
                  <DetailValue
                    label="Tipo y número"
                    value={creditNoteNumberLabel}
                  />
                </div>
                <div className="admin-order-info-card rounded-xl border border-white/8 p-3">
                  <DetailValue label="CAE" value={pedido.credit_note_cae || "No informado"} />
                </div>
                <div className="admin-order-info-card rounded-xl border border-white/8 p-3">
                  <DetailValue
                    label="Vencimiento CAE"
                    value={formatInvoiceDate(pedido.credit_note_cae_due)}
                  />
                </div>
                <div className="admin-order-info-card rounded-xl border border-white/8 p-3">
                  <DetailValue
                    label="Fecha emisión"
                    value={formatOptionalOrderDate(pedido.credit_note_created_at || pedido.credit_note_issued_at)}
                  />
                </div>
                <div className="admin-order-info-card rounded-xl border border-white/8 p-3">
                  <DetailValue
                    label="Monto acreditado"
                    value={formatPrice(creditNoteAmount)}
                  />
                </div>
              </div>
              <button
                type="button"
                onClick={() => void onDownloadCreditNote()}
                className={`inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-lg border px-3 text-11px font-black uppercase tracking-wide transition ${ADMIN_SENSITIVE_DANGER.action}`}
              >
                <Download className="size-4" />
                Descargar Nota de Crédito
              </button>
            </div>
          ) : (
            <div className="mt-3 grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="admin-order-info-card rounded-xl border border-white/8 p-3">
                  <DetailValue
                    label="Factura origen"
                    value={`Factura C ${formatInvoiceNumber(pedido.invoice_point, pedido.invoice_number)}`}
                  />
                </div>
                <div className="admin-order-info-card rounded-xl border border-white/8 p-3">
                  <DetailValue
                    label="Monto a acreditar"
                    value={formatPrice(creditNoteAmount)}
                  />
                </div>
                <div className="admin-order-info-card rounded-xl border border-white/8 p-3">
                  <DetailValue
                    label="Estado"
                    value={
                      pedido.credit_note_status === "error"
                        ? "Error de ARCA"
                        : creditNoteProcessing
                          ? "Procesando"
                          : "Pendiente"
                    }
                  />
                </div>
              </div>
              <button
                type="button"
                disabled={creditNoteProcessing || creditNoteAmount <= 0}
                onClick={() => void issueCreditNote()}
                className={`inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-lg border px-3 text-11px font-black uppercase tracking-wide transition disabled:cursor-not-allowed disabled:opacity-50 ${ADMIN_SENSITIVE_DANGER.action}`}
              >
                {creditNoteProcessing ? (
                  <LoaderCircle className="size-4 animate-spin" />
                ) : (
                  <FileText className="size-4" />
                )}
                {creditNoteProcessing ? "Emitiendo..." : "Emitir Nota de Crédito"}
              </button>
            </div>
          )}
          {pedido.credit_note_error && !creditNoteIssued && (
            <p className="mt-3 rounded-lg border border-red-400/20 bg-red-500/8 px-3 py-2 text-xs font-bold text-red-100">
              {pedido.credit_note_error}
            </p>
          )}
        </div>
      )}

      {(invoiceNotice || message) && (
        <p
          role="status"
          className={`mt-4 rounded-xl border px-3 py-2 text-xs font-medium ${
            (message?.ok ?? invoiceNotice?.ok)
              ? "border-emerald-400/20 bg-emerald-400/8 text-emerald-200"
              : "border-red-400/20 bg-red-400/8 text-red-200"
          }`}
        >
          {message?.text ?? invoiceNotice?.message}
        </p>
      )}
    </section>
  )
}

function AdminOrderSummaryDashboard({
  pedido,
  financialBreakdown,
  onGoToView,
}: {
  pedido: SupabasePedido
  financialBreakdown: ReturnType<typeof getOrderFinancialBreakdown>
  onGoToView: (view: AdminOrderDetailView) => void
}) {
  const statusCards = getOrderSummaryBadges(pedido)
  const action = getOrderRecommendedAction(pedido)
  const latestActivity = getOrderLatestActivity(pedido)
  const mainStatus = getExecutiveOrderStatus(pedido)
  const refundAmount = Number(pedido.refund_amount ?? 0)
  const confirmedAmount = Number(pedido.payment_confirmed_amount ?? 0)
  const orderTotal = Number(pedido.total ?? 0)
  const pendingBalance =
    isOrderPaymentConfirmed(pedido)
      ? 0
      : Math.max(0, orderTotal - (Number.isFinite(confirmedAmount) ? confirmedAmount : 0))
  const refundedOrder = isRefundedOrder(pedido) && refundAmount > 0
  const paymentStateText = refundedOrder
    ? "Devolución finalizada"
    : isOrderPaymentConfirmed(pedido)
    ? "Pago confirmado"
    : getPaymentStatusLabel(pedido.payment_status)
  const paymentContext = refundedOrder
    ? paymentStateText
    : `${paymentStateText} · ${getPaymentMethodLabel(pedido)}`
  const totalLabel = refundedOrder
    ? "Monto reintegrado"
    : isOrderPaymentConfirmed(pedido)
    ? "Total cobrado"
    : confirmedAmount > 0
      ? "Saldo pendiente"
      : "Total a cobrar"
  const totalValue = refundedOrder
    ? refundAmount
    : isOrderPaymentConfirmed(pedido)
    ? orderTotal
    : confirmedAmount > 0
      ? pendingBalance
      : orderTotal
  const finalBalance = Math.max(0, orderTotal - refundAmount)
  const ActionIcon =
    action.target === "pago"
      ? CreditCard
      : action.target === "envio"
        ? Truck
        : action.target === "facturacion"
          ? FileText
          : action.target === "reclamos"
            ? AlertTriangle
            : action.target === "cancelacion"
              ? X
              : CheckCircle2
  const actionToneClass = {
    urgent: ADMIN_SENSITIVE_DANGER.panel,
    warning: "border-amber-300/20 bg-amber-400/7",
    info: "border-beyonix-blue-light/20 bg-beyonix-blue/14",
    success: "border-emerald-300/18 bg-emerald-400/7",
  }[action.tone]
  const sensitiveAction =
    action.target === "reclamos" ||
    action.target === "cancelacion" ||
    isAdminSensitiveStatus(action.title)

  return (
    <div className="space-y-3">
      <section className={`rounded-2xl border bg-[#0B1118] p-4 sm:p-5 ${actionToneClass}`}>
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(280px,0.42fr)] lg:items-center">
          <div className="min-w-0 space-y-3">
            <p className="text-11px font-bold uppercase tracking-widest text-beyonix-cyan">
              Resumen ejecutivo
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-xl font-black text-white">
                Pedido #{formatPublicOrderId(pedido.id)}
              </h3>
              <span className={`rounded-full border px-3 py-1 text-xs font-black uppercase tracking-wide ${
                isAdminSensitiveStatus(mainStatus)
                  ? ADMIN_SENSITIVE_DANGER.badge
                  : "border-white/10 bg-black/24 text-white/82"
              }`}>
                {mainStatus}
              </span>
            </div>
            <div className="grid gap-1 text-sm sm:grid-cols-[auto_minmax(0,1fr)] sm:items-baseline">
              <span className="text-white/42">Última actividad</span>
              <span className="font-bold text-white/82">{latestActivity.label}</span>
              <span className="text-white/42">Fecha</span>
              <span className="font-medium text-white/58">{formatOptionalOrderDate(latestActivity.at)}</span>
            </div>
          </div>

          <div className="rounded-xl border border-white/10 bg-black/18 p-3">
            <div className="flex items-start gap-2.5">
              <span className={`inline-flex size-8 shrink-0 items-center justify-center rounded-lg border ${
                sensitiveAction
                  ? ADMIN_SENSITIVE_DANGER.icon
                  : "border-beyonix-blue-light/18 bg-beyonix-blue/18 text-beyonix-sky"
              }`}>
                <ActionIcon className="size-4" />
              </span>
              <div className="min-w-0">
                <p className="text-10px font-bold uppercase tracking-widest text-white/46">
                  Acción recomendada
                </p>
                <p className="mt-1 text-base font-black text-white">{action.title}</p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => onGoToView(action.target)}
              className={`mt-3 inline-flex h-9 cursor-pointer items-center justify-center rounded-lg border px-3 text-11px font-black uppercase tracking-wide transition ${
                sensitiveAction
                  ? ADMIN_SENSITIVE_DANGER.action
                  : "border-beyonix-blue-light/30 bg-beyonix-blue/50 text-beyonix-sky hover:border-beyonix-blue-light hover:bg-beyonix-blue"
              }`}
            >
              {action.buttonLabel}
            </button>
          </div>
        </div>
      </section>

      <section className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
        {statusCards.map((card) => (
          <div
            key={card.label}
            className={`rounded-xl border px-3 py-2.5 ${card.className}`}
          >
            <p className="text-10px font-black uppercase tracking-widest text-white/42">
              {card.label}
            </p>
            <p className="mt-1 text-sm font-black text-white/88">{card.value}</p>
          </div>
        ))}
      </section>

      <div className="grid gap-3 xl:grid-cols-[minmax(320px,0.42fr)_minmax(0,0.58fr)]">
        <section className="rounded-xl border border-white/8 bg-[#0D1117] p-3 sm:p-4">
          <div className="flex items-center justify-between gap-3">
            <p className="text-11px font-bold uppercase tracking-widest text-beyonix-cyan">
              Resumen económico
            </p>
            <span className="rounded-full border border-white/8 bg-black/24 px-2.5 py-1 text-10px font-black uppercase tracking-wide text-white/48">
              Ticket
            </span>
          </div>

          <div className="mt-4 space-y-2 text-sm">
            <div className="flex items-baseline justify-between gap-4">
              <span className="text-white/54">Subtotal productos</span>
              <span className="font-bold text-white/82">{formatPrice(financialBreakdown.productsSubtotal)}</span>
            </div>
            <div className="flex items-baseline justify-between gap-4">
              <span className="text-white/54">Descuento transferencia</span>
              <span className="font-bold text-white/72">
                {financialBreakdown.transferDiscount > 0
                  ? `-${formatPrice(financialBreakdown.transferDiscount)}`
                  : formatPrice(0)}
              </span>
            </div>
            <div className="flex items-baseline justify-between gap-4">
              <span className="text-white/54">Envío</span>
              <span className="font-bold text-white/82">
                {financialBreakdown.shipping > 0 ? formatPrice(financialBreakdown.shipping) : "Gratis"}
              </span>
            </div>
          </div>

          <div className="my-4 border-t border-dashed border-white/12" />

          <div className="rounded-xl border border-emerald-300/22 bg-emerald-400/6 p-3 shadow-[0_0_22px_rgba(16,185,129,0.08)]">
            <p className="text-10px font-black uppercase tracking-widest text-emerald-100/78">
              {totalLabel}
            </p>
            <p className="mt-1 text-2xl font-black text-white sm:text-3xl">
              {formatPrice(totalValue)}
            </p>
            <p className="mt-1 text-xs font-medium text-white/48">
              {paymentContext}
            </p>
          </div>

          {(isCancellationFlowOrder(pedido) || refundAmount > 0) && (
            <div className="mt-3 space-y-2 border-t border-white/8 pt-3 text-sm">
              {!refundedOrder && (
                <div className="flex items-baseline justify-between gap-4">
                  <span className="text-white/54">Monto reintegrado</span>
                  <span className="font-black text-white/84">
                    {refundAmount > 0 ? `-${formatPrice(refundAmount)}` : "Pendiente"}
                  </span>
                </div>
              )}
              {(refundAmount > 0 || refundedOrder) && (
                <div className="flex items-baseline justify-between gap-4">
                  <span className="text-white/54">Saldo final</span>
                  <span className="font-black text-white">{formatPrice(finalBalance)}</span>
                </div>
              )}
            </div>
          )}
        </section>

        <section className="rounded-xl border border-white/8 bg-[#0D1117] p-3 sm:p-4">
          <p className="text-11px font-bold uppercase tracking-widest text-beyonix-cyan">
            Cliente y dirección
          </p>
          <div className="mt-3 space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <DetailValue label="Nombre" value={pedido.cliente_nombre || "Cliente sin nombre"} />
              <DetailValue label="Usuario" value={(pedido.cliente_username || "Sin usuario").toUpperCase()} />
              <DetailValue label="Email" value={pedido.cliente_email || "No informado"} />
              <DetailValue label="Teléfono" value={pedido.cliente_telefono || "No informado"} />
            </div>
            <CustomerAddressDetails pedido={pedido} />
          </div>
        </section>
      </div>
    </div>
  )
}

function getOrderStatusSelectClassName(status: string) {
  const styles: Record<string, string> = {
    pendiente:
      "!border-amber-400/35 !bg-amber-400/10 !text-amber-200 hover:!bg-amber-400/14",
    pagado:
      "!border-emerald-400/35 !bg-emerald-400/10 !text-emerald-200 hover:!bg-emerald-400/14",
    enviado:
      "!border-beyonix-blue-light/45 !bg-beyonix-blue/35 !text-beyonix-sky hover:!bg-beyonix-blue/45",
    en_camino:
      "!border-sky-300/35 !bg-sky-400/10 !text-sky-200 hover:!bg-sky-400/14",
    entregado:
      "!border-emerald-300/45 !bg-emerald-500/12 !text-emerald-100 hover:!bg-emerald-500/16",
    cancelado:
      "!border-[#9f3546] !bg-[#2a1117] !text-[#ffc2c8] hover:!bg-[#35151d]",
  }

  return styles[status] ?? ""
}

function getOrderFinancialBreakdown(pedido: SupabasePedido) {
  const productsSubtotal = (pedido.orden_items ?? []).reduce(
    (sum, item) =>
      sum + Number(item.precio ?? 0) * Number(item.cantidad ?? 0),
    0,
  )
  const shipping = Number(
    pedido.shipping_cost_charged ?? pedido.andreani_costo ?? 0,
  )
  const transferDiscount = Number(pedido.transfer_discount_amount ?? 0)

  return {
    productsSubtotal,
    shipping,
    transferDiscount,
  }
}

function MobileOrderField({
  label,
  children,
  align = "left",
}: {
  label: string
  children: React.ReactNode
  align?: "left" | "right"
}) {
  return (
    <div className={`min-w-0 ${align === "right" ? "text-right" : ""}`}>
      <p className="text-9px font-bold uppercase tracking-widest text-white/38">
        {label}
      </p>
      <div className="mt-1 min-w-0 text-sm font-bold text-white/88">
        {children}
      </div>
    </div>
  )
}

function PedidoPreviewModal({
  pedido,
  pedidos,
  onClose,
  onOpenPaymentProof,
  onPaymentStatusChange,
}: {
  pedido: SupabasePedido
  pedidos: SupabasePedido[]
  onClose: () => void
  onOpenPaymentProof: (pedidoId: number) => Promise<boolean>
  onPaymentStatusChange: (pedidoId: number, nextStatus: string) => void
}) {
  const clientKey = getPedidoClientKey(pedido)
  const paidPedidos = pedidos.filter(
    (currentPedido) =>
      currentPedido.estado === "pagado" &&
      getPedidoClientKey(currentPedido) === clientKey
  )
  const pedidosToShow =
    pedido.estado === "pagado" && paidPedidos.length > 0
      ? paidPedidos
      : [pedido]
  const total = pedidosToShow.reduce(
    (sum, currentPedido) => sum + Number(currentPedido.total ?? 0),
    0
  )
  const itemsCount = pedidosToShow.reduce(
    (sum, currentPedido) =>
      sum +
      (currentPedido.orden_items ?? []).reduce(
        (itemsSum, item) => itemsSum + Number(item.cantidad ?? 0),
        0
      ),
    0
  )
  const isGrouped = pedidosToShow.length > 1

  return (
    <div className="fixed inset-0 z-100 flex items-center justify-center bg-black/82 px-4 py-6 backdrop-blur-sm">
      <div className="flex max-h-80vh w-full max-w-6xl flex-col overflow-hidden rounded-3xl border border-white/10 bg-beyonix-surface shadow-2xl shadow-black/80">
        <div className="flex items-start justify-between gap-4 border-b border-white/8 px-5 py-4 sm:px-6">
          <div>
            <p className="text-11px font-bold uppercase tracking-widest text-beyonix-cyan">
              Ver pedido
            </p>
            <h2 className="mt-1 text-2xl font-black text-white">
              Pedido #{formatPublicOrderId(pedido.id)}
            </h2>
            <p className="mt-1 text-sm text-white/55">
              {isGrouped
                ? `Mostrando ${pedidosToShow.length} pedidos pagados unificados de este cliente.`
                : "Detalle completo del pedido seleccionado."}
            </p>
          </div>

          <button
            type="button"
            title="Cerrar detalle del pedido"
            aria-label="Cerrar detalle del pedido"
            onClick={onClose}
            className="flex size-10 cursor-pointer items-center justify-center rounded-xl border border-white/10 text-white/62 transition-colors hover:border-white/22 hover:text-white"
          >
            <X className="size-5" />
          </button>
        </div>

        <div className="custom-scrollbar overflow-y-auto px-5 py-5 sm:px-6">
          <div className="grid gap-4 lg:grid-cols-3">
            <section className="rounded-2xl border border-white/8 bg-black p-4">
              <p className="text-11px font-bold uppercase tracking-widest text-white/45">
                Cliente
              </p>
              <h3 className="mt-3 text-lg font-black text-white">
                {pedido.cliente_nombre || "Cliente sin nombre"}
              </h3>
              <div className="mt-3 space-y-2 text-sm text-white/62">
                <p>{pedido.cliente_email || "Email no informado"}</p>
                <p>{pedido.cliente_telefono || "Teléfono no informado"}</p>
                <p>{pedido.cliente_direccion || "Dirección no informada"}</p>
              </div>
            </section>

            <section className="rounded-2xl border border-white/8 bg-black p-4">
              <p className="text-11px font-bold uppercase tracking-widest text-white/45">
                Resumen
              </p>
              <div className="mt-3 grid grid-cols-2 gap-3">
                <div>
                  <p className="text-11px uppercase tracking-widest text-white/38">
                    Pedidos
                  </p>
                  <p className="mt-1 text-xl font-black text-white">
                    {pedidosToShow.length}
                  </p>
                </div>
                <div>
                  <p className="text-11px uppercase tracking-widest text-white/38">
                    Unidades
                  </p>
                  <p className="mt-1 text-xl font-black text-white">
                    {itemsCount}
                  </p>
                </div>
                <div className="col-span-2">
                  <p className="text-11px uppercase tracking-widest text-white/38">
                    Total
                  </p>
                  <p className="mt-1 text-2xl font-black text-white">
                    {formatPrice(total)}
                  </p>
                </div>
              </div>
            </section>

            <section className="rounded-2xl border border-white/8 bg-black p-4">
              <p className="text-11px font-bold uppercase tracking-widest text-white/45">
                Pedido seleccionado
              </p>
              <div className="mt-3 space-y-2 text-sm text-white/62">
                <p>Estado: {pedido.estado}</p>
                <p>Fecha: {formatOrderDate(pedido.created_at)}</p>
                <p>Pago: {pedido.payment_id || "Sin ID pago"}</p>
                <p>
                  Método:{" "}
                  {pedido.payment_method_id ||
                    pedido.payment_type_id ||
                    "Método no informado"}
                </p>
                <p>Seguimiento: {pedido.tracking_number || "Pendiente"}</p>
              </div>
            </section>
          </div>

          {pedido.payment_method_id === "transferencia" && (
            <section className="mt-5 rounded-2xl border border-beyonix-blue-light/25 bg-black p-4">
              <div className="flex flex-col gap-4 border-b border-white/7 pb-4 lg:flex-row lg:items-start lg:justify-between">
                <div>
                  <p className="text-11px font-bold uppercase tracking-widest text-beyonix-cyan">
                    Pago por transferencia
                  </p>
                  <h3 className="mt-2 flex items-center gap-2 text-xl font-black text-white">
                    <CreditCard className="size-5 text-beyonix-sky" />
                    Alias usado: {pedido.transfer_alias || "beyonix"}
                  </h3>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <TransferPaymentBadges pedido={pedido} />
                  </div>
                </div>

                <div className="w-full max-w-sm">
                  <p className="mb-2 text-10px font-bold uppercase tracking-widest text-white/38">
                    Estado administrativo de pago
                  </p>
                  <AdminSelect
                    title="Estado de pago"
                    value={pedido.payment_status || "pendiente_comprobante"}
                    onChange={(value) => onPaymentStatusChange(pedido.id, value)}
                  >
                    <option value="pendiente_comprobante">Pendiente comprobante</option>
                    <option value="en_revision">En revisión</option>
                    <option value="confirmado">Confirmado</option>
                    <option value="rechazado">Rechazado</option>
                  </AdminSelect>
                </div>
              </div>

              <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                <div className="rounded-xl border border-white/7 bg-white/3 p-3">
                  <p className="text-10px font-bold uppercase tracking-widest text-white/38">
                    Estado de pago
                  </p>
                  <p className="mt-2 text-sm font-black text-white">
                    {getPaymentStatusLabel(pedido.payment_status)}
                  </p>
                </div>
                <div className="rounded-xl border border-white/7 bg-white/3 p-3">
                  <p className="text-10px font-bold uppercase tracking-widest text-white/38">
                    Descuento transferencia
                  </p>
                  <p className="mt-2 text-sm font-black text-emerald-300">
                    {formatPrice(Number(pedido.transfer_discount_amount ?? 0))}
                  </p>
                </div>
                <div className="rounded-xl border border-white/7 bg-white/3 p-3">
                  <p className="text-10px font-bold uppercase tracking-widest text-white/38">
                    Comprobante actual
                  </p>
                  <p
                    title={pedido.payment_proof_file_name || "Sin comprobante"}
                    className="mt-2 wrap-break-word text-sm font-black text-white"
                  >
                    {pedido.payment_proof_file_name || "Sin comprobante"}
                  </p>
                </div>
                <div className="rounded-xl border border-white/7 bg-white/3 p-3">
                  <p className="text-10px font-bold uppercase tracking-widest text-white/38">
                    Fecha de subida
                  </p>
                  <p className="mt-2 text-sm font-black text-white">
                    {formatOptionalOrderDate(pedido.payment_proof_uploaded_at)}
                  </p>
                </div>
              </div>

              <div className="mt-4 rounded-xl border border-white/7 bg-white/3 p-3">
                <p className="text-10px font-bold uppercase tracking-widest text-white/38">
                  Comprobante
                </p>
                {pedido.payment_proof_url ? (
                  <button
                    type="button"
                    aria-label={`Ver comprobante del pedido ${pedido.id}`}
                    title="Ver o descargar comprobante"
                    onClick={() => onOpenPaymentProof(pedido.id)}
                    className="mt-3 inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-xl border border-beyonix-blue-light/35 px-3 text-11px font-black uppercase tracking-wide text-beyonix-sky transition-colors hover:bg-beyonix-blue"
                  >
                    <Download className="size-4" />
                    Ver comprobante
                  </button>
                ) : (
                  <p className="mt-2 text-sm font-black text-white/55">
                    Sin comprobante
                  </p>
                )}
              </div>
            </section>
          )}

          <section className="mt-5 rounded-2xl border border-white/8 bg-black p-4">
            <p className="text-11px font-bold uppercase tracking-widest text-beyonix-cyan">
              Estados administrativos
            </p>
            <div className="mt-4 grid gap-3 md:grid-cols-3">
              <div className="rounded-xl border border-white/7 bg-white/3 p-3">
                <p className="text-10px font-bold uppercase tracking-widest text-white/38">
                  Estado del pedido
                </p>
                <div className="mt-2">
                  <EstadoBadge estado={getDisplayedOrderStatus(pedido)} />
                </div>
              </div>
              <div className="rounded-xl border border-white/7 bg-white/3 p-3">
                <p className="text-10px font-bold uppercase tracking-widest text-white/38">
                  Estado de pago
                </p>
                {pedido.payment_method_id === "transferencia" ? (
                  <div className="mt-2">
                    <TransferPaymentBadges pedido={pedido} />
                  </div>
                ) : (
                  <p className="mt-2 text-sm font-black text-white">
                    {getPaymentStatusLabel(pedido.payment_status)}
                  </p>
                )}
              </div>
              <div className="rounded-xl border border-white/7 bg-white/3 p-3">
                <p className="text-10px font-bold uppercase tracking-widest text-white/38">
                  Despacho
                </p>
                <span
                  title={getDispatchAlert(pedido).label}
                  className={`mt-2 inline-flex items-center gap-2 rounded-full border px-3 py-1 text-11px font-black uppercase tracking-wide ${getDispatchAlert(pedido).className}`}
                >
                  <AlertTriangle className="size-3.5" />
                  {getDispatchAlert(pedido).label}
                </span>
              </div>
            </div>
          </section>

          <section className="mt-5 rounded-2xl border border-white/8 bg-black p-4">
            <div className="flex flex-col gap-4 border-b border-white/7 pb-4 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <p className="text-11px font-bold uppercase tracking-widest text-beyonix-cyan">
                  Envío
                </p>
                <h3 className="mt-2 flex items-center gap-2 text-xl font-black text-white">
                  <Truck className="size-5 text-beyonix-sky" />
                  Proveedor: {getShippingProvider(pedido)}
                </h3>
                <p className="mt-2 text-sm text-white/55">
                  Integración preparada para Andreani. Las credenciales reales
                  quedan reservadas para el backend.
                </p>
              </div>

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  title="Generar envío Andreani"
                  aria-label={`Generar envío Andreani para pedido ${pedido.id}`}
                  onClick={() => runAndreaniAction("crear-envio", pedido.id)}
                  className="inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-xl border border-beyonix-blue-light/30 bg-beyonix-blue px-3 text-11px font-black uppercase tracking-wide text-beyonix-sky transition-colors hover:border-beyonix-blue-light hover:bg-beyonix-blue-hover"
                >
                  <Truck className="size-4" />
                  Generar envío Andreani
                </button>
                <button
                  type="button"
                  title="Consultar tracking"
                  aria-label={`Consultar tracking Andreani para pedido ${pedido.id}`}
                  onClick={() => runAndreaniAction("tracking", pedido.id)}
                  className="inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-xl border border-white/10 px-3 text-11px font-black uppercase tracking-wide text-white/72 transition-colors hover:border-beyonix-blue-light/35 hover:text-beyonix-sky"
                >
                  <RefreshCw className="size-4" />
                  Consultar tracking
                </button>
                <button
                  type="button"
                  title="Imprimir etiqueta"
                  aria-label={`Imprimir etiqueta Andreani para pedido ${pedido.id}`}
                  onClick={() => handlePrintAndreaniLabel(pedido)}
                  className="inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-xl border border-white/10 px-3 text-11px font-black uppercase tracking-wide text-white/72 transition-colors hover:border-beyonix-blue-light/35 hover:text-beyonix-sky"
                >
                  <Printer className="size-4" />
                  Imprimir etiqueta
                </button>
              </div>
            </div>

            <div className="mt-4 grid gap-3 md:grid-cols-3 xl:grid-cols-6">
              <div className="rounded-xl border border-white/7 bg-white/3 p-3">
                <p className="text-10px font-bold uppercase tracking-widest text-white/38">
                  Estado de envío
                </p>
                <p className="mt-2 text-sm font-black text-white">
                  {getAndreaniStatus(pedido)}
                </p>
              </div>
              <div className="rounded-xl border border-white/7 bg-white/3 p-3">
                <p className="text-10px font-bold uppercase tracking-widest text-white/38">
                  Tracking
                </p>
                <p className="mt-2 wrap-break-word text-sm font-black text-white">
                  {pedido.andreani_tracking || pedido.tracking_number || "Pendiente"}
                </p>
              </div>
              <div className="rounded-xl border border-white/7 bg-white/3 p-3">
                <p className="text-10px font-bold uppercase tracking-widest text-white/38">
                  Envío ID
                </p>
                <p className="mt-2 wrap-break-word text-sm font-black text-white">
                  {pedido.andreani_envio_id || "Pendiente"}
                </p>
              </div>
              <div className="rounded-xl border border-white/7 bg-white/3 p-3">
                <p className="text-10px font-bold uppercase tracking-widest text-white/38">
                  Etiqueta
                </p>
                <p className="mt-2 wrap-break-word text-sm font-black text-white">
                  {pedido.andreani_etiqueta_url ? "Disponible" : "Pendiente"}
                </p>
              </div>
              <div className="rounded-xl border border-white/7 bg-white/3 p-3">
                <p className="text-10px font-bold uppercase tracking-widest text-white/38">
                  Costo
                </p>
                <p className="mt-2 text-sm font-black text-white">
                  {typeof pedido.andreani_costo === "number"
                    ? formatPrice(pedido.andreani_costo)
                    : "Pendiente"}
                </p>
              </div>
              <div className="rounded-xl border border-white/7 bg-white/3 p-3">
                <p className="text-10px font-bold uppercase tracking-widest text-white/38">
                  Error
                </p>
                <p
                  title={pedido.andreani_error || "Sin errores"}
                  className="mt-2 wrap-break-word text-sm font-black text-white"
                >
                  {pedido.andreani_error || "Sin errores"}
                </p>
              </div>
            </div>
          </section>

          <div className="mt-5 space-y-4">
            {pedidosToShow.map((currentPedido) => (
              <section
                key={currentPedido.id}
                className="rounded-2xl border border-white/8 bg-black p-4"
              >
                <div className="flex flex-col gap-3 border-b border-white/7 pb-4 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <h3 className="text-lg font-black text-white">
                      Pedido #{formatPublicOrderId(currentPedido.id)}
                    </h3>
                    <p className="mt-1 text-sm text-white/55">
                      {formatOrderDate(currentPedido.created_at)} · Estado:{" "}
                      {currentPedido.estado}
                    </p>
                  </div>
                  {isGrouped && (
                    <div className="text-left sm:text-right">
                      <p className="text-11px font-bold uppercase tracking-widest text-white/38">
                        Total de este pedido
                      </p>
                      <p className="mt-1 text-xl font-black text-white">
                        {formatPrice(currentPedido.total)}
                      </p>
                    </div>
                  )}
                </div>

                <div className="mt-4">
                  <div className="mb-2 hidden grid-cols-admin-order-modal-item gap-4 px-3 xl:grid">
                    {[
                      "Producto",
                      "Color",
                      "Cantidad",
                      "Precio unitario",
                      "Subtotal",
                    ].map((label) => (
                      <span
                        key={label}
                        className={`text-11px font-bold uppercase tracking-widest text-white/38 ${
                          label === "Producto" ? "text-left" : "text-center"
                        }`}
                      >
                        {label}
                      </span>
                    ))}
                  </div>

                  <div className="space-y-3">
                    {(currentPedido.orden_items ?? []).map((item) => {
                      const image = getItemImage(item)
                      const productName =
                        item.productos?.nombre ?? `Producto #${item.producto_id}`
                      const quantity = Number(item.cantidad ?? 0)
                      const unitPrice = Number(item.precio ?? 0)
                      const subtotal = quantity * unitPrice

                      return (
                        <div
                          key={item.id}
                          className="grid gap-4 rounded-2xl border border-white/7 bg-white/3 p-3 sm:grid-cols-admin-order-modal-item sm:items-center"
                        >
                          <div className="flex items-center gap-3">
                            <div className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-white/8 bg-white">
                              {image ? (
                                <img
                                  src={image}
                                  alt={productName}
                                  className="size-full object-contain"
                                />
                              ) : (
                                <ShoppingCart className="size-6 text-black/35" />
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

                          <div className="text-center text-sm text-white/72">
                            <p className="text-11px font-bold uppercase tracking-widest text-white/38">
                              Color
                            </p>
                            <p className="mt-1 font-black text-white">
                              {getItemColor(item)}
                            </p>
                          </div>

                          <div className="text-center text-sm text-white/72">
                            <p className="text-11px font-bold uppercase tracking-widest text-white/38">
                              Cantidad
                            </p>
                            <p className="mt-1 font-black text-white">
                              {quantity}
                            </p>
                          </div>

                          <div className="text-center text-sm text-white/72">
                            <p className="text-11px font-bold uppercase tracking-widest text-white/38">
                              Precio unitario
                            </p>
                            <p className="mt-1 font-black text-white">
                              {formatPrice(unitPrice)}
                            </p>
                          </div>

                          <div className="text-center text-sm text-white/72">
                            <p className="text-11px font-bold uppercase tracking-widest text-white/38">
                              Subtotal
                            </p>
                            <p className="mt-1 font-black text-white">
                              {formatPrice(subtotal)}
                            </p>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              </section>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function PedidoDetailModal({
  pedido,
  isSuperAdmin,
  canEditRefundAmount,
  onClose,
  onOpenPaymentProof,
  onEstadoChange,
  onPaymentStatusChange,
  onAndreaniAction,
  onIssueInvoice,
  onDownloadInvoice,
  onDownloadCreditNote,
  onClaimChange,
  onRefundUpdated,
  embedded = false,
}: {
  pedido: SupabasePedido
  isSuperAdmin: boolean
  canEditRefundAmount: boolean
  onClose: () => void
  onOpenPaymentProof: (pedidoId: number) => Promise<boolean>
  onEstadoChange: (pedido: SupabasePedido, nextEstado: string) => void
  onPaymentStatusChange: (pedidoId: number, nextStatus: string) => void
  onAndreaniAction: (
    action: AndreaniAction,
    pedidoId: number
  ) => Promise<{ ok: boolean; message: string }>
  onIssueInvoice: (
    pedidoId: number
  ) => Promise<{ ok: boolean; message: string }>
  onDownloadInvoice: (
    pedidoId: number
  ) => Promise<{ ok: boolean; message: string }>
  onDownloadCreditNote: (
    pedidoId: number
  ) => Promise<{ ok: boolean; message: string }>
  onClaimChange: (pedidoId: number, claim: SupabaseOrderClaim) => void
  onRefundUpdated: (order: SupabasePedido) => void
  embedded?: boolean
}) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const items = pedido.orden_items ?? []
  const financialBreakdown = getOrderFinancialBreakdown(pedido)
  const dispatch = getDispatchAlert(pedido)
  const tracking = pedido.andreani_tracking || pedido.tracking_number
  const isLocalRosarioOrder = isLocalRosarioDeliveryOrder(pedido)
  const [andreaniLoading, setAndreaniLoading] = useState<AndreaniAction | null>(
    null
  )
  const [andreaniNotice, setAndreaniNotice] = useState<{
    ok: boolean
    message: string
  } | null>(null)
  const [invoiceLoading, setInvoiceLoading] = useState(false)
  const [invoiceDownloading, setInvoiceDownloading] = useState(false)
  const [paymentProofSeen, setPaymentProofSeen] = useState(true)
  const [invoiceNotice, setInvoiceNotice] = useState<{
    ok: boolean
    message: string
  } | null>(null)
  const [activeView, setActiveView] =
    useState<AdminOrderDetailView>(() =>
      getAdminOrderDetailView(searchParams.get("tab")),
    )
  const showPaymentProofIndicator =
    isTransferOrder(pedido) &&
    pedido.payment_status === "en_revision" &&
    Boolean(pedido.payment_proof_url) &&
    !paymentProofSeen
  const destination =
    [pedido.localidad, pedido.provincia].filter(Boolean).join(", ") ||
    "No informado"
  const pendingClaim = (pedido.order_claims ?? []).find(
    (claim) => claim.admin_needs_action,
  )
  const tabState = useMemo(
    () =>
      getAdminOrderTabState(pedido, {
        paymentProofPending: showPaymentProofIndicator,
        pendingClaim: Boolean(pendingClaim),
      }),
    [pedido, pendingClaim, showPaymentProofIndicator],
  )
  const detailTabs = useMemo(
    () => [
      { view: "resumen" as const, label: "Resumen", icon: FileText, badge: null },
      { view: "pago" as const, label: "Pago", icon: CreditCard, badge: tabState.badges.pago },
      { view: "facturacion" as const, label: "Facturación", icon: FileText, badge: tabState.badges.facturacion },
      { view: "envio" as const, label: "Envío", icon: Truck, badge: tabState.badges.envio },
      { view: "reclamos" as const, label: "Reclamos", icon: AlertTriangle, badge: tabState.badges.reclamos },
      ...(tabState.visible.cancelacion
        ? [{ view: "cancelacion" as const, label: "Cancelación", icon: X, badge: tabState.badges.cancelacion }]
        : []),
    ],
    [tabState],
  )
  const paymentStatusValue =
    pedido.payment_status === "confirmado" || pedido.payment_status === "approved"
      ? "confirmado"
      : isRejectedPayment(pedido.payment_status)
        ? "rechazado"
        : pedido.payment_status === "en_revision"
          ? "en_revision"
          : "pendiente_comprobante"

  useEffect(() => {
    const requestedView = getAdminOrderDetailView(searchParams.get("tab"))
    const nextView = detailTabs.some((tab) => tab.view === requestedView)
      ? requestedView
      : "resumen"

    setActiveView(nextView)
  }, [detailTabs, pedido.id, searchParams])

  useEffect(() => {
    let active = true
    setPaymentProofSeen(true)

    if (!pedido.payment_proof_url || !pedido.payment_proof_uploaded_at) return

    void isAdminPaymentProofSeen(
      pedido.id,
      pedido.payment_proof_uploaded_at,
    ).then((seen) => {
      if (active) setPaymentProofSeen(seen)
    })

    return () => {
      active = false
    }
  }, [pedido.id, pedido.payment_proof_uploaded_at, pedido.payment_proof_url])

  useEffect(() => {
    if (activeView !== "pago") return
    if (!showPaymentProofIndicator) return

    setPaymentProofSeen(true)
    void markAdminPaymentProofSeen(
      pedido.id,
      pedido.payment_proof_uploaded_at,
    )
  }, [
    activeView,
    pedido.id,
    pedido.payment_proof_uploaded_at,
    showPaymentProofIndicator,
  ])

  useEffect(() => {
    if (activeView !== "reclamos") return
    if (!pendingClaim) return

    void markAdminClaimNotificationsRead(pedido.id)
  }, [activeView, pedido.id, pendingClaim?.id])

  const showDetailView = (view: AdminOrderDetailView) => {
    setActiveView(view)
    const nextParams = new URLSearchParams(searchParams.toString())
    nextParams.set("tab", view)
    router.replace(`${pathname}?${nextParams.toString()}`, { scroll: false })
  }

  const handleModalAndreaniAction = async (action: AndreaniAction) => {
    setAndreaniLoading(action)
    setAndreaniNotice(null)

    const result = await onAndreaniAction(action, pedido.id)
    setAndreaniNotice(result)
    setAndreaniLoading(null)
  }

  const handleIssueInvoice = async () => {
    setInvoiceLoading(true)
    setInvoiceNotice(null)
    const result = await onIssueInvoice(pedido.id)
    setInvoiceNotice(result)
    setInvoiceLoading(false)
  }

  const handleDownloadInvoice = async () => {
    setInvoiceDownloading(true)
    setInvoiceNotice(null)
    const result = await onDownloadInvoice(pedido.id)
    setInvoiceNotice(result.ok ? null : result)
    setInvoiceDownloading(false)
  }

  const handleDownloadCreditNote = async () => {
    setInvoiceDownloading(true)
    setInvoiceNotice(null)
    const result = await onDownloadCreditNote(pedido.id)
    setInvoiceNotice(result.ok ? null : result)
    setInvoiceDownloading(false)
  }

  const handleViewPaymentProof = async () => {
    const opened = await onOpenPaymentProof(pedido.id)
    if (opened) setPaymentProofSeen(true)
  }

  return (
    <div className={embedded ? "min-w-0 px-2 pb-2 pt-4 sm:px-3 sm:pb-3 sm:pt-5" : "fixed inset-0 z-100 flex items-center justify-center bg-black/82 px-4 pb-6 pt-9 backdrop-blur-sm"}>
      <div className={embedded ? "mx-auto flex w-full max-w-[1320px] flex-col overflow-hidden rounded-xl border border-white/10 bg-[#05070A]" : "flex max-h-[88vh] w-full max-w-5xl flex-col overflow-hidden rounded-3xl border border-white/12 bg-[#05070A] shadow-2xl shadow-black/80"}>
        <header className="border-b border-white/8 bg-[#0D1117]">
          <div className="flex min-h-16 items-center justify-between gap-3 px-3 py-2">
            <div className="min-w-0">
              <p className="sr-only">Detalle del pedido</p>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-xl font-black text-white">
                  Pedido #{formatPublicOrderId(pedido.id)}
                </h2>
                {isCancellationFlowOrder(pedido) ? (
                  <EstadoBadge estado={getCurrentOrderStatusForHeader(pedido)} />
                ) : isTransferOrder(pedido) ? (
                  <PaymentStatusBadge status={pedido.payment_status} />
                ) : (
                  <EstadoBadge estado={getDisplayedOrderStatus(pedido)} />
                )}
              </div>
              <p className="mt-1 text-xs text-white/60">
                {formatOrderDate(pedido.created_at)} · {getPaymentMethodLabel(pedido)}
              </p>
            </div>

            <div className="flex shrink-0 items-center">
              <button
                type="button"
                title="Cerrar detalle del pedido"
                aria-label="Cerrar detalle del pedido"
                onClick={onClose}
                className={`cursor-pointer items-center justify-center rounded-xl border border-white/10 text-white/62 transition-colors hover:border-white/22 hover:text-white ${embedded ? "inline-flex h-9 gap-2 px-3 text-xs font-bold" : "flex size-9"}`}
              >
                {embedded ? <><ArrowLeft className="size-4" />Volver</> : <X className="size-5" />}
              </button>
            </div>
          </div>

          <nav
            aria-label="Secciones del pedido"
            className="custom-scrollbar flex gap-1.5 overflow-x-auto border-t border-white/8 px-3 py-2"
          >
            {detailTabs.map(({ view, label, icon: ViewIcon, badge }) => {
              const sensitiveTab = view === "reclamos" || view === "cancelacion"

              return (
                <button
                  key={view}
                  type="button"
                  onClick={() => showDetailView(view)}
                  className={`relative inline-flex h-9 shrink-0 cursor-pointer items-center justify-center rounded-lg border px-3 text-10px font-black uppercase tracking-wide transition-colors ${
                    activeView === view
                      ? sensitiveTab
                        ? `${ADMIN_SENSITIVE_DANGER.action} shadow-[0_0_14px_rgba(159,53,70,0.28)]`
                        : "border-beyonix-blue-light bg-beyonix-blue text-beyonix-sky shadow-[0_0_14px_rgba(17,42,67,0.32)]"
                      : sensitiveTab
                        ? "border-[#7f2d3a]/45 bg-[#15191F] text-[#ffc2c8] hover:border-[#9f3546] hover:bg-[#241217]"
                        : "border-white/8 bg-[#15191F] text-white/68 hover:border-beyonix-blue-light/45 hover:bg-[#1B2028] hover:text-beyonix-sky"
                  }`}
                >
                  <ViewIcon className="mr-1.5 size-3.5" />
                  {label}
                  <AdminOrderTabBadge state={badge} />
                </button>
              )
            })}
          </nav>
        </header>

        <div className={`custom-scrollbar bg-[#05070A] p-2.5 sm:p-3 ${embedded ? "" : "overflow-y-auto"}`}>
          {activeView === "resumen" && (
            <AdminOrderSummaryDashboard
              pedido={pedido}
              financialBreakdown={financialBreakdown}
              onGoToView={showDetailView}
            />
          )}

          {activeView === "pago" && (
            <>
          <div className="grid gap-3 lg:grid-cols-2">
            <section className="admin-order-data-panel admin-order-payment-panel rounded-xl border border-white/8 p-3 lg:col-span-2">
              <p className="text-11px font-bold uppercase tracking-widest text-beyonix-cyan">
                Método de pago
              </p>
              <h3 className="mt-1 text-base font-black text-white">
                {getPaymentMethodLabel(pedido)}
              </h3>

              {isTransferOrder(pedido) ? (
                <div className="mt-2 space-y-2 border-t border-white/8 pt-2">
                  <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                    <div className="admin-order-info-card rounded-lg border border-white/8 p-2">
                      <DetailValue
                        label="Descuento aplicado"
                        value={
                          Number(pedido.transfer_discount_amount ?? 0) > 0
                            ? `-${formatPrice(Number(pedido.transfer_discount_amount))}`
                            : formatPrice(0)
                        }
                      />
                    </div>
                    <div className="admin-order-info-card rounded-lg border border-white/8 p-2">
                      <DetailValue
                        label="Fecha de pago"
                        value={formatOptionalOrderDate(pedido.paid_at)}
                      />
                    </div>
                    <div className="w-fit rounded-lg border border-white/8 bg-[#1B2028] p-2">
                      <p className="mb-1 text-10px font-bold uppercase tracking-widest text-white/55">
                        Estado del pago
                      </p>
                      <PaymentStatusDropdown
                        value={paymentStatusValue}
                        onChange={(value) => onPaymentStatusChange(pedido.id, value)}
                      />
                    </div>
                    <div className="rounded-lg bg-[#16A34A] px-3 py-2">
                      <p className="text-10px font-bold uppercase tracking-widest text-white/80">
                        Total recibido
                      </p>
                      <p className="mt-0.5 text-lg font-black text-white">
                        {formatPrice(pedido.total)}
                      </p>
                    </div>
                  </div>
                  <div className="admin-order-proof-card flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/8 p-2">
                    <DetailValue
                      label="Comprobante actual"
                      value={pedido.payment_proof_file_name || "Sin comprobante"}
                    />
                    {pedido.payment_proof_url && (
                      <button
                        type="button"
                        title="Ver comprobante"
                        aria-label={`Ver comprobante del pedido ${pedido.id}`}
                        onClick={() => void handleViewPaymentProof()}
                        className="inline-flex h-9 cursor-pointer items-center justify-center gap-2 rounded-xl border border-beyonix-blue-light/35 px-3 text-11px font-black uppercase tracking-wide text-beyonix-sky transition-colors hover:bg-beyonix-blue"
                      >
                        <Download className="size-4" />
                        Ver comprobante
                      </button>
                    )}
                  </div>
                </div>
              ) : (
                <div className="mt-2 grid gap-2 border-t border-white/8 pt-2 sm:grid-cols-2 xl:grid-cols-4">
                  <div className="admin-order-info-card rounded-lg border border-white/8 p-2">
                    <DetailValue
                      label="Estado del pago"
                      value={getPaymentStatusLabel(pedido.payment_status)}
                    />
                  </div>
                  <DetailValue label="ID de pago" value={pedido.payment_id || "No informado"} />
                  <DetailValue
                    label="Fecha de acreditación"
                    value={formatOptionalOrderDate(pedido.paid_at)}
                  />
                  <div className="rounded-lg bg-[#16A34A] px-3 py-2">
                    <p className="text-10px font-bold uppercase tracking-widest text-white/80">
                      Total recibido
                    </p>
                    <p className="mt-0.5 text-lg font-black text-white">
                      {formatPrice(pedido.total)}
                    </p>
                  </div>
                </div>
              )}
            </section>
          </div>
            </>
          )}

          {activeView === "facturacion" && (
            <BillingManagementPanel
              pedido={pedido}
              invoiceLoading={invoiceLoading}
              invoiceDownloading={invoiceDownloading}
              invoiceNotice={invoiceNotice}
              onIssueInvoice={handleIssueInvoice}
              onDownloadInvoice={handleDownloadInvoice}
              onDownloadCreditNote={handleDownloadCreditNote}
              onBillingUpdated={onRefundUpdated}
            />
          )}

          {activeView === "cancelacion" && (
            <RefundManagementPanel
              pedido={pedido}
              canEditRefundAmount={canEditRefundAmount}
              onRefundUpdated={onRefundUpdated}
            />
          )}

          {activeView === "reclamos" && (
          <AdminClaimManager
            pedido={pedido}
            onClaimChange={(claim) => onClaimChange(pedido.id, claim)}
          />
          )}

          {(activeView === "resumen" || activeView === "envio") && (
            <>
           {activeView === "resumen" && (
           <section className="admin-order-products-panel mt-3 rounded-xl border border-white/8 p-3">
            <div className="flex flex-wrap items-center gap-3">
              <div>
                <p className="text-11px font-bold uppercase tracking-widest text-beyonix-cyan">
                  Productos
                </p>
                <p className="mt-1 text-sm text-white/55">
                  {items.reduce((sum, item) => sum + Number(item.cantidad ?? 0), 0)} unidades
                </p>
              </div>
            </div>

            <div className="mt-2 space-y-1.5">
              {items.length ? (
                items.map((item) => {
                  const image = getItemImage(item)
                  const productName =
                    item.productos?.nombre ?? `Producto #${item.producto_id}`
                  const quantity = Number(item.cantidad ?? 0)
                  const unitPrice = Number(item.precio ?? 0)

                  return (
                    <article
                      key={item.id}
                      className="admin-order-item-card grid min-h-16 gap-2 rounded-lg border border-white/8 p-2 sm:grid-cols-admin-order-modal-item sm:items-center"
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <div className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-white/8 bg-white">
                          {image ? (
                            <img
                              src={image}
                              alt={productName}
                              className="size-full object-contain"
                            />
                          ) : (
                            <ShoppingCart className="size-5 text-black/35" />
                          )}
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-black text-white">{productName}</p>
                          <p className="mt-0.5 text-[10px] text-white/48">
                            Producto #{item.producto_id}
                          </p>
                        </div>
                      </div>
                      <ItemValue label="Color" value={getItemColor(item)} />
                      <ItemValue label="Cantidad" value={String(quantity)} />
                      <ItemValue label="Precio unitario" value={formatPrice(unitPrice)} />
                      <ItemValue
                        label="Subtotal"
                        value={formatPrice(quantity * unitPrice)}
                      />
                    </article>
                  )
                })
              ) : (
                <p className="admin-order-item-card rounded-xl border border-white/8 p-4 text-sm text-white/55">
                  Este pedido no tiene productos cargados.
                </p>
              )}
            </div>
          </section>
          )}

          {activeView === "envio" && (
          <section className="admin-order-shipping-panel mt-3 rounded-xl border border-beyonix-blue-light/20 p-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-11px font-bold uppercase tracking-widest text-beyonix-cyan">
                  Envío
                </p>
                <h3 className="mt-1 flex items-center gap-2 text-sm font-black text-white">
                  <Truck className="size-4 text-beyonix-sky" />
                  {isLocalRosarioOrder
                    ? "Envío sin costo"
                    : pedido.shipping_type === "sucursal"
                      ? "Retiro en sucursal"
                      : "Envío a domicilio"}
                </h3>
                {isLocalRosarioOrder && (
                  <p className="mt-0.5 text-xs font-medium text-beyonix-sky/88">
                    Entrega local dentro de Rosario.
                  </p>
                )}
              </div>
              <span
                title={dispatch.label}
                className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-11px font-black uppercase tracking-wide ${dispatch.className}`}
              >
                <AlertTriangle className="size-3.5" />
                {dispatch.label}
              </span>
            </div>

            <div className="mt-3 grid gap-2 border-t border-white/8 pt-3 sm:grid-cols-2">
              <CustomerAddressDetails pedido={pedido} />
            </div>

            <div className="mt-2 w-full max-w-xs rounded-xl border border-white/8 bg-[#1B2028] p-3">
              <p className="mb-2 text-10px font-bold uppercase tracking-widest text-white/55">
                Estado operativo
              </p>
              <AdminSelect
                title="Estado operativo del pedido"
                value={pedido.estado}
                triggerClassName={getOrderStatusSelectClassName(pedido.estado)}
                onChange={(value) => onEstadoChange(pedido, value)}
              >
                <option value="pendiente">Pendiente</option>
                <option value="pagado">Pago confirmado</option>
                <option value="enviado">Enviado</option>
                {(isLocalRosarioOrder ||
                  isSuperAdmin ||
                  pedido.estado === "en_camino") && (
                  <option value="en_camino">En camino</option>
                )}
                {(isLocalRosarioOrder ||
                  isSuperAdmin ||
                  pedido.estado === "entregado") && (
                  <option value="entregado">Entregado</option>
                )}
                <option value="cancelado">Cancelado</option>
              </AdminSelect>
            </div>

            <div className="mt-2 grid gap-2 border-t border-white/8 pt-2 sm:grid-cols-2 lg:grid-cols-3">
              <div className="admin-order-info-card rounded-lg border border-white/8 p-2">
                <p className="text-10px font-bold uppercase tracking-widest text-white/45">
                  Proveedor
                </p>
                <div className="mt-1.5 flex items-center gap-2">
                  <span className="flex size-7 items-center justify-center rounded-lg border border-beyonix-blue-light/25 bg-beyonix-blue/25 text-beyonix-sky">
                    <Truck className="size-3.5" />
                  </span>
                  <p className="text-sm font-black text-white">
                    {isLocalRosarioOrder
                      ? "Envío local Rosario"
                      : getShippingProvider(pedido)}
                  </p>
                </div>
              </div>
              <div className="admin-order-info-card rounded-lg border border-white/8 p-2">
                <DetailValue label="Estado" value={getAndreaniStatus(pedido)} />
              </div>
              <div className="admin-order-info-card rounded-lg border border-white/8 p-2">
                <DetailValue label="Seguimiento" value={tracking || "Pendiente"} />
              </div>
              <div className="admin-order-info-card rounded-lg border border-white/8 p-2">
                <DetailValue
                  label="Envío ID"
                  value={pedido.andreani_envio_id || "Pendiente"}
                />
              </div>
              <div className="admin-order-info-card rounded-lg border border-white/8 p-2">
                <DetailValue
                  label="Costo"
                  value={
                    isLocalRosarioOrder
                      ? "Sin costo"
                      : typeof pedido.andreani_costo === "number"
                        ? formatPrice(pedido.andreani_costo)
                      : "Pendiente"
                  }
                />
              </div>
              <div className="admin-order-info-card rounded-lg border border-white/8 p-2">
                <DetailValue label="Destino" value={destination} />
              </div>
            </div>

            {pedido.andreani_error && (
              <p className="mt-3 rounded-xl border border-red-400/20 bg-red-400/8 px-3 py-2 text-xs font-medium text-red-200">
                {pedido.andreani_error}
              </p>
            )}

            {andreaniNotice && (
              <p
                role="status"
                className={`mt-3 rounded-xl border px-3 py-2 text-xs font-medium ${
                  andreaniNotice.ok
                    ? "border-emerald-400/20 bg-emerald-400/8 text-emerald-200"
                    : "border-red-400/20 bg-red-400/8 text-red-200"
                }`}
              >
                {andreaniNotice.message}
              </p>
            )}

            <div className="mt-2 rounded-lg border border-white/8 bg-black/35 p-2">
              <p className="text-10px font-bold uppercase tracking-widest text-white/38">
                Acciones de Andreani
              </p>
              <div className="mt-2 grid gap-1.5 sm:grid-cols-2 xl:grid-cols-5">
                <button
                  type="button"
                  title="Generar envío en Andreani"
                  aria-label={`Generar envío Andreani para pedido ${pedido.id}`}
                  disabled={andreaniLoading !== null}
                  onClick={() => void handleModalAndreaniAction("crear-envio")}
                  className="inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-xl border border-beyonix-blue-light/30 bg-beyonix-blue px-3 text-11px font-black uppercase tracking-wide text-beyonix-sky transition-colors hover:border-beyonix-blue-light hover:bg-beyonix-blue-hover disabled:cursor-wait disabled:opacity-50"
                >
                  <Truck className="size-4" />
                  Generar envío
                </button>
                <button
                  type="button"
                  title="Consultar el estado del envío"
                  aria-label={`Consultar envío Andreani del pedido ${pedido.id}`}
                  disabled={andreaniLoading !== null}
                  onClick={() => void handleModalAndreaniAction("tracking")}
                  className="inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-xl border border-white/10 px-3 text-11px font-black uppercase tracking-wide text-white/72 transition-colors hover:border-beyonix-blue-light/35 hover:text-beyonix-sky disabled:cursor-wait disabled:opacity-50"
                >
                  <RefreshCw className="size-4" />
                  Consultar
                </button>
                {pedido.tracking_url ? (
                  <ExternalLink
                    href={normalizeExternalUrl(pedido.tracking_url) ?? "#"}
                    label="Ver envío"
                    ariaLabel={`Abrir seguimiento del pedido ${pedido.id}`}
                  />
                ) : (
                  <button
                    type="button"
                    disabled
                    title="El seguimiento todavía no está disponible"
                    aria-label="Seguimiento no disponible"
                    className="inline-flex h-10 cursor-not-allowed items-center justify-center gap-2 rounded-xl border border-white/7 px-3 text-11px font-black uppercase tracking-wide text-white/28"
                  >
                    <Eye className="size-4" />
                    Ver envío
                  </button>
                )}
                {pedido.andreani_etiqueta_url ? (
                  <ExternalLink
                    href={pedido.andreani_etiqueta_url}
                    label="Ver etiqueta"
                    ariaLabel={`Abrir etiqueta del pedido ${pedido.id}`}
                  />
                ) : (
                  <button
                    type="button"
                    disabled
                    title="La etiqueta todavía no está disponible"
                    aria-label="Etiqueta no disponible"
                    className="inline-flex h-10 cursor-not-allowed items-center justify-center gap-2 rounded-xl border border-white/7 px-3 text-11px font-black uppercase tracking-wide text-white/28"
                  >
                    <Download className="size-4" />
                    Ver etiqueta
                  </button>
                )}
                <button
                  type="button"
                  disabled={!pedido.andreani_etiqueta_url}
                  title={
                    pedido.andreani_etiqueta_url
                      ? "Imprimir etiqueta de envío"
                      : "La etiqueta todavía no está disponible"
                  }
                  aria-label={`Imprimir etiqueta Andreani del pedido ${pedido.id}`}
                  onClick={() => handlePrintAndreaniLabel(pedido)}
                  className="inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-xl border border-white/10 px-3 text-11px font-black uppercase tracking-wide text-white/72 transition-colors hover:border-beyonix-blue-light/35 hover:text-beyonix-sky disabled:cursor-not-allowed disabled:border-white/7 disabled:text-white/28"
                >
                  <Printer className="size-4" />
                  Imprimir
                </button>
              </div>
            </div>
          </section>
          )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function DetailValue({
  label,
  value,
  wide = false,
}: {
  label: string
  value: string
  wide?: boolean
}) {
  return (
    <div className={wide ? "sm:col-span-2" : undefined}>
      <p className="text-10px font-bold uppercase tracking-widest text-white/38">
        {label}
      </p>
      <p className="mt-1 wrap-break-word text-sm font-bold text-white/82">{value}</p>
    </div>
  )
}

function InvoiceReminderBell({ compact = false }: { compact?: boolean }) {
  return (
    <span
      title="Factura pendiente"
      className={`inline-flex items-center justify-center rounded-full border border-violet-400/45 bg-violet-600 text-white shadow-[0_0_12px_rgba(124,58,237,0.35)] transition-colors hover:bg-violet-700 ${
        compact ? "size-4" : "size-7"
      }`}
    >
      <FileText className={compact ? "size-2.5" : "size-3.5"} />
    </span>
  )
}

function ShippingReminderBadge({ compact = false }: { compact?: boolean }) {
  return (
    <span
      title="Envío pendiente"
      className={`inline-flex items-center justify-center rounded-full border border-[#77E6E2]/25 bg-[#77E6E2]/5 text-[#77E6E2] transition-colors hover:border-[#77E6E2]/40 ${
        compact ? "size-4" : "size-7"
      }`}
    >
      <Truck className={compact ? "size-2.5" : "size-3.5"} />
    </span>
  )
}

function normalizeExternalUrl(value: string) {
  const trimmed = value.trim()
  if (!trimmed) return null

  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
}

function getAddressReference(value?: string | null) {
  const match = value?.match(/referencias?:\s*(.+)$/i)
  return match?.[1]?.trim() || ""
}

function cleanAddressValue(value?: string | null) {
  return (value ?? "")
    .replace(/\.?\s*referencias?:\s*.+$/i, "")
    .trim()
}

function getPostalCodeFromAddress(value?: string | null) {
  return value?.match(/\bCP\s*([A-Z0-9 -]+)/i)?.[1]?.trim().replace(/\.$/, "") || ""
}

function CustomerAddressDetails({ pedido }: { pedido: SupabasePedido }) {
  const cleanAddress = cleanAddressValue(pedido.cliente_direccion)
  const parsedAddress = parseDeliveryAddress(
    cleanAddress,
    pedido.provincia ?? undefined,
    pedido.cp_destino ?? undefined
  )
  const streetLine = [parsedAddress.street, parsedAddress.streetNumber]
    .filter(Boolean)
    .join(" ")
  const unitLine = [
    parsedAddress.floor ? `Piso ${parsedAddress.floor}` : "",
    parsedAddress.apartment ? `Depto ${parsedAddress.apartment}` : "",
  ]
    .filter(Boolean)
    .join(" · ")
  const locality = pedido.localidad || parsedAddress.locality
  const postalCode = pedido.cp_destino || getPostalCodeFromAddress(cleanAddress)
  const reference = getAddressReference(pedido.cliente_direccion)

  return (
    <div className="sm:col-span-2 rounded-lg border border-white/8 bg-[#111111] p-2">
      <p className="text-10px font-bold uppercase tracking-widest text-white/38">
        Dirección
      </p>
      <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
        <DetailValue
          label="Calle y número"
          value={streetLine || cleanAddress || "No informada"}
        />
        <DetailValue
          label="Piso / departamento"
          value={unitLine || "Sin datos"}
        />
        <DetailValue label="Localidad" value={locality || "No informada"} />
        <DetailValue
          label="Provincia"
          value={pedido.provincia || "No informada"}
        />
        <DetailValue label="Código postal" value={postalCode || "No informado"} />
        <DetailValue
          label="Referencias"
          value={reference || "Sin referencias"}
        />
      </div>
    </div>
  )
}

function ItemValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="text-center">
      <p className="text-10px font-bold uppercase tracking-widest text-white/38">
        {label}
      </p>
      <p className="mt-1 text-sm font-black text-white">{value}</p>
    </div>
  )
}

function ExternalLink({
  href,
  label,
  ariaLabel,
}: {
  href: string
  label: string
  ariaLabel: string
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      title={label}
      aria-label={ariaLabel}
      className="inline-flex h-9 cursor-pointer items-center justify-center rounded-xl border border-beyonix-blue-light/35 px-3 text-11px font-black uppercase tracking-wide text-beyonix-sky transition-colors hover:bg-beyonix-blue"
    >
      {label}
    </a>
  )
}

function TrackingStatusModal({
  request,
  loading,
  onCancel,
  onConfirm,
}: {
  request: TrackingStatusRequest
  loading: boolean
  onCancel: () => void
  onConfirm: (tracking: {
    tracking_number: string | null
    tracking_url: string | null
  }) => void
}) {
  const [trackingNumber, setTrackingNumber] = useState("")
  const [trackingUrl, setTrackingUrl] = useState("")

  useEffect(() => {
    setTrackingNumber(
      request?.pedido.andreani_tracking ||
        request?.pedido.tracking_number ||
        ""
    )
    setTrackingUrl(request?.pedido.tracking_url || "")
  }, [request?.pedido.id])

  if (!request) return null

  return (
    <div className="fixed inset-0 z-[150] flex items-center justify-center bg-black/82 px-4 py-6 backdrop-blur-sm">
      <div className="w-full max-w-lg overflow-hidden rounded-3xl border border-beyonix-blue-light/25 bg-[#101010] shadow-2xl shadow-black/80">
        <div className="border-b border-white/8 bg-[linear-gradient(135deg,#102438_0%,#141414_58%,#0b0b0b_100%)] px-5 py-4">
          <p className="text-11px font-black uppercase tracking-widest text-beyonix-cyan">
            Datos de despacho
          </p>
          <h2 className="mt-2 text-xl font-black text-white">
            Marcar pedido #{formatPublicOrderId(request.pedido.id)} como
            despachado
          </h2>
          <p className="mt-2 text-sm font-semibold leading-6 text-white/62">
            El número de seguimiento se muestra en el pedido del cliente. El
            link es opcional y solo hace falta si tenés una URL pública para
            consultar el envío.
          </p>
        </div>

        <div className="space-y-4 px-5 py-4">
          <label className="block">
            <span className="text-10px font-bold uppercase tracking-widest text-white/38">
              Número de seguimiento
            </span>
            <input
              value={trackingNumber}
              onChange={(event) => setTrackingNumber(event.target.value)}
              placeholder="Ej: 360001234567890"
              className="mt-2 h-11 w-full rounded-xl border border-beyonix-blue-light/25 bg-[#111111] px-3 text-sm font-semibold text-white outline-none placeholder:text-white/34 focus:border-beyonix-blue-light"
            />
          </label>

          <label className="block">
            <span className="text-10px font-bold uppercase tracking-widest text-white/38">
              Link de seguimiento opcional
            </span>
            <input
              value={trackingUrl}
              onChange={(event) => setTrackingUrl(event.target.value)}
              placeholder="https://..."
              className="mt-2 h-11 w-full rounded-xl border border-beyonix-blue-light/25 bg-[#111111] px-3 text-sm font-semibold text-white outline-none placeholder:text-white/34 focus:border-beyonix-blue-light"
            />
          </label>

          <div className="rounded-2xl border border-white/8 bg-black/25 px-3 py-2 text-xs font-semibold leading-5 text-white/55">
            Podés dejar ambos campos vacíos si todavía no tenés datos de
            seguimiento. El estado se actualizará igual.
          </div>
        </div>

        <div className="flex flex-col-reverse gap-2 border-t border-white/8 px-5 py-4 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={onCancel}
            disabled={loading}
            className="inline-flex h-10 cursor-pointer items-center justify-center rounded-xl border border-white/10 px-4 text-11px font-black uppercase tracking-wide text-white/68 transition-colors hover:border-beyonix-blue-light/35 hover:text-white disabled:cursor-wait disabled:opacity-50"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={() =>
              onConfirm({
                tracking_number: trackingNumber.trim() || null,
                tracking_url: normalizeExternalUrl(trackingUrl),
              })
            }
            disabled={loading}
            className="inline-flex h-10 cursor-pointer items-center justify-center rounded-xl border border-beyonix-blue-light/45 bg-beyonix-blue px-4 text-11px font-black uppercase tracking-wide text-beyonix-sky transition-colors hover:border-beyonix-blue-light hover:bg-beyonix-blue-hover disabled:cursor-wait disabled:opacity-50"
          >
            {loading ? "Guardando..." : "Guardar despacho"}
          </button>
        </div>
      </div>
    </div>
  )
}

function ForcedStatusConfirmModal({
  request,
  loading,
  onCancel,
  onConfirm,
}: {
  request: ForcedStatusRequest
  loading: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  if (!request) return null

  const statusLabel =
    request.nextEstado === "entregado" ? "Entregado" : "En camino"

  return (
    <div className="fixed inset-0 z-[150] flex items-center justify-center bg-black/82 px-4 py-6 backdrop-blur-sm">
      <div className="w-full max-w-md overflow-hidden rounded-3xl border border-beyonix-blue-light/25 bg-[#101010] shadow-2xl shadow-black/80">
        <div className="border-b border-white/8 bg-[linear-gradient(135deg,#102438_0%,#141414_58%,#0b0b0b_100%)] px-5 py-4">
          <p className="text-11px font-black uppercase tracking-widest text-beyonix-cyan">
            Acción de super admin
          </p>
          <h2 className="mt-2 text-xl font-black text-white">
            ¿Estás seguro de marcar como {statusLabel}?
          </h2>
          <p className="mt-2 text-sm font-semibold leading-6 text-white/62">
            Este pedido usa Andreani. Al confirmar, vas a forzar manualmente el
            estado del pedido #{formatPublicOrderId(request.pedido.id)}.
          </p>
        </div>

        <div className="space-y-3 px-5 py-4">
          <div className="rounded-2xl border border-white/8 bg-[#181818] p-3">
            <p className="text-10px font-bold uppercase tracking-widest text-white/38">
              Cliente
            </p>
            <p className="mt-1 text-sm font-black text-white">
              {request.pedido.cliente_nombre || "Cliente sin nombre"}
            </p>
          </div>
          <div className="rounded-2xl border border-amber-300/20 bg-amber-400/8 p-3 text-sm font-semibold leading-6 text-amber-100">
            Usalo solo cuando tengas confirmación real de envío o entrega fuera
            de la sincronización automática.
          </div>
        </div>

        <div className="flex flex-col-reverse gap-2 border-t border-white/8 px-5 py-4 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={onCancel}
            disabled={loading}
            className="inline-flex h-10 cursor-pointer items-center justify-center rounded-xl border border-white/10 px-4 text-11px font-black uppercase tracking-wide text-white/68 transition-colors hover:border-beyonix-blue-light/35 hover:text-white disabled:cursor-wait disabled:opacity-50"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={loading}
            className="inline-flex h-10 cursor-pointer items-center justify-center rounded-xl border border-beyonix-blue-light/45 bg-beyonix-blue px-4 text-11px font-black uppercase tracking-wide text-beyonix-sky transition-colors hover:border-beyonix-blue-light hover:bg-beyonix-blue-hover disabled:cursor-wait disabled:opacity-50"
          >
            {loading ? "Confirmando..." : `Marcar ${statusLabel}`}
          </button>
        </div>
      </div>
    </div>
  )
}

function AdminClaimsCenterSection({
  pedido,
  onClaimChange,
}: {
  pedido: SupabasePedido
  onClaimChange: (claim: SupabaseOrderClaim) => void
}) {
  const claims = pedido.order_claims ?? []
  const [editingClaimId, setEditingClaimId] = useState<number | null>(
    claims[0]?.id ?? null
  )
  const claim = claims.find((item) => item.id === editingClaimId) ?? claims[0]
  const [status, setStatus] = useState<OrderClaimStatus>(
    claim?.status ?? "recibido"
  )
  const [resolution, setResolution] = useState<OrderClaimResolution | "">(
    claim?.resolution ?? ""
  )
  const [closeAfterResolution, setCloseAfterResolution] = useState(
    claim?.status === "cerrado"
  )
  const [adminResponse, setAdminResponse] = useState(
    claim?.admin_response ?? ""
  )
  const [rejectionReason, setRejectionReason] = useState(
    claim?.rejection_reason ?? ""
  )
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState("")

  useEffect(() => {
    setEditingClaimId(claims[0]?.id ?? null)
  }, [pedido.id, claims.length])

  useEffect(() => {
    if (!claim) return
    setStatus(claim.status)
    setResolution(claim.resolution ?? "")
    setCloseAfterResolution(claim.status === "cerrado")
    setAdminResponse(claim.admin_response ?? "")
    setRejectionReason(claim.rejection_reason ?? "")
    setMessage("")
  }, [claim?.id])

  const saveClaim = async () => {
    if (!claim) return

    setSaving(true)
    setMessage("")

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession()

      if (!session?.access_token) {
        setMessage("La sesión administrativa venció.")
        return
      }

      const response = await fetch(`/api/admin/order-claims/${claim.id}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          status: closeAfterResolution ? "cerrado" : status,
          resolution: resolution || null,
          offered_resolutions: [],
          admin_response: adminResponse,
          rejection_reason: rejectionReason,
        }),
      })
      const data = (await response.json()) as {
        claim?: SupabaseOrderClaim
        error?: string
      }

      if (!response.ok || !data.claim) {
        setMessage(data.error || "No se pudo actualizar el reclamo.")
        return
      }

      onClaimChange(data.claim)
      setStatus(data.claim.status)
      setResolution(data.claim.resolution ?? "")
      setCloseAfterResolution(data.claim.status === "cerrado")
      setAdminResponse(data.claim.admin_response ?? "")
      setRejectionReason(data.claim.rejection_reason ?? "")
      setMessage("Reclamo actualizado.")
    } catch {
      setMessage("No se pudo actualizar el reclamo.")
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className={`admin-order-invoice-panel mt-4 rounded-2xl border p-4 sm:p-5 ${ADMIN_SENSITIVE_DANGER.panel}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className={`text-11px font-bold uppercase tracking-widest ${ADMIN_SENSITIVE_DANGER.label}`}>
            Centro de reclamos
          </p>
          <h3 className="mt-2 text-lg font-black text-white">
            {claims.length
              ? `${claims.length} reclamo${claims.length === 1 ? "" : "s"}`
              : "Sin reclamos"}
          </h3>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-white/55">
            Revisá la evidencia cargada por el cliente, cambiá el estado y
            dejá una respuesta visible en su pedido.
          </p>
        </div>
        {claims.length > 1 && (
          <AdminSelect
            title="Historial de reclamos"
            compact
            value={String(claim?.id ?? "")}
            onChange={(value) => setEditingClaimId(Number(value))}
          >
            {claims.map((item) => (
              <option key={item.id} value={item.id}>
                #{item.id} · {getOrderClaimTypeLabel(item.claim_type)}
              </option>
            ))}
          </AdminSelect>
        )}
      </div>

      {!claim ? (
        <p className={`mt-4 rounded-xl border px-3 py-2 text-xs font-medium ${ADMIN_SENSITIVE_DANGER.panelSoft} ${ADMIN_SENSITIVE_DANGER.textMuted}`}>
          Este pedido todavía no tiene reclamos cargados.
        </p>
      ) : (
        <div className="mt-4 grid gap-4 border-t border-[#7f2d3a]/45 pt-4 lg:grid-cols-2">
          <div className="space-y-3">
            <div className={`admin-order-info-card rounded-xl border p-3 ${ADMIN_SENSITIVE_DANGER.panelSoft}`}>
              <DetailValue
                label="Tipo de reclamo"
                value={getOrderClaimTypeLabel(claim.claim_type)}
              />
            </div>
            <div className={`admin-order-info-card rounded-xl border p-3 ${ADMIN_SENSITIVE_DANGER.panelSoft}`}>
              <DetailValue
                label="Descripción"
                value={claim.description || "Sin descripción"}
                wide
              />
            </div>
            {claim.failure_type && (
              <div className={`admin-order-info-card rounded-xl border p-3 ${ADMIN_SENSITIVE_DANGER.panelSoft}`}>
                <DetailValue label="Tipo de falla" value={claim.failure_type} />
              </div>
            )}
            {claim.started_at && (
              <div className={`admin-order-info-card rounded-xl border p-3 ${ADMIN_SENSITIVE_DANGER.panelSoft}`}>
                <DetailValue label="Inicio de falla" value={claim.started_at} />
              </div>
            )}
            <div className={`rounded-xl border p-3 ${ADMIN_SENSITIVE_DANGER.panelSoft}`}>
              <p className={`text-10px font-bold uppercase tracking-widest ${ADMIN_SENSITIVE_DANGER.label}`}>
                Evidencia
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {(claim.order_claim_files ?? []).length ? (
                  (claim.order_claim_files ?? []).map((file) => (
                    <a
                      key={file.id}
                      href={file.signedUrl ?? undefined}
                      target="_blank"
                      rel="noreferrer"
                      className={`inline-flex h-9 items-center gap-2 rounded-xl border px-3 text-10px font-black uppercase tracking-wide ${ADMIN_SENSITIVE_DANGER.action}`}
                    >
                      <Download className="size-3.5" />
                      {file.file_name}
                    </a>
                  ))
                ) : (
                  <p className="text-sm font-semibold text-white/55">
                    Sin archivos cargados.
                  </p>
                )}
              </div>
            </div>
          </div>

          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <p className="mb-2 text-10px font-bold uppercase tracking-widest text-white/38">
                  Estado
                </p>
                <AdminSelect
                  title="Estado del reclamo"
                  value={status}
                  onChange={(value) => setStatus(value as OrderClaimStatus)}
                >
                  <option value="recibido">Recibido</option>
                  <option value="en_revision">En revisión</option>
                  <option value="falta_informacion">
                    En conversación
                  </option>
                  <option value="aprobado">Aprobado</option>
                  <option value="cambio_pendiente">Solución en proceso</option>
                  <option value="reemplazo_enviado">Solución en proceso</option>
                  <option value="reintegro_pendiente">Reintegro pendiente</option>
                  <option value="cupon_pendiente">Cupón pendiente</option>
                  <option value="rechazado">Rechazado</option>
                  <option value="cerrado">Cerrado</option>
                </AdminSelect>
              </div>
              <div>
                <p className="mb-2 text-10px font-bold uppercase tracking-widest text-white/38">
                  Resolución final
                </p>
                <AdminSelect
                  title="Resolución del reclamo"
                  value={resolution}
                  onChange={(value) =>
                    setResolution(value as OrderClaimResolution | "")
                  }
                >
                  <option value="">Sin resolución</option>
                  <option value="reintegro_total">Reintegro total</option>
                  <option value="reintegro_parcial">Reintegro parcial</option>
                  <option value="cupon_descuento">Cupón de descuento</option>
                  <option value="rechazado">Rechazado</option>
                  <option value="otro">Otra solución</option>
                </AdminSelect>
              </div>
            </div>
            <div className={`rounded-xl border p-3 ${ADMIN_SENSITIVE_DANGER.panelSoft}`}>
              <p className={`text-10px font-bold uppercase tracking-widest ${ADMIN_SENSITIVE_DANGER.label}`}>
                Resolución definida por BEYONIX
              </p>
              <p className="mt-2 text-xs font-semibold leading-5 text-white/58">
                El cliente no elige soluciones desde la web. Registrá la resolución y, si hace falta, respondé desde la conversación.
              </p>
            </div>
            {claim.customer_selected_resolution && (
              <div className="rounded-xl border border-emerald-300/20 bg-emerald-400/8 px-3 py-2 text-xs font-semibold leading-5 text-emerald-100">
                Resolución registrada previamente:{" "}
                <span className="font-black">
                  {getOrderClaimResolutionLabel(
                    claim.customer_selected_resolution,
                  )}
                </span>
                .
              </div>
            )}
            {(claim.order_claim_messages ?? []).length > 0 && (
              <div className={`rounded-xl border p-3 ${ADMIN_SENSITIVE_DANGER.panelSoft}`}>
                <p className={`text-10px font-bold uppercase tracking-widest ${ADMIN_SENSITIVE_DANGER.label}`}>
                  Conversación con el cliente
                </p>
                <div className="mt-3 space-y-2">
                  {[...(claim.order_claim_messages ?? [])]
                    .sort(
                      (a, b) =>
                        new Date(a.created_at).getTime() -
                        new Date(b.created_at).getTime(),
                    )
                    .map((message) => {
                      const isCustomer = message.author_role === "cliente"

                      return (
                        <div
                          key={message.id}
                          className={`rounded-xl border px-3 py-2 ${
                            isCustomer
                              ? "border-[#7f2d3a]/55 bg-[#241217]"
                              : "border-[#7f2d3a]/35 bg-[#2a1117]"
                          }`}
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <p className="text-10px font-black uppercase tracking-widest text-white/45">
                              {isCustomer ? "Cliente" : "BEYONIX"}
                            </p>
                            <p className="text-10px font-semibold text-white/34">
                              {formatOrderDate(message.created_at)}
                            </p>
                          </div>
                          <p className="mt-1 text-sm font-semibold leading-6 text-white/72">
                            {message.message}
                          </p>
                        </div>
                      )
                    })}
                </div>
              </div>
            )}
            <textarea
              value={adminResponse}
              onChange={(event) => setAdminResponse(event.target.value)}
              rows={4}
              placeholder="Respuesta visible para el cliente. El reclamo seguirá abierto hasta que lo marques como Cerrado."
              className="w-full resize-none rounded-xl border border-[#7f2d3a]/55 bg-[#241217] px-3 py-3 text-sm font-semibold text-white outline-none placeholder:text-white/34 focus:border-[#bf4a5b]"
            />
            <textarea
              value={rejectionReason}
              onChange={(event) => setRejectionReason(event.target.value)}
              rows={3}
              placeholder="Motivo de rechazo obligatorio si el estado es Rechazado."
              className="w-full resize-none rounded-xl border border-[#7f2d3a]/55 bg-[#241217] px-3 py-3 text-sm font-semibold text-white outline-none placeholder:text-white/34 focus:border-[#bf4a5b]"
            />
            <label className={`flex items-start gap-2 rounded-xl border px-3 py-2 text-xs font-semibold leading-5 ${ADMIN_SENSITIVE_DANGER.panelSoft} ${ADMIN_SENSITIVE_DANGER.textMuted}`}>
              <input
                type="checkbox"
                checked={closeAfterResolution}
                onChange={(event) =>
                  setCloseAfterResolution(event.target.checked)
                }
                className="mt-0.5 size-4 accent-[#9f3546]"
              />
              Dar por finalizada la conversación con el cliente al guardar. Se
              requiere una resolución final.
            </label>
            <p className="text-xs font-semibold leading-5 text-white/46">
              Para seguir hablando, dejá el estado como En revisión o En
              conversación. Solo Cerrado o Rechazado finalizan el reclamo.
            </p>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs font-semibold text-white/48">
                {message ||
                  `Actual: ${getOrderClaimStatusLabel(claim.status)} · ${getOrderClaimResolutionLabel(claim.resolution)}`}
              </p>
              <button
                type="button"
                onClick={() => void saveClaim()}
                disabled={saving}
                className={`inline-flex h-10 cursor-pointer items-center justify-center rounded-xl border px-4 text-11px font-black uppercase tracking-wide disabled:cursor-wait disabled:opacity-50 ${ADMIN_SENSITIVE_DANGER.actionSolid}`}
              >
                {saving ? "Guardando..." : "Guardar reclamo"}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}

export function AdminPedidos({
  initialOrderId,
}: {
  initialOrderId?: number
}) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { isAdmin, isSuperAdmin } = useAuth()
  const { pedidos, loading, error, deletePedido, updatePedidoEstado, reloadPedidos } =
    usePedidos()
  const [search, setSearch] = useState("")
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("todos")
  const [attentionFilter, setAttentionFilter] =
    useState<AdminNotificationTone | "all">(() => {
      const value = searchParams.get("attention")
      return value === "order" ||
        value === "message" ||
        value === "payment" ||
        value === "invoice" ||
        value === "shipping" ||
        value === "cancellation"
        ? value
        : value === "claim" || value === "issue"
          ? "claim"
        : "all"
    })
  const [previewPedido, setPreviewPedido] = useState<SupabasePedido | null>(null)
  const [newOrderIds, setNewOrderIds] = useState<Set<number>>(() => new Set())
  const knownOrderIdsRef = useRef<Set<number> | null>(null)
  const newOrderTimersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(
    new Map(),
  )
  const [attentionOrderIds, setAttentionOrderIds] = useState<Set<number>>(
    () => new Set()
  )
  const [attentionLastSeenAt, setAttentionLastSeenAt] = useState<string | null>(null)
  const [attentionOrdersLoaded, setAttentionOrdersLoaded] = useState(false)
  const [notice, setNotice] = useState<AdminNotice>(null)
  const [forcedStatusRequest, setForcedStatusRequest] =
    useState<ForcedStatusRequest>(null)
  const [forcedStatusLoading, setForcedStatusLoading] = useState(false)
  const [trackingStatusRequest, setTrackingStatusRequest] =
    useState<TrackingStatusRequest>(null)
  const [trackingStatusLoading, setTrackingStatusLoading] = useState(false)

  useEffect(() => {
    if (loading) return

    const currentIds = new Set(pedidos.map((pedido) => pedido.id))
    const knownIds = knownOrderIdsRef.current
    knownOrderIdsRef.current = currentIds

    if (!knownIds) return

    const addedIds = [...currentIds].filter((id) => !knownIds.has(id))
    if (addedIds.length === 0) return

    setNewOrderIds((current) => new Set([...current, ...addedIds]))
    for (const id of addedIds) {
      const previousTimer = newOrderTimersRef.current.get(id)
      if (previousTimer) clearTimeout(previousTimer)

      const timer = setTimeout(() => {
        setNewOrderIds((current) => {
          const next = new Set(current)
          next.delete(id)
          return next
        })
        newOrderTimersRef.current.delete(id)
      }, 8000)
      newOrderTimersRef.current.set(id, timer)
    }
  }, [loading, pedidos])

  useEffect(() => {
    const timers = newOrderTimersRef.current
    return () => {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
    }
  }, [])

  useEffect(() => {
    const value = searchParams.get("attention")
    setAttentionFilter(
      value === "order" ||
        value === "message" ||
        value === "payment" ||
        value === "invoice" ||
        value === "shipping" ||
        value === "cancellation"
        ? value
        : value === "claim" || value === "issue"
          ? "claim"
        : "all",
    )
  }, [searchParams])

  useEffect(() => {
    if (!notice) return

    const timeout = window.setTimeout(() => setNotice(null), 4000)
    return () => window.clearTimeout(timeout)
  }, [notice])

  useEffect(() => {
    setPreviewPedido((currentPedido) => {
      if (!currentPedido) return currentPedido

      return (
        pedidos.find((pedido) => pedido.id === currentPedido.id) ?? currentPedido
      )
    })
  }, [pedidos])

  useEffect(() => {
    if (!previewPedido) return

    const orderId = previewPedido.id
    let reloadTimer: ReturnType<typeof setTimeout> | null = null
    const scheduleDetailReload = () => {
      if (reloadTimer) clearTimeout(reloadTimer)
      reloadTimer = setTimeout(() => {
        reloadTimer = null
        void reloadPedidos({ silent: true })
        notifyOrderNotificationsChanged()
      }, 140)
    }

    const handleOrderChange = (payload: { new?: Partial<SupabasePedido> }) => {
      if (!payload.new) return

      setPreviewPedido((currentPedido) =>
        currentPedido?.id === orderId
          ? {
              ...currentPedido,
              ...payload.new,
              orden_items: currentPedido.orden_items,
              order_claims: currentPedido.order_claims,
              order_refund_proofs: currentPedido.order_refund_proofs,
              order_audit_events: currentPedido.order_audit_events,
            }
          : currentPedido,
      )
      scheduleDetailReload()
    }

    const handleRelatedChange = () => {
      scheduleDetailReload()
    }

    const channel = supabase
      .channel(`admin-pedido-detail-${orderId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "ordenes",
          filter: `id=eq.${orderId}`,
        },
        handleOrderChange,
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "orden_items",
          filter: `orden_id=eq.${orderId}`,
        },
        handleRelatedChange,
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "order_claims",
          filter: `order_id=eq.${orderId}`,
        },
        handleRelatedChange,
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "order_refund_proofs",
          filter: `order_id=eq.${orderId}`,
        },
        handleRelatedChange,
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "order_audit_events",
          filter: `order_id=eq.${orderId}`,
        },
        handleRelatedChange,
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "customer_notifications",
          filter: `order_id=eq.${orderId}`,
        },
        handleRelatedChange,
      )

    channel.subscribe()

    return () => {
      if (reloadTimer) clearTimeout(reloadTimer)
      void supabase.removeChannel(channel)
    }
  }, [previewPedido?.id, reloadPedidos])

  useEffect(() => {
    if (!initialOrderId || loading) return
    const pedido = pedidos.find((item) => item.id === initialOrderId) ?? null
    setPreviewPedido(pedido)
  }, [initialOrderId, loading, pedidos])

  useEffect(() => {
    if (loading) return
    if (attentionOrdersLoaded) return

    let active = true

    async function loadAttentionOrders() {
      try {
        const lastSeenAt = await getAdminOrderLastSeenAt()

        if (!active) return

        if (!lastSeenAt) {
          setAttentionLastSeenAt(null)
          setAttentionOrdersLoaded(true)
          return
        }

        setAttentionLastSeenAt(lastSeenAt)

        setAttentionOrderIds(
          new Set(
            pedidos
              .filter(
                (pedido) =>
                  isVisibleAdminOrder(pedido) &&
                  (orderHasPendingClaimAction(pedido) ||
                    hasOrderAttentionAfter(pedido, lastSeenAt))
              )
              .map((pedido) => pedido.id)
          )
        )
        setAttentionOrdersLoaded(true)
      } catch (error) {
        console.error(
          "ADMIN_ORDER_VIEW_MARK_ERROR",
          getSupabaseErrorDetails(error)
        )
      }
    }

    void loadAttentionOrders()

    return () => {
      active = false
    }
  }, [loading, pedidos, attentionOrdersLoaded])

  const handleOpenPedido = (pedido: SupabasePedido) => {
    router.push(`/admin/pedidos/${pedido.id}`)

    if (orderHasPendingClaimAction(pedido)) return
    if (!attentionOrderIds.has(pedido.id)) return

    const remainingUnread = new Set(attentionOrderIds)
    remainingUnread.delete(pedido.id)
    setAttentionOrderIds(remainingUnread)

    if (remainingUnread.size === 0) {
      void markOrdersSeenAndGetPreviousLastSeen()
    }
  }

  const pedidosFiltrados = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase()

    return pedidos.filter((pedido) => {
      if (!isVisibleAdminOrder(pedido)) return false

      const matchesSearch = [
        String(pedido.id),
        pedido.cliente_username ?? "",
        pedido.cliente_nombre ?? "",
        pedido.cliente_email ?? "",
        pedido.cliente_telefono ?? "",
        pedido.cliente_direccion ?? "",
        pedido.payment_status ?? "",
        pedido.payment_method_id ?? "",
        pedido.orden_items?.map((item) => item.productos?.nombre ?? "").join(" ") ?? "",
      ]
        .join(" ")
        .toLowerCase()
        .includes(normalizedSearch)
      const matchesStatus =
        statusFilter === "todos" ||
        getDisplayedOrderStatus(pedido) === statusFilter
      const matchesAttention =
        attentionFilter === "all" ||
        orderMatchesNotificationTone(
          pedido,
          attentionFilter,
          attentionLastSeenAt,
        )

      return matchesSearch && matchesStatus && matchesAttention
    })
  }, [attentionFilter, attentionLastSeenAt, attentionOrderIds, pedidos, search, statusFilter])

  const handleDelete = async (id: number) => {
    const ok = confirm("¿Eliminar pedido?")
    if (!ok) return
    const deleted = await deletePedido(id)
    if (deleted) notifyOrderNotificationsChanged()
  }

  const handleEstadoChange = async (
    pedido: SupabasePedido,
    nextEstado: string
  ) => {
    const pedidoId = pedido.id
    const estadoActual = pedido.estado
    const isLocalRosarioOrder = isLocalRosarioDeliveryOrder(pedido)

    if (estadoActual === nextEstado) return

    if (
      (nextEstado === "en_camino" || nextEstado === "entregado") &&
      !isLocalRosarioOrder
    ) {
      if (isSuperAdmin) {
        setForcedStatusRequest({
          pedido,
          nextEstado,
        })
        return
      }

      setNotice({
        type: "error",
        message:
          "Los estados En camino y Entregado se actualizan desde Andreani. Solo el envío local de Rosario puede cambiarlos manualmente.",
      })
      return
    }

    if (nextEstado === "pagado" && estadoActual !== "pagado") {
      if (!isTransferOrder(pedido)) {
        setNotice({
          type: "error",
          message:
            "Los pagos de Mercado Pago se aprueban automáticamente mediante el webhook.",
        })
        return
      }

      await handlePaymentStatusChange(pedidoId, "confirmado")
      return
    }

    if (
      (nextEstado === "en_camino" || nextEstado === "entregado") &&
      isLocalRosarioOrder
    ) {
      const updated = await updatePedidoEstado(pedidoId, nextEstado)
      if (updated) {
        setNotice({ type: "ok", message: "Estado del envío local actualizado." })
        notifyOrderNotificationsChanged()
      } else {
        setNotice({ type: "error", message: "No se pudo actualizar el estado." })
      }
      return
    }

    if (nextEstado === "enviado" || nextEstado === "en_camino") {
      setTrackingStatusRequest({
        pedido,
        nextEstado,
      })
      return
    }

    const updated = await updatePedidoEstado(pedidoId, nextEstado)
    if (updated) {
      setNotice({ type: "ok", message: "Estado del pedido actualizado." })
      notifyOrderNotificationsChanged()
    } else {
      setNotice({ type: "error", message: "No se pudo actualizar el estado." })
    }
  }

  const confirmTrackingStatusChange = async (tracking: {
    tracking_number: string | null
    tracking_url: string | null
  }) => {
    if (!trackingStatusRequest) return

    setTrackingStatusLoading(true)
    const updated = await updatePedidoEstado(
      trackingStatusRequest.pedido.id,
      trackingStatusRequest.nextEstado,
      tracking
    )
    setTrackingStatusLoading(false)

    if (updated) {
      setNotice({ type: "ok", message: "Estado del pedido actualizado." })
      setTrackingStatusRequest(null)
      notifyOrderNotificationsChanged()
      return
    }

    setNotice({ type: "error", message: "No se pudo actualizar el estado." })
  }

  const confirmForcedStatusChange = async () => {
    if (!forcedStatusRequest) return

    setForcedStatusLoading(true)
    const updated = await updatePedidoEstado(
      forcedStatusRequest.pedido.id,
      forcedStatusRequest.nextEstado
    )
    setForcedStatusLoading(false)

    if (updated) {
      setNotice({
        type: "ok",
        message:
          forcedStatusRequest.nextEstado === "entregado"
            ? "Pedido marcado como Entregado por super admin."
            : "Pedido marcado como En camino por super admin.",
      })
      setForcedStatusRequest(null)
      notifyOrderNotificationsChanged()
      return
    }

    setNotice({ type: "error", message: "No se pudo forzar el estado." })
    setForcedStatusRequest(null)
  }

  const handlePaymentStatusChange = async (
    pedidoId: number,
    nextStatus: string
  ) => {
    const {
      data: { session },
    } = await supabase.auth.getSession()

    if (!session?.access_token) {
      setNotice({ type: "error", message: "La sesión administrativa venció." })
      return false
    }

    const response = await fetch(`/api/admin/pedidos/${pedidoId}/payment-status`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ payment_status: nextStatus }),
    })
    const data = await response.json()

    if (!response.ok) {
      setNotice({
        type: "error",
        message: data.error || "No se pudo actualizar el estado de pago.",
      })
      return false
    }

    if (data.order) {
      setPreviewPedido((currentPedido) =>
        currentPedido?.id === pedidoId
          ? {
              ...currentPedido,
              ...data.order,
              orden_items: currentPedido.orden_items,
              order_claims: currentPedido.order_claims,
            }
          : currentPedido
      )
    }

    await reloadPedidos()
    setNotice({ type: "ok", message: "Estado de pago actualizado." })
    notifyOrderNotificationsChanged()
  }

  const handleClaimChange = (pedidoId: number, claim: SupabaseOrderClaim) => {
    setPreviewPedido((currentPedido) =>
      currentPedido?.id === pedidoId
        ? {
            ...currentPedido,
            order_claims: [
              claim,
              ...(currentPedido.order_claims ?? []).filter((item) => item.id !== claim.id),
            ],
          }
        : currentPedido
    )
    void reloadPedidos()
  }

  const handleRefundUpdated = (updatedOrder: SupabasePedido) => {
    setPreviewPedido((currentPedido) =>
      currentPedido?.id === updatedOrder.id
        ? {
            ...currentPedido,
            ...updatedOrder,
            orden_items: currentPedido.orden_items,
            order_claims: currentPedido.order_claims,
          }
        : currentPedido,
    )
    void reloadPedidos({ silent: true })
  }


  const handleOpenPaymentProof = async (pedidoId: number) => {
    const {
      data: { session },
    } = await supabase.auth.getSession()

    if (!session?.access_token) {
      setNotice({ type: "error", message: "La sesión administrativa venció." })
      return false
    }

    const response = await fetch(`/api/admin/payment-proofs/${pedidoId}`, {
      headers: {
        Authorization: `Bearer ${session.access_token}`,
      },
    })
    const data = await response.json()

    if (!response.ok || !data.signedUrl) {
      setNotice({
        type: "error",
        message: data.error || "No se pudo abrir el comprobante.",
      })
      return false
    }

    window.open(data.signedUrl, "_blank", "noopener,noreferrer")
    const pedido =
      previewPedido?.id === pedidoId
        ? previewPedido
        : pedidos.find((item) => item.id === pedidoId)
    await markAdminPaymentProofSeen(
      pedidoId,
      pedido?.payment_proof_uploaded_at,
    )
    return true
  }

  const handleIssueInvoice = async (pedidoId: number) => {
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession()

      if (!session?.access_token) {
        return {
          ok: false,
          message: "La sesión administrativa venció.",
        }
      }

      const response = await fetch(`/api/admin/orders/${pedidoId}/invoice`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
      })
      const data = (await response.json()) as { error?: string }

      if (!response.ok) {
        const detail = data.error || "No se pudo emitir factura."
        const message = /ARCA_|configur|CUIT|PTO_VTA|cert|private/i.test(detail)
          ? `Revisar configuración fiscal. ${detail}`
          : detail

        setNotice({ type: "error", message })
        return { ok: false, message }
      }

      await reloadPedidos()
      const message = "Factura C emitida correctamente."
      setNotice({ type: "ok", message })
      return { ok: true, message }
    } catch (error) {
      console.error("ADMIN_INVOICE_ISSUE_ERROR", error)
      const message = "Error de conexión con ARCA. Inténtalo de nuevo."
      setNotice({ type: "error", message })
      return { ok: false, message }
    }
  }

  const handleDownloadInvoice = async (pedidoId: number) => {
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession()

      if (!session?.access_token) {
        return {
          ok: false,
          message: "La sesión administrativa venció.",
        }
      }

      const response = await fetch(`/api/admin/orders/${pedidoId}/invoice/pdf`, {
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
      })

      if (!response.ok) {
        const data = (await response.json()) as { error?: string }
        return {
          ok: false,
          message: data.error || "No se pudo descargar la factura.",
        }
      }

      const blob = await response.blob()
      downloadBlob(blob, "Factura-BEYONIX.pdf")
      return { ok: true, message: "Factura descargada." }
    } catch (error) {
      console.error("ADMIN_INVOICE_DOWNLOAD_ERROR", error)
      return {
        ok: false,
        message: "No se pudo descargar la factura.",
      }
    }
  }

  const handleDownloadCreditNote = async (pedidoId: number) => {
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession()

      if (!session?.access_token) {
        return {
          ok: false,
          message: "La sesión administrativa venció.",
        }
      }

      const response = await fetch(`/api/admin/orders/${pedidoId}/invoice/pdf?type=credit_note`, {
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
      })

      if (!response.ok) {
        const data = (await response.json()) as { error?: string }
        return {
          ok: false,
          message: data.error || "No se pudo descargar la nota de crédito.",
        }
      }

      const blob = await response.blob()
      downloadBlob(blob, "Nota-Credito-BEYONIX.pdf")
      return { ok: true, message: "Nota de crédito descargada." }
    } catch (error) {
      console.error("ADMIN_CREDIT_NOTE_DOWNLOAD_ERROR", error)
      return {
        ok: false,
        message: "No se pudo descargar la nota de crédito.",
      }
    }
  }

  const handleAndreaniAction = async (
    action: AndreaniAction,
    pedidoId: number
  ) => {
    try {
      const result = await runAndreaniAction(action, pedidoId)

      setNotice({
        type: result.ok ? "ok" : "error",
        message: result.message,
      })

      if (result.ok) {
        await reloadPedidos()
      }

      return result
    } catch (error) {
      console.error("ADMIN_ANDREANI_ACTION_ERROR", error)
      const result = {
        ok: false,
        message: "No se pudo completar la acción de Andreani.",
      }
      setNotice({
        type: "error",
        message: result.message,
      })
      return result
    }
  }

  if (initialOrderId) {
    if (loading) {
      return <div className="flex min-h-[50vh] items-center justify-center"><LoaderCircle className="size-8 animate-spin text-beyonix-sky" /></div>
    }

    if (!previewPedido) {
      return <div className="p-6"><button type="button" onClick={() => router.push("/admin?section=pedidos")} className="cursor-pointer text-sm font-bold text-beyonix-sky">← Volver a pedidos</button><p className="mt-4 text-sm text-white/60">No encontramos este pedido.</p></div>
    }

    return (
      <>
        <PedidoDetailModal
          embedded
          pedido={previewPedido}
          isSuperAdmin={isSuperAdmin}
          canEditRefundAmount={isAdmin || isSuperAdmin}
          onClose={() => router.push("/admin?section=pedidos")}
          onOpenPaymentProof={handleOpenPaymentProof}
          onEstadoChange={(pedido, nextEstado) => void handleEstadoChange(pedido, nextEstado)}
          onPaymentStatusChange={(pedidoId, nextStatus) =>
            void handlePaymentStatusChange(pedidoId, nextStatus)
          }
          onAndreaniAction={handleAndreaniAction}
          onIssueInvoice={handleIssueInvoice}
          onDownloadInvoice={handleDownloadInvoice}
          onDownloadCreditNote={handleDownloadCreditNote}
          onClaimChange={handleClaimChange}
          onRefundUpdated={handleRefundUpdated}
        />
        <ForcedStatusConfirmModal request={forcedStatusRequest} loading={forcedStatusLoading} onCancel={() => setForcedStatusRequest(null)} onConfirm={() => void confirmForcedStatusChange()} />
        <TrackingStatusModal request={trackingStatusRequest} loading={trackingStatusLoading} onCancel={() => setTrackingStatusRequest(null)} onConfirm={(tracking) => void confirmTrackingStatusChange(tracking)} />
      </>
    )
  }

  return (
    <div className="min-w-0 space-y-5 p-3 sm:p-5 lg:p-6 2xl:p-8">
      <div className="rounded-3xl border border-white/8 bg-black/80 p-4 sm:p-5">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
          <div className="min-w-0">
            <p className="mb-1 text-11px font-bold uppercase tracking-widest text-beyonix-cyan">
              Pedidos
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-2xl font-black text-white/95 sm:text-3xl">
                Gestión de pedidos
              </h1>
            </div>
            <p className="mt-2 text-sm text-white/68">
              Seguimiento de pago, productos, envío y prioridad de despacho.
            </p>
          </div>

          <div className="grid w-full gap-3 sm:grid-cols-admin-order-filters xl:max-w-xl">
            <AdminTextInput
              title="Buscar pedido"
              ariaLabel="Buscar pedido"
              placeholder="Buscar pedido, cliente o producto"
              value={search}
              icon={<Search className="size-4" />}
              onChange={setSearch}
            />

            <AdminSelect
              title="Filtrar estado"
              value={statusFilter}
              onChange={(value) => setStatusFilter(value as StatusFilter)}
            >
              <option value="todos">Todos los estados</option>
              <option value="pendiente">Pendientes</option>
              <option value="pagado">Pagados</option>
              <option value="enviado">Enviados</option>
              <option value="en_camino">En camino</option>
              <option value="entregado">Entregados</option>
              <option value="cancelado">Cancelados</option>
              <option value="refund_pending">Reintegro pendiente</option>
              <option value="refunded">Reintegrados</option>
              <option value="rechazado">Comprobantes rechazados</option>
            </AdminSelect>
          </div>
        </div>
      </div>

      {attentionFilter !== "all" && (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-white/8 bg-[#141820] px-3 py-2 text-xs text-white/70">
          <span>
            Filtro de notificaciones: {attentionFilter === "claim"
              ? "Reclamos por responder"
              : attentionFilter === "message"
                ? "Mensajes nuevos"
                : attentionFilter === "payment"
                  ? "Comprobantes nuevos"
                : attentionFilter === "invoice"
                  ? "Facturas pendientes"
                : attentionFilter === "shipping"
                  ? "Envíos pendientes"
                : attentionFilter === "cancellation"
                  ? "Cancelaciones y reintegros"
                  : "Pedidos nuevos"}
          </span>
          <button
            type="button"
            onClick={() => {
              setAttentionFilter("all")
              const nextParams = new URLSearchParams(searchParams.toString())
              nextParams.delete("attention")
              router.replace(`/admin?${nextParams.toString()}`, { scroll: false })
            }}
            className="cursor-pointer font-black text-beyonix-sky hover:text-white"
          >
            Ver todos
          </button>
        </div>
      )}

      {error && (
        <div className="rounded-2xl border border-red-400/20 bg-red-400/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      )}

      {notice && (
        <div
          role="status"
          className={`flex items-center gap-3 rounded-2xl border px-4 py-3 text-sm ${
            notice.type === "ok"
              ? "border-emerald-400/20 bg-emerald-400/10 text-emerald-200"
              : "border-red-400/20 bg-red-400/10 text-red-200"
          }`}
        >
          {notice.type === "ok" ? (
            <CheckCircle2 className="size-4 shrink-0" />
          ) : (
            <AlertTriangle className="size-4 shrink-0" />
          )}
          {notice.message}
        </div>
      )}

      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 7 }).map((_, index) => (
            <div
              key={index}
              className="h-112px animate-pulse rounded-3xl border border-white/7 bg-white/3"
            />
          ))}
        </div>
      ) : pedidosFiltrados.length === 0 ? (
        <div className="rounded-3xl border border-white/8 bg-black p-12 text-center">
          <ShoppingCart className="mx-auto mb-4 size-11 text-white/24" />
          <p className="text-sm font-bold text-white/72">
            No hay pedidos para los filtros seleccionados.
          </p>
        </div>
      ) : (
        <div className="w-full min-w-0 space-y-3">
            <div className="hidden grid-cols-admin-orders-pro gap-3 rounded-2xl border border-white/8 bg-black/90 px-4 py-3 2xl:grid">
                {[
                  "Pedido",
                  "Fecha",
                  "Cliente",
                  "Estado",
                  "Despacho",
                  "Método de pago",
                  "Total",
                  "Acciones",
                ].map((label) => (
                  <span
                    key={label}
                    title={label}
                    className="text-center text-11px font-bold uppercase tracking-wide text-white/55"
                  >
                    {label}
                  </span>
                ))}
              </div>

              {pedidosFiltrados.map((pedido) => {
                const dispatch = getDispatchAlert(pedido)
                const hasPendingAttention =
                  attentionOrderIds.has(pedido.id) ||
                  needsInvoiceReminder(pedido) ||
                  needsShippingReminder(pedido) ||
                  (pedido.estado === "cancelado" && !isRefundedOrder(pedido))
                const hasPendingClaim = orderHasPendingClaimAction(pedido)
                const attentionTone = getOrderNotificationTone(pedido)
                const showInvoiceReminder = needsInvoiceReminder(pedido)
                const showShippingReminder = needsShippingReminder(pedido)
                const paymentMethod = getCompactPaymentMethodLabel(pedido)
                const orderDate = formatOrderDateParts(pedido.created_at)
                const isNewOrder = newOrderIds.has(pedido.id)
                return (
                  <article
                    key={pedido.id}
                    className={`min-w-0 overflow-hidden rounded-2xl border p-4 transition sm:p-5 2xl:px-4 2xl:py-4 ${
                      hasPendingAttention
                        ? attentionTone === "claim"
                          ? ADMIN_SENSITIVE_DANGER.card
                          : attentionTone === "cancellation"
                            ? ADMIN_SENSITIVE_DANGER.card
                          : attentionTone === "message"
                            ? "border-sky-400/35 bg-sky-500/8 shadow-[0_0_16px_rgba(14,165,233,0.12)] hover:bg-sky-500/10"
                            : attentionTone === "payment"
                              ? "border-[#2563EB]/35 bg-[#2563EB]/8 shadow-[0_0_16px_rgba(37,99,235,0.12)] hover:bg-[#1D4ED8]/10"
                              : attentionTone === "invoice"
                                ? "border-violet-400/35 bg-violet-500/8 shadow-[0_0_16px_rgba(124,58,237,0.12)] hover:bg-violet-500/10"
                              : attentionTone === "shipping"
                                ? "border-[#77E6E2]/25 bg-zinc-900/75 hover:border-[#77E6E2]/40"
                                : "border-[#16A34A]/35 bg-[#16A34A]/8 shadow-[0_0_16px_rgba(22,163,74,0.12)] hover:bg-[#15803D]/10"
                        : "border-white/8 bg-zinc-900/75 hover:border-beyonix-blue-light/45 hover:bg-zinc-900"
                    } ${
                      isNewOrder
                        ? "ring-1 ring-emerald-400/65 shadow-[0_0_22px_rgba(52,211,153,0.2)]"
                        : ""
                    }`}
                  >
                    <div className="2xl:hidden">
                      <div className="flex min-w-0 items-start justify-between gap-3 border-b border-white/7 pb-4">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="text-base font-black text-white">
                              {formatPublicOrderId(pedido.id)}
                            </p>
                            {isNewOrder && (
                              <span className="rounded-full border border-emerald-400/35 bg-emerald-500/15 px-2 py-1 text-9px font-black uppercase tracking-wide text-emerald-200">
                                Nuevo pedido
                              </span>
                            )}
                            {showInvoiceReminder && <InvoiceReminderBell />}
                            {showShippingReminder && <ShippingReminderBadge />}
                            <EstadoBadge estado={getDisplayedOrderStatus(pedido)} />
                            {hasPendingClaim && <span className={`rounded-full border px-2 py-1 text-[10px] font-black uppercase tracking-wide ${ADMIN_SENSITIVE_DANGER.badge}`}>Reclamo pendiente</span>}
                          </div>
                        </div>
                        <div className="shrink-0 text-right">
                          <p className="text-9px font-bold uppercase tracking-widest text-white/38">
                            Total
                          </p>
                          <p className="mt-1 text-base font-black text-white">
                            {formatPrice(pedido.total)}
                          </p>
                        </div>
                      </div>

                      <div className="grid min-w-0 grid-cols-2 gap-x-4 gap-y-4 py-4 sm:grid-cols-3">
                        <MobileOrderField label="Fecha">
                          <p>{orderDate.date}</p>
                          <p className="text-xs font-medium text-white/48">
                            {orderDate.time}
                          </p>
                        </MobileOrderField>
                        <MobileOrderField label="Cliente">
                          <p
                            title={getOrderUsername(pedido)}
                            className="truncate uppercase"
                          >
                            {getOrderUsername(pedido).toLocaleUpperCase("es-AR")}
                          </p>
                        </MobileOrderField>
                      </div>

                      <div className="grid min-w-0 gap-4 border-y border-white/7 py-4 sm:grid-cols-3">
                        <MobileOrderField label="Estado">
                          <div className="flex min-w-0">
                            <EstadoBadge estado={getDisplayedOrderStatus(pedido)} />
                          </div>
                        </MobileOrderField>
                        <MobileOrderField label="Despacho">
                          <div className="flex min-w-0 flex-wrap items-center gap-2">
                            <span
                              title={dispatch.label}
                              className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-9px font-black uppercase tracking-wide ${dispatch.className}`}
                            >
                              <AlertTriangle className="size-3" />
                              {dispatch.label}
                            </span>
                          </div>
                        </MobileOrderField>
                        <MobileOrderField label="Pago">
                          <span className="inline-flex max-w-full items-center rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-10px font-black uppercase tracking-wide text-white/78">
                            <span className="truncate">{paymentMethod}</span>
                          </span>
                        </MobileOrderField>
                      </div>

                      <div className="flex items-center justify-between gap-3 pt-4">
                        <p className="min-w-0 truncate text-xs text-white/48">
                          {pedido.cliente_email || "Cliente sin correo informado"}
                        </p>
                        <div className="flex shrink-0 items-center gap-2">
                          <button
                            type="button"
                            aria-label={`Ver pedido ${pedido.id}`}
                            title="Ver pedido"
                            onClick={() => handleOpenPedido(pedido)}
                            className="flex h-9 cursor-pointer items-center justify-center gap-2 rounded-xl border border-beyonix-blue-light/30 px-3 text-xs font-bold text-beyonix-sky transition-colors hover:bg-beyonix-blue"
                          >
                            <Eye className="size-3.5" />
                            Ver
                          </button>
                          <button
                            type="button"
                            aria-label={`Eliminar pedido ${pedido.id}`}
                            title="Eliminar pedido"
                            onClick={() => handleDelete(pedido.id)}
                            className="flex size-9 cursor-pointer items-center justify-center rounded-xl border border-white/8 text-white/62 transition-colors hover:border-red-500/30 hover:text-red-300"
                          >
                            <Trash2 className="size-4" />
                          </button>
                        </div>
                      </div>
                    </div>

                    <div className="hidden min-w-0 grid-cols-admin-orders-pro items-center gap-3 text-center 2xl:grid">
                  <div className="relative flex min-w-0 items-center justify-center">
                    {(showInvoiceReminder || showShippingReminder) && (
                      <span className="absolute left-2 top-1/2 flex -translate-y-1/2 flex-col gap-1">
                        {showInvoiceReminder && <InvoiceReminderBell />}
                        {showShippingReminder && <ShippingReminderBadge />}
                      </span>
                    )}
                    <div className="text-center">
                      <p className="text-11px font-black uppercase tracking-wide text-beyonix-sky">
                        #BX-
                      </p>
                      <p className="mt-0.5 text-sm font-black text-white/95">
                        {formatPublicOrderNumber(pedido.id)}
                      </p>
                      {isNewOrder && (
                        <span className="mt-1 inline-flex rounded-full border border-emerald-400/35 bg-emerald-500/15 px-2 py-0.5 text-9px font-black uppercase tracking-wide text-emerald-200">
                          Nuevo
                        </span>
                      )}
                      {hasPendingClaim && <span className={`mt-1 inline-flex rounded-full border px-2 py-0.5 text-[9px] font-black uppercase tracking-wide ${ADMIN_SENSITIVE_DANGER.badge}`}>Reclamo pendiente</span>}
                    </div>
                  </div>

                  <div title={formatOrderDate(pedido.created_at)} className="text-center">
                    <p className="text-sm font-black leading-5 text-white/95">
                      {orderDate.date}
                    </p>
                    <p className="text-11px font-bold leading-4 text-white/52">
                      {orderDate.time}
                    </p>
                  </div>

                  <div className="flex min-w-0 justify-center">
                    <p
                      title={getOrderUsername(pedido)}
                      className="truncate text-sm font-bold uppercase leading-5 text-white/92"
                    >
                      {getOrderUsername(pedido).toLocaleUpperCase("es-AR")}
                    </p>
                  </div>

                  <div className="text-center">
                    <div className="flex justify-center">
                      <EstadoBadge estado={getDisplayedOrderStatus(pedido)} />
                    </div>
                  </div>

                  <div className="text-center">
                    <span
                      title={dispatch.label}
                      className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-10px font-black uppercase tracking-wide ${dispatch.className}`}
                    >
                      <AlertTriangle className="size-3" />
                      {dispatch.label}
                    </span>
                  </div>

                  <div className="min-w-0 space-y-1 text-center">
                    <span
                      title={paymentMethod}
                      className="inline-flex max-w-full items-center rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-10px font-black uppercase tracking-wide text-white/78"
                    >
                      <span className="truncate">
                        {paymentMethod}
                      </span>
                    </span>
                  </div>

                  <div className="min-w-0 text-center">
                    <p className="text-sm font-black text-white/95">
                      {formatPrice(pedido.total)}
                    </p>
                  </div>

                  <div className="flex items-center justify-center gap-1">
                    <button
                      type="button"
                      aria-label={`Ver pedido ${pedido.id}`}
                      title="Ver pedido"
                      onClick={() => handleOpenPedido(pedido)}
                      className="flex size-8 cursor-pointer items-center justify-center rounded-lg border border-white/8 text-white/68 transition-colors hover:border-beyonix-blue-light/35 hover:text-beyonix-sky"
                    >
                      <Eye className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      aria-label={`Eliminar pedido ${pedido.id}`}
                      title="Eliminar pedido"
                      onClick={() => handleDelete(pedido.id)}
                      className="flex size-8 cursor-pointer items-center justify-center rounded-lg border border-white/8 text-white/62 transition-colors hover:border-red-500/30 hover:text-red-300"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </div>
                </div>
                  </article>
                )
              })}
            </div>
      )}
      {previewPedido && (
        <PedidoDetailModal
          pedido={previewPedido}
          isSuperAdmin={isSuperAdmin}
          canEditRefundAmount={isAdmin || isSuperAdmin}
          onClose={() => setPreviewPedido(null)}
          onOpenPaymentProof={handleOpenPaymentProof}
          onEstadoChange={(pedido, nextEstado) =>
            void handleEstadoChange(pedido, nextEstado)
          }
          onPaymentStatusChange={(pedidoId, nextStatus) =>
            void handlePaymentStatusChange(pedidoId, nextStatus)
          }
          onAndreaniAction={handleAndreaniAction}
          onIssueInvoice={handleIssueInvoice}
          onDownloadInvoice={handleDownloadInvoice}
          onDownloadCreditNote={handleDownloadCreditNote}
          onClaimChange={handleClaimChange}
          onRefundUpdated={handleRefundUpdated}
        />
      )}
      <ForcedStatusConfirmModal
        request={forcedStatusRequest}
        loading={forcedStatusLoading}
        onCancel={() => setForcedStatusRequest(null)}
        onConfirm={() => void confirmForcedStatusChange()}
      />
      <TrackingStatusModal
        request={trackingStatusRequest}
        loading={trackingStatusLoading}
        onCancel={() => setTrackingStatusRequest(null)}
        onConfirm={(tracking) => void confirmTrackingStatusChange(tracking)}
      />
    </div>
  )
}

