import assert from "node:assert/strict"
import test from "node:test"

import {
  calculateInventoryStock,
  classifyReturnStock,
} from "./stock-metrics.ts"

test("una devolución total recibida correctamente vuelve a stock normal", () => {
  const result = classifyReturnStock({ received: 3, sellable: 3 })
  assert.deepEqual(result, {
    received: 3,
    sellable: 3,
    discounted: 0,
    nonSellable: 0,
    pendingReview: 0,
  })
})

test("una devolución parcial conserva las unidades restantes pendientes", () => {
  const result = classifyReturnStock({ received: 4, sellable: 1 })
  assert.equal(result.sellable, 1)
  assert.equal(result.pendingReview, 3)
})

test("clasifica por separado stock con descuento, cuarentena y no vendible", () => {
  const classified = classifyReturnStock({
    received: 7,
    sellable: 1,
    discounted: 2,
    nonSellable: 3,
  })
  const stock = calculateInventoryStock({
    normal: 10 + classified.sellable,
    discounted: classified.discounted,
    nonSellable: classified.nonSellable,
    pendingReview: classified.pendingReview,
  })

  assert.equal(stock.normal, 11)
  assert.equal(stock.discounted, 2)
  assert.equal(stock.quarantine, 1)
  assert.equal(stock.nonSellable, 3)
  assert.equal(stock.sellable, 13)
  assert.equal(stock.physical, 17)
})

test("los datos externos negativos no crean cantidades físicas negativas", () => {
  const classified = classifyReturnStock({
    received: -3,
    sellable: -1,
    discounted: -1,
    nonSellable: -1,
  })
  assert.deepEqual(classified, {
    received: 0,
    sellable: 0,
    discounted: 0,
    nonSellable: 0,
    pendingReview: 0,
  })
})

test("un saldo normal negativo permanece visible para la conciliación", () => {
  const stock = calculateInventoryStock({ normal: -2 })
  assert.equal(stock.normal, -2)
  assert.equal(stock.physical, -2)
})
