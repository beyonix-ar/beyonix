import { requireAdmin } from "@/app/api/admin/clientes/_auth"

export async function GET(request: Request) {
  const auth = await requireAdmin(request)
  if ("error" in auth) return auth.error

  const summaryOnly = new URL(request.url).searchParams.get("summary") === "1"
  const columns =
    "id, cliente_nombre, cliente_email, total, paid_at, created_at, estado, payment_status, financial_status, invoice_status, invoice_cae, invoice_error"
  const query = auth.admin
    .from("ordenes")
    .select(summaryOnly ? "id" : columns, {
      count: summaryOnly ? "exact" : undefined,
      head: summaryOnly,
    })
    .in("payment_status", ["confirmed", "confirmado", "approved"])
    .neq("estado", "cancelado")
    .not("financial_status", "in", "(cancelled,cancellation_requested,refund_pending,refunded)")
    .or("invoice_status.is.null,invoice_status.eq.pending,invoice_status.eq.processing,invoice_status.eq.error")
    .is("invoice_cae", null)

  if (summaryOnly) {
    const { count, error } = await query

    if (error) {
      return Response.json(
        { error: error.message || "No se pudo calcular la facturación pendiente." },
        { status: 500 },
      )
    }

    return Response.json({ count: count ?? 0 })
  }

  const { data, error } = await query
    .order("paid_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })

  if (error) {
    return Response.json(
      { error: error.message || "No se pudieron cargar las facturas pendientes." },
      { status: 500 },
    )
  }

  return Response.json({ orders: data ?? [] })
}
