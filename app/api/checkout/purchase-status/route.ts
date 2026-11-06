import { NextResponse } from "next/server"

import { verifyGuestOrderAccessToken } from "@/lib/orders/guest-order-token"
import {
  parsePurchaseStatusRequests,
  resolvePurchaseStatuses,
  type PurchaseStatusOrderRow,
} from "@/lib/orders/purchase-status"
import { createAdminClient } from "@/lib/supabase/admin"
import { createClient } from "@/lib/supabase/server"

const ORDER_COLUMNS =
  "id, usuario_id, estado, cancelled_at, financial_status, payment_status, paid_at, payment_confirmed_amount, orden_items(producto_id, variante_id, conditioned_stock_id, cantidad)"

/**
 * Carrito: ¿las compras que este navegador inició ya están pagadas? Sólo
 * responde por pedidos propios (sesión o token de invitado) y sólo devuelve
 * ítems con pago confirmado. Ver lib/orders/purchase-status.ts.
 */
export async function POST(request: Request) {
  const requests = parsePurchaseStatusRequests(await request.json().catch(() => null))
  if (!requests) return NextResponse.json({ error: "Solicitud inválida." }, { status: 400 })

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  const admin = createAdminClient()

  try {
    const orders = await resolvePurchaseStatuses(requests, {
      userId: user?.id ?? null,
      async loadOrders(orderIds) {
        const { data, error } = await admin.from("ordenes").select(ORDER_COLUMNS).in("id", orderIds)
        if (error) throw new Error("PURCHASE_STATUS_READ_FAILED")
        return (data ?? []) as PurchaseStatusOrderRow[]
      },
      verifyGuestToken: verifyGuestOrderAccessToken,
    })
    return NextResponse.json({ orders }, { headers: { "Cache-Control": "private, no-store" } })
  } catch {
    return NextResponse.json({ error: "No pudimos verificar tus compras." }, { status: 503 })
  }
}
