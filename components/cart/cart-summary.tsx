"use client"

import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { FreeShippingBar } from "./free-shipping-bar"
import {
  ACTIVE_SALE_EVENT,
  hasFreeShipping,
} from "@/lib/store-config"
import { calculateCartTotals } from "@/lib/cart/cart-totals"

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
  const totals = calculateCartTotals(items)
  const isFreeShipping = hasFreeShipping(totals.productsTotal)

  return (
    <div className="space-y-4 border-t border-beyonix-blue-light bg-beyonix-surface p-4">
      
      <FreeShippingBar subtotal={totals.productsTotal} />

      <div className="space-y-2 rounded-xl border border-beyonix-blue-light bg-beyonix-surface-3 p-3">
        <div className="flex justify-between text-sm">
          <span className="text-beyonix-sky">Subtotal</span>
          <span className="text-white">{formatPrice(totals.subtotal)}</span>
        </div>

        {totals.discount > 0 && (
          <div className="flex justify-between text-sm items-center">
            <span className="flex items-center gap-2 text-beyonix-sky">
              Descuento
              {ACTIVE_SALE_EVENT !== "none" && (
                <span className="text-9px text-emerald-400/80 tracking-wide">
                  {ACTIVE_SALE_EVENT.toUpperCase()}
                </span>
              )}
            </span>

            <span className="text-emerald-400 font-medium tracking-wide">
              -{formatPrice(totals.discount)}
            </span>
          </div>
        )}

        <div className="flex justify-between text-sm">
          <span className="text-beyonix-sky">Envío</span>
          <span
            className={`${
              isFreeShipping
                ? "text-emerald-400 font-semibold beyonix-success-glow"
                : "text-white"
            }`}
          >
            {isFreeShipping ? "GRATIS" : formatPrice(totals.shipping)}
          </span>
        </div>

        <Separator />

        <div className="flex justify-between font-bold text-lg">
          <span className="text-white">Total</span>
          <span className="text-white">{formatPrice(totals.total)}</span>
        </div>
      </div>

      <div className="rounded-md border border-white/10 bg-black px-3 py-2 text-center">
        <p className="text-11px mb-0 tracking-widest text-beyonix-blue">
          IMPORTANTE
        </p>

        <p className="text-xs text-white">
          Verificá variante y color antes de finalizar la compra
        </p>
      </div>

      <Button
        type="button"
        aria-label="Finalizar compra"
        title="Finalizar compra"
        className="h-12 w-full bg-beyonix-blue text-base font-semibold text-white transition-colors hover:bg-beyonix-blue-hover"
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
        className="h-11 w-full border border-beyonix-blue-light bg-black text-sm font-medium text-white transition-colors hover:bg-beyonix-blue"
        onClick={onContinueShopping}
      >
        Seguir comprando
      </Button>
    </div>
  )
}
