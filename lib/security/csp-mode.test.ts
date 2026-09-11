import { test } from "node:test"
import assert from "node:assert/strict"

import { resolveCspMode } from "./csp-mode.ts"

test("CSP_MODE ausente (undefined) cae en report-only", () => {
  assert.equal(resolveCspMode(undefined), "report-only")
})

test("CSP_MODE null cae en report-only", () => {
  assert.equal(resolveCspMode(null), "report-only")
})

test("CSP_MODE vacío cae en report-only", () => {
  assert.equal(resolveCspMode(""), "report-only")
})

test("CSP_MODE sólo espacios cae en report-only", () => {
  assert.equal(resolveCspMode("   "), "report-only")
})

test("CSP_MODE=report-only se mantiene explícito", () => {
  assert.equal(resolveCspMode("report-only"), "report-only")
})

test("CSP_MODE=enforce activa enforcing", () => {
  assert.equal(resolveCspMode("enforce"), "enforce")
})

test("CSP_MODE=enforce con espacios alrededor (típico de .env) sigue activando enforcing", () => {
  assert.equal(resolveCspMode("  enforce  "), "enforce")
})

test("un typo de mayúsculas nunca activa enforcing por accidente", () => {
  assert.equal(resolveCspMode("Enforce"), "report-only")
  assert.equal(resolveCspMode("ENFORCE"), "report-only")
})

test("cualquier valor inválido (typo, boolean, etc.) cae en report-only", () => {
  assert.equal(resolveCspMode("enforced"), "report-only")
  assert.equal(resolveCspMode("true"), "report-only")
  assert.equal(resolveCspMode("1"), "report-only")
  assert.equal(resolveCspMode("Report-Only"), "report-only")
})
