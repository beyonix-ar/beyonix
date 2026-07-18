"use client"

import { useCallback, useEffect, useState } from "react"

import type {
  BlockedClientIdentifier,
  ClientRiskStatus,
} from "@/lib/clients/client-blocking"
import { normalizeBlockIdentifier } from "@/lib/clients/client-blocking"
import { supabase } from "@/lib/supabase/client"
import { getClientes } from "@/lib/supabase/queries/clientes"
import type { SupabaseCliente } from "@/lib/supabase/types"

export interface CustomerCreditTopupReview {
  id: string
  user_id: string
  amount?: number | string | null
  proof_file_name?: string | null
  proof_signed_url?: string | null
  status: "en_revision"
  admin_notes?: string | null
  created_at: string
  profile?: {
    id: string
    nombre?: string | null
    username?: string | null
    dni?: string | null
    email?: string | null
  } | null
}

async function getAuthHeaders() {
  const {
    data: { session },
  } = await supabase.auth.getSession()

  return session?.access_token
    ? {
        Authorization: `Bearer ${session.access_token}`,
      }
    : undefined
}

async function adminFetch(url: string, init?: RequestInit) {
  const headers = await getAuthHeaders()

  return fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...headers,
      ...init?.headers,
    },
  })
}

function blockMatchesClient(
  block: BlockedClientIdentifier,
  cliente: SupabaseCliente
) {
  if (block.source_profile_id === cliente.id) return true

  if (block.identifier_type === "email") {
    return (
      normalizeBlockIdentifier("email", cliente.email ?? "") ===
      block.identifier_value
    )
  }

  if (block.identifier_type === "username") {
    return (
      normalizeBlockIdentifier("username", cliente.username ?? "") ===
      block.identifier_value
    )
  }

  return (
    normalizeBlockIdentifier("phone", cliente.telefono ?? "") ===
    block.identifier_value
  )
}

function applyBlockedStateToClientes(
  clientes: SupabaseCliente[],
  blockedIdentifiers: BlockedClientIdentifier[]
) {
  return clientes.map((cliente) => {
    const clientBlocks = blockedIdentifiers.filter((block) =>
      blockMatchesClient(block, cliente)
    )
    const firstBlock = clientBlocks[0]

    if (!firstBlock) return cliente

    return {
      ...cliente,
      blocked_at: cliente.blocked_at ?? firstBlock.created_at,
      blocked_reason: cliente.blocked_reason ?? firstBlock.reason,
    }
  })
}

export function useClientes() {
  const [clientes, setClientes] = useState<SupabaseCliente[]>([])
  const [blockedIdentifiers, setBlockedIdentifiers] = useState<
    BlockedClientIdentifier[]
  >([])
  const [creditTopups, setCreditTopups] = useState<CustomerCreditTopupReview[]>([])
  const [topupSavingId, setTopupSavingId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadClientes = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      const [nextClientes, blocksResponse, creditResponse] = await Promise.all([
        getClientes(),
        adminFetch("/api/admin/clientes/bloqueos"),
        adminFetch("/api/admin/clientes/saldos"),
      ])

      let nextBlockedIdentifiers: BlockedClientIdentifier[] = []
      let creditBalances = new Map<string, number>()

      if (blocksResponse.ok) {
        const data = (await blocksResponse.json()) as {
          blockedIdentifiers?: BlockedClientIdentifier[]
        }
        nextBlockedIdentifiers = data.blockedIdentifiers ?? []
      }

      if (creditResponse.ok) {
        const data = (await creditResponse.json()) as {
          accounts?: Array<{ user_id: string; balance: number }>
          topups?: CustomerCreditTopupReview[]
        }
        creditBalances = new Map(
          (data.accounts ?? []).map((account) => [account.user_id, Number(account.balance ?? 0)]),
        )
        setCreditTopups(data.topups ?? [])
      } else {
        setCreditTopups([])
      }

      setBlockedIdentifiers(nextBlockedIdentifiers)
      setClientes(
        applyBlockedStateToClientes(
          nextClientes.map((cliente) => ({
            ...cliente,
            customer_credit_balance: creditBalances.get(cliente.id) ?? 0,
          })),
          nextBlockedIdentifiers,
        ),
      )
    } catch (err) {
      console.error(err)
      setError("No se pudieron cargar los clientes.")
    } finally {
      setLoading(false)
    }
  }, [])

  const updateClientAdminInfo = useCallback(
    async (
      clienteId: string,
      data: {
        client_risk_status?: ClientRiskStatus
        admin_note?: string | null
        blocked?: boolean
        blocked_reason?: string | null
      }
    ) => {
      setSaving(true)
      setError(null)

      try {
        const response = await adminFetch(`/api/admin/clientes/${clienteId}`, {
          method: "PATCH",
          body: JSON.stringify(data),
        })

        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as {
            error?: string
          } | null

          throw new Error(payload?.error ?? "No se pudo actualizar el cliente.")
        }

        await loadClientes()
      } catch (err) {
        console.error(err)
        setError(
          err instanceof Error ? err.message : "No se pudo actualizar el cliente."
        )
      } finally {
        setSaving(false)
      }
    },
    [loadClientes]
  )

  const createBlockedIdentifier = useCallback(
    async (data: {
      lookup_value: string
      reason?: string | null
    }) => {
      setSaving(true)
      setError(null)

      try {
        const response = await adminFetch("/api/admin/clientes/bloqueos", {
          method: "POST",
          body: JSON.stringify(data),
        })

        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as {
            error?: string
          } | null

          throw new Error(payload?.error ?? "No se pudo crear el bloqueo.")
        }

        await loadClientes()
      } catch (err) {
        console.error(err)
        setError(err instanceof Error ? err.message : "No se pudo crear el bloqueo.")
      } finally {
        setSaving(false)
      }
    },
    [loadClientes]
  )

  const removeBlockedIdentifier = useCallback(
    async (id: number, sourceProfileId?: string | null, ids?: number[]) => {
      setSaving(true)
      setError(null)

      try {
        const params = new URLSearchParams()

        if (ids?.length) {
          params.set("ids", ids.join(","))
        }

        if (sourceProfileId) {
          params.set("source_profile_id", sourceProfileId)
        } else if (!ids?.length) {
          params.set("id", String(id))
        }

        const response = await adminFetch(
          `/api/admin/clientes/bloqueos?${params.toString()}`,
          {
            method: "DELETE",
          }
        )

        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as {
            error?: string
          } | null

          throw new Error(payload?.error ?? "No se pudo quitar el bloqueo.")
        }

        await loadClientes()
      } catch (err) {
        console.error(err)
        setError(err instanceof Error ? err.message : "No se pudo quitar el bloqueo.")
      } finally {
        setSaving(false)
      }
    },
    [loadClientes]
  )

  const resolveCreditTopup = useCallback(
    async (data: {
      topupId: string
      action: "approve" | "reject"
      amount?: string
      notes?: string
    }) => {
      setTopupSavingId(data.topupId)
      setError(null)

      try {
        const response = await adminFetch("/api/admin/clientes/saldos", {
          method: "PATCH",
          body: JSON.stringify(data),
        })
        const payload = (await response.json().catch(() => null)) as {
          error?: string
        } | null

        if (!response.ok) {
          throw new Error(payload?.error ?? "No se pudo resolver el comprobante.")
        }

        await loadClientes()
      } catch (err) {
        console.error(err)
        setError(
          err instanceof Error ? err.message : "No se pudo resolver el comprobante.",
        )
        throw err
      } finally {
        setTopupSavingId(null)
      }
    },
    [loadClientes],
  )
  useEffect(() => {
    void loadClientes()
  }, [loadClientes])

  useEffect(() => {
    let reloadTimer: ReturnType<typeof setTimeout> | null = null
    const scheduleReload = () => {
      if (reloadTimer) clearTimeout(reloadTimer)
      reloadTimer = setTimeout(() => {
        reloadTimer = null
        void loadClientes()
      }, 200)
    }
    const channel = supabase
      .channel("admin-client-credit-updates")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "customer_credit_topups" },
        scheduleReload,
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "customer_credit_movements" },
        scheduleReload,
      )
      .subscribe()

    return () => {
      if (reloadTimer) clearTimeout(reloadTimer)
      void supabase.removeChannel(channel)
    }
  }, [loadClientes])

  return {
    clientes,
    blockedIdentifiers,
    creditTopups,
    topupSavingId,
    loading,
    saving,
    error,
    reloadClientes: loadClientes,
    updateClientAdminInfo,
    createBlockedIdentifier,
    removeBlockedIdentifier,
    resolveCreditTopup,
  }
}
