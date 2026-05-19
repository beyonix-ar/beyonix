"use client"

import Image from "next/image"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ShoppingBag, Heart } from "lucide-react"
import { getProductDiscount } from "@/lib/store-config"
import { productsData } from "@/lib/products"

interface ProductsSectionProps {
  onAddToCart: (
    product: any,
    color: string,
    image?: string
  ) => void
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
    <section className="py-16 lg:py-24 bg-secondary/30" id="productos">
      <div className="container mx-auto px-4 lg:px-8">
        
        {/* Header */}
        <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4 mb-12 lg:mb-16">
          <div>
            <p className="text-sm font-medium tracking-widest text-muted-foreground uppercase mb-3">
              Destacados
            </p>
            <h2 className="text-3xl lg:text-5xl font-bold tracking-tight text-foreground">
              Productos populares
            </h2>
          </div>

          <Button
            type="button"
            variant="outline"
            aria-label="Ver todos los productos"
          >
            Ver todos los productos
          </Button>
        </div>

        {/* Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-5">
          {featured.map((product) => {
            const discount = getProductDiscount(product.id)
            const finalPrice = Math.round(product.price * (1 - discount))
            const hasSale = discount > 0

            const defaultColor = product.colors?.[0]?.name ?? "default"
            const previewImage =
              product.colors?.[0]?.images?.[0] ?? "/placeholder.png"

            return (
              <article
                key={product.id}
                className="group flex flex-col bg-card border border-border rounded-lg overflow-hidden hover:border-muted-foreground/30 transition"
              >
                {/* Imagen */}
                <div className="relative aspect-square bg-muted overflow-hidden">
                  <Image
                    src={previewImage}
                    alt={product.name}
                    fill
                    className="object-cover transition-transform duration-500 group-hover:scale-105"
                  />

                  {hasSale && (
                    <Badge className="absolute top-3 left-3 bg-foreground text-background">
                      Oferta
                    </Badge>
                  )}

                  <div className="absolute top-3 right-3 opacity-0 group-hover:opacity-100 transition">
                    <Button
                      type="button"
                      size="icon"
                      variant="secondary"
                      className="size-9 rounded-full"
                    >
                      <Heart className="size-4" />
                    </Button>
                  </div>
                </div>

                {/* Contenido */}
                <div className="flex flex-col flex-1 p-4">
                  <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">
                    {product.category}
                  </p>

                  <h3 className="min-h-48px line-clamp-2 text-lg font-semibold text-white">
                    {product.name}
                  </h3>

                  <div className="mt-3 space-y-1">
                    <span className="text-xl font-bold block">
                      {formatPrice(finalPrice)}
                    </span>

                    {hasSale && (
                      <span className="text-sm line-through text-muted-foreground">
                        {formatPrice(product.price)}
                      </span>
                    )}
                  </div>

                  {/* BOTÓN */}
                  <Button
                    type="button"
                    className="w-full mt-auto cursor-pointer"
                    onClick={() =>
                      onAddToCart(product, defaultColor, previewImage)
                    }
                  >
                    <ShoppingBag className="size-4 mr-2" />
                    Añadir al carrito
                  </Button>
                </div>
              </article>
            )
          })}
        </div>
      </div>
    </section>
  )
}