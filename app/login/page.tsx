"use client"

import { Suspense, useEffect, useState } from "react"
import type { InputHTMLAttributes } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { CheckCircle2, Eye, EyeOff, Loader2, RefreshCw } from "lucide-react"

import { BeyonixLogoLink } from "@/components/beyonix-logo-link"
import { PasswordRequirements } from "@/components/password-requirements"
import { ProvinceSelect } from "@/components/province-select"
import { useAuth } from "@/context/auth-context"
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
          title={label}
          required={required}
          value={value}
          placeholder={placeholder}
          maxLength={maxLength}
          inputMode={inputMode}
          autoComplete={autoComplete}
          onChange={(e) => onChange(e.target.value)}
          className={`beyonix-login-input h-10 w-full rounded-lg border border-white/10 bg-black px-3 text-sm text-white outline-none transition-colors placeholder:text-white/25 focus:border-beyonix-focus ${
            showPasswordToggle ? "pr-12" : ""
          }`}
        />
        {showPasswordToggle && type === "password" && (
          <button
            type="button"
            aria-label={passwordVisible ? "Ocultar contrasena" : "Mostrar contrasena"}
            title={passwordVisible ? "Ocultar contrasena" : "Mostrar contrasena"}
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
        title={label}
        value={value}
        placeholder={placeholder}
        maxLength={maxLength}
        onChange={(e) => onChange(e.target.value)}
        className="min-h-14 w-full resize-none rounded-lg border border-white/10 bg-black px-3 py-2 text-sm leading-5 text-white outline-none transition-colors placeholder:text-white/25 focus:border-beyonix-focus"
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
  const [identifier, setIdentifier] = useState("")
  const [email, setEmail] = useState("")
  const [street, setStreet] = useState("")
  const [streetNumber, setStreetNumber] = useState("")
  const [floor, setFloor] = useState("")
  const [apartment, setApartment] = useState("")
  const [locality, setLocality] = useState("")
  const [province, setProvince] = useState("")
  const [postalCode, setPostalCode] = useState("")
  const [phone, setPhone] = useState("")
  const [password, setPassword] = useState("")
  const [references, setReferences] = useState("")
  const [error, setError] = useState("")
  const [success, setSuccess] = useState("")
  const [loading, setLoading] = useState(false)
  const [confirmationEmail, setConfirmationEmail] = useState("")
  const [resendingEmail, setResendingEmail] = useState(false)
  const [resendMessage, setResendMessage] = useState("")
  const [resendCooldown, setResendCooldown] = useState(0)

  const redirect = getSafeRedirect(searchParams.get("redirect"))
  const verificationEmail = searchParams.get("verificar-email")

  useEffect(() => {
    if (searchParams.get("reset") !== "success") return

    setSuccess("ContraseÃ±a actualizada correctamente. Ya podÃ©s iniciar sesiÃ³n.")
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
    if (resendCooldown <= 0) return

    const timeout = window.setTimeout(() => {
      setResendCooldown((current) => Math.max(0, current - 1))
    }, 1000)

    return () => window.clearTimeout(timeout)
  }, [resendCooldown])

  useEffect(() => {
    if (isLoading || !user) return
    router.replace(redirect)
  }, [isLoading, redirect, router, user])

  if (isLoading || user) return null

  const handleModeChange = (nextMode: "login" | "register") => {
    setMode(nextMode)
    setError("")
    setSuccess("")
    setConfirmationEmail("")
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

    if (!street.trim()) {
      setLoading(false)
      setError("Ingresá la calle.")
      return
    }

    if (!streetNumber.trim()) {
      setLoading(false)
      setError("Ingresá el número de calle.")
      return
    }

    if (!locality.trim()) {
      setLoading(false)
      setError("Ingresá la localidad.")
      return
    }

    const deliveryAddress = formatDeliveryAddress({
      street,
      streetNumber,
      floor,
      apartment,
      locality,
      region: province,
      postalCode,
    })

    if (!meetsPasswordRequirements(password)) {
      setLoading(false)
      setError("La contraseña no cumple los requisitos.")
      return
    }

    const validationError = validateRegisterPayload({
      username,
      name,
      email,
      address: deliveryAddress,
      province,
      postalCode,
      phone,
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
      password,
      address: deliveryAddress,
      postalCode,
      phone,
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

      setConfirmationEmail(normalizedEmail)
      setMode("login")
      router.replace(
        `/verificar-email?email=${encodeURIComponent(normalizedEmail)}`,
        { scroll: false }
      )
      return
    }

    setSuccess("Cuenta creada correctamente.")
    router.replace(redirect)
  }

  const handleForgotPassword = async () => {
    const recoveryEmail = identifier.trim().toLowerCase()

    if (!recoveryEmail || !recoveryEmail.includes("@")) {
      setError("Para recuperar la contrasena ingresa tu email.")
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
    <div className="flex min-h-screen flex-col bg-black">
      <header className="border-b border-white/10 bg-black">
        <nav className="container mx-auto px-4 lg:px-8">
          <div className="flex h-16 items-center justify-center lg:h-18">
            <BeyonixLogoLink />
          </div>
        </nav>
      </header>

      <main className="flex flex-1 items-center justify-center px-4 py-4">
        {confirmationEmail ? (
          <div className="w-full max-w-lg rounded-2xl border border-beyonix-blue-light/18 bg-beyonix-surface-4 p-6 text-center shadow-2xl shadow-black/35 lg:p-8">
            <div className="mx-auto flex size-16 items-center justify-center rounded-full border border-emerald-400/25 bg-emerald-500/10">
              <CheckCircle2 className="size-10 text-emerald-400" strokeWidth={2.25} />
            </div>

            <h1 className="mt-5 text-2xl font-bold text-white sm:text-3xl">
              Usuario creado con éxito
            </h1>

            <p className="mt-3 text-sm leading-6 text-white/68">
              Te enviamos un correo de confirmación. Revisá tu email para activar la cuenta.
            </p>

            <p className="mt-2 rounded-xl border border-white/8 bg-black px-4 py-3 text-sm font-semibold text-white">
              {confirmationEmail}
            </p>

            <p className="mt-4 text-sm leading-6 text-white/58">
              Para verificar la cuenta y poder comprar en nuestra tienda, tenés que abrir el correo de confirmación y validar tu email.
            </p>

            <p className="mt-3 text-xs leading-5 text-white/42">
              Si no lo encontrás, revisá spam, promociones o correo no deseado.
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

            {resendMessage && (
              <p
                role="status"
                className={`mt-3 text-xs leading-5 ${
                  resendMessage.startsWith("Correo reenviado")
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
              title="Volver al inicio de sesión"
              onClick={() => {
                setConfirmationEmail("")
                setMode("login")
                router.replace("/login", { scroll: false })
              }}
              className="mt-3 flex h-11 w-full cursor-pointer items-center justify-center rounded-xl bg-white text-sm font-semibold text-black transition-opacity hover:opacity-90"
            >
              Volver al inicio de sesión
            </button>
          </div>
        ) : (
          <div
          className={`w-full rounded-2xl border border-white/10 bg-beyonix-surface-4 p-5 shadow-2xl lg:p-6 ${
            mode === "login" ? "max-w-md" : "max-w-5xl"
          }`}
        >
          <div
          className={
            mode === "login"
              ? "mb-6 space-y-5"
              : "mb-4 grid gap-3 lg:grid-cols-login-register lg:items-end"
          }
        >
          <div>
            <h1 className="text-2xl font-bold text-white sm:text-3xl">
              {mode === "login" ? "Iniciar sesión" : "Crear cuenta"}
            </h1>
            <p className="mt-1.5 text-sm text-white/65">
              {mode === "login"
                ? "Accedé a tu cuenta para continuar la compra."
                : "Registrate para comprar en BEYONIX."}
            </p>
          </div>

          <div className="grid grid-cols-2 rounded-xl border border-white/10 bg-black p-1">
            <button
              type="button"
              aria-label="Iniciar sesión"
              title="Iniciar sesión"
              onClick={() => handleModeChange("login")}
              className={`h-10 cursor-pointer rounded-lg text-sm font-medium transition-all ${
                mode === "login"
                  ? "bg-white text-black"
                  : "text-white/70 hover:text-white"
              }`}
            >
              Iniciar sesión
            </button>

            <button
              type="button"
              aria-label="Registrarme"
              title="Registrarme"
              onClick={() => handleModeChange("register")}
              className={`h-10 cursor-pointer rounded-lg text-sm font-medium transition-all ${
                mode === "register"
                  ? "bg-white text-black"
                  : "text-white/70 hover:text-white"
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
          className={mode === "register" ? "grid gap-3 md:grid-cols-2" : "space-y-4"}
        >
          {mode === "register" && (
            <>
              <Field name="username" label="Nombre de usuario" type="text" value={username} onChange={setUsername} placeholder="usuario.tech" maxLength={FIELD_LIMITS.username} autoComplete="username" />
              <Field name="name" label="Nombre y apellido" type="text" value={name} onChange={setName} placeholder="Nombre Apellido" maxLength={FIELD_LIMITS.name} autoComplete="name" />
            </>
          )}

          {mode === "login" ? (
            <>
              <Field name="username" label="Email o usuario" type="text" value={identifier} onChange={setIdentifier} placeholder="usuario.tech o nombre@email.com" maxLength={FIELD_LIMITS.loginIdentifier} autoComplete="username" />
              <Field name="password" label="Contraseña" type="password" value={password} onChange={setPassword} placeholder="Contraseña" maxLength={FIELD_LIMITS.password} autoComplete="current-password" showPasswordToggle />
            </>
          ) : (
            <>
              <div>
                <Field name="password" label="Contraseña" type="password" value={password} onChange={setPassword} placeholder="Creá una contraseña segura" maxLength={FIELD_LIMITS.password} autoComplete="new-password" showPasswordToggle />
                <PasswordRequirements password={password} />
              </div>
              <Field name="email" label="Email" type="email" value={email} onChange={setEmail} placeholder="nombre@email.com" maxLength={FIELD_LIMITS.email} autoComplete="email" />
            </>
          )}

          {mode === "register" && (
            <>
              <div className="md:col-span-2 rounded-xl border border-beyonix-blue-light/12 bg-black/30 p-3">
                <div className="mb-2">
                  <p className="text-11px font-semibold uppercase tracking-widest text-beyonix-focus">
                    Dirección de entrega
                  </p>
                  <p className="mt-0.5 text-xs leading-4 text-white/45">
                    Estos datos ayudan a preparar futuros envíos a domicilio.
                  </p>
                </div>

                <div className="grid gap-2.5 md:grid-cols-2">
                  <Field name="street" label="Calle" type="text" value={street} onChange={setStreet} placeholder="San Martín" maxLength={60} autoComplete="address-line1" />
                  <Field name="street-number" label="Número" type="tel" value={streetNumber} onChange={(value) => setStreetNumber(onlyDigits(value, 8))} placeholder="1234" maxLength={8} inputMode="numeric" autoComplete="address-line2" />
                  <Field name="floor" label="Piso opcional" type="text" value={floor} onChange={setFloor} placeholder="3" maxLength={12} autoComplete="off" required={false} />
                  <Field name="apartment" label="Departamento opcional" type="text" value={apartment} onChange={setApartment} placeholder="B" maxLength={12} autoComplete="off" required={false} />
                  <Field name="postal-code" label="Código postal" type="tel" value={postalCode} onChange={(value) => setPostalCode(onlyDigits(value, FIELD_LIMITS.postalCode))} placeholder="2000" maxLength={FIELD_LIMITS.postalCode} inputMode="numeric" autoComplete="postal-code" />
                  <Field name="locality" label="Localidad" type="text" value={locality} onChange={setLocality} placeholder="Rosario" maxLength={60} autoComplete="address-level2" />
                  <div>
                    <label className="mb-1 block text-xs font-medium text-white/78">
                      Provincia / Región
                    </label>
                    <ProvinceSelect value={province} onChange={setProvince} compact />
                  </div>
                  <Field name="phone" label="Teléfono móvil" type="tel" value={phone} onChange={(value) => setPhone(onlyDigits(value, FIELD_LIMITS.phone))} placeholder="1100000000" maxLength={FIELD_LIMITS.phone} inputMode="numeric" autoComplete="tel" />
                  <div className="md:col-span-2">
                    <TextareaField name="references" label="Referencias para llegar" value={references} onChange={setReferences} placeholder="Entre Córdoba y Entre Ríos, fachada blanca, portón negro, antes de llegar a la esquina." maxLength={FIELD_LIMITS.references} />
                  </div>
                </div>
              </div>
            </>
          )}

          {mode === "login" && (
            <button
              type="button"
              aria-label="Olvidé mi contraseña"
              title="Olvidé mi contraseña"
              onClick={handleForgotPassword}
              className="cursor-pointer text-left text-sm text-beyonix-focus transition-opacity hover:opacity-80"
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

          <button
            type="submit"
            aria-label={mode === "login" ? "Ingresar" : "Crear cuenta"}
            title={mode === "login" ? "Ingresar" : "Crear cuenta"}
            disabled={loading}
            className="flex h-11 w-full cursor-pointer items-center justify-center rounded-xl bg-white font-semibold text-black transition-opacity hover:opacity-90 disabled:opacity-50 md:col-span-2"
          >
            {loading ? (
              <Loader2 className="size-5 animate-spin" />
            ) : mode === "login" ? (
              "Ingresar"
            ) : (
              "Crear cuenta"
            )}
          </button>
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
