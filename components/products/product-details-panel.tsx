"use client"

import { useState } from "react"

import {
  Armchair,
  AudioLines,
  BadgeCheck,
  Battery,
  BatteryCharging,
  BatteryFull,
  Bluetooth,
  Cable,
  Camera,
  Car,
  CircleHelp,
  Clock,
  Coffee,
  CookingPot,
  CupSoda,
  Ear,
  Flame,
  Gamepad2,
  Gauge,
  Hammer,
  Hand,
  HardDrive,
  Headphones,
  Home,
  Laptop,
  Layers3,
  Lock,
  Mic,
  Monitor,
  MonitorUp,
  Music,
  Network,
  Package,
  PanelsTopLeft,
  Plug,
  PlugZap,
  Rocket,
  Rotate3d,
  Ruler,
  ScanFace,
  Shield,
  ShieldCheck,
  Smile,
  Smartphone,
  Sparkles,
  Star,
  Thermometer,
  Truck,
  Usb,
  Volume2,
  Weight,
  Wifi,
  Zap,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"

import type { SupabaseProducto } from "@/lib/supabase/types"

import { ColorSelector, formatColorName } from "./color-selector"
import { ProductPurchaseBox } from "./product-purchase-box"
import { ProductRatingSummary } from "./product-rating-summary"
import { ProductReviewsDialog } from "./product-reviews-dialog"
import { RandomVariantHint } from "./random-variant-hint"
import {
  DEFAULT_VARIANT_VALUE,
  getProductVariantOptions,
  RANDOM_VARIANT_LABEL,
} from "@/lib/products/product-variants"
import { getPriceWithoutNationalTaxes, getTransferPrice } from "@/lib/pricing/financed-pricing"
import { getProductInterestFreeMessage } from "@/lib/pricing/interest-free-communication"
import {
  MAX_CART_ITEM_QUANTITY,
  getQuantityLimitMessage,
} from "@/lib/cart/stock-status"
import { useSiteSettings } from "@/hooks/use-site-settings"

interface ProductDetailsPanelProps {
  product: SupabaseProducto

  selectedColor: string

  onColorChange: (
    colorName: string
  ) => void

  onAddToCart: (
    quantity?: number
  ) => void

  onDecreaseCart: () => void

  onRemoveFromCart: () => void

  onViewCart: () => void

  isInCart?: boolean
  cartQuantity?: number
  selectedStock: number
}

const iconMap: Record<string, LucideIcon> = {
  Armchair,
  AudioLines,
  BadgeCheck,
  Battery,
  BatteryCharging,
  BatteryFull,
  Bluetooth,
  Cable,
  Camera,
  Car,
  Clock,
  Coffee,
  CookingPot,
  CupSoda,
  Ear,
  Flame,
  Gamepad2,
  Gauge,
  Hammer,
  Hand,
  HardDrive,
  Headphones,
  Home,
  Laptop,
  Layers3,
  Lock,
  Mic,
  Monitor,
  MonitorUp,
  Music,
  Network,
  Package,
  PanelsTopLeft,
  Plug,
  PlugZap,
  Rocket,
  Rotate3d,
  Ruler,
  ScanFace,
  Shield,
  ShieldCheck,
  Smile,
  Smartphone,
  Sparkles,
  Star,
  Thermometer,
  Truck,
  Usb,
  Volume2,
  Weight,
  Wifi,
  Zap,
}

export function ProductDetailsPanel({
  product,
  selectedColor,
  onColorChange,
  onAddToCart,
  onDecreaseCart,
  onRemoveFromCart,
  onViewCart,
  isInCart = false,
  cartQuantity = 0,
  selectedStock,
}: ProductDetailsPanelProps) {
  const colors = getProductVariantOptions(product)
  const selectedOption =
    colors.find((option) => option.value === selectedColor) ?? colors[0]
  const [previewedColor, setPreviewedColor] = useState<
    { name: string; value: string; colorHex?: string | null; image?: string | null } | null
  >(null)
  // "Aleatorio según stock" es una frase, no un nombre de color: sin
  // mayúscula por palabra.
  const displayedColorName =
    !previewedColor && selectedOption?.isRandom
      ? RANDOM_VARIANT_LABEL
      : formatColorName(previewedColor?.name ?? selectedOption?.name ?? "")
  const { pricing, interestFreeOffer, installmentsFinancing } = useSiteSettings()
  const cashPrice = selectedOption?.price ?? product.precio
  const transferPrice = getTransferPrice(cashPrice, pricing.transferDiscountPercent)
  // Sólo el plan que el precio financiado de esta variante alcanza (nunca
  // el de transferencia); lo que se cobra lo define el total del checkout.
  const interestFreeText =
    getProductInterestFreeMessage(interestFreeOffer, cashPrice, installmentsFinancing)?.text ?? null
  const priceWithoutNationalTaxesCash = getPriceWithoutNationalTaxes(
    cashPrice,
    pricing.nationalTaxesIncidencePercent,
  )
  const hasVariants =
    colors.length > 1 || colors[0]?.value !== DEFAULT_VARIANT_VALUE
  const productSpecifications =
    product.producto_especificaciones
      ?.filter((specification) => specification.activo !== false)
      .sort((a, b) => {
        if (a.orden !== b.orden) return a.orden - b.orden
        return a.id - b.id
      }) ?? []
  const visibleFeatures = productSpecifications.map((specification) => ({
    icon: iconMap[specification.icono] ?? CircleHelp,
    text: specification.texto,
  }))
  const limitedFeatures = visibleFeatures.slice(0, 8)
  const featureColumns =
    limitedFeatures.length >= 4
      ? [
          limitedFeatures.slice(0, Math.ceil(limitedFeatures.length / 2)),
          limitedFeatures.slice(Math.ceil(limitedFeatures.length / 2)),
        ]
      : [limitedFeatures]
  const reviewsCount = Number(product.reviews_count)
  const hasReviews =
    Number.isInteger(reviewsCount) && reviewsCount > 0

  // Venta aleatoria: no hay color para elegir (sin selección falsa); sólo
  // aparece selector si además hay unidades con descuento para elegir.
  const isRandomSelected = selectedOption?.isRandom === true

  return (
    <aside className="beyonix-modal-shell flex min-w-0 flex-col bg-[#080D13] text-white md:border-l md:border-white/7">
      <div className="px-5 pb-4 pt-6 md:px-7 md:pb-5 md:pt-7">
        {product.categorias?.nombre && (
          <span className="beyonix-category-pill mb-3 inline-flex items-center gap-2 rounded-full bg-beyonix-blue/16 px-3.5 py-1.5 text-11px font-bold uppercase tracking-widest text-beyonix-sky">
            <Sparkles className="beyonix-category-pill-icon size-3.5 text-white" />
            {product.categorias.nombre}
          </span>
        )}

        <h2 className="beyonix-modal-title text-[28px] font-bold leading-tight text-white md:text-[34px]">
          {product.nombre}
        </h2>

        {hasReviews && (
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <ProductRatingSummary
              averageRating={product.average_rating}
              reviewsCount={product.reviews_count}
              className="text-sm"
              starClassName="size-4"
              countClassName="beyonix-modal-body text-white/55"
            />

            <ProductReviewsDialog
              productId={product.id}
              productName={product.nombre}
              averageRating={product.average_rating}
              reviewsCount={reviewsCount}
            />
          </div>
        )}
      </div>

      <div className="beyonix-modal-header border-t border-white/7">
        <ProductPurchaseBox
          price={cashPrice}
          originalPrice={
            selectedOption?.originalPrice ??
            product.precio_anterior ??
            undefined
          }
          transferPrice={transferPrice}
          transferDiscountPercent={pricing.transferDiscountPercent}
          interestFreeText={interestFreeText}
          priceWithoutNationalTaxesCash={priceWithoutNationalTaxesCash}
          isInCart={isInCart}
          cartQuantity={cartQuantity}
          maxReached={
            // selectedStock ya es el disponible (físico - reservas activas).
            cartQuantity >= Math.min(MAX_CART_ITEM_QUANTITY, selectedStock)
          }
          limitMessage={getQuantityLimitMessage(
            product,
            selectedOption?.value ?? selectedColor,
            cartQuantity,
          )}
          onAddToCart={onAddToCart}
          onDecreaseCart={onDecreaseCart}
          onRemoveFromCart={onRemoveFromCart}
          onViewCart={onViewCart}
        />
      </div>

      {(limitedFeatures.length > 0 || hasVariants || selectedOption?.isConditioned) && (
      <div className="beyonix-modal-header border-t border-white/7 px-5 py-5 md:px-7">
        <div className="space-y-7">
          {limitedFeatures.length > 0 && (
            <section>
              <p className="mb-3 text-11px font-bold uppercase tracking-widest text-beyonix-sky">
                Características principales
              </p>

              <div className="pr-2">
                <div
                  className={`grid items-start gap-x-4 gap-y-2.5 ${
                    featureColumns.length > 1 ? "sm:grid-cols-2" : "grid-cols-1"
                  }`}
                >
                  {featureColumns.map((column, columnIndex) => (
                    <ul
                      key={`feature-column-${columnIndex}`}
                      className="grid content-start gap-y-2.5 self-start"
                    >
                      {column.map((feature) => {
                        const Icon = feature.icon

                        return (
                          <li
                            key={feature.text}
                            className="beyonix-modal-body flex items-center gap-2.5 text-14px leading-5 text-white/82"
                          >
                            <span className="flex size-8 shrink-0 items-center justify-center rounded-full border border-beyonix-sky/24 bg-[#0D1720]">
                              <Icon className="size-3.5 text-white" />
                            </span>
                            <span className="leading-tight">{feature.text}</span>
                          </li>
                        )
                      })}
                    </ul>
                  ))}
                </div>
              </div>
            </section>
          )}

          {hasVariants && (
            <section>
              <p className={`flex flex-wrap items-center gap-x-1 text-14px ${colors.length > 1 ? "mb-3" : ""}`}>
                <span className="beyonix-modal-body text-white/55">
                  {isRandomSelected && !previewedColor ? "Color/modelo:" : "Color:"}
                </span>
                <span className="beyonix-modal-title font-semibold text-white">
                  {displayedColorName}
                </span>
                {isRandomSelected && !previewedColor && <RandomVariantHint />}
              </p>

              {colors.length > 1 && (
                <ColorSelector
                  colors={colors.map((color) => ({
                    name: color.name,
                    value: color.value,
                    colorHex: color.colorHex,
                    secondaryColorHex: color.secondaryColorHex,
                    image: color.images[0] ?? null,
                  }))}
                  selectedColor={selectedColor}
                  onSelect={onColorChange}
                  onPreviewChange={setPreviewedColor}
                  thumbnailMode
                  showLabels
                />
              )}
            </section>
          )}

          {selectedOption?.isConditioned && (
            <section className="rounded-xl border border-amber-300/22 bg-amber-300/7 px-4 py-3">
              <p className="text-10px font-black uppercase tracking-widest text-amber-200">
                Variante con descuento
              </p>
              <p className="beyonix-modal-body mt-1 text-sm font-semibold leading-5 text-white/72">
                {selectedOption.reason ||
                  "Esta unidad fue revisada y se vende separada del stock normal."}
              </p>
            </section>
          )}
        </div>
      </div>
      )}
    </aside>
  )
}
