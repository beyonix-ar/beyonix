import Link from "next/link"
import { Clock3 } from "lucide-react"

import {
  CheckoutStatusCard,
  CheckoutStatusShell,
} from "@/components/checkout/checkout-status-layout"

// Mercado Pago vuelve acá sin un id de pedido confiable (external_reference
// es el UUID interno), así que no se arma una URL de pedido: se lleva a
// Mis compras, que ya lista el pedido con su estado.
export default function CheckoutPendingPage() {
  return (
    <CheckoutStatusShell>
      <CheckoutStatusCard
        tone="pending"
        icon={Clock3}
        eyebrow="Pago pendiente"
        title="Tu pago está pendiente de confirmación"
        description="Cuando Mercado Pago confirme el pago, el pedido se actualizará automáticamente."
        className="mx-auto max-w-lg"
        footer={
          <div className="space-y-3">
            <p className="text-center text-sm text-[var(--account-text-secondary)]">
              Podés seguir el estado desde Mis compras.
            </p>
            <div className="grid gap-2.5 sm:grid-cols-2">
              <Link
                href="/"
                aria-label="Volver al inicio"
                title="Volver al inicio"
                className="flex h-10 w-full cursor-pointer items-center justify-center rounded-lg border border-[var(--account-border)] bg-[var(--account-surface)] text-sm font-semibold text-[var(--account-text-primary)] transition-colors duration-200 hover:bg-[var(--account-surface-hover)]"
              >
                Volver al inicio
              </Link>

              <Link
                href="/cuenta?tab=ordenes"
                aria-label="Ir a Mis compras"
                title="Ir a Mis compras"
                className="flex h-10 w-full cursor-pointer items-center justify-center rounded-lg bg-[var(--account-accent)] text-sm font-semibold text-white shadow-sm transition-colors duration-200 hover:bg-[var(--account-accent-hover)]"
              >
                Ir a Mis compras
              </Link>
            </div>
          </div>
        }
      />
    </CheckoutStatusShell>
  )
}
