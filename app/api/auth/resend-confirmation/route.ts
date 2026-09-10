import { NextResponse } from "next/server"

import { requestConfirmationResend } from "@/lib/auth/resend-confirmation"
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
 * Reenvío del correo de confirmación de cuenta. Toda la protección contra
 * abuso (piso de segundos entre intentos + topes por hora/día, por email e
 * IP) vive server-side en `lib/auth/resend-confirmation.ts` -- el cooldown
 * de 30s del botón en el frontend es sólo UX y nunca la única barrera. La
 * respuesta pública es SIEMPRE la misma, sin importar el resultado real.
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => null)) as {
      email?: unknown
    } | null

    const result = await requestConfirmationResend({
      admin: createAdminClient(),
      emailRaw: body?.email,
      ip: getClientIp(request),
      siteUrl: resolveTrustedSiteUrl(request),
    })

    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status })
    }

    return NextResponse.json({ ok: true, message: result.message })
  } catch (error) {
    console.error("RESEND_CONFIRMATION_ROUTE_ERROR", error)
    return NextResponse.json(
      { error: "No pudimos procesar la solicitud. Intentá nuevamente." },
      { status: 500 },
    )
  }
}
