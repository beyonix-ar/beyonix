import assert from "node:assert/strict"
import test from "node:test"

import { normalizeUsername } from "./username.ts"

test("Lucas, lucas y ' LUCAS ' normalizan a la misma cadena (caso real pedido en la auditoría)", () => {
  const variants = ["Lucas", "lucas", " LUCAS ", "LuCaS", "\tlucas\n"]
  const normalized = variants.map(normalizeUsername)

  assert.deepEqual(normalized, variants.map(() => "lucas"))
})

test("trimea espacios al inicio y al final", () => {
  assert.equal(normalizeUsername("  antares  "), "antares")
})

test("cadena vacía o sólo espacios: undefined, nunca ''", () => {
  assert.equal(normalizeUsername(""), undefined)
  assert.equal(normalizeUsername("   "), undefined)
})

test("valores no-string: undefined", () => {
  assert.equal(normalizeUsername(null), undefined)
  assert.equal(normalizeUsername(undefined), undefined)
  assert.equal(normalizeUsername(123), undefined)
  assert.equal(normalizeUsername({}), undefined)
})

test("no toca espacios internos (sólo trim en los bordes)", () => {
  assert.equal(normalizeUsername("  ana maria  "), "ana maria")
})
