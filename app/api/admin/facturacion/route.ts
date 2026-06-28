import { requireAdmin } from "@/app/api/admin/clientes/_auth"

export async function GET(request: Request) {
  const auth = await requireAdmin(request)
  if ("error" in auth) return auth.error

  const { data, error } = await auth.admin
    .from("ordenes")
    .select(
      "id, cliente_nombre, cliente_email, total, paid_at, created_at, estado, payment_status, financial_status, invoice_status, invoice_cae, invoice_error",
    )
    .in("payment_status", ["confirmed", "confirmado", "approved"])
    .neq("estado", "cancelado")
    .not("financial_status", "in", "(cancelled,cancellation_requested,refund_pending,refunded)")
    .or("invoice_status.is.null,invoice_status.eq.pending,invoice_status.eq.processing,invoice_status.eq.error")
    .is("invoice_cae", null)
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
