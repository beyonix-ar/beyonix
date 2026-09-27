import { requireInternalUser } from "@/lib/auth/admin-api"
import {
  describeStockReservation,
  type StockReservationDetailRow,
} from "@/lib/inventory/stock-reservation-details"

const MAX_ROWS = 200

function parseProductId(value: string) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

/**
 * Qué compone el "Reservado" de un producto: sólo reservas ACTIVAS
 * (expires_at > now(), mismo predicado que la base). Sin session_id ni
 * user_id: el Admin ve cantidad, vencimiento, pedido y estado.
 */
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

  const { data, error } = await auth.admin
    .from("stock_reservations")
    .select("variant_id, conditioned_stock_id, quantity, expires_at, order_id")
    .eq("product_id", productId)
    .gt("expires_at", new Date().toISOString())
    .order("expires_at", { ascending: true })
    .limit(MAX_ROWS)

  if (error) {
    console.error("ADMIN_STOCK_RESERVATIONS_LOAD_ERROR", error)
    return Response.json(
      { error: "No se pudieron cargar las reservas activas." },
      { status: 500 },
    )
  }

  return Response.json({
    reservations: ((data ?? []) as StockReservationDetailRow[]).map(describeStockReservation),
  })
}
