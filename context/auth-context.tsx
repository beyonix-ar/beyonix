"use client"

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
  type ReactNode,
} from "react"

import {
  clearSupabaseBrowserSession,
  getSafeSupabaseSession,
  supabase,
} from "@/lib/supabase/client"

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
const AUTH_LAST_ACTIVITY_KEY = "beyonix-auth-last-activity"
const AUTH_SESSION_STARTED_KEY = "beyonix-auth-session-started"
const AUTH_ADMIN_INACTIVITY_LIMIT_MS = 30 * 60 * 1000
const AUTH_ADMIN_WARNING_THRESHOLD_MS = 2 * 60 * 1000
const AUTH_CLIENT_SESSION_LIMIT_MS = 7 * 24 * 60 * 60 * 1000
const AUTH_ACTIVITY_WRITE_INTERVAL_MS = 15 * 1000

function isAdminSessionRole(role?: string | null) {
  return role === "admin" || role === "super_admin"
}

function getLastAuthActivity() {
  if (typeof window === "undefined") return null

  const storedValue = Number(localStorage.getItem(AUTH_LAST_ACTIVITY_KEY))

  return Number.isFinite(storedValue) && storedValue > 0
    ? storedValue
    : null
}

function hasAdminSessionExpired() {
  const lastActivity = getLastAuthActivity()

  return (
    lastActivity === null ||
    Date.now() - lastActivity >= AUTH_ADMIN_INACTIVITY_LIMIT_MS
  )
}

function getAdminSessionRemainingMs() {
  const lastActivity = getLastAuthActivity()

  if (lastActivity === null) return 0

  return AUTH_ADMIN_INACTIVITY_LIMIT_MS - (Date.now() - lastActivity)
}

function getSessionStartedAt() {
  if (typeof window === "undefined") return null

  const storedValue = Number(localStorage.getItem(AUTH_SESSION_STARTED_KEY))

  return Number.isFinite(storedValue) && storedValue > 0
    ? storedValue
    : null
}

function ensureSessionStartedAt() {
  if (typeof window === "undefined") return

  if (!getSessionStartedAt()) {
    localStorage.setItem(AUTH_SESSION_STARTED_KEY, String(Date.now()))
  }
}

function recordSessionStartedAt() {
  if (typeof window === "undefined") return

  localStorage.setItem(AUTH_SESSION_STARTED_KEY, String(Date.now()))
}

function hasPersistentSessionExpired() {
  const startedAt = getSessionStartedAt()

  if (!startedAt) {
    ensureSessionStartedAt()
    return false
  }

  return Date.now() - startedAt >= AUTH_CLIENT_SESSION_LIMIT_MS
}

function recordAuthActivity() {
  if (typeof window === "undefined") return

  localStorage.setItem(AUTH_LAST_ACTIVITY_KEY, String(Date.now()))
}

function clearAuthActivity() {
  if (typeof window === "undefined") return

  localStorage.removeItem(AUTH_LAST_ACTIVITY_KEY)
  localStorage.removeItem(AUTH_SESSION_STARTED_KEY)
}

function redirectToLoginWithCurrentPath() {
  if (
    typeof window === "undefined" ||
    window.location.pathname.startsWith("/login")
  ) {
    return
  }

  const redirect = `${window.location.pathname}${window.location.search}`
  window.location.href = `/login?redirect=${encodeURIComponent(redirect)}`
}

function isPasswordRecoveryInProgress() {
  if (typeof window === "undefined") return false

  return localStorage.getItem(PASSWORD_RECOVERY_KEY) === "true"
}

function isResetPasswordPage() {
  if (typeof window === "undefined") return false

  return window.location.pathname.startsWith("/reset-password")
}

function isTemporaryAuthPage() {
  if (typeof window === "undefined") return false

  return (
    window.location.pathname.startsWith("/confirmar-email") ||
    isResetPasswordPage()
  )
}

function shouldHideRecoverySession() {
  return isPasswordRecoveryInProgress() && !isResetPasswordPage()
}

function isEmailConfirmed(supabaseUser: User) {
  return Boolean(
    supabaseUser.email_confirmed_at ||
      supabaseUser.confirmed_at
  )
}

function isAccountActivated(supabaseUser: User) {
  const requiresManualActivation =
    supabaseUser.user_metadata?.pending_activation === true

  return (
    !requiresManualActivation ||
    supabaseUser.app_metadata?.account_activated === true
  )
}

function getSupabaseErrorDetails(error: unknown) {
  const candidate =
    typeof error === "object" && error !== null
      ? (error as {
          message?: unknown
          details?: unknown
          hint?: unknown
          code?: unknown
        })
      : null

  return {
    message:
      typeof candidate?.message === "string"
        ? candidate.message
        : error instanceof Error
          ? error.message
          : String(error),
    details: candidate?.details,
    hint: candidate?.hint,
    code: candidate?.code,
    error,
  }
}

// Types

export interface BeyonixUser {
  id: string

  username?: string

  name: string

  email: string

  rol: "cliente" | "operador" | "admin" | "super_admin"

  phone?: string

  dni?: string

  city?: string

  province?: string

  address?: string

  street?: string

  streetNumber?: string

  floor?: string

  apartment?: string

  postalCode?: string

  references?: string

  avatarUrl?: string

  blockedAt?: string

  createdAt: string
}

export interface RegisterPayload {
  username: string
  name: string
  email: string
  password: string
  address?: string
  street?: string
  streetNumber?: string
  floor?: string
  apartment?: string
  locality?: string
  postalCode?: string
  phone?: string
  province?: string
  references?: string
}

interface AuthContextType {
  user: BeyonixUser | null

  isLoading: boolean

  isAdmin: boolean
  isInternal: boolean
  isOperator: boolean
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
    requiresConfirmation?: boolean
    pendingUserId?: string
    confirmationHandoff?: string
  }>

  logout: () => Promise<void>

  updateUser: (
    data: Partial<BeyonixUser>
  ) => Promise<void>
}
// Mapper

function profileToUser(
  profile: SupabaseProfile,
  email: string,
  metadataUsername?: string
): BeyonixUser {
  return {
    id: profile.id,

    username:
      profile.username ?? metadataUsername,

    name: profile.nombre,

    email,

    rol:
      profile.rol === "operador" ||
      profile.rol === "admin" ||
      profile.rol === "super_admin"
        ? profile.rol
        : "cliente",

    createdAt:
      profile.created_at,

    phone:
      profile.telefono ?? undefined,

    dni:
      profile.dni ?? undefined,

    province:
      profile.provincia ?? undefined,

    street:
      profile.calle ?? undefined,

    streetNumber:
      profile.numero ?? undefined,

    floor:
      profile.piso ?? undefined,

    apartment:
      profile.departamento ?? undefined,

    city:
      profile.localidad ?? undefined,

    postalCode:
      profile.codigo_postal ?? undefined,

    references:
      profile.referencias ?? undefined,

    avatarUrl:
      profile.avatar_url ?? undefined,

    blockedAt:
      profile.blocked_at ?? undefined,
  }
}
// Context

function authUserToFallbackUser(
  supabaseUser: User,
  currentUser: BeyonixUser | null
): BeyonixUser {
  if (currentUser?.id === supabaseUser.id) return currentUser

  const metadata = supabaseUser.user_metadata ?? {}
  const metadataRole =
    supabaseUser.app_metadata?.rol ??
    supabaseUser.app_metadata?.role ??
    metadata.rol
  const role =
    metadataRole === "operador" ||
    metadataRole === "admin" ||
    metadataRole === "super_admin"
      ? metadataRole
      : "cliente"

  return {
    id: supabaseUser.id,
    username: metadata.username ?? undefined,
    name:
      metadata.nombre ??
      metadata.name ??
      supabaseUser.email?.split("@")[0] ??
      "Usuario",
    email: supabaseUser.email ?? metadata.email ?? "",
    rol: role,
    phone: metadata.telefono ?? undefined,
    city: metadata.localidad ?? undefined,
    province: metadata.provincia ?? undefined,
    street: metadata.calle ?? undefined,
    streetNumber: metadata.numero ?? undefined,
    floor: metadata.piso ?? undefined,
    apartment: metadata.departamento ?? undefined,
    postalCode: metadata.codigo_postal ?? undefined,
    references: metadata.referencias ?? undefined,
    createdAt: supabaseUser.created_at,
  }
}

const AuthContext =
  createContext<AuthContextType | null>(
    null
  )
// Provider

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
  const registrationInProgress = useRef(false)
  const loginInProgress = useRef(false)
  const hasAuthenticatedSession = useRef(false)
  const lastActivityWrite = useRef(0)
  const currentRoleRef = useRef<BeyonixUser["rol"] | null>(null)
  const [adminInactivityWarning, setAdminInactivityWarning] = useState(false)
  // Load profile

  const loadProfile =
    useCallback(
      async (
        supabaseUser: User,
        accessToken: string
      ) => {
        let profile: SupabaseProfile | undefined

        try {
          const response = await fetch("/api/auth/profile", {
            headers: {
              Authorization: `Bearer ${accessToken}`,
            },
            cache: "no-store",
          })
          const data = (await response.json()) as {
            profile?: SupabaseProfile
            error?: string
          }

          if (!response.ok || !data.profile) {
            console.error("LOAD_PROFILE_API_ERROR", {
              status: response.status,
              error: data.error,
            })
          } else {
            profile = data.profile
          }
        } catch (profileLoadError) {
          console.error(
            "LOAD_PROFILE_ERROR",
            getSupabaseErrorDetails(profileLoadError)
          )
        }

        if (!profile) {
          setUser((currentUser) => {
            const fallbackUser = authUserToFallbackUser(
              supabaseUser,
              currentUser
            )

            currentRoleRef.current = fallbackUser.rol

            if (isAdminSessionRole(fallbackUser.rol)) {
              if (!getLastAuthActivity()) recordAuthActivity()
              if (hasAdminSessionExpired()) {
                void supabase.auth.signOut({ scope: "local" })
                currentRoleRef.current = null
                redirectToLoginWithCurrentPath()
                return null
              }
            }

            return fallbackUser
          })
          return
        }

        if (profile.blocked_at) {
          await supabase.auth.signOut()
          setUser(null)
          return
        }

        const nextUser = profileToUser(
          profile,
          supabaseUser.email ?? "",
          supabaseUser.user_metadata?.username ?? undefined
        )

        currentRoleRef.current = nextUser.rol

        if (isAdminSessionRole(nextUser.rol)) {
          if (!getLastAuthActivity()) recordAuthActivity()
          if (hasAdminSessionExpired()) {
            await supabase.auth.signOut({ scope: "local" })
            currentRoleRef.current = null
            setUser(null)
            redirectToLoginWithCurrentPath()
            return
          }
        }

        setUser(nextUser)
      },
      []
    )
  // Session listener

  useEffect(() => {
    let inactivityLogoutInProgress = false

    function clearAuthenticatedUser() {
      hasAuthenticatedSession.current = false
      currentRoleRef.current = null
      setAdminInactivityWarning(false)
      clearAuthActivity()
      setUser(null)
    }

    async function logoutExpiredSession() {
      if (inactivityLogoutInProgress) return

      inactivityLogoutInProgress = true
      clearAuthenticatedUser()

      try {
        await supabase.auth.signOut({ scope: "local" })
      } finally {
        setIsLoading(false)
        inactivityLogoutInProgress = false

        redirectToLoginWithCurrentPath()
      }
    }

    function acceptAuthenticatedSession() {
      hasAuthenticatedSession.current = true
    }

    function validatePersistentSession() {
      if (!hasAuthenticatedSession.current) return true

      if (hasPersistentSessionExpired()) {
        void logoutExpiredSession()
        return false
      }

      return true
    }

    function validateAdminActivity() {
      if (
        hasAuthenticatedSession.current &&
        isAdminSessionRole(currentRoleRef.current)
      ) {
        const remainingMs = getAdminSessionRemainingMs()

        if (remainingMs <= 0) {
          void logoutExpiredSession()
          return false
        }

        setAdminInactivityWarning(
          remainingMs <= AUTH_ADMIN_WARNING_THRESHOLD_MS
        )
      }

      return true
    }

    function trackActivity() {
      if (
        !hasAuthenticatedSession.current ||
        !isAdminSessionRole(currentRoleRef.current)
      ) {
        validatePersistentSession()
        return
      }

      const now = Date.now()

      if (
        now - lastActivityWrite.current <
        AUTH_ACTIVITY_WRITE_INTERVAL_MS
      ) {
        return
      }

      lastActivityWrite.current = now
      recordAuthActivity()
      setAdminInactivityWarning(false)
    }

    function recordPageClose() {
      if (
        hasAuthenticatedSession.current &&
        isAdminSessionRole(currentRoleRef.current) &&
        !hasAdminSessionExpired()
      ) {
        recordAuthActivity()
      }
    }

    function hideRecoverySessionOutsideReset() {
      if (shouldHideRecoverySession()) {
        setUser(null)
        return
      }

      if (!validatePersistentSession()) return
      validateAdminActivity()
    }

    if (!isTemporaryAuthPage() && hasPersistentSessionExpired()) {
      clearSupabaseBrowserSession()
      clearAuthenticatedUser()
      setIsLoading(false)
    } else {
      getSafeSupabaseSession().then(
        (session) => {
          if (
            session?.user
          ) {
            if (isTemporaryAuthPage()) {
              setUser(null)
              setIsLoading(false)
              return
            }

            ensureSessionStartedAt()

            if (hasPersistentSessionExpired()) {
              void logoutExpiredSession()
              return
            }

            if (shouldHideRecoverySession()) {
              setUser(null)
              setIsLoading(false)
              return
            }

            if (!isEmailConfirmed(session.user)) {
              setUser(null)
              setIsLoading(false)
              return
            }

            if (!isAccountActivated(session.user)) {
              setUser(null)
              setIsLoading(false)
              return
            }

            acceptAuthenticatedSession()

            loadProfile(
              session.user,
              session.access_token
            ).finally(() =>
              setIsLoading(
                false
              )
            )
          } else {
            clearAuthenticatedUser()
            setIsLoading(
              false
            )
          }
        }
      ).catch(() => {
        setUser(null)
        setIsLoading(false)
      })
    }

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

          if (event === "SIGNED_OUT") {
            clearAuthenticatedUser()
            return
          }

          if (registrationInProgress.current) {
            setUser(null)
            return
          }

          if (
            session?.user
          ) {
            // Toda sesión recién emitida inicia su propio período de
            // actividad. Esto incluye confirmaciones abiertas en otra pestaña.
            if (event === "SIGNED_IN") {
              recordSessionStartedAt()
              recordAuthActivity()
              lastActivityWrite.current = Date.now()
            }

            if (isTemporaryAuthPage()) {
              setUser(null)
              setIsLoading(false)
              return
            }

            if (
              event !== "SIGNED_IN" &&
              hasPersistentSessionExpired()
            ) {
              void logoutExpiredSession()
              return
            }

            if (shouldHideRecoverySession()) {
              setUser(null)
              return
            }

            if (!isEmailConfirmed(session.user)) {
              setUser(null)
              return
            }

            if (!isAccountActivated(session.user)) {
              setUser(null)
              return
            }

            acceptAuthenticatedSession()

            loadProfile(
              session.user,
              session.access_token
            )
          } else {
            clearAuthenticatedUser()
          }
        }
      )

    const activityEvents = [
      "keydown",
      "click",
      "mousemove",
      "pointerdown",
      "scroll",
      "touchstart",
    ] as const
    const inactivityCheck = window.setInterval(
      () => {
        if (!validatePersistentSession()) return
        validateAdminActivity()
      },
      60 * 1000
    )

    activityEvents.forEach((eventName) => {
      window.addEventListener(eventName, trackActivity, {
        passive: true,
      })
    })
    window.addEventListener("focus", hideRecoverySessionOutsideReset)
    window.addEventListener("storage", hideRecoverySessionOutsideReset)
    window.addEventListener("pagehide", recordPageClose)
    document.addEventListener(
      "visibilitychange",
      hideRecoverySessionOutsideReset
    )

    return () => {
      window.clearInterval(inactivityCheck)
      activityEvents.forEach((eventName) => {
        window.removeEventListener(eventName, trackActivity)
      })
      window.removeEventListener("focus", hideRecoverySessionOutsideReset)
      window.removeEventListener("storage", hideRecoverySessionOutsideReset)
      window.removeEventListener("pagehide", recordPageClose)
      document.removeEventListener(
        "visibilitychange",
        hideRecoverySessionOutsideReset
      )
      subscription.unsubscribe()
    }
  }, [loadProfile])
  // Login

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
          const {
            data: profileEmail,
            error: profileError,
          } = await supabase
            .rpc("get_profile_email_by_username", {
              username_input: normalizedIdentifier,
            })

          if (profileError || !profileEmail) {
            return {
              ok: false,
              error:
                "No existe una cuenta con ese nombre de usuario.",
            }
          }

          loginEmail =
            String(profileEmail).trim().toLowerCase()
        }

        const { data: isBlocked } =
          await supabase.rpc(
            "is_client_registration_blocked",
            {
              email_input: loginEmail.includes("@") ? loginEmail : null,
              username_input: normalizedIdentifier.includes("@")
                ? null
                : normalizedIdentifier,
              phone_input: null,
            }
          )

        if (isBlocked) {
          return {
            ok: false,
            error:
              "Esta cuenta no puede acceder a la tienda.",
          }
        }

        loginInProgress.current = true
        recordSessionStartedAt()
        recordAuthActivity()

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
          loginInProgress.current = false
          clearAuthActivity()

          if (
            error.code === "email_not_confirmed" ||
            error.message.toLowerCase().includes("email not confirmed")
          ) {
            return {
              ok: false,
              error:
                "Tenés que confirmar tu correo antes de iniciar sesión.",
            }
          }

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
          if (!isEmailConfirmed(data.user)) {
            await supabase.auth.signOut()
            loginInProgress.current = false
            clearAuthActivity()
            setUser(null)

            return {
              ok: false,
              error:
                "Tenés que confirmar tu correo antes de iniciar sesión.",
            }
          }

          if (!isAccountActivated(data.user)) {
            await supabase.auth.signOut()
            loginInProgress.current = false
            clearAuthActivity()
            setUser(null)

            return {
              ok: false,
              error:
                "Tenés que completar la activación desde el botón del correo antes de iniciar sesión.",
            }
          }

          await loadProfile(
            data.user,
            data.session!.access_token
          )
        }

        loginInProgress.current = false

        return {
          ok: true,
        }
      },
      [loadProfile]
    )
  // Register

  const register =
    useCallback(
      async (
        form: RegisterPayload
      ): Promise<{
        ok: boolean
        error?: string
        requiresConfirmation?: boolean
        pendingUserId?: string
        confirmationHandoff?: string
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
              form.address ?? "",
            street:
              form.street ?? "",
            streetNumber:
              form.streetNumber ?? "",
            locality:
              form.locality ?? "",
            province:
              form.province ?? "",
            postalCode:
              form.postalCode ?? "",
            phone:
              form.phone ?? "",
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

        const { data: isBlocked } =
          await supabase.rpc(
            "is_client_registration_blocked",
            {
              email_input:
                form.email.trim().toLowerCase(),
              username_input:
                form.username.trim().toLowerCase(),
              phone_input:
                form.phone?.trim() ?? "",
            }
          )

        if (isBlocked) {
          return {
            ok: false,
            error:
              "No podemos crear una cuenta con esos datos.",
          }
        }

        registrationInProgress.current = true
        const username = form.username.trim().toLowerCase()
        const email = form.email.trim().toLowerCase()
        const emailRedirectTo =
          typeof window !== "undefined"
            ? window.location.origin
            : undefined
        const confirmationHandoff = crypto.randomUUID()
        const profilePayload = {
          email,
          username,
          nombre: form.name.trim(),
          telefono: form.phone?.trim() || null,
          calle: form.street?.trim() || null,
          numero: form.streetNumber?.trim() || null,
          piso: form.floor?.trim() || null,
          departamento: form.apartment?.trim() || null,
          localidad: form.locality?.trim() || null,
          codigo_postal: form.postalCode?.trim() || null,
          provincia: form.province?.trim() || null,
          referencias: form.references?.trim() || null,
          confirmation_handoff: confirmationHandoff,
          confirmation_handoff_created_at: new Date().toISOString(),
        }

        const executeSignup = () =>
          supabase.auth.signUp({
            email,
            password: form.password,
            options: {
              emailRedirectTo,
              data: {
                ...profilePayload,
              },
            },
          })
        let signupResult: Awaited<ReturnType<typeof executeSignup>>

        try {
          signupResult = await executeSignup()
        } catch (signupError) {
          registrationInProgress.current = false
          const signupDetails = getSupabaseErrorDetails(signupError)

          console.error("AUTH_SIGNUP_THROWN_ERROR", {
            ...signupDetails,
            status:
              typeof signupError === "object" &&
              signupError !== null &&
              "status" in signupError
                ? signupError.status
                : undefined,
            name:
              signupError instanceof Error
                ? signupError.name
                : undefined,
            cause:
              signupError instanceof Error
                ? signupError.cause
                : undefined,
          })

          return {
            ok: false,
            error:
              "No pudimos crear la cuenta. Revisá los datos o intentá nuevamente en unos minutos.",
          }
        }

        const { data, error } = signupResult

        if (error) {
          registrationInProgress.current = false
          console.error("AUTH_SIGNUP_ERROR", {
            message: error.message,
            status: error.status,
            name: error.name,
            cause: error.cause,
            code: error.code,
            error,
          })

          if (
            error.code === "user_already_exists" ||
            error.message.toLowerCase().includes("already registered")
          ) {
            return {
              ok: false,
              error:
                "Ya existe una cuenta con ese email.",
            }
          }

          if (
            error.code === "over_email_send_rate_limit" ||
            error.status === 429
          ) {
            return {
              ok: false,
              error:
                "Se enviaron demasiados correos. Esperá unos minutos e intentá nuevamente.",
            }
          }

          if (
            error.message.toLowerCase().includes("confirmation email")
          ) {
            return {
              ok: false,
              error:
                "No pudimos enviar el correo de confirmación. Intentá nuevamente en unos minutos.",
            }
          }

          return {
            ok: false,
            error:
              "No pudimos crear la cuenta. Revisá los datos o intentá nuevamente en unos minutos.",
          }
        }

        if (!data.user) {
          registrationInProgress.current = false
          console.error("AUTH_SIGNUP_MISSING_USER", {
            data,
          })

          return {
            ok: false,
            error:
              "No pudimos crear la cuenta. Revisá los datos o intentá nuevamente en unos minutos.",
          }
        }

        if (
          Array.isArray(data.user.identities) &&
          data.user.identities.length === 0
        ) {
          registrationInProgress.current = false
          setUser(null)

          return {
            ok: false,
            error:
              "Ya existe una cuenta con ese email. Iniciá sesión o recuperá tu contraseña.",
          }
        }

        if (
          data.session ||
          isEmailConfirmed(data.user)
        ) {
          if (data.session) {
            await supabase.auth.signOut()
          }

          registrationInProgress.current = false
          setUser(null)

          return {
            ok: false,
            error:
              "Supabase confirmó el email automáticamente. Revisá la configuración del proyecto conectado antes de continuar.",
          }
        }

        setUser(null)
        registrationInProgress.current = false

        return {
          ok: true,
          requiresConfirmation: true,
          pendingUserId: data.user.id,
          confirmationHandoff,
        }
      },
      [loadProfile]
    )
  // Logout

  const logout =
    useCallback(
      async () => {
        await supabase.auth.signOut()

        localStorage.removeItem(PASSWORD_RECOVERY_KEY)
        clearAuthActivity()
        localStorage.removeItem("beyonix-cart")
        sessionStorage.removeItem("beyonix-cart")

        setUser(null)
      },
      []
    )

  const keepAdminSessionAlive =
    useCallback(() => {
      if (!isAdminSessionRole(currentRoleRef.current)) return

      recordAuthActivity()
      lastActivityWrite.current = Date.now()
      setAdminInactivityWarning(false)
    }, [])
  // Update user

  const updateUser =
    useCallback(
      async (
        data: Partial<BeyonixUser>
      ) => {
        if (!user) {
          return
        }

        const session = await getSafeSupabaseSession()

        if (!session?.access_token) {
          throw new Error("No se pudo validar la sesión.")
        }

        const response = await fetch("/api/auth/profile", {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${session.access_token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(data),
        })
        const result = await response.json().catch(() => ({}))

        if (!response.ok || !result.profile) {
          throw new Error(result.error || "No se pudo guardar el perfil.")
        }

        const nextProfile = result.profile as SupabaseProfile

        setUser(
          profileToUser(
            nextProfile,
            nextProfile.email ?? user.email,
            user.username,
          )
        )
      },
      [user]
    )
  // Admin

  const isSuperAdmin =
    user?.rol?.toLowerCase() ===
    "super_admin"

  const isAdmin =
    user?.rol?.toLowerCase() ===
      "admin" ||
    isSuperAdmin
  const isOperator =
    user?.rol?.toLowerCase() ===
    "operador"
  const isInternal =
    isOperator ||
    isAdmin
  // Provider

  return (
    <AuthContext.Provider
      value={{
        user,

        isLoading,

        isAdmin,
        isInternal,
        isOperator,
        isSuperAdmin,

        login,

        register,

        logout,

        updateUser,
      }}
    >
      {children}
      {adminInactivityWarning && isAdminSessionRole(user?.rol) && (
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-5 right-5 z-200 w-[min(360px,calc(100vw-2rem))] rounded-2xl border border-beyonix-blue-light/30 bg-[#0B1118]/95 p-4 font-heading text-white shadow-2xl shadow-black/55 backdrop-blur-md"
        >
          <p className="text-sm font-semibold">
            Tu sesión se cerrará pronto por inactividad.
          </p>
          <button
            type="button"
            onClick={keepAdminSessionAlive}
            className="mt-3 h-9 cursor-pointer rounded-xl border border-beyonix-blue-light/35 bg-beyonix-blue/45 px-3 text-sm font-semibold text-white transition-colors hover:bg-beyonix-blue"
          >
            Mantener sesión
          </button>
        </div>
      )}
    </AuthContext.Provider>
  )
}
// Hook

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
