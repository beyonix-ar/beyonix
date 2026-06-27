"use client"

import {
  useEffect,
  useState,
  useCallback,
} from "react"

import type {
  SupabaseProducto,
  SupabaseCategoria,
} from "@/lib/supabase/types"

import {
  getStoreProductos,
  getFeaturedProductos,
  getStoreCategorias,
  searchProductos,
} from "@/lib/supabase/queries/store"

// ─────────────────────────────────────────────────────────────────────────────
// Hook
// ─────────────────────────────────────────────────────────────────────────────

export function useStore() {
  const [productos, setProductos] =
    useState<SupabaseProducto[]>([])

  const [destacados, setDestacados] =
    useState<SupabaseProducto[]>([])

  const [categorias, setCategorias] =
    useState<SupabaseCategoria[]>([])

  const [loading, setLoading] =
    useState(true)

  const [error, setError] =
    useState<string | null>(null)

  // ───────────────────────────────────────────────────────────────────────────
  // Load store
  // ───────────────────────────────────────────────────────────────────────────

  const loadStore =
    useCallback(async () => {
      try {
        setLoading(true)

        const [
          productosData,
          destacadosData,
          categoriasData,
        ] = await Promise.all([
          getStoreProductos(),
          getFeaturedProductos(),
          getStoreCategorias(),
        ])

        setProductos(productosData)

        setDestacados(destacadosData)

        setCategorias(categoriasData)

        setError(null)
      } catch (err) {
        console.error(err)

        setError(
          "Error cargando tienda."
        )
      } finally {
        setLoading(false)
      }
    }, [])

  // ───────────────────────────────────────────────────────────────────────────
  // First load
  // ───────────────────────────────────────────────────────────────────────────

  useEffect(() => {
    loadStore()
  }, [loadStore])

  // ───────────────────────────────────────────────────────────────────────────
  // Search
  // ───────────────────────────────────────────────────────────────────────────

  const search =
    useCallback(
      async (query: string) => {
        try {
          if (!query.trim()) {
            await loadStore()
            return
          }

          setLoading(true)

          const data =
            await searchProductos(
              query
            )

          setProductos(data)
        } catch (err) {
          console.error(err)
        } finally {
          setLoading(false)
        }
      },
      [loadStore]
    )

  // ───────────────────────────────────────────────────────────────────────────
  // Return
  // ───────────────────────────────────────────────────────────────────────────

  return {
    productos,
    destacados,
    categorias,

    loading,
    error,

    reloadStore:
      loadStore,

    searchProductos:
      search,
  }
}