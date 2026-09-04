import "server-only"

import type { createAdminClient } from "../supabase/admin.ts"
import { normalizeForgotPasswordIdentifier } from "./forgot-password-identifier.ts"
import { FORGOT_PASSWORD_GENERIC_MESSAGE } from "./forgot-password-messages.ts"
import { logPasswordResetAttempt } from "./password-reset-log.ts"
import {
  hashForRateLimit,
  isPasswordResetRateLimited,
  PASSWORD_RESET_ATTEMPT_RETENTION_HOURS,
  type PasswordResetAttemptCounts,
} from "./password-reset-rate-limit.ts"

type AdminClient = ReturnType<typeof createAdminClient>

export { FORGOT_PASSWORD_GENERIC_MESSAGE }

/**
 * Enmascarar el email de destino (`b*****@gmail.com`) fue evaluado y
 * DESCARTADO a propósito: para mostrar cualquier fragmento del email hace
 * falta primero confirmar públicamente que la cuenta existe y cuál es su
 * email real -- exactamente la enumeración que este flujo existe para
 * evitar. Seguridad por sobre comodidad visual: no se muestra ningún dato
 * derivado de si la cuenta existe o no.
 */

// Sólo el formato del identificador es inválido -- no requiere el mismo
// disfraz que "no existe" porque no depende de ninguna cuenta puntual.
const INVALID_IDENTIFIER_MESSAGE = "Ingresá tu usuario o email para continuar."
const UNAVAILABLE_MESSAGE =
  "La recuperación de contraseña no está disponible en este momento."

// Todas las respuestas (encontrada, no encontrada, rate-limited, error de
// envío) tardan al menos esto: sin un piso, el tiempo de respuesta real
// (que sí llama a Supabase para reenviar el correo) sería medible y
// distinguible de las ramas que no llaman a nada.
const MIN_RESPONSE_MS = 700

type AdminAuthResult = { ok: true; message: string } | { ok: false; status: number; error: string }

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function resolveUsernameEmail(admin: AdminClient, username: string) {
  const { data, error } = await admin.rpc("get_profile_email_by_username", {
    username_input: username,
  })

  if (error || typeof data !== "string" || !data.trim()) return null

  return data.trim().toLowerCase()
}

/**
 * Sólo para el campo `accountResolved` del log estructurado -- NUNCA cambia
 * el comportamiento público (un identificador con forma de email siempre
 * dispara `resetPasswordForEmail`, exista o no la cuenta, sin importar este
 * resultado). Reutiliza `profiles` (misma tabla que la resolución de
 * username) en vez de una API de auth.admin que no existe para buscar por
 * email.
 */
async function accountExistsForEmail(admin: AdminClient, email: string) {
  const { data, error } = await admin
    .from("profiles")
    .select("id")
    .ilike("email", email)
    .limit(1)

  return !error && Boolean(data?.length)
}

/**
 * Confirma que la tabla de rate limit existe ANTES de confiar en cualquier
 * conteo. Deliberadamente NO usa `head: true`: PostgREST responde una
 * consulta `head: true` contra una tabla inexistente con 204 y
 * `{ count: null, error: null }` -- sin esta canaria, una migración
 * pendiente se leería como "0 intentos" en vez de "no se puede contar", y el
 * rate limit quedaría inerte sin que nada lo detecte.
 */
async function rateLimitTableExists(admin: AdminClient): Promise<boolean> {
  const { error } = await admin
    .from("password_reset_attempts")
    .select("id")
    .limit(1)

  return !error
}

async function countRecentAttempts(
  admin: AdminClient,
  identifierHash: string,
  ipHash: string | null,
  now: Date,
): Promise<PasswordResetAttemptCounts> {
  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString()
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()
  const table = () => admin.from("password_reset_attempts")

  const [identifierHour, identifierDay, ipHour, ipDay] = await Promise.all([
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

  return {
    identifierLastHour: Number(identifierHour.count ?? 0),
    identifierLastDay: Number(identifierDay.count ?? 0),
    ipLastHour: Number(ipHour.count ?? 0),
    ipLastDay: Number(ipDay.count ?? 0),
  }
}

export interface RequestPasswordRecoveryInput {
  admin: AdminClient
  identifierRaw: unknown
  ip: string | null
  /** URL canónica ya resuelta server-side (ver `lib/site-url.ts`) -- nunca el header Origin. */
  siteUrl: string | null
}

/**
 * Orquesta "olvidé mi contraseña" de punta a punta: normaliza el
 * identificador, aplica rate limiting persistente, resuelve username->email
 * SOLO server-side, y dispara el email de recuperación de Supabase si
 * corresponde. Devuelve SIEMPRE el mismo mensaje público de éxito salvo por
 * un identificador con formato inválido o el servicio sin configurar --
 * ninguno de los dos revela nada sobre una cuenta puntual.
 */
export async function requestPasswordRecovery({
  admin,
  identifierRaw,
  ip,
  siteUrl,
}: RequestPasswordRecoveryInput): Promise<AdminAuthResult> {
  const startedAt = Date.now()
  const respond = async (result: AdminAuthResult) => {
    const elapsed = Date.now() - startedAt
    if (elapsed < MIN_RESPONSE_MS) await sleep(MIN_RESPONSE_MS - elapsed)
    return result
  }

  const identifier = normalizeForgotPasswordIdentifier(identifierRaw)
  if (!identifier) {
    logPasswordResetAttempt({
      identifierType: "invalid",
      accountResolved: false,
      resetRequested: false,
      rateLimited: false,
      providerErrorCode: null,
      correlationId: "n/a",
    })
    return respond({ ok: false, status: 400, error: INVALID_IDENTIFIER_MESSAGE })
  }

  // Prefijo corto y no reversible: sirve para correlacionar líneas de log de
  // este mismo intento (o ver que el mismo identificador reincide) sin
  // registrar el email/username real. Ver lib/auth/password-reset-log.ts.
  const correlationId = hashForRateLimit(identifier.value).slice(0, 12)

  if (!siteUrl) {
    logPasswordResetAttempt({
      identifierType: identifier.kind,
      accountResolved: false,
      resetRequested: false,
      rateLimited: false,
      providerErrorCode: "SITE_URL_UNAVAILABLE",
      correlationId,
    })
    return respond({ ok: false, status: 503, error: UNAVAILABLE_MESSAGE })
  }

  // Fail closed: sin la tabla de rate limit no hay protección real contra
  // enumeración/spam -- no se manda ningún email hasta que la migración de
  // password_reset_attempts esté aplicada. Se verifica ANTES de tocar nada
  // más (nunca se llega a contar/insertar/enviar sobre una tabla ausente).
  if (!(await rateLimitTableExists(admin))) {
    logPasswordResetAttempt({
      identifierType: identifier.kind,
      accountResolved: false,
      resetRequested: false,
      rateLimited: false,
      providerErrorCode: "RATE_LIMIT_TABLE_MISSING",
      correlationId,
    })
    return respond({ ok: false, status: 503, error: UNAVAILABLE_MESSAGE })
  }

  const now = new Date()
  const identifierHash = hashForRateLimit(identifier.value)
  const ipHash = ip ? hashForRateLimit(ip) : null

  // Purga oportunista de filas viejas: mantiene la tabla acotada sin
  // necesitar un cron dedicado (mismo espíritu que purge_expired_stock_reservations).
  await admin
    .from("password_reset_attempts")
    .delete()
    .lt(
      "created_at",
      new Date(
        now.getTime() - PASSWORD_RESET_ATTEMPT_RETENTION_HOURS * 60 * 60 * 1000,
      ).toISOString(),
    )

  const counts = await countRecentAttempts(admin, identifierHash, ipHash, now)

  // Se registra el intento SIEMPRE, incluso si ya está rate-limited o el
  // identificador no corresponde a ninguna cuenta: de lo contrario alguien
  // podría automatizar miles de usernames sin que ninguno cuente para el límite.
  await admin.from("password_reset_attempts").insert({
    identifier_hash: identifierHash,
    ip_hash: ipHash,
  })

  if (isPasswordResetRateLimited(counts)) {
    logPasswordResetAttempt({
      identifierType: identifier.kind,
      accountResolved: false,
      resetRequested: false,
      rateLimited: true,
      providerErrorCode: null,
      correlationId,
    })
    return respond({ ok: true, message: FORGOT_PASSWORD_GENERIC_MESSAGE })
  }

  const email =
    identifier.kind === "email"
      ? identifier.value
      : await resolveUsernameEmail(admin, identifier.value)

  if (email) {
    // Diagnóstico únicamente (ver accountExistsForEmail): nunca cambia que
    // se llama a resetPasswordForEmail para CUALQUIER email bien formado,
    // exista o no -- eso es lo que hace que la respuesta pública no
    // distinga existencia para identificadores con forma de email.
    const accountResolved =
      identifier.kind === "username" ? true : await accountExistsForEmail(admin, email)

    const { error } = await admin.auth.resetPasswordForEmail(email, {
      redirectTo: `${siteUrl}/reset-password`,
    })

    logPasswordResetAttempt({
      identifierType: identifier.kind,
      accountResolved,
      resetRequested: true,
      rateLimited: false,
      providerErrorCode: error ? (error.code ?? error.message) : null,
      correlationId,
    })

    if (error) {
      // Nunca se propaga al cliente: haría que un fallo real de envío para
      // una cuenta EXISTENTE se viera distinto de "no existe". Se registra
      // sin el email/username real (ver logPasswordResetAttempt arriba).
      console.error("FORGOT_PASSWORD_SEND_ERROR", {
        identifierKind: identifier.kind,
        correlationId,
        code: error.code ?? null,
        message: error.message,
      })
    }
  } else {
    logPasswordResetAttempt({
      identifierType: identifier.kind,
      accountResolved: false,
      resetRequested: false,
      rateLimited: false,
      providerErrorCode: null,
      correlationId,
    })
  }

  return respond({ ok: true, message: FORGOT_PASSWORD_GENERIC_MESSAGE })
}
