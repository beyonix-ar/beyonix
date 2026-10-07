import { requireInternalUser } from "@/lib/auth/admin-api"
import { isPrintableBarcode } from "@/lib/barcodes/codes"
import { renderCode128Svg } from "@/lib/barcodes/render"

// Límite técnico de payload por pedido de impresión (códigos distintos; las
// copias de un mismo código no cuentan). La UI agrupa en tandas si hiciera falta.
const MAX_CODES = 500

export async function POST(request: Request) {
  const auth = await requireInternalUser(request, ["operador", "admin", "super_admin"])
  if ("error" in auth) return auth.error
  const body = (await request.json().catch(() => null)) as { codes?: unknown } | null
  const codes = Array.isArray(body?.codes) ? [...new Set(body.codes)] : []
  if (!codes.length || codes.length > MAX_CODES || !codes.every((code): code is string => typeof code === "string" && isPrintableBarcode(code))) {
    return Response.json({ error: "Hay códigos que no se pueden imprimir en Code 128." }, { status: 400 })
  }
  try {
    return Response.json(
      { svgs: Object.fromEntries(codes.map((code) => [code, renderCode128Svg(code)])) },
      { headers: { "Cache-Control": "no-store" } },
    )
  } catch {
    return Response.json({ error: "No se pudieron generar los códigos de barras." }, { status: 500 })
  }
}
