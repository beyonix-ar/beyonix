import { NextResponse } from "next/server"

import { requireAdmin } from "@/app/api/admin/clientes/_auth"
import { resolveDefaultClaimBranch, searchClaimBranches, type ClaimShipmentDirection } from "@/lib/andreani/claim-shipments"
import { normalizeAndreaniError } from "@/lib/andreani/client"

export const runtime = "nodejs"

const DIRECTIONS: readonly ClaimShipmentDirection[] = ["devolucion", "cambio", "reemplazo"]

/**
 * Buscador de sucursales Andreani para la logística de un reclamo (sólo Admin).
 *   ?q=texto              -> sucursales del catálogo real por nombre, localidad,
 *                            provincia, dirección o código postal.
 *   ?direction=cambio|... -> sucursal sugerida (la del tramo anterior o la de
 *                            BEYONIX configurada), revalidada contra el catálogo
 *                            actual; null si ninguna sigue disponible.
 * Si Andreani no responde, error claro: no hay logística sin sucursal válida.
 */
export async function GET(request: Request, { params }: { params: Promise<{ claimId: string }> }) {
  const auth = await requireAdmin(request)
  if ("error" in auth) return auth.error
  const claimId = Number((await params).claimId)
  if (!Number.isSafeInteger(claimId) || claimId <= 0) {
    return NextResponse.json({ error: "Reclamo inválido." }, { status: 400 })
  }
  const url = new URL(request.url)
  const query = (url.searchParams.get("q") ?? "").trim().slice(0, 80)
  const direction = url.searchParams.get("direction") as ClaimShipmentDirection | null
  try {
    if (query) {
      return NextResponse.json({ branches: await searchClaimBranches(query) }, { headers: { "Cache-Control": "private, no-store" } })
    }
    if (!direction || !DIRECTIONS.includes(direction)) {
      return NextResponse.json({ error: "Solicitud inválida." }, { status: 400 })
    }
    const suggested = await resolveDefaultClaimBranch(auth.admin, claimId, direction).catch((error: unknown) => {
      // Sucursal anterior que ya no existe: el Admin tiene que elegir otra.
      if (normalizeAndreaniError(error).code === "VALIDATION_ERROR") return null
      throw error
    })
    return NextResponse.json({ suggested }, { headers: { "Cache-Control": "private, no-store" } })
  } catch (error) {
    const safe = normalizeAndreaniError(error)
    return NextResponse.json({ error: safe.message }, { status: safe.code === "VALIDATION_ERROR" ? 400 : 502 })
  }
}
