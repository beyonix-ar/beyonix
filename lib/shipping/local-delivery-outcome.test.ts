import assert from "node:assert/strict"
import test from "node:test"

import {
  createLocalDeliveryAccessToken,
  CourierActionRequestError,
  describeAdminLocalDeliveryReservation,
  formatLocalDeliveryDay,
  formatLocalDeliveryDeadline,
  getCourierScreen,
  getCustomerLocalDeliveryNotice,
  isLocalDeliveryAccessToken,
  localDeliveryCourierUrl,
  normalizeLocalDeliveryReservationDays,
  parseCourierActionRequest,
} from "./local-delivery-outcome.ts"

test("token: 128 bits aleatorios en base64url, distinto cada vez y validado con el mismo formato que la base", () => {
  const tokens = new Set(Array.from({ length: 200 }, () => createLocalDeliveryAccessToken()))
  assert.equal(tokens.size, 200)
  for (const token of tokens) {
    assert.match(token, /^[A-Za-z0-9_-]{22}$/)
    assert.equal(isLocalDeliveryAccessToken(token), true)
  }
  assert.equal(createLocalDeliveryAccessToken((bytes) => bytes.fill(255)), "_____________________w")
  for (const invalid of ["", "corto", "a".repeat(65), "con espacios en el token 1", "BX-1041/../admin", 1041, null]) {
    assert.equal(isLocalDeliveryAccessToken(invalid), false, String(invalid))
  }
  assert.equal(localDeliveryCourierUrl("https://www.beyonix.com.ar/", "AbCdEfGhIjKlMnOpQrStUv"), "https://www.beyonix.com.ar/delivery/AbCdEfGhIjKlMnOpQrStUv")
})

test("pantalla del cadete: botones sólo En camino sin resultado o tras el 1.er intento; el resto es informativo", () => {
  const base = { estado: "en_camino", cancelled: false, outcomeStatus: "pending" as const, failedAttempts: 0 }
  assert.deepEqual(getCourierScreen(base), { kind: "actions", failedAttempts: 0 })
  assert.deepEqual(getCourierScreen({ ...base, outcomeStatus: "first_attempt_failed", failedAttempts: 1 }), { kind: "actions", failedAttempts: 1 })
  assert.deepEqual(getCourierScreen({ ...base, estado: "pagado" }), { kind: "preparing" })
  assert.deepEqual(getCourierScreen({ ...base, outcomeStatus: "incident" }), { kind: "incident" })
  assert.deepEqual(getCourierScreen({ ...base, outcomeStatus: "returning", failedAttempts: 2 }), { kind: "returning" })
  assert.deepEqual(getCourierScreen({ ...base, outcomeStatus: "returned", failedAttempts: 2 }), { kind: "returned" })
  assert.deepEqual(getCourierScreen({ ...base, estado: "entregado", outcomeStatus: "delivered" }), { kind: "delivered" })
  assert.deepEqual(getCourierScreen({ ...base, cancelled: true }), { kind: "cancelled" }, "cancelado gana sobre todo")
})

test("acción del cadete: estricta; 'Otro' exige comentario breve; las opciones predefinidas no", () => {
  assert.deepEqual(parseCourierActionRequest({ action: "delivered", expectedAttempts: 0 }), { action: "delivered", expectedAttempts: 0, reason: null, comment: null })
  assert.deepEqual(parseCourierActionRequest({ action: "absent", expectedAttempts: 1 }), { action: "absent", expectedAttempts: 1, reason: null, comment: null })
  assert.deepEqual(parseCourierActionRequest({ action: "incident", expectedAttempts: 0, reason: "no_access" }), { action: "incident", expectedAttempts: 0, reason: "no_access", comment: null })
  assert.deepEqual(parseCourierActionRequest({ action: "incident", expectedAttempts: 1, reason: "other", comment: "  Perro suelto,   no pude   entrar  " }),
    { action: "incident", expectedAttempts: 1, reason: "other", comment: "Perro suelto, no pude entrar" })
  for (const invalid of [
    null, [], "absent", { action: "absent" }, { action: "absent", expectedAttempts: -1 }, { action: "absent", expectedAttempts: 1.5 },
    { action: "absent", expectedAttempts: 0, extra: true }, { action: "incident", expectedAttempts: 0 },
    { action: "incident", expectedAttempts: 0, reason: "other" }, { action: "incident", expectedAttempts: 0, reason: "other", comment: "x".repeat(281) },
    { action: "absent", expectedAttempts: 0, comment: "hola" }, { action: "incident", expectedAttempts: 0, reason: "rejected", comment: 5 },
  ]) {
    assert.throws(() => parseCourierActionRequest(invalid), CourierActionRequestError, JSON.stringify(invalid))
  }
})

test("Mis compras: textos formales de 1.er y 2.º intento, regreso y reserva con fecha concreta", () => {
  assert.equal(getCustomerLocalDeliveryNotice(null), null)
  assert.equal(getCustomerLocalDeliveryNotice({ status: "pending", failedAttempts: 0, reservation: null }), null)
  assert.equal(getCustomerLocalDeliveryNotice({ status: "delivered", failedAttempts: 1, reservation: null }), null)

  const first = getCustomerLocalDeliveryNotice({ status: "first_attempt_failed", failedAttempts: 1, reservation: null })!
  assert.deepEqual(first.paragraphs, [
    "El cadete visitó tu domicilio, pero no pudo concretar la entrega porque no había nadie presente.",
    "Realizaremos un segundo intento de entrega.",
    "Si en el segundo intento tampoco podemos completar la entrega, el pedido regresará a BEYONIX y, para coordinar un nuevo envío, deberás abonar nuevamente el costo de entrega correspondiente.",
  ])
  assert.equal(first.showContact, false)

  const returning = getCustomerLocalDeliveryNotice({ status: "returning", failedAttempts: 2, reservation: null })!
  assert.equal(returning.label, "Regresando a BEYONIX")
  assert.deepEqual(returning.paragraphs, [
    "Realizamos un segundo intento de entrega y nuevamente no pudimos encontrar a nadie en el domicilio.",
    "El pedido regresará a BEYONIX.",
    "Para coordinar un nuevo envío, deberás abonar nuevamente el costo de entrega correspondiente.",
  ])

  // 09/11 00:00 en Argentina = 03:00 UTC.
  const expiresAt = "2026-11-09T03:00:00.000Z"
  const active = getCustomerLocalDeliveryNotice({ status: "returned", failedAttempts: 2, reservation: { status: "active", expiresAt } }, Date.parse("2026-11-06T12:00:00Z"))!
  assert.equal(active.title, "Tu pedido regresó a BEYONIX.")
  assert.deepEqual(active.paragraphs, [
    "Mantendremos tus productos reservados hasta el 09/11.",
    "Para solicitar un nuevo envío, contactanos antes de esa fecha.",
    "El nuevo envío tendrá costo.",
  ])
  assert.equal(active.showContact, true)
  for (const expired of [
    getCustomerLocalDeliveryNotice({ status: "returned", failedAttempts: 2, reservation: { status: "expired", expiresAt } }),
    // Venció aunque el job todavía no haya corrido.
    getCustomerLocalDeliveryNotice({ status: "returned", failedAttempts: 2, reservation: { status: "active", expiresAt } }, Date.parse("2026-11-09T03:00:00Z")),
  ]) {
    assert.match(expired!.paragraphs[0], /La reserva de los productos venció y la disponibilidad deberá confirmarse nuevamente\./)
    assert.equal(expired!.showContact, true, "puede seguir contactando")
  }
  // Nunca códigos técnicos, motivos del cadete ni cálculos.
  for (const notice of [first, returning, active]) assert.doesNotMatch(JSON.stringify(notice), /72|horas|incident|returning|token|reservation_days/)
})

test("fechas en hora de BEYONIX y estado de la reserva en Admin", () => {
  assert.equal(formatLocalDeliveryDay("2026-11-09T03:00:00.000Z"), "09/11")
  assert.equal(formatLocalDeliveryDeadline("2026-11-09T03:00:00.000Z"), "09/11 00:00")
  const now = Date.parse("2026-11-06T12:00:00Z")
  assert.deepEqual(describeAdminLocalDeliveryReservation({ status: "active", reservationDays: 3, expiresAt: "2026-11-09T03:00:00.000Z" }, now), {
    label: "Reserva activa hasta 09/11 00:00", detail: "3 días configurados · Esperando coordinación del cliente", tone: "warning",
  })
  assert.equal(describeAdminLocalDeliveryReservation({ status: "expired", reservationDays: 3, expiresAt: "2026-11-09T03:00:00.000Z" }, now)?.label, "Reserva vencida — stock liberado")
  assert.equal(describeAdminLocalDeliveryReservation({ status: "active", reservationDays: 1, expiresAt: "2026-11-06T03:00:00.000Z" }, now)?.label, "Reserva vencida — liberando stock")
  assert.equal(describeAdminLocalDeliveryReservation({ status: "consumed", reservationDays: 1, expiresAt: "2026-11-09T03:00:00.000Z" }, now)?.detail, "1 día configurado")
  assert.equal(describeAdminLocalDeliveryReservation(null), null)
})

test("configuración: días de reserva por devolución, enteros de 1 a 30", () => {
  for (const valid of [1, 3, 30]) assert.equal(normalizeLocalDeliveryReservationDays(valid), valid)
  for (const invalid of [0, 31, 2.5, -1, "3", null, Number.NaN]) assert.equal(normalizeLocalDeliveryReservationDays(invalid), null)
})
