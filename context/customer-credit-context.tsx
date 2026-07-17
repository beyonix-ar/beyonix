"use client"

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react"

import { useAuth } from "@/context/auth-context"
import {
  normalizeMoney,
  roundMoney,
  type CustomerCreditMovement,
} from "@/lib/customer-credit"

const CUSTOMER_CREDIT_APPLIED_STORAGE_KEY =
  "beyonix-customer-credit-applied"
const CUSTOMER_CREDIT_BALANCE_STORAGE_PREFIX =
  "beyonix-customer-credit-balance"

interface CustomerCreditContextType {
  balance: number
  loading: boolean
  error: string
  movements: CustomerCreditMovement[]
  movementsLoading: boolean
  appliedAmount: number
  reload: () => Promise<void>
  loadMovements: () => Promise<void>
  setAppliedAmount: (amount: number) => void
  clearAppliedAmount: () => void
}

const CustomerCreditContext = createContext<CustomerCreditContextType | null>(
  null
)

function getStoredAppliedAmount() {
  if (typeof window === "undefined") return 0

  return normalizeMoney(
    window.sessionStorage.getItem(CUSTOMER_CREDIT_APPLIED_STORAGE_KEY)
  )
}

function storeAppliedAmount(amount: number) {
  if (typeof window === "undefined") return

  const safeAmount = roundMoney(Math.max(amount, 0))

  if (safeAmount <= 0) {
    window.sessionStorage.removeItem(CUSTOMER_CREDIT_APPLIED_STORAGE_KEY)
    return
  }

  window.sessionStorage.setItem(
    CUSTOMER_CREDIT_APPLIED_STORAGE_KEY,
    String(safeAmount)
  )
}

function getBalanceStorageKey(userId: string) {
  return `${CUSTOMER_CREDIT_BALANCE_STORAGE_PREFIX}:${userId}`
}

function getStoredBalance(userId: string) {
  if (typeof window === "undefined") return 0

  return normalizeMoney(window.localStorage.getItem(getBalanceStorageKey(userId)))
}

function storeBalance(userId: string, balance: number) {
  if (typeof window === "undefined") return

  window.localStorage.setItem(
    getBalanceStorageKey(userId),
    String(roundMoney(Math.max(balance, 0)))
  )
}

export function CustomerCreditProvider({
  children,
}: {
  children: ReactNode
}) {
  const { user, isLoading: authLoading } = useAuth()
  const [balance, setBalance] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [movements, setMovements] = useState<CustomerCreditMovement[]>([])
  const [movementsLoading, setMovementsLoading] = useState(false)
  const [appliedAmount, setAppliedAmountState] = useState(0)

  useEffect(() => {
    setAppliedAmountState(getStoredAppliedAmount())
  }, [])

  const clearAppliedAmount = useCallback(() => {
    setAppliedAmountState(0)
    storeAppliedAmount(0)
  }, [])

  const setAppliedAmount = useCallback((amount: number) => {
    const safeAmount = roundMoney(Math.max(amount, 0))

    setAppliedAmountState(safeAmount)
    storeAppliedAmount(safeAmount)
  }, [])

  useEffect(() => {
    if (!user) return

    setBalance(getStoredBalance(user.id))
  }, [user])

  const reload = useCallback(async () => {
    if (!user) {
      setBalance(0)
      setError("")
      setMovements([])
      clearAppliedAmount()
      return
    }

    setLoading(true)
    setError("")

    try {
      const response = await fetch("/api/customer-credit/balance", {
        cache: "no-store",
      })
      const data = (await response.json()) as {
        balance?: number
        error?: string
      }

      if (!response.ok) {
        throw new Error(data.error || "No pudimos cargar tu saldo.")
      }

      const nextBalance = roundMoney(Number(data.balance ?? 0))
      setBalance(nextBalance)
      storeBalance(user.id, nextBalance)
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "No pudimos cargar tu saldo."
      )
      setBalance(0)
    } finally {
      setLoading(false)
    }
  }, [clearAppliedAmount, user])

  const loadMovements = useCallback(async () => {
    if (!user) {
      setMovements([])
      return
    }

    setMovementsLoading(true)
    setError("")

    try {
      const response = await fetch("/api/customer-credit/movements", {
        cache: "no-store",
      })
      const data = (await response.json()) as {
        balance?: number
        movements?: CustomerCreditMovement[]
        error?: string
      }

      if (!response.ok) {
        throw new Error(
          data.error || "No pudimos cargar tus movimientos de saldo."
        )
      }

      const nextBalance = roundMoney(Number(data.balance ?? 0))
      setBalance(nextBalance)
      storeBalance(user.id, nextBalance)
      setMovements(data.movements ?? [])
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "No pudimos cargar tus movimientos de saldo."
      )
    } finally {
      setMovementsLoading(false)
    }
  }, [user])

  useEffect(() => {
    if (authLoading) return

    void reload()
  }, [authLoading, reload])

  const value = useMemo(
    () => ({
      balance,
      loading: authLoading || loading,
      error,
      movements,
      movementsLoading,
      appliedAmount,
      reload,
      loadMovements,
      setAppliedAmount,
      clearAppliedAmount,
    }),
    [
      appliedAmount,
      authLoading,
      balance,
      clearAppliedAmount,
      error,
      loadMovements,
      loading,
      movements,
      movementsLoading,
      reload,
      setAppliedAmount,
    ]
  )

  return (
    <CustomerCreditContext.Provider value={value}>
      {children}
    </CustomerCreditContext.Provider>
  )
}

export function useCustomerCredit() {
  const context = useContext(CustomerCreditContext)

  if (!context) {
    throw new Error(
      "useCustomerCredit debe usarse dentro de <CustomerCreditProvider>"
    )
  }

  return context
}
