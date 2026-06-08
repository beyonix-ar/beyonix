"use client"

import { useMemo, useState } from "react"
import {
  AlertTriangle,
  Bell,
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
  getOrderNotificationCount,
  notifyOrderNotificationsChanged,
} from "@/lib/admin/order-notifications"
import { supabase } from "@/lib/supabase/client"
import type { SupabasePedido } from "@/lib/supabase/types"
import { AdminSelect, AdminTextInput } from "../../components/admin-controls"
import { formatPrice } from "../productos/helpers"

type StatusFilter = "todos" | "pendiente" | "pagado" | "enviado" | "cancelado"
type AndreaniAction = "crear-envio" | "tracking"

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
  return pedido.andreani_estado || "Sin envÃƒÂ­o generado"
}

function getPaymentMethodLabel(pedido: SupabasePedido) {
  if (pedido.payment_method_id === "transferencia") {
    return "Transferencia bancaria"
  }

  return pedido.payment_method_id || pedido.payment_type_id || "Metodo no informado"
}

function getPaymentStatusLabel(status?: string | null) {
  const labels: Record<string, string> = {
    pendiente_comprobante: "Pendiente de comprobante",
    en_revision: "En revision",
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
      label: "En revisiÃƒÂ³n",
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
          ? `${count} pedidos requieren atenciÃƒÂ³n`
          : "Sin pedidos pendientes de atenciÃƒÂ³n"
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

  alert(data.message || data.error || "Andreani todavÃƒÂ­a no estÃƒÂ¡ configurado")
}

function handlePrintAndreaniLabel(pedido: SupabasePedido) {
  if (!pedido.andreani_etiqueta_url) {
    alert("Andreani todavÃƒÂ­a no estÃƒÂ¡ configurado.")
    return
  }

  window.open(pedido.andreani_etiqueta_url, "_blank", "noopener,noreferrer")
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
      label: "AtenciÃƒÂ³n",
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

  return (
    <div className="space-y-1">
      {items.slice(0, 3).map((item) => {
        const text = item.productos?.nombre ?? `Producto #${item.producto_id}`

        return (
          <p key={item.id} title={text} className="text-sm font-black leading-5 text-white/95">
            {text}
          </p>
        )
      })}
      {items.length > 3 && (
        <p className="text-11px text-white/48">+{items.length - 3} productos</p>
      )}
    </div>
  )
}

function QuantitySummary({ pedido }: { pedido: SupabasePedido }) {
  const items = pedido.orden_items ?? []

  if (!items.length) {
    return <span className="text-xs text-white/55">-</span>
  }

  return (
    <div className="space-y-1 text-center">
      {items.slice(0, 3).map((item) => (
        <p key={item.id} title={`Cantidad ${item.cantidad}`} className="text-sm font-black text-white/95">
          {item.cantidad}
        </p>
      ))}
      {items.length > 3 && (
        <p className="text-11px text-white/48">+{items.length - 3}</p>
      )}
    </div>
  )
}

function ColorSummary({ pedido }: { pedido: SupabasePedido }) {
  const items = pedido.orden_items ?? []

  if (!items.length) {
    return <span className="text-xs text-white/55">-</span>
  }

  return (
    <div className="space-y-1 text-center">
      {items.slice(0, 3).map((item) => {
        const color = getItemColor(item)

        return (
          <p key={item.id} title={color} className="text-sm font-black leading-5 text-white/95">
            {color}
          </p>
        )
      })}
      {items.length > 3 && (
        <p className="text-11px text-white/48">+{items.length - 3}</p>
      )}
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
                <p>{pedido.cliente_telefono || "TelÃƒÂ©fono no informado"}</p>
                <p>{pedido.cliente_direccion || "DirecciÃƒÂ³n no informada"}</p>
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
                  MÃƒÂ©todo:{" "}
                  {pedido.payment_method_id ||
                    pedido.payment_type_id ||
                    "MÃƒÂ©todo no informado"}
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
                    <option value="en_revision">En revisiÃƒÂ³n</option>
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
                  EnvÃƒÂ­o
                </p>
                <h3 className="mt-2 flex items-center gap-2 text-xl font-black text-white">
                  <Truck className="size-5 text-beyonix-sky" />
                  Proveedor: {getShippingProvider(pedido)}
                </h3>
                <p className="mt-2 text-sm text-white/55">
                  IntegraciÃƒÂ³n preparada para Andreani. Las credenciales reales
                  quedan reservadas para el backend.
                </p>
              </div>

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  title="Generar envÃƒÂ­o Andreani"
                  aria-label={`Generar envÃƒÂ­o Andreani para pedido ${pedido.id}`}
                  onClick={() => runAndreaniAction("crear-envio", pedido.id)}
                  className="inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-xl border border-beyonix-blue-light/30 bg-beyonix-blue px-3 text-11px font-black uppercase tracking-wide text-beyonix-sky transition-colors hover:border-beyonix-blue-light hover:bg-beyonix-blue-hover"
                >
                  <Truck className="size-4" />
                  Generar envÃƒÂ­o Andreani
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
                  Estado de envÃƒÂ­o
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
                  EnvÃƒÂ­o ID
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
                      {formatOrderDate(currentPedido.created_at)} Ã‚Â· Estado:{" "}
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

export function AdminPedidos() {
  const { pedidos, loading, error, deletePedido, updatePedidoEstado, reloadPedidos } =
    usePedidos()
  const [search, setSearch] = useState("")
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("todos")
  const [previewPedido, setPreviewPedido] = useState<SupabasePedido | null>(null)
  const notificationCount = useMemo(
    () => getOrderNotificationCount(pedidos),
    [pedidos]
  )

  const pedidosFiltrados = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase()

    return pedidos.filter((pedido) => {
      const matchesSearch = [
        String(pedido.id),
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
    const ok = confirm("Ã‚Â¿Eliminar pedido?")
    if (!ok) return
    const deleted = await deletePedido(id)
    if (deleted) notifyOrderNotificationsChanged()
  }

  const handleEstadoChange = async (
    pedidoId: number,
    estadoActual: string,
    nextEstado: string
  ) => {
    if (estadoActual === nextEstado) return

    if (nextEstado === "pagado" && estadoActual !== "pagado") {
      alert("El estado pagado se actualiza automÃƒÂ¡ticamente desde Mercado Pago.")
      return
    }

    if (nextEstado === "enviado") {
      const trackingNumber =
        prompt("NÃƒÂºmero de seguimiento (opcional)")?.trim() || null
      const trackingUrl = prompt("Link de seguimiento (opcional)")?.trim() || null

      const updated = await updatePedidoEstado(pedidoId, nextEstado, {
        tracking_number: trackingNumber,
        tracking_url: trackingUrl,
      })
      if (updated) notifyOrderNotificationsChanged()
      return
    }

    const updated = await updatePedidoEstado(pedidoId, nextEstado)
    if (updated) notifyOrderNotificationsChanged()
  }

  const handlePaymentStatusChange = async (
    pedidoId: number,
    nextStatus: string
  ) => {
    const {
      data: { session },
    } = await supabase.auth.getSession()

    if (!session?.access_token) {
      alert("No autorizado.")
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
      alert(data.error || "No se pudo actualizar el estado de pago.")
      return
    }

    if (data.order) {
      setPreviewPedido((currentPedido) =>
        currentPedido?.id === pedidoId
          ? {
              ...currentPedido,
              payment_status: data.order.payment_status,
            }
          : currentPedido
      )
    }

    await reloadPedidos()
    notifyOrderNotificationsChanged()
  }

  const handleOpenPaymentProof = async (pedidoId: number) => {
    const {
      data: { session },
    } = await supabase.auth.getSession()

    if (!session?.access_token) {
      alert("No autorizado.")
      return
    }

    const response = await fetch(`/api/admin/payment-proofs/${pedidoId}`, {
      headers: {
        Authorization: `Bearer ${session.access_token}`,
      },
    })
    const data = await response.json()

    if (!response.ok || !data.signedUrl) {
      alert(data.error || "No se pudo abrir el comprobante.")
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
            <OrderNotificationBell count={notificationCount} />
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
        <div className="space-y-3">
          <div>
            <div className="space-y-3">
              <div className="hidden grid-cols-admin-orders-pro gap-4 rounded-2xl border border-white/8 bg-black px-5 py-3 xl:grid">
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
                    className={`text-xs font-bold uppercase tracking-widest text-white/55 ${
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
                const paymentMethod =
                  pedido.payment_method_id || pedido.payment_type_id || "MÃƒÂ©todo no informado"
                const orderDate = formatOrderDateParts(pedido.created_at)
                const trackingText =
                  pedido.andreani_tracking ||
                  pedido.tracking_number ||
                  "Seguimiento pendiente"

                return (
                  <article
                    key={pedido.id}
                    className="rounded-3xl border border-white/8 bg-black px-5 py-4 transition hover:border-beyonix-blue-light/45"
                  >
                    <div className="grid gap-4 xl:grid-cols-admin-orders-pro xl:items-center">
                  <div>
                    <p className="text-sm font-black text-white/95">#{formatPublicOrderId(pedido.id)}</p>
                    <p
                      title={pedido.payment_id ? `Pago ${pedido.payment_id}` : "Sin ID pago"}
                      className="mt-1 break-words text-11px leading-4 text-white/55"
                    >
                      {pedido.payment_id ? `Pago ${pedido.payment_id}` : "Sin ID pago"}
                    </p>
                  </div>

                  <div className="min-w-0">
                    <p
                      title={pedido.cliente_nombre || "Cliente sin nombre"}
                      className="text-sm font-bold leading-5 text-white/92"
                    >
                      {pedido.cliente_nombre || "Cliente sin nombre"}
                    </p>
                    <p
                      title={pedido.cliente_email || pedido.cliente_telefono || "-"}
                      className="mt-1 break-words text-xs leading-5 text-white/58"
                    >
                      {pedido.cliente_email || pedido.cliente_telefono || "-"}
                    </p>
                    {pedido.cliente_direccion && (
                      <p
                        title={pedido.cliente_direccion}
                        className="mt-1 break-words text-11px leading-4 text-white/48"
                      >
                        {pedido.cliente_direccion}
                      </p>
                    )}
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
                        value={pedido.estado}
                        onChange={(value) =>
                          handleEstadoChange(pedido.id, pedido.estado, value)
                        }
                      >
                        <option value="pendiente">Pendiente</option>
                        <option value="pagado">Pagado</option>
                        <option value="enviado">Enviado</option>
                        <option value="cancelado">Cancelado</option>
                      </AdminSelect>
                    </div>
                    <div className="mt-2 flex justify-center">
                      <EstadoBadge estado={pedido.estado} />
                    </div>
                  </div>

                  <div className="text-center">
                    <p className="mb-2 text-11px font-black uppercase tracking-wide text-beyonix-sky">
                      {getShippingProvider(pedido)}
                    </p>
                    <span
                      title={dispatch.label}
                      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-11px font-black uppercase tracking-wide ${dispatch.className}`}
                    >
                      <AlertTriangle className="size-3.5" />
                      {dispatch.label}
                    </span>
                    <p title={trackingText} className="mt-2 break-words text-11px leading-4 text-white/58">
                      {trackingText}
                    </p>
                    {pedido.tracking_url && (
                      <a
                        href={pedido.tracking_url}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-1 block text-11px font-bold text-beyonix-sky underline underline-offset-4"
                      >
                        Ver seguimiento
                      </a>
                    )}
                  </div>

                  <div className="text-center">
                    {pedido.payment_method_id === "transferencia" ? (
                      <TransferPaymentBadges pedido={pedido} />
                    ) : (
                      <span className="inline-flex w-fit items-center rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-10px font-black uppercase tracking-wide text-white/58">
                        {getPaymentStatusLabel(pedido.payment_status)}
                      </span>
                    )}
                  </div>

                  <div className="text-center">
                    <p className="text-sm font-black text-white/95">
                      {formatPrice(pedido.total)}
                    </p>
                    <p title={paymentMethod} className="mt-1 break-words text-11px leading-4 text-white/58">
                      {paymentMethod.toLowerCase()}
                    </p>
                  </div>

                  <div className="flex items-center justify-center gap-2">
                    <button
                      type="button"
                      aria-label={`Ver pedido ${pedido.id}`}
                      title="Ver pedido"
                      onClick={() => setPreviewPedido(pedido)}
                      className="inline-flex h-9 cursor-pointer items-center justify-center gap-1.5 rounded-xl border border-white/8 px-3 text-11px font-black uppercase tracking-wide text-white/68 transition-colors hover:border-beyonix-blue-light/35 hover:text-beyonix-sky"
                    >
                      <Eye className="size-3.5" />
                      Ver pedido
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
                  </article>
                )
              })}
            </div>
          </div>
        </div>
      )}
      {previewPedido && (
        <PedidoPreviewModal
          pedido={previewPedido}
          pedidos={pedidos}
          onClose={() => setPreviewPedido(null)}
          onOpenPaymentProof={handleOpenPaymentProof}
          onPaymentStatusChange={handlePaymentStatusChange}
        />
      )}
    </div>
  )
}
