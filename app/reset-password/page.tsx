"use client"

import { Suspense, useEffect, useState } from "react"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  LockKeyhole,
  ShieldCheck,
} from "lucide-react"

import { BeyonixButton, BeyonixCard, BeyonixIconBox } from "@/components/beyonix-ui"
import { PasswordRequirements } from "@/components/password-requirements"
import {
  getInvalidRecoveryLinkMessage,
} from "@/lib/auth/password-update-messages"
import { supabase } from "@/lib/supabase/client"
import { FIELD_LIMITS, validatePassword } from "@/lib/validation/account-fields"

const PASSWORD_RECOVERY_KEY = "beyonix-password-recovery"

function ResetPasswordContent() {
  const searchParams = useSearchParams()
  const [password, setPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)
  const [checkingSession, setCheckingSession] = useState(true)
  const [canChangePassword, setCanChangePassword] = useState(false)
  const [accessToken, setAccessToken] = useState("")
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = useState(false)
  const [success, setSuccess] = useState(false)

  useEffect(() => {
    let mounted = true

    const markValidRecovery = async () => {
      const { data } = await supabase.auth.getSession()
      const token = data.session?.access_token ?? ""

      if (!mounted) return

      if (!token) {
        localStorage.removeItem(PASSWORD_RECOVERY_KEY)
        setError(getInvalidRecoveryLinkMessage())
        setCanChangePassword(false)
        setCheckingSession(false)
        return
      }

      localStorage.setItem(PASSWORD_RECOVERY_KEY, "true")
      setAccessToken(token)
      setCanChangePassword(true)
      setCheckingSession(false)
    }

    const failRecovery = () => {
      localStorage.removeItem(PASSWORD_RECOVERY_KEY)
      if (mounted) {
        setError(getInvalidRecoveryLinkMessage())
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
      const accessTokenParam = hashParams.get("access_token")
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
        Boolean(code || tokenHash || accessTokenParam || refreshToken) ||
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

        await markValidRecovery()
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

        await markValidRecovery()
        window.history.replaceState(null, "", "/reset-password")
        return
      }

      if (accessTokenParam && refreshToken) {
        const { error: sessionError } = await supabase.auth.setSession({
          access_token: accessTokenParam,
          refresh_token: refreshToken,
        })

        if (sessionError) {
          failRecovery()
          return
        }

        await markValidRecovery()
        window.history.replaceState(null, "", "/reset-password")
        return
      }

      const { data: existingData } = await supabase.auth.getSession()

      if (existingData.session && (hasRecoveryMarker || hasRecoveryToken)) {
        await markValidRecovery()
        window.history.replaceState(null, "", "/reset-password")
        return
      }

      failRecovery()
    }

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") {
        void markValidRecovery()
      }
    })

    prepareSession()

    return () => {
      mounted = false
      subscription.unsubscribe()
    }
  }, [searchParams])

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

    if (!canChangePassword || !accessToken) {
      setError(getInvalidRecoveryLinkMessage())
      return
    }

    setLoading(true)

    try {
      const response = await fetch("/api/auth/reset-password/confirm", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ password }),
      })
      const data = (await response.json().catch(() => null)) as
        | { ok?: boolean; error?: string }
        | null

      if (!response.ok || !data?.ok) {
        setError(data?.error || getInvalidRecoveryLinkMessage())
        setLoading(false)
        return
      }

      localStorage.removeItem(PASSWORD_RECOVERY_KEY)
      await supabase.auth.signOut()
      setLoading(false)
      setSuccess(true)
    } catch {
      setError("No se pudo actualizar la contraseña. Intentá nuevamente.")
      setLoading(false)
    }
  }

  return (
    <main className="min-h-screen bg-black text-white">
      <section className="relative overflow-hidden bg-beyonix-page">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_22%_14%,rgba(30,77,123,0.22),transparent_36%),radial-gradient(circle_at_82%_68%,rgba(74,144,184,0.09),transparent_30%)]"
        />

        <div className="relative mx-auto flex min-h-[calc(100vh-4rem)] max-w-lg flex-col justify-center px-4 pt-20 pb-16 sm:px-6 lg:pt-24">
          <BeyonixCard
            variant="elevated"
            className="p-6 shadow-[0_28px_80px_rgba(0,0,0,0.48)] sm:p-8"
          >
            {success ? (
              <div className="flex flex-col items-center text-center">
                <BeyonixIconBox variant="success" size="lg">
                  <CheckCircle2 className="size-6" strokeWidth={2.25} />
                </BeyonixIconBox>

                <h1 className="beyonix-modal-title mt-5 text-2xl font-bold tracking-tight sm:text-3xl">
                  Contraseña actualizada
                </h1>

                <p className="beyonix-modal-body mt-3 max-w-sm text-sm leading-6 text-white/68">
                  Ya podés iniciar sesión con tu nueva contraseña.
                </p>

                <BeyonixButton asChild className="mt-7 w-full">
                  <Link href="/login" aria-label="Iniciar sesión">
                    Iniciar sesión
                    <ArrowRight className="size-4" />
                  </Link>
                </BeyonixButton>
              </div>
            ) : (
              <>
                <div className="mb-6 flex items-start gap-4">
                  <BeyonixIconBox size="lg" className="shrink-0">
                    <KeyRound className="size-5" />
                  </BeyonixIconBox>
                  <div className="min-w-0">
                    <p className="text-11px font-semibold uppercase tracking-widest text-beyonix-cyan">
                      Acceso seguro
                    </p>
                    <h1 className="beyonix-modal-title mt-1 text-2xl font-bold tracking-tight sm:text-3xl">
                      Nueva contraseña
                    </h1>
                    <p className="beyonix-modal-body mt-2 text-sm leading-6 text-white/64">
                      Creá una clave nueva para recuperar el acceso a tu
                      cuenta BEYONIX.
                    </p>
                  </div>
                </div>

                {checkingSession ? (
                  <div className="flex h-36 flex-col items-center justify-center rounded-xl border border-beyonix-blue-light/14 bg-beyonix-surface text-center">
                    <Loader2 className="size-6 animate-spin text-beyonix-sky" />
                    <p className="beyonix-modal-body mt-3 text-sm text-white/60">
                      Validando enlace de recuperación...
                    </p>
                  </div>
                ) : canChangePassword ? (
                  <form onSubmit={handleSubmit} className="space-y-4">
                    <div>
                      <label
                        htmlFor="new-password"
                        className="mb-1.5 block text-xs font-semibold text-white/72"
                      >
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
                          className="h-11 w-full rounded-xl border border-white/10 bg-[#0b1118] px-3.5 pr-11 text-sm text-white outline-none transition-all placeholder:text-white/40 hover:border-beyonix-blue-light/45 focus:border-beyonix-sky/70 focus:ring-2 focus:ring-beyonix-blue-light/24"
                        />
                        <button
                          type="button"
                          aria-label={
                            showPassword ? "Ocultar contraseña" : "Mostrar contraseña"
                          }
                          onClick={() => setShowPassword((current) => !current)}
                          className="absolute right-2 top-1/2 flex size-8 -translate-y-1/2 cursor-pointer items-center justify-center rounded-lg text-white/55 transition hover:bg-white/6 hover:text-white"
                        >
                          {showPassword ? (
                            <EyeOff className="size-4" />
                          ) : (
                            <Eye className="size-4" />
                          )}
                        </button>
                      </div>
                    </div>

                    <PasswordRequirements password={password} />

                    <div>
                      <label
                        htmlFor="confirm-password"
                        className="mb-1.5 block text-xs font-semibold text-white/72"
                      >
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
                          className="h-11 w-full rounded-xl border border-white/10 bg-[#0b1118] px-3.5 pr-11 text-sm text-white outline-none transition-all placeholder:text-white/40 hover:border-beyonix-blue-light/45 focus:border-beyonix-sky/70 focus:ring-2 focus:ring-beyonix-blue-light/24"
                        />
                        <button
                          type="button"
                          aria-label={
                            showConfirmPassword
                              ? "Ocultar contraseña repetida"
                              : "Mostrar contraseña repetida"
                          }
                          onClick={() =>
                            setShowConfirmPassword((current) => !current)
                          }
                          className="absolute right-2 top-1/2 flex size-8 -translate-y-1/2 cursor-pointer items-center justify-center rounded-lg text-white/55 transition hover:bg-white/6 hover:text-white"
                        >
                          {showConfirmPassword ? (
                            <EyeOff className="size-4" />
                          ) : (
                            <Eye className="size-4" />
                          )}
                        </button>
                      </div>
                      {confirmPassword && password !== confirmPassword && (
                        <p className="mt-1.5 text-xs text-red-400">
                          Las contraseñas no coinciden.
                        </p>
                      )}
                    </div>

                    {error && (
                      <div className="flex gap-2 rounded-xl border border-red-500/24 bg-red-500/10 px-4 py-3 text-sm text-red-300">
                        <AlertCircle className="mt-0.5 size-4 shrink-0" />
                        <span>{error}</span>
                      </div>
                    )}

                    <BeyonixButton
                      type="submit"
                      aria-label="Guardar contraseña nueva"
                      disabled={loading}
                      size="lg"
                      className="w-full"
                    >
                      {loading ? (
                        <Loader2 className="size-5 animate-spin" />
                      ) : (
                        <>
                          Guardar contraseña
                          <ArrowRight className="size-4" />
                        </>
                      )}
                    </BeyonixButton>

                    <div className="flex items-center justify-center gap-2 border-t border-white/8 pt-4 text-xs text-white/38">
                      <ShieldCheck className="size-4 text-beyonix-cyan" />
                      Tu contraseña nunca queda guardada en BEYONIX.
                    </div>
                  </form>
                ) : (
                  <div className="space-y-4">
                    <div className="flex gap-3 rounded-xl border border-red-500/24 bg-red-500/10 px-4 py-4 text-sm text-red-300">
                      <AlertCircle className="mt-0.5 size-5 shrink-0" />
                      <div>
                        <p className="font-semibold text-red-200">
                          {error || getInvalidRecoveryLinkMessage()}
                        </p>
                        <p className="mt-1 text-xs leading-5 text-red-300/80">
                          Por seguridad, cada enlace de recuperación sólo se
                          puede usar una vez y vence a los pocos minutos de
                          haberlo recibido.
                        </p>
                      </div>
                    </div>

                    <BeyonixButton asChild className="w-full" size="lg">
                      <Link href="/login" aria-label="Solicitar un nuevo enlace">
                        <LockKeyhole className="size-4" />
                        Solicitar un nuevo enlace
                      </Link>
                    </BeyonixButton>
                  </div>
                )}
              </>
            )}
          </BeyonixCard>
        </div>
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
