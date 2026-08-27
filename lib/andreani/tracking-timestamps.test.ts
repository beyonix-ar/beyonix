import assert from "node:assert/strict"
import test from "node:test"

import { isNaiveAndreaniTimestamp, parseAndreaniTimestamp } from "./tracking-timestamps.ts"

test("detecta timestamps naive (sin offset ni Z)", () => {
  assert.equal(isNaiveAndreaniTimestamp("2026-08-26T15:11:02.4760000"), true)
  assert.equal(isNaiveAndreaniTimestamp("2026-08-26T15:11:00.0000000"), true)
})

test("detecta timestamps con offset u con Z explícitos", () => {
  assert.equal(isNaiveAndreaniTimestamp("2026-08-26T15:10:51-03:00"), false)
  assert.equal(isNaiveAndreaniTimestamp("2026-08-26T18:10:51Z"), false)
  assert.equal(isNaiveAndreaniTimestamp("2026-08-26T18:10:51+00:00"), false)
})

test("un timestamp naive de /v3/trazas se interpreta como Argentina (UTC-3), nunca como UTC", () => {
  // Caso real confirmado en vivo (PROD, 2026-08-26): /v3/envios/.../trazas
  // devuelve "2026-08-26T15:11:02.4760000" para el mismo instante que
  // /v2/ordenes-de-envio informa como "2026-08-26T15:10:51-03:00"
  // (fechaCreacion, con offset explícito). Ambos son la misma hora de pared
  // argentina -- el resultado UTC correcto es 18:xx, nunca 15:xx.
  const result = parseAndreaniTimestamp("2026-08-26T15:11:02.4760000")
  assert.equal(result, "2026-08-26T18:11:02.476Z")
})

test("un timestamp con offset explícito se respeta tal cual, sin sumarle nada", () => {
  const result = parseAndreaniTimestamp("2026-08-26T15:10:51-03:00")
  assert.equal(result, "2026-08-26T18:10:51.000Z")
})

test("un timestamp ya en UTC (Z) no se corre 3 horas de más", () => {
  const result = parseAndreaniTimestamp("2026-08-26T18:10:51Z")
  assert.equal(result, "2026-08-26T18:10:51.000Z")
})

test("una fecha inválida lanza en vez de persistir Invalid Date", () => {
  assert.throws(() => parseAndreaniTimestamp("no-es-una-fecha"), RangeError)
})
