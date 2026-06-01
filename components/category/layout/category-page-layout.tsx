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
  description,
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
        <div className="grid gap-8 lg:grid-cols-category-hero lg:items-end">
          <div className="min-w-0">
            <p className="mb-3 text-11px font-semibold uppercase tracking-widest text-beyonix-cyan">
              Categoria
            </p>

            <h1 className="text-4xl font-bold tracking-tight lg:text-6xl">
              {title}
            </h1>

            {description && (
              <p className="mt-4 max-w-2xl text-base leading-7 text-white/68 lg:text-lg">
                {description}
              </p>
            )}

            <p className="mt-4 text-sm font-medium text-white/45">
              {filteredProducts.length} producto{filteredProducts.length === 1 ? "" : "s"} disponible{filteredProducts.length === 1 ? "" : "s"}
            </p>
          </div>

          <div className="relative min-h-220px overflow-hidden rounded-2xl border border-white/8 bg-beyonix-surface-3">
            {image ? (
              <Image
                fill
                src={image}
                alt={title}
                sizes="(min-width: 1024px) 420px, 100vw"
                className="object-cover"
              />
            ) : (
              <div className="flex h-full min-h-220px items-center justify-center">
                <Boxes className="size-10 text-beyonix-cyan/45" />
              </div>
            )}
            <div className="absolute inset-0 bg-linear-to-t from-black/55 via-transparent to-transparent" />
          </div>

          <div className="lg:col-span-2">
            <CategorySort
              sortBy={sortBy}
              onSortChange={setSortBy}
            />
          </div>
        </div>
      </div>

      <div className="category-products container relative z-0 mx-auto grid grid-cols-1 gap-8 px-4 pb-20 lg:grid-cols-products-layout lg:px-8">
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

        <CategoryProductsGrid
          products={filteredProducts}
          onOpenPreview={openDetails}
        />
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
