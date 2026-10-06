"use client"

import { useEffect, useState } from "react"
import { CheckCircle2, ShieldCheck, Truck } from "lucide-react"

import { BeyonixButton } from "@/components/beyonix-ui"
import { PaymentMethodLogoStrip } from "@/components/payments/payment-method-logo-tile"

import { ProductCartToggleButton } from "./product-cart-toggle-button"
import { getDiscountPercent } from "@/lib/products/product-variants"
import { DEFAULT_PRODUCT_WARRANTY_MONTHS } from "@/lib/orders/warranty-policy"
import { usePaymentMethodLogos } from "@/lib/payments/use-payment-method-logos"

interface ProductPurchaseBoxProps {
  price: number
  originalPrice?: number
  transferPrice?: number | null
  transferDiscountPercent?: number
  /**
   * Regla GLOBAL vigente de cuotas sin interés ("Hasta N cuotas sin interés a
   * partir de $X"), confirmada por Mercado Pago. `null`: no se comunica nada.
   */
  interestFreeText?: string | null
  priceWithoutNationalTaxesCash?: number | null
  isInCart?: boolean
  cartQuantity?: number
  maxReached?: boolean
  /** Motivo real por el que no se puede sumar otra unidad. */
  limitMessage?: string | null
  onAddToCart: (quantity?: number) => void
  onDecreaseCart: () => void
  onRemoveFromCart: () => void
  onViewCart: () => void
}

function formatPrice(price: number) {
  return new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    minimumFractionDigits: 0,
  }).format(price)
}

/** "10" -> "10%", "7.5" -> "7,5%" -- nunca fuerza un decimal ",0" innecesario. */
function formatOffPercent(value: number) {
  return new Intl.NumberFormat("es-AR", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 1,
  }).format(value)
}

export function ProductPurchaseBox({
  price,
  originalPrice,
  transferPrice = null,
  transferDiscountPercent = 0,
  interestFreeText = null,
  priceWithoutNationalTaxesCash = null,
  isInCart = false,
  cartQuantity = 0,
  maxReached = false,
  limitMessage = null,
  onAddToCart,
  onDecreaseCart,
  onRemoveFromCart,
  onViewCart,
}: ProductPurchaseBoxProps) {
  const [quantity, setQuantity] = useState(cartQuantity)

  useEffect(() => {
    setQuantity(cartQuantity)
  }, [cartQuantity, isInCart])

  const handleAdd = () => {
    setQuantity(1)
    onAddToCart(1)
  }

  const handleIncrease = () => {
    if (maxReached) return

    setQuantity((current) => current + 1)
    onAddToCart(1)
  }

  const handleDecrease = () => {
    if (quantity <= 1) {
      setQuantity(0)
      onRemoveFromCart()
      return
    }

    setQuantity((current) => current - 1)
    onDecreaseCart()
  }

  const discount = getDiscountPercent(price, originalPrice)
  // Sólo logos cargados en Admin y disponibles hoy (Mercado Pago o habilitados a mano).
  const paymentLogos = usePaymentMethodLogos() ?? []

  return (
    <div className="bg-transparent px-5 pb-5 pt-4 md:px-7 md:pb-6 md:pt-5">
      <div className="mb-3 flex flex-wrap items-end gap-2.5">
        <span className="beyonix-modal-title text-[28px] font-black leading-none tracking-tight text-white md:text-[32px]">
          {formatPrice(price)}
        </span>

        {discount && (
          <span className="beyonix-discount-badge rounded-lg border border-emerald-300/30 bg-emerald-400/16 px-3 py-1.5 text-13px font-bold leading-none text-emerald-200">
            -{discount}%
          </span>
        )}

        {originalPrice && originalPrice > price && (
          <span className="beyonix-modal-body pb-0.5 text-15px leading-none text-white/62 line-through">
            {formatPrice(originalPrice)}
          </span>
        )}
      </div>

      {transferPrice != null && transferPrice < price && (
        <p className="beyonix-modal-body mb-2 text-13px font-semibold text-white/85">
          Transferencia {formatPrice(transferPrice)}{" "}
          <span className="beyonix-success-text text-emerald-400 font-bold">
            ({formatOffPercent(transferDiscountPercent)}% OFF)
          </span>
        </p>
      )}

      {interestFreeText && (
        <p data-interest-free-global className="beyonix-modal-title mb-2 text-14px font-semibold text-white">
          {interestFreeText}
        </p>
      )}

      {priceWithoutNationalTaxesCash != null && (
        <p className="beyonix-modal-muted mb-3 text-10px font-medium leading-4 text-white/40">
          Precio s/imp. nac.: {formatPrice(priceWithoutNationalTaxesCash)}
        </p>
      )}

      <div className="beyonix-modal-muted mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-12px font-medium text-white/45">
        <span className="inline-flex items-center gap-1 whitespace-nowrap">
          <ShieldCheck className="beyonix-modal-muted-icon size-3.5 shrink-0 text-white/45" />
          Garantía legal de {DEFAULT_PRODUCT_WARRANTY_MONTHS} meses
        </span>
        <span aria-hidden="true">·</span>
        <span className="inline-flex items-center gap-1 whitespace-nowrap">
          <Truck className="beyonix-modal-muted-icon size-3.5 shrink-0 text-white/45" />
          Envíos a todo el país
        </span>
        <span aria-hidden="true">·</span>
        <span className="inline-flex items-center gap-1 whitespace-nowrap">
          <CheckCircle2 className="beyonix-modal-muted-icon size-3.5 shrink-0 text-white/45" />
          Compra segura
        </span>
      </div>

      {/* Grid 1fr/1fr, no dos anchos fijos calculados por separado: ambas
          columnas siempre miden exactamente lo mismo. "Añadir al carrito" y
          el selector "− 1 +" se renderizan a `w-full` dentro de la primera
          columna, así ninguno de los dos estados puede desplazar a
          "Ver carrito" ni cambiar de tamaño entre sí. */}
      <div className="grid gap-2.5 sm:grid-cols-2 sm:items-center">
        <div className="w-full">
          <ProductCartToggleButton
            quantity={quantity}
            maxReached={maxReached}
            limitMessage={limitMessage}
            onAdd={handleAdd}
            onIncrease={handleIncrease}
            onDecrease={handleDecrease}
          />
        </div>

        <BeyonixButton
          variant="primary"
          size="lg"
          aria-label="Ver carrito"
          onClick={onViewCart}
          className="w-full px-5 text-14px"
        >
          Ver carrito
        </BeyonixButton>
      </div>

      {maxReached && limitMessage && (
        <p
          role="status"
          data-quantity-limit-message
          className="beyonix-modal-muted mt-2 text-12px leading-5 text-white/65"
        >
          {limitMessage}
        </p>
      )}

      <PaymentMethodLogoStrip logos={paymentLogos} className="mt-3.5" />
    </div>
  )
}
