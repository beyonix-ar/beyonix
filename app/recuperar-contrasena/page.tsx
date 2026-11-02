"use client"

import { Suspense, useEffect, useRef, useState } from "react"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { AlertCircle, ArrowLeft, KeyRound, Loader2, MailCheck } from "lucide-react"

import { BeyonixButton, BeyonixCard, BeyonixIconBox } from "@/components/beyonix-ui"
import { FORGOT_PASSWORD_GENERIC_MESSAGE } from "@/lib/auth/forgot-password-messages"
import { buildLoginHref } from "@/lib/auth/safe-redirect"
import { FIELD_LIMITS } from "@/lib/validation/account-fields"

// Cuenta regresiva visible para no reenviar en ráfaga; el límite real lo
// aplica el servidor (lib/auth/password-reset-rate-limit.ts).
const RESEND_COOLDOWN_SECONDS = 30

function RecoverPasswordContent() {
  const searchParams = useSearchParams()
  const loginHref = buildLoginHref(searchParams.get("redirect"))

  const [identifier, setIdentifier] = useState("")
  const [error, setError] = useState("")
  const [message, setMessage] = useState("")
  const [loading, setLoading] = useState(false)
  const [cooldown, setCooldown] = useState(0)
  const inFlight = useRef(false)

  useEffect(() => {
    if (cooldown <= 0) return
    const timeout = window.setTimeout(() => {
      setCooldown((current) => Math.max(0, current - 1))
    }, 1000)
    return () => window.clearTimeout(timeout)
  }, [cooldown])

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (inFlight.current || cooldown > 0) return

    const recoveryIdentifier = identifier.trim()
    if (!recoveryIdentifier) {
      setError("Ingresá tu email o usuario para continuar.")
      return
    }

    inFlight.current = true
    setLoading(true)
    setError("")
    setMessage("")

    try {
      // Toda la resolución usuario -> email, el rate limit y el envío viven
      // server-side (lib/auth/forgot-password.ts). La respuesta es la misma
      // exista o no la cuenta.
      const response = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: recoveryIdentifier }),
      })
      const data = (await response.json().catch(() => null)) as
        | { message?: string; error?: string }
        | null

      if (!response.ok) {
        setError(data?.error || "No pudimos procesar la solicitud. Intentá nuevamente.")
        return
      }

      setMessage(FORGOT_PASSWORD_GENERIC_MESSAGE)
      setCooldown(RESEND_COOLDOWN_SECONDS)
    } catch {
      setError("No pudimos procesar la solicitud. Intentá nuevamente.")
    } finally {
      inFlight.current = false
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
            <div className="mb-6 flex items-start gap-4">
              <BeyonixIconBox size="lg" className="shrink-0">
                <KeyRound className="size-5" />
              </BeyonixIconBox>
              <div className="min-w-0">
                <h1 className="beyonix-modal-title text-2xl font-bold tracking-tight sm:text-3xl">
                  Recuperar contraseña
                </h1>
                <p className="beyonix-modal-body mt-2 text-sm leading-6 text-white/64">
                  Ingresá tu email o usuario para recibir un enlace de recuperación.
                </p>
              </div>
            </div>

            <form onSubmit={handleSubmit} noValidate className="space-y-4">
              <div>
                <label
                  htmlFor="recovery-identifier"
                  className="mb-1.5 block text-xs font-semibold text-[var(--account-text-secondary)]"
                >
                  Email o usuario
                </label>
                <input
                  id="recovery-identifier"
                  name="identifier"
                  type="text"
                  required
                  value={identifier}
                  maxLength={FIELD_LIMITS.loginIdentifier}
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  placeholder="usuario.tech o nombre@email.com"
                  onChange={(event) => setIdentifier(event.target.value)}
                  className="h-11 w-full rounded-xl border border-[var(--account-border)] bg-[var(--account-input)] px-3.5 text-sm text-[var(--account-text-primary)] outline-none transition-all placeholder:text-[var(--account-text-placeholder)] hover:border-beyonix-blue-light/45 focus:border-beyonix-sky/70 focus:ring-2 focus:ring-beyonix-blue-light/24"
                />
              </div>

              {error && (
                <div
                  role="alert"
                  className="flex gap-2 rounded-xl border border-[var(--account-danger-border)] bg-[var(--account-danger-bg)] px-4 py-3 text-sm text-[var(--account-danger-text)]"
                >
                  <AlertCircle className="mt-0.5 size-4 shrink-0" />
                  <span>{error}</span>
                </div>
              )}

              {message && (
                <div
                  role="status"
                  className="flex items-start gap-3 rounded-xl border border-[var(--account-success-border)] bg-[var(--account-success-bg)] px-4 py-3.5"
                >
                  <MailCheck className="mt-0.5 size-5 shrink-0 text-[var(--account-success-text)]" />
                  <p className="text-sm leading-5 text-[var(--account-success-text)]">
                    {message}
                  </p>
                </div>
              )}

              <BeyonixButton
                type="submit"
                aria-label="Enviar enlace de recuperación"
                disabled={loading || cooldown > 0}
                size="lg"
                className="w-full"
              >
                {loading ? (
                  <Loader2 className="size-5 animate-spin" />
                ) : cooldown > 0 ? (
                  `Reintentar en ${cooldown}s`
                ) : (
                  "Enviar enlace de recuperación"
                )}
              </BeyonixButton>

              <Link
                href={loginHref}
                className="flex h-11 w-full items-center justify-center gap-2 rounded-xl text-sm font-semibold text-[var(--account-text-secondary)] underline decoration-2 decoration-transparent underline-offset-4 transition-colors duration-200 hover:text-[var(--account-accent)] hover:decoration-[var(--account-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-beyonix-blue-light/25"
              >
                <ArrowLeft className="size-4" />
                Volver a iniciar sesión
              </Link>
            </form>
          </BeyonixCard>
        </div>
      </section>
    </main>
  )
}

export default function RecoverPasswordPage() {
  return (
    <Suspense fallback={null}>
      <RecoverPasswordContent />
    </Suspense>
  )
}
