const SAFE_ERROR_CODE = /^[A-Z0-9_]{2,40}$/

/**
 * Metadata acotada para logs: nunca mensajes ni campos de proveedores. Sólo se
 * conserva `code` cuando es un identificador estricto (p. ej. 23505, PGRST116,
 * VALIDATION_ERROR), necesario para diagnosticar sin exponer datos.
 */
export function safeErrorMetadata(error: unknown) {
  const name = error instanceof Error ? "Error" : "UnknownError"
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? error.code
      : undefined
  return typeof code === "string" && SAFE_ERROR_CODE.test(code)
    ? { name, code }
    : { name }
}
