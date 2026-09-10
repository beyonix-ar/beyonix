import "server-only"

import { createHash } from "node:crypto"

/**
 * Límites de "reenviar correo de confirmación". Mismo patrón que
 * `lib/auth/password-reset-rate-limit.ts`: ventanas por identificador Y por
 * IP, contadas contra una tabla persistente (nunca en memoria del proceso --
 * en producción corren múltiples instancias, ver
 * `email_confirmation_resend_attempts` en supabase/migrations).
 *
 * El cooldown visible de 30s del botón en el frontend es sólo UX; el límite
 * real que impide bombardear el envío de emails es `MIN_INTERVAL_SECONDS`
 * más los topes por hora/día de acá.
 */
export const RESEND_CONFIRMATION_MIN_INTERVAL_SECONDS = 30
export const RESEND_CONFIRMATION_MAX_PER_IDENTIFIER_PER_HOUR = 5
export const RESEND_CONFIRMATION_MAX_PER_IDENTIFIER_PER_DAY = 10
export const RESEND_CONFIRMATION_MAX_PER_IP_PER_HOUR = 15
export const RESEND_CONFIRMATION_MAX_PER_IP_PER_DAY = 40

/** Antigüedad máxima de filas antes de poder purgarlas (ventana más larga que verificamos + margen). */
export const RESEND_CONFIRMATION_ATTEMPT_RETENTION_HOURS = 48

/** Hash determinístico, no reversible, del email/IP para la tabla de rate limit. */
export function hashForRateLimit(value: string) {
  return createHash("sha256").update(value.trim().toLowerCase()).digest("hex")
}

export interface ResendConfirmationAttemptCounts {
  secondsSinceLastIdentifierAttempt: number | null
  identifierLastHour: number
  identifierLastDay: number
  ipLastHour: number
  ipLastDay: number
}

/**
 * Pura: decide si HAY QUE OMITIR el reenvío del email. El resultado nunca
 * debe cambiar la respuesta pública -- ver
 * `app/api/auth/resend-confirmation/route.ts`, que devuelve el mismo mensaje
 * genérico esté o no rate-limited.
 */
export function isResendConfirmationRateLimited(
  counts: ResendConfirmationAttemptCounts,
): boolean {
  return (
    (counts.secondsSinceLastIdentifierAttempt !== null &&
      counts.secondsSinceLastIdentifierAttempt <
        RESEND_CONFIRMATION_MIN_INTERVAL_SECONDS) ||
    counts.identifierLastHour >= RESEND_CONFIRMATION_MAX_PER_IDENTIFIER_PER_HOUR ||
    counts.identifierLastDay >= RESEND_CONFIRMATION_MAX_PER_IDENTIFIER_PER_DAY ||
    counts.ipLastHour >= RESEND_CONFIRMATION_MAX_PER_IP_PER_HOUR ||
    counts.ipLastDay >= RESEND_CONFIRMATION_MAX_PER_IP_PER_DAY
  )
}
