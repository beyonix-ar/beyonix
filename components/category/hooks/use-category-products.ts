"use client"

import { useMemo, useState } from "react"
import type { SupabaseProducto } from "@/lib/supabase/types"

export function useCategoryProducts(products: SupabaseProducto[]) {
  const [search, setSearch] = useState("")
  const [sortBy, setSortBy] = useState("default")

  const filteredProducts = useMemo(() => {
    const normalizedSearch = search.toLowerCase().trim()

    const filtered = products.filter((product) =>
      product.nombre
        .toLowerCase()
        .includes(normalizedSearch)
    )

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
  }, [products, search, sortBy])

  return {
    search,
    setSearch,
    sortBy,
    setSortBy,
    filteredProducts,
  }
}
