"use client"

import { useCallback, useEffect, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import {
  CreditCard,
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
import { TrackingCopyButton } from "@/components/account/account-order-components"
import {
  formatCuentaPrice,
  formatOrderCardDate,
  formatPublicOrderId,
} from "@/lib/account/account-formatters"
import {
  getClientOrderStatusBadge,
  getCuentaItemImage,
  getPaymentProgressLabel,
  type CustomerOrderDetailView,
} from "@/lib/account/account-utils"
import { resolveOrderTrackingLink } from "@/lib/andreani/public-tracking"
import { supabase } from "@/lib/supabase/client"
import type {
  CustomerOrderSummary,
  CustomerOrderSummaryClaim,
} from "@/lib/supabase/types"

function getLatestCustomerClaim(claims: CustomerOrderSummaryClaim[] = []) {
  return claims
    .filter(
      (claim) =>
        claim.failure_type !== "cancelar_compra" &&
        claim.failure_type !== "consulta_pedido",
    )
    .sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at))[0]
}

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
  const [orders, setOrders] = useState<CustomerOrderSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")

  const loadOrders = useCallback(
    async ({ silent = false }: { silent?: boolean } = {}) => {
      if (!user) {
        setOrders([])
        setLoading(false)
        return
      }

      if (!silent) setLoading(true)
      setError("")

      try {
        const response = await fetch("/api/orders", { cache: "no-store" })
        const data = (await response.json()) as {
          orders?: CustomerOrderSummary[]
          error?: string
        }

        if (!response.ok) {
          setError(data.error || "No se pudieron cargar tus compras.")
          return
        }

        setOrders(data.orders ?? [])
      } catch {
        setError("No se pudieron cargar tus compras.")
      } finally {
        if (!silent) setLoading(false)
      }
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
          filter: `usuario_id=eq.${user.id}`,
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
          {[...orders]
            .sort(
              (first, second) =>
                new Date(second.created_at).getTime() -
                new Date(first.created_at).getTime(),
            )
            .map((order, orderIndex) => {
            const items = order.orden_items ?? []
            const isTransferOrder = order.payment_method_id === "transferencia"
            const paymentMethodLabel =
              order.payment_method_id === "customer_credit"
                ? "Saldo a favor"
                : isTransferOrder
                  ? "Transferencia bancaria"
                  : "Mercado Pago"
            const orderStatusBadge = getClientOrderStatusBadge(order)
            const firstItem = items[0]
            const firstProductImage = firstItem ? getCuentaItemImage(firstItem) : ""
            const firstProductName = firstItem?.productos?.nombre ?? "Productos del pedido"
            const productCount = items.reduce(
              (total, item) => total + Number(item.cantidad ?? 0),
              0,
            )
            const orderTracking = resolveOrderTrackingLink(order)
            const hasTrackingNumber = Boolean(orderTracking.trackingNumber)
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
                  ? "En camino"
                  : "Preparando envío"
            // null => se muestra la línea de seguimiento en vivo (número + copiar)
            // en vez de este texto genérico.
            const shippingDetail: string | null =
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
                : hasTrackingNumber
                  ? null
                  : "Te avisaremos cuando el pedido esté en camino"
            const existingClaim = getLatestCustomerClaim(order.order_claims)

            return (
              <article
                key={order.id}
                className={`relative overflow-visible rounded-[18px] border border-[var(--account-border)] shadow-[0_18px_46px_rgba(0,0,0,0.28),0_0_0_1px_rgba(17,42,67,0.18)] before:absolute before:inset-x-5 before:top-0 before:h-px before:bg-[rgba(119,230,226,0.16)] before:content-[''] ${
                  orderIndex % 2 === 0 ? "bg-[var(--account-surface)]" : "bg-[var(--account-surface-raised)]"
                }`}
              >
                <div className="p-4 sm:p-5">
                  <div className="flex flex-col gap-3 rounded-2xl border border-[var(--account-border-subtle)] bg-[linear-gradient(135deg,rgba(255,255,255,0.045),rgba(17,42,67,0.12))] p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.035)] sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex min-w-0 items-center gap-4">
                      <div className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-white/8 bg-white">
                        {firstProductImage ? (
                          <img src={firstProductImage} alt={firstProductName} className="size-full object-contain" />
                        ) : (
                          <ShoppingBag className="size-7 text-black/30" />
                        )}
                      </div>
                      <div className="min-w-0">
                        <p className="text-base font-black text-[var(--account-text-primary)]">
                          Pedido #{formatPublicOrderId(order.id)}
                        </p>
                        <p className="mt-1 text-sm text-[var(--account-text-secondary)]">
                          {formatOrderCardDate(order.created_at)}
                        </p>
                        <span className={"mt-2 inline-flex w-fit rounded-full border px-2.5 py-1 text-[10px] font-black uppercase tracking-wide " + orderStatusBadge.className}>
                          {orderStatusBadge.label}
                        </span>
                      </div>
                    </div>
                    <div className="shrink-0 rounded-xl border border-[var(--account-success-border)] bg-[var(--account-success-bg)] px-3 py-2.5 text-center shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_10px_24px_rgba(0,0,0,0.18)] sm:w-36">
                      <p className="text-[9px] font-black uppercase tracking-[0.18em] text-[var(--account-success-text)]">Total pagado</p>
                      <p className="mt-1 text-lg font-black leading-none tracking-tight text-[var(--account-success-text)]">{formatCuentaPrice(Number(order.total ?? 0))}</p>
                    </div>
                  </div>

                  <div className="mt-4 grid rounded-2xl border border-[var(--account-border-subtle)] bg-[var(--account-surface-raised)] p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.025)] sm:grid-cols-[1fr_1.3fr_0.9fr]">
                    <div className="flex items-center gap-3 py-2 sm:px-3 sm:py-0 sm:first:pl-0">
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[#112A43]"><CreditCard className="size-5 text-white" /></span>
                      <div><p className="text-[10px] font-black uppercase tracking-widest text-[var(--account-text-secondary)]">Pago</p><p className="mt-1 text-sm font-bold text-[var(--account-text-primary)]">{paymentMethodLabel}</p><p className="mt-0.5 text-xs text-[var(--account-text-secondary)]">{getPaymentProgressLabel(order)}</p></div>
                    </div>
                    <div className="flex items-center gap-3 border-t border-[var(--account-border-subtle)] py-3 sm:border-t-0 sm:border-l sm:px-3 sm:py-0">
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[#112A43]"><Truck className="size-5 text-white" /></span>
                      <div className="min-w-0">
                        <p className="text-[10px] font-black uppercase tracking-widest text-[var(--account-text-secondary)]">Envío</p>
                        <p className="mt-1 text-sm font-bold text-[var(--account-text-primary)]">{shippingLabel}</p>
                        {shippingDetail !== null ? (
                          <p className="mt-0.5 text-xs text-[var(--account-text-secondary)]">{shippingDetail}</p>
                        ) : (
                          <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                            <span className="text-xs text-[var(--account-text-secondary)]">
                              {orderTracking.trackingNumber}
                            </span>
                            {orderTracking.trackingNumber && (
                              <TrackingCopyButton
                                trackingNumber={orderTracking.trackingNumber}
                                className="text-[var(--account-text-secondary)] hover:text-[var(--account-text-primary)]"
                              />
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-3 border-t border-[var(--account-border-subtle)] pt-3 sm:border-t-0 sm:border-l sm:px-3 sm:py-0 sm:last:pr-0">
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[#112A43]"><Package className="size-5 text-white" /></span>
                      <div><p className="text-[10px] font-black uppercase tracking-widest text-[var(--account-text-secondary)]">Productos</p><p className="mt-1 text-sm font-bold text-[var(--account-text-primary)]">{productCount} {productCount === 1 ? "producto" : "productos"}</p></div>
                    </div>
                  </div>

                  <div className="mt-3 flex flex-wrap gap-2">
                    <BeyonixButton type="button" size="sm" onClick={() => router.push(`/cuenta/compras/${order.id}`)}>
                      <FileText className="size-4" />
                      Ver compra
                    </BeyonixButton>
                    {existingClaim && (
                      <BeyonixButton
                        type="button"
                        size="sm"
                        variant="secondary"
                        aria-label={`Ver reclamo del pedido ${formatPublicOrderId(order.id)}`}
                        onClick={() => router.push(`/cuenta/compras/${order.id}/ayuda`)}
                      >
                        <MessageCircle className="size-4" />
                        Ver reclamo
                      </BeyonixButton>
                    )}
                  </div>
                </div>

              </article>
            )
          })}
        </div>
      )}
    </AccountViewFrame>
  )
}
