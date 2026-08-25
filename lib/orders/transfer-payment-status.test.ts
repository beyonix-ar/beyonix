import assert from "node:assert/strict"
import test from "node:test"

import {
  getAllowedAdminTransferPaymentStatuses,
  getTransferPaymentTransitionError,
} from "./transfer-payment-status.ts"

test("un comprobante en revisión puede ser confirmado por el admin", () => {
  assert.equal(
    getTransferPaymentTransitionError({
      currentStatus: "en_revision",
      nextStatus: "confirmado",
      hasProof: true,
    }),
    null,
  )
})

test("subir comprobante no habilita confirmar desde un estado distinto de en_revision", () => {
  assert.match(
    getTransferPaymentTransitionError({
      currentStatus: "pendiente_comprobante",
      nextStatus: "confirmado",
      hasProof: true,
    }) ?? "",
    /en revisión/,
  )
})

test("rechazar exige comprobante en revisión y motivo", () => {
  assert.match(
    getTransferPaymentTransitionError({
      currentStatus: "en_revision",
      nextStatus: "rechazado",
      hasProof: true,
      observation: "",
    }) ?? "",
    /motivo/,
  )
  assert.equal(
    getTransferPaymentTransitionError({
      currentStatus: "en_revision",
      nextStatus: "rechazado",
      hasProof: true,
      observation: "El importe no coincide.",
    }),
    null,
  )
})

test("confirmado es terminal para la ruta administrativa", () => {
  assert.match(
    getTransferPaymentTransitionError({
      currentStatus: "confirmado",
      nextStatus: "rechazado",
      hasProof: true,
      observation: "Revisión tardía",
    }) ?? "",
    /no puede volver/,
  )
  assert.deepEqual(
    getAllowedAdminTransferPaymentStatuses("confirmado", true),
    ["confirmado"],
  )
})
