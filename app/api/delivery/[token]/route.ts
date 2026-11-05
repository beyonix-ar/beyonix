import { runCourierAction } from "@/lib/orders/local-delivery-courier"
import { CourierActionRequestError, isLocalDeliveryAccessToken, parseCourierActionRequest } from "@/lib/shipping/local-delivery-outcome"
import { createAdminClient } from "@/lib/supabase/admin"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Context = { params: Promise<{ token: string }> }

const NO_STORE = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" }

/**
 * Resultado de la entrega informado por el cadete desde el QR. Sin sesión: el
 * token (validado en la base, bajo lock) sólo permite registrar Entregado,
 * Cliente ausente o Problema con la entrega de ESE pedido.
 */
export async function POST(request: Request, context: Context) {
  const { token } = await context.params
  if (!isLocalDeliveryAccessToken(token)) {
    return Response.json({ ok: false, message: "Este código QR no es válido." }, { status: 404, headers: NO_STORE })
  }
  const bodySize = Number(request.headers.get("content-length") ?? 0)
  if (bodySize > 4096) return Response.json({ ok: false, message: "Acción inválida." }, { status: 413, headers: NO_STORE })
  let parsed: ReturnType<typeof parseCourierActionRequest>
  try {
    parsed = parseCourierActionRequest(await request.json())
  } catch (cause) {
    const message = cause instanceof CourierActionRequestError ? cause.message : "Acción inválida."
    return Response.json({ ok: false, message }, { status: 400, headers: NO_STORE })
  }
  try {
    const result = await runCourierAction(createAdminClient(), token, parsed)
    return Response.json(result.body, { status: result.status, headers: NO_STORE })
  } catch {
    return Response.json({ ok: false, message: "No pudimos registrar el resultado. Revisá la conexión y probá de nuevo." }, { status: 503, headers: NO_STORE })
  }
}
