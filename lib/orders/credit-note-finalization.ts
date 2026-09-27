import "server-only"

import type { createAdminClient } from "@/lib/supabase/admin"
import { creditCustomerForOrderCreditNote } from "@/lib/customer-credit/server"
import { roundCreditMoney } from "@/lib/orders/credit-note-calculations"
import { appendOrderAuditEvent } from "@/lib/orders/order-audit"
import { isPhysicallyReceivedStatus } from "@/lib/orders/return-reception"

type AdminClient = ReturnType<typeof createAdminClient>

/**
 * Pasos posteriores a la autorización ARCA de una Nota de Crédito C:
 * reingreso de stock, acreditación de saldo, resumen del pedido y auditoría.
 *
 * Reanudable: lee TODO de la base (la NC guarda recepción, destino de stock y
 * descuento), así que corre igual en la emisión original y en una
 * conciliación posterior a un reinicio. Idempotente:
 *   * stock: record_order_item_return_reception con clave
 *     credit-note-item:<id> (y RETURN_EXCEEDS_REMAINING = ya reingresado);
 *   * saldo: creditCustomerForOrderCreditNote, única por comprobante;
 *   * resumen: se recalcula desde las NC autorizadas;
 *   * auditoría/avisos: sólo la primera vez (finish_credit_note_finalization).
 * Nunca mueve dinero externo: el reintegro por medio de pago sigue su flujo
 * propio (comprobante de reintegro), una sola vez.
 */

type CreditNoteItemRow = {
  id: number
  order_item_id: number
  quantity: number
  approved_quantity?: number | null
  total_amount?: number | string | null
  product_name?: string | null
  variant_name?: string | null
  unit_amount?: number | string | null
}

type CreditNoteRow = {
  id: string
  order_id: number
  claim_id: number | null
  status: string
  destination: "external_refund" | "customer_balance" | "none"
  reason: string
  items_amount: number | string
  manual_amount: number | string
  total_amount: number | string
  invoice_point: number
  invoice_number: number
  voucher_point: number
  voucher_number: number
  cae: string
  cae_due: string
  authorized_at: string
  reception_status: string
  reception_date: string | null
  reception_notes: string | null
  physical_condition: string | null
  stock_destination: string
  conditioned_discount_percent: number | string | null
  finalized_at: string | null
  order_credit_note_items?: CreditNoteItemRow[]
}

function optionalText(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) || null : null
}

export class CreditNoteFinalizationError extends Error {}

export async function finalizeCreditNote(
  admin: AdminClient,
  { noteId, actorId }: { noteId: string; actorId: string | null },
) {
  const { data: noteData, error: noteError } = await admin
    .from("order_credit_notes")
    .select("*, order_credit_note_items(*)")
    .eq("id", noteId)
    .single()
  if (noteError || !noteData) {
    throw new CreditNoteFinalizationError("No se pudo recuperar la nota de crédito autorizada.")
  }
  const note = noteData as unknown as CreditNoteRow
  if (note.status !== "authorized") {
    throw new CreditNoteFinalizationError("La nota de crédito todavía no está autorizada por ARCA.")
  }
  const orderId = Number(note.order_id)
  const totalAmount = roundCreditMoney(Number(note.total_amount))
  const authorizedAt = note.authorized_at
  const issueDateIso = String(authorizedAt).slice(0, 10)

  const [{ data: order, error: orderError }, { data: orderItems, error: itemsError }] = await Promise.all([
    admin
      .from("ordenes")
      .select("id, usuario_id, estado, financial_status, credit_note_status, invoice_point, invoice_number")
      .eq("id", orderId)
      .single(),
    admin
      .from("orden_items")
      .select("id, producto_id, variante_id, conditioned_stock_id, conditioned_name, cantidad")
      .eq("orden_id", orderId),
  ])
  if (orderError || !order || itemsError) {
    throw new CreditNoteFinalizationError("No se pudo recuperar el pedido de la nota de crédito.")
  }

  const creditItems = note.order_credit_note_items ?? []
  const stockDestination = note.stock_destination
  if (isPhysicallyReceivedStatus(note.reception_status as never) && stockDestination !== "no_reingresar") {
    const items = orderItems ?? []
    const orderItemsById = new Map(items.map((item) => [Number(item.id), item]))
    const productIds = [...new Set(items.map((item) => Number(item.producto_id)))]
    const variantIds = [...new Set(items.map((item) => item.variante_id).filter((value): value is number => typeof value === "number"))]
    const conditionedIds = items
      .map((item) => item.conditioned_stock_id)
      .filter((value): value is string => typeof value === "string")
    const [productsResult, variantsResult, conditionedSources] = await Promise.all([
      productIds.length
        ? admin.from("productos").select("id, nombre, sku").in("id", productIds)
        : Promise.resolve({ data: [], error: null }),
      variantIds.length
        ? admin.from("producto_variantes").select("id, nombre, sku, color_hex, imagenes").in("id", variantIds)
        : Promise.resolve({ data: [], error: null }),
      conditionedIds.length
        ? admin.from("inventory_return_movements").select("id, variant_id").in("id", conditionedIds)
        : Promise.resolve({ data: [], error: null }),
    ])
    if (productsResult.error || variantsResult.error || conditionedSources.error) {
      throw new CreditNoteFinalizationError("No se pudo preparar el reingreso de stock.")
    }
    const productsById = new Map((productsResult.data ?? []).map((product) => [Number(product.id), product]))
    const variantsById = new Map((variantsResult.data ?? []).map((variant) => [Number(variant.id), variant]))
    const sourceVariantByMovement = new Map(
      (conditionedSources.data ?? []).map((movement) => [
        String(movement.id),
        typeof movement.variant_id === "number" ? movement.variant_id : null,
      ]),
    )
    const occurredAt = note.reception_date && /^\d{4}-\d{2}-\d{2}$/.test(String(note.reception_date))
      ? `${note.reception_date}T12:00:00-03:00`
      : authorizedAt
    const discountPercent = note.conditioned_discount_percent == null ? null : Number(note.conditioned_discount_percent)

    for (const creditItem of creditItems) {
      const orderItem = orderItemsById.get(Number(creditItem.order_item_id))
      const quantity = Number(creditItem.approved_quantity ?? creditItem.quantity ?? 0)
      if (!orderItem || quantity <= 0) continue

      const product = productsById.get(Number(orderItem.producto_id))
      const variant = typeof orderItem.variante_id === "number" ? variantsById.get(orderItem.variante_id) : null
      const returnVariantId = typeof orderItem.variante_id === "number"
        ? orderItem.variante_id
        : orderItem.conditioned_stock_id
          ? sourceVariantByMovement.get(orderItem.conditioned_stock_id) ?? null
          : null
      const sellableQuantity = stockDestination === "stock_vendible" ? quantity : 0
      const discountedQuantity = stockDestination === "stock_observaciones" ? quantity : 0
      const nonSellableQuantity = ["fallado", "garantia_proveedor"].includes(stockDestination) ? quantity : 0
      const discountReason = discountedQuantity > 0
        ? optionalText(note.physical_condition, 300) ||
          optionalText(note.reception_notes, 300) ||
          "Detalle físico verificado en devolución"
        : null
      const nonSellableReason = nonSellableQuantity > 0
        ? optionalText(note.reception_notes, 300) ||
          optionalText(note.physical_condition, 300) ||
          (stockDestination === "garantia_proveedor" ? "Derivado a garantía del proveedor" : "Producto fallado")
        : null
      const baseName = [product?.nombre, variant?.nombre].filter(Boolean).join(" · ")
      const baseSku = variant?.sku || product?.sku || `DEV-${orderItem.id}`

      const { error: stockMovementError } = await admin.rpc("record_order_item_return_reception", {
        p_order_id: orderId,
        p_order_item_id: Number(orderItem.id),
        p_sellable_quantity: sellableQuantity,
        p_discounted_quantity: discountedQuantity,
        p_non_sellable_quantity: nonSellableQuantity,
        p_idempotency_key: `credit-note-item:${creditItem.id}`,
        p_processed_by: actorId,
        p_note: optionalText(note.reception_notes, 1000),
        p_discount_percent: discountedQuantity > 0 ? discountPercent : null,
        p_discount_reason: discountReason,
        p_non_sellable_reason: nonSellableReason,
        p_conditioned_name: discountedQuantity > 0 ? `${baseName || "Producto devuelto"} · Con descuento` : null,
        p_conditioned_sku: discountedQuantity > 0 ? `${baseSku}-DEV-${creditItem.id}`.slice(0, 120) : null,
        p_conditioned_color_hex: discountedQuantity > 0 ? variant?.color_hex || "#808080" : null,
        p_conditioned_images: discountedQuantity > 0 && Array.isArray(variant?.imagenes) ? variant.imagenes : [],
        p_occurred_at: occurredAt,
        p_variant_id_override: typeof orderItem.variante_id === "number" ? null : returnVariantId,
      })
      // Ya reingresado por otra vía (o por un intento anterior): informativo.
      if (stockMovementError && !/RETURN_EXCEEDS_REMAINING/.test(stockMovementError.message ?? "")) {
        throw new CreditNoteFinalizationError("La nota fue autorizada, pero no se pudo registrar el reingreso de stock.")
      }
    }

    await admin
      .from("order_credit_note_items")
      .update({ stock_processed_at: authorizedAt })
      .eq("credit_note_id", noteId)
      .gt("approved_quantity", 0)
      .is("stock_processed_at", null)
    await admin
      .from("order_credit_notes")
      .update({ stock_reviewed_by: actorId, stock_reviewed_at: authorizedAt })
      .eq("id", noteId)
      .is("stock_reviewed_at", null)
  }

  const { data: authorizedNotes } = await admin
    .from("order_credit_notes")
    .select("*, order_credit_note_items(*)")
    .eq("order_id", orderId)
    .eq("status", "authorized")
  const cumulativeAmount = roundCreditMoney(
    (authorizedNotes ?? []).reduce((sum, current) => sum + Number(current.total_amount ?? 0), 0),
  )
  const cumulativeBalanceAmount = roundCreditMoney(
    (authorizedNotes ?? [])
      .filter((current) => current.destination === "customer_balance")
      .reduce((sum, current) => sum + Number(current.total_amount ?? 0), 0),
  )
  const settlesCancellationToBalance =
    note.destination === "customer_balance" &&
    (order.estado === "cancelado" ||
      ["cancellation_requested", "refund_pending", "refunded"].includes(order.financial_status ?? ""))

  // Única por comprobante (punto + número): un reintento nunca acredita dos veces.
  const customerCreditMovement = note.destination === "customer_balance"
    ? await creditCustomerForOrderCreditNote(admin, {
        userId: order.usuario_id,
        orderId,
        amount: totalAmount,
        creditNoteNumber: note.voucher_number,
        creditNotePoint: note.voucher_point,
        creditNoteCae: note.cae,
        claimId: note.claim_id,
        createdBy: actorId,
        metadata: {
          order_credit_note_id: noteId,
          associated_invoice_point: note.invoice_point,
          associated_invoice_number: note.invoice_number,
        },
      })
    : null

  if (note.destination === "customer_balance") {
    await admin
      .from("order_credit_notes")
      .update({
        management_status: "finalizada",
        settlement_status: "completado",
        settlement_date: issueDateIso,
        updated_at: new Date().toISOString(),
      })
      .eq("id", noteId)
  }

  const { data: updatedOrder, error: orderUpdateError } = await admin
    .from("ordenes")
    .update({
      credit_note_status: "authorized",
      credit_note_number: String(note.voucher_number),
      credit_note_point: note.voucher_point,
      credit_note_cae: note.cae,
      credit_note_cae_due: note.cae_due,
      credit_note_created_at: authorizedAt,
      credit_note_amount: cumulativeAmount,
      credit_note_error: null,
      credit_note_required: false,
      credit_note_issued: true,
      credit_note_issued_at: authorizedAt,
      ...(settlesCancellationToBalance
        ? {
            financial_status: "refunded",
            refund_amount: cumulativeBalanceAmount,
            refund_method: "Saldo en cuenta BEYONIX",
            refunded_at: authorizedAt,
            refunded_by: actorId,
          }
        : {}),
    })
    .eq("id", orderId)
    .select()
    .single()
  if (orderUpdateError || !updatedOrder) {
    throw new CreditNoteFinalizationError("La nota fue autorizada, pero no se pudo actualizar el resumen del pedido.")
  }

  const { data: firstFinalization, error: finishError } = await admin.rpc("finish_credit_note_finalization", {
    p_note_id: noteId,
  })
  if (finishError) {
    throw new CreditNoteFinalizationError("La nota fue autorizada, pero no se pudo cerrar su gestión.")
  }

  const movementId = customerCreditMovement && "movement_id" in customerCreditMovement
    ? customerCreditMovement.movement_id
    : null
  if (firstFinalization === true) {
    await appendOrderAuditEvent(admin, {
      orderId,
      actorType: actorId ? "admin" : "system",
      actorId,
      action: "credit_note_authorized",
      previousStatus: order.credit_note_status ?? null,
      newStatus: "authorized",
      metadata: {
        orderCreditNoteId: noteId,
        amount: totalAmount,
        itemsAmount: Number(note.items_amount),
        manualAmount: Number(note.manual_amount),
        destination: note.destination,
        reason: note.reason,
        items: creditItems.map((item) => ({
          order_item_id: item.order_item_id,
          quantity: item.quantity,
          total_amount: Number(item.total_amount ?? 0),
        })),
        creditNoteNumber: note.voucher_number,
        creditNotePoint: note.voucher_point,
        associatedInvoicePoint: note.invoice_point,
        associatedInvoiceNumber: note.invoice_number,
        customerCreditMovementId: movementId,
      },
    })
    if (settlesCancellationToBalance) {
      await appendOrderAuditEvent(admin, {
        orderId,
        actorType: "system",
        actorId: null,
        action: "order_refunded_to_customer_balance",
        previousStatus: order.financial_status ?? "refund_pending",
        newStatus: "refunded",
        metadata: {
          orderCreditNoteId: noteId,
          amount: totalAmount,
          cumulativeAmount: cumulativeBalanceAmount,
          customerCreditMovementId: movementId,
        },
      })
    }
  }

  const { data: finalNote } = await admin
    .from("order_credit_notes")
    .select("*, order_credit_note_items(*)")
    .eq("id", noteId)
    .single()

  return {
    order: updatedOrder,
    note: finalNote ?? noteData,
    authorizedNotes: authorizedNotes ?? [],
    customerCreditMovement,
    firstFinalization: firstFinalization === true,
  }
}
