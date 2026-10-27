/**
 * Búsquedas de la tienda para Analítica: normalización y filtro de privacidad.
 * Se aplica en el navegador (para no enviar lo que no se va a guardar) y otra
 * vez en el servidor (que nunca confía en el cliente).
 *
 * - Normaliza para agregar: recorta, une espacios repetidos y pasa a
 *   minúsculas (con tildes y ñ intactas). Hasta 80 caracteres.
 * - No guarda texto que parezca un dato personal o un secreto: emails,
 *   secuencias largas de dígitos (teléfono, DNI, tarjeta, CBU) o tokens largos
 *   sin espacios. Esas búsquedas no se registran.
 */

export const SEARCH_QUERY_MAX_LENGTH = 80

const EMAIL_PATTERN = /[^\s@]+@[^\s@]+/
// 6 o más dígitos seguidos, aunque estén separados por espacios, puntos o guiones (DNI 12.345.678, tarjetas).
const LONG_NUMBER_PATTERN = /\d(?:[\s.-]?\d){5,}/
// Palabra de 25+ caracteres sin espacios: claves, tokens, enlaces.
const TOKEN_PATTERN = /\S{25,}/
const URL_PATTERN = /https?:\/\/|www\./

/** Búsqueda lista para registrar, o `null` si está vacía o parece contener datos sensibles. */
export function normalizeSearchQuery(raw: unknown): string | null {
  if (typeof raw !== "string") return null
  const normalized = raw.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase()
  if (!normalized) return null
  if (EMAIL_PATTERN.test(normalized) || LONG_NUMBER_PATTERN.test(normalized) || TOKEN_PATTERN.test(normalized) || URL_PATTERN.test(normalized)) {
    return null
  }
  return Array.from(normalized).slice(0, SEARCH_QUERY_MAX_LENGTH).join("").trimEnd()
}
