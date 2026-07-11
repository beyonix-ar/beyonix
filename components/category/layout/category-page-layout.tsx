"use client"

import Image from "next/image"
import {
  Boxes,
  CreditCard,
  Headphones,
  ShieldCheck,
  Truck,
} from "lucide-react"

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
import { getImageUrlFromMediaIndex } from "@/lib/products/product-video"

interface CategoryPageLayoutProps {
  title: string
  description: string
  image?: string | null
  currentSlug: string
  products: SupabaseProducto[]
}

const storeBenefits = [
  { label: "Envíos a todo el país", icon: Truck },
  { label: "Hasta 12 cuotas", icon: CreditCard },
  { label: "Garantía oficial", icon: ShieldCheck },
  { label: "Atención personalizada", icon: Headphones },
]

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
    priceRange,
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
      getImageUrlFromMediaIndex(
        images,
        selectedImage,
        product.video_url
      )
    )
  }

  const handleProductCardAdd = (
    nextProduct: SupabaseProducto,
    color: string,
    nextImage?: string
  ) => {
    addToCart(nextProduct, color, nextImage)
  }

  return (
    <section className="relative min-h-screen overflow-visible text-white">
      <div className="pointer-events-none absolute inset-0 z-0 h-full w-full beyonix-store-page-bg" />

      <div className="category-hero container relative z-20 mx-auto px-4 pb-8 pt-28 lg:px-8 lg:pb-10 lg:pt-32">
        <div className="mx-auto max-w-1400px">
          <div className="beyonix-store-hero relative flex min-h-420px flex-col items-center justify-center overflow-hidden rounded-xl px-4 py-12 text-center sm:min-h-[500px] lg:min-h-[560px]">
            {image ? (
              <Image
                fill
                src={image}
                alt={title}
                sizes="(min-width: 1536px) 1400px, 100vw"
                className="z-0 object-cover object-center opacity-25 beyonix-category-banner-image-fade"
                priority
              />
            ) : (
              <div className="absolute inset-0 z-0 flex items-center justify-center bg-beyonix-surface-3">
                <Boxes className="size-10 text-beyonix-cyan/45" />
              </div>
            )}

            <div className="pointer-events-none absolute inset-0 beyonix-category-banner-fade" />

            <div className="relative z-20 mx-auto flex w-full max-w-5xl flex-col items-center">
              <p className="beyonix-metal-title text-[60px] font-black uppercase leading-none sm:text-[104px] lg:text-[146px]">
                BEYONIX
              </p>
              <p className="mt-4 text-18px font-medium text-white/84 sm:text-21px">
                Tecnología pensada para tu{" "}
                <span className="text-beyonix-sky">comodidad</span>
              </p>
              <p className="mt-3 text-11px font-semibold uppercase tracking-[0.28em] text-beyonix-cyan/80">
                {title}
              </p>

              {description ? (
                <p className="mt-3 max-w-[520px] text-sm leading-relaxed text-white/68 sm:text-base">
                  {description}
                </p>
              ) : null}

              <div className="global-search-wrapper mt-8 flex w-full justify-center">
                <GlobalSearchBar
                  search={search}
                  className="max-w-3xl lg:max-w-4xl"
                  products={products.map((nextProduct) => ({
                    id: String(nextProduct.id),
                    nombre: nextProduct.nombre,
                  }))}
                  onSearchChange={setSearch}
                />
              </div>

              <div className="mt-6 grid w-full max-w-4xl grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {storeBenefits.map(({ label, icon: Icon }) => (
                  <div
                    key={label}
                    className="beyonix-benefit-item flex items-center gap-3 rounded-lg px-3 py-3 text-left"
                  >
                    <span className="flex size-10 shrink-0 items-center justify-center rounded-md border border-beyonix-blue-light/35 bg-beyonix-blue/55 text-white shadow-[0_0_18px_rgba(30,140,255,0.18)]">
                      <Icon className="size-4" />
                    </span>
                    <span className="text-13px font-semibold text-white/86">
                      {label}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="category-products container relative z-20 mx-auto px-4 pb-16 lg:px-8 lg:pb-20">
        <div className="beyonix-products-shell mx-auto grid max-w-1400px grid-cols-1 items-start gap-4 p-3 sm:p-4 lg:grid-cols-products-layout lg:gap-5 lg:p-5">
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
              minPriceLimit={priceRange.min}
              maxPriceLimit={priceRange.max}
              priceStep={priceRange.step}
              showInstallmentsFilter={SITE_SETTINGS.filters.showInstallmentsFilter}
              showFeaturedFilter={SITE_SETTINGS.filters.showFeaturedFilter}
              showOfferFilter={SITE_SETTINGS.filters.showOfferFilter}
              showPriceFilter={SITE_SETTINGS.filters.showPriceFilter}
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

          decreaseQuantity(product.id, selectedColor)
        }}
        onRemoveFromCart={() => {
          if (!product) return

          removeFromCart(product.id, selectedColor)
        }}
        onViewCart={openCart}
        isInCart={product ? isInCart(product.id, selectedColor) : false}
        cartQuantity={product ? getQuantity(product.id, selectedColor) : 0}
      />
    </section>
  )
}
