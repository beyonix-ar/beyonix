"use client"

import { Suspense, useEffect, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { Loader2 } from "lucide-react"

import { supabase } from "@/lib/supabase/client"
import { validatePassword } from "@/lib/validation/account-fields"

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

  const goLoginLoggedOut = async () => {
    localStorage.removeItem("beyonix-password-recovery")
    await supabase.auth.signOut()
    router.replace("/login?reset=success")
  }

  useEffect(() => {
    let mounted = true

    const markValidRecovery = () => {
      localStorage.setItem("beyonix-password-recovery", "true")
      if (mounted) {
        setCanChangePassword(true)
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
        localStorage.getItem("beyonix-password-recovery") === "true"
      const hasRecoveryToken =
        Boolean(code || tokenHash || accessToken || refreshToken) ||
        type === "recovery" ||
        hashType === "recovery" ||
        recovery === "1"

      if (hashError || queryError) {
        setError(getInvalidLinkMessage())
        setCanChangePassword(false)
        setCheckingSession(false)
        return
      }

      if (code) {
        const { error: exchangeError } =
          await supabase.auth.exchangeCodeForSession(code)

        if (exchangeError) {
          setError(getInvalidLinkMessage())
          setCanChangePassword(false)
          setCheckingSession(false)
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
          setError(getInvalidLinkMessage())
          setCanChangePassword(false)
          setCheckingSession(false)
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
          setError(getInvalidLinkMessage())
          setCanChangePassword(false)
          setCheckingSession(false)
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

      setError(getInvalidLinkMessage())
      setCanChangePassword(false)
      setCheckingSession(false)
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
    <main className="flex min-h-screen items-center justify-center bg-black px-4 py-10">
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-beyonix-surface p-8 shadow-2xl">
        <div className="mb-8">
          <p className="mb-2 text-11px font-medium uppercase tracking-widest text-beyonix-focus">
            BEYONIX
          </p>
          <h1 className="text-3xl font-bold text-white">
            Nueva contraseña
          </h1>
          <p className="mt-2 text-sm text-white/65">
            Ingresá una contraseña nueva para recuperar el acceso a tu cuenta.
          </p>
        </div>

        {checkingSession ? (
          <div className="flex h-28 items-center justify-center">
            <Loader2 className="size-6 animate-spin text-white" />
          </div>
        ) : canChangePassword ? (
          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label className="mb-2 block text-sm text-white/80">
                Contraseña nueva
              </label>
              <input
                type="password"
                aria-label="Contraseña nueva"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="h-12 w-full rounded-xl border border-white/10 bg-black px-4 text-white outline-none transition-colors focus:border-beyonix-focus"
              />
            </div>

            <div>
              <label className="mb-2 block text-sm text-white/80">
                Repetir contraseña
              </label>
              <input
                type="password"
                aria-label="Repetir contraseña"
                required
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="h-12 w-full rounded-xl border border-white/10 bg-black px-4 text-white outline-none transition-colors focus:border-beyonix-focus"
              />
            </div>

            {error && (
              <div className="rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
                {error}
              </div>
            )}

            <button
              type="submit"
              aria-label="Guardar contraseña nueva"
              disabled={loading}
              className="flex h-12 w-full items-center justify-center rounded-xl bg-white font-semibold text-black transition-opacity hover:opacity-90 disabled:opacity-50 cursor-pointer"
            >
              {loading ? (
                <Loader2 className="size-5 animate-spin" />
              ) : (
                "Guardar contraseña"
              )}
            </button>
          </form>
        ) : (
          <div className="rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
            {error || getInvalidLinkMessage()}
          </div>
        )}
      </div>
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
