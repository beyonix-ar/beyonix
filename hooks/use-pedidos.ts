"use client"

import {
  useEffect,
  useState,
  useCallback,
} from "react"

import type {
  SupabasePedido,
} from "@/lib/supabase/types"

import {
  getPedidos,
  deletePedido,
  updatePedidoEstado,
} from "@/lib/supabase/queries/pedidos"

// ─────────────────────────────────────────────────────────────────────────────
// Hook
// ─────────────────────────────────────────────────────────────────────────────

export function usePedidos() {
  const [pedidos, setPedidos] =
    useState<SupabasePedido[]>([])

  const [loading, setLoading] =
    useState(true)

  const [error, setError] =
    useState<string | null>(null)

  // ───────────────────────────────────────────────────────────────────────────
  // Load pedidos
  // ───────────────────────────────────────────────────────────────────────────

  const loadPedidos =
    useCallback(async () => {
      try {
        setLoading(true)

        const data =
          await getPedidos()

        setPedidos(data)

        setError(null)
      } catch (err) {
        console.error(err)

        setError(
          "Error cargando pedidos."
        )
      } finally {
        setLoading(false)
      }
    }, [])

  // ───────────────────────────────────────────────────────────────────────────
  // First load
  // ───────────────────────────────────────────────────────────────────────────

  useEffect(() => {
    loadPedidos()
  }, [loadPedidos])

  // ───────────────────────────────────────────────────────────────────────────
  // Delete
  // ───────────────────────────────────────────────────────────────────────────

  const removePedido =
    useCallback(
      async (id: number) => {
        try {
          await deletePedido(id)

          setPedidos((prev) =>
            prev.filter(
              (p) => p.id !== id
            )
          )

          return true
        } catch (err) {
          console.warn("DELETE_PEDIDO_ERROR", err)

          return false
        }
      },
      []
    )

  // ───────────────────────────────────────────────────────────────────────────
  // Update estado
  // ───────────────────────────────────────────────────────────────────────────

  const updateEstado =
    useCallback(
      async (
        id: number,
        estado: string,
        tracking?: {
          tracking_number?: string | null
          tracking_url?: string | null
        }
      ) => {
        try {
          const updated =
            await updatePedidoEstado(
              id,
              estado,
              tracking
            )

          setPedidos((prev) =>
            prev.map((p) =>
              p.id === updated.id
                ? updated
                : p
            )
          )

          return true
        } catch (err) {
          console.warn("UPDATE_PEDIDO_ESTADO_ERROR", err)

          return false
        }
      },
      []
    )

  // ───────────────────────────────────────────────────────────────────────────
  // Return
  // ───────────────────────────────────────────────────────────────────────────

  return {
    pedidos,
    loading,
    error,

    reloadPedidos:
      loadPedidos,

    deletePedido:
      removePedido,

    updatePedidoEstado:
      updateEstado,
  }
}
