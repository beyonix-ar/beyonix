import assert from "node:assert/strict"
import test from "node:test"

import {
  getStandaloneHistoricalUnitCost,
  standaloneCostKey,
  type StandaloneCostRow,
} from "./standalone-cost-items.ts"

function row(overrides: Partial<StandaloneCostRow> = {}): StandaloneCostRow {
  return {
    id: "row-1",
    product_id: null,
    article_name: "Artículo suelto",
    sku: null,
    purchase_date: "2026-01-01",
    quantity: 1,
    total_cost: 1000,
    received_quantity: null,
    reception_status: "recibida",
    ...overrides,
  }
}

// Auditoría 3/7, Fase 1 (P0-3) y Fase 5 (caso K): getStandaloneHistoricalUnitCost
// reutiliza getReceivedCostContribution (lib/business/product-costs.ts) --
// misma semántica de recepción que el costeo de productos catalogados, ya
// no una suma ingenua de quantity/total_cost.

test("compra RECIBIDA de un artículo no catalogado aporta el costo completo", () => {
  const key = standaloneCostKey({ article_name: "Repuesto X", sku: null })
  const rows = [row({ article_name: "Repuesto X", quantity: 2, total_cost: 2000 })]
  assert.equal(getStandaloneHistoricalUnitCost(rows, key, "2026-06-01"), 1000)
})

test("compra PENDIENTE de un artículo no catalogado no contamina su costo histórico", () => {
  const key = standaloneCostKey({ article_name: "Repuesto Y", sku: null })
  const rows = [
    row({ article_name: "Repuesto Y", quantity: 1, total_cost: 1000, received_quantity: 1 }),
    row({
      article_name: "Repuesto Y",
      purchase_date: "2026-02-01",
      quantity: 10,
      total_cost: 999_999,
      reception_status: "pendiente",
      received_quantity: 0,
    }),
  ]
  assert.equal(getStandaloneHistoricalUnitCost(rows, key, "2026-06-01"), 1000)
})

test("compra ANULADA de un artículo no catalogado no contamina su costo histórico", () => {
  const key = standaloneCostKey({ article_name: "Repuesto Z", sku: null })
  const rows = [
    row({ article_name: "Repuesto Z", quantity: 1, total_cost: 500, received_quantity: 1 }),
    row({
      article_name: "Repuesto Z",
      purchase_date: "2026-02-01",
      quantity: 5,
      total_cost: 50_000,
      reception_status: "anulada",
      received_quantity: 0,
    }),
  ]
  assert.equal(getStandaloneHistoricalUnitCost(rows, key, "2026-06-01"), 500)
})

test("compra PARCIAL de un artículo no catalogado prorratea sólo lo recibido", () => {
  const key = standaloneCostKey({ article_name: "Repuesto W", sku: null })
  const rows = [
    row({
      article_name: "Repuesto W",
      quantity: 10,
      total_cost: 1000,
      reception_status: "parcial",
      received_quantity: 2,
    }),
  ]
  // 10 unidades por $1.000 en total; se recibieron 2 => $200 por 2 unidades.
  assert.equal(getStandaloneHistoricalUnitCost(rows, key, "2026-06-01"), 100)
})

test("un artículo cuya única compra está pendiente queda SIN costo conocido, nunca en 0", () => {
  const key = standaloneCostKey({ article_name: "Repuesto V", sku: null })
  const rows = [
    row({
      article_name: "Repuesto V",
      quantity: 5,
      total_cost: 5000,
      reception_status: "pendiente",
      received_quantity: 0,
    }),
  ]
  assert.equal(getStandaloneHistoricalUnitCost(rows, key, "2026-06-01"), null)
})

test("no mezcla artículos con nombres distintos ni usa costos futuros a la fecha de venta", () => {
  const key = standaloneCostKey({ article_name: "Repuesto U", sku: null })
  const rows = [
    row({ article_name: "Repuesto U", purchase_date: "2026-01-01", quantity: 1, total_cost: 500 }),
    row({ article_name: "Repuesto U", purchase_date: "2026-03-01", quantity: 1, total_cost: 700 }),
    row({ article_name: "Otro repuesto", purchase_date: "2026-01-01", quantity: 1, total_cost: 999_999 }),
  ]
  assert.equal(getStandaloneHistoricalUnitCost(rows, key, "2026-02-01"), 500)
  assert.equal(getStandaloneHistoricalUnitCost(rows, key, "2026-06-01"), 600)
})
