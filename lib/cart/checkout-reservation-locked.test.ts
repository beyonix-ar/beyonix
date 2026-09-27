import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"

import {
  CheckoutReservationExpiredError,
  CheckoutReservationLockedError,
  commitCheckoutStepReservation,
} from "../orders/checkout-inventory.ts"
import { CHECKOUT_RESERVATION_LOCKED_MESSAGE } from "./checkout-step-reservation.ts"

// Fase 6 (bug): al iniciar Mercado Pago la reserva del Paso 3 queda ligada a
// ese pedido. Si el cliente vuelve atrás (o otra pestaña pagó), la sesión
// quedaba "locked": el checkout mostraba "Tu reserva ya no está disponible",
// bloqueaba Pagar y Continuar para siempre sin rotar la sesión, y el backend
// respondía "Tu reserva venció" (falso: todavía no venció) redirigiendo al
// inicio. Ahora es un estado propio y recuperable.

const root = process.cwd()
const read = (path: string) => readFileSync(join(root, path), "utf8").replace(/\r\n/g, "\n")
const checkout = read("app/checkout/page.tsx")

const rpcFailing = (message: string) => ({
  rpc: async () => ({ data: null, error: { message } }),
})
const items = [{ productId: 1, quantity: 1 }]

test("backend: RESERVATION_LOCKED_TO_ORDER es un error propio, no un vencimiento", async () => {
  await assert.rejects(
    commitCheckoutStepReservation(rpcFailing("RESERVATION_LOCKED_TO_ORDER") as never, items, "checkout-session-abc", 7, "transferencia"),
    (error: unknown) => error instanceof CheckoutReservationLockedError && error.message === CHECKOUT_RESERVATION_LOCKED_MESSAGE,
  )
  // Sigue siendo un CheckoutReservationExpiredError: ningún camino existente la trata como válida.
  assert.ok(new CheckoutReservationLockedError() instanceof CheckoutReservationExpiredError)
  await assert.rejects(
    commitCheckoutStepReservation(rpcFailing("RESERVATION_EXPIRED") as never, items, "checkout-session-abc", 7, "customer_credit"),
    (error: unknown) => error instanceof CheckoutReservationExpiredError && !(error instanceof CheckoutReservationLockedError),
  )
})

test("rutas de pago: responden RESERVATION_LOCKED (409) antes del caso vencido", () => {
  for (const path of [
    "app/api/mercadopago/create-preference/route.ts",
    "app/api/transferencia/create-order/route.ts",
    "app/api/customer-credit/create-order/route.ts",
  ]) {
    const route = read(path)
    const locked = route.indexOf("if (error instanceof CheckoutReservationLockedError)")
    const expired = route.indexOf("if (error instanceof CheckoutReservationExpiredError)")
    assert.ok(locked > 0 && locked < expired, path)
    assert.match(route.slice(locked, expired), /code: "RESERVATION_LOCKED"[\s\S]*status: 409/)
  }
})

test("checkout: una sesión ligada a un pedido se libera sin prometer plazo ni redirigir, conservando el carrito", () => {
  const release = checkout.slice(
    checkout.indexOf("const releaseLockedCheckoutSession = useCallback"),
    checkout.indexOf("}, [startNewCheckoutSession])", checkout.indexOf("const releaseLockedCheckoutSession")),
  )
  assert.match(release, /sessionStorage\.removeItem\(CHECKOUT_STEP_RESERVATION_KEY\)/)
  assert.match(release, /startNewCheckoutSession\(\)/)
  assert.match(release, /setCurrentStep\(\(step\) => \(step === 3 \? 2 : step\)\)/)
  assert.match(release, /setCheckoutError\(CHECKOUT_RESERVATION_LOCKED_MESSAGE\)/)
  assert.doesNotMatch(release, /router\.replace|clearCart|setReservationExpired\(true\)/)

  // Todos los lugares que antes quedaban sin salida.
  assert.match(checkout, /\} else if \(snapshot\.status === "locked"\) \{\s*releaseLockedCheckoutSession\(\)/)
  assert.match(checkout, /snapshot\.status === "locked" && !submissionInFlightRef\.current/)
  assert.match(checkout, /if \(liveReservation\.status === "locked"\) \{\s*releaseLockedCheckoutSession\(\)/)
  assert.match(checkout, /result\.code === "RESERVATION_LOCKED_TO_ORDER"\) \{\s*releaseLockedCheckoutSession\(\)/)
  assert.match(checkout, /data\?\.code === "RESERVATION_LOCKED"\) \{\s*releaseLockedCheckoutSession\(\)/)
})
