import Link from "next/link"
import { Clock3 } from "lucide-react"

import {
  BeyonixButton,
} from "@/components/beyonix-ui"
import {
  CheckoutStatusCard,
  CheckoutStatusShell,
} from "@/components/checkout/checkout-status-layout"

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
          <BeyonixButton
            asChild
            type="button"
            size="lg"
            aria-label="Volver al inicio"
            title="Volver al inicio"
            className="w-full"
          >
            <Link href="/">Volver al inicio</Link>
          </BeyonixButton>
        }
      />
    </CheckoutStatusShell>
  )
}
