import assert from "node:assert/strict"
import test from "node:test"

import {
  diagnoseVariantAllocation,
  repairVariantAllocation,
} from "./inventory-reconciliation.ts"

const affectedState = {
  genericBalance: 1,
  allocationQuantity: 2,
  variantMovementBalance: 1,
  storedVariantStock: 3,
  historicalLinkedReturnQuantity: 1,
}

test("el diagnóstico identifica la devolución incluida dos veces", () => {
  assert.deepEqual(diagnoseVariantAllocation(affectedState), {
    calculatedStock: 3,
    duplicatedAllocation: 1,
    expectedStock: 2,
    difference: 1,
  })
})

test("reparar reduce sólo la asignación inválida y no cambia el stock físico", () => {
  assert.deepEqual(repairVariantAllocation(affectedState, true), {
    allocationQuantity: 1,
    physicalDelta: 0,
    repairedQuantity: 1,
  })
})

test("la reparación exige confirmación y una causa demostrable", () => {
  assert.throws(() => repairVariantAllocation(affectedState, false), /CONFIRMATION/)
  assert.throws(
    () =>
      repairVariantAllocation(
        { ...affectedState, allocationQuantity: 1, storedVariantStock: 2 },
        true,
      ),
    /NO_PROVEN_DUPLICATE/,
  )
})
