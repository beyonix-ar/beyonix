import "server-only"

import { createHash } from "node:crypto"

/**
 * Límites de "olvidé mi contraseña": ventanas por identificador Y por IP
 * contra una tabla persistente. La decisión la toma ATÓMICAMENTE la RPC
 * `admit_password_reset_attempt`
 * (supabase/migrations/20261101120000_password_reset_atomic_rate_limit.sql),
 * que tiene estos mismos valores; estas constantes son su espejo documental y
 * un test verifica que coincidan.
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
