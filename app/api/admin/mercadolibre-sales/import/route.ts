import { requireInternalUser } from "@/lib/auth/admin-api"

interface MercadoLibreSaleInput {
  sale_date?: string | null
  operation_id?: string | null
  order_id?: string | null
  product_name?: string | null
  sku?: string | null
  quantity?: number | null
  gross_amount?: number | null
  fee_amount?: number | null
  shipping_amount?: number | null
  net_amount?: number | null
  source_file_name?: string | null
  raw_data?: Record<string, unknown>
}

function toNumber(value: unknown) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function normalizeSale(row: MercadoLibreSaleInput, importedBy: string) {
  return {
    sale_date: row.sale_date || null,
    operation_id: row.operation_id || null,
    order_id: row.order_id || null,
    product_name: row.product_name?.trim() || "Venta MercadoLibre",
    sku: row.sku || null,
    quantity: Math.max(1, Math.trunc(toNumber(row.quantity) ?? 1)),
    gross_amount: toNumber(row.gross_amount) ?? 0,
    fee_amount: toNumber(row.fee_amount),
    shipping_amount: toNumber(row.shipping_amount),
    net_amount: toNumber(row.net_amount),
    source_file_name: row.source_file_name || null,
    imported_by: importedBy,
    raw_data: row.raw_data ?? {},
  }
}

export async function POST(request: Request) {
  const auth = await requireInternalUser(request, ["admin", "super_admin"])
  if ("error" in auth) return auth.error

  const body = (await request.json()) as {
    rows?: MercadoLibreSaleInput[]
    sourceFileName?: string
  }
  const rows = body.rows ?? []

  if (!rows.length) {
    return Response.json(
      { error: "No hay ventas para importar." },
      { status: 400 }
    )
  }

  const payload = rows.map((row) =>
    normalizeSale(
      {
        ...row,
        source_file_name: row.source_file_name || body.sourceFileName || null,
      },
      auth.user.id
    )
  )

  const { error } = await auth.admin.from("mercadolibre_sales").insert(payload)

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  return Response.json({ imported: payload.length })
}
