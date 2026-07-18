"use client"

import { useEffect, useState } from "react"

import Image from "next/image"
import Link from "next/link"
import {
  ArrowRight,
  PackageCheck,
  SearchCheck,
  ShieldCheck,
  Sparkles,
  Tag,
} from "lucide-react"

import {
  BeyonixButton,
  BeyonixCard,
  BeyonixIconBox,
} from "@/components/beyonix-ui"
import { getInstallmentsLabel } from "@/lib/products/installments"
import { getDefaultVariantOption } from "@/lib/products/product-variants"
import { getProductDiscount } from "@/lib/store-config"
import { getFeaturedProductos } from "@/lib/supabase/queries/store"
import type { SupabaseProducto } from "@/lib/supabase/types"

const trustItems = [
  {
    title: "Selección cuidada",
    sub: "Productos elegidos con criterio",
    icon: SearchCheck,
  },
  {
    title: "Tecnología útil",
    sub: "Para tu día a día",
    icon: ShieldCheck,
  },
  {
    title: "Envío a todo el país",
    sub: "Entrega segura y con seguimiento",
    icon: PackageCheck,
  },
]

const formatPrice = (price: number) =>
  new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    minimumFractionDigits: 0,
  }).format(price)

interface HeroSectionProps {
  onOpenPreview: (product: SupabaseProducto) => void
}

export function HeroSection({ onOpenPreview }: HeroSectionProps) {
  const [featuredProduct, setFeaturedProduct] =
    useState<SupabaseProducto | null>(null)

  useEffect(() => {
    let active = true

    getFeaturedProductos()
      .then((products) => {
        if (active) {
          setFeaturedProduct(products[0] ?? null)
        }
      })
      .catch((error) => {
        console.error("Error cargando producto destacado del hero:", error)
      })

    return () => {
      active = false
    }
  }, [])

  const defaultVariant = featuredProduct
    ? getDefaultVariantOption(featuredProduct)
    : null
  const productImage =
    defaultVariant?.images[0] ??
    featuredProduct?.imagen_principal
  const eventDiscount = featuredProduct
    ? getProductDiscount(featuredProduct.id)
    : 0
  const productOriginalPrice =
    featuredProduct?.precio_anterior &&
    featuredProduct.precio_anterior > featuredProduct.precio
      ? featuredProduct.precio_anterior
      : null
  const finalPrice = featuredProduct
    ? Math.round(featuredProduct.precio * (1 - eventDiscount))
    : 0
  const originalPrice = featuredProduct
    ? eventDiscount > 0
      ? featuredProduct.precio
      : productOriginalPrice
    : null
  const discountPercentage = originalPrice
    ? Math.round((1 - finalPrice / originalPrice) * 100)
    : 0
  const hasSale = discountPercentage > 0
  const installmentsLabel = featuredProduct
    ? getInstallmentsLabel(featuredProduct)
    : null

  const openFeaturedProduct = () => {
    if (!featuredProduct) {
      return
    }

    onOpenPreview(featuredProduct)
  }

  return (
    <section className="relative overflow-hidden pt-18 lg:pt-20">
      <div className="container relative mx-auto grid min-h-[clamp(620px,78vh,840px)] items-center gap-[clamp(2.5rem,4vw,4.5rem)] py-[clamp(3.75rem,5.5vw,5.5rem)] lg:grid-cols-hero-premium">
        <div className="max-w-3xl">
          <h1 className="mb-5 max-w-3xl text-[clamp(2.4rem,4.3vw,4.65rem)] font-bold leading-1-1 tracking-tight text-white">
            Tecnología para tu comodidad
          </h1>

          <p className="mb-8 max-w-xl text-[clamp(1rem,1vw,1.15rem)] leading-1-8 text-white/68">
            Productos confiables, útiles y seleccionados para que tu vida se
            sienta más simple, segura y tranquila.
          </p>

          <div className="flex flex-col items-start gap-3 sm:flex-row">
            <BeyonixButton asChild size="lg">
              <Link href="/productos">
                Explorar tienda
                <ArrowRight className="size-4" />
              </Link>
            </BeyonixButton>

            <BeyonixButton asChild variant="outline" size="lg">
              <Link href="/categorias">Ver categorías</Link>
            </BeyonixButton>
          </div>

          <div className="mt-8 grid max-w-4xl gap-3 border-t border-beyonix-blue-light/16 pt-6 sm:grid-cols-3">
            {trustItems.map((item) => {
              const Icon = item.icon

              return (
                <BeyonixCard
                  key={item.title}
                  variant="information"
                  className="flex min-h-24 items-center gap-3 p-3.5"
                >
                  <BeyonixIconBox size="sm" className="text-white">
                    <Icon className="size-5" />
                  </BeyonixIconBox>

                  <div className="min-w-0">
                    <span className="block text-sm font-semibold leading-5 text-white sm:text-base">
                      {item.title}
                    </span>
                    <span className="mt-1 block text-11px leading-5 text-white/52">
                      {item.sub}
                    </span>
                  </div>
                </BeyonixCard>
              )
            })}
          </div>
        </div>

        <BeyonixCard
          variant="highlighted"
          onClick={openFeaturedProduct}
          className="relative cursor-pointer overflow-hidden p-4 sm:p-5"
        >
          {featuredProduct && productImage ? (
            <>
              <div className="mb-4 flex items-start justify-between gap-4">
                <div>
                  <p className="text-11px font-semibold uppercase tracking-widest text-beyonix-cyan">
                    Producto destacado
                  </p>
                  <h2 className="mt-2 line-clamp-2 text-2xl font-bold leading-tight text-white">
                    {featuredProduct.nombre}
                  </h2>
                </div>

                {hasSale && (
                  <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-emerald-400/24 bg-emerald-500/12 px-2.5 py-1 text-xs font-semibold text-emerald-200">
                    <Tag className="size-3" />
                    -{discountPercentage}%
                  </span>
                )}
              </div>

              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation()
                  openFeaturedProduct()
                }}
                aria-label={`Ver ${featuredProduct.nombre}`}
                className="group block w-full cursor-pointer rounded-2xl text-left outline-none focus-visible:ring-2 focus-visible:ring-beyonix-blue-light/35"
              >
                <div className="relative aspect-[1.08] overflow-hidden rounded-2xl border border-beyonix-blue-light/18 bg-[#f8fafc] p-5">
                  <Image
                    fill
                    src={productImage}
                    alt={featuredProduct.nombre}
                    sizes="(min-width: 1024px) 420px, calc(100vw - 48px)"
                    className="object-contain transition-transform duration-500 group-hover:scale-[1.025]"
                    priority
                  />
                </div>
              </button>

              <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                <div className="min-w-0">
                  <p className="text-2xl font-bold leading-none text-white">
                    {formatPrice(finalPrice)}
                  </p>
                  {hasSale && (
                    <p className="mt-1 text-sm text-white/42 line-through">
                      {formatPrice(originalPrice ?? featuredProduct.precio)}
                    </p>
                  )}

                  {(hasSale || installmentsLabel) && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {hasSale && (
                        <span className="inline-flex min-h-24px items-center rounded-full border border-green-500/25 bg-green-500/12 px-3 py-1.5 text-12px font-semibold leading-none text-green-400">
                          En oferta
                        </span>
                      )}

                      {installmentsLabel && (
                        <span className="inline-flex min-h-24px items-center rounded-full border border-beyonix-blue-light/24 bg-beyonix-blue/22 px-3 py-1.5 text-12px font-medium leading-none text-beyonix-sky">
                          {installmentsLabel}
                        </span>
                      )}
                    </div>
                  )}
                </div>

                <BeyonixButton
                  type="button"
                  variant="outline"
                  size="md"
                  className="shrink-0"
                  onClick={(event) => {
                    event.stopPropagation()
                    openFeaturedProduct()
                  }}
                >
                  Ver producto
                  <ArrowRight className="size-4" />
                </BeyonixButton>
              </div>
            </>
          ) : (
            <div className="flex min-h-360px flex-col items-center justify-center p-6 text-center">
              <BeyonixIconBox size="lg" className="mb-4 text-beyonix-sky">
                <Sparkles className="size-5" />
              </BeyonixIconBox>
              <h2 className="text-2xl font-bold text-white">
                Catálogo BEYONIX
              </h2>
              <p className="mt-3 max-w-sm text-sm leading-6 text-white/58">
                Una selección de tecnología y accesorios pensados para comprar
                con confianza.
              </p>
            </div>
          )}
        </BeyonixCard>
      </div>

    </section>
  )
}
