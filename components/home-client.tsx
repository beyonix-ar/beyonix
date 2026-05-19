"use client"

import { HeroSection } from "@/components/hero-section"
import { CategoriesSection } from "@/components/categories-section"
import { ProductsSection } from "@/components/products-section"
import { BenefitsSection } from "@/components/benefits-section"
import { PromoBanner } from "@/components/promo-banner"
import { ReviewsSection } from "@/components/reviews-section"
import { Footer } from "@/components/footer"
import { WhatsAppButton } from "@/components/whatsapp-button"
import { useCart } from "@/context/cart-context"

export function HomeClient() {
  const { addToCart } = useCart()

  // ✅ SIMPLE Y CORRECTO
  const handleAddToCart = (product: any, color: string) => {
    addToCart(product, color)
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

      <PromoBanner />

      <section id="reseñas">
        <ReviewsSection />
      </section>

      <section id="contacto">
        <Footer />
      </section>

      <WhatsAppButton />
    </>
  )
}