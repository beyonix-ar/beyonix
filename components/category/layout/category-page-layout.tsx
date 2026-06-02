"use client"

import Image from "next/image"
import { Boxes } from "lucide-react"

import { useCart } from "@/context/cart-context"

import type { SupabaseProducto } from "@/lib/supabase/types"

import { ProductDetailsModal } from "../../products/product-details-modal"

import { GlobalSearchBar } from "@/components/global-search-bar"

import { CategorySort } from "../category-sort"
import { useCategoryProducts } from "../hooks/use-category-products"
import { useProductDetails } from "../use-product-details"

import { CategoryProductsGrid } from "./category-products-grid"
import { ProductsFiltersSidebar } from "@/components/products/products-filters-sidebar"
import { SITE_SETTINGS } from "@/config/site-settings"

interface CategoryPageLayoutProps {
  title: string
  description: string
  image?: string | null
  currentSlug: string
  products: SupabaseProducto[]
}

export function CategoryPageLayout({
  title,
  image,
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
    onlyOffers,
    setOnlyOffers,
    onlyBestSellers,
    setOnlyBestSellers,
    onlyInstallments,
    setOnlyInstallments,
    minPrice,
    setMinPrice,
    maxPrice,
    setMaxPrice,
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
      images[selectedImage]
    )
  }

  const handleProductCardAdd = (
    nextProduct: SupabaseProducto,
    color: string,
    nextImage?: string
  ) => {
    addToCart(
      nextProduct,
      color,
      nextImage
    )
  }

  return (
    <section className="relative min-h-screen overflow-visible text-white">
      <div className="pointer-events-none absolute inset-0 z-0 h-full w-full beyonix-category-page-bg" />

      <div className="category-hero container relative z-20 mx-auto px-4 pb-6 pt-24 lg:px-8 lg:pb-8 lg:pt-28">
        <div className="mx-auto max-w-1400px">
          <div className="relative min-h-300px overflow-hidden rounded-xl border border-white/12 beyonix-category-banner-glass sm:min-h-360px lg:min-h-420px">
            <div className="global-search-wrapper absolute left-0 right-0 top-4 z-30 flex justify-center px-4 sm:top-5">
              <GlobalSearchBar
                search={search}
                className="max-w-xl"
                products={products.map((product) => ({
                  id: String(product.id),
                  nombre: product.nombre,
                }))}
                onSearchChange={setSearch}
              />
            </div>

            {image ? (
              <Image
                fill
                src={image}
                alt={title}
                sizes="(min-width: 1536px) 1400px, 100vw"
                className="object-cover object-center beyonix-category-banner-image-fade"
                priority
              />
            ) : (
              <div className="flex h-full min-h-300px items-center justify-center bg-beyonix-surface-3 sm:min-h-360px lg:min-h-420px">
                <Boxes className="size-10 text-beyonix-cyan/45" />
              </div>
            )}

            <div className="pointer-events-none absolute inset-0 beyonix-category-banner-fade" />
          </div>
        </div>
      </div>

      <div className="category-products container relative z-20 mx-auto px-4 pb-16 lg:px-8 lg:pb-20">
        <div className="mx-auto grid max-w-1400px grid-cols-1 items-start gap-4 lg:grid-cols-products-layout lg:gap-5">
          <div className="flex justify-end lg:col-span-2 lg:row-start-1">
            <CategorySort
              sortBy={sortBy}
              onSortChange={setSortBy}
            />
          </div>

          <div className="w-full lg:col-start-1 lg:row-start-2 lg:w-260px">
            <ProductsFiltersSidebar
              categories={[]}
              selectedCategories={[]}
              setSelectedCategories={() => {}}
              onlyOffers={onlyOffers}
              setOnlyOffers={setOnlyOffers}
              onlyBestSellers={onlyBestSellers}
              setOnlyBestSellers={setOnlyBestSellers}
              onlyInstallments={onlyInstallments}
              setOnlyInstallments={setOnlyInstallments}
              minPrice={minPrice}
              setMinPrice={setMinPrice}
              maxPrice={maxPrice}
              setMaxPrice={setMaxPrice}
              showInstallmentsFilter={
                SITE_SETTINGS.filters.showInstallmentsFilter
              }
              showFeaturedFilter={
                SITE_SETTINGS.filters.showFeaturedFilter
              }
              showOfferFilter={
                SITE_SETTINGS.filters.showOfferFilter
              }
              showPriceFilter={
                SITE_SETTINGS.filters.showPriceFilter
              }
              showCategoryFilter={false}
            />
          </div>

          <div className="min-w-0 lg:col-start-2 lg:row-start-2">
            <CategoryProductsGrid
              products={filteredProducts}
              onOpenPreview={openDetails}
              onAddToCart={handleProductCardAdd}
            />
          </div>
        </div>
      </div>

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
