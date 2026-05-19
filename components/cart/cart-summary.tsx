"use client"

import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { FreeShippingBar } from "./free-shipping-bar"
import { getProductDiscount, ACTIVE_SALE_EVENT } from "@/lib/store-config"

interface Props {
  subtotal: number
  items: { product: { id: number; price: number }; quantity: number }[]
  onCheckout: () => void
}

const formatPrice = (price: number) =>
  new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    minimumFractionDigits: 0,
  }).format(price)

export function CartSummary({
  subtotal,
  items,
  onCheckout,
}: Props) {
  const FREE_SHIPPING_MIN = 90000

  const isFreeShipping = subtotal >= FREE_SHIPPING_MIN
  const shippingCost = isFreeShipping ? 0 : 14000

  // 🔥 NUEVO: cálculo real de descuento por productos
  const discount = items.reduce((acc, item) => {
    const rate = getProductDiscount(item.product.id)
    if (!rate) return acc

    return acc + item.product.price * rate * item.quantity
  }, 0)

  const finalTotal = subtotal + shippingCost - discount

  return (
    <div className="p-4 border-t border-border space-y-4">
      
      {/* Barra envío */}
      <FreeShippingBar subtotal={subtotal} />

      {/* Totales */}
      <div className="space-y-2">
        <div className="flex justify-between text-sm">
          <span className="text-white/80">Subtotal</span>
          <span className="text-white">{formatPrice(subtotal)}</span>
        </div>

        {/* 🔥 NUEVO: descuento (solo si existe) */}
        {discount > 0 && (
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
              -{formatPrice(discount)}
            </span>
          </div>
        )}

        <div className="flex justify-between text-sm">
          <span className="text-white/80">Envío</span>
          <span
            className={`${
              isFreeShipping
                ? "text-emerald-400 font-semibold drop-shadow-[0_0_6px_rgba(16,185,129,0.5)]"
                : "text-white"
            }`}
          >
            {isFreeShipping ? "¡Gratis!" : formatPrice(shippingCost)}
          </span>
        </div>

        <Separator />

        <div className="flex justify-between font-bold text-lg">
          <span className="text-white">Total</span>
          <span className="text-white">{formatPrice(finalTotal)}</span>
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

      {/* CTA */}
      <Button
        type="button"
        className="w-full h-12 text-base font-semibold bg-black text-white hover:bg-gray-800 transition-colors"
        size="lg"
        onClick={onCheckout}
      >
        Finalizar compra
      </Button>

      <Button
        type="button"
        size="lg"
        className="w-full h-11 text-sm font-medium bg-black text-white hover:bg-gray-800 transition-colors"
      >
        Seguir comprando
      </Button>
    </div>
  )
}