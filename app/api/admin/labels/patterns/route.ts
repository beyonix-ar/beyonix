import { requireInternalUser } from "@/lib/auth/admin-api"
import { isPrintableBarcode } from "@/lib/barcodes/codes"
import { LABEL_ROLES } from "@/lib/labels/api-roles"
import type { BarcodePattern } from "@/lib/labels/drawing"
import { encodeBarcodePattern } from "@/lib/labels/encode"

// Códigos distintos por pedido; las copias no cuentan.
const MAX_CODES = 500

export async function POST(request: Request) {
  const auth = await requireInternalUser(request, [...LABEL_ROLES])
  if ("error" in auth) return auth.error
  const headers = { "Cache-Control": "no-store" }
  const body = (await request.json().catch(() => null)) as { codes?: unknown } | null
  const codes = Array.isArray(body?.codes) ? [...new Set(body.codes)] : []
  if (!codes.length || codes.length > MAX_CODES || !codes.every((code): code is string => typeof code === "string" && code.length <= 64 && isPrintableBarcode(code))) {
    return Response.json({ error: "Hay códigos que no se pueden imprimir." }, { status: 400, headers })
  }
  const patterns: Record<string, BarcodePattern> = {}
  const errors: Record<string, string> = {}
  for (const code of codes) {
    try {
      patterns[code] = encodeBarcodePattern(code)
    } catch {
      errors[code] = "No se pudo generar el código de barras."
    }
  }
  return Response.json({ patterns, errors }, { headers })
}
