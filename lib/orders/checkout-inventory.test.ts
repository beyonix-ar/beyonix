import assert from "node:assert/strict"
import test from "node:test"

import { validateCheckoutInventory } from "./checkout-inventory.ts"

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

test("nunca reenvía reservationSessionId como p_session_id al RPC (no depende de una reserva previa)", async () => {
  const { admin, calls } = createFakeAdmin(() => ({ error: null }))

  await validateCheckoutInventory(
    admin,
    [{ productId: 1, quantity: 6, variantId: 21 }],
    "cart-session-con-una-reserva-inexistente",
    999,
  )

  assert.equal(calls.length, 1)
  const args = calls[0].args as { p_session_id: unknown; p_order_id: unknown }
  assert.equal(args.p_session_id, null)
  assert.equal(args.p_order_id, 999)
})

test("sin reservationSessionId también manda p_session_id null", async () => {
  const { admin, calls } = createFakeAdmin(() => ({ error: null }))

  await validateCheckoutInventory(
    admin,
    [{ productId: 1, quantity: 1 }],
    null,
    1,
  )

  const args = calls[0].args as { p_session_id: unknown }
  assert.equal(args.p_session_id, null)
})

test("un error CHECKOUT_STOCK_INSUFFICIENT del RPC se traduce al mensaje genérico existente", async () => {
  const { admin } = createFakeAdmin(() => ({
    error: { message: "CHECKOUT_STOCK_INSUFFICIENT" },
  }))

  await assert.rejects(
    () => validateCheckoutInventory(admin, [{ productId: 1, quantity: 6 }], null, 1),
    (error) => {
      assert.ok(error instanceof Error)
      assert.equal(error.message, "La disponibilidad del producto cambió desde que comenzaste la compra. Revisá tu carrito antes de continuar.")
      return true
    },
  )
})
