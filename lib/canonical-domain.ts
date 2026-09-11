/**
 * Canonicalización de dominio: www.beyonix.com.ar -> beyonix.com.ar.
 * Módulo sin dependencias (ni next/server ni Supabase) a propósito, para que
 * `proxy.ts` pueda usarlo y a la vez sea testeable en aislamiento total.
 *
 * CAUSA RAÍZ (confirmada en producción, detrás de Nginx): `request.nextUrl.hostname`
 * no refleja de forma confiable el header HTTP `Host` real reenviado por el
 * reverse proxy -- `curl -H "Host: www.beyonix.com.ar" http://127.0.0.1:3000/...`
 * devolvía 200 en vez de 301 pese a que Nginx ya hace `proxy_set_header Host
 * $host` correctamente. La detección debe leer el header `Host` crudo
 * (`request.headers.get("host")`), nunca `nextUrl.hostname`.
 *
 * Comparación exacta contra un hostname literal (nunca un `.includes`/regex
 * amplio) para no atrapar por accidente localhost, previews de Vercel u
 * otro host. El destino es un origin fijo hardcodeado -- NUNCA se construye
 * a partir de Host/X-Forwarded-Host/Origin/Referer del request (el Host sólo
 * se usa como condición booleana), para no abrir un open redirect.
 */
const CANONICAL_WWW_HOSTNAME = "www.beyonix.com.ar"
const CANONICAL_ORIGIN = "https://beyonix.com.ar"

/**
 * Normaliza el header `Host` crudo: trim, minúsculas, y quita únicamente el
 * puerto final si existe (`www.beyonix.com.ar:3000` -> `www.beyonix.com.ar`).
 * No usa `URL`/`new URL(host)` porque un `Host` sin esquema no parsea como
 * origin válido -- sólo se quita el último `:puerto` con una regex anclada al
 * final del string, lo que también deja intacta cualquier dirección IPv6
 * entre corchetes (`[::1]:3000` -> `[::1]`).
 */
function normalizeHostHeader(hostHeader: string | null): string | null {
  if (!hostHeader) return null
  const normalized = hostHeader.trim().toLowerCase().replace(/:\d+$/, "")
  return normalized || null
}

/**
 * Devuelve la URL canónica a la que redirigir si el header `Host` (crudo, tal
 * cual llega en la request -- nunca `nextUrl.hostname`) es exactamente el www
 * canónico, o `null` si no corresponde redirigir. Preserva pathname y query
 * string exactos.
 */
export function getCanonicalWwwRedirectUrl(
  hostHeader: string | null,
  pathname: string,
  search: string,
): string | null {
  if (normalizeHostHeader(hostHeader) !== CANONICAL_WWW_HOSTNAME) return null
  return new URL(`${pathname}${search}`, CANONICAL_ORIGIN).toString()
}
