import assert from "node:assert/strict"
import test from "node:test"

import {
  CheckoutReservationExpiredError,
  commitCheckoutStepReservation,
  normalizeReservationSessionId,
} from "./checkout-inventory.ts"

type RpcResult = { data?: unknown; error: { message: string } | null }

function createFakeAdmin(rpcImpl: (fn: string, args: unknown) => RpcResult) {
  const calls: Array<{ fn: string; args: unknown }> = []

  return {
    calls,
    admin: {
      rpc: async (fn: string, args: unknown) => {
        calls.push({ fn, args })
        return rpcImpl(fn, args)
      },
    } as unknown as Parameters<typeof commitCheckoutStepReservation>[0],
  }
}

const SESSION = "cart-session-4f1c9a2e-checkout"
const EXPIRES_AT = "2026-09-26T13:20:00.000Z"
const STOCK_CHANGED =
  "La disponibilidad del producto cambió desde que comenzaste la compra. Revisá tu carrito antes de continuar."

test("todos los medios comprometen la reserva del Paso 3 y devuelven su expiresAt original", async () => {
  for (const [commitment, rpc] of [
    ["transferencia", "commit_checkout_step_reservation"],
    ["customer_credit", "commit_checkout_step_reservation"],
    ["mercadopago", "commit_mercadopago_checkout_reservation"],
  ] as const) {
    const { admin, calls } = createFakeAdmin(() => ({ data: EXPIRES_AT, error: null }))
    const expiresAt = await commitCheckoutStepReservation(
      admin,
      [{ productId: 1, quantity: 2, variantId: 21 }],
      SESSION,
      999,
      commitment,
    )
    assert.equal(expiresAt, EXPIRES_AT)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].fn, rpc)
    const args = calls[0].args as { p_session_id: unknown; p_order_id: unknown; p_items: unknown }
    assert.equal(args.p_session_id, SESSION)
    assert.equal(args.p_order_id, 999)
    assert.deepEqual(args.p_items, [{ product_id: 1, variant_id: 21, conditioned_stock_id: null, quantity: 2 }])
  }
})

test("sin sesión (o demasiado corta) no hay reserva que comprometer: vencida, sin llamar a la base", async () => {
  for (const session of [null, "corta"]) {
    const { admin, calls } = createFakeAdmin(() => ({ data: EXPIRES_AT, error: null }))
    await assert.rejects(
      () => commitCheckoutStepReservation(admin, [{ productId: 1, quantity: 1 }], session, 1, "customer_credit"),
      (error) => error instanceof CheckoutReservationExpiredError,
    )
    assert.equal(calls.length, 0)
  }
})

test("reserva vencida, ajena o inválida -> RESERVATION_EXPIRED para el cliente", async () => {
  // INVALID_SESSION incluye la sesión atada a OTRO usuario: el cliente nunca
  // ve el motivo técnico.
  for (const code of ["RESERVATION_EXPIRED", "RESERVATION_INVALID", "INVALID_SESSION", "RESERVATION_LOCKED_TO_ORDER"]) {
    const { admin } = createFakeAdmin(() => ({ error: { message: code } }))
    await assert.rejects(
      () => commitCheckoutStepReservation(admin, [{ productId: 1, quantity: 1 }], SESSION, 1, "transferencia"),
      (error) => error instanceof CheckoutReservationExpiredError,
      code,
    )
  }
})

test("normalizeReservationSessionId acepta identificadores válidos y descarta el resto", () => {
  assert.equal(normalizeReservationSessionId(`  ${SESSION}  `), SESSION)
  assert.equal(normalizeReservationSessionId("1234567"), null)
  assert.equal(normalizeReservationSessionId("x".repeat(161)), null)
  assert.equal(normalizeReservationSessionId(undefined), null)
  assert.equal(normalizeReservationSessionId(42), null)
})

test("un conflicto de stock del RPC se traduce al mensaje genérico existente (nunca el motivo técnico)", async () => {
  for (const message of ["CHECKOUT_STOCK_INSUFFICIENT", "CHECKOUT_VARIANT_REQUIRED"]) {
    const { admin } = createFakeAdmin(() => ({ error: { message } }))
    await assert.rejects(
      () => commitCheckoutStepReservation(admin, [{ productId: 1, quantity: 1 }], SESSION, 1, "transferencia"),
      (error) => {
        assert.ok(error instanceof Error)
        assert.equal(error.message, STOCK_CHANGED)
        return true
      },
    )
  }
})

test("si la migración todavía no está aplicada se informa sin exponer el error técnico", async () => {
  const { admin } = createFakeAdmin(() => ({
    error: { message: "Could not find the function public.commit_checkout_step_reservation in the schema cache" },
  }))
  await assert.rejects(
    () => commitCheckoutStepReservation(admin, [{ productId: 1, quantity: 1 }], SESSION, 1, "customer_credit"),
    /migración pendiente/,
  )
})

test("un vencimiento inválido devuelto por la base nunca se usa como plazo", async () => {
  const { admin } = createFakeAdmin(() => ({ data: "no-es-fecha", error: null }))
  await assert.rejects(
    () => commitCheckoutStepReservation(admin, [{ productId: 1, quantity: 1 }], SESSION, 1, "transferencia"),
    /vencimiento válido/,
  )
})
