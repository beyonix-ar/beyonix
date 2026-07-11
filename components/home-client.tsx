"use client"

import { useEffect } from "react"

import type { SupabaseProducto } from "@/lib/supabase/types"

import { useCart } from "@/context/cart-context"
import { useProductDetails } from "@/components/category/use-product-details"
import { getImageUrlFromMediaIndex } from "@/lib/products/product-video"

import { BenefitsSection } from "@/components/benefits-section"
import { CategoriesSection } from "@/components/categories-section"
import { HeroSection } from "@/components/hero-section"
import { ProductDetailsModal } from "@/components/products/product-details-modal"
import { ProductsSection } from "@/components/products-section"
import { ReviewsSection } from "@/components/reviews-section"
import { WhatsAppButton } from "@/components/whatsapp-button"

export function HomeClient() {
  const {
    addToCart,
    removeFromCart,
    decreaseQuantity,
    getQuantity,
    isInCart,
    openCart,
  } = useCart()

  const {
    isOpen,
    product,
    images,
    selectedImage,
    selectedColor,
    openDetails,
    closeDetails,
    nextImage,
    prevImage,
    changeColor,
    setSelectedImage,
  } = useProductDetails()

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
        <HeroSection onOpenPreview={openDetails} />
      </section>

      <section id="categorias">
        <CategoriesSection />
      </section>

      <section id="productos">
        <ProductsSection
          onAddToCart={handleAddToCart}
          onOpenPreview={openDetails}
        />
      </section>

      <section id="beneficios">
        <BenefitsSection />
      </section>

      <section id="reseñas">
        <ReviewsSection />
      </section>

      <ProductDetailsModal
        open={isOpen}
        product={product}
        images={images}
        selectedImage={selectedImage}
        selectedColor={selectedColor}
        onClose={closeDetails}
        onNext={nextImage}
        onPrev={prevImage}
        onSelectImage={setSelectedImage}
        onColorChange={changeColor}
        onAddToCart={() => {
          if (!product) {
            return
          }

          addToCart(
            product,
            selectedColor,
            getImageUrlFromMediaIndex(
              images,
              selectedImage,
              product.video_url
            )
          )
        }}
        onDecreaseCart={() => {
          if (!product) {
            return
          }

          decreaseQuantity(product.id, selectedColor)
        }}
        onRemoveFromCart={() => {
          if (!product) {
            return
          }

          removeFromCart(product.id, selectedColor)
        }}
        onViewCart={openCart}
        isInCart={product ? isInCart(product.id, selectedColor) : false}
        cartQuantity={product ? getQuantity(product.id, selectedColor) : 0}
      />

      <WhatsAppButton />
    </>
  )
}
