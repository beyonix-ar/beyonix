"use client"

import { Suspense, useEffect, useRef, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react"
import type { EmailOtpType, Session } from "@supabase/supabase-js"

import { BeyonixLogoLink } from "@/components/beyonix-logo-link"
import { supabase } from "@/lib/supabase/client"

const INVALID_LINK_MESSAGE =
  "El enlace venció o ya fue utilizado. Solicitá un nuevo correo de confirmación."
const AUTH_LAST_ACTIVITY_KEY = "beyonix-auth-last-activity"
const CONFIRMATION_OTP_TYPES = new Set<EmailOtpType>([
  "signup",
  "email",
  "invite",
  "magiclink",
])

function getConfirmationOtpType(type: string | null): EmailOtpType {
  return type && CONFIRMATION_OTP_TYPES.has(type)
    ? type
    : "signup"
}

function recordConfirmationActivity() {
  localStorage.setItem(AUTH_LAST_ACTIVITY_KEY, String(Date.now()))
}

async function activateConfirmedAccount(accessToken: string) {
  const response = await fetch("/api/auth/confirm-email", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  })
  const data = (await response.json()) as {
    error?: string
  }

  if (!response.ok) {
    throw new Error(data.error || "No pudimos activar tu cuenta.")
  }
}

async function persistActivatedSession(confirmationSession: Session) {
  // verifyOtp/exchangeCodeForSession ya persisten la sesión. No hay que
  // renovarla aquí: otra pestaña puede rotar el refresh token al mismo tiempo
  // y convertir una confirmación válida en un error.
  const {
    data: { session: currentSession },
  } = await supabase.auth.getSession()

  if (
    !currentSession ||
    currentSession.user.id !== confirmationSession.user.id
  ) {
    throw new Error("No pudimos conservar la sesión confirmada.")
  }
}

function ConfirmEmailContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const hasConfirmed = useRef(false)
  const [error, setError] = useState("")
  const [confirmed, setConfirmed] = useState(false)

  useEffect(() => {
    if (!confirmed) return

    const closeTimeout = window.setTimeout(() => {
      window.opener?.focus()
      window.close()
    }, 1500)

    return () => window.clearTimeout(closeTimeout)
  }, [confirmed])

  useEffect(() => {
    if (hasConfirmed.current) return

    hasConfirmed.current = true

    const confirmEmail = async () => {
      const code = searchParams.get("code")
      const tokenHash = searchParams.get("token_hash")
      const type = searchParams.get("type")
      const confirmationType = getConfirmationOtpType(type)

      if (type === "recovery") {
        const resetParams = new URLSearchParams()

        if (code) resetParams.set("code", code)
        if (tokenHash) resetParams.set("token_hash", tokenHash)
        resetParams.set("type", type)

        router.replace(`/reset-password?${resetParams.toString()}`)
        return
      }

      let confirmationSession: Session | null = null

      if (tokenHash) {
        // Debe ocurrir antes de SIGNED_IN. La pestaña original aplica el
        // vencimiento de 30 minutos apenas recibe ese evento.
        recordConfirmationActivity()
        const { data, error } = await supabase.auth.verifyOtp({
          token_hash: tokenHash,
          type: confirmationType,
        })

        if (error) {
          setError(INVALID_LINK_MESSAGE)
          return
        }

        window.history.replaceState(null, "", "/confirmar-email")
        confirmationSession = data.session
      } else if (code) {
        recordConfirmationActivity()
        const { data, error } = await supabase.auth.exchangeCodeForSession(code)

        if (error) {
          setError(INVALID_LINK_MESSAGE)
          return
        }

        window.history.replaceState(null, "", "/confirmar-email")
        confirmationSession = data.session
      } else {
        setError(INVALID_LINK_MESSAGE)
        return
      }

      if (!confirmationSession) {
        await supabase.auth.signOut({ scope: "local" })
        setError(INVALID_LINK_MESSAGE)
        return
      }

      try {
        await activateConfirmedAccount(confirmationSession.access_token)
        await persistActivatedSession(confirmationSession)
        recordConfirmationActivity()
        setConfirmed(true)
      } catch {
        setError("No pudimos activar tu cuenta. Intentá nuevamente.")
      }
    }

    confirmEmail()
  }, [router, searchParams])

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
            {error ? (
              <AlertCircle className="size-10 text-red-400" />
            ) : confirmed ? (
              <CheckCircle2 className="size-10 text-emerald-400" />
            ) : (
              <Loader2 className="size-8 animate-spin text-emerald-400" />
            )}
          </div>

          <h1 className="mt-5 text-2xl font-bold text-white">
            {confirmed ? "Cuenta confirmada" : "Confirmando tu cuenta"}
          </h1>

          {error ? (
            <p className="mt-4 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
              {error}
            </p>
          ) : confirmed ? (
            <>
              <p className="mt-3 text-sm leading-6 text-white/60">
                La pestaña donde te registraste te llevará al Home en un
                segundo. Esta pestaña se cerrará automáticamente si Chrome lo
                permite.
              </p>

              <button
                type="button"
                onClick={() => window.close()}
                className="mt-5 flex h-11 w-full cursor-pointer items-center justify-center rounded-xl bg-white text-sm font-semibold text-black transition-opacity hover:opacity-90"
              >
                Cerrar esta pestaña
              </button>
            </>
          ) : (
            <p className="mt-3 text-sm leading-6 text-white/60">
              Estamos validando tu email. Te vamos a redirigir automáticamente.
            </p>
          )}
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
