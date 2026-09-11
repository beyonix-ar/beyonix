/**
 * Canonicalización de dominio: www.beyonix.com.ar -> beyonix.com.ar.
 * Módulo sin dependencias (ni next/server ni Supabase) a propósito, para que
 * `proxy.ts` pueda usarlo y a la vez sea testeable en aislamiento total.
 *
 * Comparación exacta contra un hostname literal (nunca un `.includes`/regex
 * amplio) para no atrapar por accidente localhost, previews de Vercel u
 * otro host. El destino es un origin fijo hardcodeado -- NUNCA se construye
 * a partir de Host/X-Forwarded-Host del request, para no abrir un open
 * redirect si esos headers llegaran manipulados.
 */
const CANONICAL_WWW_HOSTNAME = "www.beyonix.com.ar"
const CANONICAL_ORIGIN = "https://beyonix.com.ar"

/**
 * Devuelve la URL canónica a la que redirigir si `hostname` es exactamente
 * el www canónico, o `null` si no corresponde redirigir. Preserva pathname
 * y query string exactos.
 */
export function getCanonicalWwwRedirectUrl(
  hostname: string,
  pathname: string,
  search: string,
): string | null {
  if (hostname !== CANONICAL_WWW_HOSTNAME) return null
  return new URL(`${pathname}${search}`, CANONICAL_ORIGIN).toString()
}
