"use client"

import { Suspense, useEffect, useRef, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { AlertCircle, Loader2 } from "lucide-react"

import { BeyonixLogoLink } from "@/components/beyonix-logo-link"
import { supabase } from "@/lib/supabase/client"

const INVALID_LINK_MESSAGE =
  "El enlace venció o ya fue utilizado. Solicitá un nuevo correo de confirmación."

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

function ConfirmEmailContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const hasConfirmed = useRef(false)
  const [error, setError] = useState("")

  useEffect(() => {
    if (hasConfirmed.current) return

    hasConfirmed.current = true

    const confirmEmail = async () => {
      const code = searchParams.get("code")
      const tokenHash = searchParams.get("token_hash")
      const type = searchParams.get("type")

      if (type === "recovery") {
        const resetParams = new URLSearchParams()

        if (code) resetParams.set("code", code)
        if (tokenHash) resetParams.set("token_hash", tokenHash)
        resetParams.set("type", type)

        router.replace(`/reset-password?${resetParams.toString()}`)
        return
      }

      let accessToken = ""

      if (tokenHash) {
        window.history.replaceState(null, "", "/confirmar-email")
        const { data, error } = await supabase.auth.verifyOtp({
          token_hash: tokenHash,
          type: "signup",
        })

        if (error) {
          setError(INVALID_LINK_MESSAGE)
          return
        }

        accessToken = data.session?.access_token ?? ""
      } else if (code) {
        window.history.replaceState(null, "", "/confirmar-email")
        const { data, error } = await supabase.auth.exchangeCodeForSession(code)

        if (error) {
          setError(INVALID_LINK_MESSAGE)
          return
        }

        accessToken = data.session?.access_token ?? ""
      } else {
        setError(INVALID_LINK_MESSAGE)
        return
      }

      if (!accessToken) {
        await supabase.auth.signOut({ scope: "local" })
        setError(INVALID_LINK_MESSAGE)
        return
      }

      try {
        await activateConfirmedAccount(accessToken)
        await supabase.auth.signOut({ scope: "local" })
        router.replace("/login?email-confirmed=1")
      } catch (activationError) {
        await supabase.auth.signOut({ scope: "local" })
        setError(
          activationError instanceof Error
            ? activationError.message
            : "No pudimos activar tu cuenta. Intentá nuevamente."
        )
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
            ) : (
              <Loader2 className="size-8 animate-spin text-emerald-400" />
            )}
          </div>

          <h1 className="mt-5 text-2xl font-bold text-white">
            Confirmando tu cuenta
          </h1>

          {error ? (
            <p className="mt-4 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
              {error}
            </p>
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
