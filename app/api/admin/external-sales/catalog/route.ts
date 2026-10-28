import { authorizeExternalSales, externalSalesDatabaseError } from "@/lib/admin/external-sales-api"

/** Catálogo liviano para el alta manual: SKU, estado y stock de productos y variantes. */
export async function GET(request: Request) {
  const auth = await authorizeExternalSales(request)
  if ("error" in auth) return auth.error

  const { data, error } = await auth.admin
    .from("productos")
    .select("id, nombre, sku, activo, stock, producto_variantes(id, nombre, sku, activo, stock)")
    .order("nombre", { ascending: true })
  if (error) return externalSalesDatabaseError(error.message)
  return Response.json({ products: data ?? [] }, { headers: { "Cache-Control": "private, no-store" } })
}
