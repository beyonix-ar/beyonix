import * as XLSX from "xlsx"

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
export type MercadoLibreFieldMap = Record<MercadoLibreFieldKey, string | number | null>

export interface MercadoLibreImportRow {
  sale_date: string | null
  operation_id: string
  order_id: string
  product_name: string
  sku: string | null
  quantity: number
  gross_amount: number
  fee_amount: number
  shipping_amount: number
  net_amount: number
  raw_data: {
    report_format: "mercadolibre_ventas_ar"
    parsed: MercadoLibreFieldMap
    grouped: Record<string, Record<string, string | number | null>>
    beyonix_cost_mapping?: {
      product_id: number
      variant_id: number | null
      match_key: string
      mapped_at?: string
      mapped_by?: string
    }
    source: {
      sheet: string
      row_number: number
      groups: string[]
      headers: string[]
      cells: Array<string | number | null>
    }
  }
}

export interface MercadoLibreReportSummary {
  sales: number
  completedSales: number
  returnSales: number
  cancelledSales: number
  units: number
  returnedUnits: number
  cancelledUnits: number
  netUnits: number
  productRevenue: number
  saleFees: number
  salesWithSaleFee: number
  fixedCosts: number
  installmentCosts: number
  shippingIncome: number
  shippingIncomeOnReturns: number
  shippingIncomeOnEffectiveSales: number
  shippingCosts: number
  declaredShippingCosts: number
  sizeWeightDifferenceCharges: number
  taxes: number
  discountsBonuses: number
  cancellationsRefunds: number
  total: number
  returnShippingCosts: number
  claims: number
}

export interface ParsedMercadoLibreReport {
  sheetName: string
  rows: MercadoLibreImportRow[]
  summary: MercadoLibreReportSummary
  warnings: string[]
}

const MONTHS: Record<string, number> = {
  enero: 1,
  febrero: 2,
  marzo: 3,
  abril: 4,
  mayo: 5,
  junio: 6,
  julio: 7,
  agosto: 8,
  septiembre: 9,
  octubre: 10,
  noviembre: 11,
  diciembre: 12,
}

const NUMERIC_FIELDS = new Set<MercadoLibreFieldKey>([
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
  "listing_unit_price",
  "return_units",
  "return_money_in_favor",
  "claim_units",
])

function text(value: unknown) {
  return value == null ? "" : String(value).trim()
}

function number(value: unknown) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0
  const normalized = text(value)
    .replace(/\s/g, "")
    .replace(/\$/g, "")
    .replace(/\.(?=\d{3}(?:\D|$))/g, "")
    .replace(",", ".")
  const parsed = Number(normalized)
  return Number.isFinite(parsed) ? parsed : 0
}

function rounded(value: number) {
  return Math.round(value * 100) / 100
}

function parseSaleDate(value: unknown) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString()
  }
  const source = text(value).toLocaleLowerCase("es-AR")
  const match = source.match(
    /^(\d{1,2}) de ([a-záéíóúñ]+) de (\d{4})(?:\s+(\d{1,2}):(\d{2}))?/i,
  )
  if (!match) return null
  const month = MONTHS[match[2].normalize("NFD").replace(/[\u0300-\u036f]/g, "")]
  if (!month) return null
  const day = String(Number(match[1])).padStart(2, "0")
  const monthText = String(month).padStart(2, "0")
  const hour = String(Number(match[4] ?? 0)).padStart(2, "0")
  const minute = String(Number(match[5] ?? 0)).padStart(2, "0")
  return `${match[3]}-${monthText}-${day}T${hour}:${minute}:00-03:00`
}

function isReturnRow(fields: MercadoLibreFieldMap) {
  const status = text(fields.status)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
  return (
    status.includes("devol") ||
    status.includes("reembolso") ||
    number(fields.cancellations_refunds) < 0 ||
    Boolean(text(fields.return_tracking_number)) ||
    Boolean(text(fields.return_result))
  )
}

function isCancelledRow(fields: MercadoLibreFieldMap) {
  const status = text(fields.status)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
  return status.includes("cancel") || status.includes("anulad")
}

export function getMercadoLibreCostableUnits(row: MercadoLibreImportRow) {
  const fields = row.raw_data.parsed
  const units = Math.max(0, Math.trunc(number(fields.units) || row.quantity || 0))
  if (isCancelledRow(fields)) return 0

  const reportedReturnedUnits = Math.max(
    0,
    Math.trunc(number(fields.return_units)),
  )
  const returnedUnits = isReturnRow(fields)
    ? reportedReturnedUnits || units
    : reportedReturnedUnits

  return Math.max(0, units - Math.min(units, returnedUnits))
}

function createSummary(rows: MercadoLibreImportRow[]): MercadoLibreReportSummary {
  return rows.reduce<MercadoLibreReportSummary>(
    (summary, row) => {
      const fields = row.raw_data.parsed
      const returned = isReturnRow(fields)
      const cancelled = !returned && isCancelledRow(fields)
      const units = number(fields.units)
      const returnedUnits = returned
        ? Math.max(number(fields.return_units), units)
        : number(fields.return_units)

      summary.sales += 1
      summary.completedSales += returned || cancelled ? 0 : 1
      summary.returnSales += returned ? 1 : 0
      summary.cancelledSales += cancelled ? 1 : 0
      summary.units += units
      summary.returnedUnits += returnedUnits
      summary.cancelledUnits += cancelled ? units : 0
      summary.productRevenue += number(fields.product_revenue)
      summary.saleFees += number(fields.sale_fee)
      summary.salesWithSaleFee += number(fields.sale_fee) !== 0 ? 1 : 0
      summary.fixedCosts += number(fields.fixed_cost)
      summary.installmentCosts += number(fields.installment_cost)
      summary.shippingIncome += number(fields.shipping_income)
      summary.shippingIncomeOnReturns += returned
        ? number(fields.shipping_income)
        : 0
      summary.shippingIncomeOnEffectiveSales += returned || cancelled
        ? 0
        : number(fields.shipping_income)
      summary.shippingCosts += number(fields.shipping_cost)
      summary.declaredShippingCosts += number(fields.declared_shipping_cost)
      summary.sizeWeightDifferenceCharges += number(fields.size_weight_difference_charge)
      summary.taxes += number(fields.taxes)
      summary.discountsBonuses += number(fields.discounts_bonuses)
      summary.cancellationsRefunds += number(fields.cancellations_refunds)
      summary.total += number(fields.total)
      summary.returnShippingCosts += returned
        ? Math.abs(number(fields.shipping_cost)) +
          Math.abs(number(fields.declared_shipping_cost)) +
          Math.abs(number(fields.size_weight_difference_charge))
        : 0
      const claimValues = [
        fields.claim_open,
        fields.claim_closed,
        fields.claim_mediation,
      ].map((value) =>
        text(value)
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .toLowerCase(),
      )
      summary.claims +=
        number(fields.claim_units) > 0 ||
        claimValues.some((value) => Boolean(value && value !== "no"))
          ? 1
          : 0
      summary.netUnits = Math.max(
        0,
        summary.units - summary.returnedUnits - summary.cancelledUnits,
      )
      return summary
    },
    {
      sales: 0,
      completedSales: 0,
      returnSales: 0,
      cancelledSales: 0,
      units: 0,
      returnedUnits: 0,
      cancelledUnits: 0,
      netUnits: 0,
      productRevenue: 0,
      saleFees: 0,
      salesWithSaleFee: 0,
      fixedCosts: 0,
      installmentCosts: 0,
      shippingIncome: 0,
      shippingIncomeOnReturns: 0,
      shippingIncomeOnEffectiveSales: 0,
      shippingCosts: 0,
      declaredShippingCosts: 0,
      sizeWeightDifferenceCharges: 0,
      taxes: 0,
      discountsBonuses: 0,
      cancellationsRefunds: 0,
      total: 0,
      returnShippingCosts: 0,
      claims: 0,
    },
  )
}

export function parseMercadoLibreSalesReport(buffer: ArrayBuffer): ParsedMercadoLibreReport {
  const workbook = XLSX.read(buffer, { type: "array", cellDates: true })
  const sheetName =
    workbook.SheetNames.find((name) => name.trim().toLowerCase() === "ventas ar") ??
    workbook.SheetNames[0]
  if (!sheetName) throw new Error("El archivo no contiene hojas.")

  const sheet = workbook.Sheets[sheetName]
  const matrix = XLSX.utils.sheet_to_json<Array<string | number | Date | null>>(sheet, {
    header: 1,
    defval: null,
    raw: true,
  })
  const headerIndex = matrix.findIndex(
    (row) =>
      text(row[0]).toLowerCase() === "# de venta" &&
      row.some((cell) => text(cell).toLowerCase() === "fecha de venta"),
  )
  if (headerIndex < 0) {
    throw new Error(
      "No se encontró la fila de encabezados del reporte “Ventas AR” de Mercado Libre.",
    )
  }

  const rawGroups = matrix[headerIndex - 1] ?? []
  const headers = matrix[headerIndex].map((value) => text(value))
  const groups: string[] = []
  let currentGroup = "Ventas"
  headers.forEach((_, index) => {
    const nextGroup = text(rawGroups[index])
    if (nextGroup) currentGroup = nextGroup
    groups[index] = currentGroup
  })

  const warnings = new Set<string>()
  if (headers.length < MERCADOLIBRE_FIELD_KEYS.length) {
    warnings.add(
      `El reporte tiene ${headers.length} columnas y se esperaban ${MERCADOLIBRE_FIELD_KEYS.length}.`,
    )
  }

  const rows = matrix
    .slice(headerIndex + 1)
    .map<MercadoLibreImportRow | null>((cells, relativeIndex) => {
      const saleNumber = text(cells[0])
      if (!saleNumber) return null

      const fields = {} as MercadoLibreFieldMap
      MERCADOLIBRE_FIELD_KEYS.forEach((key, index) => {
        fields[key] = NUMERIC_FIELDS.has(key)
          ? number(cells[index])
          : text(cells[index]) || null
      })

      const grouped: Record<string, Record<string, string | number | null>> = {}
      MERCADOLIBRE_FIELD_KEYS.forEach((key, index) => {
        const group = groups[index] || "Otros"
        grouped[group] ??= {}
        const label = headers[index] || key
        const uniqueLabel = grouped[group][label] === undefined ? label : `${label} (${key})`
        grouped[group][uniqueLabel] = fields[key]
      })

      const marketplaceCharges = -(
        number(fields.sale_fee) +
        number(fields.fixed_cost) +
        number(fields.installment_cost) +
        number(fields.size_weight_difference_charge) +
        number(fields.taxes)
      )
      const shippingCosts =
        -number(fields.shipping_cost) - number(fields.declared_shipping_cost)
      const parsedDate = parseSaleDate(fields.sale_date_text)
      if (!parsedDate) warnings.add(`No se pudo interpretar la fecha de la venta ${saleNumber}.`)

      return {
        sale_date: parsedDate,
        operation_id: saleNumber,
        order_id: text(fields.purchase_order) || saleNumber,
        product_name: text(fields.listing_title) || `Venta Mercado Libre ${saleNumber}`,
        sku: text(fields.sku) || null,
        quantity: Math.max(1, Math.trunc(number(fields.units) || 1)),
        gross_amount: rounded(number(fields.product_revenue)),
        fee_amount: rounded(marketplaceCharges),
        shipping_amount: rounded(shippingCosts),
        net_amount: rounded(number(fields.total)),
        raw_data: {
          report_format: "mercadolibre_ventas_ar",
          parsed: fields,
          grouped,
          source: {
            sheet: sheetName,
            row_number: headerIndex + relativeIndex + 2,
            groups,
            headers,
            cells: MERCADOLIBRE_FIELD_KEYS.map((_, index) => {
              const value = cells[index]
              if (value instanceof Date) return value.toISOString()
              return value == null ? null : value
            }),
          },
        },
      }
    })
    .filter((row): row is MercadoLibreImportRow => Boolean(row))

  if (!rows.length) {
    throw new Error("El reporte no contiene ventas para importar.")
  }

  return {
    sheetName,
    rows,
    summary: createSummary(rows),
    warnings: [...warnings],
  }
}

export function summarizeMercadoLibreRows(rows: MercadoLibreImportRow[]) {
  return createSummary(rows)
}
