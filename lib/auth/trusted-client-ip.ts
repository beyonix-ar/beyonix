import { isIP } from "node:net"

/** Nginx debe sobrescribir X-Real-IP con $remote_addr tras validar Cloudflare. */
export function getTrustedClientIp(request: Request) {
  return getTrustedClientIpFromHeaders(request.headers)
}

/** Igual que `getTrustedClientIp`, para server actions (`headers()` de Next). */
export function getTrustedClientIpFromHeaders(headers: Pick<Headers, "get">) {
  return headers.get("x-real-ip")?.trim() || null
}

/** IP confiable sólo si es una dirección IPv4/IPv6 válida (lista para `inet`). */
export function getValidTrustedClientIp(headers: Pick<Headers, "get">) {
  const ip = getTrustedClientIpFromHeaders(headers)
  return ip && isIP(ip) ? ip : null
}
