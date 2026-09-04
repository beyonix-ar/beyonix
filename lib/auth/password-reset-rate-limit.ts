import "server-only"

import { createHash } from "node:crypto"

/**
 * Límites de "olvidé mi contraseña". Mismo orden de magnitud y mismo patrón
 * que el rate limiting ya existente de checkout de Mercado Pago
 * (`lib/mercadopago/checkout-attempt.ts`): ventanas por identificador Y por
 * IP, contadas contra una tabla persistente (nunca en memoria del proceso --
 * en producción corren múltiples instancias, ver
 * `password_reset_attempts` en supabase/migrations).
 */
export const PASSWORD_RESET_MAX_PER_IDENTIFIER_PER_HOUR = 3
export const PASSWORD_RESET_MAX_PER_IDENTIFIER_PER_DAY = 6
export const PASSWORD_RESET_MAX_PER_IP_PER_HOUR = 8
export const PASSWORD_RESET_MAX_PER_IP_PER_DAY = 20

/** Antigüedad máxima de filas antes de poder purgarlas (ventana más larga que verificamos + margen). */
export const PASSWORD_RESET_ATTEMPT_RETENTION_HOURS = 48

/**
 * Hash determinístico, no reversible, del identificador/IP para la tabla de
 * rate limit. No se guarda el email/username/IP en texto plano en esta
 * tabla: no hace falta para contar intentos, y así esta tabla nunca se
 * vuelve un segundo directorio de cuentas o de IPs de clientes.
 */
export function hashForRateLimit(value: string) {
  return createHash("sha256").update(value.trim().toLowerCase()).digest("hex")
}

export interface PasswordResetAttemptCounts {
  identifierLastHour: number
  identifierLastDay: number
  ipLastHour: number
  ipLastDay: number
}

/**
 * Pura: decide si HAY QUE OMITIR el envío del email de recuperación. El
 * resultado nunca debe cambiar la respuesta pública -- ver
 * `app/api/auth/forgot-password/route.ts`, que devuelve el mismo mensaje
 * genérico esté o no rate-limited. Alcanza con superar CUALQUIERA de los
 * cuatro límites (identificador u origen, hora o día).
 */
export function isPasswordResetRateLimited(
  counts: PasswordResetAttemptCounts,
): boolean {
  return (
    counts.identifierLastHour >= PASSWORD_RESET_MAX_PER_IDENTIFIER_PER_HOUR ||
    counts.identifierLastDay >= PASSWORD_RESET_MAX_PER_IDENTIFIER_PER_DAY ||
    counts.ipLastHour >= PASSWORD_RESET_MAX_PER_IP_PER_HOUR ||
    counts.ipLastDay >= PASSWORD_RESET_MAX_PER_IP_PER_DAY
  )
}
