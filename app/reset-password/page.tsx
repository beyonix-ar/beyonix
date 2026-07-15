"use client"

import { Suspense, useEffect, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import {
  AlertCircle,
  ArrowRight,
  Eye,
  EyeOff,
  Loader2,
  ShieldCheck,
} from "lucide-react"

import { PasswordRequirements } from "@/components/password-requirements"
import { supabase } from "@/lib/supabase/client"
import { FIELD_LIMITS, validatePassword } from "@/lib/validation/account-fields"

const PASSWORD_RECOVERY_KEY = "beyonix-password-recovery"

function getPasswordUpdateMessage(message: string) {
  const normalizedMessage = message.toLowerCase()

  if (
    normalizedMessage.includes("different from the old password") ||
    normalizedMessage.includes("same password") ||
    normalizedMessage.includes("new password should be different")
  ) {
    return "La nueva contraseña no puede coincidir con la contraseña anterior."
  }

  return "No se pudo actualizar la contraseña. Intentá nuevamente."
}

function getInvalidLinkMessage() {
  return "El enlace no es válido o expiró. Pedí un nuevo email de recuperación."
}

function ResetPasswordContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [password, setPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)
  const [checkingSession, setCheckingSession] = useState(true)
  const [canChangePassword, setCanChangePassword] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = useState(false)

  const goLoginLoggedOut = async () => {
    localStorage.removeItem(PASSWORD_RECOVERY_KEY)
    await supabase.auth.signOut()
    router.replace("/login?reset=success")
  }

  useEffect(() => {
    let mounted = true

    const markValidRecovery = () => {
      localStorage.setItem(PASSWORD_RECOVERY_KEY, "true")
      if (mounted) {
        setCanChangePassword(true)
        setCheckingSession(false)
      }
    }

    const failRecovery = () => {
      localStorage.removeItem(PASSWORD_RECOVERY_KEY)
      if (mounted) {
        setError(getInvalidLinkMessage())
        setCanChangePassword(false)
        setCheckingSession(false)
      }
    }

    const prepareSession = async () => {
      const hashParams = new URLSearchParams(
        window.location.hash.replace(/^#/, "")
      )
      const code = searchParams.get("code")
      const tokenHash = searchParams.get("token_hash")
      const type = searchParams.get("type")
      const recovery = searchParams.get("recovery")
      const accessToken = hashParams.get("access_token")
      const refreshToken = hashParams.get("refresh_token")
      const hashType = hashParams.get("type")
      const hashError =
        hashParams.get("error_description") ||
        hashParams.get("error")
      const queryError =
        searchParams.get("error_description") ||
        searchParams.get("error")
      const hasRecoveryMarker =
        localStorage.getItem(PASSWORD_RECOVERY_KEY) === "true"
      const hasRecoveryToken =
        Boolean(code || tokenHash || accessToken || refreshToken) ||
        type === "recovery" ||
        hashType === "recovery" ||
        recovery === "1"

      if (hashError || queryError) {
        failRecovery()
        return
      }

      if (code) {
        const { error: exchangeError } =
          await supabase.auth.exchangeCodeForSession(code)

        if (exchangeError) {
          failRecovery()
          return
        }

        markValidRecovery()
        window.history.replaceState(null, "", "/reset-password")
        return
      }

      if (tokenHash && type === "recovery") {
        const { error: verifyError } = await supabase.auth.verifyOtp({
          token_hash: tokenHash,
          type: "recovery",
        })

        if (verifyError) {
          failRecovery()
          return
        }

        markValidRecovery()
        window.history.replaceState(null, "", "/reset-password")
        return
      }

      if (accessToken && refreshToken) {
        const { error: sessionError } = await supabase.auth.setSession({
          access_token: accessToken,
          refresh_token: refreshToken,
        })

        if (sessionError) {
          failRecovery()
          return
        }

        markValidRecovery()
        window.history.replaceState(null, "", "/reset-password")
        return
      }

      const { data: existingData } = await supabase.auth.getSession()

      if (existingData.session && (hasRecoveryMarker || hasRecoveryToken)) {
        markValidRecovery()
        window.history.replaceState(null, "", "/reset-password")
        return
      }

      failRecovery()
    }

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") {
        markValidRecovery()
      }
    })

    prepareSession()

    return () => {
      mounted = false
      subscription.unsubscribe()
    }
  }, [router, searchParams])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError("")

    const passwordError = validatePassword(password)

    if (passwordError) {
      setError(passwordError)
      return
    }

    if (password !== confirmPassword) {
      setError("Las contraseñas no coinciden.")
      return
    }

    if (!canChangePassword) {
      setError(getInvalidLinkMessage())
      return
    }

    setLoading(true)

    try {
      const { error: updateError } = await supabase.auth.updateUser({
        password,
      })

      if (updateError) {
        setError(getPasswordUpdateMessage(updateError.message))
        setLoading(false)
        return
      }

      await goLoginLoggedOut()
    } catch {
      setError("No se pudo actualizar la contraseña. Intentá nuevamente.")
      setLoading(false)
    }
  }

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-black px-4 py-10 text-white">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_28%_18%,rgba(17,42,67,0.55),transparent_34%),linear-gradient(180deg,rgba(10,23,37,0.78),rgba(0,0,0,0.92))]" />
      <div
        aria-hidden="true"
        className="absolute inset-x-0 top-0 h-px bg-beyonix-blue-light/24"
      />

      <section className="relative z-10 w-full max-w-lg rounded-2xl border border-beyonix-blue-light/30 bg-[linear-gradient(145deg,rgba(15,28,42,0.98),rgba(10,16,23,0.98))] p-6 shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_24px_70px_rgba(0,0,0,0.44)] sm:p-7">
        <div className="mb-6 flex items-start gap-4">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-beyonix-blue-light/30 bg-beyonix-blue/34 text-white shadow-[0_0_22px_rgba(30,77,123,0.18)]">
            <ShieldCheck className="size-5" />
          </div>
          <div>
            <p className="mb-2 text-11px font-semibold uppercase tracking-widest text-beyonix-sky">
              Acceso seguro
            </p>
            <h1 className="text-3xl font-bold tracking-tight text-white">
              Nueva contraseña
            </h1>
            <p className="mt-2 max-w-sm text-sm leading-6 text-white/68">
              Creá una clave nueva para recuperar tu cuenta BEYONIX.
            </p>
          </div>
        </div>

        {checkingSession ? (
          <div className="flex h-36 flex-col items-center justify-center rounded-xl border border-white/10 bg-[#1b1f24] text-center">
            <Loader2 className="size-6 animate-spin text-beyonix-sky" />
            <p className="mt-3 text-sm text-white/62">
              Validando enlace de recuperación...
            </p>
          </div>
        ) : canChangePassword ? (
          <form onSubmit={handleSubmit} className="space-y-3.5">
            <div>
              <label htmlFor="new-password" className="mb-2 block text-sm font-medium text-white/82">
                Contraseña nueva
              </label>
              <div className="relative">
                <input
                  id="new-password"
                  type={showPassword ? "text" : "password"}
                  aria-label="Contraseña nueva"
                  required
                  value={password}
                  maxLength={FIELD_LIMITS.password}
                  autoComplete="new-password"
                  onChange={(e) => setPassword(e.target.value)}
                  className="h-10 w-full rounded-xl border border-white/10 bg-[#1b1f24] px-3.5 pr-11 text-sm text-white outline-none transition-all placeholder:text-white/40 hover:border-beyonix-blue-light/45 focus:border-beyonix-sky/70 focus:ring-2 focus:ring-beyonix-blue-light/24"
                />
                <button
                  type="button"
                  aria-label={showPassword ? "Ocultar contraseña" : "Mostrar contraseña"}
                  onClick={() => setShowPassword((current) => !current)}
                  className="absolute right-2 top-1/2 flex size-8 -translate-y-1/2 cursor-pointer items-center justify-center rounded-lg text-white/55 transition hover:bg-white/6 hover:text-white"
                >
                  {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>
            </div>

            <div>
              <label htmlFor="confirm-password" className="mb-2 block text-sm font-medium text-white/82">
                Repetir contraseña
              </label>
              <div className="relative">
                <input
                  id="confirm-password"
                  type={showConfirmPassword ? "text" : "password"}
                  aria-label="Repetir contraseña"
                  required
                  value={confirmPassword}
                  maxLength={FIELD_LIMITS.password}
                  autoComplete="new-password"
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="h-10 w-full rounded-xl border border-white/10 bg-[#1b1f24] px-3.5 pr-11 text-sm text-white outline-none transition-all placeholder:text-white/40 hover:border-beyonix-blue-light/45 focus:border-beyonix-sky/70 focus:ring-2 focus:ring-beyonix-blue-light/24"
                />
                <button
                  type="button"
                  aria-label={showConfirmPassword ? "Ocultar contraseña repetida" : "Mostrar contraseña repetida"}
                  onClick={() => setShowConfirmPassword((current) => !current)}
                  className="absolute right-2 top-1/2 flex size-8 -translate-y-1/2 cursor-pointer items-center justify-center rounded-lg text-white/55 transition hover:bg-white/6 hover:text-white"
                >
                  {showConfirmPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>
            </div>

            <PasswordRequirements password={password} />

            {error && (
              <div className="flex gap-2 rounded-xl border border-red-500/24 bg-red-500/10 px-4 py-3 text-sm text-red-300">
                <AlertCircle className="mt-0.5 size-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <button
              type="submit"
              aria-label="Guardar contraseña nueva"
              disabled={loading}
              className="flex h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-xl border border-beyonix-blue-light/48 bg-beyonix-blue px-5 font-heading text-sm font-semibold text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_14px_34px_rgba(0,0,0,0.35)] transition-all hover:border-beyonix-blue-light/75 hover:bg-beyonix-blue-hover focus-visible:ring-2 focus-visible:ring-beyonix-blue-light/25 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading ? (
                <Loader2 className="size-5 animate-spin" />
              ) : (
                <>
                  Guardar contraseña
                  <ArrowRight className="size-4" />
                </>
              )}
            </button>
          </form>
        ) : (
          <div className="space-y-4">
            <div className="flex gap-3 rounded-xl border border-red-500/24 bg-red-500/10 px-4 py-3 text-sm text-red-300">
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
              <span>{error || getInvalidLinkMessage()}</span>
            </div>
            <button
              type="button"
              onClick={() => router.replace("/login")}
              className="flex h-11 w-full cursor-pointer items-center justify-center rounded-xl border border-beyonix-blue-light/24 bg-[#1b1f24] text-sm font-semibold text-white/86 transition hover:border-beyonix-blue-light/45 hover:bg-[#22272e]"
            >
              Volver al inicio de sesión
            </button>
          </div>
        )}
      </section>
    </main>
  )
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={null}>
      <ResetPasswordContent />
    </Suspense>
  )
}
