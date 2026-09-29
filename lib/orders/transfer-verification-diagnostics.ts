// Observabilidad de la verificación automática de transferencias sin exponer
// datos sensibles: nunca un DNI/CUIT, CVU/CBU ni payment.id completos. Todo
// número de 6 o más dígitos se enmascara dejando sólo los últimos 3.

const LONG_DIGITS = /\d{6,}/g

/** "20372812924" -> "********924". Valores cortos o vacíos se devuelven tal cual. */
export function maskIdentifier(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null
  const text = String(value)
  return text.replace(LONG_DIGITS, (digits) => `${"*".repeat(digits.length - 3)}${digits.slice(-3)}`)
}

export interface TransferConfirmationFailureDiagnostic {
  /** Prefijo tipificado de la RPC ("LEASE_EXPIRED"), si lo hay. */
  code: string | null
  /** SQLSTATE / código de PostgREST (P0001, 57014, 40P01, PGRST202…). */
  sqlstate: string | null
  /** Mensaje truncado y enmascarado. */
  message: string | null
  hint: string | null
  /** La RPC no devolvió error ni fila (respuesta vacía). */
  emptyResponse: boolean
}

type SupabaseLikeError = {
  message?: string | null
  code?: string | null
  details?: string | null
  hint?: string | null
} | null | undefined

const sanitize = (value: string | null | undefined, max = 300) =>
  value ? (maskIdentifier(value) ?? "").slice(0, max) : null

/**
 * Qué falló al confirmar, en forma segura para logs y auditoría. Antes el
 * servicio sólo guardaba "confirmation_error" y el motivo real quedaba en
 * un console.error sin estructura: no había forma de reconstruir el fallo.
 */
export function describeTransferConfirmationFailure(error: SupabaseLikeError): TransferConfirmationFailureDiagnostic {
  const message = error?.message ?? null
  const typed = message ? /^([A-Z_]+):/.exec(message)?.[1] ?? null : null
  return {
    code: typed,
    sqlstate: error?.code ?? null,
    message: sanitize(message),
    hint: sanitize(error?.hint, 200),
    emptyResponse: !error,
  }
}
