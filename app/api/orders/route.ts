import { NextResponse } from "next/server"

import { createAdminClient } from "@/lib/supabase/admin"
import { createClient } from "@/lib/supabase/server"
import { expireOverdueTransferOrders } from "@/lib/orders/transfer-expiration"
import { toCustomerSafeOrderAuditEvents } from "@/lib/orders/customer-order-audit-view"
import { attachCustomerClaimReads } from "@/lib/orders/customer-claim-access"
import type { CustomerOrderSummary } from "@/lib/supabase/types"

const ORDER_LIST_SELECT =
  "id, created_at, total, estado, payment_status, payment_method_id, financial_status, delivered_at, payment_proof_url, payment_proof_uploaded_at, shipping_type, tracking_number, tracking_url, andreani_tracking, andreani_estado, cancellation_requested_by, orden_items(id, orden_id, producto_id, cantidad, conditioned_images, productos(nombre, imagen_principal, imagenes_producto(url)), producto_variantes(imagenes)), order_claims(id, status, failure_type, created_at, order_claim_messages(id, author_role, created_at)), order_audit_events(action, actor_type, previous_status, new_status, metadata, created_at)"

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

  // Badge de "Ver reclamo": última lectura del propio cliente por reclamo
  // (order_claim_customer_reads), en una sola consulta para toda la lista.
  const allClaims = [...merged.values()].flatMap((order) => order.order_claims ?? [])
  const claimsWithReads = await attachCustomerClaimReads(admin, user.id, allClaims)
  const readByClaimId = new Map(claimsWithReads.map((claim) => [claim.id, claim.customer_last_read_at]))

  const orders = [...merged.values()]
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .map((order) => ({
      ...order,
      order_claims: (order.order_claims ?? []).map((claim) => ({
        ...claim,
        customer_last_read_at: readByClaimId.get(claim.id) ?? null,
      })),
      // Auditoría Andreani Parte 4/4: order_audit_events.metadata trae datos
      // administrativos internos (andreaniSnapshot, notes de conciliación,
      // reasonCode, source, etc.) que este endpoint de cliente nunca debe
      // reenviar tal cual -- ver lib/orders/customer-order-audit-view.ts.
      order_audit_events: toCustomerSafeOrderAuditEvents(order.order_audit_events),
    }))

  return NextResponse.json({ orders })
}
