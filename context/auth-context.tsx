"use client"

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from "react"

import { supabase } from "@/lib/supabase/client"

import type {
  SupabaseProfile,
} from "@/lib/supabase/types"

import type {
  User,
} from "@supabase/supabase-js"

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface BeyonixUser {
  id: string

  name: string

  email: string

  rol: "cliente" | "admin"

  phone?: string

  city?: string

  province?: string

  address?: string

  createdAt: string
}

interface AuthContextType {
  user: BeyonixUser | null

  isLoading: boolean

  isAdmin: boolean

  login: (
    email: string,
    password: string
  ) => Promise<{
    ok: boolean
    error?: string
  }>

  register: (
    name: string,
    email: string,
    password: string
  ) => Promise<{
    ok: boolean
    error?: string
  }>

  logout: () => Promise<void>

  updateUser: (
    data: Partial<BeyonixUser>
  ) => Promise<void>
}

// ─────────────────────────────────────────────────────────────────────────────
// Mapper
// ─────────────────────────────────────────────────────────────────────────────

function profileToUser(
  profile: SupabaseProfile,
  email: string
): BeyonixUser {
  return {
    id: profile.id,

    name: profile.nombre,

    email,

    rol:
      profile.rol === "admin"
        ? "admin"
        : "cliente",

    createdAt:
      profile.created_at,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Context
// ─────────────────────────────────────────────────────────────────────────────

const AuthContext =
  createContext<AuthContextType | null>(
    null
  )

// ─────────────────────────────────────────────────────────────────────────────
// Provider
// ─────────────────────────────────────────────────────────────────────────────

export function AuthProvider({
  children,
}: {
  children: ReactNode
}) {
  const [user, setUser] =
    useState<BeyonixUser | null>(
      null
    )

  const [isLoading, setIsLoading] =
    useState(true)

  // ───────────────────────────────────────────────────────────────────────────
  // Load profile
  // ───────────────────────────────────────────────────────────────────────────

  const loadProfile =
    useCallback(
      async (
        supabaseUser: User
      ) => {
        const {
          data: profile,
          error,
        } = await supabase
          .from("profiles")
          .select("*")
          .eq(
            "id",
            supabaseUser.id
          )
          .single()

        console.log(
          "PROFILE:",
          profile
        )

        if (
          error ||
          !profile
        ) {
          console.error(
            "No se encontró el perfil:",
            error
          )

          setUser({
            id: supabaseUser.id,

            name:
              supabaseUser
                .user_metadata
                ?.nombre ||
              "Usuario",

            email:
              supabaseUser.email ??
              "",

            rol: "cliente",

            createdAt:
              new Date().toISOString(),
          })

          return
        }

        setUser(
          profileToUser(
            profile,
            supabaseUser.email ??
              ""
          )
        )
      },
      []
    )

  // ───────────────────────────────────────────────────────────────────────────
  // Session listener
  // ───────────────────────────────────────────────────────────────────────────

  useEffect(() => {
    supabase.auth
      .getSession()
      .then(
        ({
          data: {
            session,
          },
        }) => {
          if (
            session?.user
          ) {
            loadProfile(
              session.user
            ).finally(() =>
              setIsLoading(
                false
              )
            )
          } else {
            setIsLoading(
              false
            )
          }
        }
      )

    const {
      data: {
        subscription,
      },
    } =
      supabase.auth.onAuthStateChange(
        (
          _event,
          session
        ) => {
          if (
            session?.user
          ) {
            loadProfile(
              session.user
            )
          } else {
            setUser(null)
          }
        }
      )

    return () =>
      subscription.unsubscribe()
  }, [loadProfile])

  // ───────────────────────────────────────────────────────────────────────────
  // Login
  // ───────────────────────────────────────────────────────────────────────────

  const login =
    useCallback(
      async (
        email: string,
        password: string
      ): Promise<{
        ok: boolean
        error?: string
      }> => {
        const {
          data,
          error,
        } =
          await supabase.auth.signInWithPassword(
            {
              email:
                email
                  .trim()
                  .toLowerCase(),

              password,
            }
          )

        if (error) {
          if (
            error.message.includes(
              "Invalid login"
            )
          ) {
            return {
              ok: false,

              error:
                "Email o contraseña incorrectos.",
            }
          }

          return {
            ok: false,

            error:
              "Ocurrió un error al iniciar sesión.",
          }
        }

        if (data.user) {
          await loadProfile(
            data.user
          )
        }

        return {
          ok: true,
        }
      },
      [loadProfile]
    )

  // ───────────────────────────────────────────────────────────────────────────
  // Register
  // ───────────────────────────────────────────────────────────────────────────

  const register =
    useCallback(
      async (
        name: string,
        email: string,
        password: string
      ): Promise<{
        ok: boolean
        error?: string
      }> => {
        if (
          password.length < 6
        ) {
          return {
            ok: false,

            error:
              "La contraseña debe tener al menos 6 caracteres.",
          }
        }

        const {
          data,
          error,
        } =
          await supabase.auth.signUp(
            {
              email:
                email
                  .trim()
                  .toLowerCase(),

              password,

              options: {
                data: {
                  nombre:
                    name.trim(),
                },
              },
            }
          )

        if (error) {
          if (
            error.message.includes(
              "already registered"
            )
          ) {
            return {
              ok: false,

              error:
                "Ya existe una cuenta con ese email.",
            }
          }

          return {
            ok: false,

            error:
              "Ocurrió un error al crear la cuenta.",
          }
        }

        if (data.user) {
          await loadProfile(
            data.user
          )
        }

        return {
          ok: true,
        }
      },
      [loadProfile]
    )

  // ───────────────────────────────────────────────────────────────────────────
  // Logout
  // ───────────────────────────────────────────────────────────────────────────

  const logout =
    useCallback(
      async () => {
        await supabase.auth.signOut()

        setUser(null)
      },
      []
    )

  // ───────────────────────────────────────────────────────────────────────────
  // Update user
  // ───────────────────────────────────────────────────────────────────────────

  const updateUser =
    useCallback(
      async (
        data: Partial<BeyonixUser>
      ) => {
        if (!user) {
          return
        }

        const payload: Record<
          string,
          unknown
        > = {}

        if (
          data.name !==
          undefined
        ) {
          payload.nombre =
            data.name
        }

        if (
          data.rol !==
          undefined
        ) {
          payload.rol =
            data.rol
        }

        await supabase
          .from(
            "profiles"
          )
          .update(payload)
          .eq(
            "id",
            user.id
          )

        setUser(
          (prev) =>
            prev
              ? {
                  ...prev,
                  ...data,
                }
              : prev
        )
      },
      [user]
    )

  // ───────────────────────────────────────────────────────────────────────────
  // Admin
  // ───────────────────────────────────────────────────────────────────────────

  const isAdmin =
    user?.rol?.toLowerCase() ===
    "admin"

  // ───────────────────────────────────────────────────────────────────────────
  // Provider
  // ───────────────────────────────────────────────────────────────────────────

  return (
    <AuthContext.Provider
      value={{
        user,

        isLoading,

        isAdmin,

        login,

        register,

        logout,

        updateUser,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Hook
// ─────────────────────────────────────────────────────────────────────────────

export function useAuth(): AuthContextType {
  const ctx =
    useContext(AuthContext)

  if (!ctx) {
    throw new Error(
      "useAuth debe usarse dentro de <AuthProvider>"
    )
  }

  return ctx
}