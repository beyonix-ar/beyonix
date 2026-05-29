"use client"

import { useCallback, useEffect, useState } from "react"

import { getClientes } from "@/lib/supabase/queries/clientes"
import type { SupabaseCliente } from "@/lib/supabase/types"

export function useClientes() {
  const [clientes, setClientes] = useState<SupabaseCliente[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadClientes = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      setClientes(await getClientes())
    } catch (err) {
      console.error(err)
      setError("No se pudieron cargar los clientes.")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadClientes()
  }, [loadClientes])

  return {
    clientes,
    loading,
    error,
    reloadClientes: loadClientes,
  }
}
