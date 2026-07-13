"use client"

import { useCallback, useEffect, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import {
  CreditCard,
  Download,
  FileText,
  MessageCircle,
  Package,
  ShoppingBag,
  Truck,
} from "lucide-react"

import { useAuth } from "@/context/auth-context"
import {
  AccountCard,
  AccountEmptyState,
  BeyonixButton,
} from "@/components/account/account-ui"
import { AccountViewFrame } from "@/components/account/account-view-frame"
import {
  CustomerInvoiceBell,
  DOWNLOADED_INVOICES_STORAGE_KEY,
  OrderProductFeedback,
  OrderProgressTimeline,
  OrderTrackingPanel,
  PaymentProofViewButton,
} from "@/components/account/account-order-components"
import { PaymentProofActionButton } from "@/components/payment-proof-uploader"
import { CustomerClaimExperience } from "@/components/claims/customer-claim-experience"
import type { ClaimProblemId } from "@/components/claims/customer-claim-experience"
import { supabase } from "@/lib/supabase/client"
import {
  formatCuentaInvoiceNumber,
  formatCuentaPrice,
  formatOrderCardDate,
  formatPublicOrderId,
} from "@/lib/account/account-formatters"
import {
  getClientOrderStatusBadge,
  getCuentaItemColor,
  getCuentaItemImage,
  getPaymentProgressLabel,
  isAndreaniOrderInTransit,
  isInvoiceAvailable,
  normalizeTrackingUrl,
  type CustomerOrderDetailView,
} from "@/lib/account/account-utils"
import type { SupabasePedido } from "@/lib/supabase/types"

export function MisOrdenes({ onBack }: { onBack: () => void }) {
  const { user } = useAuth()
  const router = useRouter()
  const searchParams = useSearchParams()
  const requestedOrderId = Number(searchParams.get("order"))
  const requestedOrderView = searchParams.get("tab")
  const initialOrderView: CustomerOrderDetailView =
    requestedOrderView === "factura" || requestedOrderView === "reclamo"
      ? requestedOrderView
      : "detalle"
  const hasRequestedOrder = Number.isInteger(requestedOrderId) && requestedOrderId > 0
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
    () => new Set(hasRequestedOrder ? [requestedOrderId] : []),
  )
  const [orderDetailViews, setOrderDetailViews] = useState<
    Record<number, CustomerOrderDetailView>
  >(() => hasRequestedOrder ? { [requestedOrderId]: initialOrderView } : {})
  const [claimProblemByOrder, setClaimProblemByOrder] = useState<Record<number, ClaimProblemId | undefined>>({})

  const loadOrders = useCallback(
    async ({ silent = false }: { silent?: boolean } = {}) => {
      if (!user) {
        setOrders([])
        setLoading(false)
        return
      }

      if (!silent) setLoading(true)
      setError("")

      await fetch("/api/orders/transfer-expirations", {
        method: "POST",
      }).catch(() => null)

      const { data, error: ordersError } = await supabase
        .from("ordenes")
        .select("*, orden_items(id, orden_id, producto_id, variante_id, cantidad, precio, productos(*), producto_variantes(*))")
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
    if (!hasRequestedOrder) return

    const section = initialOrderView === "reclamo" ? "?section=reclamo" : ""
    router.replace(`/cuenta/compras/${requestedOrderId}${section}`)
  }, [hasRequestedOrder, initialOrderView, requestedOrderId, router])

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
          : order,
      ),
    )
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

    const nextParams = new URLSearchParams(searchParams.toString())
    nextParams.set("tab", view)
    nextParams.set("order", String(orderId))
    router.replace(`/cuenta?${nextParams.toString()}`, { scroll: false })
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
      description="Revisá el estado de tus pedidos, facturas y comprobantes."
      className="max-w-[1160px]"
    >
      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 2 }).map((_, index) => (
            <AccountCard
              key={index}
              className="h-132px animate-pulse"
            />
          ))}
        </div>
      ) : error ? (
        <AccountCard padding="sm" className="border-[var(--account-danger-border)] bg-[var(--account-danger-bg)] text-sm text-[var(--account-danger-text)]">
          {error}
        </AccountCard>
      ) : orders.length === 0 ? (
        <AccountEmptyState
          icon={<ShoppingBag />}
          title="Todavía no realizaste ninguna compra."
          description="Cuando hagas un pedido, vas a poder consultar acá su estado, factura y seguimiento."
        />
      ) : (
        <div className="space-y-8 sm:space-y-10">
          {invoiceError && (
            <AccountCard padding="sm" className="border-[var(--account-danger-border)] bg-[var(--account-danger-bg)] text-sm text-[var(--account-danger-text)]">
              {invoiceError}
            </AccountCard>
          )}
          {[...orders]
            .sort(
              (first, second) =>
                new Date(second.created_at).getTime() -
                new Date(first.created_at).getTime(),
            )
            .map((order, orderIndex) => {
            const items = order.orden_items ?? []
            const hasProof = Boolean(order.payment_proof_url)
            const isTransferOrder = order.payment_method_id === "transferencia"
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
              order.financial_status === "refunded"
                ? "Dinero reintegrado"
                : order.financial_status === "refund_pending"
                  ? "Reintegro pendiente"
              : order.estado === "cancelado"
                ? "Pedido cancelado"
                : order.payment_status === "rechazado"
                  ? "Comprobante rechazado"
                  : order.estado === "entregado"
                ? "Entregado"
                : order.estado === "en_camino" || order.estado === "enviado"
                  ? "Enviado"
                  : "Preparando envío"
            const shippingDetail =
              order.financial_status === "refunded"
                ? "Cancelado - dinero reintegrado"
                : order.financial_status === "refund_pending"
                  ? "BEYONIX está gestionando la devolución"
              : order.estado === "cancelado"
                ? "La compra fue cancelada correctamente"
                : order.payment_status === "rechazado"
                  ? "Podés subir un nuevo comprobante"
                  : order.estado === "entregado" && order.delivered_at
                ? formatOrderCardDate(order.delivered_at).split(" · ")[0]
                : trackingUrl || order.andreani_tracking || order.tracking_number
                  ? "Andreani · Seguimiento disponible"
                  : "Te avisaremos cuando sea enviado"
            const orderPaymentConfirmed =
              order.estado === "pagado" ||
              order.payment_status === "confirmado" ||
              order.payment_status === "approved"
            const orderDispatched =
              order.estado === "enviado" ||
              order.estado === "en_camino" ||
              order.estado === "entregado" ||
              Boolean(order.tracking_number || order.andreani_tracking || order.andreani_envio_id) ||
              isAndreaniOrderInTransit(order)
            const canOpenClaim = order.estado === "entregado" || (orderPaymentConfirmed && !orderDispatched)

            return (
              <article
                key={order.id}
                className={`relative overflow-visible rounded-[18px] border border-white/10 shadow-[0_18px_46px_rgba(0,0,0,0.28),0_0_0_1px_rgba(17,42,67,0.18)] before:absolute before:inset-x-5 before:top-0 before:h-px before:bg-[rgba(119,230,226,0.16)] before:content-[''] ${
                  orderIndex % 2 === 0 ? "bg-[#0D1117]" : "bg-[#10151B]"
                }`}
              >
                <div className="p-4 sm:p-5">
                  <div className="flex flex-col gap-3 rounded-2xl border border-white/7 bg-[linear-gradient(135deg,rgba(255,255,255,0.045),rgba(17,42,67,0.12))] p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.035)] sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex min-w-0 items-center gap-4">
                      <div className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-white/8 bg-white">
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
                    <div className="shrink-0 rounded-xl border border-emerald-300/20 bg-[#0E2B24] px-3 py-2.5 text-center shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_10px_24px_rgba(0,0,0,0.18)] sm:w-36">
                      <p className="text-[9px] font-black uppercase tracking-[0.18em] text-emerald-200/80">Total pagado</p>
                      <p className="mt-1 text-lg font-black leading-none tracking-tight text-emerald-50">{formatCuentaPrice(Number(order.total ?? 0))}</p>
                    </div>
                  </div>

                  <div className="mt-4 grid rounded-2xl border border-white/8 bg-[#090D12]/70 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.025)] sm:grid-cols-3 sm:divide-x sm:divide-white/12">
                    <div className="flex items-center gap-3 py-2 sm:px-3 sm:py-0 sm:first:pl-0">
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[#112A43]"><CreditCard className="size-5 text-white" /></span>
                      <div><p className="text-[10px] font-black uppercase tracking-widest text-[#A0A0A0]">Pago</p><p className="mt-1 text-sm font-bold text-white">{isTransferOrder ? "Transferencia bancaria" : "Mercado Pago"}</p><p className="mt-0.5 text-xs text-[#A0A0A0]">{getPaymentProgressLabel(order)}</p></div>
                    </div>
                    <div className="flex items-center gap-3 border-t border-white/8 py-3 sm:border-0 sm:px-3 sm:py-0">
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[#112A43]"><Truck className="size-5 text-white" /></span>
                      <div><p className="text-[10px] font-black uppercase tracking-widest text-[#A0A0A0]">Envío</p><p className="mt-1 text-sm font-bold text-white">{shippingLabel}</p><p className="mt-0.5 text-xs text-[#A0A0A0]">{shippingDetail}</p></div>
                    </div>
                    <div className="flex items-center gap-3 border-t border-white/8 pt-3 sm:border-0 sm:px-3 sm:py-0 sm:last:pr-0">
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[#112A43]"><Package className="size-5 text-white" /></span>
                      <div><p className="text-[10px] font-black uppercase tracking-widest text-[#A0A0A0]">Productos</p><p className="mt-1 text-sm font-bold text-white">{productCount} {productCount === 1 ? "producto" : "productos"}</p></div>
                    </div>
                  </div>

                  <div className="mt-3 flex flex-wrap gap-2">
                    <BeyonixButton type="button" size="sm" onClick={() => router.push(`/cuenta/compras/${order.id}`)}>
                      <FileText className="size-4" />
                      Ver compra
                    </BeyonixButton>
                  </div>
                </div>

                {false && (
                  <div className="customer-order-detail border-t border-white/7 px-3 py-3 sm:px-4">
                    <div className="mb-3 flex flex-wrap gap-2 rounded-xl border border-white/8 bg-black/25 p-2.5">
                      <button type="button" onClick={() => showOrderDetailView(order.id, "detalle")} className={`inline-flex h-9 cursor-pointer items-center gap-2 rounded-lg border px-3 text-xs font-black text-white transition-colors ${activeOrderView === "detalle" ? "border-beyonix-blue-light/45 bg-[#112A43]" : "border-white/12 bg-[#181818] hover:border-blue-300/30"}`}><FileText className="size-4" />Estado y productos</button>
                      {invoiceAvailable && <button type="button" onClick={() => showOrderDetailView(order.id, "factura")} className={`relative inline-flex h-9 cursor-pointer items-center gap-2 rounded-lg border px-3 text-xs font-black text-white transition-colors ${activeOrderView === "factura" ? "border-beyonix-blue-light/45 bg-[#112A43]" : "border-white/12 bg-[#181818] hover:border-blue-300/30"}`}><Download className="size-4" />Ver factura{showInvoiceNotification && <span className="absolute -right-1.5 -top-1.5"><CustomerInvoiceBell /></span>}</button>}
                      {isTransferOrder && (hasProof ? <PaymentProofViewButton order={order} /> : <PaymentProofActionButton orderId={order.id} onUploaded={handlePaymentProofUploaded} className="inline-flex h-9 cursor-pointer items-center justify-center gap-2 rounded-lg border border-white/12 bg-[#181818] px-3 text-xs font-black text-white transition-colors hover:border-blue-300/30 hover:bg-[#112A43] disabled:opacity-60" />)}
                      {canOpenClaim && <button type="button" aria-expanded={activeOrderView === "reclamo"} onClick={() => showClaimView(order.id)} className={`inline-flex h-9 cursor-pointer items-center gap-2 rounded-lg border px-3 text-xs font-black text-white transition-colors ${activeOrderView === "reclamo" ? "border-beyonix-blue-light/45 bg-[#112A43]" : "border-white/12 bg-[#181818] hover:border-blue-300/30"}`}><MessageCircle className="size-4" />Necesito ayuda</button>}
                    </div>
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

                    {activeOrderView === "reclamo" && canOpenClaim && (
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

                    <div className="space-y-2">
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
                            className="grid gap-3 rounded-xl border border-white/6 bg-black/35 p-2.5 sm:grid-cols-account-order-item sm:items-center"
                          >
                            <div className="flex items-center gap-3">
                              <div className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-white/8 bg-white">
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
                    {order.estado === "entregado" && <div className="mt-3"><OrderProductFeedback order={order} /></div>}
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
