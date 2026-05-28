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

  username?: string

  name: string

  email: string

  rol: "cliente" | "admin" | "super_admin"

  phone?: string

  city?: string

  province?: string

  address?: string

  postalCode?: string

  createdAt: string
}

export interface RegisterPayload {
  username: string
  name: string
  email: string
  password: string
  address: string
  postalCode: string
  phone: string
  province: string
}

interface AuthContextType {
  user: BeyonixUser | null

  isLoading: boolean

  isAdmin: boolean
  isSuperAdmin: boolean

  login: (
    email: string,
    password: string
  ) => Promise<{
    ok: boolean
    error?: string
  }>

  register: (
    data: RegisterPayload
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

    username:
      profile.username ?? undefined,

    name: profile.nombre,

    email,

    rol:
      profile.rol === "admin" ||
      profile.rol === "super_admin"
        ? profile.rol
        : "cliente",

    createdAt:
      profile.created_at,

    phone:
      profile.telefono ?? undefined,

    province:
      profile.provincia ?? undefined,

    address:
      profile.direccion ?? undefined,

    postalCode:
      profile.codigo_postal ?? undefined,
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

        if (
          error ||
          !profile
        ) {
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
        form: RegisterPayload
      ): Promise<{
        ok: boolean
        error?: string
      }> => {
        if (
          form.password.length < 6
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
                form.email
                  .trim()
                  .toLowerCase(),

              password:
                form.password,

              options: {
                data: {
                  nombre:
                    form.name.trim(),
                  username:
                    form.username.trim(),
                  telefono:
                    form.phone.trim(),
                  direccion:
                    form.address.trim(),
                  codigo_postal:
                    form.postalCode.trim(),
                  provincia:
                    form.province.trim(),
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
          const { error: profileError } =
            await supabase
              .from("profiles")
              .update({
                username:
                  form.username.trim(),
                nombre:
                  form.name.trim(),
                telefono:
                  form.phone.trim(),
                direccion:
                  form.address.trim(),
                codigo_postal:
                  form.postalCode.trim(),
                provincia:
                  form.province.trim(),
              } as never)
              .eq("id", data.user.id)

          if (profileError) {
            return {
              ok: false,
              error:
                "La cuenta se creó, pero faltan columnas de perfil en Supabase. Ejecutá el SQL de perfiles.",
            }
          }

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

        localStorage.removeItem("beyonix-cart")
        sessionStorage.removeItem("beyonix-cart")

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

        if (data.username !== undefined) {
          payload.username = data.username
        }

        if (data.phone !== undefined) {
          payload.telefono = data.phone
        }

        if (data.address !== undefined) {
          payload.direccion = data.address
        }

        if (data.postalCode !== undefined) {
          payload.codigo_postal = data.postalCode
        }

        if (data.province !== undefined) {
          payload.provincia = data.province
        }

        if (data.city !== undefined) {
          payload.provincia = data.city
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

  const isSuperAdmin =
    user?.rol?.toLowerCase() ===
    "super_admin"

  const isAdmin =
    user?.rol?.toLowerCase() ===
      "admin" ||
    isSuperAdmin

  // ───────────────────────────────────────────────────────────────────────────
  // Provider
  // ───────────────────────────────────────────────────────────────────────────

  return (
    <AuthContext.Provider
      value={{
        user,

        isLoading,

        isAdmin,
        isSuperAdmin,

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
