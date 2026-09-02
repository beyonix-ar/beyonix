"use client"

import { Suspense, useEffect, useRef, useState } from "react"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  CloudUpload,
  Copy,
  CreditCard,
  Clock3,
  LogIn,
  Truck,
  type LucideIcon,
} from "lucide-react"

import { CustomerPaymentProof } from "@/components/customer-payment-proof"
import {
  BeyonixButton,
} from "@/components/beyonix-ui"
import {
  CheckoutStatusCard,
  CheckoutStatusNotice,
  CheckoutStatusPanel,
  CheckoutStatusShell,
} from "@/components/checkout/checkout-status-layout"
import { useCart } from "@/context/cart-context"
import {
  TRANSFER_ACCOUNT_HOLDER,
  TRANSFER_ALIAS,
  TRANSFER_CVU,
} from "@/lib/payments/transfer"
import { BEYONIX_SUPPORT_HOURS_DETAIL } from "@/lib/legal-contact"
import { getGuestOrderToken } from "@/lib/orders/guest-order-token-client"
import type { SupabasePedido } from "@/lib/supabase/types"

const formatPrice = (price: number) =>
  new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    minimumFractionDigits: 0,
  }).format(Number.isFinite(price) ? price : 0)

const formatPriceNumber = (price: number) =>
  new Intl.NumberFormat("es-AR", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(Number.isFinite(price) ? price : 0)

const TRANSFER_PAYMENT_WINDOW_MS = 48 * 60 * 60 * 1000

type StepState = "completed" | "active" | "pending"

interface OrderStep {
  label: string
  icon: LucideIcon
  state: StepState
}

const SHIPPING_STARTED_STATES = new Set([
  "preparando",
  "despachado",
  "enviado",
  "en_camino",
  "en_sucursal",
  "entregado",
])

function formatOrderDate(value?: string | null) {
  if (!value) return "-"

  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return "-"

  return new Intl.DateTimeFormat("es-AR", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date)
}

function formatCountdown(value: number | null) {
  if (value === null) return "--:--:--"

  const totalSeconds = Math.max(Math.floor(value / 1000), 0)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  return [hours, minutes, seconds]
    .map((part) => String(part).padStart(2, "0"))
    .join(":")
}

function getOrderSteps(order: SupabasePedido | null): OrderStep[] {
  if (!order) {
    return [
      { label: "Confirmado", icon: CheckCircle2, state: "completed" },
      { label: "Pago", icon: CreditCard, state: "active" },
      { label: "Comprobante", icon: CloudUpload, state: "pending" },
      { label: "Envío", icon: Truck, state: "pending" },
    ]
  }

  const normalizedOrderStatus = (order.estado ?? "").toLowerCase()
  const normalizedPaymentStatus = (order.payment_status ?? "").toLowerCase()
  const proofSubmitted = Boolean(
    order.payment_proof_url ||
      order.payment_proof_uploaded_at ||
      ["en_revision", "confirmado", "approved"].includes(
        normalizedPaymentStatus,
      ),
  )
  const paymentConfirmed = isCheckoutPaymentConfirmed(order)
  const shippingStarted = SHIPPING_STARTED_STATES.has(normalizedOrderStatus)
  const delivered = normalizedOrderStatus === "entregado"

  return [
    { label: "Confirmado", icon: CheckCircle2, state: "completed" },
    {
      label: "Pago",
      icon: CreditCard,
      state: proofSubmitted || paymentConfirmed ? "completed" : "active",
    },
    {
      label: "Comprobante",
      icon: CloudUpload,
      state: paymentConfirmed
        ? "completed"
        : proofSubmitted
          ? "active"
          : "pending",
    },
    {
      label: "Envío",
      icon: Truck,
      state: delivered
        ? "completed"
        : paymentConfirmed || shippingStarted
          ? "active"
          : "pending",
    },
  ]
}

function OrderProgress({ steps }: { steps: OrderStep[] }) {
  return (
    <nav
      aria-label="Progreso del pedido"
      className="min-w-0 overflow-hidden px-1 py-1"
    >
      <ol className="grid grid-cols-4">
        {steps.map((step, index) => {
          const StepIcon = step.state === "completed" ? Check : step.icon
          const previousCompleted =
            index > 0 && steps[index - 1]?.state === "completed"
          const nextCompleted = step.state === "completed"

          return (
            <li
              key={step.label}
              aria-current={step.state === "active" ? "step" : undefined}
              className="min-w-0"
            >
              <div className="flex items-center">
                <span
                  aria-hidden="true"
                  className={`h-px flex-1 ${
                    index === 0
                      ? "bg-transparent"
                      : previousCompleted
                        ? "bg-[var(--account-success)]/60"
                        : "bg-[var(--account-border)]"
                  }`}
                />
                <span
                  className={`flex size-9 shrink-0 items-center justify-center rounded-full border sm:size-10 ${
                    step.state === "completed"
                      ? "border-[var(--account-success-border)] bg-[var(--account-success-bg)] text-[var(--account-success)]"
                      : step.state === "active"
                        ? "border-[var(--account-accent)] bg-[var(--account-accent)] text-white ring-4 ring-[var(--account-accent)]/12"
                        : "border-[var(--account-border)] bg-[var(--account-surface-hover)] text-[var(--account-text-secondary)]"
                  }`}
                >
                  <StepIcon className="size-4" aria-hidden="true" />
                </span>
                <span
                  aria-hidden="true"
                  className={`h-px flex-1 ${
                    index === steps.length - 1
                      ? "bg-transparent"
                      : nextCompleted
                        ? "bg-[var(--account-success)]/60"
                        : "bg-[var(--account-border)]"
                  }`}
                />
              </div>
              <p
                className={`mt-2 truncate text-center text-10px font-semibold sm:text-xs ${
                  step.state === "completed"
                    ? "text-[var(--account-success)]"
                    : step.state === "active"
                      ? "text-[var(--account-accent)]"
                      : "text-[var(--account-text-secondary)]"
                }`}
              >
                {step.label}
              </p>
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

function CopyablePaymentField({
  label,
  value,
  copied,
  onCopy,
}: {
  label: string
  value: string
  copied: boolean
  onCopy: () => void
}) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-3 border-b border-[var(--account-border-subtle)] py-3 last:border-b-0">
      <div className="min-w-0">
        <p className="text-11px font-semibold uppercase tracking-wider text-[var(--account-text-secondary)]">
          {label}
        </p>
        <p className="mt-1 break-all text-base font-bold tracking-normal text-[var(--account-text-primary)]">
          {value}
        </p>
      </div>
      <button
        type="button"
        aria-label={`Copiar ${label.toLowerCase()}`}
        title={`Copiar ${label.toLowerCase()}`}
        onClick={onCopy}
        className="flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg bg-[var(--account-accent)] px-3 text-xs font-semibold text-white transition-colors duration-200 hover:bg-[var(--account-accent-hover)]"
      >
        {copied ? (
          <Check className="size-4" aria-hidden="true" />
        ) : (
          <Copy className="size-4" aria-hidden="true" />
        )}
        <span className="hidden sm:inline">{copied ? "Copiado" : "Copiar"}</span>
      </button>
    </div>
  )
}

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
  const { clearCart, itemCount } = useCart()
  const hasClearedCartRef = useRef(false)
  const allowNavigationRef = useRef(false)
  const initialItemCountRef = useRef(itemCount)
  const copyFeedbackTimerRef = useRef<number | null>(null)
  const searchParams = useSearchParams()
  const isTransfer = searchParams.get("method") === "transferencia"
  const orderId = Number(searchParams.get("order_id"))
  const [order, setOrder] = useState<SupabasePedido | null>(null)
  const [orderLoading, setOrderLoading] = useState(isTransfer)
  const [orderError, setOrderError] = useState("")
  const [sessionExpired, setSessionExpired] = useState(false)
  const [pendingNavigationHref, setPendingNavigationHref] = useState("")
  const [copiedField, setCopiedField] = useState<"alias" | "cvu" | null>(null)
  const [remainingPaymentMs, setRemainingPaymentMs] = useState<number | null>(
    null,
  )
  const paymentConfirmed = isCheckoutPaymentConfirmed(order)
  const orderSteps = getOrderSteps(order)
  const orderArticleCount =
    order?.orden_items?.reduce(
      (total, item) => total + Math.max(Number(item.cantidad) || 0, 0),
      0,
    ) || initialItemCountRef.current || null
  const showProofPanel =
    orderLoading ||
    sessionExpired ||
    Boolean(orderError) ||
    !order ||
    !paymentConfirmed
  const isProofPending = Boolean(
    isTransfer &&
      order &&
      order.payment_status === "pendiente_comprobante" &&
      !order.payment_proof_url,
  )
  const successReturnUrl = `/checkout/success${
    searchParams.toString() ? `?${searchParams.toString()}` : ""
  }`
  const loginHref = `/login?redirect=${encodeURIComponent(successReturnUrl)}`
  const orderStatusHref =
    Number.isFinite(orderId) && orderId > 0
      ? `/cuenta/compras/${orderId}`
      : "/cuenta"
  const deadlineExpired =
    order?.payment_status === "vencido_falta_comprobante" ||
    remainingPaymentMs === 0
  const showPaymentDeadline = Boolean(
    isTransfer &&
      order &&
      !order.payment_proof_url &&
      !order.payment_proof_uploaded_at &&
      (isProofPending || deadlineExpired),
  )

  useEffect(() => {
    if (hasClearedCartRef.current) return

    hasClearedCartRef.current = true
    clearCart()
  }, [clearCart])

  useEffect(() => {
    return () => {
      if (copyFeedbackTimerRef.current) {
        window.clearTimeout(copyFeedbackTimerRef.current)
      }
    }
  }, [])

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
      intervalId = window.setInterval(updateRemainingTime, 1000)
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
      if (allowNavigationRef.current) return

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

  const handleCopyValue = async (
    field: "alias" | "cvu",
    value: string,
  ) => {
    try {
      await navigator.clipboard.writeText(value)
      setCopiedField(field)

      if (copyFeedbackTimerRef.current) {
        window.clearTimeout(copyFeedbackTimerRef.current)
      }

      copyFeedbackTimerRef.current = window.setTimeout(() => {
        setCopiedField(null)
      }, 2000)
    } catch {
      setCopiedField(null)
    }
  }

  return (
    <>
      <CheckoutStatusShell>
        <CheckoutStatusCard
          tone="success"
          icon={CheckCircle2}
          eyebrow={isTransfer ? "Pedido registrado" : "Pago recibido"}
          title={
            isTransfer
              ? "Tu pedido fue registrado correctamente"
              : "Estamos preparando tu pedido"
          }
          orderId={orderId}
          compact
          footer={
            <div className="grid gap-2.5 sm:grid-cols-2">
              <Link
                href="/productos"
                aria-label="Ir a productos"
                title="Ir a productos"
                onClick={(event) => {
                  if (!isProofPending) return
                  event.preventDefault()
                  setPendingNavigationHref("/productos")
                }}
                className="flex h-10 w-full cursor-pointer items-center justify-center rounded-lg border border-[var(--account-border)] bg-[var(--account-surface)] text-sm font-semibold text-[var(--account-text-primary)] transition-colors duration-200 hover:bg-[var(--account-surface-hover)]"
              >
                Seguir comprando
              </Link>

              <Link
                href={orderStatusHref}
                aria-label="Ver estado del pedido"
                title="Ver estado del pedido"
                onClick={(event) => {
                  if (!isProofPending) return
                  event.preventDefault()
                  setPendingNavigationHref(orderStatusHref)
                }}
                className="flex h-10 w-full cursor-pointer items-center justify-center rounded-lg bg-[var(--account-accent)] text-sm font-semibold text-white shadow-sm transition-colors duration-200 hover:bg-[var(--account-accent-hover)]"
              >
                Ver estado del pedido
              </Link>
            </div>
          }
        >
          {isTransfer ? (
            <>
              <OrderProgress steps={orderSteps} />

              <dl className="mt-4 mb-4 grid grid-cols-2 gap-y-2 rounded-lg bg-[var(--account-accent)] px-3 py-3 sm:grid-cols-4 sm:px-4">
                <div>
                  <dt className="text-10px font-semibold uppercase tracking-wider text-white/55">
                    Pedido
                  </dt>
                  <dd className="mt-0.5 text-sm font-bold text-white">
                    {Number.isFinite(orderId) && orderId > 0
                      ? `#${orderId}`
                      : "-"}
                  </dd>
                </div>
                <div>
                  <dt className="text-10px font-semibold uppercase tracking-wider text-white/55">
                    Fecha
                  </dt>
                  <dd className="mt-0.5 text-sm font-semibold text-white/85">
                    {orderLoading ? "Cargando..." : formatOrderDate(order?.created_at)}
                  </dd>
                </div>
                <div>
                  <dt className="text-10px font-semibold uppercase tracking-wider text-white/55">
                    Artículos
                  </dt>
                  <dd className="mt-0.5 text-sm font-semibold text-white/85">
                    {orderArticleCount ?? "-"}
                  </dd>
                </div>
                <div>
                  <dt className="text-10px font-semibold uppercase tracking-wider text-white/55">
                    Monto
                  </dt>
                  <dd className="mt-0.5 text-sm font-bold text-white">
                    {orderLoading
                      ? "Cargando..."
                      : order
                        ? formatPrice(Number(order.total))
                        : "-"}
                  </dd>
                </div>
              </dl>

              <div className="grid min-w-0 items-stretch gap-4 md:grid-cols-2">
                <CheckoutStatusPanel title="Finalizá tu pago">
                  <div className="mt-3 flex items-center gap-2.5">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[var(--account-accent)] text-white">
                      <CreditCard className="size-4" aria-hidden="true" />
                    </span>
                    <p className="text-sm font-semibold text-[var(--account-text-secondary)]">
                      Transferencia bancaria
                    </p>
                  </div>

                  <div className="mt-3 flex items-start gap-2 rounded-lg border border-[var(--account-info-border)] bg-[var(--account-info-bg)] px-3 py-2.5">
                    <Clock3 className="mt-0.5 size-4 shrink-0 text-[var(--account-accent)]" aria-hidden="true" />
                    <p className="text-xs leading-5 text-[var(--account-text-secondary)]">
                      Validamos comprobantes {BEYONIX_SUPPORT_HOURS_DETAIL.toLocaleLowerCase("es-AR")}
                    </p>
                  </div>

                  <div className="mt-1">
                    <CopyablePaymentField
                      label="Alias"
                      value={TRANSFER_ALIAS.toUpperCase()}
                      copied={copiedField === "alias"}
                      onCopy={() =>
                        void handleCopyValue(
                          "alias",
                          TRANSFER_ALIAS.toUpperCase(),
                        )
                      }
                    />
                    <div className="border-b border-[var(--account-border-subtle)] py-3">
                      <p className="text-11px font-semibold uppercase tracking-wider text-[var(--account-text-secondary)]">
                        Titular
                      </p>
                      <p className="mt-1 text-base font-bold text-[var(--account-text-primary)]">
                        {TRANSFER_ACCOUNT_HOLDER}
                      </p>
                    </div>
                    <CopyablePaymentField
                      label="CVU"
                      value={TRANSFER_CVU}
                      copied={copiedField === "cvu"}
                      onCopy={() =>
                        void handleCopyValue("cvu", TRANSFER_CVU)
                      }
                    />
                  </div>

                  <div className="mt-4 flex flex-col items-center gap-1 rounded-xl border border-[var(--account-success-border)] bg-[var(--account-success-bg)] px-4 py-4 text-center">
                    <p className="text-11px font-bold uppercase tracking-wider text-[var(--account-success)]">
                      Total a transferir
                    </p>
                    <p className="flex items-baseline gap-1 text-[var(--account-success)]">
                      <span className="text-xl font-bold">$</span>
                      <span className="text-3xl font-extrabold tracking-tight tabular-nums">
                        {orderLoading
                          ? "..."
                          : order
                            ? formatPriceNumber(Number(order.total))
                            : "-"}
                      </span>
                    </p>
                  </div>
                </CheckoutStatusPanel>

                {showProofPanel && (
                  <CheckoutStatusPanel
                    id="comprobante-pago"
                    title="Comprobante de pago"
                    className="flex h-full flex-col"
                  >
                    <div className="mt-3 flex flex-1 flex-col">
                      {orderLoading ? (
                        <div className="h-40 animate-pulse rounded-lg bg-[var(--account-surface-hover)]" />
                      ) : sessionExpired ? (
                        <div className="flex flex-col items-center rounded-lg bg-[var(--account-surface-raised)] px-5 py-6 text-center">
                          <span className="flex size-11 items-center justify-center rounded-xl bg-[var(--account-accent)] text-white">
                            <LogIn className="size-5" aria-hidden="true" />
                          </span>
                          <h3 className="mt-3 text-lg font-bold text-[var(--account-text-primary)]">
                            Tu sesión expiró
                          </h3>
                          <p className="mt-1.5 max-w-sm text-sm leading-5 text-[var(--account-text-secondary)]">
                            Para subir el comprobante de este pedido, iniciá sesión nuevamente.
                          </p>
                          <BeyonixButton
                            asChild
                            size="sm"
                            aria-label="Iniciar sesión y continuar"
                            title="Iniciar sesión y continuar"
                            className="mt-4 h-9 px-4 text-xs"
                          >
                            <Link href={loginHref}>
                              <LogIn className="size-4" aria-hidden="true" />
                              Iniciar sesión y continuar
                            </Link>
                          </BeyonixButton>
                        </div>
                      ) : orderError ? (
                        <CheckoutStatusNotice tone="failure">
                          {orderError}
                        </CheckoutStatusNotice>
                      ) : order ? (
                        <CustomerPaymentProof
                          order={order}
                          showHeading={false}
                          hideProofWhenConfirmed
                          expandUploader
                          onUploaded={(updatedOrder) =>
                            void handleProofUploaded(updatedOrder)
                          }
                        />
                      ) : (
                        <CheckoutStatusNotice tone="failure">
                          No pudimos identificar el pedido. Revisalo desde tu
                          cuenta para subir el comprobante.
                        </CheckoutStatusNotice>
                      )}
                    </div>
                  </CheckoutStatusPanel>
                )}
              </div>

              {showPaymentDeadline && (
                <CheckoutStatusNotice
                  tone={deadlineExpired ? "failure" : "pending"}
                  className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="flex items-start gap-2.5">
                    <AlertTriangle
                      className={`mt-0.5 size-4 shrink-0 ${
                        deadlineExpired
                          ? "text-[var(--account-danger)]"
                          : "text-[var(--account-warning)]"
                      }`}
                      aria-hidden="true"
                    />
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-[var(--account-text-primary)]">
                        {deadlineExpired
                          ? "Plazo de pago expirado"
                          : "Tiempo restante para enviar el comprobante"}
                      </p>
                      <p className="mt-0.5 text-xs text-[var(--account-text-secondary)]">
                        {deadlineExpired
                          ? "El pedido ya no admite comprobantes y será cancelado por falta de pago."
                          : "Al llegar a cero, el pedido se cancelará automáticamente."}
                      </p>
                    </div>
                  </div>
                  <p className="shrink-0 text-2xl font-bold tabular-nums text-[var(--account-text-primary)] sm:text-right">
                    {deadlineExpired
                      ? "EXPIRADO"
                      : formatCountdown(remainingPaymentMs)}
                  </p>
                </CheckoutStatusNotice>
              )}
            </>
          ) : (
            <p className="mx-auto max-w-md py-6 text-center text-sm leading-relaxed text-[var(--account-text-secondary)]">
              Pago recibido. Estamos preparando tu pedido.
            </p>
          )}
        </CheckoutStatusCard>
      </CheckoutStatusShell>

      {pendingNavigationHref && isProofPending && (
        <div className="fixed inset-0 z-100 flex items-center justify-center bg-black/60 px-4 font-heading">
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="comprobante-pendiente-titulo"
            aria-describedby="comprobante-pendiente-descripcion"
            className="w-full max-w-md rounded-2xl border border-[var(--account-border-subtle)] bg-[var(--account-surface)] p-5 shadow-xl shadow-black/20"
          >
            <div className="flex items-start gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-[var(--account-warning-bg)] text-[var(--account-warning)]">
                <AlertTriangle className="size-4" aria-hidden="true" />
              </span>
              <div>
                <h2
                  id="comprobante-pendiente-titulo"
                  className="text-base font-bold text-[var(--account-text-primary)]"
                >
                  Todavía no subiste el comprobante de pago
                </h2>
                <p
                  id="comprobante-pendiente-descripcion"
                  className="mt-1.5 text-sm leading-5 text-[var(--account-text-secondary)]"
                >
                  Tu pedido quedará pendiente hasta que podamos validar la
                  transferencia.
                </p>
              </div>
            </div>

            <div className="mt-5 grid gap-2.5">
              <BeyonixButton
                type="button"
                autoFocus
                size="sm"
                aria-label="Volver al comprobante"
                title="Volver al comprobante"
                className="h-10 px-4 text-xs"
                onClick={() => {
                  setPendingNavigationHref("")
                  document.getElementById("comprobante-pago")?.scrollIntoView({
                    behavior: "smooth",
                    block: "center",
                  })
                }}
              >
                Volver al comprobante
              </BeyonixButton>
              <BeyonixButton
                type="button"
                variant="destructive"
                size="sm"
                aria-label="Continuar sin subir el comprobante"
                title="Continuar sin subir el comprobante"
                className="h-10 px-4 text-xs"
                onClick={() => {
                  allowNavigationRef.current = true
                  window.location.href = pendingNavigationHref
                }}
              >
                Continuar sin subir
              </BeyonixButton>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

export default function CheckoutSuccessPage() {
  return (
    <Suspense fallback={null}>
      <CheckoutSuccessContent />
    </Suspense>
  )
}
