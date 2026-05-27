"use client"

import {
  useEffect,
  useMemo,
  useState,
} from "react"

import { useSearchParams } from "next/navigation"

import type {
  SupabaseProducto,
} from "@/lib/supabase/types"

import { getProductos } from "@/lib/supabase/queries/productos"

import { useCart } from "@/context/cart-context"

import { useProductDetails } from "@/components/category/use-product-details"

import { GlobalSearchBar } from "@/components/global-search-bar"

import { ProductDetailsModal } from "@/components/products/product-details-modal"

import { ProductsFiltersSidebar } from "./products-filters-sidebar"

import { ProductsGrid } from "./products-grid"

import { ProductsToolbar } from "./products-toolbar"

export function ProductsPageLayout() {
  const searchParams =
    useSearchParams()

  const [products, setProducts] =
    useState<
      SupabaseProducto[]
    >([])

  const [search, setSearch] =
    useState("")

  const [sortBy, setSortBy] =
    useState("relevance")

  const [
    selectedCategories,
    setSelectedCategories,
  ] = useState<string[]>([])

  const [onlyOffers, setOnlyOffers] =
    useState(false)

  const [
    onlyBestSellers,
    setOnlyBestSellers,
  ] = useState(false)

  const [minPrice, setMinPrice] =
    useState(1000)

  const [maxPrice, setMaxPrice] =
    useState(150000)

  const {
    cart,
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
        const data =
          await getProductos()

        setProducts(data)
      } catch (error) {
        console.error(error)
      }
    }

    loadProducts()
  }, [searchParams])

  // ─────────────────────────────────────
  // Sync localStorage cart
  // ─────────────────────────────────────

  useEffect(() => {
    localStorage.setItem(
      "beyonix-cart",
      JSON.stringify(cart)
    )
  }, [cart])

  // ─────────────────────────────────────
  // Filters
  // ─────────────────────────────────────

  const filteredProducts =
    useMemo(() => {
      return products
        .filter((product) => {
          const matchCategory =
            !selectedCategories.length ||
            selectedCategories.includes(
              product.categorias
                ?.slug || ""
            )

          const matchOffers =
            !onlyOffers ||
            !!product.precio_anterior

          const matchBestSellers =
            !onlyBestSellers ||
            product.destacado

          const matchPrice =
            product.precio >=
              minPrice &&
            product.precio <=
              maxPrice

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
      search,
      sortBy,
    ])

  // ─────────────────────────────────────
  // Cart helpers
  // ─────────────────────────────────────

  const handleAddToCart = (
    product: SupabaseProducto
  ) => {
    addToCart(
      product,
      "default",
      product.imagen_principal ||
        product
          .imagenes_producto?.[0]
          ?.url ||
        "/placeholder.png"
    )
  }

  const modalProductQuantity =
    product
      ? getQuantity(
          product.id,
          "default"
        )
      : 0

  const modalProductInCart =
    product
      ? isInCart(
          product.id,
          "default"
        )
      : false

  // ─────────────────────────────────────
  // Render
  // ─────────────────────────────────────

  return (
    <main className="min-h-screen bg-black pt-24 text-white">
      <section className="container mx-auto px-4 lg:px-8">
        {/* Header */}
        <div className="mb-10 border-b border-white/6 pb-8">
          <div className="flex flex-col gap-6 lg:grid lg:grid-cols-[auto_1fr] lg:items-end lg:gap-12">
            <div>
              <p className="mb-2 text-11px font-semibold uppercase tracking-[0.3em] text-[#4A90B8]">
                Productos
              </p>

              <h1 className="text-3xl font-bold tracking-tight lg:text-4xl">
                Todos los productos
              </h1>

              <p className="mt-2 text-sm tracking-wide text-white/50">
                Explorá el catálogo completo de
                BEYONIX.
              </p>
            </div>

            <GlobalSearchBar
              search={search}
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
        <div className="grid grid-cols-1 gap-8 pb-16 lg:grid-cols-[260px_1fr]">
          <ProductsFiltersSidebar
            selectedCategories={
              selectedCategories
            }
            setSelectedCategories={
              setSelectedCategories
            }
            selectedColors={[]}
            setSelectedColors={() => {}}
            availableColors={[]}
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
            onlyNew={false}
            setOnlyNew={() => {}}
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
                filteredProducts as never
              }
              selectedColors={[]}
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
            product
          )
        }}
        onDecreaseCart={() => {
          if (!product) {
            return
          }

          decreaseQuantity(
            product.id,
            "default"
          )
        }}
        onRemoveFromCart={() => {
          if (!product) {
            return
          }

          removeFromCart(
            product.id,
            "default"
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