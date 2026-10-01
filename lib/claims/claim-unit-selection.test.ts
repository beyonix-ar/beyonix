import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  buildClaimUnits,
  getInitialClaimSelection,
  isSingleUnitClaim,
  toClaimAffectedItems,
  toggleClaimUnit,
  WHOLE_ORDER_SELECTION,
} from "./claim-unit-selection.ts"

test("pedido con UNA unidad total: viene seleccionada y no se puede destildar", () => {
  const units = buildClaimUnits([{ id: 7, cantidad: 1 }])
  assert.equal(isSingleUnitClaim(units), true)
  const selection = getInitialClaimSelection(units)
  assert.deepEqual(selection, ["7:1"])
  assert.deepEqual(toggleClaimUnit(selection, "7:1", units), ["7:1"], "no queda en 0 unidades")
  assert.deepEqual(toClaimAffectedItems(selection, units), [{ order_item_id: 7, quantity: 1 }])
})

test("dos o más unidades: ninguna seleccionada al inicio", () => {
  assert.deepEqual(getInitialClaimSelection(buildClaimUnits([{ id: 7, cantidad: 2 }])), [])
  assert.deepEqual(getInitialClaimSelection(buildClaimUnits([{ id: 7, cantidad: 1 }, { id: 8, cantidad: 1 }])), [])
})

test("cantidad > 1 genera unidades independientes (Producto X — Unidad 1, 2, 3)", () => {
  const units = buildClaimUnits([{ id: 7, cantidad: 3 }, { id: 8, cantidad: 1 }])
  assert.deepEqual(
    units.map((unit) => [unit.key, unit.unitNumber, unit.unitCount]),
    [["7:1", 1, 3], ["7:2", 2, 3], ["7:3", 3, 3], ["8:1", 1, 1]],
  )
  let selection = toggleClaimUnit([], "7:2", units)
  selection = toggleClaimUnit(selection, "7:3", units)
  assert.deepEqual(toClaimAffectedItems(selection, units), [{ order_item_id: 7, quantity: 2 }], "sólo las marcadas")
  selection = toggleClaimUnit(selection, "7:2", units)
  assert.deepEqual(toClaimAffectedItems(selection, units), [{ order_item_id: 7, quantity: 1 }], "se puede destildar")
  assert.deepEqual(toClaimAffectedItems(toggleClaimUnit([], "8:1", units), units), [{ order_item_id: 8, quantity: 1 }])
})

test("'Todo el pedido' no manda unidades; marcar una unidad lo reemplaza", () => {
  const units = buildClaimUnits([{ id: 7, cantidad: 2 }, { id: 8, cantidad: 1 }])
  assert.deepEqual(toClaimAffectedItems([WHOLE_ORDER_SELECTION], units), [])
  assert.deepEqual(toggleClaimUnit([WHOLE_ORDER_SELECTION], "8:1", units), ["8:1"])
})

function readSource(path: string) {
  return readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n")
}

test("UI: aviso sólo con 2+ unidades, envío deshabilitado sin selección y check verde con tilde blanca", () => {
  const source = readSource("../../components/claims/customer-claim-experience.tsx")
  assert.match(source, /\{claimUnits\.length > 1 && \(\s*<p data-claim-units-hint className="[^"]*font-bold[^"]*underline[^"]*">\s*Marcá únicamente las unidades con falla/)
  assert.match(source, /affectedItems\.length === 0 \|\|/, "Enviar reclamo deshabilitado con 0 unidades")
  assert.match(source, /aria-disabled=\{singleUnitClaim \|\| undefined\}/)
  assert.match(source, /selectedItem\s*\?\s*"border-emerald-700 bg-emerald-500"/)
  assert.match(source, /<Check className="size-3 text-white" strokeWidth=\{3\.5\} \/>/)
  // Se envía lo marcado por unidad, agrupado por ítem (mismo contrato de la API).
  assert.match(source, /toClaimAffectedItems\(affectedItems, claimUnits\)/)
  assert.doesNotMatch(source, /affectedQuantities/)
})
