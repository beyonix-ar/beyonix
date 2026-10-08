import { requireInternalUser } from "@/lib/auth/admin-api"
import {
  loadLogisticsOrders,
  loadLogisticsSummary,
  LogisticsRangeError,
  parseLogisticsRange,
} from "@/lib/admin/logistics"

// Datos financieros de logística: sólo Admin/Super Admin (el operador arma
// pedidos pero no ve costos).
const ROLES = ["admin", "super_admin"] as const

export async function GET(request: Request) {
  const auth = await requireInternalUser(request, [...ROLES])
  if ("error" in auth) return auth.error

  const params = new URL(request.url).searchParams
  let range: ReturnType<typeof parseLogisticsRange>
  try {
    range = parseLogisticsRange(params.get("from"), params.get("to"))
  } catch (error) {
    return Response.json({ error: error instanceof LogisticsRangeError ? error.message : "Fechas inválidas." }, { status: 400 })
  }
  const pageValue = Number(params.get("page") ?? "1")
  const page = Number.isSafeInteger(pageValue) && pageValue >= 1 && pageValue <= 10_000 ? pageValue : 1
  const includeOrders = params.get("orders") === "1"

  try {
    const [summary, orders] = await Promise.all([
      loadLogisticsSummary(auth.admin, range),
      includeOrders ? loadLogisticsOrders(auth.admin, range, page) : Promise.resolve(null),
    ])
    return Response.json(
      { range: { from: range.from, to: range.to }, summary, orders },
      { headers: { "Cache-Control": "no-store" } },
    )
  } catch {
    return Response.json({ error: "No se pudo cargar la logística." }, { status: 500 })
  }
}
