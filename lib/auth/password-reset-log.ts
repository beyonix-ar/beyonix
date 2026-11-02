import "server-only"

import { randomBytes } from "node:crypto"

/**
 * Logging estructurado y seguro para diagnosticar "olvidé mi contraseña"
 * sin comprometer la protección contra enumeración ni filtrar datos
 * sensibles. Nunca llega al cliente (la respuesta pública es siempre la
 * misma, ver `lib/auth/forgot-password.ts`).
 *
 * Deliberadamente EXCLUYE: email/username, IP, tokens, URL de recuperación
 * y cualquier texto libre del proveedor. `correlationId` es aleatorio por
 * request: correlaciona las líneas de un mismo intento sin derivarse del
 * identificador (un hash sin clave permitiría confirmar emails por
 * diccionario contra los logs).
 */

/** Códigos de error de Supabase Auth (GoTrue) que se registran tal cual; cualquier otro se colapsa. */
const KNOWN_PROVIDER_ERROR_CODES = [
  "over_email_send_rate_limit",
  "over_request_rate_limit",
  "email_address_invalid",
  "email_address_not_authorized",
  "email_provider_disabled",
  "user_not_found",
  "validation_failed",
  "request_timeout",
  "unexpected_failure",
] as const

export type PasswordResetProviderErrorCode =
  | (typeof KNOWN_PROVIDER_ERROR_CODES)[number]
  | "provider_error_unknown"

export type PasswordResetInternalError =
  | "SITE_URL_UNAVAILABLE"
  | "ADMIN_CLIENT_UNAVAILABLE"
  | "RATE_LIMIT_TABLE_MISSING"
  | "RATE_LIMIT_STORAGE_ERROR"
  | "USERNAME_LOOKUP_ERROR"
  | "PROVIDER_CALL_FAILED"
  | "INTERNAL_ERROR"

export interface PasswordResetLogEvent {
  identifierType: "email" | "username" | "invalid"
  /** true si el identificador resolvió a una cuenta real (sólo lo sabe el servidor; nunca se expone). */
  accountResolved: boolean
  /** true si se llegó a llamar a resetPasswordForEmail. */
  resetRequested: boolean
  rateLimited: boolean
  /** Código normalizado del error del proveedor (nunca su mensaje). */
  providerErrorCode: PasswordResetProviderErrorCode | null
  /** Categoría interna cuando el flujo falló cerrado por un problema propio. */
  internalError: PasswordResetInternalError | null
  /** Aleatorio por request; no se deriva del identificador. */
  correlationId: string
}

export function createPasswordResetCorrelationId() {
  return randomBytes(8).toString("hex")
}

export function normalizeProviderErrorCode(error: unknown): PasswordResetProviderErrorCode {
  const code =
    typeof error === "object" && error !== null && "code" in error ? error.code : undefined
  return KNOWN_PROVIDER_ERROR_CODES.find((known) => known === code) ?? "provider_error_unknown"
}

export function logPasswordResetAttempt(event: PasswordResetLogEvent) {
  console.log("password-reset:", JSON.stringify(event))
}
