import Link from "next/link"

import { CheckCircle2 } from "lucide-react"

import { Button } from "@/components/ui/button"

export default function CheckoutSuccessPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-black px-4 text-white">
      <div className="w-full max-w-lg rounded-2xl border border-white/10 bg-beyonix-surface p-8 text-center shadow-2xl">
        <div className="mb-6 flex justify-center">
          <div className="flex h-20 w-20 items-center justify-center rounded-full bg-emerald-500/10">
            <CheckCircle2 className="size-12 text-emerald-400" />
          </div>
        </div>

        <p className="mb-2 text-11px font-semibold uppercase tracking-widest text-beyonix-cyan">
          Pago recibido
        </p>

        <h1 className="mb-3 text-3xl font-bold tracking-tight">
          Estamos preparando tu pedido
        </h1>

        <p className="mx-auto mb-8 max-w-md text-sm leading-relaxed text-white/70">
          Pago recibido. Estamos preparando tu pedido.
        </p>

        <div className="space-y-3">
          <Button
            asChild
            type="button"
            aria-label="Ir a productos"
            title="Ir a productos"
            className="h-12 w-full text-base font-semibold"
          >
            <Link href="/productos">
              Seguir comprando
            </Link>
          </Button>

          <Button
            asChild
            type="button"
            aria-label="Ir al inicio"
            title="Ir al inicio"
            variant="outline"
            className="h-12 w-full border-white/15 bg-transparent text-white hover:bg-white/10"
          >
            <Link href="/">
              Volver al inicio
            </Link>
          </Button>
        </div>
      </div>
    </main>
  )
}