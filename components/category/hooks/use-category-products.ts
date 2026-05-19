"use client"

import { useMemo, useState } from "react"
import { ProductItem } from "../../products/product-details"

export function useCategoryProducts(products: ProductItem[]) {
  const [search, setSearch] = useState("")
  const [sortBy, setSortBy] = useState("default")

  const filteredProducts = useMemo(() => {
    const normalizedSearch = search.toLowerCase().trim()

    const filtered = products.filter((product) =>
      product.name
        .toLowerCase()
        .includes(normalizedSearch)
    )

    if (sortBy === "featured") {
      return [...filtered].sort((a, b) => b.id - a.id)
    }

    if (sortBy === "price-asc") {
      return [...filtered].sort((a, b) => a.price - b.price)
    }

    if (sortBy === "price-desc") {
      return [...filtered].sort((a, b) => b.price - a.price)
    }

    return filtered
  }, [products, search, sortBy])

  return {
    search,
    setSearch,
    sortBy,
    setSortBy,
    filteredProducts,
  }
}