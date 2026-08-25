import assert from "node:assert/strict"
import test from "node:test"

import { getCreditNoteClaimPolicyError } from "./credit-note-claim-policy.ts"

const validClaim = {
  id: 10,
  order_id: 42,
  user_id: "customer-1",
  status: "aprobado",
  failure_type: "producto_defectuoso",
  resolution: "reintegro_parcial",
  affected_items: [{ order_item_id: 7, quantity: 1 }],
}

const baseInput = {
  operationType: "devolucion_parcial",
  actorRole: "admin",
  orderId: 42,
  orderUserId: "customer-1",
  claim: validClaim,
  selectedItems: [{ order_item_id: 7, quantity: 1 }],
}

test("un reclamo válido del mismo pedido/cliente y producto permite continuar", () => {
  assert.equal(getCreditNoteClaimPolicyError(baseInput), null)
})

test("sin claim, claim ajeno, no aprobado o de ayuda queda bloqueado", () => {
  assert.match(getCreditNoteClaimPolicyError({ ...baseInput, claim: null }) ?? "", /requiere/)
  assert.match(
    getCreditNoteClaimPolicyError({
      ...baseInput,
      claim: { ...validClaim, order_id: 99 },
    }) ?? "",
    /pedido/,
  )
  assert.match(
    getCreditNoteClaimPolicyError({
      ...baseInput,
      claim: { ...validClaim, status: "rechazado" },
    }) ?? "",
    /no está habilitado/,
  )
  assert.match(
    getCreditNoteClaimPolicyError({
      ...baseInput,
      claim: { ...validClaim, status: "cerrado" },
    }) ?? "",
    /no está habilitado/,
  )
  assert.match(
    getCreditNoteClaimPolicyError({
      ...baseInput,
      claim: { ...validClaim, status: "en_revision" },
    }) ?? "",
    /no está habilitado/,
  )
  assert.match(
    getCreditNoteClaimPolicyError({
      ...baseInput,
      claim: { ...validClaim, failure_type: "consulta_pedido" },
    }) ?? "",
    /no está habilitado/,
  )
})

test("un item o cantidad no reclamados quedan bloqueados", () => {
  assert.match(
    getCreditNoteClaimPolicyError({
      ...baseInput,
      selectedItems: [{ order_item_id: 8, quantity: 1 }],
    }) ?? "",
    /no forma parte/,
  )
  assert.match(
    getCreditNoteClaimPolicyError({
      ...baseInput,
      selectedItems: [{ order_item_id: 7, quantity: 2 }],
    }) ?? "",
    /no forma parte/,
  )
})

test("las operaciones administrativas exigen super_admin, cero items y ningún claim", () => {
  const administrative = {
    ...baseInput,
    operationType: "reembolso_excepcional",
    claim: null,
    selectedItems: [],
  }
  assert.match(getCreditNoteClaimPolicyError(administrative) ?? "", /superadministrador/)
  assert.equal(
    getCreditNoteClaimPolicyError({ ...administrative, actorRole: "super_admin" }),
    null,
  )
  assert.match(
    getCreditNoteClaimPolicyError({
      ...administrative,
      actorRole: "super_admin",
      selectedItems: [{ order_item_id: 7, quantity: 1 }],
    }) ?? "",
    /no puede devolver productos/,
  )
})
