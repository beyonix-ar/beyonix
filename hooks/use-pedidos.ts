"use client"

import {
  useEffect,
  useState,
  useCallback,
  useRef,
} from "react"

import type {
  SupabasePedido,
} from "@/lib/supabase/types"

import {
  getPedidos,
  deletePedido,
  updatePedidoEstado,
  type UpdatePedidoStatusDetails,
} from "@/lib/supabase/queries/pedidos"
import { supabase } from "@/lib/supabase/client"
import { notifyAdminNotificationsChanged } from "@/lib/admin/admin-notifications"

const REALTIME_PEDIDOS_TABLES = [
  "ordenes",
  "orden_items",
  "admin_events",
  "order_claims",
  "order_claim_messages",
  "order_claim_files",
  "order_refund_proofs",
  "order_audit_events",
] as const

function dedupePedidos(pedidos: SupabasePedido[]) {
  const byId = new Map<number, SupabasePedido>()
  for (const pedido of pedidos) byId.set(pedido.id, pedido)
  return [...byId.values()]
}

// ─────────────────────────────────────────────────────────────────────────────
// Hook
// ─────────────────────────────────────────────────────────────────────────────

export function usePedidos() {
  const requestIdRef = useRef(0)
  const channelNameRef = useRef(
    `admin-pedidos-live-${Math.random().toString(36).slice(2)}`,
  )
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
    useCallback(async ({ silent = false }: { silent?: boolean } = {}) => {
      const requestId = ++requestIdRef.current
      try {
        if (!silent) setLoading(true)

        const data =
          await getPedidos()

        if (requestId !== requestIdRef.current) return

        setPedidos(dedupePedidos(data))

        setError(null)
      } catch (err) {
        if (requestId !== requestIdRef.current) return

        console.error(err)

        setError(
          "Error cargando pedidos."
        )
      } finally {
        if (requestId === requestIdRef.current) setLoading(false)
      }
    }, [])

  // ───────────────────────────────────────────────────────────────────────────
  // First load
  // ───────────────────────────────────────────────────────────────────────────

  useEffect(() => {
    void loadPedidos()
  }, [loadPedidos])

  useEffect(() => {
    let reloadTimer: ReturnType<typeof setTimeout> | null = null
    const scheduleReload = () => {
      if (reloadTimer) clearTimeout(reloadTimer)
      reloadTimer = setTimeout(() => {
        reloadTimer = null
        void loadPedidos({ silent: true })
        notifyAdminNotificationsChanged()
      }, 180)
    }

    let channel = supabase.channel(channelNameRef.current)
    for (const table of REALTIME_PEDIDOS_TABLES) {
      channel = channel.on(
        "postgres_changes",
        { event: "*", schema: "public", table },
        scheduleReload,
      )
    }
    channel.subscribe()

    return () => {
      if (reloadTimer) clearTimeout(reloadTimer)
      void supabase.removeChannel(channel)
    }
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
        details?: UpdatePedidoStatusDetails
      ) => {
        try {
          const updated =
            await updatePedidoEstado(
              id,
              estado,
              details
            )

          setPedidos((prev) =>
            prev.map((p) =>
              p.id === updated.id
                ? {
                    ...p,
                    ...updated,
                    orden_items: p.orden_items,
                    order_claims: p.order_claims,
                  }
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
