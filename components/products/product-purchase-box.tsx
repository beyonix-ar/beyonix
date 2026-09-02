"use client"

import { useEffect, useState } from "react"
import { CheckCircle2, ChevronDown, ShieldCheck, Truck } from "lucide-react"

import { BeyonixButton } from "@/components/beyonix-ui"

import { ProductCartToggleButton } from "./product-cart-toggle-button"
import { getDiscountPercent } from "@/lib/products/product-variants"

interface ProductPurchaseBoxProps {
  price: number
  originalPrice?: number
  /** Mayor modalidad de cuotas habilitada, ya formateada (ver `getMaxInstallmentPlanLabel`). */
  maxInstallmentLabel?: string | null
  /** Todas las modalidades habilitadas, para el detalle desplegable "Ver opciones". */
  installmentsLabels?: string[]
  isInCart?: boolean
  cartQuantity?: number
  maxReached?: boolean
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

export function ProductPurchaseBox({
  price,
  originalPrice,
  maxInstallmentLabel = null,
  installmentsLabels = [],
  isInCart = false,
  cartQuantity = 0,
  maxReached = false,
  onAddToCart,
  onDecreaseCart,
  onRemoveFromCart,
  onViewCart,
}: ProductPurchaseBoxProps) {
  const [quantity, setQuantity] = useState(cartQuantity)
  const [showInstallmentOptions, setShowInstallmentOptions] = useState(false)

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

      {!!maxInstallmentLabel && (
        <div className="mb-3">
          <p className="beyonix-modal-title text-14px font-semibold text-white">
            {maxInstallmentLabel}
          </p>

          {installmentsLabels.length > 1 && (
            <button
              type="button"
              onClick={() => setShowInstallmentOptions((current) => !current)}
              className="mt-1 inline-flex items-center gap-1 text-12px font-medium text-beyonix-sky/85 transition-colors hover:text-beyonix-sky"
            >
              Ver opciones de financiación
              <ChevronDown
                className={`size-3.5 transition-transform ${showInstallmentOptions ? "rotate-180" : ""}`}
              />
            </button>
          )}

          {showInstallmentOptions && installmentsLabels.length > 1 && (
            <ul className="mt-2 space-y-1 border-l border-[#21476B]/65 pl-3">
              {installmentsLabels.map((label) => (
                <li key={label} className="beyonix-modal-body text-12px font-medium text-white/70">
                  {label}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="beyonix-modal-muted mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-12px font-medium text-white/45">
        <span className="inline-flex items-center gap-1 whitespace-nowrap">
          <ShieldCheck className="beyonix-modal-muted-icon size-3.5 shrink-0 text-white/45" />
          Garantía de 6 meses
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
    </div>
  )
}
