import { requireInternalUser } from "@/lib/auth/admin-api"
import { resolveProductKnownCost } from "@/lib/admin/product-known-cost"
import {
  calculateAvailableStock,
  fetchActiveReservationTotals,
  summarizeProductReservations,
} from "@/lib/inventory/sellable-stock"
import { estimateProductCashProfit, unavailable } from "@/lib/pricing/product-cash-profit"
import { getSinglePaymentCostSettings } from "@/lib/site-settings"

function parseProductId(value: string) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

interface ProductStockRow {
  precio: number | null
  stock: number | null
  activo: boolean | null
  producto_variantes: Array<{ id: number; activo: boolean | null; stock: number | null }> | null
}

/**
 * Ganancia estimada al contado (Mercado Pago, 1 pago) de UN producto, por
 * variante vendible. Exclusivo de Admin: expone costos. Se pide bajo demanda
 * al abrir el ojo de la fila (nunca al renderizar el listado). Primero el
 * producto (si está inactivo se corta acá); después, en paralelo, libro de
 * compras, costo de Mercado Pago y reservas activas.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await requireInternalUser(request, ["admin", "super_admin"])
  if ("error" in auth) return auth.error

  const productId = parseProductId((await context.params).id)
  if (!productId) {
    return Response.json({ error: "Producto inválido." }, { status: 400 })
  }

  try {
    // 1) Producto primero: uno inactivo no se vende (catálogo y carrito lo
    // excluyen), así que se responde sin leer tarifa, costos ni reservas.
    const productResult = await auth.admin
      .from("productos")
      .select("precio, stock, activo, producto_variantes(id, activo, stock)")
      .eq("id", productId)
      .maybeSingle()
    if (productResult.error) throw productResult.error
    if (!productResult.data) {
      return Response.json({ error: "El producto ya no existe." }, { status: 404 })
    }
    const product = productResult.data as ProductStockRow
    const productActive = product.activo === true
    if (!productActive) {
      return Response.json(unavailable("product_inactive"), { headers: { "Cache-Control": "no-store" } })
    }

    // 2) Activo: el resto de las lecturas en paralelo, igual que antes.
    const [knownCost, fee, reservationTotals] = await Promise.all([
      resolveProductKnownCost(auth.admin, productId),
      getSinglePaymentCostSettings(),
      fetchActiveReservationTotals(auth.admin, [productId]),
    ])

    // Stock vendible = físico derivado − reservas activas, con los mismos
    // helpers que catálogo, carrito y checkout (lib/inventory/sellable-stock).
    const reservations = summarizeProductReservations(productId, reservationTotals)
    const variantStock = new Map(
      (product.producto_variantes ?? []).map((variant) => [
        variant.id,
        {
          active: variant.activo !== false,
          availableStock: calculateAvailableStock(variant.stock, reservations.byVariant.get(variant.id) ?? 0),
        },
      ]),
    )
    // Producto simple: su stock es el del padre (mismo `normal` que el catálogo).
    const productStock = {
      active: productActive,
      availableStock: calculateAvailableStock(product.stock, reservations.normal),
    }

    const estimate = estimateProductCashProfit({
      productId,
      productActive,
      price: Number(product.precio),
      variants: knownCost.variantCosts.map((entry) => ({
        variantId: entry.variantId,
        variantName: entry.variantName,
        unitCost: entry.unitCost,
        ...(entry.variantId == null
          ? productStock
          : variantStock.get(entry.variantId) ?? { active: false, availableStock: 0 }),
      })),
      fee,
    })

    return Response.json(estimate, { headers: { "Cache-Control": "no-store" } })
  } catch {
    return Response.json(
      { error: "No se pudo calcular la ganancia estimada." },
      { status: 500 },
    )
  }
}
