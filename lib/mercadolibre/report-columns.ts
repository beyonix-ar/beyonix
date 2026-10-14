import { foldText } from "./report-values.ts"

/**
 * Columnas del reporte "Ventas AR" de Mercado Libre, en el orden histórico
 * que el importador leía por posición. El orden se conserva para que un
 * archivo con ese diseño se interprete exactamente igual que antes.
 */
export const MERCADOLIBRE_FIELD_KEYS = [
  "sale_number",
  "sale_date_text",
  "status",
  "status_description",
  "multi_product_package",
  "belongs_to_kit",
  "units",
  "product_revenue",
  "sale_fee",
  "fixed_cost",
  "installment_cost",
  "shipping_income",
  "shipping_cost",
  "declared_shipping_cost",
  "size_weight_difference_charge",
  "taxes",
  "discounts_bonuses",
  "cancellations_refunds",
  "total",
  "billing_month",
  "purchase_order",
  "advertising_sale",
  "sku",
  "listing_id",
  "listing_title",
  "variant",
  "listing_unit_price",
  "added_installments",
  "attached_invoice",
  "billing_person_or_company",
  "billing_document",
  "billing_address",
  "tax_condition",
  "gross_income_number",
  "buyer",
  "business",
  "buyer_dni",
  "buyer_address",
  "buyer_city",
  "buyer_state",
  "buyer_postal_code",
  "buyer_country",
  "shipping_method",
  "shipping_on_way_date",
  "shipping_delivered_date",
  "shipping_carrier",
  "shipping_tracking_number",
  "shipping_tracking_url",
  "return_units",
  "return_method",
  "return_on_way_date",
  "return_delivered_date",
  "return_carrier",
  "return_tracking_number",
  "return_tracking_url",
  "return_reviewed_by_ml",
  "return_review_date",
  "return_money_in_favor",
  "return_result",
  "return_destination",
  "return_result_reason",
  "claim_units",
  "claim_open",
  "claim_closed",
  "claim_mediation",
] as const

export type MercadoLibreFieldKey = (typeof MERCADOLIBRE_FIELD_KEYS)[number]

type ColumnGroup = "sale" | "billing" | "buyer" | "shipping" | "return" | "claim"

interface ColumnSpec {
  /** Nombre que se muestra al usuario cuando la columna falta. */
  label: string
  /** Encabezados aceptados, ya normalizados (minúsculas, sin tildes ni "(ARS)"). */
  aliases: string[]
  /** Prefijos aceptados para encabezados largos que ML suele extender. */
  prefixes?: string[]
  group?: ColumnGroup
  /** Para encabezados repetidos sin fila de grupos: 0 = primera aparición. */
  occurrence?: number
  required?: boolean
}

export const MERCADOLIBRE_COLUMNS: Record<MercadoLibreFieldKey, ColumnSpec> = {
  sale_number: { label: "# de venta", aliases: ["# de venta", "numero de venta", "n de venta", "nro de venta"], required: true },
  sale_date_text: { label: "Fecha de venta", aliases: ["fecha de venta"], required: true },
  status: { label: "Estado", aliases: ["estado"], group: "sale", occurrence: 0, required: true },
  status_description: { label: "Descripción del estado", aliases: ["descripcion del estado"] },
  multi_product_package: { label: "Paquete de varios productos", aliases: ["paquete de varios productos"] },
  belongs_to_kit: { label: "Pertenece a un kit", aliases: ["pertenece a un kit"] },
  units: { label: "Unidades", aliases: ["unidades"], group: "sale", occurrence: 0, required: true },
  product_revenue: { label: "Ingresos por productos", aliases: ["ingresos por productos"], required: true },
  sale_fee: { label: "Cargo por venta e impuestos", aliases: ["cargo por venta e impuestos", "cargo por venta", "cargos por venta"], required: true },
  fixed_cost: { label: "Costo fijo", aliases: ["costo fijo"] },
  installment_cost: { label: "Costo por ofrecer cuotas", aliases: ["costo por ofrecer cuotas", "costo de ofrecer cuotas", "costo por cuotas"] },
  shipping_income: { label: "Ingresos por envío", aliases: ["ingresos por envio"] },
  shipping_cost: { label: "Costos de envío", aliases: ["costos de envio", "costo de envio"], required: true },
  declared_shipping_cost: { label: "Costo de envío basado en medidas y peso declarados", aliases: [], prefixes: ["costo de envio basado en"] },
  size_weight_difference_charge: { label: "Cargo por diferencias en medidas y peso", aliases: [], prefixes: ["cargo por diferencias en medidas", "cargo por diferencia en medidas"] },
  taxes: { label: "Impuestos", aliases: ["impuestos"] },
  discounts_bonuses: { label: "Descuentos y bonificaciones", aliases: ["descuentos y bonificaciones", "descuentos", "bonificaciones"] },
  cancellations_refunds: { label: "Anulaciones y reembolsos", aliases: ["anulaciones y reembolsos"], required: true },
  total: { label: "Total", aliases: ["total"], required: true },
  billing_month: { label: "Mes de facturación de tus cargos", aliases: [], prefixes: ["mes de facturacion"] },
  purchase_order: { label: "Orden de compra", aliases: ["orden de compra", "# de orden", "numero de orden"] },
  advertising_sale: { label: "Venta por publicidad", aliases: ["venta por publicidad"] },
  sku: { label: "SKU", aliases: ["sku"] },
  listing_id: { label: "# de publicación", aliases: ["# de publicacion", "numero de publicacion"] },
  listing_title: { label: "Título de la publicación", aliases: ["titulo de la publicacion", "titulo"] },
  variant: { label: "Variante", aliases: ["variante"] },
  listing_unit_price: { label: "Precio unitario de venta de la publicación", aliases: [], prefixes: ["precio unitario de venta"] },
  added_installments: { label: "Cuotas agregadas", aliases: ["cuotas agregadas"] },
  attached_invoice: { label: "Factura adjunta", aliases: ["factura adjunta"] },
  billing_person_or_company: { label: "Datos personales o de empresa", aliases: ["datos personales o de empresa"] },
  billing_document: { label: "Tipo y número de documento", aliases: ["tipo y numero de documento"] },
  billing_address: { label: "Dirección", aliases: ["direccion"], group: "billing" },
  tax_condition: { label: "Condición fiscal", aliases: ["tipo de contribuyente", "condicion fiscal", "condicion frente al iva"] },
  gross_income_number: { label: "Ingresos brutos", aliases: [], prefixes: ["inscripcion de ingresos brutos", "ingresos brutos", "numero de ingresos brutos"] },
  buyer: { label: "Comprador", aliases: ["comprador"] },
  business: { label: "Negocio", aliases: ["negocio"] },
  buyer_dni: { label: "DNI", aliases: ["dni"] },
  buyer_address: { label: "Domicilio", aliases: ["domicilio"] },
  buyer_city: { label: "Municipio/Alcaldía", aliases: ["municipio/alcaldia", "municipio", "ciudad", "localidad"] },
  buyer_state: { label: "Provincia", aliases: ["estado", "provincia"], group: "buyer", occurrence: 1 },
  buyer_postal_code: { label: "Código postal", aliases: ["codigo postal"] },
  buyer_country: { label: "País", aliases: ["pais"] },
  shipping_method: { label: "Forma de entrega", aliases: ["forma de entrega"], group: "shipping", occurrence: 0 },
  shipping_on_way_date: { label: "Fecha en camino", aliases: ["fecha en camino"], group: "shipping", occurrence: 0 },
  shipping_delivered_date: { label: "Fecha entregado", aliases: ["fecha entregado", "fecha de entrega"], group: "shipping", occurrence: 0 },
  shipping_carrier: { label: "Transportista", aliases: ["transportista"], group: "shipping", occurrence: 0 },
  shipping_tracking_number: { label: "Número de seguimiento", aliases: ["numero de seguimiento"], group: "shipping", occurrence: 0 },
  shipping_tracking_url: { label: "URL de seguimiento", aliases: ["url de seguimiento"], group: "shipping", occurrence: 0 },
  return_units: { label: "Unidades devueltas", aliases: ["unidades"], group: "return", occurrence: 1 },
  return_method: { label: "Forma de entrega (devolución)", aliases: ["forma de entrega"], group: "return", occurrence: 1 },
  return_on_way_date: { label: "Fecha en camino (devolución)", aliases: ["fecha en camino"], group: "return", occurrence: 1 },
  return_delivered_date: { label: "Fecha entregada (devolución)", aliases: ["fecha entregada", "fecha entregado", "fecha de entrega"], group: "return", occurrence: 1 },
  return_carrier: { label: "Transportista (devolución)", aliases: ["transportista"], group: "return", occurrence: 1 },
  return_tracking_number: { label: "Número de seguimiento (devolución)", aliases: ["numero de seguimiento"], group: "return", occurrence: 1 },
  return_tracking_url: { label: "URL de seguimiento (devolución)", aliases: ["url de seguimiento"], group: "return", occurrence: 1 },
  return_reviewed_by_ml: { label: "Revisado por Mercado Libre", aliases: ["revisado por mercado libre"] },
  return_review_date: { label: "Fecha de revisión", aliases: ["fecha de revision"] },
  return_money_in_favor: { label: "Dinero a favor", aliases: ["dinero a favor"] },
  return_result: { label: "Resultado", aliases: ["resultado"] },
  return_destination: { label: "Destino", aliases: ["destino"] },
  return_result_reason: { label: "Motivo del resultado", aliases: ["motivo del resultado"] },
  claim_units: { label: "Unidades en reclamo", aliases: ["unidades"], group: "claim", occurrence: 2 },
  claim_open: { label: "Reclamo abierto", aliases: ["reclamo abierto"] },
  claim_closed: { label: "Reclamo cerrado", aliases: ["reclamo cerrado"] },
  claim_mediation: { label: "Con mediación", aliases: ["con mediacion"] },
}

export function normalizeHeader(value: unknown) {
  return foldText(value)
    .replace(/\((?:ars|\$|usd)\)/g, "")
    .replace(/[“”"']/g, "")
    .replace(/\s+/g, " ")
    .replace(/[.:]+$/, "")
    .trim()
}

function normalizeGroup(value: unknown): ColumnGroup | null {
  const group = normalizeHeader(value)
  if (!group) return null
  if (group.includes("devol")) return "return"
  if (group.includes("reclam")) return "claim"
  if (group.includes("envio") || group.includes("entrega")) return "shipping"
  if (group.includes("factur")) return "billing"
  if (group.includes("comprador")) return "buyer"
  return "sale"
}

function headerMatches(spec: ColumnSpec, header: string) {
  return (
    spec.aliases.includes(header) ||
    (spec.prefixes ?? []).some((prefix) => header.startsWith(prefix))
  )
}

export interface ResolvedColumns {
  indexes: Partial<Record<MercadoLibreFieldKey, number>>
  /** true si se completaron columnas por posición (diseño histórico verificado). */
  usedLegacyLayout: boolean
  missingRequired: string[]
  missingOptional: string[]
}

/**
 * Resuelve cada campo por el nombre del encabezado (respetando el grupo de
 * la fila superior cuando existe). La posición histórica sólo se usa para
 * completar columnas cuyo nombre no se reconoció y únicamente si todas las
 * columnas reconocidas están exactamente en su lugar histórico: si el
 * archivo cambió de orden, nunca se lee por posición.
 */
export function resolveMercadoLibreColumns(
  headerCells: unknown[],
  groupCells: unknown[],
): ResolvedColumns {
  const headers = headerCells.map(normalizeHeader)
  const hasGroupRow = groupCells.some((cell) => normalizeHeader(cell))
  const groups: Array<ColumnGroup | null> = []
  let currentGroup: ColumnGroup | null = hasGroupRow ? "sale" : null
  headers.forEach((_, index) => {
    const next = normalizeGroup(groupCells[index])
    if (next) currentGroup = next
    groups[index] = currentGroup
  })

  const indexes: Partial<Record<MercadoLibreFieldKey, number>> = {}
  const claimed = new Set<number>()
  for (const key of MERCADOLIBRE_FIELD_KEYS) {
    const spec = MERCADOLIBRE_COLUMNS[key]
    const candidates = headers
      .map((header, index) => ({ header, index }))
      .filter(({ header, index }) => header && !claimed.has(index) && headerMatches(spec, header))
      .map(({ index }) => index)
    if (!candidates.length) continue

    let index: number | undefined
    if (spec.group && hasGroupRow) {
      index = candidates.find((candidate) => groups[candidate] === spec.group)
      if (index === undefined && spec.group === "sale") index = candidates[0]
    } else if (spec.occurrence !== undefined) {
      const all = headers
        .map((header, position) => ({ header, position }))
        .filter(({ header }) => header && headerMatches(spec, header))
        .map(({ position }) => position)
      const byOccurrence = all[spec.occurrence]
      index = byOccurrence !== undefined && !claimed.has(byOccurrence) ? byOccurrence : undefined
    } else {
      index = candidates[0]
    }
    if (index === undefined) continue
    indexes[key] = index
    claimed.add(index)
  }

  const legacyAnchored =
    headers[0] === "# de venta" &&
    headers[1] === "fecha de venta" &&
    MERCADOLIBRE_FIELD_KEYS.every((key, position) => {
      const found = indexes[key]
      return found === undefined || found === position
    })

  let usedLegacyLayout = false
  if (legacyAnchored) {
    MERCADOLIBRE_FIELD_KEYS.forEach((key, position) => {
      if (indexes[key] !== undefined || position >= headers.length || claimed.has(position)) return
      indexes[key] = position
      claimed.add(position)
      usedLegacyLayout = true
    })
  }

  const missingRequired: string[] = []
  const missingOptional: string[] = []
  for (const key of MERCADOLIBRE_FIELD_KEYS) {
    if (indexes[key] !== undefined) continue
    const spec = MERCADOLIBRE_COLUMNS[key]
    ;(spec.required ? missingRequired : missingOptional).push(spec.label)
  }

  return { indexes, usedLegacyLayout, missingRequired, missingOptional }
}

/** Fila de encabezados: la primera que contiene "# de venta" o "Fecha de venta". */
export function findHeaderRow(matrix: unknown[][], limit = 40) {
  const saleNumberAliases = MERCADOLIBRE_COLUMNS.sale_number.aliases
  for (let index = 0; index < Math.min(matrix.length, limit); index += 1) {
    const headers = matrix[index].map(normalizeHeader)
    const hasSaleNumber = headers.some((header) => saleNumberAliases.includes(header))
    const hasSaleDate = headers.includes("fecha de venta")
    if (hasSaleNumber || hasSaleDate) return index
  }
  return -1
}
