import { requireOperator } from "@/app/api/admin/clientes/_auth"
import { getBatchDispatch, validId } from "@/lib/admin/dispatch"
import { renderDispatchBarcode } from "@/lib/admin/dispatch-barcode"

type Context = { params: Promise<{ id: string }> }

export async function GET(request: Request, context: Context) {
  const id = validId((await context.params).id)
  if (!id) return Response.json({ error: "Tanda inválida." }, { status: 400 })
  const auth = await requireOperator(request)
  if ("error" in auth) return auth.error
  const detail = await getBatchDispatch(auth.admin, id).catch(() => null)
  if (!detail || detail.batch.status === "open") return Response.json({ error: "Cerrá la tanda para imprimir su etiqueta." }, { status: 409 })
  const svg = renderDispatchBarcode(detail.batch.code)
  return new Response(svg, { headers: { "Content-Type": "image/svg+xml; charset=utf-8", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } })
}
