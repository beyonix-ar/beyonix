"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { SupabaseProducto } from "@/lib/supabase/types"
import { getProductPriceRange } from "@/lib/products/price-range"
import { filterCatalogProducts, getAvailableCatalogColors, type CatalogFilterValues } from "@/lib/products/catalog-filters"

function readFilters(query: URLSearchParams, defaults: CatalogFilterValues): CatalogFilterValues {
  const numberOr = (key: string, fallback: number) => {
    const value = Number(query.get(key))
    return query.has(key) && Number.isFinite(value) && value >= 0 ? value : fallback
  }
  const sort = query.get("sort")
  return {
    search: query.get("search") ?? "",
    sortBy: sort === "price-asc" || sort === "price-desc" ? sort : "relevance",
    selectedCategories: query.has("category") ? query.getAll("category").filter(Boolean) : defaults.selectedCategories,
    selectedColors: query.getAll("color").filter(Boolean),
    onlyOffers: query.get("offer") === "1",
    onlyBestSellers: query.get("featured") === "1",
    minPrice: numberOr("minPrice", defaults.minPrice),
    maxPrice: numberOr("maxPrice", defaults.maxPrice),
  }
}

export function useCatalogFilters(products: SupabaseProducto[], initialCategory?: string, initialSearch = "") {
  const priceRange = useMemo(() => getProductPriceRange(products), [products])
  const defaults: CatalogFilterValues = useMemo(() => ({
    search: initialSearch,
    sortBy: "relevance",
    selectedCategories: initialCategory ? [initialCategory] : [],
    selectedColors: [],
    onlyOffers: false,
    onlyBestSellers: false,
    minPrice: priceRange.min,
    maxPrice: priceRange.max,
  }), [initialCategory, initialSearch, priceRange.min, priceRange.max])
  const [values, setValues] = useState<CatalogFilterValues>(defaults)
  const [ready, setReady] = useState(false)
  const historyMode = useRef<"push" | "replace">("push")
  const pendingWrite = useRef(false)
  const previousRange = useRef(priceRange)

  useEffect(() => {
    const restore = () => setValues(readFilters(new URLSearchParams(window.location.search), defaults))
    restore()
    setReady(true)
    window.addEventListener("popstate", restore)
    return () => window.removeEventListener("popstate", restore)
    // The route's initial defaults are read once; range updates are handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const old = previousRange.current
    previousRange.current = priceRange
    if (old.min === priceRange.min && old.max === priceRange.max) return
    setValues((current) => ({
      ...current,
      minPrice: current.minPrice === old.min && !new URLSearchParams(window.location.search).has("minPrice") ? priceRange.min : current.minPrice,
      maxPrice: current.maxPrice === old.max && !new URLSearchParams(window.location.search).has("maxPrice") ? priceRange.max : current.maxPrice,
    }))
  }, [priceRange])

  useEffect(() => {
    if (!ready || !pendingWrite.current) return
    const url = new URL(window.location.href)
    if (url.protocol !== "http:" && url.protocol !== "https:") return
    const query = url.searchParams
    for (const key of ["search", "sort", "category", "color", "offer", "featured", "minPrice", "maxPrice"]) query.delete(key)
    if (values.search) query.set("search", values.search)
    if (values.sortBy !== "relevance") query.set("sort", values.sortBy)
    if (values.selectedCategories.length && !(initialCategory && values.selectedCategories.length === 1 && values.selectedCategories[0] === initialCategory)) values.selectedCategories.forEach((slug) => query.append("category", slug))
    else if (initialCategory) query.set("category", "")
    values.selectedColors.forEach((color) => query.append("color", color))
    if (values.onlyOffers) query.set("offer", "1")
    if (values.onlyBestSellers) query.set("featured", "1")
    if (values.minPrice !== priceRange.min) query.set("minPrice", String(values.minPrice))
    if (values.maxPrice !== priceRange.max) query.set("maxPrice", String(values.maxPrice))
    const next = `${url.pathname}${url.search}${url.hash}`
    const current = `${window.location.pathname}${window.location.search}${window.location.hash}`
    if (next !== current) window.history[historyMode.current === "replace" ? "replaceState" : "pushState"](null, "", next)
    historyMode.current = "push"
    pendingWrite.current = false
  }, [values, ready, initialCategory, priceRange.min, priceRange.max])

  function set<K extends keyof CatalogFilterValues>(key: K, value: CatalogFilterValues[K], mode: "push" | "replace" = "push") {
    historyMode.current = mode
    pendingWrite.current = true
    setValues((current) => ({ ...current, [key]: value }))
  }
  const restoreSearch = useCallback((search: string) => {
    setValues((current) => current.search === search ? current : { ...current, search })
  }, [])

  const availableColors = useMemo(() => getAvailableCatalogColors(products), [products])
  const filteredProducts = useMemo(() => filterCatalogProducts(products, values), [products, values])
  return {
    ...values,
    priceRange,
    availableColors,
    filteredProducts,
    setSearch: (value: string) => set("search", value, "replace"),
    restoreSearch,
    setSortBy: (value: string) => set("sortBy", value),
    setSelectedCategories: (value: string[]) => set("selectedCategories", value),
    setSelectedColors: (value: string[]) => set("selectedColors", value),
    setOnlyOffers: (value: boolean) => set("onlyOffers", value),
    setOnlyBestSellers: (value: boolean) => set("onlyBestSellers", value),
    setMinPrice: (value: number) => set("minPrice", value, "replace"),
    setMaxPrice: (value: number) => set("maxPrice", value, "replace"),
    clearAll: () => {
      pendingWrite.current = true
      setValues({ ...defaults, selectedCategories: [], minPrice: priceRange.min, maxPrice: priceRange.max })
    },
  }
}
