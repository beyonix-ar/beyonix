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
    <div className="p-4 border-t border-border space-y-4">
      
      <FreeShippingBar subtotal={totals.productsTotal} />

      <div className="space-y-2">
        <div className="flex justify-between text-sm">
          <span className="text-white/80">Subtotal</span>
          <span className="text-white">{formatPrice(totals.subtotal)}</span>
        </div>

        {totals.discount > 0 && (
          <div className="flex justify-between text-sm items-center">
            <span className="text-white/80 flex items-center gap-2">
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
          <span className="text-white/80">Envío</span>
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

      <div className="border border-white/20 rounded-md px-3 py-3 text-center">
        <p className="text-default tracking-widest text-white/80 mb-0">
          IMPORTANTE
        </p>

        <p className="text-sm text-white">
          Verificá variante y color antes de finalizar la compra
        </p>
      </div>

      <Button
        type="button"
        aria-label="Finalizar compra"
        title="Finalizar compra"
        className="w-full h-12 text-base font-semibold bg-black text-white hover:bg-gray-800 transition-colors"
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
        className="w-full h-11 text-sm font-medium bg-black text-white hover:bg-gray-800 transition-colors"
        onClick={onContinueShopping}
      >
        Seguir comprando
      </Button>
    </div>
  )
}
