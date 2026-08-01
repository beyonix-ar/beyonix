export interface MercadoLibreIdentityRow {
  sale_date?: string | null
  operation_id?: string | null
  order_id?: string | null
  product_name?: string | null
  sku?: string | null
  quantity?: number | null
  gross_amount?: number | null
  fee_amount?: number | null
  shipping_amount?: number | null
  net_amount?: number | null
  source_file_name?: string | null
  raw_data?: Record<string, unknown>
}

function normalized(value: unknown) {
  return String(value ?? "").trim().toLocaleLowerCase("es")
}

function objectValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function normalizedDate(value: unknown) {
  const parsed = new Date(String(value ?? ""))
  return Number.isNaN(parsed.getTime()) ? normalized(value) : String(parsed.getTime())
}

export function getMercadoLibreIdentityParts(row: MercadoLibreIdentityRow) {
  const parsed = objectValue(objectValue(row.raw_data).parsed)
  const operationId = normalized(row.operation_id)
  const listingId = normalized(parsed.listing_id)
  const variantName = normalized(parsed.variant)
  const sku = normalized(row.sku)
  const productName = normalized(row.product_name)
  const discriminatorType = listingId
    ? "listing"
    : sku
      ? "sku"
      : "product"
  const discriminator = listingId || sku || productName

  return operationId
    ? [
        "operation",
        operationId,
        discriminatorType,
        discriminator,
        "variant",
        variantName,
      ]
    : [
        "order",
        normalized(row.order_id),
        "sale_date",
        normalizedDate(row.sale_date),
        discriminatorType,
        discriminator,
        "variant",
        variantName,
      ]
}

export function getMercadoLibreSaleIdentity(row: MercadoLibreIdentityRow) {
  return JSON.stringify(getMercadoLibreIdentityParts(row))
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (!value || typeof value !== "object") return value

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "source_file_name")
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nestedValue]) => {
        if (key === "raw_data") {
          const raw = objectValue(nestedValue)
          return [
            key,
            canonicalValue(
              Object.fromEntries(
                Object.entries(raw).filter(([rawKey]) => rawKey !== "source"),
              ),
            ),
          ]
        }
        return [key, canonicalValue(nestedValue)]
      }),
  )
}

function fingerprint(row: MercadoLibreIdentityRow) {
  return JSON.stringify(canonicalValue(row))
}

export function validateMercadoLibreImportBatch<
  T extends MercadoLibreIdentityRow,
>(rows: T[]) {
  const uniqueRows: T[] = []
  const fingerprints = new Map<string, string>()
  let duplicateRows = 0

  rows.forEach((row, index) => {
    if (!normalized(row.operation_id) && !normalized(row.order_id)) {
      throw new Error(
        `La fila ${index + 1} no tiene número de venta ni orden de compra.`,
      )
    }

    const identity = getMercadoLibreSaleIdentity(row)
    const nextFingerprint = fingerprint(row)
    const previousFingerprint = fingerprints.get(identity)

    if (previousFingerprint === undefined) {
      fingerprints.set(identity, nextFingerprint)
      uniqueRows.push(row)
      return
    }

    if (previousFingerprint !== nextFingerprint) {
      throw new Error(
        `El archivo contiene datos contradictorios para una misma venta (${row.operation_id ?? row.order_id}).`,
      )
    }

    duplicateRows += 1
  })

  return {
    rows: uniqueRows,
    duplicateRows,
  }
}
