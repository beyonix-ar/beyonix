"use client"

import { Suspense, useEffect, useRef, useState } from "react"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import {
  CheckCircle2,
  Clock3,
  Landmark,
  ShieldCheck,
  Upload,
} from "lucide-react"

import { Footer } from "@/components/footer"
import { CustomerPaymentProof } from "@/components/customer-payment-proof"
import { Button } from "@/components/ui/button"
import { useCart } from "@/context/cart-context"
import { TRANSFER_ALIAS } from "@/lib/payments/transfer"
import type { SupabasePedido } from "@/lib/supabase/types"

function CheckoutSuccessContent() {
  const { clearCart } = useCart()
  const hasClearedCartRef = useRef(false)
  const searchParams = useSearchParams()
  const isTransfer = searchParams.get("method") === "transferencia"
  const orderId = Number(searchParams.get("order_id"))
  const [order, setOrder] = useState<SupabasePedido | null>(null)
  const [orderLoading, setOrderLoading] = useState(isTransfer)
  const [orderError, setOrderError] = useState("")

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

      try {
        const response = await fetch(`/api/payment-proofs/${orderId}`, {
          cache: "no-store",
        })
        const data = (await response.json()) as {
          order?: SupabasePedido
          error?: string
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

  return (
    <>
      <main className="bg-beyonix-page px-4 py-8 text-white sm:py-10">
        <div className="mx-auto w-full max-w-5xl rounded-3xl border border-white/10 bg-[#111111] p-5 shadow-2xl shadow-black/50 sm:p-8">
          <div className="flex flex-col items-center border-b border-white/8 pb-6 text-center">
            <div className="flex size-16 items-center justify-center rounded-full border border-emerald-400/20 bg-emerald-400/10">
              <CheckCircle2 className="size-9 text-emerald-400" />
            </div>

            <p className="mt-4 text-11px font-semibold uppercase tracking-widest text-beyonix-cyan">
              {isTransfer ? "Pedido registrado" : "Pago recibido"}
            </p>

            <h1 className="mt-2 max-w-2xl text-2xl font-bold tracking-tight sm:text-3xl">
              {isTransfer ? "Tu pedido fue registrado correctamente" : "Estamos preparando tu pedido"}
            </h1>

            {Number.isFinite(orderId) && orderId > 0 && (
              <p className="mt-2 text-sm text-white/45">
                Pedido #{orderId}
              </p>
            )}
          </div>

          {isTransfer ? (
            <div className="grid gap-6 py-6 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
              <section className="rounded-2xl border border-white/8 bg-[#181818] p-5">
                <h2 className="border-l-4 border-beyonix-blue pl-3 text-lg font-semibold">
                  Completá el pago
                </h2>

                <div className="mt-5 rounded-2xl border border-beyonix-blue-light/25 bg-[#112A43]/45 p-4">
                  <div className="flex items-center gap-3">
                    <span className="flex size-10 items-center justify-center rounded-xl bg-beyonix-blue text-beyonix-sky">
                      <Landmark className="size-5" />
                    </span>
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wider text-white/45">
                        Alias de transferencia
                      </p>
                      <p className="mt-1 text-xl font-bold uppercase tracking-wide text-white">
                        {TRANSFER_ALIAS}
                      </p>
                    </div>
                  </div>
                </div>

                <div className="mt-5 space-y-4">
                  {[
                    {
                      icon: Landmark,
                      title: "Realizá la transferencia",
                      text: `Transferí el total del pedido al alias ${TRANSFER_ALIAS.toUpperCase()}.`,
                    },
                    {
                      icon: Upload,
                      title: "Subí el comprobante",
                      text: "Adjuntá una captura, imagen o PDF desde el sector de carga.",
                    },
                    {
                      icon: ShieldCheck,
                      title: "Validamos tu pago",
                      text: "Cuando lo confirmemos, comenzaremos a preparar tu pedido.",
                    },
                  ].map((item, index) => (
                    <div key={item.title} className="flex gap-3">
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-beyonix-blue-light/20 bg-beyonix-blue/20 text-beyonix-sky">
                        <item.icon className="size-4" />
                      </span>
                      <div>
                        <p className="text-sm font-semibold text-white">
                          {index + 1}. {item.title}
                        </p>
                        <p className="mt-1 text-sm leading-6 text-white/55">
                          {item.text}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="mt-5 flex gap-3 rounded-xl border border-white/8 bg-black/25 p-4">
                  <Clock3 className="mt-0.5 size-5 shrink-0 text-beyonix-sky" />
                  <div>
                    <p className="text-sm font-semibold text-white">Validación de pagos</p>
                    <p className="mt-1 text-xs leading-5 text-white/50">
                      Lunes a viernes de 7:00 a 20:00 hs · Sábados de 8:00 a 14:00 hs
                    </p>
                  </div>
                </div>
              </section>

              <section className="rounded-2xl border border-white/8 bg-[#181818] p-5">
                <h2 className="border-l-4 border-beyonix-blue pl-3 text-lg font-semibold">
                  Comprobante de pago
                </h2>
                <p className="mt-3 text-sm leading-6 text-white/55">
                  Subí una captura legible donde se vea la operación. Podés elegirla desde cualquier dispositivo o arrastrarla al área de carga.
                </p>

                <div className="mt-5">
                  {orderLoading ? (
                    <div className="h-52 animate-pulse rounded-2xl border border-white/8 bg-[#141414]" />
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

          <div className="grid gap-3 border-t border-white/8 pt-6 sm:grid-cols-2">
            <Button
              asChild
              type="button"
              aria-label="Ir a productos"
              title="Ir a productos"
              className="h-12 w-full bg-beyonix-blue text-base font-semibold text-white hover:bg-beyonix-blue-hover"
            >
              <Link href="/productos">Seguir comprando</Link>
            </Button>

            <Button
              asChild
              type="button"
              aria-label="Ir al inicio"
              title="Ir al inicio"
              variant="outline"
              className="h-12 w-full border-white/15 bg-transparent text-white hover:border-beyonix-blue-light/55 hover:bg-[#112A43]"
            >
              <Link href="/">Volver al inicio</Link>
            </Button>
          </div>
        </div>
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
