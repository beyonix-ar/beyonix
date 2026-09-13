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
const ACTIVATION_ERROR_MESSAGE =
  "Tu correo fue confirmado, pero no pudimos completar la activación de la cuenta. Intentá iniciar sesión o volvé a intentarlo."
const AUTH_LAST_ACTIVITY_KEY = "beyonix-auth-last-activity"

function recordConfirmationActivity() {
  localStorage.setItem(AUTH_LAST_ACTIVITY_KEY, String(Date.now()))
}

/**
 * TEMPORAL -- instrumentación de la máquina de estados de /confirmar-email
 * (auditoría 2026-09-14: Supabase Auth Logs confirman POST /verify 200 tanto
 * para el signup como para el login por magic link de la pestaña original,
 * pero esta pestaña igual mostraba el cartel de "enlace vencido" un par de
 * segundos antes de cerrarse). Sólo loguea: un instanceId corto por montaje
 * (para detectar dos instancias/remounts), ms transcurridos desde el mount,
 * el nombre del paso y un snapshot de los 4 flags de estado (booleans, nunca
 * su contenido). NUNCA loguea token_hash, access_token, JWT, cookies, email
 * ni passwords -- `detail` sólo lleva tags fijos definidos acá mismo, nunca
 * datos de la respuesta de Supabase. Sólo corre en el navegador (nunca en
 * los tests, que ejecutan en Node sin `window`). Remover una vez identificado
 * el origen exacto del error transitorio.
 */
function logConfirmFlowStep(
  instanceId: string,
  mountedAt: number,
  step: string,
  state: { confirming: boolean; confirmed: boolean; error: boolean; needsConfirmation: boolean },
  detail?: string,
) {
  if (typeof window === "undefined") return

  console.log(
    `CONFIRM_FLOW_TEMP_DIAGNOSTIC instance=${instanceId} tMs=${Date.now() - mountedAt} step=${step}${
      detail ? ` detail=${detail}` : ""
    } confirming=${state.confirming} confirmed=${state.confirmed} error=${state.error} needsConfirmation=${state.needsConfirmation}`,
  )
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

  // TEMPORAL -- ver logConfirmFlowStep. instanceRef se fija una única vez
  // (si dos instancias del componente llegan a existir -- StrictMode, un
  // remount real, etc. -- cada una loguea con un instanceId distinto).
  // stateRef se mantiene sincronizado en cada render para que los logs
  // emitidos desde dentro de callbacks (que closurean el estado de cuando
  // fueron creados) puedan reportar el último estado renderizado en vez de
  // un valor stale.
  const instanceRef = useRef<{ id: string; mountedAt: number } | null>(null)
  if (!instanceRef.current) {
    instanceRef.current = {
      id: Math.random().toString(36).slice(2, 8),
      mountedAt: Date.now(),
    }
  }
  const stateRef = useRef({ confirming, confirmed, error: Boolean(error), needsConfirmation })
  stateRef.current = { confirming, confirmed, error: Boolean(error), needsConfirmation }

  const logStep = useCallback((step: string, detail?: string) => {
    const { id, mountedAt } = instanceRef.current!
    logConfirmFlowStep(id, mountedAt, step, stateRef.current, detail)
  }, [])

  useEffect(() => {
    if (!confirmed) return

    logStep("close_scheduled")
    const closeTimeout = window.setTimeout(() => {
      logStep("close_attempt")
      window.opener?.focus()
      window.close()
    }, 1500)

    return () => window.clearTimeout(closeTimeout)
  }, [confirmed, logStep])

  const finishConfirmation = useCallback(
    async (resolution: Awaited<ReturnType<typeof resolveConfirmationLink>>) => {
      if (resolution.status !== "confirmed") {
        logStep("verify_failure")
      } else {
        logStep("verify_success", resolution.accessToken ? "with_session" : "no_session")
      }

      if (!mountedRef.current) return

      if (resolution.status !== "confirmed") {
        logStep("resolution_invalid")
        // El token de ESTE click puntual falló (ya usado/vencido), pero
        // puede no ser un fallo real: un doble click, dos pestañas abiertas
        // desde el mismo link de email, o el polling de la pestaña original
        // (/api/auth/confirmation-status, que corre en paralelo y también
        // persiste sesión vía su propio magic link) pueden haber consumido
        // el flujo de confirmación exitosamente ANTES de que esta respuesta
        // puntual llegue. Ambos casos comparten `localStorage` en el mismo
        // navegador/origen -- si ya hay una sesión válida acá, es evidencia
        // real de que la cuenta SÍ quedó confirmada, no una suposición.
        const {
          data: { session: existingSession },
        } = await supabase.auth.getSession()

        if (!mountedRef.current) return

        if (existingSession) {
          recordConfirmationActivity()
          logStep("set_confirmed", "existing_session_fallback")
          setConfirmed(true)
          return
        }

        setConfirming(false)
        logStep("set_error", "invalid_no_existing_session")
        setError(INVALID_LINK_MESSAGE)
        return
      }

      logStep("resolution_confirmed", resolution.accessToken ? "with_session" : "no_session")

      window.history.replaceState(null, "", "/confirmar-email")

      // verifyOtp confirmó el email (sin error) pero esta respuesta no trajo
      // sesión utilizable en esta pestaña (ver lib/auth/confirmation-link.ts).
      // Sin accessToken no hay forma de llamar a /api/auth/confirm-email
      // desde acá -- la activación y el login real los completa el polling
      // ya existente de /api/auth/confirmation-status en la pestaña
      // original. Mostrar éxito acá es correcto: el email SÍ quedó
      // confirmado.
      if (!resolution.accessToken || !resolution.userId) {
        recordConfirmationActivity()
        logStep("set_confirmed", "confirmed_no_access_token")
        setConfirmed(true)
        return
      }

      try {
        logStep("activation_start")
        await activateConfirmedAccount(resolution.accessToken)
        await persistActivatedSession(resolution.userId)
        recordConfirmationActivity()
        if (!mountedRef.current) return
        logStep("activation_success")
        logStep("set_confirmed", "full_success")
        setConfirmed(true)
      } catch {
        if (!mountedRef.current) return
        setConfirming(false)
        logStep("activation_failure")
        logStep("set_error", "activation_error")
        setError(ACTIVATION_ERROR_MESSAGE)
      }
    },
    [logStep],
  )

  const handleConfirmClick = useCallback(() => {
    if (!controllerRef.current) return

    logStep("click")
    // Debe ocurrir antes de SIGNED_IN. La pestaña original aplica el
    // vencimiento de 30 minutos apenas recibe ese evento.
    recordConfirmationActivity()
    // Deshabilita el botón en el mismo tick del click (antes del `await`).
    // La protección real contra doble consumo es el controller (confirm()
    // cachea la promesa en curso); esto es sólo feedback visual.
    setConfirming(true)
    logStep("verify_start")
    void controllerRef.current.confirm().then(finishConfirmation)
  }, [finishConfirmation, logStep])

  useEffect(() => {
    mountedRef.current = true
    logStep("mount")

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
        logStep("mount", "needs_confirmation")
        setNeedsConfirmation(true)
      } else {
        logStep("set_error", "no_consumable_token")
        setError(INVALID_LINK_MESSAGE)
      }
    }

    return () => {
      mountedRef.current = false
    }
  }, [router, searchParams, logStep])

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
                ? "Cuenta verificada con éxito"
                : confirming
                  ? "Confirmando tu cuenta..."
                  : needsConfirmation
                    ? "Confirmá tu cuenta"
                    : "Confirmando tu cuenta..."}
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
                Tu cuenta fue confirmada correctamente.
              </p>

              <button
                type="button"
                onClick={() => window.close()}
                className={primaryButtonClassName}
              >
                Cerrar esta pestaña
              </button>
            </>
          ) : confirming ? (
            <p className="mt-3 text-sm leading-6 text-[var(--account-text-secondary)]">
              Estamos validando tu correo.
            </p>
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
