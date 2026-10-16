import { NextResponse } from "next/server"

import { requireOperator } from "@/app/api/admin/clientes/_auth"
import { AndreaniError, normalizeAndreaniError } from "@/lib/andreani/client"
import { fetchAndreaniOrderLabel } from "@/lib/andreani/dispatch-shipment"
import { validId } from "@/lib/admin/dispatch"

type Context = { params: Promise<{ id: string }> }

/**
 * Etiqueta Andreani para Despachos. Imprimirla identifica físicamente el
 * pedido (confirm_order_andreani_label): es la etiqueta que después se escanea
 * en el Bulto general. Reimprimir no cambia el primer registro.
 */
export async function POST(request: Request, context: Context) {
  const id = validId((await context.params).id)
  if (!id) return Response.json({ error: "Pedido inválido." }, { status: 400 })
  const auth = await requireOperator(request)
  if ("error" in auth) return auth.error
  const body = await request.json().catch(() => null) as { formato?: unknown } | null
  const formato = body?.formato === "zpl" ? "zpl" : "pdf"

  let label: Awaited<ReturnType<typeof fetchAndreaniOrderLabel>>
  try {
    label = await fetchAndreaniOrderLabel(auth.admin, id, formato)
  } catch (error) {
    const safeError = normalizeAndreaniError(error)
    console.error("DISPATCH_ANDREANI_LABEL_ERROR", { orderId: id, code: safeError.code, status: safeError.status, requestId: safeError.requestId })
    return Response.json({ error: safeError.message }, { status: error instanceof AndreaniError && error.code === "VALIDATION_ERROR" ? 409 : 502 })
  }

  // Sólo un pedido con el pickeo completo queda identificado; la etiqueta se
  // entrega igual (p. ej. reimpresión de un pedido ya en el Bulto general).
  const identified = await auth.admin.rpc("confirm_order_andreani_label", { p_order_id: id, p_actor_id: auth.user.id })
  if (identified.error && !/DISPATCH_PACKAGE_NOT_PREPARED|DISPATCH_PREPARATION_NOT_STARTED/.test(identified.error.message)) {
    console.error("DISPATCH_ANDREANI_LABEL_IDENTIFICATION_ERROR", { orderId: id, message: identified.error.message })
  }

  return new NextResponse(Buffer.from(label.data), {
    headers: {
      "Content-Type": label.contentType,
      "Content-Disposition": `inline; filename="andreani-${label.envioId}.${formato}"`,
      "Cache-Control": "private, no-store",
      "X-Dispatch-Identified": identified.error ? "false" : "true",
    },
  })
}
