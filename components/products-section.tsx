"use client"

import { useEffect, useState } from "react"

import Link from "next/link"

import { ArrowRight, PackageCheck } from "lucide-react"

import {
  BeyonixButton,
  BeyonixEmptyState,
  BeyonixSectionHeader,
} from "@/components/beyonix-ui"
import SharedProductCard from "@/components/products/shared/shared-product-card"
import { getFeaturedProductos } from "@/lib/supabase/queries/store"
import type { SupabaseProducto } from "@/lib/supabase/types"
import { cn } from "@/lib/utils"

interface ProductsSectionProps {
  onAddToCart: (
    product: SupabaseProducto,
    color: string,
    image?: string
  ) => void
  onOpenPreview: (product: SupabaseProducto) => void
}

export function ProductsSection({
  onAddToCart,
  onOpenPreview,
}: ProductsSectionProps) {
  const [products, setProducts] = useState<SupabaseProducto[]>([])
  const hasSingleProduct = products.length === 1

  useEffect(() => {
    getFeaturedProductos().then(setProducts)
  }, [])

  return (
    <section id="productos" className="scroll-mt-20 beyonix-section-spacing">
      <div className="container mx-auto px-4 lg:px-8">
        <BeyonixSectionHeader
          eyebrow="Destacados"
          title="Productos populares"
          description="Una selección de productos activos para descubrir tecnología útil, con precios claros y compra directa."
          action={
            <BeyonixButton asChild variant="outline">
              <Link href="/productos">
                Ver todos los productos
                <ArrowRight className="size-3.5" />
              </Link>
            </BeyonixButton>
          }
        />

        {!products.length ? (
          <BeyonixEmptyState
            icon={<PackageCheck className="size-5" />}
            title="Todavía no hay productos destacados"
            description="Cuando se destaquen productos desde el panel, aparecerán en esta sección."
            action={
              <BeyonixButton asChild variant="outline">
                <Link href="/productos">Ver catálogo</Link>
              </BeyonixButton>
            }
          />
        ) : (
          <div
            className={cn(
              "grid w-full min-w-0 items-stretch gap-[clamp(1rem,1.4vw,1.35rem)]",
              hasSingleProduct
                ? "justify-center"
                : "grid-cols-1 md:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4"
            )}
            style={
              hasSingleProduct
                ? { gridTemplateColumns: "minmax(280px, 320px)" }
                : undefined
            }
          >
            {products.map((product) => (
              <div key={product.id} className="w-full min-w-0">
                <SharedProductCard
                  product={product}
                  onAddToCart={onAddToCart}
                  onOpenPreview={onOpenPreview}
                  showFavorite={false}
                  showRating={false}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}
