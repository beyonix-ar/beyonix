import assert from "node:assert/strict"
import test from "node:test"

import {
  DEFAULT_ADMIN_THEME,
  isAdminTheme,
  resolveAdminTheme,
} from "./admin-theme.ts"

test("isAdminTheme reconoce sólo dark/light como valores válidos", () => {
  assert.equal(isAdminTheme("dark"), true)
  assert.equal(isAdminTheme("light"), true)
  assert.equal(isAdminTheme("system"), false)
  assert.equal(isAdminTheme(""), false)
  assert.equal(isAdminTheme(null), false)
  assert.equal(isAdminTheme(undefined), false)
  assert.equal(isAdminTheme(0), false)
})

test("resolveAdminTheme devuelve el valor si es válido", () => {
  assert.equal(resolveAdminTheme("dark"), "dark")
  assert.equal(resolveAdminTheme("light"), "light")
})

test("resolveAdminTheme cae al default (dark) ante cualquier valor inválido, sin reventar", () => {
  assert.equal(resolveAdminTheme(null), DEFAULT_ADMIN_THEME)
  assert.equal(resolveAdminTheme(undefined), DEFAULT_ADMIN_THEME)
  assert.equal(resolveAdminTheme(""), DEFAULT_ADMIN_THEME)
  assert.equal(resolveAdminTheme("claro"), DEFAULT_ADMIN_THEME)
  assert.equal(resolveAdminTheme(42), DEFAULT_ADMIN_THEME)
})

test("DEFAULT_ADMIN_THEME es dark -- la migración a light es siempre opt-in", () => {
  assert.equal(DEFAULT_ADMIN_THEME, "dark")
})
