import { NextResponse } from "next/server"

import { requestPasswordRecovery } from "@/lib/auth/forgot-password"
import { resolveTrustedSiteUrl } from "@/lib/site-url"
import { createAdminClient } from "@/lib/supabase/admin"

function getClientIp(request: Request) {
  return (
    request.headers.get("x-nf-client-connection-ip") ||
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-real-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    null
  )
}

/**
 * "Olvidé mi contraseña", con username O email. Toda la resolución
 * identificador -> cuenta pasa server-side (ver lib/auth/forgot-password.ts);
 * el browser nunca recibe si la cuenta existe, cuál es su email, ni ningún
 * dato de auth. La respuesta pública es SIEMPRE la misma, sin importar el
 * resultado real -- ver FORGOT_PASSWORD_GENERIC_MESSAGE.
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => null)) as {
      identifier?: unknown
    } | null

    const result = await requestPasswordRecovery({
      admin: createAdminClient(),
      identifierRaw: body?.identifier,
      ip: getClientIp(request),
      siteUrl: resolveTrustedSiteUrl(request),
    })

    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status })
    }

    return NextResponse.json({ ok: true, message: result.message })
  } catch (error) {
    console.error("FORGOT_PASSWORD_ROUTE_ERROR", error)
    return NextResponse.json(
      { error: "No pudimos procesar la solicitud. Intentá nuevamente." },
      { status: 500 },
    )
  }
}
