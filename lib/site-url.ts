import "server-only"

/**
 * URL pública de BEYONIX para construir enlaces que SALEN del servidor
 * (back_urls y notification_url de Mercado Pago, links de recuperación de
 * contraseña, etc.).
 *
 * `Origin` lo elige por completo quien hace la request: nunca puede ser la
 * fuente de verdad de una URL sensible. Un `Origin: https://atacante.example`
 * en /api/auth/reset-password hacía que Supabase enviara el link de
 * recuperación apuntando al dominio del atacante; en Mercado Pago desviaba el
 * webhook de notificación y el retorno del pago.
 *
 * Regla: manda siempre `NEXT_PUBLIC_SITE_URL`. Sólo fuera de producción se
 * acepta el `Origin` de la request (comodidad de desarrollo con puertos y
 * túneles variables). En producción, si falta la variable, se devuelve `null`
 * y quien llama corta la operación -- nunca se adivina un dominio.
 */
export function resolveTrustedSiteUrl(request?: Request): string | null {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim()

  if (configured) {
    const parsed = safeParseOrigin(configured)
    if (!parsed) return null

    if (
      process.env.NODE_ENV === "production" &&
      (parsed.protocol !== "https:" ||
        ["localhost", "127.0.0.1"].includes(parsed.hostname))
    ) {
      return null
    }

    return parsed.origin
  }

  if (process.env.NODE_ENV === "production") return null

  const origin = request?.headers.get("origin")
  return safeParseOrigin(origin ?? "")?.origin ?? "http://localhost:3000"
}

function safeParseOrigin(value: string) {
  try {
    return new URL(value)
  } catch {
    return null
  }
}
