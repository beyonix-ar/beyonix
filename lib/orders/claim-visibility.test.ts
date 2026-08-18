import assert from "node:assert/strict"
import test from "node:test"

import {
  isClaimVisibleForMode,
  shouldShowReturnInventoryPanel,
} from "./claim-visibility.ts"

test("mode=all incluye mensajes de ayuda y reclamos formales", () => {
  assert.equal(isClaimVisibleForMode("consulta_pedido", "all"), true)
  assert.equal(isClaimVisibleForMode("producto_defectuoso", "all"), true)
})

test("mode=all EXCLUYE cancelar_compra (tiene su propio flujo/pestaña)", () => {
  assert.equal(isClaimVisibleForMode("cancelar_compra", "all"), false)
})

test("mode=messaging solo incluye consulta_pedido", () => {
  assert.equal(isClaimVisibleForMode("consulta_pedido", "messaging"), true)
  assert.equal(isClaimVisibleForMode("producto_defectuoso", "messaging"), false)
  assert.equal(isClaimVisibleForMode("cancelar_compra", "messaging"), false)
})

test("mode=claims excluye consulta_pedido y cancelar_compra", () => {
  assert.equal(isClaimVisibleForMode("producto_defectuoso", "claims"), true)
  assert.equal(isClaimVisibleForMode("consulta_pedido", "claims"), false)
  assert.equal(isClaimVisibleForMode("cancelar_compra", "claims"), false)
})

test("ReturnInventoryPanel no se muestra para mensajes de ayuda", () => {
  assert.equal(shouldShowReturnInventoryPanel("consulta_pedido"), false)
})

test("ReturnInventoryPanel no se muestra para cancelaciones", () => {
  assert.equal(shouldShowReturnInventoryPanel("cancelar_compra"), false)
})

test("ReturnInventoryPanel se muestra para un reclamo formal real", () => {
  assert.equal(shouldShowReturnInventoryPanel("producto_defectuoso"), true)
  assert.equal(shouldShowReturnInventoryPanel("producto_incorrecto"), true)
})
