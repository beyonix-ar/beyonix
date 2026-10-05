import type { createAdminClient } from "@/lib/supabase/admin"

export type DispatchAdmin = ReturnType<typeof createAdminClient>
export type DispatchPackage = { id: number; order_id: number; status: "preparing" | "prepared"; attempt_number: number; prepared_at: string | null; prepared_by: string | null }
export type DispatchLine = { order_item_id: number; expected_sku: string | null; expected_barcode: string | null; expected_quantity: number; scanned_quantity: number; product_id: number; variant_id: number | null; conditioned_stock_id: string | null; name?: string }
export type DispatchBatch = { id: number; code: string; status: "open" | "closed" | "handed_over"; created_at: string; closed_at: string | null; handed_over_at: string | null; handed_over_by: string | null }
export type DispatchMembership = { id: number; batch_id: number; order_id: number; package_id: number; added_at: string; removed_at: string | null }
export type DispatchOrder = { id: number; estado: string; financial_status: string | null; payment_status: string | null; invoice_status: string | null; shipping_provider: string | null; envio_proveedor: string | null; cancelled_at: string | null; andreani_handed_over_at: string | null; andreani_handed_over_batch_id: number | null }

export const orderCode = (id: number) => `BX-${1000 + id}`

export function parseOrderCode(value: string): number | null {
  const match = /^#?BX-(\d+)$/i.exec(value.trim())
  if (!match) return null
  const id = Number(match[1]) - 1000
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

export function validId(value: string): number | null {
  const id = Number(value)
  return /^\d+$/.test(value) && Number.isSafeInteger(id) && id > 0 ? id : null
}

export function dispatchError(error: { message: string } | null, fallback = "No se pudo completar la operación.") {
  if (!error) return fallback
  const messages: Record<string, string> = {
    DISPATCH_ORDER_BLOCKED: "Este pedido requiere revisión antes del despacho.",
    DISPATCH_WRONG_ITEM: "Este producto no pertenece al pedido.",
    DISPATCH_WRONG_SKU_OR_VARIANT: "Este producto o variante no pertenece al pedido.",
    DISPATCH_QUANTITY_EXCEEDED: "Ya completaste la cantidad requerida.",
    DISPATCH_ALREADY_PREPARED: "El pedido ya está preparado.",
    DISPATCH_PREPARATION_NOT_STARTED: "Iniciá la preparación primero.",
    DISPATCH_PACKAGE_NOT_PREPARED: "Este pedido todavía no está preparado.",
    DISPATCH_BATCH_CLOSED: "La tanda ya está cerrada.",
    DISPATCH_BATCH_EMPTY: "Agregá al menos un pedido antes de cerrar la tanda.",
    DISPATCH_BATCH_NOT_CLOSED: "Cerrá la tanda antes de confirmar la entrega.",
    DISPATCH_ALREADY_HANDED_OVER: "La tanda ya fue entregada.",
    DISPATCH_RESET_REQUIRES_REMOVAL: "Retirá el pedido de la tanda para reiniciar su preparación.",
    DISPATCH_REASON_REQUIRED: "Ingresá un motivo de al menos 10 caracteres.",
    DISPATCH_RESET_REASON_REQUIRED: "Ingresá un motivo de al menos 10 caracteres.",
    DISPATCH_ITEM_IDENTITY_MISSING: "Un artículo no tiene SKU ni código de barras. Revisá el catálogo.",
    DISPATCH_ORDER_EMPTY: "Este pedido no tiene artículos para preparar.",
    DISPATCH_ORDER_NOT_FOUND: "No se encontró el pedido.",
    DISPATCH_BATCH_NOT_FOUND: "No se encontró la tanda.",
  }
  const code = Object.keys(messages).find((key) => error.message.includes(key))
  if (code) return messages[code]
  if (error.message.includes("dispatch_batch_items_active_order_unique")) return "Este pedido ya pertenece a otra tanda."
  if (error.message.includes("DISPATCH_")) return fallback
  return fallback
}

export function resolveScanLine(lines: DispatchLine[], code: string): DispatchLine | null {
  const input = code.trim()
  const matches = lines.filter((line) => line.expected_barcode === input || line.expected_sku === input.toUpperCase())
  return matches.find((line) => line.scanned_quantity < line.expected_quantity) ?? matches[0] ?? null
}

export async function getOrderDispatch(admin: DispatchAdmin, orderId: number) {
  const [orderResult, packageResult, itemsResult, membershipResult, blocksResult] = await Promise.all([
    admin.from("ordenes").select("id,estado,financial_status,payment_status,invoice_status,shipping_provider,envio_proveedor,cancelled_at,andreani_handed_over_at,andreani_handed_over_batch_id").eq("id", orderId).maybeSingle(),
    admin.from("order_packages").select("id,order_id,status,attempt_number,prepared_at,prepared_by").eq("order_id", orderId).maybeSingle(),
    admin.from("orden_items").select("id,producto_id,variante_id,conditioned_name,cantidad,productos(nombre),producto_variantes(nombre)").eq("orden_id", orderId).order("id"),
    admin.from("dispatch_batch_items").select("id,batch_id,order_id,package_id,added_at,removed_at").eq("order_id", orderId).is("removed_at", null).maybeSingle(),
    admin.from("dispatch_blocks").select("id,reason").eq("order_id", orderId).is("resolved_at", null),
  ])
  const failure = [orderResult, packageResult, itemsResult, membershipResult, blocksResult].find((result) => result.error)
  if (failure?.error) throw failure.error
  if (!orderResult.data) return null
  const pkg = packageResult.data as DispatchPackage | null
  const linesResult = pkg ? await admin.from("order_preparation_lines").select("order_item_id,expected_sku,expected_barcode,expected_quantity,scanned_quantity,product_id,variant_id,conditioned_stock_id").eq("package_id", pkg.id).order("order_item_id") : null
  if (linesResult?.error) throw linesResult.error
  const names = new Map<number, string>()
  for (const item of itemsResult.data ?? []) {
    const product = item.productos as unknown as { nombre?: string } | null
    const variant = item.producto_variantes as unknown as { nombre?: string } | null
    names.set(item.id, [item.conditioned_name || product?.nombre || "Producto", variant?.nombre].filter(Boolean).join(" · "))
  }
  const lines = ((linesResult?.data ?? []) as DispatchLine[]).map((line) => ({ ...line, name: names.get(line.order_item_id) ?? "Producto" }))
  const membership = membershipResult.data as DispatchMembership | null
  let batch: DispatchBatch | null = null
  if (membership) {
    const result = await admin.from("dispatch_batches").select("id,code,status,created_at,closed_at,handed_over_at,handed_over_by").eq("id", membership.batch_id).maybeSingle()
    if (result.error) throw result.error
    batch = result.data as DispatchBatch | null
  }
  return { order: orderResult.data as DispatchOrder, package: pkg, lines, itemCount: itemsResult.data?.length ?? 0, expectedUnits: (itemsResult.data ?? []).reduce((sum, item) => sum + Number(item.cantidad), 0), membership, batch, blocked: (blocksResult.data?.length ?? 0) > 0 }
}

export async function getBatchDispatch(admin: DispatchAdmin, batchId: number) {
  const [batchResult, itemsResult] = await Promise.all([
    admin.from("dispatch_batches").select("id,code,status,created_at,closed_at,handed_over_at,handed_over_by").eq("id", batchId).maybeSingle(),
    admin.from("dispatch_batch_items").select("id,batch_id,order_id,package_id,added_at,removed_at").eq("batch_id", batchId).is("removed_at", null).order("order_id"),
  ])
  if (batchResult.error || itemsResult.error) throw batchResult.error ?? itemsResult.error
  if (!batchResult.data) return null
  const items = (itemsResult.data ?? []) as DispatchMembership[]
  const ids = items.map((item) => item.order_id)
  const [blocksResult, ordersResult] = ids.length ? await Promise.all([
    admin.from("dispatch_blocks").select("order_id").in("order_id", ids).is("resolved_at", null),
    admin.from("ordenes").select("id,cancelled_at,andreani_handed_over_at").in("id", ids),
  ]) : [{ data: [], error: null }, { data: [], error: null }]
  if (blocksResult.error || ordersResult.error) throw blocksResult.error ?? ordersResult.error
  const blockedIds = new Set((blocksResult.data ?? []).map((block) => block.order_id))
  for (const order of ordersResult.data ?? []) if (order.cancelled_at && !order.andreani_handed_over_at) blockedIds.add(order.id)
  const batch = batchResult.data as DispatchBatch
  const operatorResult = batch.handed_over_by ? await admin.from("profiles").select("nombre,username,email").eq("id", batch.handed_over_by).maybeSingle() : null
  if (operatorResult?.error) throw operatorResult.error
  const operator = operatorResult?.data
  return { batch, items: items.map((item) => ({ ...item, blocked: blockedIds.has(item.order_id) })), blockedCount: blockedIds.size, operatorName: operator?.nombre || operator?.username || operator?.email || null }
}
