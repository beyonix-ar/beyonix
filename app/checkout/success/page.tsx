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
import { TRANSFER_ALIAS } from "@/lib/payments/transfer"
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
      <main className="min-h-screen bg-[#05070A] px-4 py-[21px] font-heading text-white sm:py-[25px]">
        <div className="mx-auto w-full max-w-[1075px] rounded-3xl border border-[#303846] bg-[#0D1117] px-4 py-[17px] shadow-2xl shadow-black/50 sm:px-5 sm:py-[21px]">
          <div className="flex flex-col items-center border-b border-[#303846] pb-4 text-center">
            <div className="flex size-12 items-center justify-center rounded-full border border-emerald-400/20 bg-emerald-400/10">
              <CheckCircle2 className="size-7 text-emerald-400" />
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
            <div className="grid items-stretch gap-4 py-4 lg:grid-cols-2">
              <section className="rounded-2xl border border-[#303846] bg-[#141820] p-3.5 sm:p-4">
                <h2 className="border-l-4 border-beyonix-blue pl-3 text-lg font-semibold">
                  Finalizá tu pago
                </h2>

                <div className="mt-3 rounded-xl border border-[#303846] bg-[#1B2028] p-3.5 shadow-inner shadow-black/20">
                  <div className="flex items-center gap-2.5 border-b border-[#303846] pb-2.5">
                    <span className="flex size-8 items-center justify-center rounded-lg bg-beyonix-blue text-beyonix-sky">
                      <CreditCard className="size-4" />
                    </span>
                    <p className="text-sm font-bold text-white">
                      Transferencia bancaria
                    </p>
                  </div>

                  <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <p className="text-10px font-semibold uppercase tracking-wider text-[#9CA3AF]">
                          Alias
                        </p>
                        <p className="mt-0.5 text-lg font-bold uppercase tracking-wide text-white">
                          {TRANSFER_ALIAS}
                        </p>
                      </div>
                      <div>
                        <p className="text-10px font-semibold uppercase tracking-wider text-[#9CA3AF]">
                          Total a transferir
                        </p>
                        <p className="mt-0.5 text-xl font-bold tracking-tight text-white">
                          {orderLoading
                            ? "Cargando…"
                            : order
                              ? formatPrice(Number(order.total))
                              : "—"}
                        </p>
                      </div>
                    </div>

                    <button
                      type="button"
                      aria-label="Copiar alias de transferencia"
                      title="Copiar alias"
                      onClick={() => void handleCopyAlias()}
                      className={`inline-flex h-9 cursor-pointer items-center justify-center gap-2 rounded-lg px-3 text-xs font-semibold text-white transition-colors ${
                        aliasCopied
                          ? "bg-[#16A34A] hover:bg-[#15803D]"
                          : "bg-[#112A43] hover:bg-[#183B5E]"
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
                </div>

                <div className="mt-3 grid grid-cols-3 overflow-hidden rounded-xl border border-[#303846] bg-[#1B2028]">
                  <div className="flex min-w-0 items-center justify-center gap-1.5 border-r border-[#303846] px-2 py-2.5 text-center text-10px font-semibold text-[#C8C8C8] sm:text-xs">
                    <CheckCircle2 className="size-3.5 shrink-0 text-emerald-400" />
                    <span>Pedido creado</span>
                  </div>
                  <div className="flex min-w-0 items-center justify-center gap-1.5 border-r border-[#303846] px-2 py-2.5 text-center text-10px font-semibold text-[#C8C8C8] sm:text-xs">
                    <Clock3 className="size-3.5 shrink-0 text-amber-300" />
                    <span>Pago pendiente</span>
                  </div>
                  <div className="flex min-w-0 items-center justify-center gap-1.5 px-2 py-2.5 text-center text-10px font-semibold text-[#9CA3AF] sm:text-xs">
                    <span className="size-3.5 shrink-0 rounded-full border border-[#9CA3AF]" />
                    <span>Preparación</span>
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
                        className="mt-4 inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-xl border border-beyonix-blue-light/35 bg-[#112A43] px-5 text-sm font-semibold text-white shadow-[0_0_20px_rgba(17,42,67,0.3)] transition-colors hover:bg-[#183B5E]"
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
              className={`h-10 w-full text-sm font-semibold text-white ${
                isProofPending
                  ? "border border-[#303846] bg-[#141820] hover:border-beyonix-blue-light/45 hover:bg-[#1B2028]"
                  : "bg-beyonix-blue hover:bg-beyonix-blue-hover"
              }`}
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
              className="h-10 w-full border-[#303846] bg-transparent text-sm text-[#C8C8C8] hover:border-beyonix-blue-light/55 hover:bg-[#112A43] hover:text-white"
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
                <span className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-amber-300/15 bg-amber-300/[0.06] text-amber-100">
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
                  className="h-10 cursor-pointer rounded-xl bg-[#16A34A] px-4 text-sm font-semibold text-white transition-colors hover:bg-[#15803D]"
                  onClick={() => {
                    setPendingNavigationHref("")
                    document.getElementById("comprobante-pago")?.scrollIntoView({
                      behavior: "smooth",
                      block: "center",
                    })
                  }}
                >
                  Subir comprobante ahora
                </button>
                <button
                  type="button"
                  className="h-10 cursor-pointer rounded-xl border border-[#303846] bg-[#141820] px-4 text-sm font-medium text-[#C8C8C8] transition-colors hover:bg-[#1B2028] hover:text-white"
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
