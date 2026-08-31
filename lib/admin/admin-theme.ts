export type AdminTheme = "dark" | "light"

export const ADMIN_THEME_STORAGE_KEY = "beyonix-admin-theme"
export const DEFAULT_ADMIN_THEME: AdminTheme = "dark"

export function isAdminTheme(value: unknown): value is AdminTheme {
  return value === "dark" || value === "light"
}

/**
 * Resuelve el theme a partir de un valor crudo (localStorage, atributo del
 * DOM, lo que sea) -- cualquier valor inválido o ausente cae al default
 * (dark), nunca revienta ni deja el theme en un estado intermedio.
 */
export function resolveAdminTheme(rawValue: unknown): AdminTheme {
  return isAdminTheme(rawValue) ? rawValue : DEFAULT_ADMIN_THEME
}
