import { requireAdmin } from "@/app/api/admin/clientes/_auth"
import { renderAdminInvoicePdf } from "@/lib/arca/admin-invoice-pdf"
import {
  argentinaToday,
  fiscalMonthBounds,
  fiscalZipName,
  FISCAL_EXPORT_LIMIT,
  type FiscalDocument,
  type FiscalKind,
} from "@/lib/arca/fiscal-history"
import { createFiscalZipStream } from "@/lib/arca/zip-stream"

export const runtime = "nodejs"

interface ExportItem {
  id: string
  orderId: number
  day: string
}

const NO_STORE = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function invalid(message = "Selección fiscal inválida.") {
  return Response.json({ error: message }, { status: 400, headers: NO_STORE })
}

function pdfFilename(response: Response) {
  const disposition = response.headers.get("content-disposition") ?? ""
  const match = disposition.match(/filename="([A-Za-z0-9._-]+\.pdf)"/i)
  if (!match) throw new Error("Nombre de PDF fiscal inválido.")
  return match[1]
}

export async function POST(request: Request) {
  const auth = await requireAdmin(request)
  if ("error" in auth) return auth.error

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return invalid()
  }
  if (!body || typeof body !== "object" || !("kind" in body) || !("scope" in body)) return invalid()
  const kind = body.kind
  const scope = body.scope
  if (kind !== "invoice" && kind !== "credit_note") return invalid()
  if (scope !== "selected" && scope !== "month") return invalid()

  let items: ExportItem[] = []
  let zipName = ""
  if (scope === "selected") {
    if (!("ids" in body) || !Array.isArray(body.ids) || body.ids.length < 1 || body.ids.length > FISCAL_EXPORT_LIMIT ||
        !body.ids.every((id): id is string => typeof id === "string" && (
          kind === "invoice" ? /^\d{1,15}$/.test(id) && Number.isSafeInteger(Number(id)) : UUID.test(id)
        ))) return invalid()
    const ids = [...new Set(body.ids as string[])]
    if (ids.length !== body.ids.length) return invalid()

    if (kind === "invoice") {
      const { data, error } = await auth.admin.from("ordenes")
        .select("id, invoice_created_at")
        .in("id", ids.map(Number))
        .eq("invoice_status", "authorized")
        .not("invoice_cae", "is", null)
        .not("invoice_created_at", "is", null)
      if (error) return Response.json({ error: "No se pudieron validar las facturas." }, { status: 503, headers: NO_STORE })
      items = (data ?? []).map((row) => ({ id: String(row.id), orderId: Number(row.id), day: argentinaToday(new Date(row.invoice_created_at)) }))
    } else {
      const { data, error } = await auth.admin.from("order_credit_notes")
        .select("id, order_id, authorized_at")
        .in("id", ids)
        .eq("status", "authorized")
        .not("cae", "is", null)
        .not("authorized_at", "is", null)
      if (error) return Response.json({ error: "No se pudieron validar las notas de crédito." }, { status: 503, headers: NO_STORE })
      items = (data ?? []).map((row) => ({ id: String(row.id), orderId: Number(row.order_id), day: argentinaToday(new Date(row.authorized_at)) }))
    }
    if (items.length !== ids.length || items.some((item) => item.day.includes("undefined"))) {
      return Response.json({ error: "La selección contiene comprobantes no disponibles." }, { status: 409, headers: NO_STORE })
    }
    const byId = new Map(items.map((item) => [item.id, item]))
    items = ids.map((id) => byId.get(id)!).filter(Boolean)
    zipName = fiscalZipName(kind, items.map((item) => item.day))
  } else {
    if (!("year" in body) || !("month" in body) ||
        typeof body.year !== "number" || typeof body.month !== "number") return invalid()
    let bounds: { from: string; to: string }
    try {
      bounds = fiscalMonthBounds(body.year, body.month)
    } catch {
      return invalid("Mes fiscal inválido.")
    }
    const { data, error } = await auth.admin.rpc("search_admin_fiscal_history", {
      p_kind: kind,
      p_from: bounds.from,
      p_to: bounds.to,
      p_page: 1,
      p_page_size: FISCAL_EXPORT_LIMIT + 1,
    })
    if (error || !data || typeof data !== "object" || !Array.isArray(data.items) || !Number.isSafeInteger(Number(data.total))) {
      return Response.json({ error: "No se pudo consultar el mes fiscal." }, { status: 503, headers: NO_STORE })
    }
    if (Number(data.total) > FISCAL_EXPORT_LIMIT) {
      return Response.json({ error: `El mes supera el límite de ${FISCAL_EXPORT_LIMIT} comprobantes por ZIP. Exportá períodos más pequeños.` }, { status: 413, headers: NO_STORE })
    }
    items = (data.items as FiscalDocument[]).map((item) => ({ id: item.id, orderId: item.order_id, day: item.day }))
    const prefix = kind === "invoice" ? "facturas" : "notas-credito"
    zipName = `${prefix}-beyonix-${bounds.from.slice(0, 7)}.zip`
  }

  if (!items.length) return Response.json({ error: "No hay comprobantes para descargar." }, { status: 404, headers: NO_STORE })

  const getPdf = async (item: ExportItem) => {
    const response = await renderAdminInvoicePdf(auth.admin, item.orderId, kind as FiscalKind, kind === "credit_note" ? item.id : null)
    if (!response.ok) throw new Error("No se pudo regenerar un PDF fiscal.")
    return { name: pdfFilename(response), bytes: new Uint8Array(await response.arrayBuffer()) }
  }

  if (scope === "selected" && items.length === 1) {
    try {
      const pdf = await getPdf(items[0])
      return new Response(pdf.bytes, {
        headers: {
          ...NO_STORE,
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="${pdf.name}"`,
        },
      })
    } catch {
      return Response.json({ error: "No se pudo generar el PDF seleccionado." }, { status: 503, headers: NO_STORE })
    }
  }

  // Se precalcula el primero para detectar errores antes de enviar headers ZIP.
  let first: Awaited<ReturnType<typeof getPdf>>
  try {
    first = await getPdf(items[0])
  } catch {
    return Response.json({ error: "No se pudo generar el primer PDF del ZIP." }, { status: 503, headers: NO_STORE })
  }
  const entries = items.map((item, index) => ({
    document: async () => index === 0 ? first : getPdf(item),
  }))
  return new Response(createFiscalZipStream(entries, request.signal), {
    headers: {
      ...NO_STORE,
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${zipName}"`,
    },
  })
}
