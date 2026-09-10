import "server-only"

import type { createAdminClient } from "../supabase/admin.ts"
import {
  hashForRateLimit,
  isResendConfirmationRateLimited,
  RESEND_CONFIRMATION_ATTEMPT_RETENTION_HOURS,
  type ResendConfirmationAttemptCounts,
} from "./resend-confirmation-rate-limit.ts"

type AdminClient = ReturnType<typeof createAdminClient>

const EMAIL_FORMAT = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const INVALID_EMAIL_MESSAGE = "Ingresá un email válido."
const UNAVAILABLE_MESSAGE =
  "El reenvío de confirmación no está disponible en este momento."
/**
 * Mismo mensaje siempre, esté la cuenta pendiente de confirmar, ya
 * confirmada, inexistente, o rate-limited -- ninguna de esas ramas debe
 * distinguirse desde afuera (ver nota en forgot-password.ts).
 */
export const RESEND_CONFIRMATION_GENERIC_MESSAGE =
  "Si la cuenta existe y está pendiente de confirmación, reenviamos el correo. Puede demorar unos minutos en llegar."

// Igual que forgot-password.ts: sin un piso mínimo, el tiempo de respuesta
// real (que sí llama a Supabase) sería distinguible de las ramas rate-limited.
const MIN_RESPONSE_MS = 500

type ResendConfirmationResult =
  | { ok: true; message: string }
  | { ok: false; status: number; error: string }

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null
  const trimmed = raw.trim().toLowerCase()
  if (!trimmed || trimmed.length > 254) return null
  if (!EMAIL_FORMAT.test(trimmed)) return null
  return trimmed
}

/**
 * Confirma que la tabla de rate limit existe ANTES de confiar en cualquier
 * conteo. Fail closed, mismo motivo que `rateLimitTableExists` en
 * password-reset-rate-limit: sin canaria, una migración pendiente se leería
 * como "0 intentos" y el rate limit quedaría inerte.
 */
async function rateLimitTableExists(admin: AdminClient): Promise<boolean> {
  const { error } = await admin
    .from("email_confirmation_resend_attempts")
    .select("id")
    .limit(1)

  return !error
}

async function countRecentAttempts(
  admin: AdminClient,
  identifierHash: string,
  ipHash: string | null,
  now: Date,
): Promise<ResendConfirmationAttemptCounts> {
  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString()
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()
  const table = () => admin.from("email_confirmation_resend_attempts")

  const [lastAttempt, identifierHour, identifierDay, ipHour, ipDay] =
    await Promise.all([
      table()
        .select("created_at")
        .eq("identifier_hash", identifierHash)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      table()
        .select("id", { count: "exact", head: true })
        .eq("identifier_hash", identifierHash)
        .gte("created_at", hourAgo),
      table()
        .select("id", { count: "exact", head: true })
        .eq("identifier_hash", identifierHash)
        .gte("created_at", dayAgo),
      ipHash
        ? table()
            .select("id", { count: "exact", head: true })
            .eq("ip_hash", ipHash)
            .gte("created_at", hourAgo)
        : Promise.resolve({ count: 0 }),
      ipHash
        ? table()
            .select("id", { count: "exact", head: true })
            .eq("ip_hash", ipHash)
            .gte("created_at", dayAgo)
        : Promise.resolve({ count: 0 }),
    ])

  const lastAttemptAt = lastAttempt.data?.created_at
    ? Date.parse(lastAttempt.data.created_at)
    : null

  return {
    secondsSinceLastIdentifierAttempt:
      lastAttemptAt && Number.isFinite(lastAttemptAt)
        ? Math.floor((now.getTime() - lastAttemptAt) / 1000)
        : null,
    identifierLastHour: Number(identifierHour.count ?? 0),
    identifierLastDay: Number(identifierDay.count ?? 0),
    ipLastHour: Number(ipHour.count ?? 0),
    ipLastDay: Number(ipDay.count ?? 0),
  }
}

export interface RequestConfirmationResendInput {
  admin: AdminClient
  emailRaw: unknown
  ip: string | null
  siteUrl: string | null
}

/**
 * Orquesta "reenviar correo de confirmación" de punta a punta: normaliza el
 * email, aplica rate limiting persistente (identificador + IP, con piso de
 * `RESEND_CONFIRMATION_MIN_INTERVAL_SECONDS` entre intentos) y dispara
 * `auth.resend` de Supabase si corresponde. Devuelve SIEMPRE el mismo
 * mensaje público, exista o no la cuenta, esté o no ya confirmada, y esté o
 * no rate-limited -- ninguna rama revela el estado real de una cuenta puntual.
 */
export async function requestConfirmationResend({
  admin,
  emailRaw,
  ip,
  siteUrl,
}: RequestConfirmationResendInput): Promise<ResendConfirmationResult> {
  const startedAt = Date.now()
  const respond = async (result: ResendConfirmationResult) => {
    const elapsed = Date.now() - startedAt
    if (elapsed < MIN_RESPONSE_MS) await sleep(MIN_RESPONSE_MS - elapsed)
    return result
  }

  const email = normalizeEmail(emailRaw)
  if (!email) {
    return respond({ ok: false, status: 400, error: INVALID_EMAIL_MESSAGE })
  }

  if (!siteUrl) {
    console.error("RESEND_CONFIRMATION_SITE_URL_UNAVAILABLE")
    return respond({ ok: false, status: 503, error: UNAVAILABLE_MESSAGE })
  }

  // Fail closed: sin la tabla de rate limit no hay protección real contra
  // el bombardeo de reenvíos -- no se manda ningún email hasta que la
  // migración de email_confirmation_resend_attempts esté aplicada.
  if (!(await rateLimitTableExists(admin))) {
    console.error("RESEND_CONFIRMATION_RATE_LIMIT_TABLE_MISSING")
    return respond({ ok: false, status: 503, error: UNAVAILABLE_MESSAGE })
  }

  const now = new Date()
  const identifierHash = hashForRateLimit(email)
  const ipHash = ip ? hashForRateLimit(ip) : null

  // Purga oportunista de filas viejas: mantiene la tabla acotada sin
  // necesitar un cron dedicado.
  await admin
    .from("email_confirmation_resend_attempts")
    .delete()
    .lt(
      "created_at",
      new Date(
        now.getTime() -
          RESEND_CONFIRMATION_ATTEMPT_RETENTION_HOURS * 60 * 60 * 1000,
      ).toISOString(),
    )

  const counts = await countRecentAttempts(admin, identifierHash, ipHash, now)

  if (isResendConfirmationRateLimited(counts)) {
    return respond({ ok: true, message: RESEND_CONFIRMATION_GENERIC_MESSAGE })
  }

  // Se registra el intento SIEMPRE que no esté ya rate-limited: de lo
  // contrario un intento bloqueado por el piso de segundos no contaría para
  // el propio piso, permitiendo ráfagas más rápidas de lo previsto.
  await admin.from("email_confirmation_resend_attempts").insert({
    identifier_hash: identifierHash,
    ip_hash: ipHash,
  })

  const { error } = await admin.auth.resend({
    type: "signup",
    email,
    options: {
      emailRedirectTo: siteUrl,
    },
  })

  if (error) {
    // Nunca se propaga al cliente: haría que "ya confirmada" o "no existe"
    // se vieran distinto de "reenviado correctamente". Se registra sin el
    // email real (sólo el prefijo del hash, para correlacionar en logs).
    console.error("RESEND_CONFIRMATION_SEND_ERROR", {
      correlationId: identifierHash.slice(0, 12),
      code: error.code ?? null,
      status: error.status ?? null,
      message: error.message,
    })
  }

  return respond({ ok: true, message: RESEND_CONFIRMATION_GENERIC_MESSAGE })
}
