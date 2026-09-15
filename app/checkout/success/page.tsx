"use client"

import { Suspense, useEffect, useRef, useState } from "react"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { CheckCircle2 } from "lucide-react"

import { TransferFlow } from "@/components/checkout/transfer-flow"
import {
  CheckoutStatusCard,
  CheckoutStatusShell,
} from "@/components/checkout/checkout-status-layout"
import { useCart } from "@/context/cart-context"
import { getGuestOrderToken } from "@/lib/orders/guest-order-token-client"
import type { SupabasePedido } from "@/lib/supabase/types"

const TRANSFER_PAYMENT_WINDOW_MS = 48 * 60 * 60 * 1000
const COUNTDOWN_TICK_MS = 60 * 1000

function isCheckoutPaymentConfirmed(order: SupabasePedido | null) {
  if (!order) return false

  const paymentStatus = (order.payment_status ?? "").toLowerCase()

  return (
    order.estado === "pagado" ||
    paymentStatus === "confirmado" ||
    paymentStatus === "confirmed" ||
    paymentStatus === "approved" ||
    Boolean(order.paid_at) ||
    Number(order.payment_confirmed_amount ?? 0) > 0
  )
}

function CheckoutSuccessContent() {
  const { clearCart } = useCart()
  const hasClearedCartRef = useRef(false)
  const searchParams = useSearchParams()
  const isTransfer = searchParams.get("method") === "transferencia"
  const orderId = Number(searchParams.get("order_id"))
  const [order, setOrder] = useState<SupabasePedido | null>(null)
  const [orderLoading, setOrderLoading] = useState(isTransfer)
  const [orderError, setOrderError] = useState("")
  const [sessionExpired, setSessionExpired] = useState(false)
  const [remainingPaymentMs, setRemainingPaymentMs] = useState<number | null>(
    null,
  )
  const paymentConfirmed = isCheckoutPaymentConfirmed(order)
  const successReturnUrl = `/checkout/success${
    searchParams.toString() ? `?${searchParams.toString()}` : ""
  }`
  const loginHref = `/login?redirect=${encodeURIComponent(successReturnUrl)}`
  const orderStatusHref =
    Number.isFinite(orderId) && orderId > 0
      ? `/cuenta/compras/${orderId}`
      : "/cuenta"
  const isProofPending = Boolean(
    isTransfer &&
      order &&
      order.payment_status === "pendiente_comprobante" &&
      !order.payment_proof_url,
  )
  const deadlineExpired =
    order?.payment_status === "vencido_falta_comprobante" ||
    remainingPaymentMs === 0

  useEffect(() => {
    if (hasClearedCartRef.current) return

    hasClearedCartRef.current = true
    clearCart()
  }, [clearCart])

  useEffect(() => {
    let active = true

    async function loadOrder() {
      if (!isTransfer || !Number.isFinite(orderId) || orderId <= 0) {
        setOrderLoading(false)
        return
      }

      setOrderLoading(true)
      setOrderError("")
      setSessionExpired(false)

      try {
        const guestToken = getGuestOrderToken(orderId)
        const response = await fetch(`/api/payment-proofs/${orderId}`, {
          cache: "no-store",
          headers: guestToken ? { "x-guest-order-token": guestToken } : undefined,
        })
        const data = (await response.json()) as {
          order?: SupabasePedido
          error?: string
        }

        if (response.status === 401) {
          if (active) setSessionExpired(true)
          return
        }

        if (!response.ok || !data.order) {
          throw new Error(data.error || "No se pudo recuperar el pedido.")
        }

        if (active) setOrder(data.order)
      } catch (error) {
        if (active) {
          setOrderError(
            error instanceof Error
              ? error.message
              : "No se pudo recuperar el pedido.",
          )
        }
      } finally {
        if (active) setOrderLoading(false)
      }
    }

    void loadOrder()

    return () => {
      active = false
    }
  }, [isTransfer, orderId])

  useEffect(() => {
    if (!isProofPending || !order?.created_at) {
      setRemainingPaymentMs(null)
      return
    }

    const createdAt = new Date(order.created_at).getTime()
    if (!Number.isFinite(createdAt)) {
      setRemainingPaymentMs(null)
      return
    }

    // El backend expira transferencias a las 48 h desde created_at.
    // Si se agrega payment_deadline al modelo, debe usarse aquí directamente.
    const deadline = createdAt + TRANSFER_PAYMENT_WINDOW_MS
    let intervalId: number | undefined

    const updateRemainingTime = () => {
      const nextValue = Math.max(deadline - Date.now(), 0)
      setRemainingPaymentMs(nextValue)

      if (nextValue === 0 && intervalId !== undefined) {
        window.clearInterval(intervalId)
      }
    }

    updateRemainingTime()

    if (deadline > Date.now()) {
      // Sólo texto discreto en minutos (ver TransferInstructionsStep) -- no
      // necesita granularidad de segundos, así que actualiza una vez por
      // minuto en vez de una vez por segundo.
      intervalId = window.setInterval(updateRemainingTime, COUNTDOWN_TICK_MS)
    }

    return () => {
      if (intervalId !== undefined) {
        window.clearInterval(intervalId)
      }
    }
  }, [isProofPending, order?.created_at])

  useEffect(() => {
    if (!isProofPending) return

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ""
    }

    window.addEventListener("beforeunload", handleBeforeUnload)

    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload)
    }
  }, [isProofPending])

  const handleProofUploaded = async (updatedOrder: SupabasePedido) => {
    setOrder(updatedOrder)
    setOrderError("")

    try {
      const guestToken = getGuestOrderToken(orderId)
      const response = await fetch(`/api/payment-proofs/${orderId}`, {
        cache: "no-store",
        headers: guestToken ? { "x-guest-order-token": guestToken } : undefined,
      })
      const data = (await response.json()) as {
        order?: SupabasePedido
        error?: string
      }

      if (!response.ok || !data.order) {
        throw new Error(data.error || "No se pudo actualizar el pedido.")
      }

      setOrder(data.order)
    } catch (error) {
      setOrderError(
        error instanceof Error
          ? error.message
          : "No se pudo actualizar el pedido.",
      )
    }
  }

  return (
    <CheckoutStatusShell>
      {isTransfer ? (
        <TransferFlow
          orderLoading={orderLoading}
          sessionExpired={sessionExpired}
          orderError={orderError}
          order={order}
          paymentConfirmed={paymentConfirmed}
          remainingMs={remainingPaymentMs}
          deadlineExpired={deadlineExpired}
          onUpdated={(updatedOrder) => void handleProofUploaded(updatedOrder)}
          loginHref={loginHref}
          ordersHref={orderStatusHref}
          homeHref="/"
        />
      ) : (
        <CheckoutStatusCard
          tone="success"
          icon={CheckCircle2}
          eyebrow="Pago recibido"
          title="Estamos preparando tu pedido"
          orderId={orderId}
          compact
          footer={
            <div className="grid gap-2.5 sm:grid-cols-2">
              <Link
                href="/productos"
                aria-label="Ir a productos"
                title="Ir a productos"
                className="flex h-10 w-full cursor-pointer items-center justify-center rounded-lg border border-[var(--account-border)] bg-[var(--account-surface)] text-sm font-semibold text-[var(--account-text-primary)] transition-colors duration-200 hover:bg-[var(--account-surface-hover)]"
              >
                Seguir comprando
              </Link>

              <Link
                href={orderStatusHref}
                aria-label="Ver estado del pedido"
                title="Ver estado del pedido"
                className="flex h-10 w-full cursor-pointer items-center justify-center rounded-lg bg-[var(--account-accent)] text-sm font-semibold text-white shadow-sm transition-colors duration-200 hover:bg-[var(--account-accent-hover)]"
              >
                Ver estado del pedido
              </Link>
            </div>
          }
        >
          <p className="mx-auto max-w-md py-6 text-center text-sm leading-relaxed text-[var(--account-text-secondary)]">
            Pago recibido. Estamos preparando tu pedido.
          </p>
        </CheckoutStatusCard>
      )}
    </CheckoutStatusShell>
  )
}

export default function CheckoutSuccessPage() {
  return (
    <Suspense fallback={null}>
      <CheckoutSuccessContent />
    </Suspense>
  )
}
