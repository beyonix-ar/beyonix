"use client"

import {
  useEffect,
  useState,
} from "react"

import Image from "next/image"
import Link from "next/link"

import {
  ArrowRight,
  ShoppingBag,
  Tag,
} from "lucide-react"

import type {
  SupabaseProducto,
} from "@/lib/supabase/types"

import { getFeaturedProductos } from "@/lib/supabase/queries/store"

import { getProductDiscount } from "@/lib/store-config"
import {
  getDefaultVariantOption,
} from "@/lib/products/product-variants"

interface ProductsSectionProps {
  onAddToCart: (
    product: SupabaseProducto,
    color: string,
    image?: string
  ) => void
}

const formatPrice = (
  price: number
) =>
  new Intl.NumberFormat(
    "es-AR",
    {
      style: "currency",
      currency: "ARS",
      minimumFractionDigits: 0,
    }
  ).format(price)

export function ProductsSection({
  onAddToCart,
}: ProductsSectionProps) {
  const [products, setProducts] =
    useState<SupabaseProducto[]>(
      []
    )

  useEffect(() => {
    getFeaturedProductos().then(
      setProducts
    )
  }, [])

  return (
    <section
      id="productos"
      className="scroll-mt-20 beyonix-section-spacing"
    >
      <div className="container mx-auto px-4 lg:px-8">
        <div className="mb-[clamp(2rem,3.6vw,3rem)] flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="mb-2 text-11px font-semibold uppercase tracking-widest text-beyonix-cyan">
              Destacados
            </p>

            <h2 className="text-[clamp(1.85rem,2.6vw,2.65rem)] font-bold tracking-tight text-white">
              Productos populares
            </h2>
          </div>

          <Link
            href="/productos"
            className="inline-flex h-10 items-center gap-2 self-start rounded-xl border border-white/15 px-5 text-sm font-medium text-white/80 transition-colors hover:border-white/30 hover:text-white lg:self-auto"
          >
            Ver todos los
            productos

            <ArrowRight className="size-3.5" />
          </Link>
        </div>

        <div className="mx-auto grid grid-cols-1 items-stretch justify-center gap-[clamp(1rem,1.4vw,1.35rem)] sm:grid-cols-product-cards-2 xl:grid-cols-product-cards-4">
          {products.map(
            (product) => {
              const discount =
                getProductDiscount(
                  product.id
                )

              const hasSale =
                discount > 0

              const finalPrice =
                Math.round(
                  product.precio *
                    (1 -
                      discount)
                )

              const defaultVariant =
                getDefaultVariantOption(product)

              const image =
                defaultVariant.images[0]

              return (
                <article
                  key={
                    product.id
                  }
                  className="group flex h-full w-full max-w-[var(--beyonix-product-card-max)] flex-col overflow-hidden rounded-2xl border border-white/6 bg-beyonix-surface transition-all duration-300 hover:border-white/12 hover:shadow-xl hover:shadow-black/50"
                >
                  <div className="relative h-[clamp(220px,14vw,300px)] shrink-0 overflow-hidden bg-white p-2">
                    <Image
                      fill
                      src={image}
                      alt={
                        product.nombre
                      }
                      sizes="(min-width: 640px) 280px, calc(100vw - 32px)"
                      className="object-contain transition-transform duration-500 group-hover:scale-105"
                    />
                  </div>

                  <div className="flex flex-1 flex-col p-4">
                    <p className="truncate text-10px font-semibold uppercase tracking-widest text-white/45">
                      {
                        product
                          .categorias
                          ?.nombre
                      }
                    </p>

                    <h3 className="mt-1.5 min-h-44px line-clamp-2 text-15px font-semibold leading-product-title text-white">
                      {
                        product.nombre
                      }
                    </h3>

                    <div className="mt-auto border-t border-white/5 pt-3">
                      <div className="mb-4 flex min-h-88px flex-col justify-start">
                        <div className="flex items-center gap-2">
                          <span className="text-19px font-bold leading-none text-white">
                            {formatPrice(
                              finalPrice
                            )}
                          </span>

                          {hasSale && (
                            <span className="inline-flex items-center gap-1 rounded-md border border-green-500/20 bg-green-500/12 px-1.5 py-0.5">
                              <Tag className="size-2.5 text-green-400" />

                              <span className="text-11px font-bold leading-none text-green-400">
                                -
                                {Math.round(
                                  discount *
                                    100
                                )}
                                %
                              </span>
                            </span>
                          )}
                        </div>

                        {hasSale && (
                          <p className="mt-1 text-13px leading-none text-white/45 line-through">
                            {formatPrice(
                              product.precio
                            )}
                          </p>
                        )}

                        {!hasSale && (
                          <div className="mt-1 min-h-18px" />
                        )}
                      </div>

                      <button
                        type="button"
                        title={`Agregar ${product.nombre}`}
                        aria-label={`Agregar ${product.nombre}`}
                        onClick={() =>
                          onAddToCart(
                            product,
                            defaultVariant.value,
                            image
                          )
                        }
                        className="flex h-9 w-full items-center justify-center gap-2 rounded-lg bg-white text-13px font-semibold text-black transition-all hover:bg-white/90 active:scale-95 cursor-pointer"
                      >
                        <ShoppingBag className="size-3.5" />

                        Añadir al carrito
                      </button>
                    </div>
                  </div>
                </article>
              )
            }
          )}
        </div>
      </div>
    </section>
  )
}
