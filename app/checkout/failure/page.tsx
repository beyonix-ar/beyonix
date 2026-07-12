import Link from "next/link"
import { XCircle } from "lucide-react"

import {
  BeyonixButton,
} from "@/components/beyonix-ui"
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
        eyebrow="Pago rechazado"
        title="El pago no pudo completarse"
        description="No se registró el pago. Podés volver al checkout e intentarlo nuevamente."
        className="mx-auto max-w-lg"
        footer={
          <BeyonixButton
            asChild
            type="button"
            size="lg"
            aria-label="Volver al checkout"
            title="Volver al checkout"
            className="w-full"
          >
            <Link href="/checkout">Volver al checkout</Link>
          </BeyonixButton>
        }
      />
    </CheckoutStatusShell>
  )
}
