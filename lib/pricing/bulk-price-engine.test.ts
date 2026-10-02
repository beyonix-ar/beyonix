import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  computeBulkPriceUpdate,
  roundBulkPrice,
  validateBulkPriceAction,
} from "./bulk-price-engine.ts"

// Núcleo ÚNICO de cambios masivos: Editor masivo, eventos manuales y eventos
// programados calculan exactamente igual.

const product = { precio: 100_000, precio_anterior: null, descuento: null }

test("+X%: aumenta con el redondeo comercial del Editor masivo y limpia la oferta", () => {
  assert.deepEqual(computeBulkPriceUpdate(product, "price_increase_percent", 5), { precio: 105_000, precio_anterior: null, descuento: null })
  assert.deepEqual(computeBulkPriceUpdate({ precio: 63_400, precio_anterior: 70_000, descuento: 9 }, "price_increase_percent", 5), {
    precio: 66_500,
    precio_anterior: null,
    descuento: null,
  })
})

test("-X% y descuento especial: bajan y dejan el precio anterior para el % OFF", () => {
  for (const kind of ["price_decrease_percent", "discount_percent"] as const) {
    assert.deepEqual(computeBulkPriceUpdate(product, kind, 10), { precio: 90_000, precio_anterior: 100_000, descuento: 10 })
  }
})

test("quitar oferta: mismo precio, sin precio anterior ni descuento", () => {
  assert.deepEqual(computeBulkPriceUpdate({ precio: 90_000, precio_anterior: 100_000, descuento: 10 }, "clear_offer", 0), {
    precio: 90_000,
    precio_anterior: null,
    descuento: null,
  })
})

test("precios nunca negativos ni nulos: porcentaje 1–99 y redondeo mínimo $1", () => {
  assert.equal(validateBulkPriceAction("price_decrease_percent", 100), "El porcentaje debe estar entre 1 y 99.")
  assert.equal(validateBulkPriceAction("price_decrease_percent", 0), "El porcentaje debe estar entre 1 y 99.")
  assert.equal(validateBulkPriceAction("price_increase_percent", -5), "El porcentaje debe estar entre 1 y 99.")
  assert.equal(validateBulkPriceAction("price_increase_percent", Number.NaN), "El porcentaje debe estar entre 1 y 99.")
  assert.equal(validateBulkPriceAction("price_increase_amount", 500), null)
  assert.match(validateBulkPriceAction("price_decrease_amount", -1) ?? "", /monto debe ser positivo/)
  assert.equal(validateBulkPriceAction("clear_offer", null), null)
  assert.equal(roundBulkPrice(-50), 1)
  assert.equal(computeBulkPriceUpdate({ precio: 2, precio_anterior: null, descuento: null }, "price_decrease_percent", 99).precio, 1)
})

test("monto fijo: ambos sentidos usan el mismo redondeo; una baja inválida se rechaza", () => {
  assert.deepEqual(computeBulkPriceUpdate(product, "price_increase_amount", 5_000), { precio: 105_000, precio_anterior: null, descuento: null })
  assert.equal(computeBulkPriceUpdate(product, "price_decrease_amount", 55_000).precio, 45_000)
  assert.equal(computeBulkPriceUpdate({ precio: 500, precio_anterior: null, descuento: null }, "price_decrease_amount", 500).precio, 0)
})

test("un solo motor: Editor masivo, eventos y scheduler usan el núcleo; no queda otra fórmula", () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")
  const bulk = read("../../app/api/admin/product-bulk-actions/route.ts")
  const events = read("../../app/api/admin/product-bulk-events/route.ts")
  const runner = read("../commercial-events/runner.ts")
  for (const source of [bulk, events, runner]) {
    assert.match(source, /computeBulkPriceUpdate\(/)
    assert.doesNotMatch(source, /function (roundBulkPrice|roundPrice)\b|\* \(1 [-+] value \/ 100\)/)
  }
  assert.match(bulk, /resolveBulkTargetProducts\(/)
  assert.match(runner, /resolveBulkTargetProducts\(/)
})
