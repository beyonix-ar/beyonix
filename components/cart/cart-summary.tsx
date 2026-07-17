"use client"

import { useEffect, useState } from "react"

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
  normalizeMoney,
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
  const [creditInput, setCreditInput] = useState("")
  const totals = calculateCartTotals(items)
  const hasShippingBonus =
    IS_FREE_SHIPPING_ENABLED &&
    totals.productsTotal >= FREE_SHIPPING_MIN
  const displayedTotal = totals.productsTotal
  const maxApplicableCredit = getMaxApplicableCustomerCredit(
    customerCredit.balance,
    displayedTotal
  )
  const creditApplication = calculateCustomerCreditApplication({
    availableBalance: customerCredit.balance,
    eligibleTotal: displayedTotal,
    requestedAmount: customerCredit.appliedAmount,
  })
  const canUseCustomerCredit =
    !customerCredit.loading && maxApplicableCredit > 0

  useEffect(() => {
    if (customerCredit.appliedAmount > maxApplicableCredit) {
      customerCredit.setAppliedAmount(maxApplicableCredit)
      setCreditInput(String(maxApplicableCredit))
    }
  }, [customerCredit, maxApplicableCredit])

  return (
    <div className="space-y-2 border-t border-beyonix-blue-light/60 bg-beyonix-surface px-4 py-2.5">
      <FreeShippingBar subtotal={totals.productsTotal} />

      <div className="rounded-xl border border-beyonix-blue-light/60 bg-beyonix-surface-3 px-3 py-2.5">
        <h3 className="mb-2 text-sm font-bold tracking-wide text-white">
          Resumen del pedido
        </h3>

        <div className="space-y-1.5">
          <div className="flex justify-between text-sm">
            <span className="text-white/60">Subtotal</span>
            <span className="text-white">{formatPrice(totals.subtotal)}</span>
          </div>

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
                hasShippingBonus
                  ? "beyonix-success-glow font-semibold text-emerald-400"
                  : "text-white"
              }`}
            >
              {hasShippingBonus ? "Bonificado" : "A definir"}
            </span>
          </div>

          <Separator />

          {creditApplication.appliedAmount > 0 && (
            <div className="flex items-center justify-between text-sm">
              <span className="text-beyonix-sky">Saldo a favor</span>
              <span className="font-medium tracking-wide text-emerald-400">
                -{formatPrice(creditApplication.appliedAmount)}
              </span>
            </div>
          )}

          <div className="flex justify-between text-base font-bold">
            <span className="text-white">Total</span>
            <span className="text-white">
              {formatPrice(creditApplication.externalAmountDue)}
            </span>
          </div>
        </div>
      </div>

      {(customerCredit.loading || canUseCustomerCredit) && (
        <div className="rounded-xl border border-beyonix-blue-light/28 bg-[#0B1118] px-3 py-2.5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-bold uppercase tracking-widest text-beyonix-sky">
                Saldo a favor
              </p>
              {customerCredit.loading ? (
                <span className="mt-1 block h-4 w-28 animate-pulse rounded-full bg-white/12" />
              ) : (
                <p className="mt-1 text-sm font-semibold text-white">
                  Disponible: {formatPrice(customerCredit.balance)}
                </p>
              )}
            </div>
            {creditApplication.appliedAmount > 0 && (
              <button
                type="button"
                onClick={() => {
                  customerCredit.clearAppliedAmount()
                  setCreditInput("")
                }}
                className="h-8 cursor-pointer rounded-lg border border-white/12 px-2.5 text-xs font-bold text-white/72 transition hover:border-beyonix-blue-light/45 hover:text-white"
              >
                Quitar
              </button>
            )}
          </div>

          {canUseCustomerCredit && (
            <div className="mt-2 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
              <input
                type="text"
                inputMode="decimal"
                aria-label="Monto de saldo a favor"
                value={creditInput}
                onChange={(event) => {
                  const value = event.target.value
                  setCreditInput(value)
                  customerCredit.setAppliedAmount(
                    Math.min(normalizeMoney(value), maxApplicableCredit)
                  )
                }}
                placeholder="Monto"
                className="h-9 rounded-lg border border-beyonix-blue-light/18 bg-black/35 px-3 text-sm font-semibold text-white outline-none placeholder:text-white/35 focus:border-beyonix-blue-light/65"
              />
              <button
                type="button"
                onClick={() => {
                  customerCredit.setAppliedAmount(maxApplicableCredit)
                  setCreditInput(String(maxApplicableCredit))
                }}
                className="h-9 cursor-pointer rounded-lg border border-beyonix-blue-light/35 bg-beyonix-blue/35 px-3 text-xs font-bold text-white transition hover:border-beyonix-blue-light/70 hover:bg-beyonix-blue"
              >
                Aplicar máximo
              </button>
            </div>
          )}
        </div>
      )}

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
        onClick={onCheckout}
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
