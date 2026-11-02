import { after, NextResponse } from "next/server"

import { requestPasswordRecovery } from "@/lib/auth/forgot-password"
import { getValidTrustedClientIp } from "@/lib/auth/trusted-client-ip"
import { resolveConfiguredSiteUrl } from "@/lib/site-url"
import { createAdminClient } from "@/lib/supabase/admin"

/**
 * "Olvidé mi contraseña", con username O email. Toda la resolución
 * identificador -> cuenta pasa server-side y DESPUÉS de responder (`after`),
 * ver lib/auth/forgot-password.ts. `requestPasswordRecovery` nunca lanza:
 * cualquier fallo interno termina en la misma respuesta neutra, con el mismo
 * piso temporal.
 *
 * - URL del enlace: sólo `NEXT_PUBLIC_SITE_URL` (nunca Origin/Host).
 * - IP: sólo `X-Real-IP` (Nginx la sobrescribe con $remote_addr) y sólo si
 *   es una IP válida; `X-Forwarded-For` nunca se lee. Sin IP confiable sigue
 *   aplicando el límite por identificador.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as {
    identifier?: unknown
  } | null

  const result = await requestPasswordRecovery({
    admin: createAdminClient,
    identifierRaw: body?.identifier,
    ip: getValidTrustedClientIp(request.headers),
    siteUrl: resolveConfiguredSiteUrl(),
    defer: after,
  })

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status })
  }

  return NextResponse.json({ ok: true, message: result.message })
}
