import type { AdminApiAuth } from "@/lib/auth/admin-api"

export interface PersistedInvoiceItem {
  id: number
  producto_id: number | null
  variante_id: number | null
  conditioned_name: string | null
  cantidad: number
  precio: number
}

export interface FiscalPdfItem {
  cantidad: number
  precio: number
  productos: { nombre: string }
  producto_variantes: { nombre: string } | null
}

export function fiscalInvoiceTotal(order: { invoice_requested_total?: number | string | null; total?: number | string | null }) {
  return Number(order.invoice_requested_total ?? order.total ?? 0)
}

export async function loadFiscalInvoiceTotal(
  admin: AdminApiAuth["admin"],
  orderId: number,
  order: { invoice_requested_total?: number | string | null; total?: number | string | null },
) {
  const { data, error } = await admin
    .from("arca_invoice_header_snapshots")
    .select("fiscal_total")
    .eq("order_id", orderId)
    .maybeSingle()
  if (error && !["42P01", "PGRST205"].includes(error.code)) {
    throw new Error("No se pudo recuperar el importe fiscal persistido.")
  }
  return data ? Number(data.fiscal_total) : fiscalInvoiceTotal(order)
}

/**
 * El snapshot se fija al reservar el número fiscal. Para instalaciones donde la
 * migración aún no se aplicó o comprobantes anteriores sin captura, el catálogo
 * se consulta únicamente como último recurso. Un nombre ya cambiado antes del
 * backfill histórico no se puede reconstruir con certeza.
 */
export async function loadFiscalPdfItems(
  admin: AdminApiAuth["admin"],
  orderId: number,
  orderItems: PersistedInvoiceItem[],
): Promise<FiscalPdfItem[]> {
  const { data: snapshots, error: snapshotError } = await admin
    .from("arca_invoice_item_snapshots")
    .select("order_item_id, quantity, unit_price, product_name, variant_name")
    .eq("order_id", orderId)
    .order("order_item_id", { ascending: true })

  if (snapshotError && !["42P01", "PGRST205"].includes(snapshotError.code)) {
    throw new Error("No se pudo recuperar el detalle fiscal persistido.")
  }
  if (!snapshotError && snapshots?.length) {
    return snapshots.map((item) => ({
      cantidad: Number(item.quantity),
      precio: Number(item.unit_price),
      productos: { nombre: item.product_name },
      producto_variantes: item.variant_name ? { nombre: item.variant_name } : null,
    }))
  }

  const sortedItems = [...orderItems].sort((a, b) => a.id - b.id)
  const productIds = [...new Set(sortedItems.flatMap((item) => item.producto_id == null ? [] : [item.producto_id]))]
  const variantIds = [...new Set(sortedItems.flatMap((item) => item.variante_id == null ? [] : [item.variante_id]))]
  const [productsResult, variantsResult] = await Promise.all([
    productIds.length
      ? admin.from("productos").select("id, nombre").in("id", productIds)
      : Promise.resolve({ data: [], error: null }),
    variantIds.length
      ? admin.from("producto_variantes").select("id, nombre").in("id", variantIds)
      : Promise.resolve({ data: [], error: null }),
  ])
  if (productsResult.error || variantsResult.error) {
    throw new Error("No se pudieron recuperar los nombres históricos disponibles.")
  }
  const productNames = new Map((productsResult.data ?? []).map((item) => [item.id, item.nombre]))
  const variantNames = new Map((variantsResult.data ?? []).map((item) => [item.id, item.nombre]))

  return sortedItems.map((item) => {
    const variantName = item.conditioned_name?.trim() ||
      (item.variante_id == null ? null : variantNames.get(item.variante_id)) || null
    return {
      cantidad: Number(item.cantidad),
      precio: Number(item.precio),
      productos: { nombre: (item.producto_id == null ? null : productNames.get(item.producto_id)) ||
        (item.producto_id == null ? "Producto eliminado" : `Producto #${item.producto_id}`) },
      producto_variantes: variantName ? { nombre: variantName } : null,
    }
  })
}
