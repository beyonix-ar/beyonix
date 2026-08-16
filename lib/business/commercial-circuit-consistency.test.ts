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

test("las ventas externas catalogadas usan el mismo libro de compras que web y ML", () => {
  assert.match(
    dashboardRoute,
    /from\("external_sales"\)\s*\.select\("id, sale_date, product_id, variant_id,/,
  )
  assert.match(
    dashboardRoute,
    /getUnitCost\(costLedgers, productId, variantId, saleDate\)/,
  )
  assert.match(dashboardRoute, /resolveExternalSaleUnitCost\(\{/)
  assert.match(
    dashboardRoute,
    /externalMerchandiseCosts\.set\(String\(row\.id\), merchandiseCost\)/,
  )
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
      total_cost: 20,
    },
    {
      product_id: 1,
      variant_id: 10,
      purchase_date: "2026-02-01",
      quantity: 2,
      total_cost: 60,
    },
    {
      product_id: 1,
      variant_id: 11,
      purchase_date: "2026-01-01",
      quantity: 1,
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
