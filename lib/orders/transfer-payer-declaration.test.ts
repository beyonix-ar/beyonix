import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  decideTransferPayerDeclaration,
  getTransferAmountDue,
} from "./transfer-payer-declaration.ts"

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")
const awaitingOrder = {
  estado: "pendiente",
  payment_method_id: "transferencia",
  payment_status: "pendiente_comprobante",
  payment_proof_url: null,
  payment_proof_uploaded_at: null,
  transfer_verification_status: "pending",
  external_amount_due: 41_400,
  total: 45_000,
}
const holder = { nombre: "  Ñandú  José ", apellido: "Pérez Müller", dni: "30.111.222" }

test("A2: valida titular con nombres en español y fija el monto calculado por el servidor (no el del cliente)", () => {
  const decision = decideTransferPayerDeclaration(awaitingOrder, { ...holder, monto: 1 } as never)
  assert.equal(decision.ok, true)
  if (!decision.ok) return
  assert.equal(decision.value.firstName, "Ñandú José")
  assert.equal(decision.value.lastName, "Pérez Müller")
  assert.equal(decision.value.document, "30111222")
  assert.equal(decision.value.amount, 41_400, "saldo a favor ya descontado: external_amount_due")
  assert.equal(getTransferAmountDue({ external_amount_due: null, total: 45_000 }), 45_000)
  assert.equal(getTransferAmountDue({ external_amount_due: 0, total: 45_000 }), null)
})

test("A2: sin nombre, apellido o documento válido no hay datos bancarios", () => {
  const decision = decideTransferPayerDeclaration(awaitingOrder, { nombre: "", apellido: "Pérez", dni: "123" })
  assert.equal(decision.ok, false)
  if (decision.ok || decision.reason !== "invalid_fields") throw new Error("se esperaba invalid_fields")
  assert.ok(decision.errors.firstName)
  assert.ok(decision.errors.document)
  assert.equal(decision.errors.amount, undefined, "el monto nunca lo corrige el cliente")
})

test("A2: no se pisan los datos de un pedido con pago en curso, informado o resuelto", () => {
  const cases = [
    [{ transfer_verification_status: "checking" }, "checking"],
    [{ payment_proof_url: "proofs/1.pdf" }, "not_editable"],
    [{ payment_status: "en_revision" }, "not_editable"],
    [{ payment_status: "auto_verified_stock_conflict" }, "not_editable"],
    [{ estado: "cancelado" }, "not_editable"],
    [{ payment_method_id: "mercadopago" }, "not_transfer"],
    [{ external_amount_due: 0, total: 0 }, "invalid_amount"],
  ] as const
  for (const [overrides, reason] of cases) {
    const decision = decideTransferPayerDeclaration({ ...awaitingOrder, ...overrides }, holder)
    assert.equal(decision.ok, false, JSON.stringify(overrides))
    if (!decision.ok) assert.equal(decision.reason, reason, JSON.stringify(overrides))
  }
})

test("A2: alias/CVU sólo salen del servidor después de validar y guardar al titular, con la reserva vigente", () => {
  const route = read("../../app/api/transferencia/[orderId]/titular/route.ts")
  const reservation = route.indexOf("isTransferReservationActive(await loadTransferReservationDeadline(admin, pedidoId))")
  const decision = route.indexOf("decideTransferPayerDeclaration(order,")
  const update = route.indexOf(".update({")
  const bank = route.indexOf("bankTransfer: getTransferBankDetails()")
  assert.ok(reservation > 0 && reservation < decision && decision < update && update < bank)
  assert.match(route, /if \(!saved\) \{/)
  assert.match(route, /\.eq\("payment_status", "pendiente_comprobante"\)/)
  assert.match(route, /transfer_verification_status\.neq\.checking/)

  const proofs = read("../../app/api/payment-proofs/[orderId]/route.ts")
  assert.match(proofs, /currentOrder\.transfer_payer_dni &&\s*isAwaitingTransferPayment\(currentOrder\) &&\s*isTransferReservationActive\(reservation\.expiresAt\)/)

  const flow = read("../../components/checkout/transfer-flow.tsx")
  assert.doesNotMatch(flow, /TRANSFER_ALIAS|TRANSFER_CVU|TRANSFER_ACCOUNT_HOLDER/, "el cliente no trae alias/CVU en su bundle")
  assert.match(flow, /: bankTransfer\s*\? "instructions"\s*: "holder"/, "sin datos del titular guardados, el primer paso es el titular")
  assert.match(flow, /fetch\(`\/api\/transferencia\/\$\{order\.id\}\/titular`/)
})
