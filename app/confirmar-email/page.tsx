"use client"

import { Suspense, useEffect, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { CheckCircle2, Loader2 } from "lucide-react"

import { BeyonixLogoLink } from "@/components/beyonix-logo-link"
import { supabase } from "@/lib/supabase/client"

function ConfirmEmailContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const tokenHash = searchParams.get("token_hash") ?? ""
  const code = searchParams.get("code") ?? ""
  const [loading, setLoading] = useState(false)
  const [checkingSession, setCheckingSession] = useState(true)
  const [hasSession, setHasSession] = useState(false)
  const [error, setError] = useState("")

  useEffect(() => {
    supabase.auth
      .getSession()
      .then(({ data }) => {
        setHasSession(Boolean(data.session))
      })
      .catch(() => {
        setError("No pudimos validar el enlace. Recargá la página.")
      })
      .finally(() => {
        setCheckingSession(false)
      })
  }, [])

  const handleConfirm = async () => {
    if (loading) return

    setLoading(true)
    setError("")

    if (tokenHash) {
      const { error: verificationError } = await supabase.auth.verifyOtp({
        token_hash: tokenHash,
        type: "email",
      })

      if (verificationError) {
        setLoading(false)
        setError(
          "El enlace de confirmación venció o ya fue utilizado. Solicitá un correo nuevo."
        )
        return
      }
    } else if (code) {
      const { error: exchangeError } =
        await supabase.auth.exchangeCodeForSession(code)

      if (exchangeError) {
        setLoading(false)
        setError(
          "El enlace de confirmación venció o ya fue utilizado. Solicitá un correo nuevo."
        )
        return
      }
    }

    const {
      data: { session },
    } = await supabase.auth.getSession()

    if (!session) {
      setLoading(false)
      setError(
        "Este enlace no contiene una confirmación válida. Solicitá un correo nuevo."
      )
      return
    }

    const response = await fetch("/api/auth/confirm-email", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.access_token}`,
      },
    })
    const result = await response.json()

    if (!response.ok) {
      setLoading(false)
      setError(result.error || "No pudimos confirmar tu cuenta.")
      return
    }

    const { error: refreshError } = await supabase.auth.refreshSession()

    if (refreshError) {
      setLoading(false)
      setError("La cuenta se activó, pero no pudimos iniciar la sesión.")
      return
    }

    router.replace("/")
    router.refresh()
  }

  const canConfirm =
    !checkingSession && Boolean(tokenHash || code || hasSession)

  return (
    <div className="flex min-h-screen flex-col bg-black">
      <header className="border-b border-white/10 bg-black">
        <nav className="container mx-auto px-4 lg:px-8">
          <div className="flex h-16 items-center justify-center lg:h-18">
            <BeyonixLogoLink />
          </div>
        </nav>
      </header>

      <main className="flex flex-1 items-center justify-center px-4 py-6">
        <div className="w-full max-w-md rounded-2xl border border-white/10 bg-beyonix-surface-4 p-6 text-center shadow-2xl shadow-black/35">
          <div className="mx-auto flex size-16 items-center justify-center rounded-full border border-emerald-400/25 bg-emerald-500/10">
            <CheckCircle2 className="size-10 text-emerald-400" />
          </div>

          <h1 className="mt-5 text-2xl font-bold text-white">
            Confirmá tu cuenta
          </h1>

          <p className="mt-3 text-sm leading-6 text-white/60">
            Presioná el botón para validar tu email y activar tu cuenta.
          </p>

          {error && (
            <p className="mt-4 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
              {error}
            </p>
          )}

          <button
            type="button"
            aria-label="Confirmar cuenta"
            title="Confirmar cuenta"
            onClick={handleConfirm}
            disabled={!canConfirm || loading}
            className="mt-6 flex h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-xl bg-white text-sm font-semibold text-black transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {(loading || checkingSession) && (
              <Loader2 className="size-4 animate-spin" />
            )}
            {loading ? "Confirmando..." : "Confirmar cuenta"}
          </button>
        </div>
      </main>
    </div>
  )
}

export default function ConfirmEmailPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-black" />}>
      <ConfirmEmailContent />
    </Suspense>
  )
}
