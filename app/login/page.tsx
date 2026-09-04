"use client"
// @refresh reset

import { Suspense, useCallback, useEffect, useRef, useState } from "react"
import type { InputHTMLAttributes } from "react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import {
  ArrowLeft,
  BadgeCheck,
  Check,
  CheckCircle2,
  Eye,
  EyeOff,
  Loader2,
  LockKeyhole,
  MailCheck,
  PackageCheck,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  UserRoundPlus,
} from "lucide-react"

import { BeyonixLogoLink } from "@/components/beyonix-logo-link"
import { PasswordRequirements } from "@/components/password-requirements"
import { ProvinceSelect } from "@/components/province-select"
import { useAuth } from "@/context/auth-context"
import {
  EMAIL_CONFIRMATION_CHANNEL,
  EMAIL_CONFIRMATION_STORAGE_KEY,
  type EmailConfirmationEvent,
} from "@/lib/auth/confirmation-events"
import { FORGOT_PASSWORD_GENERIC_MESSAGE } from "@/lib/auth/forgot-password-messages"
import { supabase } from "@/lib/supabase/client"
import {
  FIELD_LIMITS,
  meetsPasswordRequirements,
  onlyDigits,
  validateRegisterPayload,
} from "@/lib/validation/account-fields"
import { formatDeliveryAddress } from "@/lib/delivery-address"

function getSafeRedirect(redirect: string | null) {
  if (!redirect || redirect.startsWith("/login")) return "/"
  if (!redirect.startsWith("/")) return "/"
  return redirect
}

function Field({
  name,
  label,
  type,
  value,
  onChange,
  placeholder,
  maxLength,
  inputMode,
  autoComplete,
  showPasswordToggle,
  required = true,
  onFocus,
  onBlur,
}: {
  name: string
  label: string
  type: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  maxLength?: number
  inputMode?: InputHTMLAttributes<HTMLInputElement>["inputMode"]
  autoComplete?: string
  showPasswordToggle?: boolean
  required?: boolean
  onFocus?: () => void
  onBlur?: () => void
}) {
  const [passwordVisible, setPasswordVisible] = useState(false)
  const inputType = showPasswordToggle && type === "password" && passwordVisible
    ? "text"
    : type

  return (
    <div>
      <label htmlFor={name} className="mb-1.5 block text-xs font-semibold text-white/72">
        {label}
      </label>
      <div className="relative">
        <input
          id={name}
          name={name}
          type={inputType}
          aria-label={label}
          required={required}
          value={value}
          placeholder={placeholder}
          maxLength={maxLength}
          inputMode={inputMode}
          autoComplete={autoComplete}
          onFocus={onFocus}
          onBlur={onBlur}
          onChange={(e) => onChange(e.target.value)}
          className={`beyonix-login-input h-11 w-full rounded-xl border border-white/10 bg-[#0b1118] px-3.5 text-sm text-white outline-none transition-all placeholder:text-white/32 hover:border-beyonix-blue-light/45 focus:border-beyonix-sky/70 focus:ring-2 focus:ring-beyonix-blue-light/24 ${
            showPasswordToggle ? "pr-12" : ""
          }`}
        />
        {showPasswordToggle && type === "password" && (
          <button
            type="button"
            aria-label={passwordVisible ? "Ocultar contraseña" : "Mostrar contraseña"}
            onClick={() => setPasswordVisible((current) => !current)}
            className="absolute right-1.5 top-1/2 flex size-8 -translate-y-1/2 cursor-pointer items-center justify-center rounded-lg text-white/55 transition hover:bg-white/5 hover:text-white"
          >
            {passwordVisible ? (
              <EyeOff className="size-4" />
            ) : (
              <Eye className="size-4" />
            )}
          </button>
        )}
      </div>
    </div>
  )
}
function TextareaField({
  name,
  label,
  value,
  onChange,
  placeholder,
  maxLength,
}: {
  name: string
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  maxLength?: number
}) {
  return (
    <div className="md:col-span-2">
      <label htmlFor={name} className="mb-1.5 block text-xs font-semibold text-white/72">
        {label}
      </label>
      <textarea
        id={name}
        name={name}
        aria-label={label}
        value={value}
        placeholder={placeholder}
        maxLength={maxLength}
        onChange={(e) => onChange(e.target.value)}
        className="beyonix-login-textarea min-h-20 w-full resize-none rounded-xl border border-white/10 bg-[#0b1118] px-3.5 py-3 text-sm leading-5 text-white outline-none transition-all placeholder:text-white/32 hover:border-beyonix-blue-light/45 focus:border-beyonix-sky/70 focus:ring-2 focus:ring-beyonix-blue-light/24"
      />
    </div>
  )
}

function AuthTransitionScreen({ message }: { message: string }) {
  return (
    <div className="login-page flex min-h-screen flex-col text-white">
      <header className="login-light-scope relative z-20 border-b border-beyonix-blue-light/16 bg-black/72 backdrop-blur-xl">
        <nav className="container mx-auto px-4 lg:px-8">
          <div className="flex h-16 items-center justify-center lg:h-18">
            <BeyonixLogoLink />
          </div>
        </nav>
      </header>

      <main className="relative flex flex-1 items-center justify-center px-4">
        <div className="login-light-scope login-card relative z-10 flex w-full max-w-sm flex-col items-center rounded-3xl border border-beyonix-blue-light/24 bg-[linear-gradient(145deg,rgba(12,19,28,0.96),rgba(7,12,18,0.98))] px-6 py-9 text-center shadow-[0_28px_80px_rgba(0,0,0,0.48)]">
          <span className="flex size-12 items-center justify-center rounded-2xl border border-beyonix-sky/24 bg-beyonix-blue/42 text-beyonix-sky">
            <Loader2 className="size-6 animate-spin" />
          </span>
          <p className="mt-5 font-heading text-lg font-bold text-white">
            {message}
          </p>
          <p className="mt-2 text-sm leading-6 text-white/48">
            Estamos preparando tu experiencia BEYONIX.
          </p>
        </div>
      </main>
    </div>
  )
}

function LoginContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { login, register, user, isLoading } = useAuth()

  const [mode, setMode] = useState<"login" | "register">("login")
  const [username, setUsername] = useState("")
  const [name, setName] = useState("")
  const [dni, setDni] = useState("")
  const [identifier, setIdentifier] = useState("")
  const [email, setEmail] = useState("")
  const [street, setStreet] = useState("")
  const [streetNumber, setStreetNumber] = useState("")
  const [floor, setFloor] = useState("")
  const [apartment, setApartment] = useState("")
  const [locality, setLocality] = useState("")
  const [province, setProvince] = useState("")
  const [postalCode, setPostalCode] = useState("")
  const [phoneAreaCode, setPhoneAreaCode] = useState("")
  const [phone, setPhone] = useState("")
  const [password, setPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [passwordFocused, setPasswordFocused] = useState(false)
  const [references, setReferences] = useState("")
  const [error, setError] = useState("")
  const [success, setSuccess] = useState("")
  const [loading, setLoading] = useState(false)
  const [redirecting, setRedirecting] = useState(false)
  const [forgotPasswordLoading, setForgotPasswordLoading] = useState(false)
  const [forgotPasswordCooldown, setForgotPasswordCooldown] = useState(0)
  // Separado de `success` (que también sirve para "cuenta creada"/"email
  // confirmado"/"contraseña actualizada"): esta respuesta es deliberadamente
  // genérica por seguridad (nunca confirma que la cuenta existe), así que
  // necesita su propio título neutro ("Revisá tu correo") en vez del banner
  // de éxito compartido, que sonaría a confirmación de que se encontró la cuenta.
  const [forgotPasswordMessage, setForgotPasswordMessage] = useState("")
  const [confirmationEmail, setConfirmationEmail] = useState("")
  const [confirmationUserId, setConfirmationUserId] = useState("")
  const [confirmationHandoff, setConfirmationHandoff] = useState("")
  const [confirmationValidated, setConfirmationValidated] = useState(false)
  const [finishingConfirmation, setFinishingConfirmation] = useState(false)
  const [resendingEmail, setResendingEmail] = useState(false)
  const [resendMessage, setResendMessage] = useState("")
  const [resendCooldown, setResendCooldown] = useState(0)

  const redirect = getSafeRedirect(searchParams.get("redirect"))
  const verificationEmail = searchParams.get("verificar-email")
  const requestedMode = searchParams.get("mode")
  const confirmationPollInProgress = useRef(false)
  const confirmationCompletionStarted = useRef(false)
  const registerRedirectTimeout = useRef<number | null>(null)
  const redirectFallbackTimeout = useRef<number | null>(null)
  const navigationStarted = useRef(false)

  useEffect(() => {
    return () => {
      if (registerRedirectTimeout.current) {
        window.clearTimeout(registerRedirectTimeout.current)
      }
      if (redirectFallbackTimeout.current) {
        window.clearTimeout(redirectFallbackTimeout.current)
      }
    }
  }, [])

  useEffect(() => {
    router.prefetch(redirect)
  }, [redirect, router])

  const beginAuthenticatedRedirect = useCallback(() => {
    if (navigationStarted.current) return

    navigationStarted.current = true
    setRedirecting(true)
    router.replace(redirect)

    redirectFallbackTimeout.current = window.setTimeout(() => {
      if (window.location.pathname.startsWith("/login")) {
        window.location.replace(redirect)
      }
    }, 6_000)
  }, [redirect, router])

  useEffect(() => {
    if (searchParams.get("reset") !== "success") return

    setSuccess("Contraseña actualizada correctamente. Ya podés iniciar sesión.")
    router.replace("/login", { scroll: false })
  }, [router, searchParams])

  useEffect(() => {
    if (searchParams.get("auth-error") !== "confirmation") return

    setError(
      "El enlace de confirmación no es válido o ya fue utilizado. Solicitá un nuevo correo."
    )
    router.replace("/login", { scroll: false })
  }, [router, searchParams])

  useEffect(() => {
    if (searchParams.get("email-confirmed") !== "1") return

    setSuccess("Email confirmado correctamente. Ya podés iniciar sesión.")
    router.replace("/login", { scroll: false })
  }, [router, searchParams])

  useEffect(() => {
    const hashParams = new URLSearchParams(window.location.hash.slice(1))

    if (hashParams.get("error_code") !== "otp_expired") return

    setError(
      "El enlace de confirmación venció o ya fue utilizado. Solicitá un correo nuevo."
    )
    window.history.replaceState(null, "", "/login")
  }, [])

  useEffect(() => {
    if (!verificationEmail?.includes("@")) return

    const normalizedEmail = verificationEmail.trim().toLowerCase()
    setConfirmationEmail(normalizedEmail)
    setResendMessage("")
    setMode("login")
    setError("")
    setSuccess("")
  }, [verificationEmail])

  useEffect(() => {
    if (verificationEmail) return
    if (requestedMode !== "register") return

    setMode("register")
    setError("")
    setSuccess("")
  }, [requestedMode, verificationEmail])

  useEffect(() => {
    if (resendCooldown <= 0) return

    const timeout = window.setTimeout(() => {
      setResendCooldown((current) => Math.max(0, current - 1))
    }, 1000)

    return () => window.clearTimeout(timeout)
  }, [resendCooldown])

  useEffect(() => {
    if (forgotPasswordCooldown <= 0) return

    const timeout = window.setTimeout(() => {
      setForgotPasswordCooldown((current) => Math.max(0, current - 1))
    }, 1000)

    return () => window.clearTimeout(timeout)
  }, [forgotPasswordCooldown])

  useEffect(() => {
    if (
      !confirmationEmail ||
      !confirmationUserId ||
      !confirmationHandoff
    ) {
      return
    }

    let cancelled = false
    let timeout: number | undefined
    let channel: BroadcastChannel | null = null

    const isExpectedConfirmation = (
      value: unknown
    ): value is EmailConfirmationEvent => {
      if (!value || typeof value !== "object") return false

      const event = value as Partial<EmailConfirmationEvent>

      return (
        event.userId === confirmationUserId &&
        event.email?.trim().toLowerCase() === confirmationEmail
      )
    }

    const checkConfirmation = async () => {
      if (cancelled || confirmationPollInProgress.current) return

      confirmationPollInProgress.current = true

      try {
        const response = await fetch("/api/auth/confirmation-status", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            userId: confirmationUserId,
            handoff: confirmationHandoff,
          }),
          cache: "no-store",
        })
        const data = (await response.json()) as {
          confirmed?: boolean
          tokenHash?: string
          error?: string
        }

        if (!cancelled && response.ok && data.confirmed) {
          setConfirmationValidated(true)

          if (!data.tokenHash) {
            setResendMessage(
              data.error ||
                "Cuenta confirmada. Estamos preparando tu sesión..."
            )
            return
          }

          if (confirmationCompletionStarted.current) return

          confirmationCompletionStarted.current = true
          setFinishingConfirmation(true)
          setResendMessage("Email confirmado. Iniciando sesión...")

          localStorage.setItem(
            "beyonix-auth-last-activity",
            String(Date.now())
          )
          const { error: sessionError } = await supabase.auth.verifyOtp({
            token_hash: data.tokenHash,
            type: "magiclink",
          })

          if (cancelled) return

          if (!sessionError) {
            localStorage.removeItem(EMAIL_CONFIRMATION_STORAGE_KEY)
            setResendMessage(
              "Email confirmado. Te llevaremos al Home en un segundo..."
            )
            timeout = window.setTimeout(() => {
              window.location.assign(redirect)
            }, 1000)
            return
          }

          confirmationCompletionStarted.current = false
          setFinishingConfirmation(false)
          setResendMessage(
            "La cuenta fue confirmada, pero no pudimos iniciar sesión automáticamente."
          )
        } else if (!cancelled && !response.ok && data.error) {
          setResendMessage(data.error)
        }
      } catch {
        // La pestaña seguirá consultando mientras permanezca abierta.
      } finally {
        confirmationPollInProgress.current = false
      }

      if (!cancelled && !confirmationCompletionStarted.current) {
        timeout = window.setTimeout(checkConfirmation, 1000)
      }
    }

    const handleBroadcast = (event: MessageEvent<unknown>) => {
      if (isExpectedConfirmation(event.data)) {
        void checkConfirmation()
      }
    }
    const handleStorage = (event: StorageEvent) => {
      if (
        event.key !== EMAIL_CONFIRMATION_STORAGE_KEY ||
        !event.newValue
      ) {
        return
      }

      try {
        const confirmationEvent = JSON.parse(event.newValue) as unknown

        if (isExpectedConfirmation(confirmationEvent)) {
          void checkConfirmation()
        }
      } catch {
        // El sondeo periódico queda como respaldo.
      }
    }

    if ("BroadcastChannel" in window) {
      channel = new BroadcastChannel(EMAIL_CONFIRMATION_CHANNEL)
      channel.addEventListener("message", handleBroadcast)
    }
    window.addEventListener("storage", handleStorage)

    void checkConfirmation()

    return () => {
      cancelled = true
      if (timeout) window.clearTimeout(timeout)
      channel?.removeEventListener("message", handleBroadcast)
      channel?.close()
      window.removeEventListener("storage", handleStorage)
    }
  }, [
    confirmationEmail,
    confirmationHandoff,
    confirmationUserId,
    redirect,
  ])

  useEffect(() => {
    if (isLoading || !user || confirmationEmail) return
    beginAuthenticatedRedirect()
  }, [
    beginAuthenticatedRedirect,
    confirmationEmail,
    isLoading,
    user,
  ])

  if (isLoading) {
    return <AuthTransitionScreen message="Verificando tu sesión" />
  }

  if (redirecting || user) {
    return <AuthTransitionScreen message="Ingreso confirmado" />
  }

  const handleModeChange = (nextMode: "login" | "register") => {
    setMode(nextMode)
    setError("")
    setSuccess("")
    setForgotPasswordMessage("")
    setConfirmationEmail("")
    setConfirmationUserId("")
    setConfirmationHandoff("")
    setConfirmationValidated(false)
    setFinishingConfirmation(false)
    setRedirecting(false)
    navigationStarted.current = false
    confirmationCompletionStarted.current = false
    if (registerRedirectTimeout.current) {
      window.clearTimeout(registerRedirectTimeout.current)
      registerRedirectTimeout.current = null
    }
  }

  const getRegisterDeliveryAddress = () => {
    const hasDeliveryData = [
      street,
      streetNumber,
      floor,
      apartment,
      locality,
      province,
      postalCode,
    ].some((value) => value.trim())

    if (!hasDeliveryData) return ""

    return street.trim() && streetNumber.trim()
      ? formatDeliveryAddress({
          street,
          streetNumber,
          floor,
          apartment,
          locality,
          region: province,
          postalCode,
        })
      : [
          street.trim(),
          streetNumber.trim(),
          floor.trim() ? `Piso ${floor.trim()}` : "",
          apartment.trim() ? `Depto ${apartment.trim().toLocaleUpperCase("es-AR")}` : "",
          locality.trim(),
          province.trim(),
          postalCode.trim() ? `CP ${postalCode.trim()}` : "",
        ]
          .filter(Boolean)
          .join(", ")
  }

  const registerDeliveryAddress = getRegisterDeliveryAddress()
  const registerMobilePhone = `${phoneAreaCode}${phone}`
  const registerValidationError =
    mode === "register"
      ? validateRegisterPayload({
          username,
          name,
          email,
          dni,
          address: registerDeliveryAddress,
          street,
          streetNumber,
          locality,
          province,
          postalCode,
          phone: registerMobilePhone,
          password,
          references,
        })
      : ""
  const isRegisterReady =
    mode === "register" &&
    !registerValidationError &&
    password === confirmPassword

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError("")
    setSuccess("")
    setForgotPasswordMessage("")
    setLoading(true)

    if (mode === "login") {
      navigationStarted.current = true
      const result = await login(identifier, password)
      setLoading(false)

      if (!result.ok) {
        navigationStarted.current = false
        setError(result.error || "Error al iniciar sesión")
        return
      }

      navigationStarted.current = false
      beginAuthenticatedRedirect()
      return
    }

    if (!meetsPasswordRequirements(password)) {
      setLoading(false)
      setError("La contraseña no cumple los requisitos.")
      return
    }

    if (password !== confirmPassword) {
      setLoading(false)
      setError("Las contraseñas no coinciden.")
      return
    }

    const validationError = validateRegisterPayload({
      username,
      name,
      email,
      dni,
      address: registerDeliveryAddress,
      street,
      streetNumber,
      locality,
      province,
      postalCode,
      phone: registerMobilePhone,
      password,
      references,
    })

    if (validationError) {
      setLoading(false)
      setError(validationError)
      return
    }

    const result = await register({
      username,
      name,
      email,
      dni,
      password,
      address: registerDeliveryAddress,
      street,
      streetNumber,
      floor,
      apartment: apartment.trim().toLocaleUpperCase("es-AR"),
      locality,
      postalCode,
      phone: registerMobilePhone,
      province,
      references,
    })

    setLoading(false)

    if (!result.ok) {
      setError(result.error || "Error al crear cuenta")
      return
    }

    if (result.requiresConfirmation) {
      const normalizedEmail = email.trim().toLowerCase()

      setSuccess("Cuenta creada con éxito!")
      registerRedirectTimeout.current = window.setTimeout(() => {
        setConfirmationEmail(normalizedEmail)
        setConfirmationUserId(result.pendingUserId ?? "")
        setConfirmationHandoff(result.confirmationHandoff ?? "")
        setConfirmationValidated(false)
        confirmationCompletionStarted.current = false
        setMode("login")
        window.history.replaceState(
          null,
          "",
          `/login?verificar-email=${encodeURIComponent(normalizedEmail)}`
        )
        registerRedirectTimeout.current = null
      }, 900)
      return
    }

    setSuccess("Cuenta creada con éxito!")
    registerRedirectTimeout.current = window.setTimeout(() => {
      router.replace(redirect)
      registerRedirectTimeout.current = null
    }, 900)
  }

  const handleForgotPassword = async () => {
    const recoveryIdentifier = identifier.trim()

    if (!recoveryIdentifier) {
      setError("Ingresá tu usuario o email para recuperar la contraseña.")
      return
    }

    if (forgotPasswordLoading || forgotPasswordCooldown > 0) return

    setError("")
    setSuccess("")
    setForgotPasswordMessage("")
    setForgotPasswordLoading(true)

    try {
      const response = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: recoveryIdentifier }),
      })
      const data = (await response.json().catch(() => null)) as
        | { message?: string; error?: string }
        | null

      // Sólo un formato de entrada inválido devuelve un error puntual acá
      // (nunca "no existe"): el servidor responde siempre el mismo mensaje
      // exista o no la cuenta -- ver lib/auth/forgot-password.ts.
      if (!response.ok) {
        setError(data?.error || FORGOT_PASSWORD_GENERIC_MESSAGE)
        return
      }

      setForgotPasswordMessage(data?.message || FORGOT_PASSWORD_GENERIC_MESSAGE)
      setForgotPasswordCooldown(30)
    } catch {
      setError("No pudimos procesar la solicitud. Intentá nuevamente.")
    } finally {
      setForgotPasswordLoading(false)
    }
  }

  const handleResendConfirmation = async () => {
    if (!confirmationEmail || resendingEmail || resendCooldown > 0) return

    setResendingEmail(true)
    setResendMessage("")

    const { error: resendError } = await supabase.auth.resend({
      type: "signup",
      email: confirmationEmail,
      options: {
        emailRedirectTo: window.location.origin,
      },
    })

    setResendingEmail(false)

    if (resendError) {
      setResendMessage(
        resendError.status === 429
          ? "Esperá unos minutos antes de volver a intentarlo."
          : "No pudimos reenviar el correo de confirmación."
      )
      return
    }

    setResendCooldown(60)
    setResendMessage("Correo reenviado. Puede demorar unos minutos en llegar.")
  }

  return (
    <div className="login-page flex min-h-screen flex-col text-white">
      <header className="login-light-scope relative z-20 border-b border-beyonix-blue-light/16 bg-black/72 backdrop-blur-xl">
        <nav className="container mx-auto px-4 lg:px-8">
          <div className="flex h-16 items-center justify-between lg:h-18">
            <BeyonixLogoLink />
            <Link
              href="/"
              className="group inline-flex h-10 items-center gap-2 rounded-xl border border-white/8 bg-white/[0.03] px-3.5 text-xs font-semibold text-white/62 transition hover:border-beyonix-blue-light/36 hover:bg-beyonix-blue/16 hover:text-white sm:text-sm"
            >
              <ArrowLeft className="size-4 transition-transform group-hover:-translate-x-0.5" />
              <span className="hidden sm:inline">Volver a la tienda</span>
              <span className="sm:hidden">Volver</span>
            </Link>
          </div>
        </nav>
      </header>

      <main
        className={`relative flex flex-1 justify-center overflow-hidden px-4 sm:px-6 lg:px-8 ${
          mode === "register"
            ? "beyonix-register-main items-start py-4 sm:py-5 lg:py-6"
            : "items-center py-8 lg:py-12"
        }`}
      >
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_18%_24%,rgba(30,77,123,0.2),transparent_33%),radial-gradient(circle_at_84%_72%,rgba(74,144,184,0.08),transparent_28%)]"
        />
        {confirmationEmail ? (
          <div className="login-light-scope login-card relative z-10 w-full max-w-lg overflow-hidden rounded-3xl border border-beyonix-blue-light/26 bg-[linear-gradient(145deg,rgba(12,22,33,0.98),rgba(5,10,16,0.98))] p-6 text-center shadow-[0_30px_90px_rgba(0,0,0,0.5)] sm:p-9">
            <div className="pointer-events-none absolute inset-x-12 top-0 h-px bg-gradient-to-r from-transparent via-beyonix-sky/70 to-transparent" />
            <div className="mx-auto flex size-16 items-center justify-center rounded-2xl border border-emerald-400/25 bg-emerald-500/10 shadow-[0_0_28px_rgba(52,211,153,0.1)]">
              <CheckCircle2 className="size-10 text-emerald-400" strokeWidth={2.25} />
            </div>

            <h1 className="mt-5 text-2xl font-bold text-white sm:text-3xl">
              {confirmationValidated
                ? "Cuenta confirmada"
                : "Usuario creado con éxito"}
            </h1>

            <p className="mt-3 text-sm leading-6 text-white/68">
              {confirmationValidated
                ? "Estamos iniciando tu sesión y te llevaremos al Home automáticamente."
                : "Te enviamos un correo de confirmación. Revisá tu email para activar la cuenta."}
            </p>

            {!confirmationValidated && (
              <>
                <p className="login-light-scope mt-2 rounded-xl border border-white/8 bg-black px-4 py-3 text-sm font-semibold text-white">
                  {confirmationEmail}
                </p>

                <p className="mt-4 text-sm leading-6 text-white/58">
                  Para verificar la cuenta y poder comprar en nuestra tienda,
                  tenés que abrir el correo de confirmación y validar tu email.
                </p>

                <p className="mt-3 text-xs leading-5 text-emerald-300/75">
                  Dejá esta pestaña abierta. Cuando confirmes el correo,
                  iniciaremos tu sesión automáticamente y te llevaremos al
                  inicio.
                </p>

                <p className="mt-3 text-xs leading-5 text-white/42">
                  Si no lo encontrás, revisá spam, promociones o correo no
                  deseado.
                </p>

                <button
                  type="button"
                  onClick={handleResendConfirmation}
                  disabled={resendingEmail || resendCooldown > 0}
                  className="mt-5 flex h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-xl border border-white/12 bg-white/5 text-sm font-semibold text-white transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {resendingEmail ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <RefreshCw className="size-4" />
                  )}
                  {resendingEmail
                    ? "Reenviando..."
                    : resendCooldown > 0
                      ? `Reenviar en ${resendCooldown}s`
                      : "Reenviar correo de confirmación"}
                </button>
              </>
            )}

            {resendMessage && (
              <p
                role="status"
                className={`mt-3 text-xs leading-5 ${
                  resendMessage.startsWith("Correo reenviado") ||
                  resendMessage.startsWith("Email confirmado")
                    ? "text-emerald-400"
                    : "text-red-400"
                }`}
              >
                {resendMessage}
              </p>
            )}

            <button
              type="button"
              aria-label="Volver al inicio de sesión"
              disabled={finishingConfirmation}
              onClick={() => {
                setConfirmationEmail("")
                setConfirmationUserId("")
                setConfirmationHandoff("")
                setConfirmationValidated(false)
                setFinishingConfirmation(false)
                confirmationCompletionStarted.current = false
                setMode("login")
                router.replace("/login", { scroll: false })
              }}
              className="mt-3 flex h-11 w-full cursor-pointer items-center justify-center rounded-xl bg-white text-sm font-semibold text-black transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Volver al inicio de sesión
            </button>
          </div>
        ) : (
          <div
            className={`login-card relative z-10 grid min-w-0 w-full overflow-hidden rounded-3xl border border-beyonix-blue-light/28 bg-[#070c12]/96 shadow-[0_34px_100px_rgba(0,0,0,0.56)] backdrop-blur-xl ${
              mode === "login"
                ? "max-w-6xl lg:grid-cols-[minmax(20rem,0.9fr)_minmax(28rem,1.1fr)]"
                : "max-w-6xl lg:grid-cols-[22rem_minmax(0,1fr)]"
            }`}
          >
            <aside className="relative hidden overflow-hidden border-r border-beyonix-blue-light/18 bg-[linear-gradient(155deg,rgba(17,42,67,0.96)_0%,rgba(8,21,34,0.98)_46%,rgba(4,10,16,1)_100%)] p-8 lg:flex lg:flex-col xl:p-10">
              <div
                aria-hidden="true"
                className="pointer-events-none absolute -left-28 top-10 size-72 rounded-full border border-beyonix-sky/10"
              />
              <div
                aria-hidden="true"
                className="pointer-events-none absolute -left-14 top-24 size-48 rounded-full border border-beyonix-sky/10"
              />
              <div className="relative">
                <span className="beyonix-login-hero-badge inline-flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.2em] text-beyonix-sky">
                  <Sparkles className="size-3.5" />
                  Experiencia BEYONIX
                </span>
                <p
                  className={`mt-5 max-w-md font-heading font-bold leading-[1.12] tracking-tight text-white ${
                    mode === "login" ? "text-3xl xl:text-4xl" : "text-3xl"
                  }`}
                >
                  {mode === "login"
                    ? "Tecnología para tu comodidad, en un solo lugar."
                    : "Tu experiencia BEYONIX empieza acá."}
                </p>
                <p className="mt-4 max-w-sm text-sm leading-6 text-white/58">
                  {mode === "login"
                    ? "Ingresá para continuar tu compra, revisar pedidos y gestionar tus datos con tranquilidad."
                    : "Creá tu cuenta para comprar más rápido y acompañar cada pedido de principio a fin."}
                </p>
              </div>

              <div
                className={`relative space-y-3 ${
                  mode === "login" ? "mt-10 xl:mt-12" : "mt-10"
                }`}
              >
                {[
                  {
                    icon: ShieldCheck,
                    title: "Compra protegida",
                    text: "Tus datos y operaciones, siempre seguros.",
                  },
                  {
                    icon: PackageCheck,
                    title: "Seguimiento simple",
                    text: "Revisá el estado de tus pedidos cuando quieras.",
                  },
                  {
                    icon: BadgeCheck,
                    title: "Atención personalizada",
                    text: "Estamos para ayudarte antes y después de comprar.",
                  },
                ].map((item) => {
                  const Icon = item.icon

                  return (
                    <div
                      key={item.title}
                      className="flex items-center gap-3 rounded-2xl border border-white/8 bg-white/[0.035] p-3.5"
                    >
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-beyonix-sky/20 bg-beyonix-blue-light/20 text-white">
                        <Icon className="size-4.5" />
                      </span>
                      <div>
                        <p className="text-sm font-semibold text-white">
                          {item.title}
                        </p>
                        <p className="mt-0.5 text-[11px] leading-4 text-white/46">
                          {item.text}
                        </p>
                      </div>
                    </div>
                  )
                })}
              </div>

              {mode === "register" && (
                <div className="relative mt-auto pt-8">
                  <div className="flex items-center gap-3 border-t border-white/8 pt-5">
                    <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-beyonix-sky/22 bg-beyonix-blue-light/18 text-white">
                      <UserRoundPlus className="size-5" />
                    </span>
                    <div>
                      <p className="text-sm font-semibold text-white">
                        Una cuenta, todo más simple
                      </p>
                      <p className="mt-1 text-[11px] leading-4 text-white/46">
                        Comprá, seguí tus pedidos y gestioná tus datos desde un
                        solo lugar.
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </aside>

            <section
              className={`login-light-scope relative min-w-0 bg-[linear-gradient(145deg,rgba(12,19,28,0.98),rgba(7,12,18,0.99))] ${
                mode === "login"
                  ? "p-5 sm:p-8 lg:p-10 xl:p-12"
                  : "p-4 sm:p-5 lg:px-6 lg:py-4"
              }`}
            >
              <div className="pointer-events-none absolute inset-x-10 top-0 h-px bg-gradient-to-r from-transparent via-beyonix-sky/55 to-transparent" />

              <div className={`min-w-0 ${mode === "login" ? "mx-auto max-w-md" : ""}`}>
                <div
                  className={`grid grid-cols-2 rounded-2xl border border-beyonix-blue-light/20 bg-black/24 p-1.5 ${
                    mode === "login" ? "mb-7" : "mb-4"
                  }`}
                >
                  <button
                    type="button"
                    aria-label="Iniciar sesión"
                    onClick={() => handleModeChange("login")}
                    className={`flex h-10 min-w-0 cursor-pointer items-center justify-center gap-1.5 rounded-xl px-2 text-xs font-semibold transition-all sm:gap-2 sm:px-4 sm:text-sm ${
                      mode === "login"
                        ? "border border-beyonix-blue-light/52 bg-beyonix-blue text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_8px_24px_rgba(0,0,0,0.24)]"
                        : "text-white/48 hover:bg-white/[0.04] hover:text-white/82"
                    }`}
                  >
                    <LockKeyhole className="size-4" />
                    Iniciar sesión
                  </button>

                  <button
                    type="button"
                    aria-label="Registrarme"
                    onClick={() => handleModeChange("register")}
                    className={`flex h-10 min-w-0 cursor-pointer items-center justify-center gap-1.5 rounded-xl px-2 text-xs font-semibold transition-all sm:gap-2 sm:px-4 sm:text-sm ${
                      mode === "register"
                        ? "border border-beyonix-blue-light/52 bg-beyonix-blue text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_8px_24px_rgba(0,0,0,0.24)]"
                        : "text-white/48 hover:bg-white/[0.04] hover:text-white/82"
                    }`}
                  >
                    <UserRoundPlus className="size-4" />
                    Registrarme
                  </button>
                </div>

                <div className={mode === "login" ? "mb-7" : "mb-4"}>
                  <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-beyonix-cyan">
                    {mode === "login" ? "Qué bueno verte de nuevo" : "Creá tu perfil"}
                  </p>
                  <h1 className="mt-2 font-heading text-2xl font-bold tracking-tight text-white sm:text-3xl">
                    {mode === "login" ? "Iniciar sesión" : "Crear cuenta"}
                  </h1>
                  <p className="mt-2 text-sm leading-6 text-white/52">
                    {mode === "login"
                      ? "Accedé a tu cuenta para continuar donde lo dejaste."
                      : "Completá tus datos una sola vez y disfrutá una compra más ágil."}
                  </p>
                </div>

                <form
          key={mode}
          onSubmit={handleSubmit}
          autoComplete="on"
          className={mode === "register" ? "beyonix-register-form space-y-3" : "space-y-5"}
        >
          {mode === "register" && (
            <>
              <fieldset className="rounded-2xl border border-white/8 bg-black/18 p-3 sm:p-4">
                <legend className="px-2 text-[11px] font-bold uppercase tracking-[0.16em] text-beyonix-sky">
                  01 · Datos de acceso
                </legend>
                <div className="grid gap-2.5 md:grid-cols-2">
                  <Field name="username" label="Usuario*" type="text" value={username} onChange={setUsername} placeholder="usuario.tech" maxLength={FIELD_LIMITS.username} autoComplete="username" />
                  <Field name="email" label="Email*" type="email" value={email} onChange={setEmail} placeholder="nombre@email.com" maxLength={FIELD_LIMITS.email} autoComplete="email" />
                  <div className="relative">
                    <Field
                      name="password"
                      label="Contraseña*"
                      type="password"
                      value={password}
                      onChange={setPassword}
                      placeholder="Creá una contraseña segura"
                      maxLength={FIELD_LIMITS.password}
                      autoComplete="new-password"
                      showPasswordToggle
                      onFocus={() => setPasswordFocused(true)}
                      onBlur={() => setPasswordFocused(false)}
                    />
                    {passwordFocused && (
                      <div className="absolute left-0 top-[calc(100%+0.35rem)] z-30 w-full">
                        <PasswordRequirements password={password} />
                      </div>
                    )}
                  </div>
                  <Field name="confirm-password" label="Confirmar contraseña*" type="password" value={confirmPassword} onChange={setConfirmPassword} placeholder="Repetí la contraseña" maxLength={FIELD_LIMITS.password} autoComplete="new-password" showPasswordToggle />
                </div>
              </fieldset>

              <fieldset className="rounded-2xl border border-white/8 bg-black/18 p-3 sm:p-4">
                <legend className="px-2 text-[11px] font-bold uppercase tracking-[0.16em] text-beyonix-sky">
                  02 · Datos personales
                </legend>
                <div className="grid gap-2.5 md:grid-cols-2">
                  <Field name="name" label="Nombre y apellido*" type="text" value={name} onChange={setName} placeholder="Nombre Apellido" maxLength={FIELD_LIMITS.name} autoComplete="name" />
                  <Field name="dni" label="DNI*" type="tel" value={dni} onChange={(value) => setDni(onlyDigits(value, FIELD_LIMITS.dni))} placeholder="12345678" maxLength={FIELD_LIMITS.dni} inputMode="numeric" autoComplete="off" />
                </div>
              </fieldset>

              <fieldset className="rounded-2xl border border-white/8 bg-black/18 p-3 sm:p-4">
                <legend className="px-2 text-[11px] font-bold uppercase tracking-[0.16em] text-beyonix-sky">
                  03 · Datos de entrega
                </legend>
                <div className="space-y-2.5">
                  <div className="grid gap-2.5 md:grid-cols-2">
                    <Field name="street" label="Calle*" type="text" value={street} onChange={setStreet} placeholder="San Martín" maxLength={FIELD_LIMITS.street} autoComplete="address-line1" />
                    <div className="grid grid-cols-[minmax(5.5rem,1fr)_minmax(4.5rem,0.7fr)_minmax(4.5rem,0.7fr)] gap-2.5">
                      <Field name="street-number" label="Número*" type="tel" value={streetNumber} onChange={(value) => setStreetNumber(onlyDigits(value, 8))} placeholder="1234" maxLength={8} inputMode="numeric" autoComplete="address-line2" />
                      <Field name="floor" label="Piso" type="text" value={floor} onChange={setFloor} placeholder="3" maxLength={12} autoComplete="off" required={false} />
                      <Field name="apartment" label="DPTO" type="text" value={apartment} onChange={(value) => setApartment(value.toLocaleUpperCase("es-AR"))} placeholder="B" maxLength={12} autoComplete="off" required={false} />
                    </div>
                  </div>
                  <div className="grid gap-2.5 md:grid-cols-2">
                    <div>
                      <label className="mb-1.5 block text-xs font-semibold text-white/72">
                        Provincia*
                      </label>
                      <ProvinceSelect value={province} onChange={setProvince} compact appearance="login" />
                    </div>
                    <Field name="locality" label="Localidad*" type="text" value={locality} onChange={setLocality} placeholder="Rosario" maxLength={60} autoComplete="address-level2" required />
                  </div>
                  <div className="grid gap-2.5 md:grid-cols-2">
                    <Field name="postal-code" label="Código postal*" type="tel" value={postalCode} onChange={(value) => setPostalCode(onlyDigits(value, FIELD_LIMITS.postalCode))} placeholder="2000" maxLength={FIELD_LIMITS.postalCode} inputMode="numeric" autoComplete="postal-code" required />
                    <div>
                      <label className="mb-1.5 block text-xs font-semibold text-white/72">
                        Teléfono móvil*
                      </label>
                      <div className="grid grid-cols-[5rem_minmax(0,1fr)] gap-2">
                        <input
                          id="phone-area-code"
                          name="phone-area-code"
                          type="tel"
                          aria-label="Característica"
                          required
                          value={phoneAreaCode}
                          placeholder="341"
                          maxLength={4}
                          inputMode="numeric"
                          autoComplete="tel-area-code"
                          onChange={(event) => setPhoneAreaCode(onlyDigits(event.target.value, 4))}
                          className="beyonix-login-input h-11 w-full rounded-xl border border-white/10 bg-[#0b1118] px-3.5 text-sm text-white outline-none transition-all placeholder:text-white/32 hover:border-beyonix-blue-light/45 focus:border-beyonix-sky/70 focus:ring-2 focus:ring-beyonix-blue-light/24"
                        />
                        <input
                          id="phone"
                          name="phone"
                          type="tel"
                          aria-label="Teléfono móvil"
                          required
                          value={phone}
                          placeholder="6000000"
                          maxLength={11}
                          inputMode="numeric"
                          autoComplete="tel-national"
                          onChange={(event) => setPhone(onlyDigits(event.target.value, 11))}
                          className="beyonix-login-input h-11 w-full rounded-xl border border-white/10 bg-[#0b1118] px-3.5 text-sm text-white outline-none transition-all placeholder:text-white/32 hover:border-beyonix-blue-light/45 focus:border-beyonix-sky/70 focus:ring-2 focus:ring-beyonix-blue-light/24"
                        />
                      </div>
                      <p className="mt-1 text-[11px] leading-4 text-white/48">
                        Ingresá la característica y el número sin 0 ni 15.
                      </p>
                    </div>
                  </div>
                  <TextareaField name="references" label="Referencias para llegar (máximo 80 caracteres)" value={references} onChange={setReferences} placeholder="Fachada blanca, portón negro, antes de llegar a la esquina." maxLength={80} />
                </div>
              </fieldset>
            </>
          )}

          {mode === "login" && (
            <>
              <Field name="username" label="Email o usuario" type="text" value={identifier} onChange={setIdentifier} placeholder="usuario.tech o nombre@email.com" maxLength={FIELD_LIMITS.loginIdentifier} autoComplete="username" />
              <Field name="password" label="Contraseña" type="password" value={password} onChange={setPassword} placeholder="Contraseña" maxLength={FIELD_LIMITS.password} autoComplete="current-password" showPasswordToggle />
            </>
          )}

          {mode === "login" && (
            <div className="flex justify-end">
              <button
                type="button"
                aria-label="Olvidé mi contraseña"
                onClick={handleForgotPassword}
                disabled={forgotPasswordLoading || forgotPasswordCooldown > 0}
                className="beyonix-login-forgot-link cursor-pointer text-sm font-semibold text-beyonix-sky transition-colors hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
              >
                {forgotPasswordLoading
                  ? "Enviando..."
                  : forgotPasswordCooldown > 0
                    ? `Reintentar en ${forgotPasswordCooldown}s`
                    : "¿Olvidaste tu contraseña?"}
              </button>
            </div>
          )}

          {error && (
            <div className="rounded-xl border border-[var(--account-danger-border)] bg-[var(--account-danger-bg)] px-4 py-3 text-sm font-medium text-[var(--account-danger-text)] md:col-span-2">
              {error}
            </div>
          )}

          {success && (
            <div className="rounded-xl border border-[var(--account-success-border)] bg-[var(--account-success-bg)] px-4 py-3 text-sm font-medium text-[var(--account-success-text)] md:col-span-2">
              {success}
            </div>
          )}

          {/*
            Respuesta de "olvidé mi contraseña": deliberadamente genérica
            (nunca confirma que la cuenta existe -- ver
            lib/auth/forgot-password.ts), así que usa un título neutro
            ("Revisá tu correo") en vez del banner de éxito de arriba, que
            sonaría a "encontramos tu cuenta". Mismos tokens semánticos
            --account-success-* (ya con contraste correcto en ambos temas),
            con más padding/jerarquía por el ícono + título.
          */}
          {forgotPasswordMessage && (
            <div className="flex items-start gap-3 rounded-xl border border-[var(--account-success-border)] bg-[var(--account-success-bg)] px-4 py-3.5 md:col-span-2">
              <MailCheck className="mt-0.5 size-5 shrink-0 text-[var(--account-success-text)]" />
              <div>
                <p className="text-sm font-bold text-[var(--account-success-text)]">
                  Revisá tu correo
                </p>
                <p className="mt-1 text-sm leading-5 text-[var(--account-success-text)]">
                  {forgotPasswordMessage}
                </p>
              </div>
            </div>
          )}

          <div className={mode === "register" ? "flex justify-center" : ""}>
            <button
              type="submit"
              aria-label={mode === "login" ? "Ingresar" : "Crear cuenta"}
              disabled={loading}
              className={`flex cursor-pointer items-center justify-center gap-2 rounded-xl border px-10 font-heading text-sm font-semibold text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_14px_34px_rgba(0,0,0,0.35)] transition-all hover:-translate-y-0.5 focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-50 ${
                mode === "login" ? "w-full" : "w-full sm:max-w-xs"
              } ${mode === "login" ? "h-12" : "h-11"} ${
                isRegisterReady
                  ? "border-emerald-400/55 bg-emerald-600 text-white hover:border-emerald-300/75 hover:bg-emerald-500 focus-visible:ring-emerald-300/25"
                  : "border-beyonix-blue-light/48 bg-beyonix-blue text-white hover:border-beyonix-blue-light/75 hover:bg-beyonix-blue-hover focus-visible:ring-beyonix-blue-light/25"
              }`}
            >
              {loading ? (
                <Loader2 className="size-5 animate-spin" />
              ) : mode === "login" ? (
                "Ingresar"
              ) : isRegisterReady ? (
                <>
                  <Check className="size-4 stroke-[2.6]" />
                  Crear cuenta
                </>
              ) : (
                "Crear cuenta"
              )}
            </button>
          </div>
                </form>
                {mode === "login" && (
                  <div className="beyonix-login-secure-note mt-6 flex items-center justify-center gap-2 border-t border-white/8 pt-5 text-xs text-white/38">
                    <ShieldCheck className="size-4 text-beyonix-cyan" />
                    Acceso seguro. Tus datos están protegidos.
                  </div>
                )}
              </div>
            </section>
          </div>
        )}
      </main>
    </div>
  )
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginContent />
    </Suspense>
  )
}
