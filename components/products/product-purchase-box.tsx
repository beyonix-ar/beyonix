"use client"

import { useEffect, useState } from "react"
import { CheckCircle2, ChevronDown, ShieldCheck, Truck } from "lucide-react"

import { BeyonixButton } from "@/components/beyonix-ui"

import { ProductCartToggleButton } from "./product-cart-toggle-button"
import { getDiscountPercent } from "@/lib/products/product-variants"
import type { InstallmentPlan } from "@/lib/pricing/financed-pricing"

interface ProductPurchaseBoxProps {
  price: number
  originalPrice?: number
  transferPrice?: number | null
  transferDiscountPercent?: number
  /** Precio financiado total (constante, calculado con la cuota máxima habilitada). `null` si el producto no financia. */
  financedPrice?: number | null
  /** Todas las modalidades habilitadas, en orden ascendente, mismo `financedPrice`. */
  installmentPlans?: InstallmentPlan[]
  /** CFTEA anual (%), sólo cuando hay financiación real (nunca en 1 pago). */
  cfteaPercent?: number | null
  priceWithoutNationalTaxesCash?: number | null
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

function formatPercent(value: number) {
  return new Intl.NumberFormat("es-AR", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(value)
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
  financedPrice = null,
  installmentPlans = [],
  cfteaPercent = null,
  priceWithoutNationalTaxesCash = null,
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
  const maxInstallmentPlan = installmentPlans[installmentPlans.length - 1] ?? null

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

      {!!maxInstallmentPlan && financedPrice != null && (
        <div className="mb-2">
          {/* Concepto de cara al cliente: "Hasta N cuotas de $X", nunca
              "precio financiado" (texto técnico) ni "sin interés" -- el
              financiado es mayor al contado por diseño (cubre el costo de
              MP), así que "sin interés" sería una leyenda falsa. */}
          <p className="beyonix-modal-title text-14px font-semibold text-white">
            Hasta {maxInstallmentPlan.count} cuotas de {formatPrice(maxInstallmentPlan.amount)}
          </p>

          {installmentPlans.length > 1 && (
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

          {showInstallmentOptions && installmentPlans.length > 1 && (
            <ul className="mt-2 space-y-1 border-l border-[#21476B]/65 pl-3">
              {installmentPlans.map((plan) => (
                <li key={plan.count} className="beyonix-modal-body text-12px font-medium text-white/70">
                  {plan.count} cuotas de {formatPrice(plan.amount)}
                </li>
              ))}
            </ul>
          )}

          {/* Requisito legal Argentina: al haber precio financiado > contado,
              nunca se puede decir "sin interés" -- se muestra el costo
              financiero total efectivo anual en su lugar. */}
          {cfteaPercent != null && (
            <p className="beyonix-modal-muted mt-1 text-10px font-medium leading-4 text-white/45">
              CFTEA: {formatPercent(cfteaPercent)}%
            </p>
          )}
        </div>
      )}

      {priceWithoutNationalTaxesCash != null && (
        <p className="beyonix-modal-muted mb-3 text-10px font-medium leading-4 text-white/40">
          Precio s/imp. nac.: {formatPrice(priceWithoutNationalTaxesCash)}
        </p>
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
