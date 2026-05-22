"use client"

import {
  useEffect,
  useState,
  useCallback,
} from "react"

import type {
  SupabaseProducto,
} from "@/lib/supabase/types"

import {
  getProductos,
  deleteProducto,
  toggleProductoActivo,
} from "@/lib/supabase/queries/productos"

// ─────────────────────────────────────────────────────────────────────────────
// Hook
// ─────────────────────────────────────────────────────────────────────────────

export function useProductos() {
  const [productos, setProductos] =
    useState<SupabaseProducto[]>([])

  const [loading, setLoading] =
    useState(true)

  const [error, setError] =
    useState<string | null>(null)

  // ───────────────────────────────────────────────────────────────────────────
  // Load productos
  // ───────────────────────────────────────────────────────────────────────────

  const loadProductos =
    useCallback(async () => {
      try {
        setLoading(true)

        const data =
          await getProductos()

        setProductos(data)

        setError(null)
      } catch (err) {
        console.error(err)

        setError(
          "Error cargando productos."
        )
      } finally {
        setLoading(false)
      }
    }, [])

  // ───────────────────────────────────────────────────────────────────────────
  // First load
  // ───────────────────────────────────────────────────────────────────────────

  useEffect(() => {
    loadProductos()
  }, [loadProductos])

  // ───────────────────────────────────────────────────────────────────────────
  // Delete
  // ───────────────────────────────────────────────────────────────────────────

  const removeProducto =
    useCallback(
      async (id: number) => {
        try {
          await deleteProducto(id)

          setProductos((prev) =>
            prev.filter(
              (p) => p.id !== id
            )
          )

          return true
        } catch (err) {
          console.error(err)

          return false
        }
      },
      []
    )

  // ───────────────────────────────────────────────────────────────────────────
  // Toggle activo
  // ───────────────────────────────────────────────────────────────────────────

  const toggleActivo =
    useCallback(
      async (
        producto: SupabaseProducto
      ) => {
        try {
          const updated =
            await toggleProductoActivo(
              producto
            )

          setProductos((prev) =>
            prev.map((p) =>
              p.id === updated.id
                ? updated
                : p
            )
          )

          return true
        } catch (err) {
          console.error(err)

          return false
        }
      },
      []
    )

  // ───────────────────────────────────────────────────────────────────────────
  // Return
  // ───────────────────────────────────────────────────────────────────────────

  return {
    productos,
    loading,
    error,

    reloadProductos:
      loadProductos,

    deleteProducto:
      removeProducto,

    toggleProductoActivo:
      toggleActivo,
  }
}