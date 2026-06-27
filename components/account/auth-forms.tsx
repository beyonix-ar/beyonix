"use client"

import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { Check, Eye, EyeOff, Hash, Lock, Mail, MapPin, Phone, User } from "lucide-react"

import { useAuth } from "@/context/auth-context"
import { InputField, TextareaField } from "@/components/account/account-form-fields"
import { PasswordRequirements } from "@/components/password-requirements"
import { ProvinceSelect } from "@/components/province-select"
import { supabase } from "@/lib/supabase/client"
import {
  buildDeliveryAddressDraft,
  formatDeliveryAddressForProfile,
} from "@/lib/account/account-utils"
import {
  FIELD_LIMITS,
  meetsPasswordRequirements,
  onlyDigits,
  validateRegisterPayload,
} from "@/lib/validation/account-fields"
export function LoginForm({ onSwitch }: { onSwitch: () => void }) {
  const { login } = useAuth()
  const router = useRouter()
  const [identifier, setIdentifier] = useState("")
  const [password, setPassword] = useState("")
  const [showPass, setShowPass] = useState(false)
  const [error, setError] = useState("")
  const [success, setSuccess] = useState("")
  const [loading, setLoading] = useState(false)
  const [resetLoading, setResetLoading] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError("")
    setSuccess("")
    setLoading(true)

    const result = await login(identifier, password)
    setLoading(false)

    if (!result.ok) {
      setError(result.error || "Ocurrió un error.")
      return
    }

    router.push("/cuenta")
  }

  const handleForgotPassword = async () => {
    const normalizedEmail = identifier.trim().toLowerCase()

    if (!normalizedEmail || !normalizedEmail.includes("@")) {
      setError("Introduce tu email primero.")
      setSuccess("")
      return
    }

    setError("")
    setSuccess("")
    setResetLoading(true)

    try {
      localStorage.setItem("beyonix-password-recovery", "true")

      const { error: resetError } = await supabase.auth.resetPasswordForEmail(
        normalizedEmail,
        {
          redirectTo: `${window.location.origin}/reset-password`,
        }
      )

      if (resetError) {
        localStorage.removeItem("beyonix-password-recovery")
        setError("No se pudo enviar el email.")
        return
      }

      setSuccess("Te enviamos un email para restablecer tu contraseña.")
    } catch {
      setError("No se pudo enviar el email. Inténtalo de nuevo.")
    } finally {
      setResetLoading(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <InputField
        label="Email o usuario"
        type="text"
        value={identifier}
        onChange={setIdentifier}
        placeholder="usuario.tech o nombre@email.com"
        icon={Mail}
        maxLength={FIELD_LIMITS.loginIdentifier}
      />
      <InputField
        label="Contraseña"
        type={showPass ? "text" : "password"}
        value={password}
        onChange={setPassword}
        placeholder="••••••••"
        icon={Lock}
        maxLength={FIELD_LIMITS.password}
        rightElement={
          <button
            type="button"
            aria-label="Mostrar u ocultar contraseña"
            title="Mostrar u ocultar contraseña"
            onClick={() => setShowPass((value) => !value)}
            className="cursor-pointer text-slate-700 transition-colors hover:text-black"
          >
            {showPass ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        }
      />

      <div className="flex justify-end">
        <button
          type="button"
          aria-label="Recuperar contraseña"
          title="Recuperar contraseña"
          onClick={handleForgotPassword}
          disabled={resetLoading}
          className="text-sm font-medium text-beyonix-cyan transition-colors hover:text-white disabled:opacity-50 cursor-pointer"
        >
          {resetLoading ? "Enviando..." : "¿Olvidaste tu contraseña?"}
        </button>
      </div>

      {error && (
        <div className="rounded-xl border border-red-500/20 bg-red-500/8 px-4 py-3">
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}
      {success && (
        <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/8 px-4 py-3">
          <p className="text-sm text-emerald-400">{success}</p>
        </div>
      )}

      <button
        type="submit"
        aria-label="Iniciar sesión"
        title="Iniciar sesión"
        disabled={loading}
        className="w-full h-11 rounded-xl bg-white text-black text-sm font-semibold hover:bg-white/90 disabled:opacity-50 transition-all active:scale-95 cursor-pointer"
      >
        {loading ? "Ingresando..." : "Iniciar sesión"}
      </button>

      <p className="text-center text-sm text-white/50">
        ¿No tenés cuenta?{" "}
        <button
          type="button"
          aria-label="Ir a registro"
          title="Ir a registro"
          onClick={onSwitch}
          className="text-beyonix-cyan hover:text-white transition-colors cursor-pointer font-medium"
        >
          Registrate gratis
        </button>
      </p>
    </form>
  )
}

export function RegisterForm({ onSwitch }: { onSwitch: () => void }) {
  const { register } = useAuth()
  const [username, setUsername] = useState("")
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [street, setStreet] = useState("")
  const [streetNumber, setStreetNumber] = useState("")
  const [floor, setFloor] = useState("")
  const [apartment, setApartment] = useState("")
  const [locality, setLocality] = useState("")
  const [province, setProvince] = useState("")
  const [postalCode, setPostalCode] = useState("")
  const [phone, setPhone] = useState("")
  const [references, setReferences] = useState("")
  const [password, setPassword] = useState("")
  const [showPass, setShowPass] = useState(false)
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)
  const [pendingUserId, setPendingUserId] = useState("")
  const [confirmationHandoff, setConfirmationHandoff] = useState("")
  const [confirmationValidated, setConfirmationValidated] = useState(false)
  const [confirmationMessage, setConfirmationMessage] = useState("")
  const confirmationPollInProgress = useRef(false)
  const confirmationCompletionStarted = useRef(false)

  useEffect(() => {
    if (!pendingUserId || !confirmationHandoff) return

    let cancelled = false
    let timeout: number | undefined

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
            userId: pendingUserId,
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
            setConfirmationMessage(
              data.error ||
                "Cuenta confirmada. Estamos preparando tu sesión..."
            )
            return
          }

          if (confirmationCompletionStarted.current) return

          confirmationCompletionStarted.current = true
          setConfirmationMessage("Email confirmado. Iniciando sesión...")

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
            setConfirmationMessage(
              "Email confirmado. Te llevaremos al Home en un segundo..."
            )
            timeout = window.setTimeout(() => {
              window.location.assign("/")
            }, 1000)
            return
          }

          confirmationCompletionStarted.current = false
          setConfirmationMessage(
            "La cuenta fue confirmada, pero no pudimos iniciar sesión automáticamente."
          )
        } else if (!cancelled && !response.ok && data.error) {
          setConfirmationMessage(data.error)
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

    void checkConfirmation()

    return () => {
      cancelled = true
      if (timeout) window.clearTimeout(timeout)
    }
  }, [
    confirmationHandoff,
    pendingUserId,
  ])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError("")

    if (!meetsPasswordRequirements(password)) {
      setError("La contraseña no cumple los requisitos.")
      return
    }

    if (!street.trim()) {
      setError("Introduce la calle.")
      return
    }

    if (!streetNumber.trim()) {
      setError("Introduce el número de calle.")
      return
    }

    if (!locality.trim()) {
      setError("Introduce la localidad.")
      return
    }

    const deliveryAddress = formatDeliveryAddressForProfile(
      buildDeliveryAddressDraft({
        postalCode,
        street,
        streetNumber,
        floor,
        apartment,
        locality,
        province,
      })
    )

    const validationError = validateRegisterPayload({
      username,
      name,
      email,
      address: deliveryAddress,
      street,
      streetNumber,
      locality,
      province,
      postalCode,
      phone,
      password,
      references,
    })

    if (validationError) {
      setError(validationError)
      return
    }

    setLoading(true)
    const result = await register({
      username,
      name,
      email,
      password,
      address: deliveryAddress,
      street,
      streetNumber,
      floor,
      apartment,
      locality,
      province,
      postalCode,
      phone,
      references,
    })
    setLoading(false)

    if (!result.ok) {
      setError(result.error || "Ocurrió un error.")
      return
    }

    setPendingUserId(result.pendingUserId ?? "")
    setConfirmationHandoff(result.confirmationHandoff ?? "")
    setConfirmationValidated(false)
    setConfirmationMessage("")
    confirmationCompletionStarted.current = false
  }

  if (pendingUserId && confirmationHandoff) {
    return (
      <div className="space-y-5 text-center">
        <div className="mx-auto flex size-16 items-center justify-center rounded-full border border-emerald-400/25 bg-emerald-500/10">
          <Check className="size-9 text-emerald-400" />
        </div>

        <div>
          <h2 className="text-2xl font-bold text-white">
            {confirmationValidated ? "Cuenta confirmada" : "Revisá tu correo"}
          </h2>
          <p className="mt-2 text-sm leading-6 text-white/60">
            {confirmationValidated
              ? "Estamos iniciando tu sesión y te llevaremos al Home automáticamente."
              : "Dejá esta pestaña abierta. Cuando confirmes la cuenta desde Gmail, iniciaremos tu sesión automáticamente y te llevaremos al inicio."}
          </p>
        </div>

        {!confirmationValidated && (
          <p className="rounded-xl border border-white/10 bg-black px-4 py-3 text-sm font-semibold text-white">
            {email.trim().toLowerCase()}
          </p>
        )}

        {confirmationMessage && (
          <p className="text-sm text-emerald-400">{confirmationMessage}</p>
        )}

        <button
          type="button"
          onClick={onSwitch}
          className="h-11 w-full cursor-pointer rounded-xl bg-white text-sm font-semibold text-black transition-opacity hover:opacity-90"
        >
          Volver al inicio de sesión
        </button>
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <InputField label="Nombre de usuario" type="text" value={username} onChange={setUsername} placeholder="usuario.tech" icon={User} maxLength={FIELD_LIMITS.username} />
      <InputField label="Nombre y apellido" type="text" value={name} onChange={setName} placeholder="Nombre Apellido" icon={User} maxLength={FIELD_LIMITS.name} />
      <InputField label="Email" type="email" value={email} onChange={setEmail} placeholder="nombre@email.com" icon={Mail} maxLength={FIELD_LIMITS.email} />
      <div className="grid gap-3 md:grid-cols-2">
        <InputField label="Calle" type="text" value={street} onChange={setStreet} placeholder="San Martín" icon={MapPin} maxLength={60} />
        <InputField label="Número" type="tel" value={streetNumber} onChange={(value) => setStreetNumber(onlyDigits(value, 8))} placeholder="1234" icon={Hash} maxLength={8} inputMode="numeric" />
        <InputField label="Piso opcional" type="text" value={floor} onChange={setFloor} placeholder="3" icon={Hash} maxLength={12} />
        <InputField label="Departamento opcional" type="text" value={apartment} onChange={setApartment} placeholder="B" icon={Hash} maxLength={12} />
        <InputField label="Localidad" type="text" value={locality} onChange={setLocality} placeholder="Rosario" icon={MapPin} maxLength={60} />
      </div>
      <TextareaField
        label="Referencias"
        value={references}
        onChange={setReferences}
        placeholder="Entre calles, fachada blanca, porton negro, antes de llegar a la esquina."
        icon={MapPin}
        maxLength={FIELD_LIMITS.references}
      />
      <div className="space-y-1.5">
        <label className="block text-xs font-semibold uppercase tracking-widest text-white/60">
          Provincia
        </label>
        <ProvinceSelect value={province} onChange={setProvince} />
      </div>
      <InputField label="Código postal" type="tel" value={postalCode} onChange={(value) => setPostalCode(onlyDigits(value, FIELD_LIMITS.postalCode))} placeholder="1001" icon={Hash} maxLength={FIELD_LIMITS.postalCode} inputMode="numeric" />
      <InputField label="Teléfono móvil" type="tel" value={phone} onChange={(value) => setPhone(onlyDigits(value, FIELD_LIMITS.phone))} placeholder="1100000000" icon={Phone} maxLength={FIELD_LIMITS.phone} inputMode="numeric" />
      <InputField
        label="Contraseña"
        type={showPass ? "text" : "password"}
        value={password}
        onChange={setPassword}
        placeholder="Creá una contraseña segura"
        icon={Lock}
        maxLength={FIELD_LIMITS.password}
        rightElement={
          <button
            type="button"
            aria-label="Mostrar u ocultar contraseña"
            title="Mostrar u ocultar contraseña"
            onClick={() => setShowPass((value) => !value)}
            className="text-white/40 hover:text-white/70 transition-colors cursor-pointer"
          >
            {showPass ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        }
      />
      <PasswordRequirements password={password} />

      {error && (
        <div className="rounded-xl border border-red-500/20 bg-red-500/8 px-4 py-3">
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      <button
        type="submit"
        aria-label="Crear cuenta"
        title="Crear cuenta"
        disabled={loading}
        className="w-full h-11 rounded-xl bg-white text-black text-sm font-semibold hover:bg-white/90 disabled:opacity-50 transition-all active:scale-95 cursor-pointer"
      >
        {loading ? "Creando cuenta..." : "Crear cuenta"}
      </button>

      <p className="text-center text-sm text-white/50">
        ¿Ya tenés cuenta?{" "}
        <button
          type="button"
          aria-label="Ir a inicio de sesión"
          title="Ir a inicio de sesión"
          onClick={onSwitch}
          className="text-beyonix-cyan hover:text-white transition-colors cursor-pointer font-medium"
        >
          Iniciá sesión
        </button>
      </p>
    </form>
  )
}
