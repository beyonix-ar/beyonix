import assert from "node:assert/strict"
import test from "node:test"

import { getSafeRedirect } from "./safe-redirect.ts"

test("ruta interna normal: se preserva tal cual", () => {
  assert.equal(getSafeRedirect("/cuenta"), "/cuenta")
  assert.equal(getSafeRedirect("/checkout?paso=2"), "/checkout?paso=2")
})

test("null o vacío: cae al Home", () => {
  assert.equal(getSafeRedirect(null), "/")
})

test("apuntar de vuelta a /login: cae al Home (evita loop)", () => {
  assert.equal(getSafeRedirect("/login"), "/")
  assert.equal(getSafeRedirect("/login?redirect=/cuenta"), "/")
})

test("URL absoluta con esquema: se descarta, cae al Home", () => {
  assert.equal(getSafeRedirect("https://evil.example.com"), "/")
  assert.equal(getSafeRedirect("http://evil.example.com/cuenta"), "/")
})

test("open redirect protocol-relative (//host): se descarta -- el navegador lo resuelve como URL externa", () => {
  assert.equal(getSafeRedirect("//evil.example.com"), "/")
  assert.equal(getSafeRedirect("//evil.example.com/cuenta"), "/")
})

test("open redirect con barra invertida (/\\host): se descarta -- algunos navegadores lo normalizan a //host", () => {
  assert.equal(getSafeRedirect("/\\evil.example.com"), "/")
})

test("triple barra (///host): se descarta por el mismo motivo que //host", () => {
  assert.equal(getSafeRedirect("///evil.example.com"), "/")
})
