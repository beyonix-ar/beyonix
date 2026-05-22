"use client"

import {
  useEffect,
  useState,
  useCallback,
} from "react"

import type {
  SupabaseCategoria,
} from "@/lib/supabase/types"

import {
  getCategorias,
  deleteCategoria,
} from "@/lib/supabase/queries/categorias"

// ─────────────────────────────────────────────────────────────────────────────
// Hook
// ─────────────────────────────────────────────────────────────────────────────

export function useCategorias() {
  const [categorias, setCategorias] =
    useState<SupabaseCategoria[]>([])

  const [loading, setLoading] =
    useState(true)

  const [error, setError] =
    useState<string | null>(null)

  // ───────────────────────────────────────────────────────────────────────────
  // Load
  // ───────────────────────────────────────────────────────────────────────────

  const loadCategorias =
    useCallback(async () => {
      try {
        setLoading(true)

        const data =
          await getCategorias()

        setCategorias(data)

        setError(null)
      } catch (err) {
        console.error(err)

        setError(
          "Error cargando categorías."
        )
      } finally {
        setLoading(false)
      }
    }, [])

  // ───────────────────────────────────────────────────────────────────────────
  // First load
  // ───────────────────────────────────────────────────────────────────────────

  useEffect(() => {
    loadCategorias()
  }, [loadCategorias])

  // ───────────────────────────────────────────────────────────────────────────
  // Delete
  // ───────────────────────────────────────────────────────────────────────────

  const removeCategoria =
    useCallback(
      async (id: number) => {
        try {
          await deleteCategoria(id)

          setCategorias((prev) =>
            prev.filter(
              (c) => c.id !== id
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
    categorias,
    loading,
    error,

    reloadCategorias:
      loadCategorias,

    deleteCategoria:
      removeCategoria,
  }
}