"use client"

import { Suspense, useEffect, useState } from "react"
import { useSearchParams } from "next/navigation"
import { Loader2 } from "lucide-react"

import { supabase } from "@/lib/supabase/client"

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

function ResetPasswordContent() {
  const searchParams = useSearchParams()
  const [password, setPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)
  const [checkingSession, setCheckingSession] = useState(true)
  const [hasSession, setHasSession] = useState(false)

  const goHome = () => {
    window.location.href = "/"
  }

  useEffect(() => {
    const prepareSession = async () => {
      const {
        data: { session: existingSession },
      } = await supabase.auth.getSession()

      if (existingSession) {
        setHasSession(true)
        setCheckingSession(false)
        return
      }

      const hashParams = new URLSearchParams(
        window.location.hash.replace(/^#/, "")
      )
      const code = searchParams.get("code")
      const tokenHash = searchParams.get("token_hash")
      const type = searchParams.get("type")
      const accessToken = hashParams.get("access_token")
      const refreshToken = hashParams.get("refresh_token")
      const hashError =
        hashParams.get("error_description") ||
        hashParams.get("error")
      const queryError =
        searchParams.get("error_description") ||
        searchParams.get("error")

      if (hashError || queryError) {
        setError("El enlace no es válido o expiró. Pedí un nuevo email de recuperación.")
        setHasSession(false)
        setCheckingSession(false)
        return
      }

      if (code) {
        const { error: exchangeError } =
          await supabase.auth.exchangeCodeForSession(code)

        if (exchangeError) {
          setError("El enlace no es válido o expiró. Pedí un nuevo email de recuperación.")
          setHasSession(false)
          setCheckingSession(false)
          return
        }
      }

      if (tokenHash && type === "recovery") {
        const { error: verifyError } = await supabase.auth.verifyOtp({
          token_hash: tokenHash,
          type: "recovery",
        })

        if (verifyError) {
          setError("El enlace no es válido o expiró. Pedí un nuevo email de recuperación.")
          setHasSession(false)
          setCheckingSession(false)
          return
        }
      }

      if (accessToken && refreshToken) {
        const { error: sessionError } = await supabase.auth.setSession({
          access_token: accessToken,
          refresh_token: refreshToken,
        })

        if (sessionError) {
          setError("El enlace no es válido o expiró. Pedí un nuevo email de recuperación.")
          setHasSession(false)
          setCheckingSession(false)
          return
        }
      }

      const {
        data: { session },
      } = await supabase.auth.getSession()

      setHasSession(Boolean(session))
      setCheckingSession(false)

      if (code || tokenHash || accessToken) {
        window.history.replaceState(null, "", window.location.pathname)
      }
    }

    prepareSession()
  }, [searchParams])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError("")

    if (password.length <= 6) {
      setError("La contraseña debe tener más de 6 caracteres.")
      return
    }

    if (!/[A-Z]/.test(password)) {
      setError("La contraseña debe incluir al menos una mayúscula.")
      return
    }

    if (!/[0-9]/.test(password)) {
      setError("La contraseña debe incluir al menos un número.")
      return
    }

    if (password !== confirmPassword) {
      setError("Las contraseñas no coinciden.")
      return
    }

    setLoading(true)

    const fallbackRedirect = window.setTimeout(goHome, 5000)

    try {
      const { error: updateError } = await supabase.auth.updateUser({
        password,
      })

      window.clearTimeout(fallbackRedirect)

      if (updateError) {
        setError(getPasswordUpdateMessage(updateError.message))
        setLoading(false)
        return
      }

      goHome()
    } catch {
      window.clearTimeout(fallbackRedirect)
      setError("No se pudo actualizar la contraseña. Intentá nuevamente.")
      setLoading(false)
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-black px-4 pb-10 pt-24">
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
        ) : hasSession ? (
          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label className="mb-2 block text-sm text-white/80">
                Contraseña nueva
              </label>
              <input
                type="password"
                aria-label="Contraseña nueva"
                title="Contraseña nueva"
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
                title="Repetir contraseña"
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
              title="Guardar contraseña nueva"
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
          <div className="space-y-5">
            <div className="rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
              El enlace no es válido o expiró. Pedí un nuevo email de recuperación.
            </div>
            <a
              href="/"
              aria-label="Volver al inicio"
              title="Volver al inicio"
              className="flex h-12 w-full items-center justify-center rounded-xl bg-white font-semibold text-black transition-opacity hover:opacity-90 cursor-pointer"
            >
              Volver al inicio
            </a>
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
