import "server-only"

import { randomInt } from "node:crypto"

import { safeErrorMetadata } from "../security/safe-error.ts"
import type { createAdminClient } from "../supabase/admin.ts"
import { normalizeForgotPasswordIdentifier } from "./forgot-password-identifier.ts"
import { FORGOT_PASSWORD_GENERIC_MESSAGE } from "./forgot-password-messages.ts"
import {
  createPasswordResetCorrelationId,
  logPasswordResetAttempt,
  normalizeProviderErrorCode,
  type PasswordResetInternalError,
  type PasswordResetLogEvent,
} from "./password-reset-log.ts"
import {
  hashForRateLimit,
  PASSWORD_RESET_ATTEMPT_RETENTION_HOURS,
} from "./password-reset-rate-limit.ts"

type AdminClient = ReturnType<typeof createAdminClient>

export { FORGOT_PASSWORD_GENERIC_MESSAGE }

/**
 * Enmascarar el email de destino (`b*****@gmail.com`) fue evaluado y
 * DESCARTADO a propósito: mostrar cualquier fragmento exige confirmar
 * públicamente que la cuenta existe -- justo la enumeración que este flujo
 * evita.
 */

// Sólo el formato del identificador es inválido: no depende de ninguna cuenta.
const INVALID_IDENTIFIER_MESSAGE = "Ingresá tu usuario o email para continuar."

/**
 * Política temporal única. Toda respuesta (válida, inexistente, limitada,
 * fallo de almacenamiento, configuración ausente, excepción) sale por
 * `finalizeForgotPasswordResponse`, que garantiza un piso + jitter medido
 * desde el inicio del request.
 *
 * El trabajo que SÍ depende de la cuenta (resolver username, consultar
 * profiles, llamar al proveedor) no corre antes de responder: se entrega a
 * `defer` (en la ruta, `after()` de Next) y se ejecuta después de enviar la
 * respuesta. Antes de responder sólo se hace trabajo idéntico para cualquier
 * identificador (validar formato y rate limit), así que la latencia de
 * Supabase Auth para una cuenta existente no es observable.
 */
export const FORGOT_PASSWORD_MIN_RESPONSE_MS = 700
export const FORGOT_PASSWORD_MAX_JITTER_MS = 150

export type ForgotPasswordResult =
  | { ok: true; message: string }
  | { ok: false; status: 400; error: string }

const NEUTRAL_RESULT: ForgotPasswordResult = {
  ok: true,
  message: FORGOT_PASSWORD_GENERIC_MESSAGE,
}

export interface ForgotPasswordTiming {
  now: () => number
  sleep: (ms: number) => Promise<void>
  jitter: () => number
}

const SYSTEM_TIMING: ForgotPasswordTiming = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  jitter: () => randomInt(0, FORGOT_PASSWORD_MAX_JITTER_MS + 1),
}

/** Única salida del flujo público: aplica el piso temporal y devuelve el resultado. */
export async function finalizeForgotPasswordResponse(
  startedAt: number,
  result: ForgotPasswordResult,
  timing: ForgotPasswordTiming = SYSTEM_TIMING,
): Promise<ForgotPasswordResult> {
  const target = FORGOT_PASSWORD_MIN_RESPONSE_MS + timing.jitter()
  const remaining = target - (timing.now() - startedAt)
  if (remaining > 0) await timing.sleep(remaining)
  return result
}

class PasswordResetFailClosed extends Error {
  readonly internalError: PasswordResetInternalError
  readonly source: unknown

  constructor(internalError: PasswordResetInternalError, source?: unknown) {
    super(internalError)
    this.internalError = internalError
    this.source = source
  }
}

function describeFailure(error: unknown, fallback: PasswordResetInternalError) {
  return error instanceof PasswordResetFailClosed
    ? { internalError: error.internalError, source: error.source }
    : { internalError: fallback, source: error }
}

async function resolveUsernameEmail(admin: AdminClient, username: string) {
  const { data, error } = await admin.rpc("get_profile_email_by_username", {
    username_input: username,
  })

  if (error) throw new PasswordResetFailClosed("USERNAME_LOOKUP_ERROR", error)
  if (typeof data !== "string" || !data.trim()) return null

  return data.trim().toLowerCase()
}

/** Sólo diagnóstico para el log (`accountResolved`); nunca cambia el comportamiento. */
async function accountExistsForEmail(admin: AdminClient, email: string) {
  const { data, error } = await admin
    .from("profiles")
    .select("id")
    .ilike("email", email)
    .limit(1)

  return !error && Boolean(data?.length)
}

/**
 * Decide y registra el intento en UNA transacción de PostgreSQL
 * (`admit_password_reset_attempt`, bajo advisory locks por identificador e
 * IP): solicitudes paralelas no pueden leer el mismo conteo y quedar todas
 * admitidas. Sin IP confiable aplica sólo los límites por identificador.
 * Cualquier error o respuesta que no sea un boolean falla cerrado.
 */
async function admitAttempt(
  admin: AdminClient,
  identifierHash: string,
  ipHash: string | null,
): Promise<boolean> {
  const { data, error } = await admin.rpc("admit_password_reset_attempt", {
    p_identifier_hash: identifierHash,
    p_ip_hash: ipHash,
  })

  if (error || typeof data !== "boolean") {
    throw new PasswordResetFailClosed("RATE_LIMIT_STORAGE_ERROR", error)
  }
  return data
}

export interface RequestPasswordRecoveryInput {
  /** Cliente admin o su factory: si construirlo falla, también sale por la respuesta neutra. */
  admin: AdminClient | (() => AdminClient)
  identifierRaw: unknown
  /** IP confiable ya validada (ver `getValidTrustedClientIp`), o null. */
  ip: string | null
  /** URL canónica (ver `resolveConfiguredSiteUrl`) -- nunca derivada de headers. */
  siteUrl: string | null
  /**
   * Ejecuta el trabajo dependiente de la cuenta después de responder (en la
   * ruta: `after` de next/server). Sin `defer` se ejecuta antes de responder.
   */
  defer?: (task: () => Promise<void>) => void
  timing?: ForgotPasswordTiming
}

type IdentifierKind = "email" | "username"

interface Evaluation {
  result: ForgotPasswordResult
  deliver?: () => Promise<void>
}

function baseEvent(
  identifierType: PasswordResetLogEvent["identifierType"],
  correlationId: string,
): PasswordResetLogEvent {
  return {
    identifierType,
    accountResolved: false,
    resetRequested: false,
    rateLimited: false,
    providerErrorCode: null,
    internalError: null,
    correlationId,
  }
}

interface RequestContext {
  correlationId: string
  identifierType: PasswordResetLogEvent["identifierType"]
}

function reportInternalError(
  context: RequestContext,
  error: unknown,
  fallback: PasswordResetInternalError,
) {
  const { internalError, source } = describeFailure(error, fallback)
  logPasswordResetAttempt({
    ...baseEvent(context.identifierType, context.correlationId),
    internalError,
  })
  // Observable para operación, sin datos de la cuenta ni mensajes crudos.
  console.error("FORGOT_PASSWORD_FAIL_CLOSED", {
    correlationId: context.correlationId,
    internalError,
    error: safeErrorMetadata(source),
  })
}

async function evaluate(
  input: RequestPasswordRecoveryInput,
  context: RequestContext,
): Promise<Evaluation> {
  const { correlationId } = context
  const identifier = normalizeForgotPasswordIdentifier(input.identifierRaw)
  if (!identifier) {
    logPasswordResetAttempt(baseEvent("invalid", correlationId))
    return { result: { ok: false, status: 400, error: INVALID_IDENTIFIER_MESSAGE } }
  }
  context.identifierType = identifier.kind

  // Sin URL canónica no hay enlace seguro posible: no se envía nada.
  if (!input.siteUrl) throw new PasswordResetFailClosed("SITE_URL_UNAVAILABLE")
  const siteUrl = input.siteUrl

  let admin: AdminClient
  try {
    admin = typeof input.admin === "function" ? input.admin() : input.admin
  } catch (error) {
    throw new PasswordResetFailClosed("ADMIN_CLIENT_UNAVAILABLE", error)
  }

  const identifierHash = hashForRateLimit(identifier.value)
  const ipHash = input.ip ? hashForRateLimit(input.ip) : null

  // Purga oportunista, separada de la decisión: si falla no debilita el
  // límite (sólo deja filas viejas), así que se registra y se sigue.
  const { error: purgeError } = await admin
    .from("password_reset_attempts")
    .delete()
    .lt(
      "created_at",
      new Date(Date.now() - PASSWORD_RESET_ATTEMPT_RETENTION_HOURS * 60 * 60 * 1000).toISOString(),
    )
  if (purgeError) {
    console.error("FORGOT_PASSWORD_RATE_LIMIT_PURGE_ERROR", {
      correlationId,
      error: safeErrorMetadata(purgeError),
    })
  }

  // Decisión + registro del intento (siempre, también si queda limitado) en
  // una sola transacción. Si falla, no se programa ningún envío.
  if (!(await admitAttempt(admin, identifierHash, ipHash))) {
    logPasswordResetAttempt({ ...baseEvent(identifier.kind, correlationId), rateLimited: true })
    return { result: NEUTRAL_RESULT }
  }

  return {
    result: NEUTRAL_RESULT,
    deliver: () => deliverRecoveryEmail(admin, identifier.kind, identifier.value, siteUrl, correlationId),
  }
}

async function deliverRecoveryEmail(
  admin: AdminClient,
  kind: IdentifierKind,
  value: string,
  siteUrl: string,
  correlationId: string,
) {
  const email = kind === "email" ? value : await resolveUsernameEmail(admin, value)

  if (!email) {
    logPasswordResetAttempt(baseEvent(kind, correlationId))
    return
  }

  // Un email bien formado siempre se pasa al proveedor (que no envía nada
  // si la cuenta no existe); accountResolved es sólo diagnóstico.
  const accountResolved = kind === "username" ? true : await accountExistsForEmail(admin, email)

  const { error } = await admin.auth.resetPasswordForEmail(email, {
    redirectTo: `${siteUrl}/reset-password`,
  })

  const providerErrorCode = error ? normalizeProviderErrorCode(error) : null
  logPasswordResetAttempt({
    ...baseEvent(kind, correlationId),
    accountResolved,
    resetRequested: true,
    providerErrorCode,
  })

  if (error) {
    console.error("FORGOT_PASSWORD_SEND_ERROR", { correlationId, providerErrorCode })
  }
}

/**
 * "Olvidé mi contraseña" de punta a punta. Nunca lanza: todo camino termina
 * en `finalizeForgotPasswordResponse`. Públicamente sólo existen dos
 * respuestas: formato inválido (400, no depende de ninguna cuenta) o el
 * mensaje neutro (200) -- también ante rate limit, fallos de almacenamiento,
 * configuración ausente, errores del proveedor o excepciones.
 */
export async function requestPasswordRecovery(
  input: RequestPasswordRecoveryInput,
): Promise<ForgotPasswordResult> {
  const timing = input.timing ?? SYSTEM_TIMING
  const startedAt = timing.now()
  const context: RequestContext = {
    correlationId: createPasswordResetCorrelationId(),
    identifierType: "invalid",
  }

  let result: ForgotPasswordResult = NEUTRAL_RESULT
  try {
    const evaluation = await evaluate(input, context)
    result = evaluation.result

    const deliver = evaluation.deliver
    if (deliver) {
      const task = async () => {
        try {
          await deliver()
        } catch (error) {
          reportInternalError(context, error, "PROVIDER_CALL_FAILED")
        }
      }
      if (input.defer) input.defer(task)
      else await task()
    }
  } catch (error) {
    reportInternalError(context, error, "INTERNAL_ERROR")
    result = NEUTRAL_RESULT
  }

  return finalizeForgotPasswordResponse(startedAt, result, timing)
}
