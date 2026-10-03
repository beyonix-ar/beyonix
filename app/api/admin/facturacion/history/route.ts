import { requireAdmin } from "@/app/api/admin/clientes/_auth"
import {
  argentinaToday,
  fiscalDayBounds,
  fiscalPeriodBounds,
  FISCAL_EXPORT_LIMIT,
  FISCAL_PAGE_SIZE,
  type FiscalDocument,
  type FiscalKind,
  type FiscalPeriod,
} from "@/lib/arca/fiscal-history"

export const runtime = "nodejs"

const NO_STORE = { "Cache-Control": "private, no-store" }
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/

function optionalFilter(params: URLSearchParams, name: string, max = 120) {
  const value = params.get(name)?.trim() ?? ""
  if (value.length > max) throw new Error("Filtro demasiado largo.")
  return value || null
}

export async function GET(request: Request) {
  const auth = await requireAdmin(request)
  if ("error" in auth) return auth.error

  const params = new URL(request.url).searchParams
  const kind = params.get("kind")
  const period = params.get("period") ?? "today"
  const idsOnly = params.get("ids") === "1"
  const currentDay = argentinaToday()
  const year = Number(params.get("year") ?? currentDay.slice(0, 4))
  const month = Number(params.get("month") ?? currentDay.slice(5, 7))
  const page = Number(params.get("page") ?? 1)
  const day = params.get("day")

  if ((kind !== "invoice" && kind !== "credit_note") ||
      !["today", "month", "all"].includes(period) ||
      !Number.isSafeInteger(page) || page < 1 || page > 100000 ||
      (day !== null && !ISO_DAY.test(day)) || (idsOnly && !day)) {
    return Response.json({ error: "Filtros fiscales inválidos." }, { status: 400, headers: NO_STORE })
  }

  let filters: Record<string, string | number | null>
  try {
    const bounds = fiscalPeriodBounds(idsOnly ? "all" : period as FiscalPeriod, year, month)
    const from = period === "all" || idsOnly ? optionalFilter(params, "from", 10) : null
    const to = period === "all" || idsOnly ? optionalFilter(params, "to", 10) : null
    const dateFrom = from ? fiscalDayBounds(from).from : bounds.from
    const dateTo = to ? fiscalDayBounds(to).to : bounds.to
    if (dateFrom && dateTo && dateFrom >= dateTo) throw new Error("Rango de fechas inválido.")
    filters = {
      p_kind: kind as FiscalKind,
      p_from: dateFrom,
      p_to: dateTo,
      p_search: optionalFilter(params, "search"),
      p_number: optionalFilter(params, "number", 80),
      p_order: optionalFilter(params, "order", 80),
      p_client: optionalFilter(params, "client"),
      p_document: optionalFilter(params, "document", 80),
      p_date: day || optionalFilter(params, "date", 10),
      p_cae: optionalFilter(params, "cae", 80),
      p_amount: null,
      p_status: optionalFilter(params, "status", 40),
      p_page: idsOnly ? 1 : page,
      p_page_size: idsOnly ? FISCAL_EXPORT_LIMIT + 1 : FISCAL_PAGE_SIZE,
    }
    const amount = params.get("amount")?.trim()
    if (amount) {
      const parsed = Number(amount)
      if (!Number.isFinite(parsed) || parsed < 0) throw new Error("Importe inválido.")
      filters.p_amount = parsed
    }
    if (filters.p_date) fiscalDayBounds(String(filters.p_date))
  } catch {
    return Response.json({ error: "Filtros fiscales inválidos." }, { status: 400, headers: NO_STORE })
  }

  const { data, error } = await auth.admin.rpc("search_admin_fiscal_history", filters)
  if (error || !data || typeof data !== "object" || !Array.isArray(data.items) || !Number.isFinite(Number(data.total))) {
    return Response.json({ error: "No se pudo consultar el historial fiscal." }, { status: 503, headers: NO_STORE })
  }

  const items = data.items as FiscalDocument[]
  const total = Number(data.total)
  if (idsOnly) {
    if (total > FISCAL_EXPORT_LIMIT) {
      return Response.json({ error: `El día supera el límite de ${FISCAL_EXPORT_LIMIT} comprobantes por descarga.` }, { status: 413, headers: NO_STORE })
    }
    return Response.json({ ids: items.map((item) => item.id), total }, { headers: NO_STORE })
  }

  return Response.json({ items, total, page, pageSize: FISCAL_PAGE_SIZE }, { headers: NO_STORE })
}
