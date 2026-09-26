import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  formatReservationCountdown,
  reservationSecondsLeft,
} from "../cart/checkout-step-reservation.ts"
import { isTransferReservationActive } from "./transfer-reservation-window.ts"
import {
  canUploadTransferProof,
  isAwaitingTransferPayment,
  TRANSFER_STOCK_CONFLICT_CUSTOMER_MESSAGE,
  TRANSFER_STOCK_CONFLICT_PAYMENT_STATUS,
} from "./transfer-verification-reasons.ts"

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")
const at = (time: string) => new Date(`2026-09-26T${time}:00.000-03:00`)
const RESERVED_UNTIL = at("10:20").toISOString()

test("1. reserva creada a las 10:00: la transferencia usa el vencimiento de las 10:20", () => {
  assert.equal(isTransferReservationActive(RESERVED_UNTIL, at("10:00")), true)
  assert.equal(
    formatReservationCountdown(reservationSecondsLeft(RESERVED_UNTIL, at("10:00").toISOString(), 0, 0)),
    "20:00",
  )
})

test("2. elegir transferencia a las 10:15 no renueva hasta las 10:35: quedan ~5 minutos", () => {
  const seconds = reservationSecondsLeft(RESERVED_UNTIL, at("10:15").toISOString(), 0, 0)
  assert.equal(formatReservationCountdown(seconds), "05:00")
  assert.equal(isTransferReservationActive(RESERVED_UNTIL, at("10:34")), false)
})

test("3. refresh / volver a la pestaña: el contador se deriva del mismo expiresAt y del reloj del servidor", () => {
  // Refresh a las 10:05: nuevo serverNow, mismo expiresAt -> 15:00.
  assert.equal(
    formatReservationCountdown(reservationSecondsLeft(RESERVED_UNTIL, at("10:05").toISOString(), 0, 0)),
    "15:00",
  )
  // Pestaña en segundo plano 60 s: se descuenta con performance.now(), no con un timer local.
  assert.equal(
    reservationSecondsLeft(RESERVED_UNTIL, at("10:05").toISOString(), 1_000, 61_000),
    14 * 60,
  )
  // Reloj del dispositivo adelantado: no influye (sólo serverNow + delta monótono).
  assert.equal(reservationSecondsLeft(RESERVED_UNTIL, at("10:19").toISOString(), 0, 0), 60)
})

test("5-7. ventana comercial: minuto 11 y 19 vigentes; minuto 20+ o sin reserva, vencida", () => {
  assert.equal(isTransferReservationActive(RESERVED_UNTIL, at("10:11")), true)
  assert.equal(isTransferReservationActive(RESERVED_UNTIL, new Date(at("10:20").getTime() - 1000)), true)
  assert.equal(isTransferReservationActive(RESERVED_UNTIL, at("10:20")), false)
  assert.equal(isTransferReservationActive(RESERVED_UNTIL, at("10:25")), false)
  assert.equal(isTransferReservationActive(null, at("10:05")), false, "pedido sin reserva: fail-closed")
  assert.equal(isTransferReservationActive("no-es-fecha", at("10:05")), false)
})

test("sólo el flujo normal (esperando la transferencia) depende de la reserva", () => {
  assert.equal(isAwaitingTransferPayment({ payment_status: "pendiente_comprobante" }), true)
  assert.equal(isAwaitingTransferPayment({ payment_status: null }), true)
  assert.equal(isAwaitingTransferPayment({ payment_status: "pendiente_comprobante", payment_proof_url: "p.pdf" }), false)
  assert.equal(isAwaitingTransferPayment({ payment_status: "en_revision" }), false)
  assert.equal(isAwaitingTransferPayment({ payment_status: TRANSFER_STOCK_CONFLICT_PAYMENT_STATUS }), false)
  assert.equal(isAwaitingTransferPayment({ payment_status: "confirmado" }), false)
})

test("pago tardío sin stock: respuesta controlada, nunca 'pago rechazado'", () => {
  assert.match(TRANSFER_STOCK_CONFLICT_CUSTOMER_MESSAGE, /^Recibimos tu transferencia/)
  assert.match(TRANSFER_STOCK_CONFLICT_CUSTOMER_MESSAGE, /Nuestro equipo revisará el pago\.$/)
  assert.doesNotMatch(TRANSFER_STOCK_CONFLICT_CUSTOMER_MESSAGE, /rechaz/i)
  assert.equal(canUploadTransferProof(TRANSFER_STOCK_CONFLICT_PAYMENT_STATUS), true)
})

test("10. el endpoint de verificación rechaza server-side el flujo normal vencido antes de reclamar un intento", () => {
  const route = read("../../app/api/transferencia/[orderId]/verificar/route.ts")
  const deadline = route.indexOf("await loadTransferReservationDeadline(admin, pedidoId)")
  assert.ok(deadline > 0)
  assert.ok(deadline < route.indexOf("await attemptTransferAutoVerification("), "nunca persiste datos ni reclama lease vencido")
  const rejection = route.slice(deadline, route.indexOf("await attemptTransferAutoVerification("))
  assert.match(rejection, /if \(!isTransferReservationActive\(reservationExpiresAt\)\)/)
  assert.match(rejection, /code: "RESERVATION_EXPIRED"/)
  assert.match(rejection, /retryable: false/)
  assert.match(rejection, /status: 409/)
  assert.match(route, /result\.reason === "stock_conflict"[\s\S]*?TRANSFER_STOCK_CONFLICT_CUSTOMER_MESSAGE/)
})

test("create-order compromete la reserva del Paso 3 sin renovarla ni usar el validador heredado de 30 minutos", () => {
  const route = read("../../app/api/transferencia/create-order/route.ts")
  assert.match(route, /reservationCommitment: "transferencia"/)
  assert.match(route, /if \(!reservationExpiresAt\) throw new CheckoutReservationExpiredError\(\)/)
  assert.match(route, /error instanceof CheckoutReservationExpiredError[\s\S]*?code: "RESERVATION_EXPIRED"/)
  assert.doesNotMatch(route, /validateCheckoutInventory/)
  const inventory = read("./checkout-inventory.ts")
  assert.match(inventory, /transferencia: "commit_checkout_step_reservation"/)
  assert.match(inventory, /customer_credit: "commit_checkout_step_reservation"/)
  const credit = read("../../app/api/customer-credit/create-order/route.ts")
  assert.match(credit, /reservationCommitment: "customer_credit"/)
  assert.match(credit, /error instanceof CheckoutReservationExpiredError[\s\S]*?code: "RESERVATION_EXPIRED"/)
  // El saldo sólo se debita DESPUÉS de comprometer la reserva vigente.
  assert.ok(credit.indexOf('reservationCommitment: "customer_credit"') < credit.indexOf("await applyCustomerCreditToOrder("))
})

test("el pedido expone al cliente el expiresAt real y la hora del servidor (leerlo no renueva)", () => {
  const route = read("../../app/api/payment-proofs/[orderId]/route.ts")
  assert.match(route, /expiresAt: await loadTransferReservationDeadline\(admin, pedidoId\)/)
  assert.match(route, /serverNow: new Date\(\)\.toISOString\(\)/)
  assert.doesNotMatch(route, /reserve_cart_stock|commit_transfer_checkout_reservation/)
})

test("9, 22. la pantalla usa el reloj del servidor, bloquea al llegar a 00:00 y redirige al inicio", () => {
  const flow = read("../../components/checkout/transfer-flow.tsx")
  assert.match(flow, /reservationSecondsLeft\(reservation\.expiresAt, reservation\.serverNow, reservation\.receivedAt, now\)/)
  assert.doesNotMatch(flow, /20 \* 60|1200/, "sin un timer local de 20 minutos propio")
  assert.match(flow, /Tus productos están reservados durante este tiempo\./)
  assert.match(flow, /Realizá la transferencia antes de que finalice el contador\./)
  assert.match(flow, /if \(awaitingPayment && \(rejectedAsExpired \|\| reservationSeconds === 0\)\) \{\s*return <TransferReservationExpired homeHref=\{homeHref\} \/>/)
  assert.match(flow, /Pasaron los 20 minutos disponibles para completar la compra y liberamos los productos reservados\./)
  assert.match(flow, /router\.replace\(homeHref\)/)
  // Pestaña vieja: el servidor responde RESERVATION_EXPIRED y la pantalla se bloquea.
  assert.match(flow, /if \(data\.code === "RESERVATION_EXPIRED"\) \{\s*onReservationExpired\(\)/)
  const page = read("../../app/checkout/success/page.tsx")
  assert.match(page, /homeHref="\/"/)
})

test("21. el carrito se conserva: no se vacía al crear el pedido ni mientras el pago no esté confirmado", () => {
  const checkout = read("../../app/checkout/page.tsx")
  const transferBranch = checkout.slice(
    checkout.indexOf('if (selectedPayment === "transferencia") {'),
    checkout.indexOf("if (!response.ok || !data.init_point)"),
  )
  assert.doesNotMatch(transferBranch, /clearCart\(\)/)
  assert.match(transferBranch, /startNewCheckoutSession\(\)/)
  const success = read("../../app/checkout/success/page.tsx")
  assert.match(success, /const shouldClearCart =\s*!isTransfer \|\|\s*paymentConfirmed \|\|/)
  assert.match(success, /if \(!shouldClearCart \|\| hasClearedCartRef\.current\) return/)
})
