import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  formatReservationCountdown,
  reservationItemsFromCart,
  reservationMatchesCart,
  reservationSecondsLeft,
} from "./checkout-step-reservation.ts"
import { MAX_CART_ITEM_QUANTITY } from "./stock-status.ts"

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")
const checkout = read("../../app/checkout/page.tsx")
const cart = read("../../context/cart-context.tsx")
const reservation = read("./stock-reservations.ts")
const modal = read("../../components/checkout/insufficient-stock-modal.tsx")

function section(start: string, end: string) {
  const from = checkout.indexOf(start)
  const to = checkout.indexOf(end, from)
  assert.ok(from >= 0 && to > from, `sección no encontrada: ${start}`)
  return checkout.slice(from, to)
}

test("1-2. pasos 1 y 2 no reservan al montarse ni al ingresar; sólo al continuar desde 2", () => {
  const next = section("const goToNextStep =", "const canSubmitCheckout =")
  assert.match(next, /currentStep === 2[\s\S]*reserveCheckoutItems\(cartReservationItems, \(\) => setCurrentStep\(3\)\)/)
  assert.match(next, /setCurrentStep\(2\)/)
  assert.doesNotMatch(section("useEffect(() => {\n    setMounted(true)", "const expireStockReservation"), /reserveCartStock/)
})

test("3 y 15. sólo una reserva exitosa ejecuta la transición al paso 3; una falla de API no la ejecuta", () => {
  const action = section("const reserveCheckoutItems =", "const changeCheckoutCartItem =")
  assert.match(action, /if \(!result\.success\) \{[\s\S]*?return\s*\}/)
  assert.match(action, /onSuccess\(\)/)
  assert.match(action, /catch \{[\s\S]*No pudimos comprobar el stock/)
  assert.ok(action.indexOf("onSuccess()") > action.indexOf("if (!result.success)"))
})

test("4-5. stock insuficiente enumera sólo los ítems afectados y no entra al paso 3", () => {
  const failure = section("const showReservationFailure =", "const reserveCheckoutItems =")
  assert.match(failure, /result\.conflicts/)
  assert.match(failure, /requestedQuantity: requested\.quantity/)
  assert.match(modal, /items\.map\(\(item\)/)
  assert.match(modal, /Cantidad solicitada:/)
  assert.doesNotMatch(failure, /setCurrentStep\(3\)/)
})

test("6. el countdown deriva del expiresAt del servidor y no de una duración inventada", () => {
  const start = Date.parse("2026-09-25T10:00:00.000Z")
  const expiry = "2026-09-25T10:20:00.000Z"
  const serverNow = "2026-09-25T10:00:00.000Z"
  assert.equal(formatReservationCountdown(reservationSecondsLeft(expiry, serverNow, start, start + 1000)), "19:59")
  assert.equal(formatReservationCountdown(reservationSecondsLeft(expiry, serverNow, start, start + 2000)), "19:58")
  assert.match(checkout, /result\.expiresAt/)
})

test("7. refresh a las 10:10 mantiene vencimiento a las 10:20, incluso con reloj local desfasado", () => {
  const expiry = "2026-09-25T10:20:00.000Z"
  const serverNow = "2026-09-25T10:10:00.000Z"
  const localNow = Date.parse("2026-09-25T11:10:00.000Z")
  assert.equal(reservationSecondsLeft(expiry, serverNow, localNow, localNow), 600)
  assert.equal(reservationSecondsLeft(expiry, serverNow, localNow, localNow + 60_000), 540)
  const recovery = section("if (sessionStorage.getItem(CHECKOUT_STEP_RESERVATION_KEY)", "useEffect(() => {\n    if (!stockReservation")
  assert.match(recovery, /getCartStockReservation\(cartSessionId\)/)
  assert.doesNotMatch(recovery, /reserveCartStock|reserveCheckoutItems/)
})

test("8. dos pestañas de la misma sesión comparan composición sin duplicar unidades", () => {
  const cartItems = reservationItemsFromCart([{
    product: { id: 10 }, quantity: 2, variantId: 3, conditionedStockId: null,
  }])
  assert.equal(reservationMatchesCart(cartItems, [...cartItems]), true)
  assert.equal(reservationMatchesCart(cartItems, [{ ...cartItems[0], quantity: 3 }]), false)
  assert.match(checkout, /window\.addEventListener\("focus", synchronize\)/)
  assert.match(checkout, /La reserva cambió en otra pestaña/)
})

test("9. a 00:00 se bloquea el pago, incluso antes del redireccionamiento", () => {
  assert.equal(reservationSecondsLeft("2026-09-25T10:20:00Z", "2026-09-25T10:20:00Z", 0, 0), 0)
  const submit = section("const canSubmitCheckout =", "const handleLocalityChange =")
  assert.match(submit, /hasMatchingStockReservation/)
  assert.match(submit, /reservationExpired/)
  assert.match(submit, /getCartStockReservation\(cartSessionId\)/)
})

test("10-11. vencimiento muestra mensaje y redirige al inicio", () => {
  assert.match(checkout, /Tu reserva venció\./)
  assert.match(checkout, /Pasaron los 20 minutos disponibles para completar la compra y liberamos los productos reservados\./)
  const expiry = section("const expireStockReservation =", "useEffect(() => {\n    if (!mounted")
  assert.match(expiry, /router\.replace\("\/"\)/)
})

test("12. vencer rota la identidad de checkout sin borrar los productos del carrito", () => {
  const expiry = section("const expireStockReservation =", "useEffect(() => {\n    if (!mounted")
  assert.match(expiry, /startNewCheckoutSession\(\)/)
  assert.doesNotMatch(expiry, /clearCart\(/)
  const rotate = cart.slice(cart.indexOf("const startNewCheckoutSession ="), cart.indexOf("const refreshCartCatalog ="))
  assert.doesNotMatch(rotate, /setCart\(\[\]\)|removeItem\(CART_STORAGE_KEY\)/)
})

test("13. una reserva vencida recuperada no crea otra automáticamente", () => {
  const recovery = section("if (sessionStorage.getItem(CHECKOUT_STEP_RESERVATION_KEY)", "useEffect(() => {\n    if (!stockReservation")
  assert.match(recovery, /snapshot\.status === "expired"/)
  assert.match(recovery, /expireStockReservation\(\)/)
  assert.doesNotMatch(recovery, /reserveCartStock|reserveCheckoutItems/)
  assert.doesNotMatch(reservation.slice(reservation.indexOf("export async function getCartStockReservation"), reservation.indexOf("/** Backend preparado")), /reserve_cart_stock/)
})

test("14. carrito y checkout muestran el tope de 3; backend lo sigue validando", () => {
  assert.equal(MAX_CART_ITEM_QUANTITY, 3)
  assert.match(cart, /Math\.min\(nextQuantity, MAX_CART_ITEM_QUANTITY\)/)
  assert.match(checkout, /Máximo 3/)
  assert.match(read("../../components/cart/cart-item.tsx"), /Máximo 3/)
  assert.match(reservation, /item\.quantity > 3/)
})

test("cambios explícitos del resumen reemplazan la reserva antes de cambiar el carrito", () => {
  const change = section("const changeCheckoutCartItem =", "const getCheckoutInputClassName =")
  assert.match(change, /reserveCheckoutItems\(requestedItems, applyChange\)/)
  assert.match(checkout, /disabled=\{isMaxQuantity \|\| reservationPending \|\| reservationExpired\}/)
})
