"use client"

import { useMemo, useState } from "react"
import { SITE_SETTINGS } from "@/config/site-settings"
import {
  getProductPriceRange,
} from "@/lib/products/price-range"
import type { SupabaseProducto } from "@/lib/supabase/types"

export function useCategoryProducts(products: SupabaseProducto[]) {
  const priceRange = useMemo(
    () =>
      getProductPriceRange(
        products
      ),
    [products]
  )
  const [search, setSearch] = useState("")
  const [sortBy, setSortBy] = useState("default")
  const [onlyOffers, setOnlyOffers] = useState(false)
  const [onlyBestSellers, setOnlyBestSellers] = useState(false)
  const [onlyInstallments, setOnlyInstallments] = useState(false)
  const [minPrice, setMinPrice] = useState(
    priceRange.min
  )
  const [maxPrice, setMaxPrice] = useState(
    priceRange.max
  )

  const filteredProducts = useMemo(() => {
    const normalizedSearch = search.toLowerCase().trim()

    const filtered = products.filter((product) => {
      const matchSearch =
        product.nombre
          .toLowerCase()
          .includes(normalizedSearch)

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
        (product.precio >= minPrice &&
          product.precio <= maxPrice)

      return (
        matchSearch &&
        matchOffers &&
        matchBestSellers &&
        matchInstallments &&
        matchPrice
      )
    })

    if (sortBy === "featured") {
      return [...filtered].sort((a, b) => b.id - a.id)
    }

    if (sortBy === "price-asc") {
      return [...filtered].sort((a, b) => a.precio - b.precio)
    }

    if (sortBy === "price-desc") {
      return [...filtered].sort((a, b) => b.precio - a.precio)
    }

    return filtered
  }, [
    products,
    search,
    sortBy,
    onlyOffers,
    onlyBestSellers,
    onlyInstallments,
    minPrice,
    maxPrice,
  ])

  return {
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
  }
}
