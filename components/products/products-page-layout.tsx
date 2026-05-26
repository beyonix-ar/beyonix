"use client"

import { useEffect, useMemo, useState } from "react"
import { useSearchParams } from "next/navigation"

import { useCart } from "@/context/cart-context"

import type { SupabaseProducto } from "@/lib/supabase/types"

import { getProductos } from "@/lib/supabase/queries/productos"

import { useProductDetails } from "@/components/category/use-product-details"

import { GlobalSearchBar } from "@/components/global-search-bar"
import { ProductDetailsModal } from "@/components/products/product-details-modal"

import { ProductsFiltersSidebar } from "./products-filters-sidebar"
import { ProductsGrid } from "./products-grid"
import { ProductsToolbar } from "./products-toolbar"

export function ProductsPageLayout() {
  const searchParams = useSearchParams()

  const [products, setProducts] = useState<
    SupabaseProducto[]
  >([])

  const [search, setSearch] = useState("")
  const [sortBy, setSortBy] =
    useState("relevance")

  const [selectedCategories, setSelectedCategories] =
    useState<string[]>([])

  const [onlyOffers, setOnlyOffers] =
    useState(false)

  const [onlyBestSellers, setOnlyBestSellers] =
    useState(false)

  const [minPrice, setMinPrice] =
    useState(1000)

  const [maxPrice, setMaxPrice] =
    useState(150000)

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

  const {
    addToCart,
    removeFromCart,
    decreaseQuantity,
    getQuantity,
    isInCart,
    openCart,
  } = useCart()

  useEffect(() => {
    setSearch(
      searchParams.get("search") || ""
    )
  }, [searchParams])

  useEffect(() => {
    const loadProducts = async () => {
      setProducts(await getProductos())
    }

    loadProducts()
  }, [])

  const filteredProducts = useMemo(() => {
    return products
      .filter((product) => {
        return (
          (!selectedCategories.length ||
            selectedCategories.includes(
              product.categorias?.slug || ""
            )) &&
          (!onlyOffers ||
            !!product.precio_anterior) &&
          (!onlyBestSellers ||
            product.destacado) &&
          product.precio >= minPrice &&
          product.precio <= maxPrice &&
          product.nombre
            .toLowerCase()
            .includes(
              search.toLowerCase()
            )
        )
      })
      .sort((a, b) => {
        if (sortBy === "price-asc") {
          return a.precio - b.precio
        }

        if (sortBy === "price-desc") {
          return b.precio - a.precio
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

  const availableColors = useMemo(() => {
    return ["default"]
  }, [])

  const handleAddToCart = (
    quantity: number = 1
  ) => {
    if (!product) return

    Array.from({
      length: quantity,
    }).forEach(() => {
      addToCart(
        product,
        selectedColor,
        images?.[0]
      )
    })
  }

  return (
    <main className="min-h-screen bg-black pt-20 text-white">
      <section className="container mx-auto px-4 lg:px-8">
        <div className="mb-10 mt-8 border-b border-white/[0.06] pb-8">
          <div className="flex flex-col gap-5 lg:grid lg:grid-cols-[auto_1fr] lg:items-end lg:gap-12">
            <div>
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.3em] text-[#4A90B8]">
                Productos
              </p>

              <h1 className="text-3xl font-bold tracking-tight lg:text-4xl">
                Todos los productos
              </h1>

              <p className="mt-1.5 text-sm tracking-wide text-white/50">
                Explorá el catálogo completo de
                BEYONIX.
              </p>
            </div>

            <GlobalSearchBar
              search={search}
              products={products.map(
                (product) => ({
                  id: String(product.id),
                  name: product.nombre,
                })
              )}
              onSearchChange={setSearch}
            />
          </div>
        </div>

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
            availableColors={
              availableColors
            }
            onlyOffers={onlyOffers}
            setOnlyOffers={
              setOnlyOffers
            }
            minPrice={minPrice}
            setMinPrice={setMinPrice}
            maxPrice={maxPrice}
            setMaxPrice={setMaxPrice}
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
              products={filteredProducts}
              selectedColors={[]}
              onOpenPreview={openDetails}
              onAddToCart={addToCart}
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
        onSelectImage={
          setSelectedImage
        }
        onColorChange={changeColor}
        onAddToCart={
          handleAddToCart
        }
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
    </main>
  )
}