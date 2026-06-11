"use client"

import { Suspense, useEffect, useRef } from "react"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { CheckCircle2 } from "lucide-react"

import { PaymentProofUploader } from "@/components/payment-proof-uploader"
import { Button } from "@/components/ui/button"
import { useCart } from "@/context/cart-context"
import { TRANSFER_ALIAS } from "@/lib/payments/transfer"

function CheckoutSuccessContent() {
  const { clearCart } = useCart()
  const hasClearedCartRef = useRef(false)
  const searchParams = useSearchParams()
  const isTransfer = searchParams.get("method") === "transferencia"
  const orderId = Number(searchParams.get("order_id"))
  const proofUploaded = searchParams.get("proof") === "1"

  useEffect(() => {
    if (hasClearedCartRef.current) return

    hasClearedCartRef.current = true
    clearCart()
  }, [clearCart])

  return (
    <main className="flex min-h-screen items-center justify-center bg-black px-4 py-12 text-white">
      <div className="w-full max-w-lg rounded-2xl border border-white/10 bg-beyonix-surface p-8 text-center shadow-2xl">
        <div className="mb-6 flex justify-center">
          <div className="flex h-20 w-20 items-center justify-center rounded-full bg-emerald-500/10">
            <CheckCircle2 className="size-12 text-emerald-400" />
          </div>
        </div>

        <p className="mb-2 text-11px font-semibold uppercase tracking-widest text-beyonix-cyan">
          {isTransfer ? "Pedido registrado" : "Pago recibido"}
        </p>

        <h1 className="mb-3 text-3xl font-bold tracking-tight">
          {isTransfer ? "Tu pedido fue registrado correctamente." : "Estamos preparando tu pedido"}
        </h1>

        {isTransfer ? (
          <div className="mx-auto mb-8 max-w-md space-y-3 text-left text-sm leading-relaxed text-white/70">
            <p>Transferí al alias: <span className="font-black uppercase text-beyonix-sky">{TRANSFER_ALIAS}</span></p>
            <p>Luego subí el comprobante para validar tu pago.</p>
            <p>El pago será verificado manualmente dentro del horario de atención.</p>
            <p>Una vez confirmado el pago, prepararemos tu pedido.</p>
            {Number.isFinite(orderId) && orderId > 0 && (
              <PaymentProofUploader
                orderId={orderId}
                initialUploaded={proofUploaded}
              />
            )}
          </div>
        ) : (
          <p className="mx-auto mb-8 max-w-md text-sm leading-relaxed text-white/70">
            Pago recibido. Estamos preparando tu pedido.
          </p>
        )}

        <div className="space-y-3">
          <Button
            asChild
            type="button"
            aria-label="Ir a productos"
            title="Ir a productos"
            className="h-12 w-full text-base font-semibold"
          >
            <Link href="/productos">Seguir comprando</Link>
          </Button>

          <Button
            asChild
            type="button"
            aria-label="Ir al inicio"
            title="Ir al inicio"
            variant="outline"
            className="h-12 w-full border-white/15 bg-transparent text-white hover:bg-white/10"
          >
            <Link href="/">Volver al inicio</Link>
          </Button>
        </div>
      </div>
    </main>
  )
}

export default function CheckoutSuccessPage() {
  return (
    <Suspense fallback={null}>
      <CheckoutSuccessContent />
    </Suspense>
  )
}
