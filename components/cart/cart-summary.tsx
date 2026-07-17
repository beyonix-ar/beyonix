"use client"

import { useEffect } from "react"

import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { FreeShippingBar } from "./free-shipping-bar"
import { useCustomerCredit } from "@/context/customer-credit-context"
import {
  ACTIVE_SALE_EVENT,
  FREE_SHIPPING_MIN,
  IS_FREE_SHIPPING_ENABLED,
} from "@/lib/store-config"
import { calculateCartTotals } from "@/lib/cart/cart-totals"
import {
  calculateCustomerCreditApplication,
  getMaxApplicableCustomerCredit,
} from "@/lib/customer-credit"

interface Props {
  subtotal: number
  items: { product: { id: number; precio: number }; quantity: number }[]
  onCheckout: () => void
  onContinueShopping: () => void
}

const formatPrice = (price: number) =>
  new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    minimumFractionDigits: 0,
  }).format(price)

export function CartSummary({
  items,
  onCheckout,
  onContinueShopping,
}: Props) {
  const customerCredit = useCustomerCredit()
  const totals = calculateCartTotals(items)
  const hasShippingBonus =
    IS_FREE_SHIPPING_ENABLED &&
    totals.productsTotal >= FREE_SHIPPING_MIN
  const shippingCoveredByBeyonix = customerCredit.balance > 0
  const displayedTotal = totals.productsTotal
  const maxApplicableCredit = getMaxApplicableCustomerCredit(
    customerCredit.balance,
    displayedTotal
  )
  const creditApplication = calculateCustomerCreditApplication({
    availableBalance: customerCredit.balance,
    eligibleTotal: displayedTotal,
    requestedAmount: maxApplicableCredit,
  })
  const showCustomerCreditRow = creditApplication.appliedAmount > 0

  useEffect(() => {
    if (customerCredit.loading && customerCredit.balance <= 0) return

    if (Math.abs(customerCredit.appliedAmount - maxApplicableCredit) > 0.009) {
      customerCredit.setAppliedAmount(maxApplicableCredit)
    }
  }, [
    customerCredit.loading,
    customerCredit.appliedAmount,
    customerCredit.setAppliedAmount,
    maxApplicableCredit,
  ])

  const handleCheckout = () => {
    if (!customerCredit.loading || customerCredit.balance > 0) {
      customerCredit.setAppliedAmount(maxApplicableCredit)
    }

    onCheckout()
  }

  return (
    <div className="space-y-2 border-t border-beyonix-blue-light/60 bg-beyonix-surface px-4 py-2.5">
      <FreeShippingBar
        subtotal={totals.productsTotal}
        coveredByBeyonix={shippingCoveredByBeyonix}
      />

      <div className="rounded-xl border border-beyonix-blue-light/60 bg-beyonix-surface-3 px-3 py-2.5">
        <h3 className="mb-2 text-sm font-bold tracking-wide text-white">
          Resumen del pedido
        </h3>

        <div className="space-y-1.5">
          <div className="flex justify-between text-sm">
            <span className="text-white/60">Subtotal</span>
            <span className="text-white">{formatPrice(totals.subtotal)}</span>
          </div>

          {showCustomerCreditRow && (
            <div className="flex items-center justify-between text-sm">
              <span className="text-beyonix-sky">Saldo a favor</span>
              <span className="font-semibold tracking-wide text-emerald-400">
                -{formatPrice(creditApplication.appliedAmount)}
              </span>
            </div>
          )}

          {totals.discount > 0 && (
            <div className="flex items-center justify-between text-sm">
              <span className="flex items-center gap-2 text-beyonix-sky">
                Descuento
                {ACTIVE_SALE_EVENT !== "none" && (
                  <span className="text-9px tracking-wide text-emerald-400/80">
                    {ACTIVE_SALE_EVENT.toUpperCase()}
                  </span>
                )}
              </span>

              <span className="font-medium tracking-wide text-emerald-400">
                -{formatPrice(totals.discount)}
              </span>
            </div>
          )}

          <div className="flex justify-between text-sm">
            <span className="text-white/60">Envío</span>
            <span
              className={`${
                shippingCoveredByBeyonix
                  ? "font-bold text-emerald-400"
                  : hasShippingBonus
                  ? "beyonix-success-glow font-semibold text-emerald-400"
                  : "text-white"
              }`}
            >
              {shippingCoveredByBeyonix
                ? "GRATIS"
                : hasShippingBonus
                  ? "Bonificado"
                  : "A definir"}
            </span>
          </div>

          <Separator />

          <div className="flex justify-between text-base font-bold">
            <span className="text-white">Total</span>
            <span className="text-white">
              {formatPrice(creditApplication.externalAmountDue)}
            </span>
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-white/10 bg-black px-3 py-1.5 text-center font-heading">
        <p className="text-sm font-bold tracking-widest text-white">
          IMPORTANTE
        </p>

        <p className="text-xs font-medium leading-snug text-white">
          Verificá variante y color antes de finalizar la compra
        </p>
      </div>

      <Button
        type="button"
        aria-label="Finalizar compra"
        title="Finalizar compra"
        className="h-10 w-full text-sm font-semibold text-white transition-colors"
        style={{ backgroundColor: "#112A43" }}
        onMouseEnter={(event) => {
          event.currentTarget.style.backgroundColor = "#1E4A73"
        }}
        onMouseLeave={(event) => {
          event.currentTarget.style.backgroundColor = "#112A43"
        }}
        size="lg"
        onClick={handleCheckout}
      >
        Finalizar compra
      </Button>

      <Button
        type="button"
        aria-label="Seguir comprando"
        title="Seguir comprando"
        size="lg"
        className="h-9 w-full border border-beyonix-blue-light bg-black text-sm font-medium text-white transition-colors"
        onMouseEnter={(event) => {
          event.currentTarget.style.backgroundColor = "#1E4A73"
        }}
        onMouseLeave={(event) => {
          event.currentTarget.style.backgroundColor = "black"
        }}
        onClick={onContinueShopping}
      >
        Seguir comprando
      </Button>
    </div>
  )
}
