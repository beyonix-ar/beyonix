import assert from "node:assert/strict"
import test from "node:test"

import {
  MissingReservationSessionError,
  normalizeReservationSessionId,
  validateCheckoutInventory,
} from "./checkout-inventory.ts"

function createFakeAdmin(rpcImpl: (fn: string, args: unknown) => { error: { message: string } | null }) {
  const calls: Array<{ fn: string; args: unknown }> = []

  return {
    calls,
    admin: {
      rpc: async (fn: string, args: unknown) => {
        calls.push({ fn, args })
        return rpcImpl(fn, args)
      },
    } as unknown as Parameters<typeof validateCheckoutInventory>[0],
  }
}

const SESSION = "cart-session-4f1c9a2e-checkout"

test("reenvía la sesión del carrito como p_session_id para que el RPC cree la reserva", async () => {
  const { admin, calls } = createFakeAdmin(() => ({ error: null }))

  await validateCheckoutInventory(
    admin,
    [{ productId: 1, quantity: 6, variantId: 21 }],
    SESSION,
    999,
  )

  assert.equal(calls.length, 1)
  const args = calls[0].args as { p_session_id: unknown; p_order_id: unknown }
  assert.equal(args.p_session_id, SESSION)
  assert.equal(args.p_order_id, 999)
})

test("sin sesión de carrito no se valida inventario: no existe camino sin reserva", async () => {
  const { admin, calls } = createFakeAdmin(() => ({ error: null }))

  await assert.rejects(
    () => validateCheckoutInventory(admin, [{ productId: 1, quantity: 1 }], null, 1),
    (error) => {
      assert.ok(error instanceof MissingReservationSessionError)
      return true
    },
  )

  assert.equal(calls.length, 0)
})

test("una sesión demasiado corta se rechaza igual que una ausente", async () => {
  const { admin } = createFakeAdmin(() => ({ error: null }))

  await assert.rejects(
    () => validateCheckoutInventory(admin, [{ productId: 1, quantity: 1 }], "corta", 1),
    (error) => error instanceof MissingReservationSessionError,
  )
})

test("normalizeReservationSessionId acepta identificadores válidos y descarta el resto", () => {
  assert.equal(normalizeReservationSessionId(`  ${SESSION}  `), SESSION)
  assert.equal(normalizeReservationSessionId("1234567"), null)
  assert.equal(normalizeReservationSessionId("x".repeat(161)), null)
  assert.equal(normalizeReservationSessionId(undefined), null)
  assert.equal(normalizeReservationSessionId(42), null)
})

test("un error CHECKOUT_STOCK_INSUFFICIENT del RPC se traduce al mensaje genérico existente", async () => {
  const { admin } = createFakeAdmin(() => ({
    error: { message: "CHECKOUT_STOCK_INSUFFICIENT" },
  }))

  await assert.rejects(
    () => validateCheckoutInventory(admin, [{ productId: 1, quantity: 6 }], SESSION, 1),
    (error) => {
      assert.ok(error instanceof Error)
      assert.equal(error.message, "La disponibilidad del producto cambió desde que comenzaste la compra. Revisá tu carrito antes de continuar.")
      return true
    },
  )
})

test("un RESERVATION_SESSION_MISMATCH del RPC nunca se muestra tal cual al cliente", async () => {
  const { admin } = createFakeAdmin(() => ({
    error: { message: "RESERVATION_SESSION_MISMATCH" },
  }))

  await assert.rejects(
    () => validateCheckoutInventory(admin, [{ productId: 1, quantity: 1 }], SESSION, 1),
    (error) => {
      assert.ok(error instanceof Error)
      // El motivo técnico (secuestro de sesión) nunca llega al cliente --
      // mismo mensaje genérico que cualquier otro conflicto de stock.
      assert.equal(
        error.message,
        "La disponibilidad del producto cambió desde que comenzaste la compra. Revisá tu carrito antes de continuar.",
      )
      assert.doesNotMatch(error.message, /session_mismatch/i)
      return true
    },
  )
})
