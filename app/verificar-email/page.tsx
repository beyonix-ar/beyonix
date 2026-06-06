"use client"

import { Suspense, useEffect, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { CheckCircle2, Loader2, RefreshCw } from "lucide-react"

import { BeyonixLogoLink } from "@/components/beyonix-logo-link"
import { supabase } from "@/lib/supabase/client"

function VerifyEmailContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const email = searchParams.get("email")?.trim().toLowerCase() ?? ""
  const [resending, setResending] = useState(false)
  const [message, setMessage] = useState("")
  const [cooldown, setCooldown] = useState(0)

  useEffect(() => {
    if (cooldown <= 0) return

    const timeout = window.setTimeout(() => {
      setCooldown((current) => Math.max(0, current - 1))
    }, 1000)

    return () => window.clearTimeout(timeout)
  }, [cooldown])

  const handleResend = async () => {
    if (!email || resending || cooldown > 0) return

    setResending(true)
    setMessage("")

    const { error } = await supabase.auth.resend({
      type: "signup",
      email,
      options: {
        emailRedirectTo: `${window.location.origin}/confirmar-email`,
      },
    })

    setResending(false)

    if (error) {
      setMessage(
        error.status === 429
          ? "Esperá unos minutos antes de volver a intentarlo."
          : "No pudimos reenviar el correo de confirmación."
      )
      return
    }

    setCooldown(60)
    setMessage("Correo reenviado. Puede demorar unos minutos en llegar.")
  }

  return (
    <div className="flex min-h-screen flex-col bg-black">
      <header className="border-b border-white/10 bg-black">
        <nav className="container mx-auto px-4 lg:px-8">
          <div className="flex h-16 items-center justify-center lg:h-18">
            <BeyonixLogoLink />
          </div>
        </nav>
      </header>

      <main className="flex flex-1 items-center justify-center px-4 py-4">
        <div className="w-full max-w-lg rounded-2xl border border-beyonix-blue-light/18 bg-beyonix-surface-4 p-6 text-center shadow-2xl shadow-black/35 lg:p-8">
          <div className="mx-auto flex size-16 items-center justify-center rounded-full border border-emerald-400/25 bg-emerald-500/10">
            <CheckCircle2 className="size-10 text-emerald-400" strokeWidth={2.25} />
          </div>

          <h1 className="mt-5 text-2xl font-bold text-white sm:text-3xl">
            Usuario creado con éxito
          </h1>

          <p className="mt-3 text-sm leading-6 text-white/68">
            Te enviamos un correo de confirmación. Revisá tu email para activar la cuenta.
          </p>

          {email && (
            <p className="mt-2 rounded-xl border border-white/8 bg-black px-4 py-3 text-sm font-semibold text-white">
              {email}
            </p>
          )}

          <p className="mt-4 text-sm leading-6 text-white/58">
            Abrí el enlace del correo para verificar tu cuenta antes de iniciar sesión.
          </p>

          <p className="mt-3 text-xs leading-5 text-white/42">
            Si no lo encontrás, revisá spam, promociones o correo no deseado.
          </p>

          <button
            type="button"
            onClick={handleResend}
            disabled={!email || resending || cooldown > 0}
            className="mt-5 flex h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-xl border border-white/12 bg-white/5 text-sm font-semibold text-white transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {resending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <RefreshCw className="size-4" />
            )}
            {resending
              ? "Reenviando..."
              : cooldown > 0
                ? `Reenviar en ${cooldown}s`
                : "Reenviar correo de confirmación"}
          </button>

          {message && (
            <p
              role="status"
              className={`mt-3 text-xs leading-5 ${
                message.startsWith("Correo reenviado")
                  ? "text-emerald-400"
                  : "text-red-400"
              }`}
            >
              {message}
            </p>
          )}

          <button
            type="button"
            onClick={() => router.replace("/login")}
            className="mt-3 flex h-11 w-full cursor-pointer items-center justify-center rounded-xl bg-white text-sm font-semibold text-black transition-opacity hover:opacity-90"
          >
            Volver al inicio de sesión
          </button>
        </div>
      </main>
    </div>
  )
}

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-black" />}>
      <VerifyEmailContent />
    </Suspense>
  )
}
