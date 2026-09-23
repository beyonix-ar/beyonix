import Link from "next/link"
import { XCircle } from "lucide-react"

import {
  CheckoutStatusCard,
  CheckoutStatusShell,
} from "@/components/checkout/checkout-status-layout"

export default function CheckoutFailurePage() {
  return (
    <CheckoutStatusShell>
      <CheckoutStatusCard
        tone="failure"
        icon={XCircle}
        eyebrow="Pago no completado"
        title="No pudimos completar tu pago"
        compact
        footer={
          <div className="grid gap-2.5 sm:grid-cols-2">
            <Link
              href="/productos"
              aria-label="Volver a la tienda"
              title="Volver a la tienda"
              className="flex h-10 w-full cursor-pointer items-center justify-center rounded-lg border border-[var(--account-border)] bg-[var(--account-surface)] text-sm font-semibold text-[var(--account-text-primary)] transition-colors duration-200 hover:bg-[var(--account-surface-hover)]"
            >
              Volver a la tienda
            </Link>

            <Link
              href="/checkout"
              aria-label="Volver al checkout"
              title="Volver al checkout"
              className="flex h-10 w-full cursor-pointer items-center justify-center rounded-lg bg-[var(--account-accent)] text-sm font-semibold text-white shadow-sm transition-colors duration-200 hover:bg-[var(--account-accent-hover)]"
            >
              Volver al checkout
            </Link>
          </div>
        }
      >
        <p className="mx-auto max-w-md py-6 text-center text-sm leading-relaxed text-[var(--account-text-secondary)]">
          Mercado Pago rechazó el intento de pago y tu compra no se completó.
          Podés volver al checkout para reintentarlo o seguir viendo nuestros
          productos.
        </p>
      </CheckoutStatusCard>
    </CheckoutStatusShell>
  )
}
