import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"

import {
  calculateExternalSaleProfitability,
  getExternalSaleMerchandiseCost,
  resolveExternalSaleUnitCost,
} from "./external-sale-profitability.ts"
import { getOrCreateIdempotencyAttempt } from "./idempotency-attempt.ts"
import {
  buildProductCostLedgers,
  getHistoricalUnitCost,
} from "./product-costs.ts"

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), "utf8")
}

const dashboardRoute = source("app/api/admin/dashboard/route.ts")
const mercadoLibreSalesRoute = source("app/api/admin/mercadolibre-sales/route.ts")

// Auditoría 3/7 (P0 confirmado y corregido en Fase 1): dashboard/route.ts
// reimplementaba localmente el cálculo de costo histórico (buildCostLedgers/
// getUnitCost) sin filtrar reception_status/received_quantity, divergiendo
// de la lógica canónica. Los tests de abajo son un CONTRATO ESTRUCTURAL
// sobre el código fuente (no ejecutan el handler, que hace decenas de
// llamadas a Supabase y no es practicable importar fuera de Next.js) -- la
// garantía de comportamiento real vive en product-costs.test.ts, que ejercita
// las mismas funciones que estos archivos importan. Lo que este archivo
// verifica es que NO exista una reimplementación local paralela y que el
// SELECT a product_cost_entries traiga las columnas que esa lógica necesita.

test("dashboard NO reimplementa localmente el cálculo de costo -- usa las funciones canónicas de product-costs.ts", () => {
  assert.match(
    dashboardRoute,
    /import \{\s*[\s\S]*?buildProductCostLedgers,[\s\S]*?getHistoricalUnitCost,[\s\S]*?getReceivedCostContribution,[\s\S]*?\} from "@\/lib\/business\/product-costs"/,
  )
  assert.doesNotMatch(dashboardRoute, /function buildCostLedgers\(/)
  assert.doesNotMatch(dashboardRoute, /function getUnitCost\(/)
  assert.match(dashboardRoute, /getHistoricalUnitCost\(\s*costLedgers,\s*productId,\s*variantId,\s*saleDate,?\s*\)/)
})

test("el SELECT de dashboard a product_cost_entries incluye reception_status y received_quantity (contrato de columnas del P0)", () => {
  assert.match(
    dashboardRoute,
    /\.from\("product_cost_entries"\)\s*\.select\(\s*"id, product_id, variant_id, article_name, sku, purchase_date, quantity, received_quantity, reception_status, total_cost, created_at",?\s*\)/,
  )
})

test("las ventas externas catalogadas usan el mismo libro de compras que web y ML", () => {
  assert.match(
    dashboardRoute,
    /from\("external_sales"\)\s*\.select\("id, sale_date, product_id, variant_id,/,
  )
  assert.match(
    dashboardRoute,
    /getHistoricalUnitCost\(costLedgers, productId, variantId, saleDate\)/,
  )
  assert.match(dashboardRoute, /resolveExternalSaleUnitCost\(\{/)
  assert.match(
    dashboardRoute,
    /externalMerchandiseCosts\.set\(String\(row\.id\), merchandiseCost\)/,
  )
})

// Auditoría 3/7 (P0-2, Fase 1): mercadolibre-sales/route.ts SÍ usaba las
// funciones canónicas, pero su SELECT a product_cost_entries no traía
// reception_status/received_quantity -- mismo efecto práctico que el P0 del
// dashboard (getReceivedCostContribution trata undefined como "recibida" al
// 100%).
test("mercadolibre-sales trae reception_status/received_quantity en AMBOS SELECT a product_cost_entries", () => {
  const matches = [
    ...mercadoLibreSalesRoute.matchAll(/\.from\("product_cost_entries"\)[\s\S]{0,200}?received_quantity, reception_status/g),
  ]
  assert.equal(matches.length, 2, "el SELECT del listado y el de vinculación (link) deben traer ambas columnas")
})

test("el costo y la ganancia por venta externa no duplican el descuento del costo", () => {
  const externalMapping = dashboardRoute.match(
    /\.\.\.externalRows\.map\(\(row\) => \{[\s\S]*?\n\s{8}\}\),/,
  )?.[0] ?? ""

  assert.notEqual(externalMapping, "")
  assert.match(
    externalMapping,
    /externalMerchandiseCosts\.get\(String\(row\.id\)\)/,
  )
  assert.match(
    externalMapping,
    /calculateExternalSaleProfitability\(\{/,
  )
  assert.doesNotMatch(externalMapping, /Number\(row\.unit_cost \?\? 0\) \* quantity/)
  assert.match(externalMapping, /marginPercent: profitability\.marginPercent/)
})

test("el costo histórico respeta fecha y variante sin usar costos futuros", () => {
  const ledgers = buildProductCostLedgers([
    {
      product_id: 1,
      variant_id: 10,
      purchase_date: "2026-01-01",
      quantity: 2,
      received_quantity: 2,
      reception_status: "recibida",
      total_cost: 20,
    },
    {
      product_id: 1,
      variant_id: 10,
      purchase_date: "2026-02-01",
      quantity: 2,
      received_quantity: 2,
      reception_status: "recibida",
      total_cost: 60,
    },
    {
      product_id: 1,
      variant_id: 11,
      purchase_date: "2026-01-01",
      quantity: 1,
      received_quantity: 1,
      reception_status: "recibida",
      total_cost: 100,
    },
  ])

  assert.equal(getHistoricalUnitCost(ledgers, 1, 10, "2026-01-15"), 10)
  assert.equal(getHistoricalUnitCost(ledgers, 1, 10, "2026-03-01"), 20)
  assert.equal(getHistoricalUnitCost(ledgers, 1, 11, "2026-03-01"), 100)
  assert.equal(getHistoricalUnitCost(ledgers, 1, 10, "2025-12-31"), null)
})

test("la rentabilidad externa usa fallback manual sólo sin producto catalogado", () => {
  assert.equal(
    resolveExternalSaleUnitCost({
      productId: 1,
      historicalUnitCost: null,
      manualUnitCost: 999,
    }),
    null,
  )
  assert.equal(
    resolveExternalSaleUnitCost({
      productId: null,
      historicalUnitCost: null,
      manualUnitCost: 20,
    }),
    20,
  )
  assert.equal(
    resolveExternalSaleUnitCost({
      productId: null,
      historicalUnitCost: null,
      manualUnitCost: null,
    }),
    null,
  )

  const merchandiseCost = getExternalSaleMerchandiseCost(20, 2)
  const profitability = calculateExternalSaleProfitability({
    grossAmount: 200,
    feeAmount: 20,
    shippingAmount: 10,
    otherExpenseAmount: 5,
    merchandiseCost,
  })

  assert.equal(merchandiseCost, 40)
  assert.equal(profitability.revenueAfterFees, 165)
  assert.equal(profitability.profitAmount, 125)
  assert.equal(profitability.marginPercent, 62.5)
  assert.deepEqual(
    calculateExternalSaleProfitability({
      grossAmount: 200,
      feeAmount: 20,
      shippingAmount: 10,
      otherExpenseAmount: 5,
      merchandiseCost: null,
    }),
    { revenueAfterFees: 165, profitAmount: null, marginPercent: null },
  )
  assert.deepEqual(
    calculateExternalSaleProfitability({
      grossAmount: "inválido",
      feeAmount: 0,
      shippingAmount: 0,
      otherExpenseAmount: 0,
      merchandiseCost: 10,
    }),
    { revenueAfterFees: null, profitAmount: null, marginPercent: null },
  )
})

test("el retry conserva su key sin fusionar compras legítimas iguales", () => {
  const payload = { kind: "product", productId: 1, variantId: 10, quantity: 2 }
  const firstAttempt = getOrCreateIdempotencyAttempt(null, payload)
  const retry = getOrCreateIdempotencyAttempt(firstAttempt, { ...payload })
  const intentionalRepeat = getOrCreateIdempotencyAttempt(null, { ...payload })
  const concurrentIndependent = getOrCreateIdempotencyAttempt(null, { ...payload })
  const otherVariant = getOrCreateIdempotencyAttempt(firstAttempt, {
    ...payload,
    variantId: 11,
  })
  const expense = getOrCreateIdempotencyAttempt(null, {
    kind: "expense",
    productId: 1,
    variantId: 10,
    quantity: 2,
  })

  assert.equal(retry.key, firstAttempt.key)
  assert.match(firstAttempt.key, /^purchase:/)
  assert.match(expense.key, /^expense:/)
  assert.notEqual(intentionalRepeat.key, firstAttempt.key)
  assert.notEqual(concurrentIndependent.key, intentionalRepeat.key)
  assert.notEqual(otherVariant.key, firstAttempt.key)

  const businessCosts = source("lib/supabase/queries/business-costs.ts")
  assert.match(businessCosts, /pendingCreates\.get\(idempotencyKey\)/)
  assert.match(businessCosts, /pendingCreates\.delete\(idempotencyKey\)/)
  assert.doesNotMatch(businessCosts, /recentIdempotencyKeys|IDEMPOTENCY_KEY_TTL_MS/)
})

test("Mercado Libre actualiza por identidad estable sin borrar ausentes ni retroceder evidencia", () => {
  const migration = source(
    "supabase/migrations/20260801090000_idempotent_mercadolibre_import.sql",
  )

  assert.match(migration, /where sales\.source_key = v_source_key\s+for update;/)
  assert.match(migration, /update public\.mercadolibre_sales[\s\S]*?where id = v_existing\.id;/)
  assert.match(
    migration,
    /mercadolibre_sale_evidence_score\(v_final_raw_data\)[\s\S]*?< public\.mercadolibre_sale_evidence_score\(v_existing\.raw_data\)/,
  )
  assert.doesNotMatch(migration, /delete from public\.mercadolibre_sales/)
})
