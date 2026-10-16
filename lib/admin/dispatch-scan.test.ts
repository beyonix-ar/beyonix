import assert from "node:assert/strict"
import test from "node:test"

import { preparedOrderCode } from "./dispatch.ts"
import { createCameraGate, normalizeScannedCode, orderIdFromDispatchCode, progressPercent, typedInputMethod } from "./dispatch-scan.ts"

test("método de lectura: lector USB (ráfaga), tipeo humano o pegado; todos van al mismo envío", () => {
  const burst = [0, 8, 15, 24, 31, 40, 47, 55, 63, 70, 78, 86]
  assert.equal(typedInputMethod({ pasted: false, keyTimes: burst }), "scanner")
  assert.equal(typedInputMethod({ pasted: false, keyTimes: [0, 180, 420, 610, 900, 1150] }), "manual_code", "tipeo humano")
  assert.equal(typedInputMethod({ pasted: true, keyTimes: burst }), "manual_code", "copiar/pegar")
  assert.equal(typedInputMethod({ pasted: false, keyTimes: [] }), "manual_code", "valor sin teclas (autocompletar)")
  assert.equal(typedInputMethod({ pasted: false, keyTimes: [0, 5, 10] }), "manual_code", "muy pocas teclas")
})

test("lector: el código llega sin Enter, tabulaciones ni espacios alrededor", () => {
  assert.equal(normalizeScannedCode("  BX-PKG-2031-01\r\n"), "BX-PKG-2031-01")
  assert.equal(normalizeScannedCode("\t7790001000017\n"), "7790001000017")
  assert.equal(normalizeScannedCode("   "), null)
  assert.equal(normalizeScannedCode("X".repeat(129)), null)
})

test("cámara: el mismo código en cuadro no se cuenta dos veces; se rearma al salir de cuadro", () => {
  const gate = createCameraGate(3)
  assert.equal(gate("BAR-A"), "BAR-A")
  assert.equal(gate("BAR-A"), null, "el celular quieto sobre el mismo código")
  assert.equal(gate("bar-a"), null, "sin distinguir mayúsculas")
  assert.equal(gate(null), null)
  assert.equal(gate(null), null)
  assert.equal(gate("BAR-A"), null, "dos cuadros vacíos no alcanzan")
  gate(null); gate(null); gate(null)
  assert.equal(gate("BAR-A"), "BAR-A", "salió de cuadro: la segunda unidad igual se cuenta")
  assert.equal(gate("BAR-B"), "BAR-B", "un código distinto se acepta enseguida")
})

test("código → pedido: pedido, pedido preparado, rearmado y bulto; nunca un producto", () => {
  assert.equal(orderIdFromDispatchCode("BX-1031"), 31)
  assert.equal(orderIdFromDispatchCode("#bx-1031"), 31)
  assert.equal(orderIdFromDispatchCode(preparedOrderCode(6, 1)), 6)
  assert.equal(preparedOrderCode(6, 1), "BX-PREP-1006")
  assert.equal(preparedOrderCode(6, 2), "BX-PREP-1006-R2")
  assert.equal(orderIdFromDispatchCode("BX-PREP-1006-R2"), 6)
  assert.equal(orderIdFromDispatchCode("bx-pkg-1006-r2-03"), 6)
  assert.equal(orderIdFromDispatchCode("BX-AUR-000001"), null)
  assert.equal(orderIdFromDispatchCode("DSP-20261016-001"), null)
  assert.equal(orderIdFromDispatchCode("BX-1000"), null)
})

test("progreso: nunca 100 % antes de completar ni más de 100 %", () => {
  assert.equal(progressPercent(0, 7), 0)
  assert.equal(progressPercent(5, 7), 71)
  assert.equal(progressPercent(199, 200), 99)
  assert.equal(progressPercent(7, 7), 100)
  assert.equal(progressPercent(9, 7), 100)
  assert.equal(progressPercent(3, 0), 0)
})
