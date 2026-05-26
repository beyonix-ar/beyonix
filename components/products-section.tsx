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
      className="scroll-mt-20 bg-[#030303] py-16 lg:py-24"
    >
      <div className="container mx-auto px-4 lg:px-8">
        <div className="mb-12 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="mb-2 text-11px font-semibold uppercase tracking-[0.25em] text-[#4A90B8]">
              Destacados
            </p>

            <h2 className="text-3xl font-bold tracking-tight text-white lg:text-4xl">
              Productos populares
            </h2>
          </div>

          <Link
            href="/productos"
            className="inline-flex h-10 items-center gap-2 self-start rounded-xl border border-white/15 px-5 text-sm font-medium text-white/70 transition-colors hover:border-white/30 hover:text-white lg:self-auto"
          >
            Ver todos los
            productos

            <ArrowRight className="size-3.5" />
          </Link>
        </div>

        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-4">
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

              const image =
                product
                  .imagenes_producto?.[0]
                  ?.url ||
                product.imagen_principal ||
                "/placeholder.png"

              return (
                <article
                  key={
                    product.id
                  }
                  className="group overflow-hidden rounded-2xl border border-white/6 bg-[#0A0A0A] transition-all duration-300 hover:border-white/12 hover:shadow-xl hover:shadow-black/50"
                >
                  <div className="relative aspect-square overflow-hidden bg-white">
                    <Image
                      fill
                      src={image}
                      alt={
                        product.nombre
                      }
                      className="object-cover transition-transform duration-500 group-hover:scale-105"
                    />
                  </div>

                  <div className="flex flex-col p-4">
                    <p className="truncate text-10px font-semibold uppercase tracking-[0.2em] text-white/35">
                      {
                        product
                          .categorias
                          ?.nombre
                      }
                    </p>

                    <h3 className="mt-1.5 min-h-44px line-clamp-2 text-15px font-semibold leading-[1.375rem] text-white">
                      {
                        product.nombre
                      }
                    </h3>

                    <div className="mt-3 border-t border-white/5 pt-3">
                      <div className="mb-4 flex min-h-52px flex-col justify-center">
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
                          <p className="mt-1 text-13px leading-none text-white/35 line-through">
                            {formatPrice(
                              product.precio
                            )}
                          </p>
                        )}
                      </div>

                      <button
                        type="button"
                        title={`Agregar ${product.nombre}`}
                        aria-label={`Agregar ${product.nombre}`}
                        onClick={() =>
                          onAddToCart(
                            product,
                            "default",
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