"use client"

import { useEffect } from "react"

import type { SupabaseProducto } from "@/lib/supabase/types"

import { useCart } from "@/context/cart-context"

import { BenefitsSection } from "@/components/benefits-section"
import { CategoriesSection } from "@/components/categories-section"
import { HeroSection } from "@/components/hero-section"
import { ProductsSection } from "@/components/products-section"
import { ReviewsSection } from "@/components/reviews-section"
import { WhatsAppButton } from "@/components/whatsapp-button"

export function HomeClient() {
  const { addToCart } = useCart()

  useEffect(() => {
    if (window.location.pathname !== "/") {
      window.history.replaceState(null, "", "/")
    }
  }, [])

  const handleAddToCart = (
    product: SupabaseProducto,
    color: string,
    image?: string
  ) => {
    addToCart(product, color, image)
  }

  return (
    <>
      <section id="inicio">
        <HeroSection />
      </section>

      <section id="categorias">
        <CategoriesSection />
      </section>

      <section id="productos">
        <ProductsSection onAddToCart={handleAddToCart} />
      </section>

      <section id="beneficios">
        <BenefitsSection />
      </section>

      <section id="reseñas">
        <ReviewsSection />
      </section>

      <WhatsAppButton />
    </>
  )
}
