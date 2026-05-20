"use client"

import Image from "next/image"
import Link from "next/link"
import { ShoppingBag, ArrowRight, Tag } from "lucide-react"
import { getProductDiscount } from "@/lib/store-config"
import { productsData } from "@/lib/products"
import type { StoreProduct } from "@/lib/types/product"

interface ProductsSectionProps {
  onAddToCart: (product: StoreProduct, color: string, image?: string) => void
}

const formatPrice = (price: number) =>
  new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    minimumFractionDigits: 0,
  }).format(price)

export function ProductsSection({ onAddToCart }: ProductsSectionProps) {
  const featured = productsData.filter((p) => p.featured)

  return (
    <section id="productos" className="py-16 lg:py-24 bg-[#030303] scroll-mt-20">
      <div className="container mx-auto px-4 lg:px-8">

        {/* Header */}
        <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4 mb-12">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.25em] text-[#4A90B8] mb-2">
              Destacados
            </p>
            <h2 className="text-3xl lg:text-4xl font-bold tracking-tight text-white">
              Productos populares
            </h2>
          </div>

          <Link
            href="/productos"
            className="inline-flex items-center gap-2 h-10 px-5 rounded-xl border border-white/15 text-sm font-medium text-white/70 hover:text-white hover:border-white/30 transition-colors self-start lg:self-auto"
          >
            Ver todos los productos
            <ArrowRight className="size-3.5" />
          </Link>
        </div>

        {/* Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-5">
          {featured.map((product) => {
            const discount = getProductDiscount(product.id)
            const finalPrice = Math.round(product.price * (1 - discount))
            const hasSale = discount > 0
            const discountPct = Math.round(discount * 100)

            const defaultColor = product.colors?.[0]?.name ?? "default"
            const previewImage =
              product.colors?.[0]?.images?.[0] ?? "/placeholder.png"

            return (
              <article
                key={product.id}
                className="group flex flex-col bg-[#0A0A0A] border border-white/[6%] rounded-2xl overflow-hidden hover:border-white/[12%] hover:shadow-xl hover:shadow-black/50 transition-all duration-300"
              >
                {/* Imagen — sin badge sobre el fondo blanco */}
                <div className="relative aspect-square bg-white overflow-hidden">
                  <Image
                    src={previewImage}
                    alt={product.name}
                    fill
                    className="object-cover transition-transform duration-500 group-hover:scale-105"
                  />
                </div>

                {/* Contenido — alturas fijas para alineación perfecta */}
                <div className="flex flex-col flex-1 p-4">

                  {/* Categoría — h fija */}
                  <p className="h-4 text-[10px] font-semibold uppercase tracking-[0.2em] text-white/35 truncate">
                    {product.category}
                  </p>

                  {/* Nombre — 2 líneas fijas */}
                  <h3 className="mt-1.5 min-h-[2.75rem] line-clamp-2 text-[15px] font-semibold leading-[1.375rem] text-white">
                    {product.name}
                  </h3>

                  {/* Precio — altura fija para que el botón siempre quede al mismo nivel */}
                  <div className="mt-3 pt-3 border-t border-white/[5%] flex flex-col gap-3">

                    {/* Bloque de precios — altura reservada siempre */}
                    <div className="h-[52px] flex flex-col justify-center">
                      <div className="flex items-center gap-2">
                        <span className="text-[19px] font-bold text-white tabular-nums leading-none">
                          {formatPrice(finalPrice)}
                        </span>

                        {hasSale && (
                          <span className="inline-flex items-center gap-1 rounded-md bg-green-500/12 border border-green-500/20 px-1.5 py-0.5">
                            <Tag className="size-2.5 text-green-400" />
                            <span className="text-[11px] font-bold text-green-400 leading-none">
                              -{discountPct}%
                            </span>
                          </span>
                        )}
                      </div>

                      {hasSale ? (
                        <p className="mt-1 text-[13px] text-white/35 line-through tabular-nums leading-none">
                          {formatPrice(product.price)}
                        </p>
                      ) : (
                        /* Placeholder para mantener la altura cuando no hay descuento */
                        <p className="mt-1 h-[16px]" aria-hidden="true" />
                      )}
                    </div>

                    {/* Botón — siempre al mismo nivel */}
                    <button
                      type="button"
                      onClick={() => onAddToCart(product, defaultColor, previewImage)}
                      className="flex w-full h-9 items-center justify-center gap-2 rounded-lg bg-white text-[13px] font-semibold text-black hover:bg-white/90 active:scale-[0.98] transition-all cursor-pointer"
                    >
                      <ShoppingBag className="size-3.5" />
                      Añadir al carrito
                    </button>
                  </div>

                </div>
              </article>
            )
          })}
        </div>
      </div>
    </section>
  )
}