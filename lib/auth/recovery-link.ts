/**
 * Decide si un enlace de recuperación de contraseña es válido, extraído de
 * `app/reset-password/page.tsx` para poder testearlo con casos reales
 * (válido, vencido, ya utilizado, token_hash ausente, type incorrecto, error
 * de Supabase) sin necesitar un navegador real -- el componente sólo aplica
 * el resultado a su estado de UI (ver `prepareSession` en esa página, que
 * llama a esta función con el cliente real de Supabase).
 *
 * Soporta los tres formatos que Supabase puede usar para el link de
 * recuperación, en este orden de prioridad:
 * 1. `?code=...` (PKCE) -> exchangeCodeForSession
 * 2. `?token_hash=...&type=recovery` (el que manda hoy el email de BEYONIX,
 *    ver supabase/email-templates/reset-password.html) -> verifyOtp
 * 3. `#access_token=...&refresh_token=...` (implícito, legado) -> setSession
 * 4. Sesión ya establecida (recarga de la página, u onAuthStateChange ya
 *    procesó el evento) + marca de recuperación en localStorage o algún
 *    parámetro de recovery en la URL.
 *
 * IMPORTANTE: Supabase (GoTrue) no distingue "token vencido" de "token ya
 * utilizado" en la respuesta de error de verifyOtp/exchangeCodeForSession --
 * ambos casos llegan acá como el mismo tipo de error genérico. Por eso las
 * pruebas para "vencido" y "ya utilizado" usan mensajes/códigos de error
 * distintos (los que Supabase realmente puede devolver en cada caso) pero
 * ambas deben resolver "invalid": no hay forma de tratarlos distinto de
 * este lado sin que Supabase exponga esa distinción.
 */

export interface RecoveryLinkParams {
  code: string | null
  tokenHash: string | null
  type: string | null
  recovery: string | null
  accessToken: string | null
  refreshToken: string | null
  hashType: string | null
  hashError: string | null
  queryError: string | null
}

export interface RecoveryAuthClient {
  exchangeCodeForSession: (
    code: string,
  ) => Promise<{ error: { message: string; code?: string } | null }>
  verifyOtp: (args: {
    token_hash: string
    type: "recovery"
  }) => Promise<{ error: { message: string; code?: string } | null }>
  setSession: (args: {
    access_token: string
    refresh_token: string
  }) => Promise<{ error: { message: string; code?: string } | null }>
  getSession: () => Promise<{
    data: { session: { access_token: string } | null }
  }>
}

export type RecoveryLinkResolution =
  | { status: "valid"; accessToken: string }
  | { status: "invalid" }

/**
 * Pura, sin I/O: dice si `resolveRecoveryLink(...)` VA a llamar a un método
 * que consume el token de recuperación (`exchangeCodeForSession`,
 * `verifyOtp` o `setSession`) para estos params. `app/reset-password/page.tsx`
 * la usa para decidir si mostrar la pantalla de confirmación humana ANTES de
 * siquiera invocar `resolveRecoveryLink` -- un GET/render automático (bot,
 * scanner, prefetch, preview) nunca debe disparar esos tres métodos.
 *
 * El único caso que NO requiere confirmación pese a haber "parámetros de
 * recovery" es el fallback de sesión ya establecida (recarga de la página
 * tras ya haber confirmado una vez): ese camino sólo llama a `getSession()`,
 * que es de sólo lectura y no consume nada -- no hace falta gatearlo.
 */
export function hasConsumableRecoveryToken(params: RecoveryLinkParams): boolean {
  return Boolean(
    params.code ||
      (params.tokenHash && params.type === "recovery") ||
      (params.accessToken && params.refreshToken),
  )
}

async function markValid(
  auth: RecoveryAuthClient,
): Promise<RecoveryLinkResolution> {
  const { data } = await auth.getSession()
  const token = data.session?.access_token ?? ""

  if (!token) return { status: "invalid" }

  return { status: "valid", accessToken: token }
}

export async function resolveRecoveryLink(
  auth: RecoveryAuthClient,
  params: RecoveryLinkParams,
  hasRecoveryMarker: boolean,
): Promise<RecoveryLinkResolution> {
  const hasRecoveryToken =
    Boolean(
      params.code || params.tokenHash || params.accessToken || params.refreshToken,
    ) ||
    params.type === "recovery" ||
    params.hashType === "recovery" ||
    params.recovery === "1"

  // Un error explícito (link vencido/ya usado, redirect_to rechazado, etc.)
  // corta acá SIEMPRE, sin importar qué otros parámetros vinieran también.
  if (params.hashError || params.queryError) {
    return { status: "invalid" }
  }

  if (params.code) {
    const { error } = await auth.exchangeCodeForSession(params.code)
    if (error) return { status: "invalid" }
    return markValid(auth)
  }

  // type debe ser EXACTAMENTE "recovery": un token_hash con otro type (ej.
  // "signup", "email") es de un flujo distinto y no debe consumirse acá.
  if (params.tokenHash && params.type === "recovery") {
    const { error } = await auth.verifyOtp({
      token_hash: params.tokenHash,
      type: "recovery",
    })
    if (error) return { status: "invalid" }
    return markValid(auth)
  }

  if (params.accessToken && params.refreshToken) {
    const { error } = await auth.setSession({
      access_token: params.accessToken,
      refresh_token: params.refreshToken,
    })
    if (error) return { status: "invalid" }
    return markValid(auth)
  }

  const { data } = await auth.getSession()
  if (data.session && (hasRecoveryMarker || hasRecoveryToken)) {
    return markValid(auth)
  }

  return { status: "invalid" }
}
