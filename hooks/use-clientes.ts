"use client"

import { useCallback, useEffect, useRef, useState } from "react"

import type {
  BlockedClientIdentifier,
  ClientRiskStatus,
} from "@/lib/clients/client-blocking"
import { normalizeBlockIdentifier } from "@/lib/clients/client-blocking"
import { notifyAdminNotificationsChanged } from "@/lib/admin/admin-notifications"
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
  const silentRefreshInFlight = useRef(false)
  const [clientes, setClientes] = useState<SupabaseCliente[]>([])
  const [blockedIdentifiers, setBlockedIdentifiers] = useState<
    BlockedClientIdentifier[]
  >([])
  const [creditTopups, setCreditTopups] = useState<CustomerCreditTopupReview[]>([])
  const [topupSavingId, setTopupSavingId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadClientes = useCallback(async (
    { silent = false }: { silent?: boolean } = {},
  ) => {
    if (silent && silentRefreshInFlight.current) return

    try {
      if (silent) {
        silentRefreshInFlight.current = true
      } else {
        setLoading(true)
        setError(null)
      }
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
      setError(null)
    } catch (err) {
      console.error(err)
      if (!silent) setError("No se pudieron cargar los clientes.")
    } finally {
      if (silent) {
        silentRefreshInFlight.current = false
      } else {
        setLoading(false)
      }
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

        notifyAdminNotificationsChanged()
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

  const adjustCustomerBalance = useCallback(
    async (data: {
      userId: string
      operation: "credit" | "debit"
      amount: string
      description: string
    }) => {
      setSaving(true)
      setError(null)

      try {
        const response = await adminFetch(
          `/api/admin/clientes/${data.userId}/saldo`,
          {
            method: "POST",
            body: JSON.stringify({
              operation: data.operation,
              amount: data.amount,
              description: data.description,
            }),
          },
        )
        const payload = (await response.json().catch(() => null)) as {
          error?: string
        } | null

        if (!response.ok) {
          throw new Error(payload?.error ?? "No se pudo actualizar el saldo.")
        }

        await loadClientes()
      } catch (err) {
        throw err instanceof Error
          ? err
          : new Error("No se pudo actualizar el saldo.")
      } finally {
        setSaving(false)
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
        void loadClientes({ silent: true })
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
      .subscribe((status) => {
        if (status === "SUBSCRIBED") scheduleReload()
      })

    return () => {
      if (reloadTimer) clearTimeout(reloadTimer)
      void supabase.removeChannel(channel)
    }
  }, [loadClientes])

  useEffect(() => {
    const refreshIfVisible = () => {
      if (document.visibilityState === "visible") {
        void loadClientes({ silent: true })
      }
    }
    const fallbackInterval = window.setInterval(refreshIfVisible, 4_000)

    window.addEventListener("focus", refreshIfVisible)
    window.addEventListener("online", refreshIfVisible)
    document.addEventListener("visibilitychange", refreshIfVisible)

    return () => {
      window.clearInterval(fallbackInterval)
      window.removeEventListener("focus", refreshIfVisible)
      window.removeEventListener("online", refreshIfVisible)
      document.removeEventListener("visibilitychange", refreshIfVisible)
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
    adjustCustomerBalance,
  }
}
