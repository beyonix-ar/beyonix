import { requireAdmin } from "@/app/api/admin/clientes/_auth"
import { renderAdminInvoicePdf } from "@/lib/arca/admin-invoice-pdf"

export const runtime = "nodejs"

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin(request)
  if ("error" in auth) return auth.error
  const { id } = await params
  const url = new URL(request.url)
  const documentType = url.searchParams.get("type") === "credit_note" ? "credit_note" : "invoice"
  return renderAdminInvoicePdf(auth.admin, Number(id), documentType, url.searchParams.get("note"))
}
