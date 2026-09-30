// Nombre visible en las superficies PÚBLICAS de reseñas: sólo el primer
// nombre real del perfil (profiles.nombre), con formato prolijo. Es sólo
// presentación: nunca se reescribe el dato guardado, y Admin / Mis compras /
// pedidos siguen mostrando lo que ya mostraban. Nunca se usa el username ni
// el apellido.

export const PUBLIC_REVIEWER_FALLBACK_NAME = "Cliente verificado"

const MAX_PUBLIC_FIRST_NAME_LENGTH = 24
// Letras (con tildes, ñ, ü y marcas combinantes) y, como mucho, guion o
// apóstrofo internos ("Ana-Lía", "D'Angelo").
const FIRST_NAME_PATTERN = /^[\p{L}\p{M}]+(?:['’-][\p{L}\p{M}]+)*$/u

function capitalize(part: string) {
  const lower = part.toLocaleLowerCase("es-AR")
  const [first = "", ...rest] = Array.from(lower)
  return first.toLocaleUpperCase("es-AR") + rest.join("")
}

/**
 * "LUCAS ALBERTO" → "Lucas", "maría josé" → "María", "rOMINA" → "Romina".
 * `null` si no hay un primer nombre válido (vacío, con números, símbolos,
 * emails, etc.).
 */
export function getPublicFirstName(fullName: unknown): string | null {
  if (typeof fullName !== "string") return null

  const [firstToken = ""] = fullName.normalize("NFC").trim().split(/\s+/)
  if (!firstToken || firstToken.length > MAX_PUBLIC_FIRST_NAME_LENGTH) return null
  if (!FIRST_NAME_PATTERN.test(firstToken)) return null

  return firstToken
    .split(/(['’-])/)
    .map((part) => (/^['’-]$/.test(part) ? part : capitalize(part)))
    .join("")
}

/** Primer nombre visible o, si el perfil no tiene uno válido, un rótulo neutro. */
export function getPublicReviewerName(fullName: unknown): string {
  return getPublicFirstName(fullName) ?? PUBLIC_REVIEWER_FALLBACK_NAME
}
