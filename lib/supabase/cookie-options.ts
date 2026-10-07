// El cliente del navegador necesita leer y renovar la sesión con document.cookie.
// Secure se activa en producción y se omite en desarrollo HTTP local.
export function getSupabaseCookieOptions(nodeEnv = process.env.NODE_ENV) {
  return {
    path: "/",
    sameSite: "lax" as const,
    httpOnly: false,
    secure: nodeEnv === "production",
  }
}

export function serializeSupabaseCookieRemoval(
  name: string,
  nodeEnv = process.env.NODE_ENV,
) {
  const { path, sameSite, secure } = getSupabaseCookieOptions(nodeEnv)
  return `${name}=; Max-Age=0; Path=${path}; SameSite=${sameSite}${secure ? "; Secure" : ""}`
}
