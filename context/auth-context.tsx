"use client"

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from "react"

// ─── Tipos ───────────────────────────────────────────────────────────────────

export interface BeyonixUser {
  id: string
  name: string
  email: string
  createdAt: string
  // Se completa en el checkout
  phone?: string
  province?: string
  city?: string
  address?: string
  // Compras verificadas (habilitan reseñas)
  verifiedPurchaseIds?: number[]
}

interface AuthContextType {
  user: BeyonixUser | null
  isLoading: boolean
  login: (email: string, password: string) => Promise<{ ok: boolean; error?: string }>
  register: (name: string, email: string, password: string) => Promise<{ ok: boolean; error?: string }>
  logout: () => void
  updateUser: (data: Partial<BeyonixUser>) => void
}

// ─── Helpers de storage ──────────────────────────────────────────────────────

const USERS_KEY = "beyonix_users"
const SESSION_KEY = "beyonix_session"

function getUsers(): Record<string, { hash: string; user: BeyonixUser }> {
  try {
    return JSON.parse(localStorage.getItem(USERS_KEY) || "{}")
  } catch {
    return {}
  }
}

// Hash muy simple para demo (en producción usar bcrypt via API route)
function hashPassword(password: string): string {
  let hash = 0
  for (let i = 0; i < password.length; i++) {
    const char = password.charCodeAt(i)
    hash = (hash << 5) - hash + char
    hash = hash & hash
  }
  return `bx_${Math.abs(hash).toString(36)}_${password.length}`
}

function generateId(): string {
  return `u_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
}

// ─── Context ─────────────────────────────────────────────────────────────────

const AuthContext = createContext<AuthContextType | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<BeyonixUser | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  // Carga sesión guardada al montar
  useEffect(() => {
    try {
      const sessionId = localStorage.getItem(SESSION_KEY)
      if (sessionId) {
        const users = getUsers()
        const entry = users[sessionId]
        if (entry) setUser(entry.user)
      }
    } catch {
      // silencia errores de SSR
    } finally {
      setIsLoading(false)
    }
  }, [])

  const login = useCallback(
    async (email: string, password: string): Promise<{ ok: boolean; error?: string }> => {
      const normalizedEmail = email.trim().toLowerCase()
      const users = getUsers()

      // Busca por email
      const entry = Object.values(users).find(
        (e) => e.user.email === normalizedEmail
      )

      if (!entry) {
        return { ok: false, error: "No encontramos una cuenta con ese email." }
      }

      if (entry.hash !== hashPassword(password)) {
        return { ok: false, error: "La contraseña es incorrecta." }
      }

      localStorage.setItem(SESSION_KEY, entry.user.id)
      setUser(entry.user)
      return { ok: true }
    },
    []
  )

  const register = useCallback(
    async (
      name: string,
      email: string,
      password: string
    ): Promise<{ ok: boolean; error?: string }> => {
      const normalizedEmail = email.trim().toLowerCase()
      const users = getUsers()

      const exists = Object.values(users).some(
        (e) => e.user.email === normalizedEmail
      )

      if (exists) {
        return { ok: false, error: "Ya existe una cuenta con ese email." }
      }

      if (password.length < 6) {
        return { ok: false, error: "La contraseña debe tener al menos 6 caracteres." }
      }

      const newUser: BeyonixUser = {
        id: generateId(),
        name: name.trim(),
        email: normalizedEmail,
        createdAt: new Date().toISOString(),
        verifiedPurchaseIds: [],
      }

      users[newUser.id] = { hash: hashPassword(password), user: newUser }
      localStorage.setItem(USERS_KEY, JSON.stringify(users))
      localStorage.setItem(SESSION_KEY, newUser.id)
      setUser(newUser)
      return { ok: true }
    },
    []
  )

  const logout = useCallback(() => {
    localStorage.removeItem(SESSION_KEY)
    setUser(null)
  }, [])

  const updateUser = useCallback((data: Partial<BeyonixUser>) => {
    setUser((prev) => {
      if (!prev) return prev
      const updated = { ...prev, ...data }
      // Persiste cambios
      const users = getUsers()
      if (users[prev.id]) {
        users[prev.id].user = updated
        localStorage.setItem(USERS_KEY, JSON.stringify(users))
      }
      return updated
    })
  }, [])

  return (
    <AuthContext.Provider value={{ user, isLoading, login, register, logout, updateUser }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthContextType {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error("useAuth debe usarse dentro de <AuthProvider>")
  return ctx
}