"use client"

import { useEffect, useState } from "react"
import { X } from "lucide-react"

import { useCart } from "@/context/cart-context"
import type { SupabaseProducto } from "@/lib/supabase/types"
import {
  getDefaultVariantValue,
  getProductImagesByVariant,
  getProductVariantOptions,
  getVariantOptionByValue,
} from "@/lib/products/product-variants"
import { ProductPurchaseBox } from "@/components/products/product-purchase-box"

interface AdminProductPreviewModalProps {
  product: SupabaseProducto
  onClose: () => void
}

function formatPrice(price: number) {
  return price.toLocaleString("es-AR", {
    style: "currency",
    currency: "ARS",
    maximumFractionDigits: 0,
  })
}

export function AdminProductPreviewModal({
  product,
  onClose,
}: AdminProductPreviewModalProps) {
  const [selectedColor, setSelectedColor] = useState(() =>
    getDefaultVariantValue(product)
  )
  const [selectedImage, setSelectedImage] = useState(0)
  const {
    addToCart,
    decreaseQuantity,
    removeFromCart,
    getQuantity,
    isInCart,
    openCart,
  } = useCart()

  const variants = getProductVariantOptions(product)
  const selectedVariant = getVariantOptionByValue(product, selectedColor)
  const images = getProductImagesByVariant(product, selectedColor)
  const currentImage = images[selectedImage] || product.imagen_principal
  const stock = selectedVariant?.stock ?? product.stock
  const cartQuantity = getQuantity(product.id, selectedColor)
  const discount =
    product.precio_anterior && product.precio_anterior > product.precio
      ? Math.round(
          ((product.precio_anterior - product.precio) / product.precio_anterior) *
            100
        )
      : null

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
    }

    document.addEventListener("keydown", handleKeyDown)
    return () => document.removeEventListener("keydown", handleKeyDown)
  }, [onClose])

  const handleColorChange = (value: string) => {
    setSelectedColor(value)
    setSelectedImage(0)
  }

  return (
    <div className="fixed inset-0 z-100 flex items-center justify-center bg-black/85 px-4 py-5 backdrop-blur-sm">
      <button
        type="button"
        title="Cerrar previsualizacion"
        aria-label="Cerrar previsualizacion"
        onClick={onClose}
        className="absolute inset-0 cursor-default"
      />

      <article className="relative z-10 grid max-h-[calc(100vh-40px)] w-full max-w-6xl overflow-hidden rounded-3xl border border-white/10 bg-black shadow-2xl shadow-black/70 lg:grid-cols-[440px_minmax(0,1fr)]">
        <button
          type="button"
          title="Cerrar"
          aria-label="Cerrar"
          onClick={onClose}
          className="absolute right-4 top-4 z-20 flex size-10 items-center justify-center rounded-2xl border border-white/10 bg-black/75 text-white/70 transition-colors hover:border-beyonix-blue-light/45 hover:text-white"
        >
          <X className="size-4" />
        </button>

        <section className="bg-black p-5">
          <div className="flex h-full flex-col gap-3">
            <div className="flex aspect-square max-h-[420px] items-center justify-center overflow-hidden rounded-2xl border border-white/8 bg-white">
              {currentImage ? (
                <img
                  src={currentImage}
                  alt={product.nombre}
                  className="h-full w-full object-contain"
                />
              ) : (
                <div className="text-sm font-bold text-black/30">Sin imagen</div>
              )}
            </div>

            {images.length > 1 && (
              <div className="grid grid-cols-5 gap-2">
                {images.slice(0, 5).map((image, index) => (
                  <button
                    key={`${image}-${index}`}
                    type="button"
                    title={`Ver imagen ${index + 1}`}
                    aria-label={`Ver imagen ${index + 1}`}
                    onClick={() => setSelectedImage(index)}
                    className={`aspect-square overflow-hidden rounded-xl border bg-white transition-colors ${
                      selectedImage === index
                        ? "border-beyonix-sky"
                        : "border-white/10 hover:border-white/35"
                    }`}
                  >
                    <img
                      src={image}
                      alt={`${product.nombre} ${index + 1}`}
                      className="h-full w-full object-cover"
                    />
                  </button>
                ))}
              </div>
            )}
          </div>
        </section>

        <section className="flex min-h-0 flex-col border-l border-white/8 bg-black">
          <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto px-6 py-6 pr-16">
            <p className="text-11px font-bold uppercase tracking-widest text-beyonix-sky">
              {product.categorias?.nombre || "Sin categoria"}
            </p>
            <h2 className="mt-2 text-2xl font-black text-white">{product.nombre}</h2>

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-white/10 bg-black px-3 py-1 text-sm font-bold text-white">
                {formatPrice(product.precio)}
              </span>
              {discount && (
                <span className="rounded-full border border-emerald-500/25 bg-emerald-500/10 px-3 py-1 text-sm font-bold text-emerald-300">
                  -{discount}% OFF
                </span>
              )}
              {product.precio_anterior && product.precio_anterior > product.precio && (
                <span className="text-sm font-medium text-white/45 line-through">
                  {formatPrice(product.precio_anterior)}
                </span>
              )}
            </div>

            {product.descripcion && (
              <div className="mt-5 border-t border-white/8 pt-5">
                <p className="mb-2 text-11px font-bold uppercase tracking-widest text-white/50">
                  Descripcion
                </p>
                <p className="max-w-2xl text-sm leading-6 text-white/76 md:text-base md:leading-7">
                  {product.descripcion}
                </p>
              </div>
            )}

            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              <div className="rounded-2xl border border-white/8 bg-black px-4 py-3">
                <p className="text-11px font-bold uppercase tracking-widest text-white/45">
                  Stock
                </p>
                <p
                  className={`mt-1 text-xl font-black ${
                    stock <= 0
                      ? "text-red-300"
                      : stock < 5
                        ? "text-amber-300"
                        : "text-emerald-300"
                  }`}
                >
                  {stock}
                </p>
              </div>

              <div className="rounded-2xl border border-white/8 bg-black px-4 py-3">
                <p className="text-11px font-bold uppercase tracking-widest text-white/45">
                  Estado
                </p>
                <p className="mt-2 text-sm font-bold text-white/80">
                  {product.activo ? "Activo" : "Inactivo"}
                </p>
              </div>
            </div>

            {variants.length > 1 && (
              <div className="mt-5">
                <p className="mb-3 text-11px font-bold uppercase tracking-widest text-white/50">
                  Variante
                </p>
                <div className="flex flex-wrap gap-2">
                  {variants.map((variant) => {
                    const value = variant.value || variant.name
                    const selected = selectedColor === value

                    return (
                      <button
                        key={value}
                        type="button"
                        title={variant.name}
                        aria-label={variant.name}
                        onClick={() => handleColorChange(value)}
                        className={`flex items-center gap-2 rounded-2xl border px-3 py-2 text-sm font-bold transition-colors ${
                          selected
                            ? "border-beyonix-sky bg-beyonix-blue text-white"
                            : "border-white/10 bg-black text-white/65 hover:border-beyonix-blue-light/45 hover:text-white"
                        }`}
                      >
                        <span
                          className="size-4 rounded-full border border-white/25"
                          style={{ backgroundColor: variant.colorHex || "#ffffff" }}
                        />
                        {variant.name}
                      </button>
                    )
                  })}
                </div>
              </div>
            )}
          </div>

          <div className="border-t border-white/8">
            <ProductPurchaseBox
              price={product.precio}
              originalPrice={product.precio_anterior || undefined}
              isInCart={isInCart(product.id, selectedColor)}
              cartQuantity={cartQuantity}
              onAddToCart={() => {
                addToCart(product, selectedColor, currentImage || undefined)
              }}
              onDecreaseCart={() => {
                decreaseQuantity(product.id, selectedColor)
              }}
              onRemoveFromCart={() => {
                removeFromCart(product.id, selectedColor)
              }}
              onViewCart={openCart}
            />
          </div>
        </section>
      </article>
    </div>
  )
}
