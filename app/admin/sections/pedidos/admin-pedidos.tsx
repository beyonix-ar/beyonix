"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import {
  AlertTriangle,
  Bell,
  CheckCircle2,
  CreditCard,
  Download,
  Eye,
  Printer,
  RefreshCw,
  Search,
  ShoppingCart,
  Truck,
  Trash2,
  X,
} from "lucide-react"

import { usePedidos } from "@/hooks/use-pedidos"
import {
  getSupabaseErrorDetails,
  isOrderNewerThanLastSeen,
  markOrdersSeenAndGetPreviousLastSeen,
  notifyOrderNotificationsChanged,
} from "@/lib/admin/order-notifications"
import { supabase } from "@/lib/supabase/client"
import type { SupabasePedido } from "@/lib/supabase/types"
import { AdminSelect, AdminTextInput } from "../../components/admin-controls"
import { formatPrice } from "../productos/helpers"

type StatusFilter = "todos" | "pendiente" | "pagado" | "enviado" | "cancelado"
type AndreaniAction = "crear-envio" | "tracking"
type AdminNotice = { type: "ok" | "error"; message: string } | null

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
    pendiente_comprobante: "Pendiente de comprobante",
    en_revision: "En revisión",
    confirmado: "Confirmado",
    rechazado: "Rechazado",
    approved: "Aprobado",
    pending: "Pendiente",
    rejected: "Rechazado",
  }

  return status ? labels[status] ?? status : "Sin estado"
}

function getTransferPaymentStatusBadge(status?: string | null) {
  const badges: Record<string, { label: string; className: string }> = {
    pendiente_comprobante: {
      label: "Falta comprobante",
      className: "border-amber-400/25 bg-amber-400/10 text-amber-200",
    },
    en_revision: {
      label: "En revisión",
      className: "border-beyonix-blue-light/35 bg-beyonix-blue text-beyonix-sky",
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
      className="inline-flex items-center gap-2 rounded-full border border-beyonix-blue-light/35 bg-black px-3 py-2 text-beyonix-sky"
    >
      <Bell className="size-4" />
      {count > 0 && (
        <span className="flex min-w-5 items-center justify-center rounded-full bg-beyonix-blue px-1.5 text-11px font-black text-white">
          {count}
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
    cancelado: "border-red-500/20 bg-red-500/10 text-red-300",
  }

  return (
    <span
      className={`inline-flex w-fit items-center rounded-full border px-3 py-1 text-11px font-black uppercase tracking-wide ${
        styles[estado] ?? "border-white/10 bg-white/5 text-white/60"
      }`}
    >
      {estado}
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
                    Nombre del comprobante
                  </p>
                  <p
                    title={pedido.payment_proof_file_name || "Sin comprobante"}
                    className="mt-2 break-words text-sm font-black text-white"
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
                <p className="mt-2 break-words text-sm font-black text-white">
                  {pedido.andreani_tracking || pedido.tracking_number || "Pendiente"}
                </p>
              </div>
              <div className="rounded-xl border border-white/7 bg-white/3 p-3">
                <p className="text-10px font-bold uppercase tracking-widest text-white/38">
                  Envío ID
                </p>
                <p className="mt-2 break-words text-sm font-black text-white">
                  {pedido.andreani_envio_id || "Pendiente"}
                </p>
              </div>
              <div className="rounded-xl border border-white/7 bg-white/3 p-3">
                <p className="text-10px font-bold uppercase tracking-widest text-white/38">
                  Etiqueta
                </p>
                <p className="mt-2 break-words text-sm font-black text-white">
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
                  className="mt-2 break-words text-sm font-black text-white"
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
  onClose,
  onOpenPaymentProof,
  onPaymentStatusChange,
}: {
  pedido: SupabasePedido
  onClose: () => void
  onOpenPaymentProof: (pedidoId: number) => void
  onPaymentStatusChange: (pedidoId: number, nextStatus: string) => void
}) {
  const items = pedido.orden_items ?? []
  const dispatch = getDispatchAlert(pedido)
  const tracking = pedido.andreani_tracking || pedido.tracking_number
  const destination =
    [pedido.localidad, pedido.provincia].filter(Boolean).join(", ") ||
    "No informado"

  return (
    <div className="fixed inset-0 z-100 flex items-center justify-center bg-black/82 px-4 py-6 backdrop-blur-sm">
      <div className="flex max-h-80vh w-full max-w-5xl flex-col overflow-hidden rounded-3xl border border-white/10 bg-beyonix-surface shadow-2xl shadow-black/80">
        <header className="flex items-start justify-between gap-4 border-b border-white/8 bg-black px-5 py-4 sm:px-6">
          <div className="min-w-0">
            <p className="text-11px font-bold uppercase tracking-widest text-beyonix-cyan">
              Detalle del pedido
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <h2 className="text-2xl font-black text-white">
                Pedido #{formatPublicOrderId(pedido.id)}
              </h2>
              <EstadoBadge estado={pedido.estado} />
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

        <div className="custom-scrollbar overflow-y-auto px-5 py-5 sm:px-6">
          <div className="grid gap-4 lg:grid-cols-2">
            <section className="rounded-2xl border border-white/8 bg-black p-4">
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
                <DetailValue
                  label="Dirección"
                  value={pedido.cliente_direccion || "No informada"}
                  wide
                />
                <DetailValue label="Localidad" value={pedido.localidad || "No informada"} />
                <DetailValue label="Provincia" value={pedido.provincia || "No informada"} />
              </div>
            </section>

            <section className="rounded-2xl border border-white/8 bg-black p-4">
              <p className="text-11px font-bold uppercase tracking-widest text-beyonix-cyan">
                Pago
              </p>
              <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="text-lg font-black text-white">
                    {getPaymentMethodLabel(pedido)}
                  </h3>
                  <p className="mt-1 text-sm text-white/58">
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
                  <div>
                    <p className="mb-2 text-10px font-bold uppercase tracking-widest text-white/38">
                      Estado administrativo
                    </p>
                    <AdminSelect
                      title="Estado de pago"
                      compact
                      value={pedido.payment_status || "pendiente_comprobante"}
                      onChange={(value) => onPaymentStatusChange(pedido.id, value)}
                    >
                      <option value="pendiente_comprobante">Pendiente comprobante</option>
                      <option value="en_revision">En revisión</option>
                      <option value="confirmado">Confirmado</option>
                      <option value="rechazado">Rechazado</option>
                    </AdminSelect>
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/8 bg-white/3 p-3">
                    <DetailValue
                      label="Comprobante"
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

          <section className="mt-4 rounded-2xl border border-white/8 bg-black p-4">
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
                      className="grid gap-3 rounded-xl border border-white/8 bg-white/3 p-3 sm:grid-cols-admin-order-modal-item sm:items-center"
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
                <p className="rounded-xl border border-white/8 bg-white/3 p-4 text-sm text-white/55">
                  Este pedido no tiene productos cargados.
                </p>
              )}
            </div>
          </section>

          <section className="mt-4 rounded-2xl border border-white/8 bg-black p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-11px font-bold uppercase tracking-widest text-beyonix-cyan">
                  Envío
                </p>
                <h3 className="mt-2 flex items-center gap-2 text-lg font-black text-white">
                  <Truck className="size-5 text-beyonix-sky" />
                  {pedido.shipping_type === "sucursal"
                    ? "Retiro en sucursal"
                    : "Envío a domicilio"}
                </h3>
              </div>
              <span
                title={dispatch.label}
                className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-11px font-black uppercase tracking-wide ${dispatch.className}`}
              >
                <AlertTriangle className="size-3.5" />
                {dispatch.label}
              </span>
            </div>

            <div className="mt-4 grid gap-3 border-t border-white/8 pt-4 sm:grid-cols-2 lg:grid-cols-4">
              <DetailValue label="Proveedor" value={getShippingProvider(pedido)} />
              <DetailValue label="Estado" value={getAndreaniStatus(pedido)} />
              <DetailValue label="Seguimiento" value={tracking || "Pendiente"} />
              <DetailValue label="Destino" value={destination} />
            </div>

            {(pedido.tracking_url || pedido.andreani_etiqueta_url) && (
              <div className="mt-4 flex flex-wrap gap-2">
                {pedido.tracking_url && (
                  <ExternalLink
                    href={pedido.tracking_url}
                    label="Ver seguimiento"
                    ariaLabel={`Abrir seguimiento del pedido ${pedido.id}`}
                  />
                )}
                {pedido.andreani_etiqueta_url && (
                  <ExternalLink
                    href={pedido.andreani_etiqueta_url}
                    label="Ver etiqueta"
                    ariaLabel={`Abrir etiqueta del pedido ${pedido.id}`}
                  />
                )}
              </div>
            )}
          </section>
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
      <p className="mt-1 break-words text-sm font-bold text-white/82">{value}</p>
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

export function AdminPedidos() {
  const { pedidos, loading, error, deletePedido, updatePedidoEstado, reloadPedidos } =
    usePedidos()
  const [search, setSearch] = useState("")
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("todos")
  const [previewPedido, setPreviewPedido] = useState<SupabasePedido | null>(null)
  const [newOrderIds, setNewOrderIds] = useState<Set<number>>(() => new Set())
  const [notice, setNotice] = useState<AdminNotice>(null)
  const hasMarkedOrderViews = useRef(false)

  useEffect(() => {
    if (!notice) return

    const timeout = window.setTimeout(() => setNotice(null), 4000)
    return () => window.clearTimeout(timeout)
  }, [notice])

  useEffect(() => {
    if (loading) return
    if (hasMarkedOrderViews.current) return

    hasMarkedOrderViews.current = true

    let active = true

    async function markCurrentOrdersAsSeen() {
      try {
        const previousLastSeenAt = await markOrdersSeenAndGetPreviousLastSeen()

        if (!active || !previousLastSeenAt) return

        setNewOrderIds(
          new Set(
            pedidos
              .filter((pedido) =>
                isOrderNewerThanLastSeen(pedido.created_at, previousLastSeenAt)
              )
              .map((pedido) => pedido.id)
          )
        )
      } catch (error) {
        console.error(
          "ADMIN_ORDER_VIEW_MARK_ERROR",
          getSupabaseErrorDetails(error)
        )
      }
    }

    void markCurrentOrdersAsSeen()

    return () => {
      active = false
    }
  }, [loading, pedidos])

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

    if (estadoActual === nextEstado) return

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

    if (nextEstado === "enviado") {
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
      }
      return
    }

    const updated = await updatePedidoEstado(pedidoId, nextEstado)
    if (updated) {
      setNotice({ type: "ok", message: "Estado del pedido actualizado." })
      notifyOrderNotificationsChanged()
    }
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

  return (
    <div className="space-y-6 p-4 sm:p-6 lg:p-8">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <p className="mb-1 text-11px font-bold uppercase tracking-widest text-beyonix-cyan">
            Pedidos
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-3xl font-black text-white/95">Gestión de pedidos</h1>
            <OrderNotificationBell count={0} />
          </div>
          <p className="mt-2 text-sm text-white/68">
            Seguimiento de pago, productos, envío y prioridad de despacho.
          </p>
        </div>

        <div className="grid w-full gap-3 sm:grid-cols-admin-order-filters xl:max-w-2xl">
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
            <option value="cancelado">Cancelados</option>
          </AdminSelect>
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
        <div className="w-full min-w-0 space-y-3 overflow-visible">
            <div className="grid grid-cols-admin-orders-pro gap-3 rounded-2xl border border-white/8 bg-black px-4 py-3.5">
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
                    className={`min-w-0 rounded-2xl border px-4 py-4 transition ${
                      isNewOrder
                        ? "border-emerald-400/30 bg-emerald-500/6 shadow-lg shadow-emerald-500/5 hover:bg-emerald-500/10"
                        : "border-white/8 bg-black hover:border-beyonix-blue-light/45"
                    }`}
                  >
                    <div className="grid min-w-0 grid-cols-admin-orders-pro items-center gap-3">
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
                    <div className="mx-auto w-admin-order-status">
                      <AdminSelect
                        title="Estado del pedido"
                        compact
                        value={pedido.estado}
                        onChange={(value) =>
                          handleEstadoChange(pedido, value)
                        }
                      >
                        <option value="pendiente">Pendiente</option>
                        <option value="pagado">Pagado</option>
                        <option value="enviado">Enviado</option>
                        <option value="cancelado">Cancelado</option>
                      </AdminSelect>
                    </div>
                  </div>

                  <div className="text-center">
                    <p className="truncate text-11px font-black uppercase tracking-wide text-beyonix-sky">
                      {getShippingProvider(pedido)}
                    </p>
                    <span
                      title={dispatch.label}
                      className={`mt-1.5 inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-10px font-black uppercase tracking-wide ${dispatch.className}`}
                    >
                      <AlertTriangle className="size-3" />
                      {dispatch.label}
                    </span>
                  </div>

                  <div className="min-w-0 space-y-1 text-center">
                    {pedido.payment_method_id === "transferencia" ? (
                      <span
                        title={`${getPaymentStatusLabel(pedido.payment_status)} · ${
                          pedido.payment_proof_url ? "Con comprobante" : "Sin comprobante"
                        }`}
                        className="inline-flex max-w-full items-center rounded-full border border-beyonix-blue-light/35 bg-black px-2.5 py-1 text-10px font-black uppercase tracking-wide text-beyonix-sky"
                      >
                        <span className="truncate">
                          {getPaymentStatusLabel(pedido.payment_status)}
                        </span>
                      </span>
                    ) : (
                      <span className="inline-flex max-w-full items-center rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-10px font-black uppercase tracking-wide text-white/58">
                        <span className="truncate">
                          {getPaymentStatusLabel(pedido.payment_status)}
                        </span>
                      </span>
                    )}
                    <p className="truncate text-11px font-bold text-white/68">
                      {paymentMethod}
                    </p>
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
                      onClick={() => setPreviewPedido(pedido)}
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
          onClose={() => setPreviewPedido(null)}
          onOpenPaymentProof={handleOpenPaymentProof}
          onPaymentStatusChange={handlePaymentStatusChange}
        />
      )}
    </div>
  )
}
