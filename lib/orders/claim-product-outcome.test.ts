import assert from "node:assert/strict"
import test from "node:test"
import {
  getClaimItemOutcomeCounts,
  getClaimProductOutcomeLines,
  getClaimProductOutcomeTitle,
  getReturnReceptionOutcomeLines,
} from "./claim-product-outcome.ts"

test("una frase por destino físico, sin mezclar baja con otros estados", () => {
  assert.deepEqual(getClaimProductOutcomeLines({ restocked: 1, writtenOff: 0 }), ["1 unidad reincorporada al stock"])
  assert.deepEqual(getClaimProductOutcomeLines({ restocked: 0, writtenOff: 1 }), ["1 unidad dada de baja"])
  assert.deepEqual(getClaimProductOutcomeLines({ restocked: 2, discounted: 1, writtenOff: 3, keptByCustomer: 1 }), [
    "2 unidades reincorporadas al stock",
    "1 unidad reincorporada al stock con descuento",
    "3 unidades dadas de baja",
    "1 unidad quedó en poder del cliente",
  ])
  for (const line of getClaimProductOutcomeLines({ restocked: 1, writtenOff: 1, keptByCustomer: 1 })) {
    assert.doesNotMatch(line, /pérdida|perdida/, "no existe un estado de pérdida separado")
  }
  assert.deepEqual(getClaimProductOutcomeLines({ restocked: 0, writtenOff: 0 }), [])
})

test("título corto para una unidad; detalle cuando hay varias o destinos mixtos", () => {
  assert.equal(getClaimProductOutcomeTitle({ restocked: 1, writtenOff: 0 }), "Reincorporada al stock")
  assert.equal(getClaimProductOutcomeTitle({ restocked: 0, writtenOff: 1 }), "Dada de baja")
  assert.equal(getClaimProductOutcomeTitle({ restocked: 3, writtenOff: 0 }), "3 unidades reincorporadas al stock")
  assert.equal(getClaimProductOutcomeTitle({ restocked: 1, writtenOff: 2 }), "1 unidad reincorporada al stock · 2 unidades dadas de baja")
  assert.equal(getClaimProductOutcomeTitle({ restocked: 0, writtenOff: 0 }), null)
})

test("la recepción auditada se describe con lo que decidió el Admin", () => {
  assert.deepEqual(getReturnReceptionOutcomeLines({ sellableQuantity: 0, discountedQuantity: 0, nonSellableQuantity: 1 }), ["1 unidad dada de baja"])
  assert.deepEqual(getReturnReceptionOutcomeLines({ sellableQuantity: 1, nonSellableQuantity: 0 }), ["1 unidad reincorporada al stock"])
  assert.deepEqual(getReturnReceptionOutcomeLines(null), [])
})

test("destino por ítem: unidades del reclamo o recepción acotada; lo no recibido sólo figura al terminar", () => {
  assert.deepEqual(getClaimItemOutcomeCounts({ claimedQuantity: 1, restockedQuantity: 0, writtenOffQuantity: 1, includeNotReturned: true }),
    { restocked: 0, writtenOff: 1, keptByCustomer: 0 })
  assert.deepEqual(getClaimItemOutcomeCounts({ claimedQuantity: 2, restockedQuantity: 5, writtenOffQuantity: 5, includeNotReturned: true }),
    { restocked: 2, writtenOff: 0, keptByCustomer: 0 }, "nunca más que lo reclamado")
  assert.deepEqual(getClaimItemOutcomeCounts({ claimedQuantity: 2, restockedQuantity: 0, writtenOffQuantity: 0, includeNotReturned: true }),
    { restocked: 0, writtenOff: 0, keptByCustomer: 2 })
  assert.deepEqual(getClaimItemOutcomeCounts({
    claimedQuantity: 3, restockedQuantity: 9, writtenOffQuantity: 9, includeNotReturned: true,
    units: [{ role: "original", location: "reincorporada_stock" }, { role: "original", location: "baja" },
      { role: "original", location: "conservada_cliente" }, { role: "reemplazo", location: "baja" }],
  }), { restocked: 1, writtenOff: 1, keptByCustomer: 1 }, "con unidades manda el reclamo, no el acumulado del ítem")
})
