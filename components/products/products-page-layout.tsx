"use client"

import { useMemo, useState, useEffect } from "react"
import { useSearchParams } from "next/navigation"
import { productsData } from "@/lib/products"
import { ProductsFiltersSidebar } from "./products-filters-sidebar"
import { ProductsToolbar } from "./products-toolbar"
import { ProductsGrid } from "./products-grid"
import { ProductDetailsModal } from "@/components/products/product-details-modal"
import { useProductDetails } from "@/components/category/use-product-details"
import { useCart } from "@/context/cart-context"
import { GlobalSearchBar } from "@/components/global-search-bar"

export function ProductsPageLayout() {
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

  const searchParams = useSearchParams()

  const [selectedCategories, setSelectedCategories] = useState<string[]>([])
  const [selectedColors, setSelectedColors] = useState<string[]>([])
  const [onlyOffers, setOnlyOffers] = useState(false)
  const [onlyBestSellers, setOnlyBestSellers] = useState(false)
  const [onlyNew, setOnlyNew] = useState(false)
  const [minPrice, setMinPrice] = useState(1000)
  const [maxPrice, setMaxPrice] = useState(150000)
  const [sortBy, setSortBy] = useState("relevance")
  const [search, setSearch] = useState("")

  useEffect(() => {
    const query = searchParams.get("search") || ""
    setSearch(query)
  }, [searchParams])

  const filteredProducts = useMemo(() => {
    let result = productsData.filter((product) => {
      const matchesCategory =
        selectedCategories.length === 0 ||
        selectedCategories.includes(product.categorySlug)

      const matchesOffer =
        !onlyOffers || Boolean(product.originalPrice)

      const matchesPrice =
        product.price >= minPrice &&
        product.price <= maxPrice

      const productColors = product.colors.map((c) =>
        c.name.trim().toLowerCase()
      )

      const matchesColor =
        selectedColors.length === 0 ||
        selectedColors.some((c) =>
          productColors.includes(c.trim().toLowerCase())
        )

      const matchesBestSeller =
        !onlyBestSellers || product.featured

      const matchesNew =
        !onlyNew || product.featured

      const matchesSearch =
        product.name.toLowerCase().includes(search.toLowerCase())

      return (
        matchesCategory &&
        matchesOffer &&
        matchesPrice &&
        matchesColor &&
        matchesBestSeller &&
        matchesNew &&
        matchesSearch
      )
    })

    if (sortBy === "price-asc") {
      result = [...result].sort((a, b) => a.price - b.price)
    }

    if (sortBy === "price-desc") {
      result = [...result].sort((a, b) => b.price - a.price)
    }

    return result
  }, [
    selectedCategories,
    selectedColors,
    onlyOffers,
    onlyBestSellers,
    onlyNew,
    minPrice,
    maxPrice,
    sortBy,
    search,
  ])

  const availableColors = useMemo(() => {
    const set = new Set<string>()
    productsData.forEach((p) =>
      p.colors.forEach((c) =>
        set.add(c.name.trim().toLowerCase())
      )
    )
    return Array.from(set)
  }, [])

  const handleAddToCart = (quantity: number = 1) => {
    if (!product) return
    const selectedVariant = product.colors.find(
      (c) => c.name === selectedColor
    )
    const image =
      selectedVariant?.images?.[0] ||
      product.colors?.[0]?.images?.[0] ||
      "/placeholder.png"

    for (let i = 0; i < quantity; i++) {
      addToCart(product, selectedColor, image)
    }
  }

  const handleDecreaseCart = () => {
    if (!product) return
    decreaseQuantity(product.id, selectedColor)
  }

  const handleRemoveFromCart = () => {
    if (!product) return
    removeFromCart(product.id, selectedColor)
  }

  const handleViewCart = () => {
    openCart()
  }

  return (
    <main className="min-h-screen bg-black text-white pt-20">
      {/* Header con línea separadora sutil */}
      <section className="container mx-auto px-4 lg:px-8">

        {/* Cabecera de página */}
        <div className="mt-8 mb-10 pb-8 border-b border-white/[0.06]">

          {/* Fila superior: título a la izquierda, buscador centrado en el espacio restante */}
          <div className="flex flex-col gap-5 lg:grid lg:grid-cols-[auto_1fr] lg:items-end lg:gap-12">

            <div className="shrink-0">
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.3em] text-[#4A90B8]">
                Productos
              </p>
              <h1 className="text-3xl font-bold tracking-tight lg:text-4xl text-white">
                Todos los productos
              </h1>
              <p className="mt-1.5 text-sm text-white/50 tracking-wide">
                Explorá el catálogo completo de BEYONIX.
              </p>
            </div>

            {/* El buscador ocupa el espacio restante de la fila */}
            <div className="w-full">
              <GlobalSearchBar
                search={search}
                onSearchChange={setSearch}
              />
            </div>

          </div>
        </div>

        {/* Grid principal */}
        <div className="grid grid-cols-1 gap-8 lg:grid-cols-[260px_1fr] pb-16">

          <ProductsFiltersSidebar
            selectedCategories={selectedCategories}
            setSelectedCategories={setSelectedCategories}
            selectedColors={selectedColors}
            setSelectedColors={setSelectedColors}
            availableColors={availableColors}
            onlyOffers={onlyOffers}
            setOnlyOffers={setOnlyOffers}
            minPrice={minPrice}
            setMinPrice={setMinPrice}
            maxPrice={maxPrice}
            setMaxPrice={setMaxPrice}
            onlyBestSellers={onlyBestSellers}
            setOnlyBestSellers={setOnlyBestSellers}
            onlyNew={onlyNew}
            setOnlyNew={setOnlyNew}
          />

          <div>
            <ProductsToolbar
              total={filteredProducts.length}
              sortBy={sortBy}
              setSortBy={setSortBy}
            />

            <ProductsGrid
              products={filteredProducts}
              selectedColors={selectedColors}
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
        onSelectImage={setSelectedImage}
        onColorChange={changeColor}
        onAddToCart={handleAddToCart}
        onDecreaseCart={handleDecreaseCart}
        onRemoveFromCart={handleRemoveFromCart}
        onViewCart={handleViewCart}
        isInCart={product ? isInCart(product.id, selectedColor) : false}
        cartQuantity={product ? getQuantity(product.id, selectedColor) : 0}
      />
    </main>
  )
}