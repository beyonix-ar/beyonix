"use client"

import {
  useEffect,
  useMemo,
  useState,
} from "react"

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
import { SITE_SETTINGS } from "@/config/site-settings"

const baseColorOrder = [
  "negro",
  "blanco",
  "gris",
  "azul",
  "rojo",
  "amarillo",
  "verde",
  "rosa",
  "violeta",
  "beige",
]

const baseColorKeywords: Record<string, string[]> = {
  negro: ["negro", "black"],
  blanco: ["blanco", "white"],
  gris: ["gris", "plata", "silver", "titanio", "grafito"],
  azul: ["azul", "celeste", "turquesa", "cyan", "sky", "lavanda"],
  rojo: ["rojo", "bordo", "coral"],
  amarillo: ["amarillo", "mostaza", "dorado"],
  verde: ["verde", "oliva", "menta", "mint", "sage", "lima", "lime", "aqua"],
  rosa: ["rosa", "fucsia", "salmon", "durazno", "terracota"],
  violeta: ["violeta", "morado", "lila", "purple"],
  beige: ["beige", "crema", "arena"],
}

function normalizeColorText(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
}

function getProductBaseColors(product: SupabaseProducto) {
  const colors = new Set<string>()

  getProductVariantOptions(product).forEach((variant) => {
    const text = normalizeColorText(`${variant.name} ${product.nombre}`)

    baseColorOrder.forEach((baseColor) => {
      if (
        baseColorKeywords[baseColor].some((keyword) =>
          text.includes(keyword)
        )
      ) {
        colors.add(baseColor)
      }
    })
  })

  return [...colors]
}

export function ProductsPageLayout() {
  const searchParams =
    useSearchParams()

  const [products, setProducts] =
    useState<
      SupabaseProducto[]
    >([])

  const [categories, setCategories] =
    useState<SupabaseCategoria[]>([])

  const [search, setSearch] =
    useState("")

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

  const [
    onlyInstallments,
    setOnlyInstallments,
  ] = useState(false)

  const [minPrice, setMinPrice] =
    useState(1000)

  const [maxPrice, setMaxPrice] =
    useState(150000)

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
    setSearch(
      searchParams.get("search") ||
        ""
    )

    async function loadProducts() {
      try {
        const [
          productsData,
          categoriesData,
        ] = await Promise.all([
          getStoreProductos(),
          getStoreCategorias(),
        ])

        setProducts(productsData)
        setCategories(categoriesData)
      } catch (error) {
        console.error(error)
      }
    }

    loadProducts()
  }, [searchParams])

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

      return baseColorOrder.filter((color) => colors.has(color))
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

          const matchInstallments =
            !SITE_SETTINGS.filters.showInstallmentsFilter ||
            !onlyInstallments ||
            product.cuotas_sin_interes === true

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
            matchInstallments &&
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
      onlyInstallments,
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

  // ─────────────────────────────────────
  // Render
  // ─────────────────────────────────────

  return (
    <main className="min-h-screen bg-black pt-22 text-white lg:pt-24">
      <section className="container mx-auto px-4 lg:px-8">
        {/* Header */}
        <div className="mb-8 border-b border-white/6 pb-7 lg:mb-9">
          <div className="flex flex-col gap-5 lg:grid lg:grid-cols-auto-content lg:items-end lg:gap-10">
            <div>
              <p className="mb-2 text-11px font-semibold uppercase tracking-widest text-beyonix-cyan">
                Productos
              </p>

              <h1 className="text-3xl font-bold tracking-tight lg:text-4xl">
                Todos los productos
              </h1>

              <p className="mt-2 text-sm tracking-wide text-white/60">
                Explorá el catálogo completo de
                BEYONIX.
              </p>
            </div>

            <GlobalSearchBar
              search={search}
              className="lg:ml-auto lg:max-w-55pct"
              onSearchChange={
                setSearch
              }
              products={products.map(
                (product) => ({
                  id: String(
                    product.id
                  ),

                  nombre:
                    product.nombre,

                  slug:
                    product.slug,
                })
              )}
            />
          </div>
        </div>

        {/* Content */}
        <div className="grid grid-cols-1 gap-5 pb-14 lg:grid-cols-products-layout lg:gap-7 lg:pb-16">
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
            onlyBestSellers={
              onlyBestSellers
            }
            setOnlyBestSellers={
              setOnlyBestSellers
            }
            onlyInstallments={
              onlyInstallments
            }
            setOnlyInstallments={
              setOnlyInstallments
            }
            showInstallmentsFilter={
              SITE_SETTINGS.filters
                .showInstallmentsFilter
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

          <div>
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
            images[selectedImage]
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
