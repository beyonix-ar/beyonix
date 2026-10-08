import assert from "node:assert/strict"
import test from "node:test"

import { safeErrorMetadata } from "./safe-error.ts"

test("los logs de errores no exponen mensajes ni credenciales", () => {
  const error = Object.assign(new Error("Authorization: Bearer secreto; SQL select *"), {
    code: "PROVIDER_TIMEOUT",
    access_token: "secreto",
  })
  assert.deepEqual(safeErrorMetadata(error), {
    name: "Error",
    code: "PROVIDER_TIMEOUT",
  })
  assert.doesNotMatch(JSON.stringify(safeErrorMetadata(error)), /secreto|Bearer|select/i)
})

test("códigos no confiables se descartan", () => {
  assert.deepEqual(safeErrorMetadata({ code: "token=secreto&x=1" }), {
    name: "UnknownError",
  })
  assert.deepEqual(safeErrorMetadata({ code: "a".repeat(41) }), { name: "UnknownError" })
  assert.deepEqual(safeErrorMetadata({ code: 23505 }), { name: "UnknownError" })
  assert.deepEqual(safeErrorMetadata({ code: "PGRST116" }), { name: "UnknownError", code: "PGRST116" })
})
