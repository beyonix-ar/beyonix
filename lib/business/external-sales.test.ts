import assert from "node:assert/strict"
import test from "node:test"

import {
  EXTERNAL_SALE_EXCEL_COLUMNS,
  classifyExternalSalePreview,
  normalizeExternalSaleChannel,
  normalizeExternalSalePaymentMethod,
  normalizeExternalSaleStatus,
  parseExternalSaleAmount,
  parseExternalSaleDate,
  parseExternalSalesSheet,
  parseTabularText,
  validateExternalSaleImportRow,
  type ExternalSalePreviewServerRow,
} from "./external-sales.ts"
import { resolveExternalSaleReportedProfitability, resolveExternalSaleUnitCost } from "./external-sale-profitability.ts"

const TODAY = "2026-10-27"
const HEADER = EXTERNAL_SALE_EXCEL_COLUMNS.map((column) => column.header).join("\t")
const line = (cells: string[]) => cells.join("\t")
const ROW_A = line(["15/03/2026", "Lucía Pérez", "WhatsApp", "AUR-1", "Auricular Ñandú", "2", "$ 11.000", "$ 0", "$ 30.000", "Transferencia", "Entregada", "$ 28.500,50", "$ 6.500", "Pagó en dos veces"])

test("TSV del Excel actual: detecta encabezados, normaliza y conserva los valores importados", () => {
  const sheet = parseExternalSalesSheet(parseTabularText(`${HEADER}\n${ROW_A}\n`), TODAY)
  assert.equal(sheet.error, null)
  assert.equal(sheet.headerDetected, true)
  assert.equal(sheet.rows.length, 1)
  const [row] = sheet.rows
  assert.deepEqual(row.errors, [])
  assert.equal(row.sourceRowNumber, 2, "fila 2 de la hoja: la 1 son los títulos")
  assert.deepEqual(row.payload, {
    source_row_number: 2,
    sale_date: "2026-03-15",
    customer_name: "Lucía Pérez",
    channel: "whatsapp",
    channel_label: "WhatsApp",
    sku: "AUR-1",
    product_name: "Auricular Ñandú",
    quantity: 2,
    shipping_amount: 0,
    payment_method: "Transferencia",
    payment_method_code: "transfer",
    status: "delivered",
    gross_amount: 28500.5,
    declared_profit: 6500,
    notes: "Pagó en dos veces",
    source_values: {
      Fecha: "15/03/2026", Cliente: "Lucía Pérez", Canal: "WhatsApp", SKU: "AUR-1", Producto: "Auricular Ñandú",
      "Cant.": "2", Costo: "$ 11.000", "Envío": "$ 0", Total: "$ 30.000", "Medio de pago": "Transferencia",
      Estado: "Entregada", "Precio Final": "$ 28.500,50", Ganancia: "$ 6.500", "Observación": "Pagó en dos veces",
    },
  })
  assert.ok(!("cost" in (row.payload ?? {})), "Costo y Total no son campos de importación: quedan sólo en los valores importados")

  const long = parseExternalSalesSheet(parseTabularText(`${HEADER}\n${ROW_A.replace("Pagó en dos veces", `  Nota   con   espacios ${"x".repeat(600)}`)}`), TODAY).rows[0]
  assert.equal(long.sourceValues["Observación"].length, 500, "valores importados: celdas limitadas a 500 caracteres")
  assert.ok(long.sourceValues["Observación"].startsWith("Nota con espacios "), "espacios normalizados: no es una copia byte a byte")
})

test("sin fila de títulos: acepta las 14 columnas en el orden del Excel; con otro ancho pide los títulos", () => {
  const sheet = parseExternalSalesSheet(parseTabularText(ROW_A), TODAY)
  assert.equal(sheet.error, null)
  assert.equal(sheet.headerDetected, false)
  assert.equal(sheet.rows[0].payload?.gross_amount, 28500.5)
  assert.match(parseExternalSalesSheet([["15/03/2026", "AUR-1", "1"]], TODAY).error ?? "", /No se encontraron los encabezados/)
  assert.match(parseExternalSalesSheet([["Fecha", "Cliente", "Canal", "Producto"], ["15/03/2026", "x", "y", "z"]], TODAY).error ?? "", /Faltan columnas obligatorias: SKU, Cant\., Precio Final/)
})

test("columnas en otro orden, filas vacías y celdas con saltos de línea entre comillas", () => {
  const text = "Precio Final\tSKU\tCantidad\tFecha\tObservaciones\n15000\tAUR-1\t1\t2026-03-01\t\"Retira\nel sábado\"\n\t\t\t\t\n"
  const sheet = parseExternalSalesSheet(parseTabularText(text), TODAY)
  assert.equal(sheet.rows.length, 1)
  assert.equal(sheet.rows[0].payload?.notes, "Retira el sábado")
  assert.equal(sheet.rows[0].payload?.channel, "other")
  assert.equal(sheet.rows[0].payload?.shipping_amount, 0, "envío vacío = $0")
})

test("errores y advertencias por fila: nunca se convierten en cero", () => {
  const rows = [
    HEADER,
    line(["31/02/2026", "A", "WhatsApp", "AUR-1", "", "1", "", "", "", "", "", "100", "", ""]),
    line(["01/03/2026", "B", "Mercado Libre", "AUR-1", "", "1", "", "", "", "", "", "100", "", ""]),
    line(["01/03/2026", "C", "Tienda", "AUR-1", "", "1,5", "", "", "", "", "", "abc", "", ""]),
    line(["01/12/2026", "D", "Facebook", "", "", "1", "", "-10", "", "Bitcoin", "Señado", "100", "", ""]),
    line(["01/03/2026", "E", "WhatsApp", "AUR-1", "", "1", "", "", "", "", "Anulada", "100", "", ""]),
  ].join("\n")
  const parsed = parseExternalSalesSheet(parseTabularText(rows), TODAY).rows
  assert.match(parsed[0].errors.join(" "), /Fecha inválida/)
  assert.match(parsed[1].errors.join(" "), /Mercado Libre se cargan desde su propio importador/)
  assert.match(parsed[2].errors.join(" "), /tienda web ya están registradas/)
  assert.match(parsed[2].errors.join(" "), /Cantidad inválida/)
  assert.match(parsed[2].errors.join(" "), /Precio final inválido/)
  assert.match(parsed[3].errors.join(" "), /fecha es futura/)
  assert.match(parsed[3].errors.join(" "), /Falta el SKU/)
  assert.match(parsed[3].errors.join(" "), /Envío inválido/)
  assert.match(parsed[3].warnings.join(" "), /Canal “Facebook” no reconocido/)
  assert.match(parsed[3].warnings.join(" "), /Medio de pago “Bitcoin”/)
  assert.match(parsed[3].warnings.join(" "), /Estado “Señado”/)
  assert.match(parsed[4].errors.join(" "), /anulada o devuelta: no se importa/)
  assert.ok(parsed.every((row) => row.payload === null))
})

test("importes en formato argentino: interpretación única y documentada, sin adivinar", () => {
  for (const [input, expected] of [
    ["$ 12.345,67", 12345.67], ["12345,67", 12345.67], ["12.345", 12345], ["0", 0], ["$ 0", 0],
    ["1.234.567", 1234567], ["1,5", 1.5], ["12345.67", 12345.67], ["ARS 900", 900],
    ["-$ 1.500", -1500], ["$ -1.500,50", -1500.5], ["(1.500)", -1500], ["-0,5", -0.5], ["1,23", 1.23],
  ] as const) {
    assert.equal(parseExternalSaleAmount(input), expected, input)
  }
  assert.equal(parseExternalSaleAmount(""), null, "vacío = sin dato (en Envío se toma $0)")
  assert.equal(parseExternalSaleAmount("   "), null)
  // "1,234": la coma es decimal (nunca 1234) y $1,234 no es un importe en
  // centavos: se marca inválido en vez de redondear a $1,23 en silencio.
  for (const invalid of ["1,234", "12345.678", "1,234,567", "1,234.56", "12.34.5,6", "1.2345,6", "doce", "1,", ",5", "1.5.0"]) {
    assert.ok(Number.isNaN(parseExternalSaleAmount(invalid)), invalid)
  }

  const header = ["Fecha", "SKU", "Cant.", "Precio Final", "Envío", "Ganancia"].join("\t")
  const rows = parseExternalSalesSheet(parseTabularText([
    header,
    ["01/03/2026", "AUR-1", "1", "$ 12.345,67", "", "-$ 2.000"].join("\t"),
    ["01/03/2026", "AUR-1", "1", "12345,67", "0", "1.000"].join("\t"),
    ["01/03/2026", "AUR-1", "1", "1000", "-500", ""].join("\t"),
  ].join("\n")), TODAY).rows
  assert.deepEqual(rows[0].payload && [rows[0].payload.gross_amount, rows[0].payload.shipping_amount, rows[0].payload.declared_profit], [12345.67, 0, -2000])
  assert.deepEqual(rows[1].payload && [rows[1].payload.gross_amount, rows[1].payload.shipping_amount, rows[1].payload.declared_profit], [12345.67, 0, 1000])
  assert.match(rows[2].errors.join(" "), /Envío inválido/, "el envío es un costo: nunca negativo")
})

test("fechas y textos en formato argentino", () => {
  assert.equal(parseExternalSaleDate("5/3/26"), "2026-03-05")
  assert.equal(parseExternalSaleDate("2026-03-05 14:30"), "2026-03-05")
  assert.equal(parseExternalSaleDate("29/02/2025"), null)
  assert.equal(normalizeExternalSaleChannel("Venta directa").code, "direct")
  assert.equal(normalizeExternalSaleChannel("IG").code, "instagram")
  assert.equal(normalizeExternalSalePaymentMethod("Mercado Pago QR").code, "mercadopago_qr")
  assert.equal(normalizeExternalSalePaymentMethod("MP").code, "mercadopago")
  assert.equal(normalizeExternalSalePaymentMethod("Tarjeta de débito").code, "card")
  assert.equal(normalizeExternalSalePaymentMethod("").code, null)
  assert.equal(normalizeExternalSaleStatus("").code, "completed")
  assert.equal(normalizeExternalSaleStatus("ENTREGADO").code, "delivered")
})

function server(index: number, overrides: Partial<ExternalSalePreviewServerRow> = {}): ExternalSalePreviewServerRow {
  return {
    index, resolution: "ok", product_id: 1, variant_id: null, product_name: "Auricular Ñandú", variant_name: null,
    available_units: 3, duplicate_sale_numbers: [], ...overrides,
  }
}

test("preview: ✅ válida, ⚠️ archivado/SKU sin catálogo, ❌ sin stock o sin nombre, 🔁 posible duplicada", () => {
  const sheetRows = [
    line(["01/03/2026", "Ana", "WhatsApp", "AUR-1", "", "2", "", "", "", "", "", "100", "", ""]),
    line(["01/03/2026", "Ana", "WhatsApp", "AUR-1", "", "2", "", "", "", "", "", "100", "", ""]),
    line(["01/03/2026", "Beto", "WhatsApp", "ARCH-1", "", "1", "", "", "", "", "", "100", "", ""]),
    line(["01/03/2026", "Caro", "WhatsApp", "VIEJO-1", "Cargador discontinuado", "1", "", "", "", "", "", "100", "", ""]),
    line(["01/03/2026", "Dani", "WhatsApp", "NO-EXISTE", "Funda sólo del Excel", "1", "", "", "", "", "", "100", "", ""]),
    line(["01/03/2026", "Eli", "WhatsApp", "AUR-1", "", "1", "", "", "", "", "", "200", "", ""]),
    line(["01/03/2026", "Fede", "WhatsApp", "SIN-NOMBRE", "", "1", "", "", "", "", "", "100", "", ""]),
  ]
  const parsed = parseExternalSalesSheet(parseTabularText([HEADER, ...sheetRows].join("\n")), TODAY).rows
  const unlinked = { product_id: null, product_name: null, available_units: null }
  const serverRows = [
    server(0), server(1),
    server(2, { resolution: "archived", product_id: 3 }),
    server(3, { resolution: "historical", ...unlinked }),
    server(4, { resolution: "missing", ...unlinked }),
    server(5, { duplicate_sale_numbers: [42] }),
    server(6, { resolution: "missing", ...unlinked }),
  ]

  const historical = classifyExternalSalePreview(parsed, serverRows, "none")
  assert.deepEqual(historical.map((row) => row.state), ["valid", "duplicate", "warning", "warning", "warning", "duplicate", "error"])
  assert.deepEqual(historical[1].duplicateOf, { saleNumbers: [], inPaste: true })
  assert.deepEqual(historical[5].duplicateOf, { saleNumbers: [42], inPaste: false })
  assert.deepEqual(historical[4].messages, ["SKU histórico sin vínculo con catálogo actual."], "SKU que sólo figura en el Excel: histórica desvinculada")
  assert.deepEqual(historical[3].messages, ["SKU histórico sin vínculo con catálogo actual."])
  assert.match(historical[6].messages.join(" "), /Falta el nombre del producto/, "sin catálogo ni nombre no hay snapshot que mostrar")

  // Nuevas: el stock disponible (3, ya sin reservas) se reparte entre filas
  // del mismo artículo, y el SKU sin catálogo es error: producto válido obligatorio.
  const fresh = classifyExternalSalePreview(parsed, serverRows, "consume")
  assert.deepEqual(fresh.map((row) => row.state), ["valid", "error", "warning", "error", "error", "duplicate", "error"])
  assert.match(fresh[1].messages.join(" "), /Stock insuficiente: quedan 1 unidades/)
  assert.match(fresh[3].messages.join(" "), /una venta nueva necesita un producto válido/)
  assert.match(fresh[4].messages.join(" "), /Sólo puede importarse como histórica/)
})

test("contrato API: valida forma y tipos de cada fila; el producto se identifica sólo por SKU", () => {
  const [row] = parseExternalSalesSheet(parseTabularText(`${HEADER}\n${ROW_A}`), TODAY).rows
  const payload = row.payload!
  assert.deepEqual(validateExternalSaleImportRow(payload), payload)
  assert.deepEqual(validateExternalSaleImportRow({ ...payload, confirm_duplicate: true }), { ...payload, confirm_duplicate: true })
  for (const invalid of [
    { ...payload, product_id: 1 },
    { ...payload, stock_effect: "consume" },
    { ...payload, quantity: 1.5 },
    { ...payload, gross_amount: -1 },
    { ...payload, channel: "mercadolibre" },
    { ...payload, status: "reversed" },
    { ...payload, sale_date: "15/03/2026" },
    { ...payload, source_values: { Costo: 1 } },
    { ...payload, sku: "" },
  ]) {
    assert.equal(validateExternalSaleImportRow(invalid), null, JSON.stringify(Object.keys(invalid).at(-1)))
  }
})

test("51. ganancia reportada: histórica conserva la declarada; nueva usa el costo; sin costo cae en la declarada", () => {
  const amounts = { grossAmount: 30000, feeAmount: 0, shippingAmount: 1000, otherExpenseAmount: 0 }
  const historical = resolveExternalSaleReportedProfitability({ ...amounts, stockEffect: "none", declaredProfit: 6500, merchandiseCost: 20000 })
  assert.equal(historical.profitAmount, 6500, "el costo actual nunca reescribe la ganancia histórica")
  assert.equal(historical.profitSource, "declared")
  assert.equal(historical.merchandiseCost, 22500, "costo implícito coherente con la ganancia declarada")

  const fresh = resolveExternalSaleReportedProfitability({ ...amounts, stockEffect: "consume", declaredProfit: 6500, merchandiseCost: 20000 })
  assert.equal(fresh.profitAmount, 9000)
  assert.equal(fresh.profitSource, "calculated")

  const withoutCost = resolveExternalSaleReportedProfitability({ ...amounts, stockEffect: "consume", declaredProfit: 6500, merchandiseCost: null })
  assert.equal(withoutCost.profitAmount, 6500)
  assert.equal(withoutCost.profitSource, "declared")

  const unknown = resolveExternalSaleReportedProfitability({ ...amounts, stockEffect: "none", declaredProfit: null, merchandiseCost: null })
  assert.deepEqual([unknown.profitAmount, unknown.merchandiseCost, unknown.profitSource], [null, null, null])
  const negative = resolveExternalSaleReportedProfitability({ ...amounts, stockEffect: "none", declaredProfit: -500, merchandiseCost: null })
  assert.equal(negative.profitAmount, -500, "una pérdida declarada se conserva")
  assert.equal(negative.costStatus, "known")
  assert.equal(unknown.costStatus, "undeterminable")
})

test("ganancia declarada imposible: se conserva, el costo queda no determinable y se marca inconsistente", () => {
  // Ingreso $10.000 y ganancia -$5.000: costo implícito $15.000, coherente.
  const loss = resolveExternalSaleReportedProfitability({
    grossAmount: 10000, feeAmount: 0, shippingAmount: 0, otherExpenseAmount: 0,
    stockEffect: "none", declaredProfit: -5000, merchandiseCost: null,
  })
  assert.deepEqual([loss.profitAmount, loss.merchandiseCost, loss.costStatus], [-5000, 15000, "known"])

  // Ganancia $12.000 sobre ingreso neto $10.000: el costo sería -$2.000. No se inventa.
  const impossible = resolveExternalSaleReportedProfitability({
    grossAmount: 10500, feeAmount: 0, shippingAmount: 500, otherExpenseAmount: 0,
    stockEffect: "none", declaredProfit: 12000, merchandiseCost: 3000,
  })
  assert.equal(impossible.profitAmount, 12000, "la ganancia declarada no se oculta")
  assert.equal(impossible.profitSource, "declared")
  assert.equal(impossible.merchandiseCost, null, "costo no determinable, nunca negativo")
  assert.equal(impossible.costStatus, "inconsistent")
})

test("envío = costo logístico de BEYONIX: resta del ingreso neto; $0 por defecto no cambia nada", () => {
  const base = { grossAmount: 20000, feeAmount: 0, otherExpenseAmount: 0, stockEffect: "consume", declaredProfit: null, merchandiseCost: 8000 }
  assert.equal(resolveExternalSaleReportedProfitability({ ...base, shippingAmount: 0 }).profitAmount, 12000)
  assert.equal(resolveExternalSaleReportedProfitability({ ...base, shippingAmount: 1500 }).profitAmount, 10500)
  const [row] = parseExternalSalesSheet(parseTabularText(`Fecha\tSKU\tCant.\tPrecio Final\n01/03/2026\tAUR-1\t1\t20000`), TODAY).rows
  assert.equal(row.payload?.shipping_amount, 0, "sin columna Envío = sin costo para BEYONIX")
})

test("venta sin producto vinculado: $0 de costo manual es 'no informado', no costo cero", () => {
  assert.equal(resolveExternalSaleUnitCost({ productId: null, historicalUnitCost: null, manualUnitCost: 0 }), null)
  assert.equal(resolveExternalSaleUnitCost({ productId: null, historicalUnitCost: null, manualUnitCost: 1200 }), 1200)
  // Con producto: sólo el costo histórico a la fecha, nunca el de hoy.
  assert.equal(resolveExternalSaleUnitCost({ productId: 1, historicalUnitCost: null, manualUnitCost: 999 }), null)
})
