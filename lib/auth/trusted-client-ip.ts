/** Nginx debe sobrescribir X-Real-IP con $remote_addr tras validar Cloudflare. */
export function getTrustedClientIp(request: Request) {
  return request.headers.get("x-real-ip")?.trim() || null
}
