import { NextResponse } from "next/server"

import { requireOperator } from "@/app/api/admin/clientes/_auth"
import { AndreaniError, normalizeAndreaniError } from "@/lib/andreani/client"
import { fetchAndreaniOrderLabel } from "@/lib/andreani/dispatch-shipment"
import { validId } from "@/lib/admin/dispatch"

type Context = { params: Promise<{ id: string }> }

/**
 * Etiqueta Andreani para Despachos: sólo entrega el PDF. Imprimir no confirma
 * nada; el pedido queda listo para el Bulto general recién cuando el operador
 * escanea el seguimiento impreso (acción confirm_label del pedido).
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

  return new NextResponse(Buffer.from(label.data), {
    headers: {
      "Content-Type": label.contentType,
      "Content-Disposition": `inline; filename="andreani-${label.envioId}.${formato}"`,
      "Cache-Control": "private, no-store",
    },
  })
}
