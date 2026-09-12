/**
 * Decide si un enlace de confirmación de cuenta (Confirm signup, y los otros
 * tipos de OTP por email que comparten esta misma pantalla: email change,
 * invite, magic link) es válido. Mismo espíritu que lib/auth/recovery-link.ts
 * para /reset-password: separado de la página para poder testear con un
 * cliente de auth fake, sin navegador.
 *
 * Soporta los dos formatos que puede traer el link:
 * 1. `?token_hash=...&type=email` (el que manda hoy el email de BEYONIX,
 *    ver supabase/email-templates/confirm-signup.html) -> verifyOtp.
 *    IMPORTANTE: es `type=email`, NO `type=signup` -- confirmado contra la
 *    documentación oficial de Supabase (guía "Password-based Auth"/
 *    server-side Next.js) y la firma real de `verifyOtp` del SDK instalado.
 *    `type=signup` en este mismo endpoint (verificación por `token_hash` de
 *    un OTP de confirmación de cuenta) devuelve el mismo error genérico
 *    "Token has expired or is invalid" que un token vencido o ya usado,
 *    incluso con un token recién emitido y válido -- causa real auditada
 *    del "enlace vencido" reportado 2026-09-13.
 * 2. `?code=...` (PKCE) -> exchangeCodeForSession
 *
 * `type=recovery` NO se maneja acá: app/confirmar-email/page.tsx lo
 * redirige a /reset-password ANTES de crear el controller, porque ese es un
 * flujo completamente distinto (ver lib/auth/recovery-link.ts).
 */

export type ConfirmationOtpType = "signup" | "email" | "invite" | "magiclink"

const CONFIRMATION_OTP_TYPES = new Set<ConfirmationOtpType>([
  "signup",
  "email",
  "invite",
  "magiclink",
])

/**
 * Si el `type` de la URL no es uno de los conocidos, se asume `email`: es el
 * valor real que usa hoy Confirm Signup (el único flujo que se usa) para
 * verificar por `token_hash` -- NO `signup` (ver comentario del archivo).
 */
export function getConfirmationOtpType(type: string | null): ConfirmationOtpType {
  return type && CONFIRMATION_OTP_TYPES.has(type as ConfirmationOtpType)
    ? (type as ConfirmationOtpType)
    : "email"
}

export interface ConfirmationLinkParams {
  code: string | null
  tokenHash: string | null
  type: string | null
}

interface ConfirmationAuthResult {
  data: {
    session: { access_token: string } | null
    user: { id: string } | null
  }
  error: { message: string; code?: string } | null
}

export interface ConfirmationAuthClient {
  verifyOtp: (args: {
    token_hash: string
    type: ConfirmationOtpType
  }) => Promise<ConfirmationAuthResult>
  exchangeCodeForSession: (code: string) => Promise<ConfirmationAuthResult>
}

export type ConfirmationLinkResolution =
  | { status: "confirmed"; accessToken: string; userId: string }
  | { status: "invalid" }

/**
 * Pura, sin I/O: dice si `resolveConfirmationLink(...)` VA a llamar a un
 * método que consume el token (`verifyOtp` o `exchangeCodeForSession`) para
 * estos params. `app/confirmar-email/page.tsx` la usa para decidir si
 * mostrar la pantalla de confirmación humana ANTES de siquiera invocar
 * `resolveConfirmationLink` -- un GET/render automático (bot, scanner,
 * prefetch, preview) nunca debe disparar esos dos métodos.
 */
export function hasConsumableConfirmationToken(
  params: ConfirmationLinkParams,
): boolean {
  return Boolean(params.tokenHash || params.code)
}

export async function resolveConfirmationLink(
  auth: ConfirmationAuthClient,
  params: ConfirmationLinkParams,
): Promise<ConfirmationLinkResolution> {
  if (params.tokenHash) {
    const { data, error } = await auth.verifyOtp({
      token_hash: params.tokenHash,
      type: getConfirmationOtpType(params.type),
    })

    if (error || !data.session || !data.user) return { status: "invalid" }
    return {
      status: "confirmed",
      accessToken: data.session.access_token,
      userId: data.user.id,
    }
  }

  if (params.code) {
    const { data, error } = await auth.exchangeCodeForSession(params.code)

    if (error || !data.session || !data.user) return { status: "invalid" }
    return {
      status: "confirmed",
      accessToken: data.session.access_token,
      userId: data.user.id,
    }
  }

  return { status: "invalid" }
}
