import { FIELD_LIMITS } from "../validation/account-fields.ts"

export type ForgotPasswordIdentifier =
  | { kind: "email"; value: string }
  | { kind: "username"; value: string }

/**
 * Clasifica y normaliza lo que el usuario escribió en "¿Olvidaste tu
 * contraseña?": mismo criterio que ya usa el login real (`context/auth-context.tsx`,
 * `!normalizedIdentifier.includes("@")`) -- si contiene "@" es un email, si no
 * es un username. No valida existencia de la cuenta acá (eso es
 * responsabilidad exclusiva del servidor, ver `lib/auth/forgot-password.ts`);
 * esto sólo decide CÓMO va a resolverse, nunca SI existe.
 *
 * `null` únicamente por forma inválida (vacío, demasiado largo, con
 * espacios internos) -- nunca por "no existe", que es indistinguible desde
 * acá a propósito.
 */
export function normalizeForgotPasswordIdentifier(
  raw: unknown,
): ForgotPasswordIdentifier | null {
  if (typeof raw !== "string") return null

  const trimmed = raw.trim()
  if (!trimmed || trimmed.length > FIELD_LIMITS.loginIdentifier) return null
  if (/\s/.test(trimmed)) return null

  const normalized = trimmed.toLowerCase()

  if (normalized.includes("@")) {
    // Forma mínima de email -- la validación completa de sintaxis no
    // importa acá: si no matchea ningún registro, el flujo sigue igual de
    // genérico que un formato inválido pero plausible.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) return null
    if (normalized.length > FIELD_LIMITS.email) return null
    return { kind: "email", value: normalized }
  }

  if (normalized.length > FIELD_LIMITS.username) return null

  return { kind: "username", value: normalized }
}
