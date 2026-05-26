"use client"

import { useCart } from "@/context/cart-context"

import type { SupabaseProducto } from "@/lib/supabase/types"

import { ProductDetailsModal } from "../../products/product-details-modal"

import { GlobalSearchBar } from "@/components/global-search-bar"

import { CategorySort } from "../category-sort"
import { useCategoryProducts } from "../hooks/use-category-products"
import { useProductDetails } from "../use-product-details"

import { CategoryProductsGrid } from "./category-products-grid"

interface CategoryPageLayoutProps {
  title: string
  description: string
  currentSlug: string
  products: SupabaseProducto[]
}

export function CategoryPageLayout({
  title,
  description,
  products,
}: CategoryPageLayoutProps) {
  const {
    addToCart,
    removeFromCart,
    decreaseQuantity,
    isInCart,
    openCart,
  } = useCart()

  const {
    search,
    setSearch,
    sortBy,
    setSortBy,
    filteredProducts,
  } = useCategoryProducts(products)

  const {
    isOpen,
    product,
    selectedColor,
    selectedImage,
    images,
    openDetails,
    closeDetails,
    nextImage,
    prevImage,
    changeColor,
    setSelectedImage,
  } = useProductDetails()

  const handleAddToCart = () => {
    if (!product) return

    addToCart(
      product,
      selectedColor,
      images?.[0]
    )
  }

  return (
    <section className="relative min-h-screen overflow-visible text-white">
      <div className="absolute inset-0 -z-10 h-full w-full [background:radial-gradient(70%_50%_at_50%_0%,rgba(17,42,67,0.5)_0%,#000000_85%)]" />

      <div className="global-search-wrapper absolute left-0 right-0 top-24 z-40">
        <GlobalSearchBar
          search={search}
          products={products.map((product) => ({
            id: String(product.id),
            nombre: product.nombre,
          }))}
          onSearchChange={setSearch}
        />
      </div>

      <div className="category-hero container relative z-20 mx-auto px-4 pb-14 pt-50 lg:px-8">
        <div className="flex items-start justify-between gap-6">
          <div>
            <h1 className="text-3xl font-bold tracking-tight lg:text-5xl">
              {title}
            </h1>

            <p className="mt-4 text-lg text-white/60 lg:text-xl">
              {description}
            </p>
          </div>

          <div className="pt-4">
            <CategorySort
              sortBy={sortBy}
              onSortChange={setSortBy}
            />
          </div>
        </div>
      </div>

      <CategoryProductsGrid
        products={filteredProducts}
        onOpenPreview={openDetails}
      />

      <footer className="border-t border-white/10 py-8">
        <div className="container mx-auto px-4 text-sm text-white/50 lg:px-8">
          © 2026 BEYONIX. Todos los derechos reservados.
        </div>
      </footer>

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
        onAddToCart={handleAddToCart}
        onDecreaseCart={() => {
          if (!product) return

          decreaseQuantity(
            product.id,
            selectedColor
          )
        }}
        onRemoveFromCart={() => {
          if (!product) return

          removeFromCart(
            product.id,
            selectedColor
          )
        }}
        onViewCart={openCart}
        isInCart={
          product
            ? isInCart(
                product.id,
                selectedColor
              )
            : false
        }
      />
    </section>
  )
}