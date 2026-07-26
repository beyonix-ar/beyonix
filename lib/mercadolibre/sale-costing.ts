export interface MercadoLibreCostMapping {
  product_id: number | null
  variant_id: number | null
  standalone_key: string | null
  match_key: string
}

function number(value: unknown) {
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) ? parsed : 0
}

function normalizedText(value: unknown) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
}

function rawObject(value: unknown) {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {}
}

export function getMercadoLibreCostMapping(
  row: Record<string, unknown>,
): MercadoLibreCostMapping | null {
  const raw = rawObject(row.raw_data)
  const storedMapping = rawObject(raw.beyonix_cost_mapping)
  const standaloneKey =
    typeof storedMapping.standalone_key === "string"
      ? storedMapping.standalone_key
      : null
  const productId = number(storedMapping.product_id || row.product_id)
  const validProductId =
    Number.isInteger(productId) && productId > 0 ? productId : null

  if (!validProductId && !standaloneKey) return null

  const variantId = number(storedMapping.variant_id)
  return {
    product_id: validProductId,
    variant_id:
      validProductId && Number.isInteger(variantId) && variantId > 0
        ? variantId
        : null,
    standalone_key: standaloneKey,
    match_key:
      typeof storedMapping.match_key === "string"
        ? storedMapping.match_key
        : row.sku
          ? `sku:${String(row.sku)}`
          : `product:${String(row.product_name ?? "")}`,
  }
}

export function getMercadoLibreCostableUnits(
  row: Record<string, unknown>,
) {
  const quantity = Math.max(0, Math.trunc(number(row.quantity)))
  const parsed = rawObject(rawObject(row.raw_data).parsed)
  const status = normalizedText(parsed.status)
  const cancelled = status.includes("cancel") || status.includes("anulad")

  if (cancelled) return 0

  const returned =
    status.includes("devol") ||
    status.includes("reembolso") ||
    number(parsed.cancellations_refunds) < 0 ||
    Boolean(String(parsed.return_tracking_number ?? "").trim()) ||
    Boolean(String(parsed.return_result ?? "").trim())
  const reportedReturnedUnits = Math.max(
    0,
    Math.trunc(number(parsed.return_units)),
  )
  const returnedUnits = returned
    ? reportedReturnedUnits || quantity
    : reportedReturnedUnits

  return Math.max(0, quantity - Math.min(quantity, returnedUnits))
}

export function getMercadoLibreRefundAmount(
  row: Record<string, unknown>,
) {
  const parsed = rawObject(rawObject(row.raw_data).parsed)
  return Math.abs(Math.min(number(parsed.cancellations_refunds), 0))
}
