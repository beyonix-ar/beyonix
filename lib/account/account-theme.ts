export type AccountTheme = "dark" | "light"

export const ACCOUNT_THEME_STORAGE_KEY = "beyonix-account-theme"
export const DEFAULT_ACCOUNT_THEME: AccountTheme = "dark"

export function isAccountTheme(value: unknown): value is AccountTheme {
  return value === "dark" || value === "light"
}

/**
 * Resuelve el theme a partir de un valor crudo (localStorage, atributo del
 * DOM, lo que sea) -- cualquier valor inválido o ausente cae al default
 * (dark), nunca revienta ni deja el theme en un estado intermedio.
 */
export function resolveAccountTheme(rawValue: unknown): AccountTheme {
  return isAccountTheme(rawValue) ? rawValue : DEFAULT_ACCOUNT_THEME
}
