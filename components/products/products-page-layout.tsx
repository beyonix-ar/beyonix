"use client"

import { CATALOG_HERO_IMAGE_CLASS, CatalogHeroBanner } from "@/components/products/catalog-hero-banner"
import {
  Suspense,
  useEffect,
  useState,
} from "react"
import { useSearchParams } from "next/navigation"
import {
  ChevronLeft,
  ChevronRight,
} from "lucide-react"


import type {
  SupabaseCategoria,
  SupabaseProducto,
} from "@/lib/supabase/types"

import {
  getStoreCategorias,
  getStoreProductos,
} from "@/lib/supabase/queries/store"

import { useCart } from "@/context/cart-context"

import { useProductDetails } from "@/components/category/use-product-details"

import { GlobalSearchBar } from "@/components/global-search-bar"

import { ProductDetailsModal } from "@/components/products/product-details-modal"

import { ProductsFiltersSidebar } from "./products-filters-sidebar"

import { ProductsGrid } from "./products-grid"

import { ProductsToolbar } from "./products-toolbar"
import {
  getDefaultVariantOption,
} from "@/lib/products/product-variants"
import { getImageUrlFromMediaIndex } from "@/lib/products/product-video"
import { SITE_SETTINGS } from "@/config/site-settings"
import { useCatalogFilters } from "./use-catalog-filters"
import { CatalogPartialNotice, CatalogStatus } from "./catalog-status"
import {
  getCatalogViewState,
  isCatalogPartiallyLoaded,
  type CatalogLoadStatus,
} from "@/lib/products/catalog-view-state"

interface StoreBanner {
  id: string
  image_url: string | null
  alt_text: string | null
  sort_order?: number | null
}

function SearchParamSync({ onChange }: { onChange: (search: string) => void }) {
  const searchParams = useSearchParams()
  const search = searchParams.get("search") ?? ""
  useEffect(() => onChange(search), [search, onChange])
  return null
}

interface ProductsPageLayoutProps {
  initialProducts?: SupabaseProducto[]
  initialCategories?: SupabaseCategoria[]
  initialSearch?: string
}

export function ProductsPageLayout({
  initialProducts = [],
  initialCategories = [],
  initialSearch = "",
}: ProductsPageLayoutProps) {
  const [products, setProducts] = useState<SupabaseProducto[]>(initialProducts)
  const [categories, setCategories] = useState<SupabaseCategoria[]>(initialCategories)
  const [loadStatus, setLoadStatus] = useState<CatalogLoadStatus>("loading")
  const [reloadNonce, setReloadNonce] = useState(0)
  const [productsBanners, setProductsBanners] = useState<StoreBanner[]>([])
  const [activeBannerIndex, setActiveBannerIndex] = useState(0)
  const {
    search, setSearch, sortBy, setSortBy,
    selectedCategories, setSelectedCategories,
    selectedColors, setSelectedColors,
    onlyOffers, setOnlyOffers,
    onlyBestSellers, setOnlyBestSellers,
    minPrice, setMinPrice, maxPrice, setMaxPrice,
    priceRange, availableColors, filteredProducts, clearAll, restoreSearch,
  } = useCatalogFilters(products, undefined, initialSearch)
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

  // ─────────────────────────────────────
  // Load products
  // ─────────────────────────────────────

  useEffect(() => {
    // El servidor ya entregó una página inicial de productos en el
    // primer render (sin esperar hidratación). Este efecto completa
    // en segundo plano el catálogo completo para que el filtrado
    // client-side (categorías, color, precio, ofertas) tenga el
    // universo entero, sin bloquear el contenido inicial.
    // Un fallo de productos queda como estado de error (con Reintentar), nunca
    // como catálogo vacío; un fallo de categorías no bloquea los productos.
    let active = true

    async function loadProducts() {
      const [productsResult, categoriesResult] = await Promise.allSettled([
        getStoreProductos(),
        initialCategories.length
          ? Promise.resolve(initialCategories)
          : getStoreCategorias(),
      ])

      if (!active) return

      if (categoriesResult.status === "fulfilled") {
        setCategories(categoriesResult.value)
      } else {
        console.error(categoriesResult.reason)
      }

      if (productsResult.status === "fulfilled") {
        setProducts(productsResult.value)
        setLoadStatus("ready")
      } else {
        console.error(productsResult.reason)
        setLoadStatus("error")
      }
    }

    void loadProducts()

    return () => {
      active = false
    }
  }, [initialCategories, reloadNonce])

  const retryLoadProducts = () => {
    setLoadStatus("loading")
    setReloadNonce((current) => current + 1)
  }

  useEffect(() => {
    let active = true

    async function loadProductsBanner() {
      try {
        const response = await fetch("/api/store/banners?key=products_hero")
        const data = (await response.json()) as {
          banners?: StoreBanner[]
          banner?: StoreBanner | null
        }

        if (active) {
          setProductsBanners(
            (data.banners ?? (data.banner ? [data.banner] : [])).filter(
              (banner) => Boolean(banner.image_url)
            )
          )
        }
      } catch {
        if (active) {
          setProductsBanners([])
        }
      }
    }

    void loadProductsBanner()

    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    setActiveBannerIndex(0)
  }, [productsBanners.length])

  useEffect(() => {
    if (productsBanners.length < 2) return

    const timer = window.setInterval(() => {
      setActiveBannerIndex((current) => (current + 1) % productsBanners.length)
    }, 6500)

    return () => window.clearInterval(timer)
  }, [productsBanners.length])

  // Cart helpers
  // ─────────────────────────────────────

  const handleAddToCart = (
    product: SupabaseProducto,
    color?: string,
    image?: string
  ) => {
    const fallbackVariant =
      getDefaultVariantOption(product)

    addToCart(
      product,
      color ?? fallbackVariant.value,
      image ?? fallbackVariant.images[0]
    )
  }

  const modalProductQuantity =
    product
      ? getQuantity(
          product.id,
          selectedColor
        )
      : 0

  const modalProductInCart =
    product
      ? isInCart(
          product.id,
          selectedColor
        )
      : false

  const catalogViewState = getCatalogViewState({
    loadStatus,
    totalProducts: products.length,
    visibleProducts: filteredProducts.length,
  })
  const catalogPartiallyLoaded = isCatalogPartiallyLoaded({
    loadStatus,
    visibleProducts: filteredProducts.length,
  })

  const hasCarousel =
    productsBanners.length > 1

  const goToPreviousBanner = () => {
    setActiveBannerIndex((current) =>
      current === 0 ? productsBanners.length - 1 : current - 1
    )
  }

  const goToNextBanner = () => {
    setActiveBannerIndex((current) => (current + 1) % productsBanners.length)
  }

  // ─────────────────────────────────────
  // Render
  // ─────────────────────────────────────

  return (
    <main className="relative min-h-screen overflow-visible bg-black text-white">
      <Suspense fallback={null}><SearchParamSync onChange={restoreSearch} /></Suspense>
      <div className="pointer-events-none absolute inset-0 z-0 h-full w-full beyonix-store-page-bg" />

      <CatalogHeroBanner
        hasMedia={productsBanners.length > 0}
        media={
          <>
              {productsBanners.map((banner, index) =>
                banner.image_url ? (
                  <img
                    key={banner.id}
                    src={banner.image_url}
                    alt={banner.alt_text || "Banner de productos BEYONIX"}
                    className={`${CATALOG_HERO_IMAGE_CLASS} transition-opacity duration-700 ease-out ${
                      index === activeBannerIndex ? "opacity-100" : "opacity-0"
                    }`}
                  />
                ) : null
              )}

              {hasCarousel ? (
                <>
                  <button
                    type="button"
                    aria-label="Banner anterior"
                    onClick={goToPreviousBanner}
                    className="absolute left-4 top-1/2 z-20 hidden size-10 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full border border-white/10 bg-[#03070D]/45 text-white/62 transition hover:border-beyonix-sky/35 hover:text-white sm:flex"
                  >
                    <ChevronLeft className="size-4" />
                  </button>
                  <button
                    type="button"
                    aria-label="Banner siguiente"
                    onClick={goToNextBanner}
                    className="absolute right-4 top-1/2 z-20 hidden size-10 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full border border-white/10 bg-[#03070D]/45 text-white/62 transition hover:border-beyonix-sky/35 hover:text-white sm:flex"
                  >
                    <ChevronRight className="size-4" />
                  </button>
                  <div className="absolute bottom-5 left-0 right-0 z-20 flex justify-center gap-2">
                    {productsBanners.map((banner, index) => (
                      <button
                        key={banner.id}
                        type="button"
                        aria-label={`Ver banner ${index + 1}`}
                        onClick={() => setActiveBannerIndex(index)}
                        className={`h-1.5 cursor-pointer rounded-full transition-all ${
                          index === activeBannerIndex
                            ? "w-8 bg-beyonix-sky"
                            : "w-3 bg-white/24 hover:bg-white/45"
                        }`}
                      />
                    ))}
                  </div>
                </>
              ) : null}
          </>
        }
        search={
          <GlobalSearchBar
                search={search}
                className="max-w-3xl lg:max-w-4xl"
                surfaceClassName="!border-beyonix-blue-light/38 !bg-[#0A1420]/88 !shadow-[0_0_18px_rgba(30,140,255,0.08),inset_0_1px_0_rgba(255,255,255,0.07)] hover:!border-beyonix-sky/46 focus-within:!border-beyonix-sky/58 focus-within:!shadow-[0_0_18px_rgba(30,140,255,0.12),inset_0_1px_0_rgba(255,255,255,0.08)]"
                inputClassName="placeholder:text-white/58"
                buttonClassName="border-beyonix-blue-light/28 text-beyonix-sky/86 hover:bg-beyonix-blue/16 hover:text-white"
                onSearchChange={setSearch}
                products={products.map((product) => ({
                  id: String(product.id),
                  nombre: product.nombre,
                }))}
          />
        }
      />

      <section className="container relative z-20 mx-auto px-4 lg:px-8">
        <div className="beyonix-products-shell mx-auto grid max-w-[var(--beyonix-content-max)] grid-cols-1 gap-[clamp(1rem,1.4vw,1.5rem)] p-3 pb-10 sm:p-4 lg:grid-cols-products-layout lg:p-5 lg:pb-12">
          <div className="w-full lg:w-260px">
            <ProductsFiltersSidebar
              onClearAll={clearAll}
              categories={categories}
              selectedCategories={
                selectedCategories
              }
              setSelectedCategories={
                setSelectedCategories
              }
              selectedColors={
                selectedColors
              }
              availableColors={
                availableColors
              }
              setSelectedColors={
                setSelectedColors
              }
              onlyOffers={
                onlyOffers
              }
              setOnlyOffers={
                setOnlyOffers
              }
              minPrice={minPrice}
              setMinPrice={
                setMinPrice
              }
              maxPrice={maxPrice}
              setMaxPrice={
                setMaxPrice
              }
              minPriceLimit={
                priceRange.min
              }
              maxPriceLimit={
                priceRange.max
              }
              priceStep={
                priceRange.step
              }
              onlyBestSellers={
                onlyBestSellers
              }
              setOnlyBestSellers={
                setOnlyBestSellers
              }
              showFeaturedFilter={
                SITE_SETTINGS.filters
                  .showFeaturedFilter
              }
              showOfferFilter={
                SITE_SETTINGS.filters
                  .showOfferFilter
              }
              showPriceFilter={
                SITE_SETTINGS.filters
                  .showPriceFilter
              }
              showCategoryFilter={
                SITE_SETTINGS.filters
                  .showCategoryFilter
              }
            />
          </div>

          <div className="min-w-0">
            <ProductsToolbar
              total={
                filteredProducts.length
              }
              sortBy={sortBy}
              setSortBy={setSortBy}
            />

            {catalogPartiallyLoaded && (
              <CatalogPartialNotice onRetry={retryLoadProducts} />
            )}

            {catalogViewState === "results" ? (
              <ProductsGrid
                products={
                  filteredProducts
                }
                onOpenPreview={
                  openDetails
                }
                onAddToCart={
                  handleAddToCart
                }
              />
            ) : (
              <CatalogStatus
                state={catalogViewState}
                onRetry={retryLoadProducts}
                onClearFilters={clearAll}
              />
            )}
          </div>
        </div>
      </section>

      {/* Product modal */}
      <ProductDetailsModal
        open={isOpen}
        product={product}
        images={images}
        selectedImage={
          selectedImage
        }
        selectedColor={
          selectedColor
        }
        onClose={closeDetails}
        onNext={nextImage}
        onPrev={prevImage}
        onSelectImage={
          setSelectedImage
        }
        onColorChange={
          changeColor
        }
        onAddToCart={() => {
          if (!product) {
            return
          }

          handleAddToCart(
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

          decreaseQuantity(
            product.id,
            selectedColor
          )
        }}
        onRemoveFromCart={() => {
          if (!product) {
            return
          }

          removeFromCart(
            product.id,
            selectedColor
          )
        }}
        onViewCart={openCart}
        isInCart={
          modalProductInCart
        }
        cartQuantity={
          modalProductQuantity
        }
      />
    </main>
  )
}
