"use client"
// @refresh reset

import { Suspense, useEffect, useRef, useState } from "react"
import type { InputHTMLAttributes } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { CheckCircle2, Eye, EyeOff, Loader2, RefreshCw } from "lucide-react"

import { BeyonixLogoLink } from "@/components/beyonix-logo-link"
import { PasswordRequirements } from "@/components/password-requirements"
import { ProvinceSelect } from "@/components/province-select"
import { useAuth } from "@/context/auth-context"
import {
  EMAIL_CONFIRMATION_CHANNEL,
  EMAIL_CONFIRMATION_STORAGE_KEY,
  type EmailConfirmationEvent,
} from "@/lib/auth/confirmation-events"
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
      <label htmlFor={name} className="mb-1 block text-xs font-medium text-white/78">
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
          className={`beyonix-login-input h-10 w-full rounded-lg border border-white/10 bg-[#1b1f24] px-3 text-sm text-white outline-none transition-all placeholder:text-white/42 hover:border-beyonix-blue-light/45 focus:border-beyonix-sky/70 focus:ring-2 focus:ring-beyonix-blue-light/24 ${
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
      <label htmlFor={name} className="mb-1 block text-xs font-medium text-white/78">
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
        className="min-h-14 w-full resize-none rounded-lg border border-white/10 bg-[#1b1f24] px-3 py-2 text-sm leading-5 text-white outline-none transition-all placeholder:text-white/42 hover:border-beyonix-blue-light/45 focus:border-beyonix-sky/70 focus:ring-2 focus:ring-beyonix-blue-light/24"
      />
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

  useEffect(() => {
    return () => {
      if (registerRedirectTimeout.current) {
        window.clearTimeout(registerRedirectTimeout.current)
      }
    }
  }, [])

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
    router.replace(redirect)
  }, [confirmationEmail, isLoading, redirect, router, user])

  if (isLoading || user) return null

  const handleModeChange = (nextMode: "login" | "register") => {
    setMode(nextMode)
    setError("")
    setSuccess("")
    setConfirmationEmail("")
    setConfirmationUserId("")
    setConfirmationHandoff("")
    setConfirmationValidated(false)
    setFinishingConfirmation(false)
    confirmationCompletionStarted.current = false
    if (registerRedirectTimeout.current) {
      window.clearTimeout(registerRedirectTimeout.current)
      registerRedirectTimeout.current = null
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError("")
    setSuccess("")
    setLoading(true)

    if (mode === "login") {
      const result = await login(identifier, password)
      setLoading(false)

      if (!result.ok) {
        setError(result.error || "Error al iniciar sesión")
        return
      }

      router.replace(redirect)
      return
    }

    const hasDeliveryData = [
      street,
      streetNumber,
      floor,
      apartment,
      locality,
      province,
      postalCode,
    ].some((value) => value.trim())
    const deliveryAddress = hasDeliveryData
      ? street.trim() && streetNumber.trim()
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
            apartment.trim() ? `Depto ${apartment.trim()}` : "",
            locality.trim(),
            province.trim(),
            postalCode.trim() ? `CP ${postalCode.trim()}` : "",
          ]
            .filter(Boolean)
            .join(", ")
      : ""

    const mobilePhone = `${phoneAreaCode}${phone}`

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
      address: deliveryAddress,
      street,
      streetNumber,
      locality,
      province,
      postalCode,
      phone: mobilePhone,
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
      address: deliveryAddress,
      street,
      streetNumber,
      floor,
      apartment,
      locality,
      postalCode,
      phone: mobilePhone,
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
    const recoveryEmail = identifier.trim().toLowerCase()

    if (!recoveryEmail || !recoveryEmail.includes("@")) {
      setError("Para recuperar la contraseña ingresá tu email.")
      return
    }

    setError("")
    setSuccess("")
    localStorage.setItem("beyonix-password-recovery", "true")

    const { error: resetError } = await supabase.auth.resetPasswordForEmail(
      recoveryEmail,
      {
        redirectTo: `${window.location.origin}/reset-password`,
      }
    )

    if (resetError) {
      localStorage.removeItem("beyonix-password-recovery")
      setError("No se pudo enviar el email.")
      return
    }

    setSuccess("Si el email existe, te enviamos un enlace de recuperación.")
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
    <div className="flex min-h-screen flex-col bg-black text-white">
      <header className="border-b border-beyonix-blue-light/14 bg-black/95">
        <nav className="container mx-auto px-4 lg:px-8">
          <div className="flex h-16 items-center justify-center lg:h-18">
            <BeyonixLogoLink />
          </div>
        </nav>
      </header>

      <main className="relative flex flex-1 items-center justify-center overflow-hidden bg-[linear-gradient(180deg,rgba(17,42,67,0.32)_0%,rgba(7,18,30,0.5)_35%,rgba(0,0,0,0.34)_100%)] px-4 py-5">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 h-px bg-beyonix-blue-light/22"
        />
        {confirmationEmail ? (
          <div className="w-full max-w-lg rounded-2xl border border-beyonix-blue-light/18 bg-beyonix-surface-4 p-6 text-center shadow-2xl shadow-black/35 lg:p-8">
            <div className="mx-auto flex size-16 items-center justify-center rounded-full border border-emerald-400/25 bg-emerald-500/10">
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
                <p className="mt-2 rounded-xl border border-white/8 bg-black px-4 py-3 text-sm font-semibold text-white">
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
          className={`relative z-10 w-full rounded-2xl border border-beyonix-blue-light/30 bg-[linear-gradient(145deg,rgba(15,28,42,0.98),rgba(10,16,23,0.98))] shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_24px_70px_rgba(0,0,0,0.42)] backdrop-blur-sm ${
            mode === "login" ? "max-w-md" : "max-w-5xl"
          } ${mode === "login" ? "p-5 lg:p-6" : "p-4 lg:p-5"}`}
        >
          <div
          className={
            mode === "login"
              ? "mb-6 space-y-5"
              : "mb-3 grid gap-3 lg:grid-cols-login-register lg:items-end"
          }
        >
          <div>
            <h1 className="text-2xl font-bold text-white sm:text-3xl">
              {mode === "login" ? "Iniciar sesión" : "Crear cuenta"}
            </h1>
            <p className="mt-1.5 text-sm text-white/72">
              {mode === "login"
                ? "Accedé a tu cuenta para continuar la compra."
                : "Registrate para comprar en BEYONIX."}
            </p>
          </div>

          <div className="grid max-w-sm grid-cols-2 rounded-xl border border-beyonix-blue-light/24 bg-[#08111b] p-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.055)]">
            <button
              type="button"
              aria-label="Iniciar sesión"
              onClick={() => handleModeChange("login")}
              className={`h-9 cursor-pointer rounded-lg px-5 text-sm font-medium transition-all ${
                mode === "login"
                  ? "border border-beyonix-blue-light/55 bg-beyonix-blue text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_0_16px_rgba(30,77,123,0.22)]"
                  : "text-white/68 hover:bg-beyonix-blue/24 hover:text-white"
              }`}
            >
              Iniciar sesión
            </button>

            <button
              type="button"
              aria-label="Registrarme"
              onClick={() => handleModeChange("register")}
              className={`h-9 cursor-pointer rounded-lg px-5 text-sm font-medium transition-all ${
                mode === "register"
                  ? "border border-beyonix-blue-light/55 bg-beyonix-blue text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_0_16px_rgba(30,77,123,0.22)]"
                  : "text-white/68 hover:bg-beyonix-blue/24 hover:text-white"
              }`}
            >
              Registrarme
            </button>
          </div>
        </div>

        <form
          key={mode}
          onSubmit={handleSubmit}
          autoComplete="on"
          className={mode === "register" ? "space-y-3" : "space-y-4"}
        >
          {mode === "register" && (
            <>
              <div className="grid gap-2.5 md:grid-cols-2">
                <Field name="username" label="Usuario*" type="text" value={username} onChange={setUsername} placeholder="usuario.tech" maxLength={FIELD_LIMITS.username} autoComplete="username" />
                <Field name="email" label="Email*" type="email" value={email} onChange={setEmail} placeholder="nombre@email.com" maxLength={FIELD_LIMITS.email} autoComplete="email" />
              </div>
              <div className="grid gap-2.5 md:grid-cols-2">
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
              <div className="grid gap-2.5 md:grid-cols-2">
                <Field name="name" label="Nombre y apellido*" type="text" value={name} onChange={setName} placeholder="Nombre Apellido" maxLength={FIELD_LIMITS.name} autoComplete="name" />
                <Field name="dni" label="DNI*" type="tel" value={dni} onChange={(value) => setDni(onlyDigits(value, FIELD_LIMITS.dni))} placeholder="12345678" maxLength={FIELD_LIMITS.dni} inputMode="numeric" autoComplete="off" />
              </div>
              <div className="grid gap-2.5 md:grid-cols-2">
                <Field name="street" label="Calle*" type="text" value={street} onChange={setStreet} placeholder="San Martín" maxLength={FIELD_LIMITS.street} autoComplete="address-line1" />
                <div className="grid gap-2.5 md:grid-cols-[minmax(5.5rem,1fr)_minmax(4.75rem,0.75fr)_minmax(4.75rem,0.75fr)]">
                  <Field name="street-number" label="Número*" type="tel" value={streetNumber} onChange={(value) => setStreetNumber(onlyDigits(value, 8))} placeholder="1234" maxLength={8} inputMode="numeric" autoComplete="address-line2" />
                  <Field name="floor" label="Piso" type="text" value={floor} onChange={setFloor} placeholder="3" maxLength={12} autoComplete="off" required={false} />
                  <Field name="apartment" label="Dpto" type="text" value={apartment} onChange={setApartment} placeholder="B" maxLength={12} autoComplete="off" required={false} />
                </div>
              </div>
              <div className="grid gap-2.5 md:grid-cols-2">
                <div>
                  <label className="mb-1 block text-xs font-medium text-white/78">
                    Provincia*
                  </label>
                  <ProvinceSelect value={province} onChange={setProvince} compact appearance="login" />
                </div>
                <Field name="locality" label="Localidad*" type="text" value={locality} onChange={setLocality} placeholder="Rosario" maxLength={60} autoComplete="address-level2" required />
              </div>
              <div className="grid gap-2.5 md:grid-cols-2">
                <Field name="postal-code" label="Código postal*" type="tel" value={postalCode} onChange={(value) => setPostalCode(onlyDigits(value, FIELD_LIMITS.postalCode))} placeholder="2000" maxLength={FIELD_LIMITS.postalCode} inputMode="numeric" autoComplete="postal-code" required />
                <div>
                  <label className="mb-1 block text-xs font-medium text-white/78">
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
                      className="beyonix-login-input h-10 w-full rounded-lg border border-white/10 bg-[#1b1f24] px-3 text-sm text-white outline-none transition-all placeholder:text-white/42 hover:border-beyonix-blue-light/45 focus:border-beyonix-sky/70 focus:ring-2 focus:ring-beyonix-blue-light/24"
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
                      className="beyonix-login-input h-10 w-full rounded-lg border border-white/10 bg-[#1b1f24] px-3 text-sm text-white outline-none transition-all placeholder:text-white/42 hover:border-beyonix-blue-light/45 focus:border-beyonix-sky/70 focus:ring-2 focus:ring-beyonix-blue-light/24"
                    />
                  </div>
                  <p className="mt-1 text-[11px] leading-4 text-white/58">
                    Ingresá la característica y el número sin 0 ni 15.
                  </p>
                </div>
              </div>
              <TextareaField name="references" label="Referencias para llegar (máximo 80 caracteres)" value={references} onChange={setReferences} placeholder="Fachada blanca, portón negro, antes de llegar a la esquina." maxLength={80} />
            </>
          )}

          {mode === "login" && (
            <>
              <Field name="username" label="Email o usuario" type="text" value={identifier} onChange={setIdentifier} placeholder="usuario.tech o nombre@email.com" maxLength={FIELD_LIMITS.loginIdentifier} autoComplete="username" />
              <Field name="password" label="Contraseña" type="password" value={password} onChange={setPassword} placeholder="Contraseña" maxLength={FIELD_LIMITS.password} autoComplete="current-password" showPasswordToggle />
            </>
          )}

          {mode === "login" && (
            <button
              type="button"
              aria-label="Olvidé mi contraseña"
              onClick={handleForgotPassword}
              className="cursor-pointer text-left text-sm font-medium text-beyonix-sky transition-colors hover:text-white"
            >
              ¿Olvidaste tu contraseña?
            </button>
          )}

          {error && (
            <div className="rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400 md:col-span-2">
              {error}
            </div>
          )}

          {success && (
            <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-400 md:col-span-2">
              {success}
            </div>
          )}

          <div className={mode === "register" ? "flex justify-center pt-1" : ""}>
            <button
              type="submit"
              aria-label={mode === "login" ? "Ingresar" : "Crear cuenta"}
              disabled={loading}
              className={`flex h-10 cursor-pointer items-center justify-center rounded-xl border border-beyonix-blue-light/48 bg-beyonix-blue px-10 font-heading text-sm font-semibold text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_14px_34px_rgba(0,0,0,0.35)] transition-all hover:border-beyonix-blue-light/75 hover:bg-beyonix-blue-hover focus-visible:ring-2 focus-visible:ring-beyonix-blue-light/25 disabled:cursor-not-allowed disabled:opacity-50 ${
                mode === "login" ? "w-full" : "min-w-44"
              }`}
            >
              {loading ? (
                <Loader2 className="size-5 animate-spin" />
              ) : mode === "login" ? (
                "Ingresar"
              ) : (
                "Crear cuenta"
              )}
            </button>
          </div>
          </form>
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
