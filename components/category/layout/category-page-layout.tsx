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
    getQuantity,
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
      <div className="absolute inset-0 -z-10 h-full w-full beyonix-category-radial-bg" />

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

            <p className="mt-4 text-lg text-white/70 lg:text-xl">
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
        cartQuantity={
          product
            ? getQuantity(
                product.id,
                selectedColor
              )
            : 0
        }
      />
    </section>
  )
}
