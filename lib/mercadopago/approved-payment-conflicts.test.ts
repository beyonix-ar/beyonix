import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  isInventoryConfirmationConflict,
  MERCADOPAGO_STOCK_CONFLICT_PAYMENT_STATUS,
  MercadoPagoInventoryConflictError,
  processApprovedMercadoPagoOrderPayment,
} from "./order-payment.ts"

const APPROVED_PAYMENT = {
  status: "approved" as const,
  transaction_amount: 6000,
  currency_id: "ARS",
}

const PENDING_ORDER = {
  estado: "pendiente",
  total: 6000,
  external_amount_due: 6000,
  financial_status: "pending_payment",
}

test("isInventoryConfirmationConflict reconoce el rechazo del guardián de inventario", () => {
  assert.equal(
    isInventoryConfirmationConflict({ message: "CHECKOUT_STOCK_INSUFFICIENT" }),
    true,
  )
  assert.equal(
    isInventoryConfirmationConflict(new Error("checkout_variant_required")),
    true,
  )
  assert.equal(
    isInventoryConfirmationConflict(new Error("connection reset by peer")),
    false,
  )
  assert.equal(isInventoryConfirmationConflict(null), false)
})

test("un conflicto de inventario sale como error tipado y no como confirmación", async () => {
  await assert.rejects(
    () =>
      processApprovedMercadoPagoOrderPayment(PENDING_ORDER, APPROVED_PAYMENT, async () => {
        throw new MercadoPagoInventoryConflictError({
          message: "CHECKOUT_STOCK_INSUFFICIENT",
        })
      }),
    (error) => error instanceof MercadoPagoInventoryConflictError,
  )
})

test("la validación de monto y moneda sigue corriendo ANTES de tocar inventario", async () => {
  let confirmCalls = 0
  const wrongAmount = await processApprovedMercadoPagoOrderPayment(
    PENDING_ORDER,
    { ...APPROVED_PAYMENT, transaction_amount: 1 },
    async () => {
      confirmCalls += 1
      return true
    },
  )

  assert.equal(wrongAmount.kind, "amount_mismatch")
  assert.equal(confirmCalls, 0)
})

const WEBHOOK = readFileSync("app/api/mercadopago/webhook/route.ts", "utf8")

test("el webhook marca el pago aprobado que no se pudo confirmar en vez de reintentar para siempre", () => {
  assert.match(WEBHOOK, /MercadoPagoInventoryConflictError/)
  assert.match(WEBHOOK, /payment_status: MERCADOPAGO_STOCK_CONFLICT_PAYMENT_STATUS/)
  assert.match(WEBHOOK, /action: "payment_approved_stock_conflict"/)
  // Devuelve 200: un 500 sólo haría que Mercado Pago reintente algo que no
  // puede confirmarse nunca. El dinero queda registrado y marcado.
  assert.match(WEBHOOK, /reason: "stock_conflict"/)
})

test("el webhook NO confirma la orden cuando hay conflicto de inventario", () => {
  const conflictHandlerIndex = WEBHOOK.indexOf(
    "payment_status: MERCADOPAGO_STOCK_CONFLICT_PAYMENT_STATUS",
  )
  const confirmedIndex = WEBHOOK.indexOf('financial_status: "payment_confirmed"')

  assert.ok(conflictHandlerIndex > 0)
  assert.ok(confirmedIndex > 0)
  // El estado de conflicto se escribe en un update propio, no dentro del
  // update que confirma el pago.
  assert.ok(conflictHandlerIndex > confirmedIndex)
})

const VISIBILITY_MIGRATION = readFileSync(
  "supabase/migrations/20260903160000_admin_visibility_for_approved_payment_conflicts.sql",
  "utf8",
)

test("un pago cobrado que quedó trabado se hace visible en Admin para resolución manual", () => {
  assert.match(VISIBILITY_MIGRATION, /'approved_amount_mismatch'/)
  assert.match(VISIBILITY_MIGRATION, /'approved_currency_mismatch'/)
  assert.match(
    VISIBILITY_MIGRATION,
    new RegExp(`'${MERCADOPAGO_STOCK_CONFLICT_PAYMENT_STATUS}'`),
  )
  // Sólo con payment_id: un intento sin pago real sigue fuera del panel.
  assert.match(VISIBILITY_MIGRATION, /and new\.payment_id is not null/)
  // No se relaja la rama de confirmación existente.
  assert.match(VISIBILITY_MIGRATION, /new\.payment_confirmed_at is not null/)
})
