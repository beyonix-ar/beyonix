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
import {
  validateRegisterPayload,
} from "@/lib/validation/account-fields"
const PASSWORD_RECOVERY_KEY = "beyonix-password-recovery"

function isPasswordRecoveryInProgress() {
  if (typeof window === "undefined") return false

  return localStorage.getItem(PASSWORD_RECOVERY_KEY) === "true"
}

function isResetPasswordPage() {
  if (typeof window === "undefined") return false

  return window.location.pathname.startsWith("/reset-password")
}

function shouldHideRecoverySession() {
  return isPasswordRecoveryInProgress() && !isResetPasswordPage()
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Types
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

  references?: string

  avatarUrl?: string

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
  references?: string
}

interface AuthContextType {
  user: BeyonixUser | null

  isLoading: boolean

  isAdmin: boolean
  isSuperAdmin: boolean

  login: (
    identifier: string,
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

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Mapper
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

    references:
      profile.referencias ?? undefined,

    avatarUrl:
      profile.avatar_url ?? undefined,
  }
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Context
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const AuthContext =
  createContext<AuthContextType | null>(
    null
  )

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Provider
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Load profile
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

            username:
              supabaseUser
                .user_metadata
                ?.username ?? undefined,

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

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Session listener
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  useEffect(() => {
    function hideRecoverySessionOutsideReset() {
      if (shouldHideRecoverySession()) {
        setUser(null)
      }
    }

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
            if (shouldHideRecoverySession()) {
              setUser(null)
              setIsLoading(false)
              return
            }

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
          event,
          session
        ) => {
          if (event === "PASSWORD_RECOVERY") {
            localStorage.setItem(PASSWORD_RECOVERY_KEY, "true")
          }

          if (
            session?.user
          ) {
            if (shouldHideRecoverySession()) {
              setUser(null)
              return
            }

            loadProfile(
              session.user
            )
          } else {
            setUser(null)
          }
        }
      )

    window.addEventListener("focus", hideRecoverySessionOutsideReset)
    window.addEventListener("storage", hideRecoverySessionOutsideReset)

    return () => {
      window.removeEventListener("focus", hideRecoverySessionOutsideReset)
      window.removeEventListener("storage", hideRecoverySessionOutsideReset)
      subscription.unsubscribe()
    }
  }, [loadProfile])

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Login
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  const login =
    useCallback(
      async (
        identifier: string,
        password: string
      ): Promise<{
        ok: boolean
        error?: string
      }> => {
        localStorage.removeItem(PASSWORD_RECOVERY_KEY)

        const normalizedIdentifier =
          identifier.trim().toLowerCase()

        let loginEmail =
          normalizedIdentifier

        if (!normalizedIdentifier.includes("@")) {
          const { data: profileEmail } =
            await supabase
              .rpc(
                "get_profile_email_by_username",
                {
                  username_input:
                    normalizedIdentifier,
                }
              )

          if (!profileEmail) {
            return {
              ok: false,
              error:
                "Email, usuario o contraseña incorrectos.",
            }
          }

          loginEmail =
            String(profileEmail).trim().toLowerCase()
        }

        const {
          data,
          error,
        } =
          await supabase.auth.signInWithPassword(
            {
              email:
                loginEmail,

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
                "Email, usuario o contraseña incorrectos.",
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

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Register
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  const register =
    useCallback(
      async (
        form: RegisterPayload
      ): Promise<{
        ok: boolean
        error?: string
      }> => {
        localStorage.removeItem(PASSWORD_RECOVERY_KEY)

        const validationError =
          validateRegisterPayload({
            username:
              form.username,
            name:
              form.name,
            email:
              form.email,
            address:
              form.address,
            province:
              form.province,
            postalCode:
              form.postalCode,
            phone:
              form.phone,
            password:
              form.password,
            references:
              form.references,
          })

        if (validationError) {
          return {
            ok: false,
            error:
              validationError,
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
                    form.username.trim().toLowerCase(),
                  telefono:
                    form.phone.trim(),
                  direccion:
                    form.address.trim(),
                  codigo_postal:
                    form.postalCode.trim(),
                  provincia:
                    form.province.trim(),
                  referencias:
                    form.references?.trim() ?? "",
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
              "OcurriÃ³ un error al crear la cuenta.",
          }
        }

        if (data.user) {
          const profilePayload = {
            username:
              form.username.trim().toLowerCase(),
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
            referencias:
              form.references?.trim() ?? "",
          }

          let { error: profileError } =
            await supabase
              .from("profiles")
              .update(profilePayload as never)
              .eq("id", data.user.id)

          if (
            profileError &&
            profileError.message
              .toLowerCase()
              .includes("referencias")
          ) {
            const {
              referencias,
              ...profilePayloadWithoutReferences
            } = profilePayload

            const retry =
              await supabase
                .from("profiles")
                .update(profilePayloadWithoutReferences as never)
                .eq("id", data.user.id)

            profileError = retry.error
          }

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

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Logout
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  const logout =
    useCallback(
      async () => {
        await supabase.auth.signOut()

        localStorage.removeItem(PASSWORD_RECOVERY_KEY)
        localStorage.removeItem("beyonix-cart")
        sessionStorage.removeItem("beyonix-cart")

        setUser(null)
      },
      []
    )

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Update user
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

        if (data.avatarUrl !== undefined) {
          payload.avatar_url = data.avatarUrl
        }

        if (data.references !== undefined) {
          payload.referencias = data.references
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

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Admin
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  const isSuperAdmin =
    user?.rol?.toLowerCase() ===
    "super_admin"

  const isAdmin =
    user?.rol?.toLowerCase() ===
      "admin" ||
    isSuperAdmin

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Provider
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Hook
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

