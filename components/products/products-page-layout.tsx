"use client"

import { StoreBenefits } from "@/components/products/store-benefits"
import {
  Suspense,
  useEffect,
  useMemo,
  useState,
} from "react"
import {
  ChevronLeft,
  ChevronRight,
} from "lucide-react"

import { useSearchParams } from "next/navigation"

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
  getProductVariantOptions,
} from "@/lib/products/product-variants"
import {
  getProductPriceRange,
} from "@/lib/products/price-range"
import { getImageUrlFromMediaIndex } from "@/lib/products/product-video"
import { SITE_SETTINGS } from "@/config/site-settings"
import { BASE_COLOR_ORDER, variantBaseColors } from "@/lib/products/product-color-filters"

interface StoreBanner {
  id: string
  image_url: string | null
  alt_text: string | null
  sort_order?: number | null
}

// Colores base de un producto: de sus variantes físicas activas (nombre y
// cada color, incluido el segundo de una bicolor). Un producto aleatorio se
// filtra por los colores reales que puede recibir el cliente.
function getProductBaseColors(product: SupabaseProducto) {
  const colors = new Set<string>()
  const activeVariants = (product.producto_variantes ?? []).filter((variant) => variant.activo !== false)
  const sources = activeVariants.length
    ? activeVariants.map((variant) => ({ name: variant.nombre, colorHex: variant.color_hex, secondaryColorHex: variant.color_hex_secundario ?? null }))
    : getProductVariantOptions(product).map((option) => ({ name: option.name, colorHex: option.colorHex, secondaryColorHex: option.secondaryColorHex }))
  for (const variant of sources) {
    variantBaseColors(variant, product.nombre).forEach((color) => colors.add(color))
  }
  return [...colors]
}

// useSearchParams() obliga a Next.js a mostrar el fallback de Suspense
// durante el render estático/ISR si envuelve todo el árbol. Se aísla acá,
// en una hoja sin salida visual, para que el resto de la página (grilla
// de productos con contenido real) se sirva desde el servidor sin
// depender de esto.
function SearchParamSync({
  onChange,
}: {
  onChange: (value: string) => void
}) {
  const searchParams = useSearchParams()

  useEffect(() => {
    onChange(searchParams.get("search") || "")
  }, [searchParams, onChange])

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
  const initialPriceRange = getProductPriceRange(initialProducts)
  const [products, setProducts] =
    useState<
      SupabaseProducto[]
    >(initialProducts)

  const [categories, setCategories] =
    useState<SupabaseCategoria[]>(initialCategories)

  const [search, setSearch] =
    useState(initialSearch)

  const [productsBanners, setProductsBanners] =
    useState<StoreBanner[]>([])

  const [
    activeBannerIndex,
    setActiveBannerIndex,
  ] = useState(0)

  const [sortBy, setSortBy] =
    useState("relevance")

  const [
    selectedCategories,
    setSelectedCategories,
  ] = useState<string[]>([])

  const [
    selectedColors,
    setSelectedColors,
  ] = useState<string[]>([])

  const [onlyOffers, setOnlyOffers] =
    useState(false)

  const [
    onlyBestSellers,
    setOnlyBestSellers,
  ] = useState(false)

  const [minPrice, setMinPrice] =
    useState(initialPriceRange.min)

  const [maxPrice, setMaxPrice] =
    useState(initialPriceRange.max)

  const priceRange = useMemo(
    () =>
      getProductPriceRange(
        products
      ),
    [products]
  )

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
    async function loadProducts() {
      try {
        const [productsData, categoriesData] = await Promise.all([
          getStoreProductos(),
          initialCategories.length
            ? Promise.resolve(initialCategories)
            : getStoreCategorias(),
        ])

        const nextPriceRange =
          getProductPriceRange(
            productsData
          )

        setProducts(productsData)
        setCategories(categoriesData)
        setMinPrice(
          nextPriceRange.min
        )
        setMaxPrice(
          nextPriceRange.max
        )
      } catch (error) {
        console.error(error)
      }
    }

    loadProducts()
  }, [initialCategories])

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

  useEffect(() => {
    const activeSlugs = new Set(
      categories.map((category) => category.slug)
    )

    setSelectedCategories((current) =>
      current.filter((slug) => activeSlugs.has(slug))
    )
  }, [categories])

  const availableColors =
    useMemo(() => {
      const colors = new Set<string>()

      products.forEach((product) => {
        getProductBaseColors(product).forEach((color) =>
          colors.add(color)
        )
      })

      return BASE_COLOR_ORDER.filter((color) => colors.has(color))
    }, [products])

  // ─────────────────────────────────────
  // Filters
  // ─────────────────────────────────────

  const filteredProducts =
    useMemo(() => {
      return products
        .filter((product) => {
          const matchCategory =
            !SITE_SETTINGS.filters.showCategoryFilter ||
            !selectedCategories.length ||
            selectedCategories.includes(
              product.categorias
                ?.slug || ""
            )

          const matchOffers =
            !SITE_SETTINGS.filters.showOfferFilter ||
            !onlyOffers ||
            !!product.precio_anterior

          const matchBestSellers =
            !SITE_SETTINGS.filters.showFeaturedFilter ||
            !onlyBestSellers ||
            product.destacado


          const matchPrice =
            !SITE_SETTINGS.filters.showPriceFilter ||
            product.precio >=
              minPrice &&
            product.precio <=
              maxPrice

          const productBaseColors =
            selectedColors.length > 0
              ? getProductBaseColors(product)
              : []

          const matchColor =
            !selectedColors.length ||
            selectedColors.some((color) =>
              productBaseColors.includes(color)
            )

          const matchSearch =
            product.nombre
              .toLowerCase()
              .includes(
                search.toLowerCase()
              )

          return (
            matchCategory &&
            matchOffers &&
            matchBestSellers &&
            matchPrice &&
            matchColor &&
            matchSearch
          )
        })
        .sort((a, b) => {
          if (
            sortBy ===
            "price-asc"
          ) {
            return (
              a.precio -
              b.precio
            )
          }

          if (
            sortBy ===
            "price-desc"
          ) {
            return (
              b.precio -
              a.precio
            )
          }

          return 0
        })
    }, [
      products,
      selectedCategories,
      onlyOffers,
      onlyBestSellers,
      minPrice,
      maxPrice,
      selectedColors,
      search,
      sortBy,
    ])

  // ─────────────────────────────────────
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
      <Suspense fallback={null}>
        <SearchParamSync onChange={setSearch} />
      </Suspense>
      <div className="pointer-events-none absolute inset-0 z-0 h-full w-full beyonix-store-page-bg" />

      <div className="category-hero container relative z-20 mx-auto px-4 pb-8 pt-28 lg:px-8 lg:pb-10 lg:pt-32">
        {/*
          Banner general (arte 8000x2167 ≈ 3.69:1, con el texto a la
          izquierda y espacio abajo para el buscador):
          - desktop: la caja tiene la proporción del arte y la imagen la
            cubre (object-cover); buscador y beneficios van encima, como
            siempre, por debajo del 55% del alto (la franja libre del arte):
            el alto mínimo lo garantiza y, si actúa, el recorte es desde la
            derecha (object-left). Nunca bandas laterales.
          - mobile/tablet: el arte va en su propio bloque (12:5 / 3:1), con
            un recorte moderado desde la izquierda (donde está el texto), y
            buscador + beneficios debajo, legibles.
          Sin banners cargados no se reserva un recuadro vacío.
        */}
        <div className={`beyonix-hero-banner relative mx-auto flex w-full max-w-[var(--beyonix-content-max)] flex-col justify-end overflow-hidden rounded-xl border border-beyonix-blue-light/30 bg-[#03070D] text-center shadow-[0_0_42px_rgba(30,140,255,0.1),0_26px_70px_rgba(0,0,0,0.42)] ${productsBanners.length ? "lg:aspect-[1920/520] lg:min-h-[24rem]" : "pt-8 sm:pt-10 lg:pt-12"}`}>
          {productsBanners.length ? (
            <div data-banner-media className="relative aspect-[12/5] w-full shrink-0 sm:aspect-[3/1] lg:absolute lg:inset-0 lg:aspect-auto">
              {productsBanners.map((banner, index) =>
                banner.image_url ? (
                  <img
                    key={banner.id}
                    src={banner.image_url}
                    alt={banner.alt_text || "Banner de productos BEYONIX"}
                    className={`absolute inset-0 z-0 size-full object-cover object-left transition-opacity duration-700 ease-out ${
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
            </div>
          ) : null}

          <div className={`relative z-10 mx-auto flex w-full max-w-5xl flex-col items-center px-4 pb-8 sm:pb-10 ${productsBanners.length ? "pt-5 sm:pt-6 lg:pb-5 lg:pt-0" : "lg:pb-12"}`}>
            <div className="global-search-wrapper flex w-full justify-center">
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
            </div>

            <StoreBenefits />
          </div>
        </div>
      </div>

      <section className="container relative z-20 mx-auto px-4 lg:px-8">
        <div className="beyonix-products-shell mx-auto grid max-w-[var(--beyonix-content-max)] grid-cols-1 gap-[clamp(1rem,1.4vw,1.5rem)] p-3 pb-10 sm:p-4 lg:grid-cols-products-layout lg:p-5 lg:pb-12">
          <div className="w-full lg:w-260px">
            <ProductsFiltersSidebar
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
