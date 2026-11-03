import assert from "node:assert/strict"
import test from "node:test"

import { calculateCartTotals } from "../cart/cart-totals.ts"
import {
  estimateProductCashProfit,
  getCurrentCashUnitPrice,
  isSinglePaymentFeeReliable,
  type CashProfitVariantInput,
  type SinglePaymentFeeInput,
} from "./product-cash-profit.ts"
import { getSinglePaymentProfitAmount, simulateProductProfitability } from "./product-pricing.ts"

// Config vigente en producción (2026-11-02): comisión base manual 3,46% + IVA 21%
// → 4,1866% → 5% efectivo (redondeo hacia arriba de installments.ts).
const PROD_FINANCING = { baseProcessingPercent: 3.46, ivaPercent: 21, surchargePercentByCount: { 2: 7.79, 3: 10.49, 6: 18.69 } }
const FEE: SinglePaymentFeeInput = {
  installmentsFinancing: PROD_FINANCING,
  baseSource: "manual",
  manualBaseConfirmed: true,
  transferDiscountPercent: 10,
}
const single = (unitCost: number | null): CashProfitVariantInput[] => [
  { variantId: null, variantName: null, unitCost, active: true, availableStock: 5 },
]

function available(result: ReturnType<typeof estimateProductCashProfit>) {
  assert.equal(result.status, "available", JSON.stringify(result))
  return result as Extract<typeof result, { status: "available" }>
}

test("MP 1 pago: precio × (1 − 5%) − costo, el mismo número que la rentabilidad del editor", () => {
  const result = available(estimateProductCashProfit({ productId: 1, productActive: true, price: 30_000, variants: single(15_000), fee: FEE }))
  assert.equal(result.feePercent, 5)
  assert.equal(result.cashPrice, 30_000)
  assert.equal(result.minProfit, 13_500)
  assert.equal(result.maxProfit, 13_500)
  const editor = getSinglePaymentProfitAmount(
    simulateProductProfitability({ price: 30_000, cost: 15_000, config: PROD_FINANCING, transferDiscountPercent: 10 })!,
  )
  assert.equal(result.minProfit, editor, "fuente única: escenario mp_unico")
})

test("transferencia y cuotas 2/3/6 no cambian la ganancia al contado", () => {
  const base = available(estimateProductCashProfit({ productId: 1, productActive: true, price: 26_900, variants: single(9_000), fee: FEE })).minProfit
  for (const transferDiscountPercent of [0, 10, 25]) {
    assert.equal(available(estimateProductCashProfit({ productId: 1, productActive: true, price: 26_900, variants: single(9_000), fee: { ...FEE, transferDiscountPercent } })).minProfit, base)
  }
  const expensiveInstallments = { ...PROD_FINANCING, surchargePercentByCount: { 2: 40, 3: 40, 6: 44 } }
  assert.equal(
    available(estimateProductCashProfit({ productId: 1, productActive: true, price: 26_900, variants: single(9_000), fee: { ...FEE, installmentsFinancing: expensiveInstallments } })).minProfit,
    base,
  )
})

test("precio efectivo: el mismo del carrito (evento vigente incluido), nunca precio_anterior", () => {
  for (const productId of [1, 2, 4, 7, 99]) {
    assert.equal(
      getCurrentCashUnitPrice(productId, 45_000),
      calculateCartTotals([{ product: { id: productId, precio: 45_000 }, quantity: 1 }], { shippingCost: 0 }).productsTotal,
    )
  }
})

test("ganancia cero y negativa se informan tal cual", () => {
  assert.equal(available(estimateProductCashProfit({ productId: 1, productActive: true, price: 20_000, variants: single(19_000), fee: FEE })).minProfit, 0)
  assert.equal(available(estimateProductCashProfit({ productId: 1, productActive: true, price: 20_000, variants: single(21_000), fee: FEE })).minProfit, -2_000)
})

test("variantes: rango desde/hasta (sin promedio) y la inactiva queda afuera", () => {
  const result = available(estimateProductCashProfit({
    productId: 1, productActive: true,
    price: 30_000,
    variants: [
      { variantId: 11, variantName: "NEGRO", unitCost: 10_000, active: true, availableStock: 5 },
      { variantId: 12, variantName: "ROJO ÁMBAR", unitCost: 12_000, active: true, availableStock: 5 },
      { variantId: 13, variantName: "ROSA", unitCost: 29_000, active: false, availableStock: 5 },
    ],
    fee: FEE,
  }))
  assert.equal(result.minProfit, 16_500)
  assert.equal(result.maxProfit, 18_500)
  assert.deepEqual(result.variants.map((variant) => variant.variantId), [11, 12])
  assert.deepEqual(result.missingCostVariants, [])
})

test("costo incompleto: la variante sin costo se avisa y no entra en el rango", () => {
  const result = available(estimateProductCashProfit({
    productId: 1, productActive: true,
    price: 30_000,
    variants: [
      { variantId: 11, variantName: "NEGRO", unitCost: 10_000, active: true, availableStock: 5 },
      { variantId: 12, variantName: "AZUL", unitCost: null, active: true, availableStock: 5 },
    ],
    fee: FEE,
  }))
  assert.equal(result.minProfit, 18_500)
  assert.equal(result.maxProfit, 18_500)
  assert.deepEqual(result.missingCostVariants, [{ variantId: 12, variantName: "AZUL" }])
})

test("no disponible: sin costo, sin variantes vendibles o sin precio", () => {
  const reason = (result: ReturnType<typeof estimateProductCashProfit>) => result.status === "unavailable" ? result.reason : null
  assert.equal(reason(estimateProductCashProfit({ productId: 1, productActive: true, price: 30_000, variants: single(null), fee: FEE })), "no_cost")
  assert.equal(reason(estimateProductCashProfit({
    productId: 1, productActive: true, price: 30_000,
    variants: [{ variantId: 11, variantName: "NEGRO", unitCost: 9_000, active: false, availableStock: 5 }],
    fee: FEE,
  })), "no_sellable_stock")
  assert.equal(reason(estimateProductCashProfit({ productId: 1, productActive: true, price: 0, variants: single(9_000), fee: FEE })), "no_price")
  assert.equal(reason(estimateProductCashProfit({ productId: 1, productActive: true, price: null, variants: single(9_000), fee: FEE })), "no_price")
})

test("tarifa MP 1 pago sin confirmar ni observar: No disponible, nunca un default inventado", () => {
  const unconfirmed = { ...FEE, manualBaseConfirmed: false }
  assert.equal(isSinglePaymentFeeReliable(unconfirmed), false)
  const result = estimateProductCashProfit({ productId: 1, productActive: true, price: 30_000, variants: single(9_000), fee: unconfirmed })
  assert.equal(result.status, "unavailable")
  assert.equal(result.status === "unavailable" && result.reason, "fee_unconfigured")
  assert.match(result.status === "unavailable" ? result.message : "", /Falta configurar el costo de Mercado Pago en 1 pago/)

  // Aprendida de un pago real: confiable aunque el manual no esté confirmado.
  assert.equal(isSinglePaymentFeeReliable({ ...unconfirmed, baseSource: "observed" }), true)
  // Cero o absurdo: no es una tarifa.
  assert.equal(isSinglePaymentFeeReliable({ ...FEE, installmentsFinancing: { ...PROD_FINANCING, baseProcessingPercent: 0 } }), false)
})

// Sólo participa lo que hoy se puede vender: activo y con stock DISPONIBLE > 0
// (físico − reservas, lib/inventory/sellable-stock.ts — lo calcula la ruta).
const variant = (variantId: number, variantName: string, unitCost: number | null, active: boolean, availableStock: number): CashProfitVariantInput =>
  ({ variantId, variantName, unitCost, active, availableStock })
const estimate = (variants: CashProfitVariantInput[]) =>
  estimateProductCashProfit({ productId: 1, productActive: true, price: 30_000, variants, fee: FEE })

test("A/B/D: activa con stock entra; activa sin stock vendible queda fuera del rango y del detalle", () => {
  const result = available(estimate([
    variant(11, "NEGRO", 10_000, true, 3),
    variant(12, "BLANCO", 4_000, true, 0),
  ]))
  assert.equal(result.minProfit, 18_500)
  assert.equal(result.maxProfit, 18_500, "BLANCO (ganancia mayor) no amplía el rango")
  assert.deepEqual(result.variants.map((item) => item.variantId), [11])
})

test("C: inactiva con stock sigue excluida", () => {
  const result = available(estimate([variant(11, "NEGRO", 10_000, true, 3), variant(13, "ROSA", 29_000, false, 8)]))
  assert.deepEqual(result.variants.map((item) => item.variantId), [11])
  assert.equal(result.minProfit, 18_500)
})

test("E: todas las activas sin stock vendible → No disponible · Sin variantes con stock vendible", () => {
  const result = estimate([variant(11, "NEGRO", 10_000, true, 0), variant(12, "AZUL", 12_000, true, 0), variant(13, "ROSA", 9_000, false, 4)])
  assert.equal(result.status, "unavailable")
  assert.equal(result.status === "unavailable" && result.reason, "no_sellable_stock")
  assert.equal(result.status === "unavailable" && result.message, "Sin variantes con stock vendible.")
})

test("F/G: sin costo sólo advierte si la variante tiene stock vendible", () => {
  const withoutStock = available(estimate([variant(11, "NEGRO", 10_000, true, 2), variant(12, "AZUL", null, true, 0)]))
  assert.deepEqual(withoutStock.missingCostVariants, [], "sin stock: no hay falso Costo incompleto")
  const withStock = available(estimate([variant(11, "NEGRO", 10_000, true, 2), variant(12, "AZUL", null, true, 1)]))
  assert.deepEqual(withStock.missingCostVariants, [{ variantId: 12, variantName: "AZUL" }])
  assert.equal(withStock.minProfit, 18_500)
})

test("H/I: producto simple sin stock vendible → No disponible; con stock → cálculo normal", () => {
  const empty = estimateProductCashProfit({ productId: 1, productActive: true, price: 30_000, variants: [{ variantId: null, variantName: null, unitCost: 10_000, active: true, availableStock: 0 }], fee: FEE })
  assert.equal(empty.status, "unavailable")
  assert.equal(empty.status === "unavailable" && empty.message, "Sin stock vendible.")
  const stocked = available(estimateProductCashProfit({ productId: 1, productActive: true, price: 30_000, variants: [{ variantId: null, variantName: null, unitCost: 10_000, active: true, availableStock: 1 }], fee: FEE }))
  assert.equal(stocked.minProfit, 18_500, "misma fórmula: 30.000 × 0,95 − 10.000")
})

// Regla del padre: catálogo y carrito sólo venden productos con `activo = true`.
const parent = (productActive: boolean, variants: CashProfitVariantInput[]) =>
  estimateProductCashProfit({ productId: 1, productActive, price: 30_000, variants, fee: FEE })
const inactiveMessage = (result: ReturnType<typeof estimateProductCashProfit>) =>
  result.status === "unavailable" && result.reason === "product_inactive" ? result.message : null

test("padre A/B: producto simple inactivo con stock → No disponible; activo con stock → cálculo normal", () => {
  const stocked = [{ variantId: null, variantName: null, unitCost: 10_000, active: true, availableStock: 4 }]
  assert.equal(inactiveMessage(parent(false, stocked)), "Producto inactivo.")
  assert.equal(available(parent(true, stocked)).minProfit, 18_500)
})

test("padre C/D: con variantes, padre inactivo → No disponible sin rango ni detalle; padre activo → cálculo normal", () => {
  const variants = [variant(11, "NEGRO", 10_000, true, 3), variant(12, "ÁMBAR", 12_000, true, 2)]
  const inactive = parent(false, variants)
  assert.equal(inactiveMessage(inactive), "Producto inactivo.")
  assert.equal("variants" in inactive, false, "sin detalle por variante")
  const active = available(parent(true, [variant(11, "NEGRO", 10_000, true, 3)]))
  assert.equal(active.minProfit, 18_500)
  assert.deepEqual(active.variants.map((item) => item.variantId), [11])
})

test("padre E: padre activo + variante activa sin stock vendible sigue excluida", () => {
  const result = available(parent(true, [variant(11, "NEGRO", 10_000, true, 3), variant(12, "BLANCO", 4_000, true, 0)]))
  assert.deepEqual(result.variants.map((item) => item.variantId), [11])
  assert.equal(result.maxProfit, 18_500)
})