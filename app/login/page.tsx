"use client"

import { Suspense, useEffect, useState } from "react"
import type { InputHTMLAttributes } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { Loader2 } from "lucide-react"

import { useAuth } from "@/context/auth-context"
import { ProvinceSelect } from "@/components/province-select"
import { supabase } from "@/lib/supabase/client"
import {
  FIELD_LIMITS,
  onlyDigits,
  validateRegisterPayload,
} from "@/lib/validation/account-fields"

function getSafeRedirect(redirect: string | null) {
  if (!redirect || redirect.startsWith("/login")) {
    return "/"
  }

  if (!redirect.startsWith("/")) {
    return "/"
  }

  return redirect
}

function Field({
  label,
  type,
  value,
  onChange,
  placeholder,
  maxLength,
  inputMode,
}: {
  label: string
  type: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  maxLength?: number
  inputMode?: InputHTMLAttributes<HTMLInputElement>["inputMode"]
}) {
  return (
    <div>
      <label className="mb-2 block text-sm text-white/80">{label}</label>
      <input
        type={type}
        aria-label={label}
        title={label}
        required
        value={value}
        placeholder={placeholder}
        maxLength={maxLength}
        inputMode={inputMode}
        onChange={(e) => onChange(e.target.value)}
        className="h-12 w-full rounded-xl border border-white/10 bg-black px-4 text-white outline-none transition-colors placeholder:text-white/25 focus:border-beyonix-focus"
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
  const [address, setAddress] = useState("")
  const [province, setProvince] = useState("")
  const [postalCode, setPostalCode] = useState("")
  const [phone, setPhone] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState("")
  const [success, setSuccess] = useState("")
  const [loading, setLoading] = useState(false)

  const redirect = getSafeRedirect(searchParams.get("redirect"))

  useEffect(() => {
    if (isLoading || !user) return

    router.replace(redirect)
  }, [isLoading, redirect, router, user])

  if (isLoading || user) {
    return null
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

    const validationError = validateRegisterPayload({
      username,
      name,
      email,
      address,
      province,
      postalCode,
      phone,
      password,
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
      address,
      postalCode,
      phone,
      province,
    })

    setLoading(false)

    if (!result.ok) {
      setError(result.error || "Error al crear cuenta")
      return
    }

    setSuccess("Cuenta creada correctamente.")
    router.replace(redirect)
  }

  const handleForgotPassword = async () => {
    if (!identifier.includes("@")) {
      setError("Para recuperar la contraseña ingresá tu email.")
      return
    }

    if (!identifier) {
      setError("Ingresá tu email primero.")
      return
    }

    setError("")
    setSuccess("")

    localStorage.setItem("beyonix-password-recovery", "true")

    const { error: resetError } = await supabase.auth.resetPasswordForEmail(
      identifier.trim().toLowerCase(),
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
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-black px-4 py-10">
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-beyonix-surface-4 p-8 shadow-2xl">
        <div className="mb-8">
          <p className="mb-2 text-11px font-medium uppercase tracking-widest text-beyonix-focus">
            BEYONIX
          </p>
          <h1 className="text-3xl font-bold text-white">
            {mode === "login" ? "Iniciar sesión" : "Crear cuenta"}
          </h1>
          <p className="mt-2 text-sm text-white/65">
            {mode === "login"
              ? "Accedé a tu cuenta para continuar la compra."
              : "Registrate para comprar en BEYONIX."}
          </p>
        </div>

        <div className="mb-6 grid grid-cols-2 rounded-xl border border-white/10 bg-black p-1">
          <button
            type="button"
            aria-label="Iniciar sesión"
            title="Iniciar sesión"
            onClick={() => setMode("login")}
            className={`h-11 cursor-pointer rounded-lg text-sm font-medium transition-all ${
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
            onClick={() => setMode("register")}
            className={`h-11 cursor-pointer rounded-lg text-sm font-medium transition-all ${
              mode === "register"
                ? "bg-white text-black"
                : "text-white/70 hover:text-white"
            }`}
          >
            Registrarme
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          {mode === "register" && (
            <>
              <Field
                label="Nombre de usuario"
                type="text"
                value={username}
                onChange={setUsername}
                placeholder="usuario.tech"
                maxLength={FIELD_LIMITS.username}
              />
              <Field
                label="Nombre y apellido"
                type="text"
                value={name}
                onChange={setName}
                placeholder="Nombre Apellido"
                maxLength={FIELD_LIMITS.name}
              />
            </>
          )}

          {mode === "login" ? (
            <Field
              label="Email o usuario"
              type="text"
              value={identifier}
              onChange={setIdentifier}
              placeholder="usuario.tech o nombre@email.com"
              maxLength={FIELD_LIMITS.loginIdentifier}
            />
          ) : (
            <Field
              label="Email"
              type="email"
              value={email}
              onChange={setEmail}
              placeholder="nombre@email.com"
              maxLength={FIELD_LIMITS.email}
            />
          )}

          {mode === "register" && (
            <>
              <Field
                label="Dirección"
                type="text"
                value={address}
                onChange={setAddress}
                placeholder="Calle 1234, piso/depto"
                maxLength={FIELD_LIMITS.address}
              />
              <div>
                <label className="mb-2 block text-sm text-white/80">
                  Provincia
                </label>
                <ProvinceSelect value={province} onChange={setProvince} />
              </div>
              <Field
                label="Código postal"
                type="tel"
                value={postalCode}
                onChange={(value) =>
                  setPostalCode(onlyDigits(value, FIELD_LIMITS.postalCode))
                }
                placeholder="1001"
                maxLength={FIELD_LIMITS.postalCode}
                inputMode="numeric"
              />
              <Field
                label="Teléfono móvil"
                type="tel"
                value={phone}
                onChange={(value) =>
                  setPhone(onlyDigits(value, FIELD_LIMITS.phone))
                }
                placeholder="1100000000"
                maxLength={FIELD_LIMITS.phone}
                inputMode="numeric"
              />
            </>
          )}

          <Field
            label="Contraseña"
            type="password"
            value={password}
            onChange={setPassword}
            placeholder={mode === "register" ? "Mínimo 6 caracteres" : ""}
            maxLength={FIELD_LIMITS.password}
          />

          {mode === "login" && (
            <button
              type="button"
              aria-label="Olvidé mi contraseña"
              title="Olvidé mi contraseña"
              onClick={handleForgotPassword}
              className="cursor-pointer text-sm text-beyonix-focus transition-opacity hover:opacity-80"
            >
              ¿Olvidaste tu contraseña?
            </button>
          )}

          {error && (
            <div className="rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
              {error}
            </div>
          )}

          {success && (
            <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-400">
              {success}
            </div>
          )}

          <button
            type="submit"
            aria-label={mode === "login" ? "Ingresar" : "Crear cuenta"}
            title={mode === "login" ? "Ingresar" : "Crear cuenta"}
            disabled={loading}
            className="flex h-12 w-full cursor-pointer items-center justify-center rounded-xl bg-white font-semibold text-black transition-opacity hover:opacity-90 disabled:opacity-50"
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
    </main>
  )
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginContent />
    </Suspense>
  )
}
