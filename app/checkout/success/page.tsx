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

import { Footer } from "@/components/footer"
import { CustomerPaymentProof } from "@/components/customer-payment-proof"
import { Button } from "@/components/ui/button"
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

const primaryBlue =
  "inline-flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-beyonix-blue-light/42 bg-[#112A43] font-black text-white shadow-[0_0_14px_rgba(47,111,163,0.16)] transition-all duration-200 hover:border-beyonix-blue-light/70 hover:bg-[#183B5E] hover:shadow-[0_0_18px_rgba(47,111,163,0.22)] disabled:cursor-not-allowed disabled:border-beyonix-blue-light/15 disabled:bg-[#111820] disabled:text-white/45 disabled:shadow-none"

const successGreen =
  "inline-flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-emerald-300/35 bg-[#0F4F3A] font-black text-white shadow-[0_0_14px_rgba(16,185,129,0.14)] transition-all duration-200 hover:border-emerald-300/55 hover:bg-[#137354] hover:shadow-[0_0_18px_rgba(16,185,129,0.2)] disabled:cursor-not-allowed disabled:opacity-50"

const neutralDanger =
  "inline-flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-white/12 bg-[#151A20] font-black text-white transition-all duration-200 hover:border-red-300/45 hover:bg-[#4B1720] hover:shadow-[0_0_16px_rgba(239,68,68,0.16)] disabled:cursor-not-allowed disabled:opacity-50"

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
      <main className="min-h-screen bg-[#05070A] px-4 py-[21px] font-heading text-white sm:py-[25px]">
        <div className="mx-auto w-full max-w-[1075px] rounded-3xl border border-[#303846] bg-[#0D1117] px-4 py-[17px] shadow-2xl shadow-black/50 sm:px-5 sm:py-[21px]">
          <div className="flex flex-col items-center border-b border-[#303846] pb-4 text-center">
            <div className="flex size-12 items-center justify-center rounded-full border border-emerald-400/25 bg-emerald-400/10 shadow-[0_0_18px_rgba(16,185,129,0.14)]">
              <CheckCircle2 className="size-7 text-white" />
            </div>

            <p className="mt-3 text-10px font-semibold uppercase tracking-widest text-beyonix-cyan">
              {isTransfer ? "Pedido registrado" : "Pago recibido"}
            </p>

            <h1 className="mt-1.5 max-w-2xl text-2xl font-bold tracking-tight sm:text-3xl">
              {isTransfer ? "Tu pedido fue registrado correctamente" : "Estamos preparando tu pedido"}
            </h1>

            {Number.isFinite(orderId) && orderId > 0 && (
              <p className="mt-1.5 text-xs text-[#9CA3AF]">
                Pedido #{orderId}
              </p>
            )}
          </div>

          {isTransfer ? (
            <>
              <div className="grid items-start gap-4 py-4 lg:grid-cols-2">
                <section className="rounded-2xl border border-[#303846] bg-[#141820] p-3.5 sm:p-4 lg:-mt-2">
                <h2 className="border-l-4 border-beyonix-blue pl-3 text-lg font-semibold">
                  Finalizá tu pago
                </h2>

                <div className="mt-3 rounded-xl border border-[#303846] bg-[#1B2028] p-3.5 shadow-inner shadow-black/20">
                  <div className="flex items-center gap-2.5 border-b border-[#303846] pb-2.5">
                    <span className="flex size-8 items-center justify-center rounded-lg bg-[#112A43] text-white">
                      <CreditCard className="size-4" />
                    </span>
                    <p className="text-sm font-bold text-white">
                      Transferencia bancaria
                    </p>
                  </div>

                  <div className="mt-3">
                    <div className="space-y-3">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <p className="text-10px font-semibold uppercase tracking-wider text-[#9CA3AF]">
                            Alias
                          </p>
                          <p className="mt-0.5 text-lg font-bold uppercase tracking-wide text-white">
                            {TRANSFER_ALIAS}
                          </p>
                        </div>
                        <button
                          type="button"
                          aria-label="Copiar alias de transferencia"
                          title="Copiar alias"
                          onClick={() => void handleCopyAlias()}
                          className={`h-9 shrink-0 px-3 text-xs ${
                            aliasCopied
                              ? successGreen
                              : primaryBlue
                          }`}
                        >
                          {aliasCopied ? (
                            <Check className="size-3.5" />
                          ) : (
                            <Copy className="size-3.5" />
                          )}
                          {aliasCopied ? "Alias copiado" : "Copiar alias"}
                        </button>
                      </div>
                      <div>
                        <p className="text-10px font-semibold uppercase tracking-wider text-[#9CA3AF]">
                          Titular
                        </p>
                        <p className="mt-0.5 text-sm font-bold text-white">
                          {TRANSFER_ACCOUNT_HOLDER}
                        </p>
                      </div>
                      <div>
                        <p className="text-10px font-semibold uppercase tracking-wider text-[#9CA3AF]">
                          CVU
                        </p>
                        <p className="mt-0.5 break-all text-sm font-bold tracking-wide text-white">
                          {TRANSFER_CVU}
                        </p>
                      </div>
                      <div>
                        <p className="text-10px font-semibold uppercase tracking-wider text-[#9CA3AF]">
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
                </div>

                </section>

                <section id="comprobante-pago" className="rounded-2xl border border-[#303846] bg-[#141820] p-3.5 sm:p-4">
                <h2 className="border-l-4 border-beyonix-blue pl-3 text-lg font-semibold">
                  Comprobante
                </h2>

                <div className="mt-3">
                  {orderLoading ? (
                    <div className="h-40 animate-pulse rounded-2xl border border-[#303846] bg-[#1B2028]" />
                  ) : sessionExpired ? (
                    <div className="flex flex-col items-center rounded-2xl border border-beyonix-blue-light/25 bg-[#1B2028] px-5 py-6 text-center shadow-[0_0_28px_rgba(17,42,67,0.22)]">
                      <span className="flex size-11 items-center justify-center rounded-xl border border-beyonix-blue-light/25 bg-[#112A43]/55 text-beyonix-sky">
                        <LogIn className="size-5" />
                      </span>
                      <h3 className="mt-3 text-lg font-bold text-white">
                        Tu sesión expiró
                      </h3>
                      <p className="mt-1.5 max-w-sm text-sm leading-5 text-[#C8C8C8]">
                        Para subir el comprobante de este pedido, iniciá sesión nuevamente.
                      </p>
                      <Link
                        href={loginHref}
                        className={`mt-4 h-9 px-4 text-xs ${primaryBlue}`}
                      >
                        <LogIn className="size-4" />
                        Iniciar sesión y continuar
                      </Link>
                    </div>
                  ) : orderError ? (
                    <div className="rounded-xl border border-red-500/20 bg-red-950/40 p-4 text-sm text-red-300">
                      {orderError}
                    </div>
                  ) : order ? (
                    <CustomerPaymentProof
                      order={order}
                      showHeading={false}
                      onUploaded={(updatedOrder) =>
                        void handleProofUploaded(updatedOrder)
                      }
                    />
                  ) : (
                    <div className="rounded-xl border border-red-500/20 bg-red-950/40 p-4 text-sm text-red-300">
                      No pudimos identificar el pedido. Revisalo desde tu cuenta para subir el comprobante.
                    </div>
                  )}
                </div>
                </section>
              </div>

              <div className="-mt-1 mb-4 flex items-start gap-2.5 rounded-xl border border-amber-300/22 bg-amber-300/[0.045] px-3.5 py-2.5 text-sm leading-5 text-white/82">
                <Clock3 className="mt-0.5 size-4 shrink-0 text-amber-300" />
                <p>
                  Tenés hasta 48 hs para realizar el pago y enviar el comprobante correspondiente. Caso contrario, el pedido se cancelará automáticamente por falta de pago.
                </p>
              </div>
            </>
          ) : (
            <p className="mx-auto max-w-md py-8 text-center text-sm leading-relaxed text-white/70">
              Pago recibido. Estamos preparando tu pedido.
            </p>
          )}

          <div className="grid gap-2.5 border-t border-[#303846] pt-4 sm:grid-cols-2">
            <Button
              asChild
              type="button"
              aria-label="Ir a productos"
              title="Ir a productos"
              className={`h-9 w-full text-xs ${primaryBlue}`}
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
            </Button>

            <Button
              asChild
              type="button"
              aria-label="Ir al inicio"
              title="Ir al inicio"
              variant="outline"
              className={`h-9 w-full text-xs ${primaryBlue}`}
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
            </Button>
          </div>
        </div>

        {pendingNavigationHref && isProofPending && (
          <div className="fixed inset-0 z-100 flex items-center justify-center bg-black/80 px-4 backdrop-blur-sm">
            <div
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="comprobante-pendiente-titulo"
              aria-describedby="comprobante-pendiente-descripcion"
              className="w-full max-w-md rounded-2xl border border-[#303846] bg-[#0D1117] p-5 shadow-2xl shadow-black/70"
            >
              <div className="flex items-start gap-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-amber-300/20 bg-amber-300/[0.06] text-amber-300">
                  <Clock3 className="size-4" />
                </span>
                <div>
                  <h2 id="comprobante-pendiente-titulo" className="text-base font-bold text-white">
                    Todavía no subiste el comprobante de pago
                  </h2>
                  <p id="comprobante-pendiente-descripcion" className="mt-1.5 text-sm leading-5 text-[#C8C8C8]">
                    Tu pedido quedará pendiente hasta que podamos validar la transferencia.
                  </p>
                </div>
              </div>

              <div className="mt-5 grid gap-2.5">
                <button
                  type="button"
                  autoFocus
                  className={`h-9 px-4 text-xs ${successGreen}`}
                  onClick={() => {
                    setPendingNavigationHref("")
                    document.getElementById("comprobante-pago")?.scrollIntoView({
                      behavior: "smooth",
                      block: "center",
                    })
                  }}
                >
                  Volver al comprobante
                </button>
                <button
                  type="button"
                  className={`h-9 px-4 text-xs ${neutralDanger}`}
                  onClick={() => {
                    allowNavigationRef.current = true
                    window.location.href = pendingNavigationHref
                  }}
                >
                  Continuar sin subir
                </button>
              </div>
            </div>
          </div>
        )}
      </main>
      <Footer />
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
