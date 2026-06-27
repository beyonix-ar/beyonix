import Link from "next/link"
import { Clock3 } from "lucide-react"

import { Button } from "@/components/ui/button"

export default function CheckoutPendingPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-black px-4 text-white">
      <div className="w-full max-w-lg rounded-2xl border border-white/10 bg-beyonix-surface p-8 text-center shadow-2xl">
        <div className="mb-6 flex justify-center">
          <div className="flex h-20 w-20 items-center justify-center rounded-full bg-amber-500/10">
            <Clock3 className="size-12 text-amber-400" />
          </div>
        </div>

        <p className="mb-2 text-11px font-semibold uppercase tracking-widest text-beyonix-cyan">
          Pago pendiente
        </p>

        <h1 className="mb-3 text-3xl font-bold tracking-tight">
          Tu pago está pendiente de confirmación
        </h1>

        <p className="mx-auto mb-8 max-w-md text-sm leading-relaxed text-white/70">
          Cuando Mercado Pago confirme el pago, el pedido se actualizará automáticamente.
        </p>

        <Button
          asChild
          type="button"
          aria-label="Volver al inicio"
          title="Volver al inicio"
          className="h-12 w-full text-base font-semibold"
        >
          <Link href="/">Volver al inicio</Link>
        </Button>
      </div>
    </main>
  )
}
