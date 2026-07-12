"use client"

import { Suspense, useEffect, useRef, useState } from "react"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import {
  Check,
  CheckCircle2,
  Clock3,
  Copy,
  CreditCard,
  LogIn,
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

function CheckoutSuccessContent() {
  const { clearCart } = useCart()
  const hasClearedCartRef = useRef(false)
  const allowNavigationRef = useRef(false)
  const searchParams = useSearchParams()
  const isTransfer = searchParams.get("method") === "transferencia"
  const orderId = Number(searchParams.get("order_id"))
  const [order, setOrder] = useState<SupabasePedido | null>(null)
  const [orderLoading, setOrderLoading] = useState(isTransfer)
  const [orderError, setOrderError] = useState("")
  const [sessionExpired, setSessionExpired] = useState(false)
  const [pendingNavigationHref, setPendingNavigationHref] = useState("")
  const [aliasCopied, setAliasCopied] = useState(false)
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

  const handleCopyAlias = async () => {
    try {
      await navigator.clipboard.writeText(TRANSFER_ALIAS.toUpperCase())
      setAliasCopied(true)
      window.setTimeout(() => setAliasCopied(false), 1800)
    } catch {
      setAliasCopied(false)
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
          footer={
            <div className="grid gap-2.5 sm:grid-cols-2">
              <BeyonixButton
                asChild
                size="sm"
                aria-label="Ir a productos"
                title="Ir a productos"
                className="h-10 w-full"
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
                variant="secondary"
                size="sm"
                aria-label="Ir al inicio"
                title="Ir al inicio"
                className="h-10 w-full"
              >
                <Link
                  href="/"
                  onClick={(event) => {
                    if (!isProofPending) return
                    event.preventDefault()
                    setPendingNavigationHref("/")
                  }}
                >
                  Volver al inicio
                </Link>
              </BeyonixButton>
            </div>
          }
        >
          {isTransfer ? (
            <>
              <div className="grid items-start gap-4 lg:grid-cols-2">
                <CheckoutStatusPanel title="Finalizá tu pago">
                  <div className="mt-3 rounded-lg border border-beyonix-blue-light/14 bg-[#0B1118] p-3.5 shadow-inner shadow-black/20">
                    <div className="flex items-center gap-2.5 border-b border-beyonix-blue-light/12 pb-2.5">
                      <span className="flex size-8 items-center justify-center rounded-lg border border-beyonix-blue-light/24 bg-[#112A43] text-white">
                        <CreditCard className="size-4" />
                      </span>
                      <p className="text-sm font-bold text-white">
                        Transferencia bancaria
                      </p>
                    </div>

                    <div className="mt-3 space-y-3">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <p className="text-10px font-semibold uppercase tracking-wider text-white/48">
                            Alias
                          </p>
                          <p className="mt-0.5 text-lg font-bold uppercase tracking-wide text-white">
                            {TRANSFER_ALIAS}
                          </p>
                        </div>
                        <BeyonixButton
                          type="button"
                          size="sm"
                          aria-label="Copiar alias de transferencia"
                          title="Copiar alias"
                          onClick={() => void handleCopyAlias()}
                          className="h-9 shrink-0 px-3 text-xs"
                        >
                          {aliasCopied ? (
                            <Check className="size-3.5" />
                          ) : (
                            <Copy className="size-3.5" />
                          )}
                          {aliasCopied ? "Alias copiado" : "Copiar alias"}
                        </BeyonixButton>
                      </div>
                      <div>
                        <p className="text-10px font-semibold uppercase tracking-wider text-white/48">
                          Titular
                        </p>
                        <p className="mt-0.5 text-sm font-bold text-white">
                          {TRANSFER_ACCOUNT_HOLDER}
                        </p>
                      </div>
                      <div>
                        <p className="text-10px font-semibold uppercase tracking-wider text-white/48">
                          CVU
                        </p>
                        <p className="mt-0.5 break-all text-sm font-bold tracking-wide text-white">
                          {TRANSFER_CVU}
                        </p>
                      </div>
                      <div>
                        <p className="text-10px font-semibold uppercase tracking-wider text-white/48">
                          Total a transferir
                        </p>
                        <p className="mt-0.5 text-xl font-bold tracking-tight text-white">
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

                <CheckoutStatusPanel id="comprobante-pago" title="Comprobante">
                  <div className="mt-3">
                    {orderLoading ? (
                      <div className="h-40 animate-pulse rounded-lg border border-beyonix-blue-light/14 bg-[#0B1118]" />
                    ) : sessionExpired ? (
                      <div className="flex flex-col items-center rounded-lg border border-beyonix-blue-light/20 bg-[#0B1118] px-5 py-6 text-center shadow-[0_0_28px_rgba(17,42,67,0.18)]">
                        <span className="flex size-11 items-center justify-center rounded-xl border border-beyonix-blue-light/25 bg-[#112A43]/55 text-beyonix-sky">
                          <LogIn className="size-5" />
                        </span>
                        <h3 className="mt-3 text-lg font-bold text-white">
                          Tu sesión expiró
                        </h3>
                        <p className="mt-1.5 max-w-sm text-sm leading-5 text-white/62">
                          Para subir el comprobante de este pedido, iniciá sesión nuevamente.
                        </p>
                        <BeyonixButton
                          asChild
                          size="sm"
                          className="mt-4 h-9 px-4 text-xs"
                        >
                          <Link href={loginHref}>
                            <LogIn className="size-4" />
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
              </div>

              <CheckoutStatusNotice
                tone="pending"
                className="mt-4 flex items-start gap-2.5"
              >
                <Clock3 className="mt-0.5 size-4 shrink-0 text-amber-300" />
                <p>
                  Tenés hasta 48 hs para realizar el pago y enviar el
                  comprobante correspondiente. Caso contrario, el pedido se
                  cancelará automáticamente por falta de pago.
                </p>
              </CheckoutStatusNotice>
            </>
          ) : (
            <p className="mx-auto max-w-md py-6 text-center text-sm leading-relaxed text-white/70">
              Pago recibido. Estamos preparando tu pedido.
            </p>
          )}
        </CheckoutStatusCard>
      </CheckoutStatusShell>

      {pendingNavigationHref && isProofPending && (
        <div className="fixed inset-0 z-100 flex items-center justify-center bg-black/80 px-4 backdrop-blur-sm">
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="comprobante-pendiente-titulo"
            aria-describedby="comprobante-pendiente-descripcion"
            className="w-full max-w-md rounded-2xl border border-beyonix-blue-light/20 bg-[#0B1118] p-5 shadow-2xl shadow-black/70"
          >
            <div className="flex items-start gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-amber-300/20 bg-amber-300/[0.06] text-amber-300">
                <Clock3 className="size-4" />
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
                  className="mt-1.5 text-sm leading-5 text-white/62"
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
