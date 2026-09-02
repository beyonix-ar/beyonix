import { useState } from "react"
import Image from "next/image"
import { CheckCircle2, CircleSlash2, Flame, Minus, Plus, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { CartItem } from "@/context/cart-context"
import {
  MAX_CART_ITEM_QUANTITY,
  getStockStatus,
  getStockStatusLabel,
  type StockStatus,
} from "@/lib/cart/stock-status"
import { getColorName } from "@/lib/products/variant-color"
import { getDiscountPercent } from "@/lib/products/product-variants"

interface Props {
  item: CartItem
  onUpdateQuantity: (productId: number, color: string, quantity: number) => void
  onRemove: (productId: number, color: string) => void
}

const formatPrice = (price: number) =>
  new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    minimumFractionDigits: 0,
  }).format(price)

function getStockBadgeClassName(status: StockStatus) {
  if (status === "low") {
    return "beyonix-stock-badge-warning border-amber-300/20 bg-amber-400/10 text-amber-100"
  }

  if (status === "out") {
    return "beyonix-stock-badge-danger border-red-400/20 bg-red-500/10 text-red-100"
  }

  return "beyonix-stock-badge-success border-emerald-300/20 bg-emerald-400/10 text-emerald-100"
}

function getStockIcon(status: StockStatus) {
  if (status === "low") return Flame
  if (status === "out") return CircleSlash2

  return CheckCircle2
}

export function CartItemRow({ item, onUpdateQuantity, onRemove }: Props) {
  const {
    product,
    color,
    image,
    quantity,
    variantName,
    colorHex,
    unitPrice,
    originalUnitPrice,
    conditionedStockId,
    discountReason,
  } = item
  const price = unitPrice
  const discountPercent = getDiscountPercent(price, originalUnitPrice)
  const hasVariantInfo = Boolean(variantName || (color && color !== "default"))
  const colorName = hasVariantInfo ? getColorName(colorHex, variantName) : null
  const hasColor = Boolean(colorHex)
  const [imageSrc, setImageSrc] = useState(image || "/placeholder.svg")
  const isMaxQuantity = quantity >= MAX_CART_ITEM_QUANTITY
  const stockStatus = getStockStatus(product, color)
  const StockIcon = getStockIcon(stockStatus)

  return (
    <div className="beyonix-cart-item relative flex gap-3 rounded-xl border border-white/10 bg-beyonix-surface-3 p-2 shadow-sm shadow-black/30">
      <div className="relative size-20 shrink-0 overflow-hidden rounded-md border border-white/10 bg-white p-1">
        <Image
          src={imageSrc}
          alt={product.nombre}
          fill
          sizes="80px"
          className="object-cover"
          onError={() => setImageSrc("/placeholder.svg")}
        />
      </div>

      <div className="flex min-w-0 flex-1 flex-col justify-between py-0.5">
        <div className="pr-8">
          <h4 className="beyonix-cart-item-title line-clamp-2 text-sm font-bold leading-snug text-white">
            {product.nombre}
          </h4>

          {colorName && (
            <div className="mt-1 flex items-center gap-1.5">
              {hasColor && (
                <span
                  style={{
                    backgroundColor: colorHex ?? undefined,
                  }}
                  className="size-3 rounded-full border border-white/20"
                />
              )}
              <span className="beyonix-cart-item-meta text-xs capitalize text-white/65">{colorName}</span>
            </div>
          )}

          {conditionedStockId && (
            <p
              className="beyonix-stock-badge-warning-text mt-1 line-clamp-2 text-10px font-semibold leading-4 text-amber-200/80"
              title={discountReason || "Variante con descuento"}
            >
              Con descuento
              {discountReason ? ` · ${discountReason}` : ""}
            </p>
          )}

          <span
            className={`mt-1.5 inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-10px font-semibold uppercase tracking-wide ${getStockBadgeClassName(stockStatus)}`}
          >
            <StockIcon className="size-3" />
            {getStockStatusLabel(stockStatus)}
          </span>
        </div>

        <div className="mt-1.5 flex items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="beyonix-cart-item-title text-sm font-semibold text-white/90">
              {formatPrice(price)}
            </p>

            {discountPercent !== null && originalUnitPrice !== null && (
              <div className="mt-1 flex min-w-0 items-center gap-2">
                <span className="beyonix-cart-item-meta truncate text-13px text-white/50 line-through tabular-nums">
                  {formatPrice(originalUnitPrice)}
                </span>

                <span className="inline-flex shrink-0 items-center rounded-full border border-green-400/28 bg-green-600/78 px-2 py-0.5 text-12px font-bold leading-none text-white shadow-[0_0_7px_rgba(22,163,74,0.18)]">
                  -{discountPercent}%
                </span>
              </div>
            )}
          </div>

          <div className="flex min-w-0 shrink-0 items-center gap-1.5">
            <span className="beyonix-cart-item-meta text-11px font-medium text-white/60">Cant.</span>

            <div className="beyonix-cart-item-stepper inline-flex h-7 items-center overflow-hidden rounded-full border border-beyonix-blue-light/60 bg-black">
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="beyonix-cart-item-stepper-btn h-full w-7 rounded-none border-0 border-r border-white/10 bg-transparent text-white enabled:cursor-pointer enabled:hover:bg-beyonix-blue/60 disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent"
                aria-label="Disminuir cantidad"
                title="Disminuir cantidad"
                onClick={() => onUpdateQuantity(product.id, color, quantity - 1)}
                disabled={quantity <= 1}
              >
                <Minus className="size-3" />
              </Button>

              <span className="beyonix-cart-item-title flex h-full min-w-8 items-center justify-center px-1.5 text-xs font-bold text-white">
                {quantity}
              </span>

              <Button
                type="button"
                variant="outline"
                size="icon"
                className="beyonix-cart-item-stepper-btn h-full w-7 rounded-none border-0 border-l border-white/10 bg-transparent text-white enabled:cursor-pointer enabled:hover:bg-beyonix-blue/60 disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent"
                aria-label="Aumentar cantidad"
                title="Aumentar cantidad"
                onClick={() => onUpdateQuantity(product.id, color, quantity + 1)}
                disabled={isMaxQuantity}
              >
                <Plus className="size-3" />
              </Button>
            </div>
          </div>
        </div>
      </div>

      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="beyonix-cart-item-delete absolute right-2 top-2 size-8 cursor-pointer rounded-full border border-red-500/20 bg-red-950/20 text-red-400 transition-colors hover:border-red-400/50 hover:bg-red-500/20 hover:text-red-300"
        aria-label="Eliminar producto"
        title="Eliminar producto"
        onClick={() => onRemove(product.id, color)}
      >
        <Trash2 className="size-4" />
      </Button>
    </div>
  )
}
