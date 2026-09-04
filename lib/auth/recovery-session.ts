import "server-only"

/**
 * Confirma que un access token de Supabase se emitió específicamente a
 * través del flujo de RECUPERACIÓN de contraseña, no de cualquier sesión
 * autenticada normal.
 *
 * Supabase incluye en el JWT el claim estándar `amr` (Authentication Methods
 * Reference, RFC 8176) con el método usado para autenticar esa sesión
 * puntual. Cuando la sesión se estableció vía
 * `verifyOtp({ type: "recovery" })` / `exchangeCodeForSession` de un enlace
 * de recuperación, `amr` incluye una entrada con `method: "recovery"`. Es la
 * forma documentada por Supabase de distinguir "esta sesión vino de
 * recuperar contraseña" de "el usuario ya estaba logueado".
 *
 * Sin este chequeo, cualquier sesión autenticada válida (por ejemplo, una
 * sesión normal robada o simplemente el usuario ya logueado navegando a
 * /reset-password) podría cambiar la contraseña sin haber pasado por el
 * flujo de recuperación real. El token ya se validó criptográficamente
 * contra Supabase antes de llegar acá (vía `admin.auth.getUser`), así que
 * decodificar el payload sin re-verificar la firma es seguro: si el token
 * fuera inválido o estuviera alterado, `getUser` ya lo habría rechazado.
 */
export function isRecoverySessionToken(accessToken: string): boolean {
  const segments = accessToken.split(".")
  if (segments.length !== 3) return false

  try {
    const payloadJson = Buffer.from(
      segments[1].replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    ).toString("utf8")
    const payload = JSON.parse(payloadJson) as { amr?: unknown }

    if (!Array.isArray(payload.amr)) return false

    return payload.amr.some(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        (entry as { method?: unknown }).method === "recovery",
    )
  } catch {
    return false
  }
}
