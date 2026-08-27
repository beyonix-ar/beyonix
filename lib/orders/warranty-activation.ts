import "server-only"

import type { createAdminClient } from "../supabase/admin.ts"
import { appendOrderAuditEvent, type OrderAuditActorType } from "./order-audit.ts"
import { DEFAULT_PRODUCT_WARRANTY_MONTHS, getWarrantyExpiration } from "./warranty.ts"

type AdminClient = ReturnType<typeof createAdminClient>

/**
 * Activa la garantía de todos los ítems de un pedido que todavía estén
 * `pending_delivery` (o sin garantía iniciada) al confirmarse la entrega.
 * Compartido entre el cambio de estado manual (admin) y la sincronización
 * automática de tracking Andreani -- ambos caminos deben activar garantía
 * exactamente igual, una sola vez, sin duplicar esta lógica.
 */
export async function activatePendingItemWarranties(
  admin: AdminClient,
  {
    orderId,
    deliveredAt,
    actorType,
    actorId,
  }: {
    orderId: number
    deliveredAt: string
    actorType: OrderAuditActorType
    actorId: string | null
  },
) {
  const { data: items, error: itemsError } = await admin
    .from("orden_items")
    .select("id, warranty_started_at, warranty_expires_at, warranty_status, warranty_months")
    .eq("orden_id", orderId)

  if (itemsError) {
    console.warn("ORDER_WARRANTY_ITEMS_ERROR", {
      orderId,
      message: itemsError.message,
    })
    return
  }

  const pendingItems = (items ?? []).filter(
    (item) =>
      !item.warranty_started_at &&
      !item.warranty_expires_at &&
      (item.warranty_status === null ||
        item.warranty_status === undefined ||
        item.warranty_status === "pending_delivery"),
  )

  if (!pendingItems.length) return

  const previousByItemId = Object.fromEntries(
    pendingItems.map((item) => [
      item.id,
      {
        warranty_started_at: item.warranty_started_at,
        warranty_expires_at: item.warranty_expires_at,
        warranty_months: item.warranty_months,
        warranty_status: item.warranty_status,
      },
    ]),
  )

  const updates = pendingItems.map((item) => {
    const months =
      typeof item.warranty_months === "number" && item.warranty_months > 0
        ? item.warranty_months
        : DEFAULT_PRODUCT_WARRANTY_MONTHS

    return {
      id: item.id,
      warranty_started_at: deliveredAt,
      warranty_expires_at: getWarrantyExpiration(deliveredAt, months),
      warranty_months: months,
      warranty_status: "active",
    }
  })

  for (const update of updates) {
    const { error } = await admin
      .from("orden_items")
      .update({
        warranty_started_at: update.warranty_started_at,
        warranty_expires_at: update.warranty_expires_at,
        warranty_months: update.warranty_months,
        warranty_status: update.warranty_status,
      })
      .eq("id", update.id)
      .is("warranty_started_at", null)
      .is("warranty_expires_at", null)

    if (error) {
      console.warn("ORDER_WARRANTY_ACTIVATION_ERROR", {
        orderId,
        itemId: update.id,
        message: error.message,
      })
    }
  }

  await appendOrderAuditEvent(admin, {
    orderId,
    actorType,
    actorId,
    action: "order_item_warranty_started",
    previousStatus: "pending_delivery",
    newStatus: "active",
    metadata: {
      delivered_at: deliveredAt,
      previous: previousByItemId,
      next: updates,
    },
  })
}
