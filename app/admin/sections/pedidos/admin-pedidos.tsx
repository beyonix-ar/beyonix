"use client"

import { useEffect, useMemo, useState } from "react"
import {
  AlertTriangle,
  Bell,
  CheckCircle2,
  CreditCard,
  Download,
  Eye,
  FileText,
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
import { parseDeliveryAddress } from "@/lib/delivery-address"
import {
  getOrderClaimResolutionLabel,
  getOrderClaimStatusLabel,
  getOrderClaimTypeLabel,
} from "@/lib/order-claims"
import {
  getAdminOrderLastSeenAt,
  getSupabaseErrorDetails,
  isOrderNewerThanLastSeen,
  markOrdersSeenAndGetPreviousLastSeen,
  notifyOrderNotificationsChanged,
} from "@/lib/admin/order-notifications"
import { supabase } from "@/lib/supabase/client"
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
type AndreaniAction = "crear-envio" | "tracking"
type AdminNotice = { type: "ok" | "error"; message: string } | null
type ForcedStatusRequest = {
  pedido: SupabasePedido
  nextEstado: "en_camino" | "entregado"
} | null
type AdminOrderDetailView = "detalle" | "factura" | "reclamo"

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
  return pedido.envio_proveedor || "Andreani"
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

  return pedido.payment_method_id || pedido.payment_type_id || "Método no informado"
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

function isVisibleAdminOrder(pedido: SupabasePedido) {
  if (isTransferOrder(pedido)) return true

  const isMercadoPago =
    pedido.payment_method_id === "mercadopago" ||
    Boolean(pedido.payment_id) ||
    ["pending_checkout", "pending", "rejected", "cancelled"].includes(
      pedido.payment_status ?? ""
    )

  return !isMercadoPago || pedido.payment_status === "approved"
}

function getPaymentStatusLabel(status?: string | null) {
  const labels: Record<string, string> = {
    pendiente_comprobante: "Falta comprobante",
    en_revision: "Falta comprobante",
    confirmado: "Confirmado",
    rechazado: "Rechazado",
    approved: "Aprobado",
    pending: "Pendiente",
    rejected: "Rechazado",
  }

  return status ? labels[status] ?? status : "Sin estado"
}

function isRejectedPayment(status?: string | null) {
  return status === "rechazado" || status === "rejected"
}

function isApprovedPayment(pedido: SupabasePedido) {
  return (
    pedido.estado === "pagado" ||
    pedido.payment_status === "confirmado" ||
    pedido.payment_status === "approved"
  )
}

function needsPaymentProof(status?: string | null) {
  return status === "pendiente_comprobante"
}

function getTransferPaymentStatusBadge(status?: string | null) {
  const badges: Record<string, { label: string; className: string }> = {
    pendiente_comprobante: {
      label: "Falta comprobante",
      className: "border-amber-400/25 bg-amber-400/10 text-amber-200",
    },
    en_revision: {
      label: "Falta comprobante",
      className: "border-amber-400/25 bg-amber-400/10 text-amber-200",
    },
    confirmado: {
      label: "Pago confirmado",
      className: "border-emerald-400/25 bg-emerald-400/10 text-emerald-300",
    },
    rechazado: {
      label: "Pago rechazado",
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

function OrderNotificationBell({ count }: { count: number }) {
  return (
    <span
      title={
        count
          ? `${count} pedidos requieren atención`
          : "Sin pedidos pendientes de atención"
      }
      className="relative inline-flex size-10 items-center justify-center rounded-full border border-white/12 bg-black text-white"
    >
      <Bell className="size-4 text-white" />
      {count > 0 && (
        <span className="absolute -right-1.5 -top-1.5 flex min-h-5 min-w-5 items-center justify-center rounded-full border-2 border-black bg-red-500 px-1 text-10px font-black leading-none text-white shadow-lg shadow-red-950/40">
          {count > 99 ? "99+" : count}
        </span>
      )}
    </span>
  )
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
  const dispatched =
    pedido.estado === "enviado" ||
    pedido.estado === "entregado" ||
    Boolean(pedido.tracking_number || pedido.tracking_url)

  if (dispatched || pedido.estado === "cancelado") {
    return {
      label: "Despachado",
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
    cancelado: "border-red-500/20 bg-red-500/10 text-red-300",
  }
  const labels: Record<string, string> = {
    pendiente: "Pendiente",
    pagado: "Pago confirmado",
    enviado: "Despachado",
    en_camino: "En camino",
    entregado: "Entregado",
    cancelado: "Cancelado/Rechazado",
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

function ProductsSummary({ pedido }: { pedido: SupabasePedido }) {
  const items = pedido.orden_items ?? []

  if (!items.length) {
    return (
      <span title="Sin detalle cargado" className="text-xs text-white/55">
        Sin detalle cargado
      </span>
    )
  }

  const principal = items[0]
  const productName =
    principal.productos?.nombre ?? `Producto #${principal.producto_id}`

  return (
    <div className="min-w-0">
      <p
        title={productName}
        className="truncate text-sm font-black leading-5 text-white/95"
      >
        {productName}
      </p>
    </div>
  )
}

function QuantitySummary({ pedido }: { pedido: SupabasePedido }) {
  const items = pedido.orden_items ?? []

  if (!items.length) {
    return <span className="text-xs text-white/55">-</span>
  }

  const totalQuantity = items.reduce(
    (sum, item) => sum + Number(item.cantidad ?? 0),
    0
  )

  return (
    <p
      title={`${totalQuantity} unidades en total`}
      className="text-center text-sm font-black text-white/95"
    >
      {totalQuantity}
    </p>
  )
}

function ColorSummary({ pedido }: { pedido: SupabasePedido }) {
  const items = pedido.orden_items ?? []

  if (!items.length) {
    return <span className="text-xs text-white/55">-</span>
  }

  const principalColor = getItemColor(items[0])

  return (
    <div className="min-w-0 text-center">
      <p title={principalColor} className="truncate text-sm font-black text-white/95">
        {principalColor}
      </p>
    </div>
  )
}

function getOrderProductName(pedido: SupabasePedido) {
  const principal = pedido.orden_items?.[0]

  if (!principal) return "Sin detalle cargado"

  return principal.productos?.nombre ?? `Producto #${principal.producto_id}`
}

function getOrderQuantity(pedido: SupabasePedido) {
  return (pedido.orden_items ?? []).reduce(
    (sum, item) => sum + Number(item.cantidad ?? 0),
    0
  )
}

function getOrderColor(pedido: SupabasePedido) {
  const principal = pedido.orden_items?.[0]
  return principal ? getItemColor(principal) : "Sin color"
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
  onOpenPaymentProof: (pedidoId: number) => void
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
                  <EstadoBadge estado={pedido.estado} />
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
  onClose,
  onOpenPaymentProof,
  onEstadoChange,
  onAndreaniAction,
  onIssueInvoice,
  onDownloadInvoice,
  onClaimChange,
}: {
  pedido: SupabasePedido
  isSuperAdmin: boolean
  onClose: () => void
  onOpenPaymentProof: (pedidoId: number) => void
  onEstadoChange: (pedido: SupabasePedido, nextEstado: string) => void
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
  onClaimChange: (pedidoId: number, claim: SupabaseOrderClaim) => void
}) {
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
  const [invoiceNotice, setInvoiceNotice] = useState<{
    ok: boolean
    message: string
  } | null>(null)
  const [activeView, setActiveView] =
    useState<AdminOrderDetailView>("detalle")
  const destination =
    [pedido.localidad, pedido.provincia].filter(Boolean).join(", ") ||
    "No informado"

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

  return (
    <div className="fixed inset-0 z-100 flex items-center justify-center bg-black/82 px-4 py-6 backdrop-blur-sm">
      <div className="flex max-h-[88vh] w-full max-w-5xl flex-col overflow-hidden rounded-3xl border border-white/12 bg-[#0b0b0b] shadow-2xl shadow-black/80">
        <header className="flex items-start justify-between gap-4 border-b border-white/8 bg-[#141414] px-5 py-4 sm:px-6">
          <div className="min-w-0">
            <p className="text-11px font-bold uppercase tracking-widest text-beyonix-cyan">
              Detalle del pedido
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <h2 className="text-2xl font-black text-white">
                Pedido #{formatPublicOrderId(pedido.id)}
              </h2>
              <EstadoBadge estado={pedido.estado} />
              <div className="flex flex-wrap gap-2">
                {[
                  ["detalle", "Detalle"],
                  ["factura", "Factura"],
                  ["reclamo", "Reclamo"],
                ].map(([view, label]) => (
                  <button
                    key={view}
                    type="button"
                    onClick={() => setActiveView(view as AdminOrderDetailView)}
                    className={`inline-flex h-8 cursor-pointer items-center justify-center rounded-xl border px-3 text-10px font-black uppercase tracking-wide transition-colors ${
                      activeView === view
                        ? "border-beyonix-blue-light bg-beyonix-blue text-beyonix-sky"
                        : "border-beyonix-blue-light/25 bg-[#111111] text-white/68 hover:border-beyonix-blue-light/45 hover:text-beyonix-sky"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <p className="mt-2 text-sm text-white/55">
              {formatOrderDate(pedido.created_at)} · {getPaymentMethodLabel(pedido)}
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-4">
            <div className="hidden text-right sm:block">
              <p className="text-10px font-bold uppercase tracking-widest text-white/38">
                Total
              </p>
              <p className="mt-1 text-xl font-black text-white">
                {formatPrice(pedido.total)}
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
        </header>

        <div className="custom-scrollbar overflow-y-auto bg-[#0b0b0b] px-4 py-4 sm:px-6 sm:py-5">
          {activeView === "detalle" && (
            <>
          <div className="grid gap-4 lg:grid-cols-2">
            <section className="admin-order-data-panel admin-order-client-panel rounded-2xl border border-white/8 p-4 sm:p-5">
              <p className="text-11px font-bold uppercase tracking-widest text-beyonix-cyan">
                Cliente
              </p>
              <h3 className="mt-3 text-lg font-black text-white">
                {pedido.cliente_nombre || "Cliente sin nombre"}
              </h3>
              <div className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
                <DetailValue label="Email" value={pedido.cliente_email || "No informado"} />
                <DetailValue
                  label="Teléfono"
                  value={pedido.cliente_telefono || "No informado"}
                />
                <CustomerAddressDetails pedido={pedido} />
              </div>
            </section>

            <section className="admin-order-data-panel admin-order-payment-panel rounded-2xl border border-white/8 p-4 sm:p-5">
              <p className="text-11px font-bold uppercase tracking-widest text-beyonix-cyan">
                Pago
              </p>
              <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="text-lg font-black text-white">
                    {getPaymentMethodLabel(pedido)}
                  </h3>
                  <p
                    className={`mt-1 text-sm ${
                      isRejectedPayment(pedido.payment_status)
                        ? "font-bold text-red-300"
                        : "text-white/58"
                    }`}
                  >
                    {getPaymentStatusLabel(pedido.payment_status)}
                  </p>
                </div>
                <p className="text-xl font-black text-white">
                  {formatPrice(pedido.total)}
                </p>
              </div>

              {isTransferOrder(pedido) ? (
                <div className="mt-4 space-y-4 border-t border-white/8 pt-4">
                  <TransferPaymentBadges pedido={pedido} />
                  <div className="w-full max-w-56">
                    <p className="mb-2 text-10px font-bold uppercase tracking-widest text-white/38">
                      Estado administrativo
                    </p>
                    <AdminSelect
                      title="Estado administrativo"
                      compact
                      centered
                      value={pedido.estado}
                      onChange={(value) => onEstadoChange(pedido, value)}
                    >
                      <option value="pendiente">Pendiente</option>
                      <option value="pagado">Pago confirmado</option>
                      <option value="enviado">Despachado</option>
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
                      <option value="cancelado">Cancelado/Rechazado</option>
                    </AdminSelect>
                  </div>
                  <div className="admin-order-proof-card flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/8 p-3">
                    <DetailValue
                      label="Comprobante actual"
                      value={pedido.payment_proof_file_name || "Sin comprobante"}
                    />
                    {pedido.payment_proof_url && (
                      <button
                        type="button"
                        title="Ver comprobante"
                        aria-label={`Ver comprobante del pedido ${pedido.id}`}
                        onClick={() => onOpenPaymentProof(pedido.id)}
                        className="inline-flex h-9 cursor-pointer items-center justify-center gap-2 rounded-xl border border-beyonix-blue-light/35 px-3 text-11px font-black uppercase tracking-wide text-beyonix-sky transition-colors hover:bg-beyonix-blue"
                      >
                        <Download className="size-4" />
                        Ver comprobante
                      </button>
                    )}
                  </div>
                </div>
              ) : (
                <div className="mt-4 grid gap-3 border-t border-white/8 pt-4 sm:grid-cols-2">
                  <DetailValue label="ID de pago" value={pedido.payment_id || "No informado"} />
                  <DetailValue
                    label="Fecha de acreditación"
                    value={formatOptionalOrderDate(pedido.paid_at)}
                  />
                </div>
              )}
            </section>
          </div>

          <section className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="admin-order-info-card rounded-xl border border-white/8 p-3">
              <DetailValue
                label="Subtotal productos"
                value={formatPrice(financialBreakdown.productsSubtotal)}
              />
            </div>
            <div className="admin-order-info-card rounded-xl border border-white/8 p-3">
              <DetailValue
                label="Descuento transferencia"
                value={
                  financialBreakdown.transferDiscount > 0
                    ? `-${formatPrice(financialBreakdown.transferDiscount)}`
                    : formatPrice(0)
                }
              />
            </div>
            <div className="admin-order-info-card rounded-xl border border-white/8 p-3">
              <DetailValue
                label="Envío"
                value={
                  financialBreakdown.shipping > 0
                    ? formatPrice(financialBreakdown.shipping)
                    : "Gratis"
                }
              />
            </div>
            <div className="admin-order-total-card rounded-xl border border-beyonix-blue-light/20 p-3">
              <DetailValue label="Total cobrado" value={formatPrice(pedido.total)} />
            </div>
          </section>
            </>
          )}

          {activeView === "factura" && (
          <section className="admin-order-invoice-panel mt-4 rounded-2xl border border-beyonix-blue-light/20 p-4 sm:p-5">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <p className="text-11px font-bold uppercase tracking-widest text-beyonix-cyan">
                  Factura electrónica
                </p>
                {pedido.invoice_status === "authorized" ? (
                  <>
                    <h3 className="mt-2 flex items-center gap-2 text-lg font-black text-white">
                      <FileText className="size-5 text-emerald-300" />
                      Factura C emitida
                    </h3>
                    <p className="mt-1 text-sm font-bold text-beyonix-sky">
                      Factura C{" "}
                      {formatInvoiceNumber(
                        pedido.invoice_point,
                        pedido.invoice_number,
                      )}
                    </p>
                  </>
                ) : (
                  <>
                    <h3 className="mt-2 text-lg font-black text-white">
                      Emitir comprobante fiscal
                    </h3>
                    <p className="mt-1 max-w-xl text-sm leading-6 text-white/55">
                      La Factura C se solicitará a ARCA y quedará asociada a
                      este pedido.
                    </p>
                  </>
                )}
              </div>

              {pedido.invoice_status === "authorized" ? (
                <button
                  type="button"
                  onClick={() => void handleDownloadInvoice()}
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
                  onClick={() => void handleIssueInvoice()}
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

            {pedido.invoice_status === "authorized" ? (
              <div className="mt-4 grid gap-3 border-t border-white/8 pt-4 sm:grid-cols-3">
                <div className="admin-order-info-card rounded-xl border border-white/8 p-3">
                  <DetailValue
                    label="CAE"
                    value={pedido.invoice_cae || "No informado"}
                  />
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
              </div>
            ) : !isApprovedPayment(pedido) ? (
              <p className="mt-4 rounded-xl border border-amber-400/20 bg-amber-400/8 px-3 py-2 text-xs font-medium text-amber-200">
                Confirmá el pago antes de emitir la factura.
              </p>
            ) : null}

            {invoiceNotice && (
              <p
                role="status"
                className={`mt-4 rounded-xl border px-3 py-2 text-xs font-medium ${
                  invoiceNotice.ok
                    ? "border-emerald-400/20 bg-emerald-400/8 text-emerald-200"
                    : "border-red-400/20 bg-red-400/8 text-red-200"
                }`}
              >
              {invoiceNotice.message}
            </p>
          )}
          </section>
          )}

          {activeView === "reclamo" && (
          <AdminClaimsCenterSection
            pedido={pedido}
            onClaimChange={(claim) => onClaimChange(pedido.id, claim)}
          />
          )}

          {activeView === "detalle" && (
            <>
          <section className="admin-order-products-panel mt-4 rounded-2xl border border-white/8 p-4 sm:p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-11px font-bold uppercase tracking-widest text-beyonix-cyan">
                  Productos
                </p>
                <p className="mt-1 text-sm text-white/55">
                  {items.reduce((sum, item) => sum + Number(item.cantidad ?? 0), 0)} unidades
                </p>
              </div>
              <p className="text-lg font-black text-white">{formatPrice(pedido.total)}</p>
            </div>

            <div className="mt-4 space-y-3">
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
                      className="admin-order-item-card grid gap-3 rounded-xl border border-white/8 p-3 sm:grid-cols-admin-order-modal-item sm:items-center"
                    >
                      <div className="flex min-w-0 items-center gap-3">
                        <div className="flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-white/8 bg-white">
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
                          <p className="font-black text-white">{productName}</p>
                          <p className="mt-1 text-xs text-white/48">
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

          <section className="admin-order-shipping-panel mt-4 rounded-2xl border border-beyonix-blue-light/20 p-4 sm:p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-11px font-bold uppercase tracking-widest text-beyonix-cyan">
                  Envío
                </p>
                <h3 className="mt-2 flex items-center gap-2 text-lg font-black text-white">
                  <Truck className="size-5 text-beyonix-sky" />
                  {isLocalRosarioOrder
                    ? "Envío sin costo"
                    : pedido.shipping_type === "sucursal"
                      ? "Retiro en sucursal"
                      : "Envío a domicilio"}
                </h3>
                {isLocalRosarioOrder && (
                  <p className="mt-1 text-sm font-medium text-beyonix-sky/88">
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

            <div className="mt-4 grid gap-3 border-t border-white/8 pt-4 sm:grid-cols-2 lg:grid-cols-3">
              <div className="admin-order-info-card rounded-xl border border-white/8 p-3">
                <DetailValue
                  label="Proveedor"
                  value={
                    isLocalRosarioOrder
                      ? "Envío local Rosario"
                      : getShippingProvider(pedido)
                  }
                />
              </div>
              <div className="admin-order-info-card rounded-xl border border-white/8 p-3">
                <DetailValue label="Estado" value={getAndreaniStatus(pedido)} />
              </div>
              <div className="admin-order-info-card rounded-xl border border-white/8 p-3">
                <DetailValue label="Seguimiento" value={tracking || "Pendiente"} />
              </div>
              <div className="admin-order-info-card rounded-xl border border-white/8 p-3">
                <DetailValue
                  label="Envío ID"
                  value={pedido.andreani_envio_id || "Pendiente"}
                />
              </div>
              <div className="admin-order-info-card rounded-xl border border-white/8 p-3">
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
              <div className="admin-order-info-card rounded-xl border border-white/8 p-3">
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

            <div className="mt-4 rounded-2xl border border-white/8 bg-black/35 p-3">
              <p className="text-10px font-bold uppercase tracking-widest text-white/38">
                Acciones de Andreani
              </p>
              <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
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
                    href={pedido.tracking_url}
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
    <div className="sm:col-span-2 rounded-xl border border-white/8 bg-[#111111] p-3">
      <p className="text-10px font-bold uppercase tracking-widest text-white/38">
        Dirección
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
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
          status,
          resolution: resolution || null,
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
      setMessage("Reclamo actualizado.")
    } catch {
      setMessage("No se pudo actualizar el reclamo.")
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="admin-order-invoice-panel mt-4 rounded-2xl border border-beyonix-blue-light/20 p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-11px font-bold uppercase tracking-widest text-beyonix-cyan">
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
        <p className="mt-4 rounded-xl border border-white/8 bg-[#111111] px-3 py-2 text-xs font-medium text-white/55">
          Este pedido todavía no tiene reclamos cargados.
        </p>
      ) : (
        <div className="mt-4 grid gap-4 border-t border-white/8 pt-4 lg:grid-cols-2">
          <div className="space-y-3">
            <div className="admin-order-info-card rounded-xl border border-white/8 p-3">
              <DetailValue
                label="Tipo de reclamo"
                value={getOrderClaimTypeLabel(claim.claim_type)}
              />
            </div>
            <div className="admin-order-info-card rounded-xl border border-white/8 p-3">
              <DetailValue
                label="Descripción"
                value={claim.description || "Sin descripción"}
                wide
              />
            </div>
            {claim.failure_type && (
              <div className="admin-order-info-card rounded-xl border border-white/8 p-3">
                <DetailValue label="Tipo de falla" value={claim.failure_type} />
              </div>
            )}
            {claim.started_at && (
              <div className="admin-order-info-card rounded-xl border border-white/8 p-3">
                <DetailValue label="Inicio de falla" value={claim.started_at} />
              </div>
            )}
            <div className="rounded-xl border border-white/8 bg-[#111111] p-3">
              <p className="text-10px font-bold uppercase tracking-widest text-white/38">
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
                      className="inline-flex h-9 items-center gap-2 rounded-xl border border-beyonix-blue-light/30 px-3 text-10px font-black uppercase tracking-wide text-beyonix-sky"
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
                  <option value="falta_informacion">Falta información</option>
                  <option value="aprobado">Aprobado</option>
                  <option value="rechazado">Rechazado</option>
                  <option value="cerrado">Cerrado</option>
                </AdminSelect>
              </div>
              <div>
                <p className="mb-2 text-10px font-bold uppercase tracking-widest text-white/38">
                  Resolución
                </p>
                <AdminSelect
                  title="Resolución del reclamo"
                  value={resolution}
                  onChange={(value) =>
                    setResolution(value as OrderClaimResolution | "")
                  }
                >
                  <option value="">Sin resolución</option>
                  <option value="cambio_producto">Cambio de producto</option>
                  <option value="reintegro_total">Reintegro total</option>
                  <option value="reintegro_parcial">Reintegro parcial</option>
                  <option value="cupon_descuento">Cupón de descuento</option>
                  <option value="rechazado">Rechazado</option>
                  <option value="otro">Otra solución</option>
                </AdminSelect>
              </div>
            </div>
            <textarea
              value={adminResponse}
              onChange={(event) => setAdminResponse(event.target.value)}
              rows={4}
              placeholder="Respuesta visible para el cliente."
              className="w-full resize-none rounded-xl border border-beyonix-blue-light/25 bg-[#111111] px-3 py-3 text-sm font-semibold text-white outline-none placeholder:text-white/34 focus:border-beyonix-blue-light"
            />
            <textarea
              value={rejectionReason}
              onChange={(event) => setRejectionReason(event.target.value)}
              rows={3}
              placeholder="Motivo de rechazo obligatorio si el estado es Rechazado."
              className="w-full resize-none rounded-xl border border-white/10 bg-[#111111] px-3 py-3 text-sm font-semibold text-white outline-none placeholder:text-white/34 focus:border-beyonix-blue-light"
            />
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs font-semibold text-white/48">
                {message ||
                  `Actual: ${getOrderClaimStatusLabel(claim.status)} · ${getOrderClaimResolutionLabel(claim.resolution)}`}
              </p>
              <button
                type="button"
                onClick={() => void saveClaim()}
                disabled={saving}
                className="inline-flex h-10 cursor-pointer items-center justify-center rounded-xl border border-beyonix-blue-light/35 bg-beyonix-blue px-4 text-11px font-black uppercase tracking-wide text-beyonix-sky disabled:cursor-wait disabled:opacity-50"
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
  notificationCount,
}: {
  notificationCount: number
}) {
  const { isSuperAdmin } = useAuth()
  const { pedidos, loading, error, deletePedido, updatePedidoEstado, reloadPedidos } =
    usePedidos()
  const [search, setSearch] = useState("")
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("todos")
  const [previewPedido, setPreviewPedido] = useState<SupabasePedido | null>(null)
  const [newOrderIds, setNewOrderIds] = useState<Set<number>>(() => new Set())
  const [unreadOrdersLoaded, setUnreadOrdersLoaded] = useState(false)
  const [notice, setNotice] = useState<AdminNotice>(null)
  const [forcedStatusRequest, setForcedStatusRequest] =
    useState<ForcedStatusRequest>(null)
  const [forcedStatusLoading, setForcedStatusLoading] = useState(false)

  useEffect(() => {
    if (!notice) return

    const timeout = window.setTimeout(() => setNotice(null), 4000)
    return () => window.clearTimeout(timeout)
  }, [notice])

  useEffect(() => {
    if (!previewPedido) return

    const updatedPedido = pedidos.find(
      (pedido) => pedido.id === previewPedido.id
    )

    if (updatedPedido && updatedPedido !== previewPedido) {
      setPreviewPedido(updatedPedido)
    }
  }, [pedidos, previewPedido])

  useEffect(() => {
    if (loading) return
    if (unreadOrdersLoaded) return

    let active = true

    async function loadUnreadOrders() {
      try {
        const lastSeenAt = await getAdminOrderLastSeenAt()

        if (!active) return

        if (!lastSeenAt) {
          setUnreadOrdersLoaded(true)
          return
        }

        setNewOrderIds(
          new Set(
            pedidos
              .filter(
                (pedido) =>
                  isVisibleAdminOrder(pedido) &&
                  isOrderNewerThanLastSeen(pedido.created_at, lastSeenAt)
              )
              .map((pedido) => pedido.id)
          )
        )
        setUnreadOrdersLoaded(true)
      } catch (error) {
        console.error(
          "ADMIN_ORDER_VIEW_MARK_ERROR",
          getSupabaseErrorDetails(error)
        )
      }
    }

    void loadUnreadOrders()

    return () => {
      active = false
    }
  }, [loading, pedidos, unreadOrdersLoaded])

  const handleOpenPedido = (pedido: SupabasePedido) => {
    setPreviewPedido(pedido)

    if (!newOrderIds.has(pedido.id)) return

    const remainingUnread = new Set(newOrderIds)
    remainingUnread.delete(pedido.id)
    setNewOrderIds(remainingUnread)

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
        statusFilter === "todos" || pedido.estado === statusFilter

      return matchesSearch && matchesStatus
    })
  }, [pedidos, search, statusFilter])

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
      const trackingNumber =
        prompt("Número de seguimiento (opcional)")?.trim() || null
      const trackingUrl = prompt("Link de seguimiento (opcional)")?.trim() || null

      const updated = await updatePedidoEstado(pedidoId, nextEstado, {
        tracking_number: trackingNumber,
        tracking_url: trackingUrl,
      })
      if (updated) {
        setNotice({ type: "ok", message: "Estado del pedido actualizado." })
        notifyOrderNotificationsChanged()
      } else {
        setNotice({ type: "error", message: "No se pudo actualizar el estado." })
      }
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
      return
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
      return
    }

    if (data.order) {
      setPreviewPedido((currentPedido) =>
        currentPedido?.id === pedidoId
          ? {
              ...currentPedido,
              payment_status: data.order.payment_status,
              estado: data.order.estado,
              paid_at: data.order.paid_at,
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


  const handleOpenPaymentProof = async (pedidoId: number) => {
    const {
      data: { session },
    } = await supabase.auth.getSession()

    if (!session?.access_token) {
      setNotice({ type: "error", message: "La sesión administrativa venció." })
      return
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
      return
    }

    window.open(data.signedUrl, "_blank", "noopener,noreferrer")
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
            <OrderNotificationBell
              count={unreadOrdersLoaded ? newOrderIds.size : notificationCount}
            />
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
            <option value="enviado">Despachados</option>
            <option value="en_camino">En camino</option>
            <option value="entregado">Entregados</option>
            <option value="cancelado">Cancelados/Rechazados</option>
          </AdminSelect>
        </div>
        </div>
      </div>

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
                  "Cliente",
                  "Productos",
                  "Cantidad",
                  "Color",
                  "Fecha",
                  "Estado",
                  "Despacho",
                  "Pago",
                  "Total",
                  "Acciones",
                ].map((label) => (
                  <span
                    key={label}
                    title={label}
                    className={`text-11px font-bold uppercase tracking-wide text-white/55 ${
                      ["Pedido", "Cliente", "Productos"].includes(label)
                        ? "text-left"
                        : "text-center"
                    }`}
                  >
                    {label}
                  </span>
                ))}
              </div>

              {pedidosFiltrados.map((pedido) => {
                const dispatch = getDispatchAlert(pedido)
                const isNewOrder = newOrderIds.has(pedido.id)
                const paymentMethod = getCompactPaymentMethodLabel(pedido)
                const orderDate = formatOrderDateParts(pedido.created_at)
                return (
                  <article
                    key={pedido.id}
                    className={`min-w-0 overflow-hidden rounded-2xl border p-4 transition sm:p-5 2xl:px-4 2xl:py-4 ${
                      isNewOrder
                        ? "border-emerald-400/35 bg-emerald-500/10 shadow-lg shadow-emerald-500/5 hover:bg-emerald-500/15"
                        : "border-white/8 bg-zinc-900/75 hover:border-beyonix-blue-light/45 hover:bg-zinc-900"
                    }`}
                  >
                    <div className="2xl:hidden">
                      <div className="flex min-w-0 items-start justify-between gap-3 border-b border-white/7 pb-4">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="text-base font-black text-white">
                              {formatPublicOrderId(pedido.id)}
                            </p>
                            <EstadoBadge estado={pedido.estado} />
                            {isNewOrder && (
                              <span className="inline-flex items-center rounded-full border border-emerald-400/30 bg-emerald-400/10 px-2 py-0.5 text-9px font-black uppercase tracking-widest text-emerald-300">
                                Nuevo
                              </span>
                            )}
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
                        <MobileOrderField label="Cliente">
                          <p title={getOrderUsername(pedido)} className="truncate">
                            {getOrderUsername(pedido)}
                          </p>
                        </MobileOrderField>
                        <MobileOrderField label="Producto">
                          <p title={getOrderProductName(pedido)} className="truncate">
                            {getOrderProductName(pedido)}
                          </p>
                        </MobileOrderField>
                        <MobileOrderField label="Cantidad">
                          {getOrderQuantity(pedido)}
                        </MobileOrderField>
                        <MobileOrderField label="Color">
                          <p title={getOrderColor(pedido)} className="truncate">
                            {getOrderColor(pedido)}
                          </p>
                        </MobileOrderField>
                        <MobileOrderField label="Fecha">
                          <p>{orderDate.date}</p>
                          <p className="text-xs font-medium text-white/48">
                            {orderDate.time}
                          </p>
                        </MobileOrderField>
                      </div>

                      <div className="grid min-w-0 gap-4 border-y border-white/7 py-4 sm:grid-cols-3">
                        <MobileOrderField label="Estado">
                          <div className="flex min-w-0">
                            <EstadoBadge estado={pedido.estado} />
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

                    <div className="hidden min-w-0 grid-cols-admin-orders-pro items-center gap-3 2xl:grid">
                  <div className="min-w-0">
                    <div>
                      <p className="text-11px font-black uppercase tracking-wide text-beyonix-sky">
                        #BX-
                      </p>
                      <p className="mt-0.5 text-sm font-black text-white/95">
                        {formatPublicOrderNumber(pedido.id)}
                      </p>
                      {isNewOrder && (
                        <span className="mt-1 inline-flex items-center rounded-full border border-emerald-400/30 bg-emerald-400/10 px-2 py-0.5 text-9px font-black uppercase tracking-widest text-emerald-300">
                          Nuevo
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="min-w-0">
                    <p
                      title={getOrderUsername(pedido)}
                      className="truncate text-sm font-bold leading-5 text-white/92"
                    >
                      {getOrderUsername(pedido)}
                    </p>
                  </div>

                  <ProductsSummary pedido={pedido} />
                  <QuantitySummary pedido={pedido} />
                  <ColorSummary pedido={pedido} />

                  <div title={formatOrderDate(pedido.created_at)} className="text-center">
                    <p className="text-sm font-black leading-5 text-white/95">
                      {orderDate.date}
                    </p>
                    <p className="text-11px font-bold leading-4 text-white/52">
                      {orderDate.time}
                    </p>
                  </div>

                  <div className="text-center">
                    <div className="flex justify-center">
                      <EstadoBadge estado={pedido.estado} />
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
          onClose={() => setPreviewPedido(null)}
          onOpenPaymentProof={handleOpenPaymentProof}
          onEstadoChange={(pedido, nextEstado) =>
            void handleEstadoChange(pedido, nextEstado)
          }
          onAndreaniAction={handleAndreaniAction}
          onIssueInvoice={handleIssueInvoice}
          onDownloadInvoice={handleDownloadInvoice}
          onClaimChange={handleClaimChange}
        />
      )}
      <ForcedStatusConfirmModal
        request={forcedStatusRequest}
        loading={forcedStatusLoading}
        onCancel={() => setForcedStatusRequest(null)}
        onConfirm={() => void confirmForcedStatusChange()}
      />
    </div>
  )
}

