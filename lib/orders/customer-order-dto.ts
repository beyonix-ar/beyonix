// DTO de pedido para el cliente final. Única fuente de verdad de qué campos
// de ordenes/orden_items pueden salir hacia el navegador del cliente.
//
// El cliente ve el precio FINAL del envío (shipping_cost_charged) y nada del
// desglose interno: tarifa Andreani, recargo, redondeo, beneficio absorbido,
// estimación/medidas de bultos, recotización, facturación ni conciliación.
// Las rutas customer seleccionan columnas explícitas Y además pasan la fila
// por este allowlist: aunque alguien agregue una columna al select, no sale.

export const CUSTOMER_ORDER_FIELDS = [
  "id", "usuario_id", "created_at", "cliente_nombre", "cliente_email", "cliente_telefono", "cliente_dni",
  "cliente_direccion", "cp_destino", "localidad", "provincia",
  "shipping_provider", "shipping_type", "shipping_cost_charged", "free_shipping_applied",
  "estado", "total", "original_total", "credit_balance_used", "external_amount_due",
  "payment_status", "payment_method_id", "payment_type_id", "transfer_discount_percent", "transfer_discount_amount",
  "payment_proof_url", "payment_proof_file_name", "payment_proof_uploaded_at", "financial_status",
  "cancellation_requested_at", "cancellation_requested_by",
  "refund_pending_at", "refund_proof_url", "refund_amount", "refund_method", "refund_observation", "refunded_at",
  "credit_note_status", "credit_note_number", "credit_note_point", "credit_note_cae", "credit_note_cae_due",
  "credit_note_created_at", "credit_note_amount",
  "paid_at", "tracking_number", "tracking_url", "envio_proveedor", "andreani_estado", "andreani_tracking",
  "andreani_sucursal_nombre", "andreani_sucursal_direccion", "andreani_sucursal_localidad",
  "andreani_sucursal_provincia", "andreani_sucursal_cp",
  "invoice_number", "invoice_point", "invoice_arca_environment", "invoice_cae", "invoice_cae_due",
  "invoice_status", "invoice_created_at",
  "return_status", "return_reason", "return_requested_at", "return_resolved_at",
  "delivered_at", "cancelled_at",
  // Calculados por el servidor (no son columnas).
  "transfer_reservation_expires_at",
] as const

export const CUSTOMER_ORDER_ITEM_FIELDS = [
  "id", "orden_id", "producto_id", "variante_id", "conditioned_stock_id", "conditioned_name", "conditioned_sku",
  "conditioned_color_hex", "conditioned_images", "conditioned_discount_percent", "conditioned_reason",
  "cantidad", "precio", "productos", "producto_variantes",
] as const

/**
 * Claves internas que nunca pueden aparecer en una respuesta al cliente
 * (columnas reales de ordenes / orden_items / tablas logísticas). Los tests
 * de exposición recorren cada JSON customer-facing buscando cualquiera.
 */
export const CUSTOMER_FORBIDDEN_KEYS = [
  // Precio logístico y su desglose.
  "shipping_cost_real", "shipping_provider_quote_amount", "shipping_markup_percent", "shipping_markup_amount",
  "shipping_rounding_amount", "shipping_benefit_amount", "shipping_estimate",
  // Recotización con bultos reales.
  "shipping_parcel_quote_status", "shipping_parcel_quote_amount", "shipping_parcel_quote_at",
  "shipping_parcel_quote_request_key", "shipping_parcel_quote_parcels", "shipping_parcel_quote_error",
  // Facturación / conciliación Andreani.
  "andreani_billed_amount", "andreani_billed_at", "andreani_billing_source", "andreani_billing_reference",
  "billed_amount", "billing_entries", "andreani_billing_entries", "checkout_quote_snapshot", "parcel_quote_snapshot",
  "reconciliation", "invoice_reference", "dedupe_key",
  // Bultos y medidas.
  "actual_weight_kg", "actual_length_cm", "actual_width_cm", "actual_height_cm", "actual_volume_cm3",
  "parcel_count", "parcels_request_key", "order_package_parcels", "order_packages",
  // Costos, stock y trazabilidad interna.
  "costo_unitario_historico", "reserved_variant_id", "random_fulfillment", "return_inventory_note",
  "return_inventory_processed_by", "pricing_snapshot", "andreani_envio_id", "andreani_creation_status",
  "andreani_handed_over_by", "andreani_handed_over_batch_id", "checkout_idempotency_key",
  "cost_amount", "contract", "environment", "creation_error",
] as const

type PlainRecord = Record<string, unknown>

function pick(source: object, fields: readonly string[]) {
  const values = new Map<string, unknown>(Object.entries(source))
  const result: PlainRecord = {}
  for (const field of fields) {
    if (values.has(field)) result[field] = values.get(field)
  }
  return result
}

/** Fila de pedido (con orden_items y extras ya saneados) → DTO del cliente. */
export function toCustomerOrderDto(order: object, extras: PlainRecord = {}): PlainRecord {
  const dto = pick(order, CUSTOMER_ORDER_FIELDS)
  const items = new Map<string, unknown>(Object.entries(order)).get("orden_items")
  if (Array.isArray(items)) {
    dto.orden_items = items.map((item: unknown) =>
      item && typeof item === "object" ? pick(item, CUSTOMER_ORDER_ITEM_FIELDS) : item,
    )
  }
  return { ...dto, ...extras }
}

/** Claves prohibidas presentes en cualquier nivel de un valor JSON. */
export function findForbiddenCustomerKeys(value: unknown, found = new Set<string>()): string[] {
  if (Array.isArray(value)) {
    for (const entry of value) findForbiddenCustomerKeys(entry, found)
  } else if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if ((CUSTOMER_FORBIDDEN_KEYS as readonly string[]).includes(key)) found.add(key)
      findForbiddenCustomerKeys(entry, found)
    }
  }
  return [...found]
}
