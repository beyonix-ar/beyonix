"use client"

import { Suspense, useEffect, useRef, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { AlertCircle, Loader2 } from "lucide-react"

import { BeyonixLogoLink } from "@/components/beyonix-logo-link"
import { supabase } from "@/lib/supabase/client"

const INVALID_LINK_MESSAGE =
  "El enlace venció o ya fue utilizado. Solicitá un nuevo correo de confirmación."

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

      if (tokenHash) {
        window.history.replaceState(null, "", "/confirmar-email")
        const { error } = await supabase.auth.verifyOtp({
          token_hash: tokenHash,
          type: "signup",
        })

        if (error) {
          console.error("confirm-email error", error)
          setError(INVALID_LINK_MESSAGE)
          return
        }

        router.replace("/")
        return
      }

      if (code) {
        window.history.replaceState(null, "", "/confirmar-email")
        const { error } = await supabase.auth.exchangeCodeForSession(code)

        if (error) {
          console.error("confirm-email error", error)
          setError(INVALID_LINK_MESSAGE)
          return
        }

        router.replace("/")
        return
      }

      setError(INVALID_LINK_MESSAGE)
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
