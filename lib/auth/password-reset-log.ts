import "server-only"

/**
 * Logging estructurado y seguro para diagnosticar "olvidé mi contraseña"
 * sin comprometer la protección contra enumeración ni filtrar datos
 * sensibles. Pensado para lectura humana en los logs del servidor -- nunca
 * llega al cliente (la respuesta pública sigue siendo siempre la misma, ver
 * `lib/auth/forgot-password.ts`).
 *
 * Deliberadamente EXCLUYE: email/username completos, JWT, access token,
 * service role, URL de recuperación completa, y cualquier otro secreto.
 * `correlationId` es un prefijo corto (12 hex) del hash sha256 del
 * identificador normalizado -- alcanza para correlacionar líneas de un
 * mismo intento o ver que el mismo identificador reincide, sin ser
 * reversible al email/username real.
 */
export interface PasswordResetLogEvent {
  identifierType: "email" | "username" | "invalid"
  /** true si el identificador resolvió a una cuenta real (sólo lo sabe el servidor; nunca se expone). */
  accountResolved: boolean
  /** true si se llegó a llamar a resetPasswordForEmail (false si el formato era inválido o quedó rate-limited). */
  resetRequested: boolean
  rateLimited: boolean
  /** Código/mensaje corto del error de Supabase al pedir el reset, si lo hubo. */
  providerErrorCode: string | null
  /** Prefijo corto y no reversible del identificador normalizado, para correlacionar sin loguear el dato real. */
  correlationId: string
}

export function logPasswordResetAttempt(event: PasswordResetLogEvent) {
  console.log("password-reset:", JSON.stringify(event))
}
