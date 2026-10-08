import assert from "node:assert/strict"
import test from "node:test"

import {
  BillingCsvError,
  billingEntriesFromCsv,
  billingErrorMessage,
  detectBillingColumns,
  MAX_BILLING_CSV_ROWS,
  parseBillingAmount,
  parseBillingCsv,
  parseBillingDate,
} from "./andreani-billing.ts"

test("importes: formato argentino e internacional, nunca adivina cifras ambiguas como decimales", () => {
  const cases: Array<[string, string | null]> = [
    ["8500", "8500"], ["$ 8.500", "8500"], ["8.500,50", "8500.50"], ["8,500.50", "8500.50"],
    ["8500,5", "8500.5"], ["8500.5", "8500.5"], ["1.234.567,89", "1234567.89"], ["ARS 7.900", "7900"],
    ["8,500", "8500"], ["-100", null], ["abc", null], ["", null], ["8.50.0", null], ["123456789", null],
  ]
  for (const [input, expected] of cases) assert.equal(parseBillingAmount(input), expected, input)
})

test("fechas: AAAA-MM-DD o DD/MM/AAAA, sólo fechas reales", () => {
  assert.equal(parseBillingDate("2026-10-08"), "2026-10-08")
  assert.equal(parseBillingDate("8/10/2026"), "2026-10-08")
  assert.equal(parseBillingDate("08-10-2026"), "2026-10-08")
  for (const invalid of ["31/02/2026", "2026/10/08", "10-2026", "ayer", ""]) assert.equal(parseBillingDate(invalid), null, invalid)
})

test("CSV de Excel (es-AR): separador ;, BOM, comillas, CRLF y tildes", () => {
  const csv = "﻿Número de envío;Importe;Fecha factura;Factura;Observación\r\n" +
    "360000101651699;\"8.500,00\";08/10/2026;A-0001-00001234;\"Entrega; zona \"\"AMBA\"\"\"\r\n" +
    "\r\n" +
    "360000101651700;7.900;2026-10-08;A-0001-00001234;\r\n"
  const parsed = parseBillingCsv(csv)
  assert.deepEqual(parsed.headers, ["Número de envío", "Importe", "Fecha factura", "Factura", "Observación"])
  assert.equal(parsed.rows.length, 2)
  assert.equal(parsed.rows[0]["Observación"], "Entrega; zona \"AMBA\"")
  const mapping = detectBillingColumns(parsed.headers)
  assert.deepEqual(mapping, { tracking: "Número de envío", amount: "Importe", billedOn: "Fecha factura", reference: "Factura", notes: "Observación" })
  const { entries, rowNumbers, errors } = billingEntriesFromCsv(parsed.rows, mapping)
  assert.deepEqual(errors, [])
  assert.deepEqual(rowNumbers, [2, 3])
  assert.deepEqual(entries[0], { tracking: "360000101651699", amount: "8500.00", billedOn: "2026-10-08", reference: "A-0001-00001234", notes: "Entrega; zona \"AMBA\"" })
  assert.equal(entries[1].notes, null)
})

test("CSV: mapeo manual cuando los nombres cambian; errores por fila sin frenar las válidas", () => {
  const parsed = parseBillingCsv("guia,valor,dia,comprobante,clase\nAAA111,1000,2026-10-01,F-1,devolución\nBBB222,mil,2026-10-01,F-1,\nCCC333,1000,2026-13-01,F-1,\nDDD444,1000,2026-10-01,,\nEEE555,1000,2026-10-01,F-1,regalo\n,1000,2026-10-01,F-2,reenvío")
  assert.deepEqual(detectBillingColumns(parsed.headers), { reference: "comprobante" }, "sólo se asignan alias conocidos")
  assert.throws(() => billingEntriesFromCsv(parsed.rows, { tracking: "guia" }), /Asigná las columnas: Importe, Fecha, Referencia/)
  const { entries, errors } = billingEntriesFromCsv(parsed.rows, { tracking: "guia", amount: "valor", billedOn: "dia", reference: "comprobante", movementType: "clase" })
  assert.deepEqual(errors.map((error) => error.row), [3, 4, 5, 6])
  assert.deepEqual(entries.map((entry) => [entry.tracking, entry.movementType]), [["AAA111", "return"], [null, "exchange_resend"]])
})

test("CSV: límites de tamaño, filas y estructura", () => {
  assert.throws(() => parseBillingCsv(""), BillingCsvError)
  assert.throws(() => parseBillingCsv("a,b\n"), /no tiene filas/)
  assert.throws(() => parseBillingCsv("a,a\n1,2"), /únicos/)
  assert.throws(() => parseBillingCsv("a,b\n\"1,2"), /comillas/)
  assert.throws(() => parseBillingCsv("x".repeat(1_000_001)), /1 MB/)
  const many = "a,b\n" + "1,2\n".repeat(MAX_BILLING_CSV_ROWS + 1)
  assert.throws(() => parseBillingCsv(many), /2000 filas/)
  assert.equal(parseBillingCsv("a,b\n" + "1,2\n".repeat(MAX_BILLING_CSV_ROWS)).rows.length, MAX_BILLING_CSV_ROWS)
})

test("errores de la base se traducen; nunca se muestra el código técnico", () => {
  assert.equal(billingErrorMessage("BILLING_TRACKING_OTHER_ORDER"), "Ese tracking pertenece a otro pedido.")
  assert.equal(billingErrorMessage("LOGISTICS_FORBIDDEN"), "Sólo Admin puede conciliar la logística.")
  assert.equal(billingErrorMessage("duplicate key value violates unique constraint"), "No se pudo registrar la facturación.")
})
