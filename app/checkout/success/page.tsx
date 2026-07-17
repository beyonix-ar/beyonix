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
import type { SupabasePedido } from "@/lib/supabase/types"

const formatPrice = (price: number) =>
  new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    minimumFractionDigits: 0,
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
      className="min-w-0 overflow-hidden px-2 py-2 sm:px-4"
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
                        ? "bg-beyonix-status-success/70"
                        : "bg-beyonix-gray-700"
                  }`}
                />
                <span
                  className={`flex size-8 shrink-0 items-center justify-center rounded-full border sm:size-9 ${
                    step.state === "completed"
                      ? "border-beyonix-status-success/45 bg-beyonix-status-success/15 text-beyonix-status-success"
                      : step.state === "active"
                        ? "border-beyonix-blue-300 bg-beyonix-blue-700 text-white"
                        : "border-beyonix-gray-700 bg-beyonix-gray-900 text-beyonix-gray-500"
                  }`}
                >
                  <StepIcon className="size-3.5" aria-hidden="true" />
                </span>
                <span
                  aria-hidden="true"
                  className={`h-px flex-1 ${
                    index === steps.length - 1
                      ? "bg-transparent"
                      : nextCompleted
                        ? "bg-beyonix-status-success/70"
                        : "bg-beyonix-gray-700"
                  }`}
                />
              </div>
              <p
                className={`mt-1.5 truncate text-center text-10px font-semibold sm:text-xs ${
                  step.state === "completed"
                    ? "text-beyonix-status-success"
                    : step.state === "active"
                      ? "text-white"
                      : "text-beyonix-gray-500"
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
    <div className="flex min-w-0 items-center justify-between gap-3 border-b border-beyonix-blue-500/25 py-2 last:border-b-0">
      <div className="min-w-0">
        <p className="text-10px font-semibold uppercase tracking-wider text-beyonix-gray-300">
          {label}
        </p>
        <p className="mt-1 break-all text-sm font-semibold tracking-normal text-white">
          {value}
        </p>
      </div>
      <BeyonixButton
        type="button"
        variant="secondary"
        size="sm"
        aria-label={`Copiar ${label.toLowerCase()}`}
        title={`Copiar ${label.toLowerCase()}`}
        onClick={onCopy}
        className="h-8 shrink-0 border-beyonix-blue-500/60 bg-beyonix-blue-700 px-2.5 text-white hover:border-beyonix-blue-300 hover:bg-beyonix-blue-500"
      >
        {copied ? (
          <Check className="size-4 text-beyonix-status-success" aria-hidden="true" />
        ) : (
          <Copy className="size-4" aria-hidden="true" />
        )}
        <span className="hidden sm:inline">{copied ? "Copiado" : "Copiar"}</span>
      </BeyonixButton>
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
        const response = await fetch(`/api/payment-proofs/${orderId}`, {
          cache: "no-store",
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
      const response = await fetch(`/api/payment-proofs/${orderId}`, {
        cache: "no-store",
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
          className="border-beyonix-gray-700 bg-beyonix-gray-900"
          headerClassName="border-beyonix-blue-500/40 bg-beyonix-blue-900 py-3"
          bodyClassName="bg-beyonix-page"
          footerClassName="bg-beyonix-gray-900 py-2.5"
          footer={
            <div className="grid gap-2.5 sm:grid-cols-2">
              <BeyonixButton
                asChild
                variant="secondary"
                size="sm"
                aria-label="Ir a productos"
                title="Ir a productos"
                className="h-9 w-full border-beyonix-gray-500/50 bg-beyonix-gray-700 text-white hover:border-beyonix-gray-300 hover:bg-beyonix-gray-500"
              >
                <Link
                  href="/productos"
                  onClick={(event) => {
                    if (!isProofPending) return
                    event.preventDefault()
                    setPendingNavigationHref("/productos")
                  }}
                >
                  Seguir comprando
                </Link>
              </BeyonixButton>

              <BeyonixButton
                asChild
                size="sm"
                aria-label="Ver estado del pedido"
                title="Ver estado del pedido"
                className="h-9 w-full border-beyonix-blue-500 bg-beyonix-blue-700 text-white hover:border-beyonix-blue-300 hover:bg-beyonix-blue-500"
              >
                <Link
                  href={orderStatusHref}
                  onClick={(event) => {
                    if (!isProofPending) return
                    event.preventDefault()
                    setPendingNavigationHref(orderStatusHref)
                  }}
                >
                  Ver estado del pedido
                </Link>
              </BeyonixButton>
            </div>
          }
        >
          {isTransfer ? (
            <>
              <OrderProgress steps={orderSteps} />

              <dl className="mb-3 grid grid-cols-2 border-y border-beyonix-gray-700 bg-beyonix-gray-900 sm:grid-cols-4">
                <div className="px-3 py-1.5">
                  <dt className="text-10px font-semibold uppercase tracking-wider text-beyonix-gray-500">
                    Pedido
                  </dt>
                  <dd className="mt-0.5 text-sm font-bold text-white">
                    {Number.isFinite(orderId) && orderId > 0
                      ? `#${orderId}`
                      : "-"}
                  </dd>
                </div>
                <div className="px-3 py-1.5">
                  <dt className="text-10px font-semibold uppercase tracking-wider text-beyonix-gray-500">
                    Fecha
                  </dt>
                  <dd className="mt-0.5 text-sm font-semibold text-beyonix-gray-300">
                    {orderLoading ? "Cargando..." : formatOrderDate(order?.created_at)}
                  </dd>
                </div>
                <div className="px-3 py-1.5">
                  <dt className="text-10px font-semibold uppercase tracking-wider text-beyonix-gray-500">
                    Artículos
                  </dt>
                  <dd className="mt-0.5 text-sm font-semibold text-beyonix-gray-300">
                    {orderArticleCount ?? "-"}
                  </dd>
                </div>
                <div className="px-3 py-1.5">
                  <dt className="text-10px font-semibold uppercase tracking-wider text-beyonix-gray-500">
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

              <div className="grid min-w-0 items-stretch gap-3 md:grid-cols-2">
                <CheckoutStatusPanel
                  title="Finalizá tu pago"
                  className="border-beyonix-blue-500/45 bg-beyonix-blue-900 p-3"
                  titleClassName="text-base"
                >
                  <div className="mt-2">
                    <div className="flex items-center gap-2.5 border-b border-beyonix-blue-500/30 pb-2">
                      <span className="flex size-8 items-center justify-center rounded-lg border border-beyonix-blue-500/50 bg-beyonix-blue-700 text-beyonix-blue-300">
                        <CreditCard className="size-4" aria-hidden="true" />
                      </span>
                      <p className="text-sm font-bold text-white">
                        Transferencia bancaria
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
                      <div className="border-b border-beyonix-blue-500/25 py-2">
                        <p className="text-10px font-semibold uppercase tracking-wider text-beyonix-gray-300">
                          Titular
                        </p>
                        <p className="mt-1 text-sm font-semibold text-white">
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
                      <div className="flex flex-col items-center pt-2 text-center">
                        <p className="text-xs font-bold uppercase tracking-wider text-beyonix-status-success">
                          Total a transferir
                        </p>
                        <p className="mt-1 inline-flex min-h-9 items-center rounded-md border border-beyonix-status-success/35 bg-beyonix-status-success/12 px-3 py-1 text-lg font-bold tracking-normal text-beyonix-status-success">
                          {orderLoading
                            ? "Cargando..."
                            : order
                              ? formatPrice(Number(order.total))
                              : "-"}
                        </p>
                      </div>
                    </div>
                  </div>
                </CheckoutStatusPanel>

                {showProofPanel && (
                  <CheckoutStatusPanel
                    id="comprobante-pago"
                    title="Comprobante"
                    className="flex h-full flex-col border-beyonix-gray-700 bg-beyonix-gray-900 p-3"
                    titleClassName="border-beyonix-gray-500 text-base"
                  >
                    <div className="mt-2 flex flex-1 flex-col">
                      {orderLoading ? (
                        <div className="h-40 animate-pulse rounded-lg border border-beyonix-gray-700 bg-beyonix-gray-900" />
                      ) : sessionExpired ? (
                        <div className="flex flex-col items-center rounded-lg border border-beyonix-gray-700 bg-beyonix-gray-900 px-5 py-6 text-center shadow-lg shadow-black/20">
                          <span className="flex size-11 items-center justify-center rounded-xl border border-beyonix-blue-500/50 bg-beyonix-blue-700 text-beyonix-blue-300">
                            <LogIn className="size-5" aria-hidden="true" />
                          </span>
                          <h3 className="mt-3 text-lg font-bold text-white">
                            Tu sesión expiró
                          </h3>
                          <p className="mt-1.5 max-w-sm text-sm leading-5 text-beyonix-gray-300">
                            Para subir el comprobante de este pedido, iniciá sesión nuevamente.
                          </p>
                          <BeyonixButton
                            asChild
                            size="sm"
                            aria-label="Iniciar sesión y continuar"
                            title="Iniciar sesión y continuar"
                            className="mt-4 h-9 border-beyonix-blue-500 bg-beyonix-blue-700 px-4 text-xs hover:bg-beyonix-blue-500"
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
                  className="mt-3 flex flex-col items-center justify-center gap-1.5 py-2 text-center sm:flex-row sm:gap-3"
                >
                  <AlertTriangle
                    className={`size-4 shrink-0 ${
                      deadlineExpired
                        ? "text-beyonix-status-danger"
                        : "text-beyonix-status-pending"
                    }`}
                    aria-hidden="true"
                  />
                  <div className="min-w-0">
                    <div>
                      <p className="font-semibold">
                        {deadlineExpired
                          ? "Plazo de pago expirado"
                          : "Tiempo restante para enviar el comprobante"}
                      </p>
                      <p className="mt-0.5 text-xs text-beyonix-gray-300">
                        {deadlineExpired
                          ? "El pedido ya no admite comprobantes y será cancelado por falta de pago."
                          : "Al llegar a cero, el pedido se cancelará automáticamente."}
                      </p>
                    </div>
                  </div>
                  <p className="shrink-0 text-lg font-bold tabular-nums text-white">
                    {deadlineExpired
                      ? "EXPIRADO"
                      : formatCountdown(remainingPaymentMs)}
                  </p>
                </CheckoutStatusNotice>
              )}
            </>
          ) : (
            <p className="mx-auto max-w-md py-6 text-center text-sm leading-relaxed text-beyonix-gray-300">
              Pago recibido. Estamos preparando tu pedido.
            </p>
          )}
        </CheckoutStatusCard>
      </CheckoutStatusShell>

      {pendingNavigationHref && isProofPending && (
        <div className="fixed inset-0 z-100 flex items-center justify-center bg-beyonix-gray-900/95 px-4 font-heading">
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="comprobante-pendiente-titulo"
            aria-describedby="comprobante-pendiente-descripcion"
            className="w-full max-w-md rounded-2xl border border-beyonix-gray-700 bg-beyonix-gray-900 p-5 shadow-2xl shadow-black/70"
          >
            <div className="flex items-start gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-beyonix-status-pending/35 bg-beyonix-status-pending/10 text-beyonix-status-pending">
                <AlertTriangle className="size-4" aria-hidden="true" />
              </span>
              <div>
                <h2
                  id="comprobante-pendiente-titulo"
                  className="text-base font-bold text-white"
                >
                  Todavía no subiste el comprobante de pago
                </h2>
                <p
                  id="comprobante-pendiente-descripcion"
                  className="mt-1.5 text-sm leading-5 text-beyonix-gray-300"
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
