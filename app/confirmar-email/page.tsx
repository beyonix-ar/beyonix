"use client"

import { Suspense, useCallback, useEffect, useRef, useState } from "react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react"

import { BeyonixLogoLink } from "@/components/beyonix-logo-link"
import {
  createConfirmationLinkController,
  type ConfirmationLinkController,
} from "@/lib/auth/confirmation-flow-controller"
import {
  resolveConfirmationLink,
  type ConfirmationLinkParams,
} from "@/lib/auth/confirmation-link"
import { supabase } from "@/lib/supabase/client"

const INVALID_LINK_MESSAGE =
  "El enlace venció o ya fue utilizado. Solicitá un nuevo correo de confirmación."
const AUTH_LAST_ACTIVITY_KEY = "beyonix-auth-last-activity"

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

async function persistActivatedSession(userId: string) {
  // verifyOtp/exchangeCodeForSession ya persisten la sesión. No hay que
  // renovarla aquí: otra pestaña puede rotar el refresh token al mismo tiempo
  // y convertir una confirmación válida en un error.
  const {
    data: { session: currentSession },
  } = await supabase.auth.getSession()

  if (!currentSession || currentSession.user.id !== userId) {
    throw new Error("No pudimos conservar la sesión confirmada.")
  }
}

function ConfirmEmailContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const mountedRef = useRef(true)
  // El controlador (lib/auth/confirmation-flow-controller.ts) decide una
  // única vez, al parsear los params en el mount, si hace falta gatear
  // detrás de un click humano -- y garantiza que confirm() sólo dispare
  // resolveConfirmationLink() (verifyOtp/exchangeCodeForSession) una sola
  // vez sin importar cuántas veces se lo llame.
  const controllerRef = useRef<ConfirmationLinkController | null>(null)
  // true = mostrar la pantalla intermedia con el botón "Confirmar mi
  // cuenta" -- distinto de un loader genuino sin decisión tomada todavía.
  const [needsConfirmation, setNeedsConfirmation] = useState(false)
  // Mientras el click está en vuelo: el botón queda visible pero
  // deshabilitado con spinner, aunque la protección real contra doble
  // consumo vive en el controller (más abajo), no en este flag visual.
  const [confirming, setConfirming] = useState(false)
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

  const finishConfirmation = useCallback(
    async (resolution: Awaited<ReturnType<typeof resolveConfirmationLink>>) => {
      if (!mountedRef.current) return

      if (resolution.status !== "confirmed") {
        setConfirming(false)
        setError(INVALID_LINK_MESSAGE)
        return
      }

      window.history.replaceState(null, "", "/confirmar-email")

      try {
        await activateConfirmedAccount(resolution.accessToken)
        await persistActivatedSession(resolution.userId)
        recordConfirmationActivity()
        if (!mountedRef.current) return
        setConfirmed(true)
      } catch {
        if (!mountedRef.current) return
        setConfirming(false)
        setError("No pudimos activar tu cuenta. Intentá nuevamente.")
      }
    },
    [],
  )

  const handleConfirmClick = useCallback(() => {
    if (!controllerRef.current) return

    // Debe ocurrir antes de SIGNED_IN. La pestaña original aplica el
    // vencimiento de 30 minutos apenas recibe ese evento.
    recordConfirmationActivity()
    // Deshabilita el botón en el mismo tick del click (antes del `await`).
    // La protección real contra doble consumo es el controller (confirm()
    // cachea la promesa en curso); esto es sólo feedback visual.
    setConfirming(true)
    void controllerRef.current.confirm().then(finishConfirmation)
  }, [finishConfirmation])

  useEffect(() => {
    mountedRef.current = true

    const code = searchParams.get("code")
    const tokenHash = searchParams.get("token_hash")
    const type = searchParams.get("type")

    if (type === "recovery") {
      const resetParams = new URLSearchParams()

      if (code) resetParams.set("code", code)
      if (tokenHash) resetParams.set("token_hash", tokenHash)
      resetParams.set("type", type)

      router.replace(`/reset-password?${resetParams.toString()}`)
    } else {
      const params: ConfirmationLinkParams = { code, tokenHash, type }
      const controller = createConfirmationLinkController(supabase.auth, params)
      controllerRef.current = controller

      // Objetivo central de este diseño: un GET/render automático (bot,
      // escáner de seguridad de email, prefetch, preview) NUNCA debe
      // ejecutar verifyOtp/exchangeCodeForSession. Si hay un token
      // realmente consumible, se detiene acá y espera el click humano en
      // handleConfirmClick -- confirm() es lo único que llama a
      // resolveConfirmationLink.
      if (controller.needsConfirmation) {
        setNeedsConfirmation(true)
      } else {
        setError(INVALID_LINK_MESSAGE)
      }
    }

    return () => {
      mountedRef.current = false
    }
  }, [router, searchParams])

  const primaryButtonClassName =
    "beyonix-confirm-primary-button mt-5 flex h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-xl bg-white text-sm font-semibold text-black transition-colors duration-200 hover:opacity-90 active:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-beyonix-blue-light/50 disabled:cursor-not-allowed disabled:opacity-60"

  return (
    <div className="confirmar-email-scope flex min-h-screen flex-col bg-[var(--account-background)]">
      <header className="border-b border-[var(--account-border)] bg-[var(--account-background)]">
        <nav className="container mx-auto px-4 lg:px-8">
          <div className="flex h-16 items-center justify-center lg:h-18">
            <BeyonixLogoLink />
          </div>
        </nav>
      </header>

      <main className="flex flex-1 items-center justify-center px-4 py-6">
        <div className="w-full max-w-md rounded-2xl border border-[var(--account-border)] bg-[var(--account-surface-raised)] p-6 text-center shadow-2xl shadow-black/35">
          <div
            className={`mx-auto flex size-16 items-center justify-center rounded-full border ${
              error
                ? "border-[var(--account-danger-border)] bg-[var(--account-danger-bg)]"
                : confirmed
                  ? "border-[var(--account-success-border)] bg-[var(--account-success-bg)]"
                  : "border-[var(--account-border)] bg-[var(--account-surface-hover)]"
            }`}
          >
            {error ? (
              <AlertCircle className="size-10 text-[var(--account-danger-text)]" />
            ) : confirmed ? (
              <CheckCircle2 className="size-10 text-[var(--account-success-text)]" />
            ) : (
              <Loader2 className="size-8 animate-spin text-[var(--account-accent)]" />
            )}
          </div>

          <h1 className="mt-5 text-2xl font-bold text-[var(--account-text-primary)]">
            {error
              ? "No pudimos confirmar tu cuenta"
              : confirmed
                ? "Cuenta confirmada"
                : needsConfirmation
                  ? "Confirmá tu cuenta"
                  : "Confirmando tu cuenta"}
          </h1>

          {error ? (
            <>
              <p className="mt-4 rounded-xl border border-[var(--account-danger-border)] bg-[var(--account-danger-bg)] px-4 py-3 text-sm text-[var(--account-danger-text)]">
                {error}
              </p>

              <Link href="/login" className={primaryButtonClassName}>
                Volver al inicio de sesión
              </Link>
            </>
          ) : confirmed ? (
            <>
              <p className="mt-3 text-sm leading-6 text-[var(--account-text-secondary)]">
                La pestaña donde te registraste te llevará al Home en un
                segundo. Esta pestaña se cerrará automáticamente si Chrome lo
                permite.
              </p>

              <button
                type="button"
                onClick={() => window.close()}
                className={primaryButtonClassName}
              >
                Cerrar esta pestaña
              </button>
            </>
          ) : needsConfirmation ? (
            <>
              <p className="mt-3 text-sm leading-6 text-[var(--account-text-secondary)]">
                Para activar tu cuenta de BEYONIX, confirmá que fuiste vos
                quien se registró.
              </p>

              <button
                type="button"
                aria-label="Confirmar mi cuenta"
                onClick={handleConfirmClick}
                disabled={confirming}
                className={primaryButtonClassName}
              >
                {confirming ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  "Confirmar mi cuenta"
                )}
              </button>
            </>
          ) : (
            <p className="mt-3 text-sm leading-6 text-[var(--account-text-secondary)]">
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
    <Suspense fallback={<div className="min-h-screen bg-[var(--account-background)]" />}>
      <ConfirmEmailContent />
    </Suspense>
  )
}
