/**
 * Normalización CANÓNICA de username, compartida por los tres lugares que
 * antes podían desalinearse:
 *
 * - registro (context/auth-context.tsx `register()`)
 * - edición de perfil (app/api/auth/profile/route.ts `PATCH`)
 * - login/resolución server-side (get_profile_email_by_username hace
 *   `lower(trim(username_input))` sobre el input, y el índice
 *   profiles_username_lower_unique usa `lower(trim(username))` sobre la
 *   columna -- ver migración 20260912120000)
 *
 * Mismo criterio en los tres: trim + lowercase. Un username vacío o
 * en blanco tras el trim se normaliza a `undefined` (no a `""`), para que
 * ningún llamador termine guardando una cadena vacía como si fuera un
 * username real.
 */
export function normalizeUsername(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined

  const trimmed = value.trim()
  if (!trimmed) return undefined

  return trimmed.toLowerCase()
}
