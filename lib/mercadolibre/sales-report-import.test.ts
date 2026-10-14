import assert from "node:assert/strict"
import test from "node:test"

import { argentinaDateKey } from "../business/dashboard-timezone.ts"
import { countSaleOperations } from "../business/dashboard-sales-analytics.ts"
import { getMercadoLibreSaleIdentity } from "./import-integrity.ts"
import { MERCADOLIBRE_FIELD_KEYS } from "./report-columns.ts"
import { parseAmount, parseArgentinaDateTime, parseSaleNumber } from "./report-values.ts"
import {
  MercadoLibreReportError,
  computeMercadoLibreAmounts,
  getMercadoLibreTotalDifference,
  parseCsv,
  parseMercadoLibreSalesReport,
  readSheetMatrix,
} from "./sales-report.ts"
import { getMercadoLibreCommercialAmounts } from "./sale-costing.ts"
import {
  buildMercadoLibreWorkbook,
  headerFor,
  saleRow,
  textBuffer,
} from "./fixtures/ml-report-fixture.ts"

function rowsFor(count: number) {
  return Array.from({ length: count }, (_, index) =>
    saleRow({
      sale_number: String(2000010000000000 + index),
      sale_date_text: `${(index % 28) + 1} de octubre de 2026 ${String(index % 24).padStart(2, "0")}:15 hs.`,
      listing_title: `Producto ${index % 40}`,
      sku: `SKU-${index % 40}`,
      listing_id: `MLA${100000 + (index % 40)}`,
    }),
  )
}

/* ------------------------------ valores ------------------------------ */

test("importes: formato argentino, texto de Excel, moneda y negativos", () => {
  const value = (input: unknown) => {
    const parsed = parseAmount(input)
    return parsed.ok ? parsed.value : parsed.reason
  }
  assert.equal(value(1234.56), 1234.56)
  assert.equal(value("1.234,56"), 1234.56)
  assert.equal(value("$ 1.234,56"), 1234.56)
  assert.equal(value("-$ 1.234,56"), -1234.56)
  assert.equal(value("$ -2.600"), -2600)
  assert.equal(value("(500,50)"), -500.5)
  assert.equal(value("1.234"), 1234, "un punto con 3 decimales es separador de miles en AR")
  assert.equal(value("12.50"), 12.5)
  assert.equal(value("1,234,567"), 1234567)
  assert.equal(value("1,234.56"), 1234.56)
  assert.equal(value("1.234.567,8"), 1234567.8)
  assert.equal(value(""), 0)
  assert.equal(value(null), 0)
  assert.equal(value("−300"), -300, "signo menos Unicode")
  assert.equal(typeof value("abc"), "string")
  assert.equal(typeof value("12,3,4"), "string")
  assert.equal(typeof value("1.23,4.5"), "string")
})

test("fechas: texto de ML, dd/mm/aaaa, ISO y serial de Excel en hora argentina", () => {
  const date = (input: unknown) => {
    const parsed = parseArgentinaDateTime(input)
    return parsed.ok ? parsed.value : `ERROR ${parsed.reason}`
  }
  assert.equal(date("15 de marzo de 2026 14:35 hs."), "2026-03-15T14:35:00-03:00")
  assert.equal(date("1 de Septiembre de 2026"), "2026-09-01T00:00:00-03:00")
  assert.equal(date("3 de setiembre de 2026 9:05"), "2026-09-03T09:05:00-03:00")
  assert.equal(date("15/03/2026 23:50"), "2026-03-15T23:50:00-03:00")
  assert.equal(date("2026-03-15 08:00"), "2026-03-15T08:00:00-03:00")
  assert.equal(date("2026-03-16T02:50:00Z"), "2026-03-15T23:50:00-03:00", "un instante UTC se pasa a hora AR")
  assert.equal(date(46096.5), "2026-03-15T12:00:00-03:00", "serial de Excel")
  assert.match(date("03/04/26"), /^ERROR .*dos dígitos/)
  assert.match(date("31 de febrero de 2026"), /^ERROR .*día inválido/)
  assert.match(date("mañana"), /^ERROR/)
  assert.match(date(""), /^ERROR .*vacía/)
})

test("número de venta: dígitos, sin notación científica ni pérdida de precisión", () => {
  assert.deepEqual(parseSaleNumber("2000012345678901"), { ok: true, value: "2000012345678901" })
  assert.deepEqual(parseSaleNumber("# 2000 0123"), { ok: true, value: "20000123" })
  assert.deepEqual(parseSaleNumber(123456), { ok: true, value: "123456" })
  assert.equal(parseSaleNumber(2000012345678901).ok, false, "Excel ya perdió dígitos")
  assert.match(String((parseSaleNumber("2,00001E+15") as { reason: string }).reason), /notación científica/)
  assert.equal(parseSaleNumber("ABC-1").ok, false)
})

/* ---------------------------- estructura ---------------------------- */

test("archivo válido: columnas, montos, fechas AR y totales", () => {
  const report = parseMercadoLibreSalesReport(buildMercadoLibreWorkbook([
    saleRow(),
    saleRow({ sale_number: "2000012345678902", units: 1, product_revenue: "10.000,00", sale_fee: "-1.300", shipping_cost: "-900", taxes: "-75", total: "7.725" }),
  ]), "ventas.xlsx")

  assert.equal(report.fileKind, "xlsx")
  assert.equal(report.sheetName, "Ventas AR")
  assert.equal(report.rowsRead, 2)
  assert.equal(report.invalidRows.length, 0)
  assert.equal(report.rows.length, 2)
  assert.equal(report.usedLegacyLayout, false, "todas las columnas se reconocieron por nombre")
  assert.equal(report.columns.length, MERCADOLIBRE_FIELD_KEYS.length)
  const [first, second] = report.rows
  assert.equal(first.sale_date, "2026-03-15T14:35:00-03:00")
  assert.equal(first.operation_id, "2000012345678901")
  assert.equal(first.gross_amount, 20000)
  assert.equal(first.fee_amount, 2750, "cargo por venta + impuestos")
  assert.equal(first.shipping_amount, 1800)
  assert.equal(first.net_amount, 15450)
  assert.equal(first.product_name, "Auriculares Ñandú Pro")
  assert.equal(first.raw_data.parsed.listing_id, "MLA123456789")
  assert.equal(second.gross_amount, 10000, "importe exportado como texto")
  assert.deepEqual(report.totals, { operations: 2, lines: 2, units: 3, gross: 30000, charges: 4125, shipping: 2700, refunds: 0, net: 23175 })
  assert.equal(report.reconciliation.matching, 2, "el Total de ML cuadra con sus conceptos")
  assert.equal(first.raw_data.source.row_number, 7, "fila real de Excel")
  assert.equal(first.raw_data.source.headers, undefined, "los encabezados se guardan una vez por lote")
})

test("columnas desordenadas, sin fila de grupos y con columnas extra: mismos datos", () => {
  const base = parseMercadoLibreSalesReport(buildMercadoLibreWorkbook([saleRow()]))
  const shuffled = [...MERCADOLIBRE_FIELD_KEYS].reverse()
  const reordered = parseMercadoLibreSalesReport(buildMercadoLibreWorkbook([saleRow()], { keys: shuffled }))
  const withoutGroups = parseMercadoLibreSalesReport(buildMercadoLibreWorkbook([saleRow()], { groupRow: false }))
  const extra = parseMercadoLibreSalesReport(buildMercadoLibreWorkbook([saleRow()], { insertBefore: { key: "product_revenue", header: "Columna nueva de ML" } }))

  for (const report of [reordered, withoutGroups, extra]) {
    assert.equal(report.invalidRows.length, 0)
    assert.deepEqual(report.rows[0].raw_data.parsed, base.rows[0].raw_data.parsed)
    assert.equal(report.rows[0].net_amount, base.rows[0].net_amount)
    assert.equal(report.usedLegacyLayout, false)
  }
  assert.equal(reordered.rows[0].raw_data.parsed.buyer_state, "Córdoba", "‘Estado’ del comprador no pisa el estado de la venta")
  assert.equal(reordered.rows[0].raw_data.parsed.status, "Entregada")
})

test("columna faltante: error claro con el nombre de la columna", () => {
  const without = MERCADOLIBRE_FIELD_KEYS.filter((key) => key !== "product_revenue")
  assert.throws(
    () => parseMercadoLibreSalesReport(buildMercadoLibreWorkbook([saleRow()], { keys: without })),
    (error: unknown) =>
      error instanceof MercadoLibreReportError &&
      error.message.startsWith("No se encontró la columna ‘Ingresos por productos’"),
  )
  const withoutTwo = without.filter((key) => key !== "total")
  assert.throws(
    () => parseMercadoLibreSalesReport(buildMercadoLibreWorkbook([saleRow()], { keys: withoutTwo })),
    /No se encontraron las columnas ‘Ingresos por productos’ y ‘Total’/,
  )
})

test("encabezados con otro texto en el diseño histórico se leen por posición, nunca si el orden cambió", () => {
  const renameHeaders = { fixed_cost: "Cargo fijo por unidad (ARS)", sale_fee: "Tarifa de venta (ARS)" }
  const legacy = parseMercadoLibreSalesReport(
    buildMercadoLibreWorkbook([saleRow({ fixed_cost: -50, total: 15400 })], { renameHeaders }),
  )
  assert.equal(legacy.usedLegacyLayout, true)
  assert.equal(legacy.rows[0].raw_data.parsed.fixed_cost, -50)
  assert.equal(legacy.rows[0].raw_data.parsed.sale_fee, -2600)
  assert.ok(legacy.warnings.some((warning) => warning.includes("posición histórica")))

  // Mismo renombre pero con una columna insertada: la posición ya no es confiable.
  assert.throws(
    () =>
      parseMercadoLibreSalesReport(
        buildMercadoLibreWorkbook([saleRow()], { renameHeaders, insertBefore: { key: "units", header: "Nueva" } }),
      ),
    /No se encontró la columna ‘Cargo por venta e impuestos’/,
  )
})

test("archivos que no son reportes de ML: vacío, binario, dañado o ajeno", () => {
  assert.throws(() => parseMercadoLibreSalesReport(new ArrayBuffer(0)), /El archivo está vacío/)
  const pdf = textBuffer("%PDF-1.7\u0000\u0001binario")
  assert.throws(() => parseMercadoLibreSalesReport(pdf, "factura.pdf"), /no es un Excel/)
  const broken = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  assert.throws(() => parseMercadoLibreSalesReport(broken.buffer), /dañado/)
  assert.throws(
    () => parseMercadoLibreSalesReport(textBuffer("Producto;Precio\nMate;1000\n"), "precios.csv"),
    /no parece un reporte de ventas de Mercado Libre/,
  )
  assert.throws(
    () => parseMercadoLibreSalesReport(buildMercadoLibreWorkbook([])),
    /sólo tiene encabezados/,
  )
})

test("filas vacías se ignoran; filas con datos inválidos se informan con número de fila", () => {
  const report = parseMercadoLibreSalesReport(buildMercadoLibreWorkbook([
    saleRow({ sale_number: "2000000000000001" }),
    saleRow({ sale_number: "2000000000000002", product_revenue: "veinte mil" }),
    saleRow({ sale_number: "2000000000000003", sale_date_text: "03/04/26" }),
    saleRow({ sale_number: "", listing_title: "Sin número" }),
    saleRow({ sale_number: "2,00001E+15" }),
    saleRow({ sale_number: "2000000000000006", units: 0 }),
    saleRow({ sale_number: "2000000000000007", units: 1.5 }),
    saleRow({ sale_number: "2000000000000008" }),
  ], { blankAfter: [0, 0, 3] }))

  assert.equal(report.emptyRows, 2)
  assert.equal(report.rowsRead, 8)
  assert.deepEqual(report.rows.map((row) => row.operation_id), ["2000000000000001", "2000000000000008"])
  const messages = report.invalidRows.map((row) => `Fila ${row.rowNumber}: ${row.messages.join("; ")}`)
  assert.equal(report.invalidRows.length, 6)
  assert.match(messages[0], /^Fila \d+: ‘Ingresos por productos’ no es un número válido \(“veinte mil”\)/)
  assert.match(messages[1], /la fecha de venta usa un año de dos dígitos/)
  assert.match(messages[2], /el número de venta está vacío/)
  assert.match(messages[3], /notación científica/)
  assert.match(messages[4], /0 unidades/)
  assert.match(messages[5], /‘Unidades’ no es una cantidad entera/)
  assert.ok(report.invalidRows.every((row) => row.rowNumber > 6), "números de fila reales de Excel")
})

test("fórmulas: valor calculado se usa; fórmula con error invalida la fila", () => {
  const report = parseMercadoLibreSalesReport(buildMercadoLibreWorkbook(
    [saleRow({ sale_number: "2000000000000001" }), saleRow({ sale_number: "2000000000000003" })],
    {
      rawCells: [
        { row: 0, key: "total", cell: { t: "n", v: 15450, f: "H8+I8+M8+P8" } },
        { row: 1, key: "product_revenue", cell: { t: "e", v: 7, w: "#DIV/0!" } },
      ],
    },
  ))
  assert.deepEqual(report.rows.map((row) => row.operation_id), ["2000000000000001"])
  assert.equal(report.rows[0].net_amount, 15450)
  assert.match(report.invalidRows[0].messages.join(), /‘Ingresos por productos’ tiene un error de fórmula \(#DIV\/0!\)/)

  // Un archivo generado por otra herramienta puede guardar la fórmula sin su resultado.
  const matrix = readSheetMatrix({ "!ref": "A1:B1", A1: { t: "n", v: 1 }, B1: { t: "n", f: "A1*2" } as never })
  assert.deepEqual(matrix, [[1, { formulaError: "fórmula sin resultado calculado" }]])
})

test("fecha nativa de Excel y fecha cercana a medianoche quedan en el día argentino correcto", () => {
  const report = parseMercadoLibreSalesReport(buildMercadoLibreWorkbook(
    [
      saleRow({ sale_number: "2000000000000001", sale_date_text: "15 de marzo de 2026 23:50 hs." }),
      saleRow({ sale_number: "2000000000000002", sale_date_text: "16 de marzo de 2026 00:10 hs." }),
      saleRow({ sale_number: "2000000000000003" }),
    ],
    { rawCells: [{ row: 2, key: "sale_date_text", cell: { t: "n", v: 46096.9930555556, z: "dd/mm/yyyy hh:mm" } }] },
  ))
  assert.equal(report.invalidRows.length, 0)
  const keys = report.rows.map((row) => argentinaDateKey(row.sale_date!))
  assert.deepEqual(keys, ["2026-03-15", "2026-03-16", "2026-03-15"])
  assert.equal(report.rows[2].sale_date, "2026-03-15T23:50:00-03:00")
  assert.equal(new Date(report.rows[0].sale_date!).toISOString(), "2026-03-16T02:50:00.000Z", "en UTC ya es el día siguiente")
})

test("texto con caracteres raros se normaliza sin cambiar su significado", () => {
  const report = parseMercadoLibreSalesReport(buildMercadoLibreWorkbook([
    saleRow({ listing_title: "  Auriculares​  Ñandú Pro\t", sku: " AUR-01 ", listing_id: " mla 123456789 ", variant: "Color :  Negro" }),
  ]))
  const row = report.rows[0]
  assert.equal(row.product_name, "Auriculares Ñandú Pro")
  assert.equal(row.sku, "AUR-01")
  assert.equal(row.raw_data.parsed.listing_id, "MLA123456789")
  assert.equal(row.raw_data.parsed.variant, "Color : Negro")
})

test("CSV de Excel AR: separador ;, decimales con coma, comillas y ANSI", () => {
  const keys = ["sale_number", "sale_date_text", "status", "units", "product_revenue", "sale_fee", "shipping_cost", "cancellations_refunds", "total", "listing_title", "sku"] as const
  const header = keys.map((key) => headerFor(key)).join(";")
  const line = ["2000000000000001", "15/03/2026 10:00", "Entregada", "1", "\"10.000,50\"", "-1.300,05", "0", "0", "8.700,45", "\"Mate; calabaza \"\"premium\"\"\"", "MAT-1"].join(";")
  const csv = `${header}\r\n${line}\r\n`
  const utf = parseMercadoLibreSalesReport(textBuffer(`﻿${csv}`), "ventas.csv")
  assert.equal(utf.fileKind, "csv")
  assert.equal(utf.invalidRows.length, 0)
  assert.equal(utf.rows[0].gross_amount, 10000.5)
  assert.equal(utf.rows[0].product_name, "Mate; calabaza \"premium\"")
  assert.ok(utf.missingOptionalColumns.includes("SKU") === false)
  const ansi = parseMercadoLibreSalesReport(textBuffer(csv.replace("Mate; calabaza", "Ñandú; calabaza"), "latin1"), "ventas.csv")
  assert.equal(ansi.rows[0].product_name, "Ñandú; calabaza \"premium\"")
  assert.deepEqual(parseCsv("a,b\n1,\"x,y\"\n"), [["a", "b"], ["1", "x,y"]])
})

test("formato .xls (Excel 97-2003) también se acepta", () => {
  const report = parseMercadoLibreSalesReport(buildMercadoLibreWorkbook([saleRow()], { bookType: "xls" }), "ventas.xls")
  assert.equal(report.fileKind, "xls")
  assert.equal(report.rows[0].net_amount, 15450)
})

/* ----------------------------- duplicados ----------------------------- */

test("duplicados en el archivo: idénticos se ignoran, contradictorios se rechazan", () => {
  const report = parseMercadoLibreSalesReport(buildMercadoLibreWorkbook([
    saleRow({ sale_number: "2000000000000001" }),
    saleRow({ sale_number: "2000000000000001" }),
    saleRow({ sale_number: "2000000000000002", units: 2 }),
    saleRow({ sale_number: "2000000000000002", units: 3 }),
  ]))
  assert.deepEqual(report.rows.map((row) => row.operation_id), ["2000000000000001"])
  assert.equal(report.duplicateRows.length, 1)
  assert.equal(report.duplicateRows[0].duplicateOfRow, 7)
  assert.equal(report.invalidRows.length, 2)
  assert.match(report.invalidRows[0].messages[0], /repetida con datos distintos \(filas 9, 10\)/)
})

test("reimportar o importar un archivo solapado produce las mismas identidades", () => {
  const first = parseMercadoLibreSalesReport(buildMercadoLibreWorkbook(rowsFor(30).slice(0, 20)))
  const overlapping = parseMercadoLibreSalesReport(buildMercadoLibreWorkbook(rowsFor(30).slice(10, 30), { titleRows: 2 }))
  const firstKeys = new Set(first.rows.map(getMercadoLibreSaleIdentity))
  const shared = overlapping.rows.filter((row) => firstKeys.has(getMercadoLibreSaleIdentity(row)))
  assert.equal(shared.length, 10, "las 10 ventas del período compartido se reconocen como ya cargadas")
  const again = parseMercadoLibreSalesReport(buildMercadoLibreWorkbook(rowsFor(30).slice(0, 20)))
  assert.deepEqual(again.rows.map(getMercadoLibreSaleIdentity), first.rows.map(getMercadoLibreSaleIdentity))
})

/* ---------------------- varias líneas por operación --------------------- */

test("venta con varios productos: una operación, líneas conservadas, totales sumados", () => {
  const report = parseMercadoLibreSalesReport(buildMercadoLibreWorkbook([
    saleRow({ sale_number: "2000000000000011", purchase_order: "2000000000000010", multi_product_package: "Sí", listing_id: "MLA1", sku: "A", units: 1, product_revenue: 10000, sale_fee: -1300, shipping_cost: -500, taxes: 0, total: 8200 }),
    saleRow({ sale_number: "2000000000000012", purchase_order: "2000000000000010", multi_product_package: "Sí", listing_id: "MLA2", sku: "B", units: 2, product_revenue: 6000, sale_fee: -780, shipping_cost: -500, taxes: 0, total: 4720 }),
    saleRow({ sale_number: "2000000000000013", listing_id: "MLA3", sku: "C", variant: "Rojo", units: 1, product_revenue: 3000, sale_fee: -390, shipping_cost: 0, taxes: 0, total: 2610 }),
    saleRow({ sale_number: "2000000000000013", listing_id: "MLA3", sku: "C", variant: "Azul", units: 1, product_revenue: 3000, sale_fee: -390, shipping_cost: 0, taxes: 0, total: 2610 }),
  ]))
  assert.equal(report.rows.length, 4, "cada línea se conserva")
  assert.equal(report.invalidRows.length, 0, "dos variantes de la misma venta no son duplicados")
  assert.equal(report.totals.operations, 2)
  assert.equal(report.totals.units, 5)
  assert.equal(report.totals.gross, 22000)
  assert.equal(report.totals.charges, 2860)
  assert.equal(report.totals.shipping, 1000)
  assert.equal(report.totals.net, 18140)
  assert.equal(report.packageRows, 2)
  assert.ok(report.warnings.some((warning) => warning.includes("paquetes de varios productos")))

  const dashboardSales = report.rows.map((row) => ({
    id: `ml-${row.operation_id}-${row.raw_data.parsed.variant}`,
    channel: "MercadoLibre Marketplace" as const,
    orderId: row.order_id,
    ...getMercadoLibreCommercialAmounts({ ...row }),
  }))
  assert.equal(countSaleOperations(dashboardSales), 2, "el Dashboard no infla operaciones por línea")
})

/* ------------------------- estados y métricas ------------------------- */

test("cancelada y reembolsada no inflan ventas, operaciones ni unidades", () => {
  const report = parseMercadoLibreSalesReport(buildMercadoLibreWorkbook([
    saleRow({ sale_number: "2000000000000021", status: "Entregada" }),
    saleRow({ sale_number: "2000000000000022", status: "Cancelada por el comprador", units: 1, product_revenue: 10000, sale_fee: 0, shipping_cost: 0, taxes: 0, cancellations_refunds: -10000, total: 0 }),
    saleRow({ sale_number: "2000000000000023", status: "Devolución finalizada. Te devolvimos el dinero", units: 2, return_units: 2, product_revenue: 20000, sale_fee: -2600, shipping_cost: -1800, taxes: -150, cancellations_refunds: -20000, total: -4550 }),
    saleRow({ sale_number: "2000000000000024", status: "Devolución parcial", units: 3, return_units: 1, product_revenue: 30000, sale_fee: -3900, shipping_cost: -1800, taxes: -225, cancellations_refunds: -10000, total: 14075 }),
  ]))
  assert.equal(report.invalidRows.length, 0)
  const commercial = report.rows.map((row) => ({
    id: row.operation_id,
    channel: "MercadoLibre Marketplace" as const,
    orderId: row.order_id,
    ...getMercadoLibreCommercialAmounts({ ...row }),
  }))
  assert.deepEqual(commercial.map((sale) => [sale.grossAmount, sale.quantity]), [[20000, 2], [0, 0], [0, 0], [20000, 2]])
  assert.equal(countSaleOperations(commercial), 2, "cancelada y reembolsada completa no son operaciones")
  assert.equal(report.summary.cancelledSales, 1)
  assert.equal(report.summary.returnSales, 2)
  assert.equal(report.totals.refunds, 40000)
  assert.equal(report.totals.net, 15450 + 0 - 4550 + 14075, "el neto es el Total que liquida ML")
})

test("fórmulas monetarias explícitas y conciliación con el Total de ML", () => {
  const fields = { product_revenue: 20000, sale_fee: -2600, fixed_cost: -100, installment_cost: -300, shipping_income: 500, shipping_cost: -1800, declared_shipping_cost: 0, size_weight_difference_charge: -50, taxes: -150, discounts_bonuses: 200, cancellations_refunds: 0, total: 15700 }
  assert.deepEqual(computeMercadoLibreAmounts(fields), { gross: 20000, charges: 3200, shipping: 1800, refunds: 0, net: 15700 })
  assert.equal(getMercadoLibreTotalDifference(fields, false), 0)
  assert.equal(getMercadoLibreTotalDifference({ ...fields, total: 15000 }, false), -700)
})

/* ----------------------------- rendimiento ----------------------------- */

for (const size of [100, 1_000, 5_000]) {
  test(`rendimiento: ${size.toLocaleString("es-AR")} filas se analizan sin errores`, () => {
    const buffer = buildMercadoLibreWorkbook(rowsFor(size))
    const started = performance.now()
    const report = parseMercadoLibreSalesReport(buffer)
    const elapsed = performance.now() - started
    console.log(`  análisis de ${size} filas: ${Math.round(elapsed)} ms`)
    assert.equal(report.rows.length, size)
    assert.equal(report.invalidRows.length, 0)
    assert.ok(elapsed < 20_000, `tardó ${Math.round(elapsed)} ms`)
  })
}
