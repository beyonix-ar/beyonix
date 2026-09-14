import assert from "node:assert/strict"
import test from "node:test"

import {
  getAllowedAdminTransferPaymentStatuses,
  getTransferPaymentTransitionError,
} from "./transfer-payment-status.ts"
import { TRANSFER_STOCK_CONFLICT_PAYMENT_STATUS } from "./transfer-verification-reasons.ts"

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

test("auto_verified_stock_conflict: un admin puede confirmar o rechazar directamente, sin depender de comprobante (la plata ya está identificada contra Mercado Pago)", () => {
  assert.equal(
    getTransferPaymentTransitionError({
      currentStatus: TRANSFER_STOCK_CONFLICT_PAYMENT_STATUS,
      nextStatus: "confirmado",
      hasProof: false,
    }),
    null,
  )
  assert.equal(
    getTransferPaymentTransitionError({
      currentStatus: TRANSFER_STOCK_CONFLICT_PAYMENT_STATUS,
      nextStatus: "rechazado",
      hasProof: false,
      observation: "Sin stock disponible para reponer.",
    }),
    null,
  )
  assert.deepEqual(
    getAllowedAdminTransferPaymentStatuses(TRANSFER_STOCK_CONFLICT_PAYMENT_STATUS, false),
    ["confirmado", "rechazado"],
  )
})

test("auto_verified_stock_conflict: rechazar sigue exigiendo motivo, igual que el resto de los rechazos", () => {
  assert.match(
    getTransferPaymentTransitionError({
      currentStatus: TRANSFER_STOCK_CONFLICT_PAYMENT_STATUS,
      nextStatus: "rechazado",
      hasProof: false,
      observation: "",
    }) ?? "",
    /motivo/,
  )
})

test("auto_verified_stock_conflict: nunca puede saltar directo a en_revision ni a pendiente_comprobante", () => {
  assert.match(
    getTransferPaymentTransitionError({
      currentStatus: TRANSFER_STOCK_CONFLICT_PAYMENT_STATUS,
      nextStatus: "en_revision",
      hasProof: false,
    }) ?? "",
    /sólo puede confirmarse o rechazarse/,
  )
})
