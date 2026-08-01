import { requireInternalUser } from "@/lib/auth/admin-api"
import {
  calculateInventoryStock,
  classifyReturnStock,
} from "@/lib/inventory/stock-metrics"
import type { SupabaseClient } from "@supabase/supabase-js"

function parseProductId(value: string) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

function parseAllocations(value: unknown) {
  if (!Array.isArray(value)) return null

  const allocations = value.map((item) => {
    const record =
      item && typeof item === "object"
        ? (item as Record<string, unknown>)
        : {}
    return {
      variant_id: Number(record.variant_id),
      quantity: Number(record.quantity),
    }
  })

  return allocations.every(
    (item) =>
      Number.isInteger(item.variant_id) &&
      item.variant_id > 0 &&
      Number.isInteger(item.quantity) &&
      item.quantity >= 0,
  )
    ? allocations
    : null
}

async function loadDistribution(
  admin: SupabaseClient,
  productId: number,
) {
  const [
    productResult,
    variantsResult,
    allocationsResult,
    genericResult,
    returnsResult,
    reservationsResult,
  ] =
    await Promise.all([
      admin
        .from("productos")
        .select("id, stock")
        .eq("id", productId)
        .maybeSingle(),
      admin
        .from("producto_variantes")
        .select("id, stock")
        .eq("producto_id", productId)
        .order("orden")
        .order("id"),
      admin
        .from("inventory_variant_allocations")
        .select("variant_id, quantity")
        .eq("product_id", productId),
      admin
        .from("inventory_movements")
        .select("quantity_delta")
        .eq("product_id", productId)
        .is("variant_id", null),
      admin
        .from("inventory_return_movements")
        .select(
          "received_quantity, sellable_quantity, discounted_quantity, non_sellable_quantity",
        )
        .eq("product_id", productId),
      admin
        .from("stock_reservations")
        .select("variant_id, conditioned_stock_id, quantity")
        .eq("product_id", productId)
        .gt("expires_at", new Date().toISOString()),
    ])

  const migrationError =
    allocationsResult.error &&
    /inventory_variant_allocations|schema cache/i.test(
      allocationsResult.error.message,
    )
  if (migrationError) {
    return {
      error: Response.json(
        { error: "Falta aplicar la migración 098_variant_stock_allocations.sql." },
        { status: 503 },
      ),
    }
  }
  const reservationMigrationError =
    reservationsResult.error &&
    /stock_reservations|schema cache/i.test(reservationsResult.error.message)
  if (reservationMigrationError) {
    return {
      error: Response.json(
        { error: "Falta aplicar la migración 20260801095000_stock_reservations.sql." },
        { status: 503 },
      ),
    }
  }
  if (
    productResult.error ||
    variantsResult.error ||
    allocationsResult.error ||
    genericResult.error ||
    returnsResult.error ||
    reservationsResult.error
  ) {
    return {
      error: Response.json(
        { error: "No se pudo cargar la distribución del inventario." },
        { status: 500 },
      ),
    }
  }
  if (!productResult.data) {
    return {
      error: Response.json(
        { error: "El producto ya no existe." },
        { status: 404 },
      ),
    }
  }

  const allocationByVariant = new Map(
    (allocationsResult.data ?? []).map((row) => [
      Number(row.variant_id),
      Number(row.quantity),
    ]),
  )
  const genericBalance = (genericResult.data ?? []).reduce(
    (total, movement) => total + Number(movement.quantity_delta ?? 0),
    0,
  )
  const assignableQuantity = Math.max(0, genericBalance)
  const allocatedQuantity = [...allocationByVariant.values()].reduce(
    (total, quantity) => total + quantity,
    0,
  )
  const returns = (returnsResult.data ?? []).reduce(
    (total, movement) => {
      const classified = classifyReturnStock({
        received: movement.received_quantity,
        sellable: movement.sellable_quantity,
        discounted: movement.discounted_quantity,
        nonSellable: movement.non_sellable_quantity,
      })
      return {
        discounted: total.discounted + classified.discounted,
        nonSellable: total.nonSellable + classified.nonSellable,
        pendingReview: total.pendingReview + classified.pendingReview,
      }
    },
    { discounted: 0, nonSellable: 0, pendingReview: 0 },
  )
  const stock = calculateInventoryStock({
    normal: productResult.data.stock,
    discounted: returns.discounted,
    nonSellable: returns.nonSellable,
    pendingReview: returns.pendingReview,
  })
  const reservations = reservationsResult.data ?? []
  const reservedByVariant = new Map<number, number>()
  reservations.forEach((reservation) => {
    if (reservation.conditioned_stock_id || reservation.variant_id == null) return
    const variantId = Number(reservation.variant_id)
    reservedByVariant.set(
      variantId,
      (reservedByVariant.get(variantId) ?? 0) + Number(reservation.quantity ?? 0),
    )
  })
  const normalReserved = reservations.reduce(
    (total, reservation) =>
      reservation.conditioned_stock_id
        ? total
        : total + Number(reservation.quantity ?? 0),
    0,
  )
  const discountedReserved = reservations.reduce(
    (total, reservation) =>
      reservation.conditioned_stock_id
        ? total + Number(reservation.quantity ?? 0)
        : total,
    0,
  )
  const reservedStock = normalReserved + discountedReserved

  return {
    data: {
      totalStock: stock.normal,
      normalStock: stock.normal,
      discountedStock: stock.discounted,
      nonSellableStock: stock.nonSellable,
      pendingReviewStock: stock.pendingReview,
      sellableStock: stock.sellable,
      quarantineStock: stock.quarantine,
      physicalStock: stock.physical,
      reservedStock,
      availableStock:
        Math.max(0, stock.normal - normalReserved) +
        Math.max(0, stock.discounted - discountedReserved),
      genericBalance,
      assignableQuantity,
      allocatedQuantity,
      unassignedQuantity: Math.max(0, assignableQuantity - allocatedQuantity),
      allocationOverflow: Math.max(
        0,
        allocatedQuantity - assignableQuantity,
      ),
      variants: (variantsResult.data ?? []).map((variant) => {
        const variantId = Number(variant.id)
        const reservedQuantity = reservedByVariant.get(variantId) ?? 0
        return {
          variant_id: variantId,
          allocated_quantity: allocationByVariant.get(variantId) ?? 0,
          reserved_quantity: reservedQuantity,
          available_quantity: Math.max(
            0,
            Number(variant.stock ?? 0) - reservedQuantity,
          ),
        }
      }),
    },
  }
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await requireInternalUser(request)
  if ("error" in auth) return auth.error

  const productId = parseProductId((await context.params).id)
  if (!productId) {
    return Response.json({ error: "Producto inválido." }, { status: 400 })
  }

  const result = await loadDistribution(auth.admin, productId)
  return "error" in result
    ? result.error
    : Response.json(result.data)
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await requireInternalUser(request, ["admin", "super_admin"])
  if ("error" in auth) return auth.error

  const productId = parseProductId((await context.params).id)
  const body = (await request.json().catch(() => null)) as
    | Record<string, unknown>
    | null
  const allocations = parseAllocations(body?.allocations)
  if (!productId || !allocations) {
    return Response.json(
      { error: "La distribución indicada no es válida." },
      { status: 400 },
    )
  }

  const { error } = await auth.admin.rpc("set_product_variant_allocations", {
    p_product_id: productId,
    p_allocations: allocations,
    p_actor_id: auth.user.id,
  })
  if (error) {
    const missingMigration =
      /set_product_variant_allocations|schema cache/i.test(error.message)
    return Response.json(
      {
        error: missingMigration
          ? "Falta aplicar la migración 098_variant_stock_allocations.sql."
          : error.message,
      },
      { status: missingMigration ? 503 : 400 },
    )
  }

  const result = await loadDistribution(auth.admin, productId)
  return "error" in result
    ? result.error
    : Response.json(result.data)
}
