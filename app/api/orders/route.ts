import { NextResponse } from "next/server"

import { createAdminClient } from "@/lib/supabase/admin"
import { createClient } from "@/lib/supabase/server"
import { expireOverdueTransferOrders } from "@/lib/orders/transfer-expiration"
import type { CustomerOrderSummary } from "@/lib/supabase/types"

const ORDER_LIST_SELECT =
  "id, created_at, total, estado, payment_status, payment_method_id, financial_status, delivered_at, payment_proof_url, payment_proof_uploaded_at, shipping_type, tracking_number, tracking_url, andreani_tracking, andreani_estado, orden_items(id, orden_id, producto_id, cantidad, conditioned_images, productos(nombre, imagen_principal, imagenes_producto(url)), producto_variantes(imagenes)), order_claims(failure_type, created_at)"

function escapeIlikeValue(value: string) {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`)
}

export async function GET() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: "Debés iniciar sesión." }, { status: 401 })
  }

  const admin = createAdminClient()

  await expireOverdueTransferOrders(admin, { userId: user.id })

  const normalizedEmail = user.email?.trim().toLowerCase()

  const [byUserId, byEmail] = await Promise.all([
    admin
      .from("ordenes")
      .select(ORDER_LIST_SELECT)
      .eq("usuario_id", user.id)
      .order("created_at", { ascending: false }),
    normalizedEmail
      ? admin
          .from("ordenes")
          .select(ORDER_LIST_SELECT)
          .is("usuario_id", null)
          .ilike("cliente_email", escapeIlikeValue(normalizedEmail))
          .order("created_at", { ascending: false })
      : Promise.resolve({ data: [] as CustomerOrderSummary[], error: null }),
  ])

  if (byUserId.error || byEmail.error) {
    return NextResponse.json(
      { error: "No se pudieron cargar tus compras." },
      { status: 500 },
    )
  }

  const merged = new Map<number, CustomerOrderSummary>()
  for (const order of [
    ...((byUserId.data ?? []) as unknown as CustomerOrderSummary[]),
    ...((byEmail.data ?? []) as unknown as CustomerOrderSummary[]),
  ]) {
    merged.set(order.id, order)
  }

  const orders = [...merged.values()].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  )

  return NextResponse.json({ orders })
}
