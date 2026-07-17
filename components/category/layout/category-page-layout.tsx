"use client"

import {
  CreditCard,
  Headphones,
  ShieldCheck,
  Truck,
} from "lucide-react"

import { useCart } from "@/context/cart-context"
import type { SupabaseProducto } from "@/lib/supabase/types"
import { ProductDetailsModal } from "../../products/product-details-modal"
import { GlobalSearchBar } from "@/components/global-search-bar"
import { useCategoryProducts } from "../hooks/use-category-products"
import { useProductDetails } from "../use-product-details"
import { ProductsGrid } from "@/components/products/products-grid"
import { ProductsFiltersSidebar } from "@/components/products/products-filters-sidebar"
import { ProductsToolbar } from "@/components/products/products-toolbar"
import { SITE_SETTINGS } from "@/config/site-settings"
import { getImageUrlFromMediaIndex } from "@/lib/products/product-video"

interface CategoryPageLayoutProps {
  title: string
  description: string
  image?: string | null
  currentSlug: string
  products: SupabaseProducto[]
  priceRangeProducts?: SupabaseProducto[]
}

const storeBenefits = [
  { label: "Envíos a todo el país", icon: Truck },
  { label: "Hasta 12 cuotas", icon: CreditCard },
  { label: "Garantía oficial", icon: ShieldCheck },
  { label: "Atención personalizada", icon: Headphones },
]

export function CategoryPageLayout({
  title,
  image,
  products,
  priceRangeProducts,
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
  } = useCategoryProducts(products, priceRangeProducts)

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
    <main className="relative min-h-screen overflow-visible bg-black text-white">
      <div className="pointer-events-none absolute inset-0 z-0 h-full w-full beyonix-store-page-bg" />

      <div className="category-hero container relative z-20 mx-auto px-4 pb-8 pt-28 lg:px-8 lg:pb-10 lg:pt-32">
        <div className="relative mx-auto flex min-h-420px w-full max-w-[var(--beyonix-content-max)] flex-col justify-end overflow-hidden rounded-xl border border-beyonix-blue-light/30 bg-[#03070D] text-center shadow-[0_0_42px_rgba(30,140,255,0.1),0_26px_70px_rgba(0,0,0,0.42)] sm:min-h-[520px] lg:min-h-[600px]">
          {image ? (
            <img
              src={image}
              alt={title}
              className="absolute inset-0 z-0 size-full object-cover object-center"
            />
          ) : null}

          <div className="relative z-10 mx-auto flex w-full max-w-5xl flex-col items-center px-4 pb-8 sm:pb-10 lg:pb-12">
            <div className="global-search-wrapper flex w-full justify-center">
              <GlobalSearchBar
                search={search}
                className="max-w-3xl lg:max-w-4xl"
                surfaceClassName="!border-beyonix-blue-light/38 !bg-[#0A1420]/88 !shadow-[0_0_18px_rgba(30,140,255,0.08),inset_0_1px_0_rgba(255,255,255,0.07)] hover:!border-beyonix-sky/46 focus-within:!border-beyonix-sky/58 focus-within:!shadow-[0_0_18px_rgba(30,140,255,0.12),inset_0_1px_0_rgba(255,255,255,0.08)]"
                inputClassName="placeholder:text-white/58"
                buttonClassName="border-beyonix-blue-light/28 text-beyonix-sky/86 hover:bg-beyonix-blue/16 hover:text-white"
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
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-md border border-beyonix-blue-light/24 bg-beyonix-blue/34 text-white shadow-[0_0_8px_rgba(30,140,255,0.08)]">
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

      <section className="container relative z-20 mx-auto px-4 lg:px-8">
        <div className="beyonix-products-shell mx-auto grid max-w-[var(--beyonix-content-max)] grid-cols-1 gap-[clamp(1rem,1.4vw,1.5rem)] p-3 pb-10 sm:p-4 lg:grid-cols-products-layout lg:p-5 lg:pb-12">
          <div className="w-full lg:w-260px">
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

          <div className="min-w-0">
            <ProductsToolbar
              total={filteredProducts.length}
              sortBy={sortBy}
              setSortBy={setSortBy}
            />

            <ProductsGrid
              products={filteredProducts}
              onOpenPreview={openDetails}
              onAddToCart={handleProductCardAdd}
            />
          </div>
        </div>
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
    </main>
  )
}
