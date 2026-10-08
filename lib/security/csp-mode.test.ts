import { test } from "node:test"
import assert from "node:assert/strict"

import { resolveCspMode } from "./csp-mode.ts"

test("producción aplica CSP aunque CSP_MODE esté ausente", () => {
  assert.equal(resolveCspMode(undefined, "production"), "enforce")
})

test("desarrollo conserva Report-Only por defecto", () => {
  assert.equal(resolveCspMode(null, "development"), "report-only")
})

test("CSP_MODE vacío usa el modo del entorno", () => {
  assert.equal(resolveCspMode("", "production"), "enforce")
})

test("CSP_MODE sólo espacios usa el modo del entorno", () => {
  assert.equal(resolveCspMode("   ", "production"), "enforce")
})

test("CSP_MODE=report-only se mantiene explícito", () => {
  assert.equal(resolveCspMode("report-only", "production"), "report-only")
})

test("CSP_MODE=enforce activa enforcing", () => {
  assert.equal(resolveCspMode("enforce"), "enforce")
})

test("CSP_MODE=enforce con espacios alrededor (típico de .env) sigue activando enforcing", () => {
  assert.equal(resolveCspMode("  enforce  "), "enforce")
})

test("un typo de mayúsculas nunca activa enforcing por accidente", () => {
  assert.equal(resolveCspMode("Enforce", "development"), "report-only")
  assert.equal(resolveCspMode("ENFORCE", "development"), "report-only")
})

test("un valor inválido usa el modo del entorno", () => {
  assert.equal(resolveCspMode("enforced", "production"), "enforce")
  assert.equal(resolveCspMode("true", "development"), "report-only")
  assert.equal(resolveCspMode("Report-Only", "production"), "enforce")
})
