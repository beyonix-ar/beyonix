import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  CHECKOUT_PENDING_RELEASE_KEY,
  abandonCheckoutReservation,
  isCheckoutPath,
  pendingCheckoutReleases,
  releaseAbandonedCheckoutReservations,
} from "./checkout-abandonment.ts"
import { CHECKOUT_STEP_RESERVATION_KEY } from "./checkout-step-reservation.ts"
import type { StockReservationResult } from "./stock-reservations"

// Salir de /checkout libera la reserva del Paso 3 en el momento (sin esperar
// los 20 minutos); moverse entre pasos dentro del checkout no la toca.

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value) },
    removeItem: (key: string) => { data.delete(key) },
    data,
  }
}

const released: StockReservationResult = {
  success: true, reserved: false, expiresAt: "2026-09-27T18:20:00Z",
  reservationStartedAt: "2026-09-27T18:00:00Z", serverNow: "2026-09-27T18:05:00Z",
}
const failed = (code: Exclude<StockReservationResult, { success: true }>["code"]): StockReservationResult =>
  ({ success: false, code })

test("rutas: /checkout y sus subrutas son checkout; el resto no", () => {
  for (const path of ["/checkout", "/checkout/success", "/checkout/failure", "/checkout/pending"]) {
    assert.equal(isCheckoutPath(path), true, path)
  }
  for (const path of ["/", "/productos", "/productos/tripode", "/cuenta", "/checkoutx", "/carrito", null, undefined]) {
    assert.equal(isCheckoutPath(path), false, String(path))
  }
})

test("sin reserva del Paso 3: no hace nada ni llama a la base", async () => {
  const storage = memoryStorage()
  assert.equal(abandonCheckoutReservation(storage), null)
  let calls = 0
  const result = await releaseAbandonedCheckoutReservations(storage, async () => { calls += 1; return released })
  assert.deepEqual(result, { released: [] })
  assert.equal(calls, 0)
})

test("abandonar: la marca del Paso 3 se quita en el acto y queda pendiente de liberar (idempotente)", () => {
  const storage = memoryStorage({ [CHECKOUT_STEP_RESERVATION_KEY]: "session-a" })
  assert.equal(abandonCheckoutReservation(storage), "session-a")
  assert.equal(storage.getItem(CHECKOUT_STEP_RESERVATION_KEY), null, "si vuelve al checkout no la recupera")
  assert.deepEqual(pendingCheckoutReleases(storage), ["session-a"])
  // Otra navegación (o marca repetida) no duplica.
  storage.setItem(CHECKOUT_STEP_RESERVATION_KEY, "session-a")
  abandonCheckoutReservation(storage)
  assert.deepEqual(pendingCheckoutReleases(storage), ["session-a"])
})

test("liberar: [] sobre la sesión abandonada; éxito -> sale de pendientes y avisa que se liberó", async () => {
  const storage = memoryStorage({ [CHECKOUT_STEP_RESERVATION_KEY]: "session-a" })
  abandonCheckoutReservation(storage)
  const calls: string[] = []
  const result = await releaseAbandonedCheckoutReservations(storage, async (sessionId) => { calls.push(sessionId); return released })
  assert.deepEqual(calls, ["session-a"])
  assert.deepEqual(result.released, ["session-a"])
  assert.equal(storage.getItem(CHECKOUT_PENDING_RELEASE_KEY), null)
  // Repetir no vuelve a llamar (idempotente).
  await releaseAbandonedCheckoutReservations(storage, async (sessionId) => { calls.push(sessionId); return released })
  assert.equal(calls.length, 1)
})

test("definitivos sin liberar nada: ya vencida, ligada a un pedido (pago iniciado) o sesión inválida", async () => {
  for (const code of ["RESERVATION_EXPIRED", "RESERVATION_LOCKED_TO_ORDER", "INVALID_SESSION"] as const) {
    const storage = memoryStorage({ [CHECKOUT_STEP_RESERVATION_KEY]: `session-${code}` })
    abandonCheckoutReservation(storage)
    const result = await releaseAbandonedCheckoutReservations(storage, async () => failed(code))
    assert.deepEqual(result.released, [], code)
    assert.deepEqual(pendingCheckoutReleases(storage), [], `${code}: no se reintenta`)
  }
})

test("error transitorio o de red: queda pendiente y se reintenta en la próxima navegación", async () => {
  const storage = memoryStorage({ [CHECKOUT_STEP_RESERVATION_KEY]: "session-a" })
  abandonCheckoutReservation(storage)
  assert.deepEqual((await releaseAbandonedCheckoutReservations(storage, async () => failed("INTERNAL_ERROR"))).released, [])
  assert.deepEqual(pendingCheckoutReleases(storage), ["session-a"])
  await releaseAbandonedCheckoutReservations(storage, async () => { throw new Error("network") })
  assert.deepEqual(pendingCheckoutReleases(storage), ["session-a"])
  assert.deepEqual((await releaseAbandonedCheckoutReservations(storage, async () => released)).released, ["session-a"])
  assert.deepEqual(pendingCheckoutReleases(storage), [])
})

test("pendientes corruptos o de más: se ignora lo inválido y se acota", () => {
  const storage = memoryStorage({ [CHECKOUT_PENDING_RELEASE_KEY]: "{no es json" })
  assert.deepEqual(pendingCheckoutReleases(storage), [])
  storage.setItem(CHECKOUT_PENDING_RELEASE_KEY, JSON.stringify(["a", 3, "", null, "b"]))
  assert.deepEqual(pendingCheckoutReleases(storage), ["a", "b"])
  for (const id of ["c", "d", "e", "f", "g"]) {
    storage.setItem(CHECKOUT_STEP_RESERVATION_KEY, id)
    abandonCheckoutReservation(storage)
  }
  assert.deepEqual(pendingCheckoutReleases(storage), ["c", "d", "e", "f", "g"])
})

test("CartProvider: fuera de /checkout abandona en el acto, rota la identidad y libera con []", () => {
  const source = readFileSync("context/cart-context.tsx", "utf8").replace(/\r\n/g, "\n")
  const effect = source.slice(source.indexOf("const pathname = usePathname()"), source.indexOf("const refreshCartCatalog ="))
  assert.match(effect, /if \(!hasHydrated \|\| isCheckoutPath\(pathname\)\) return/)
  const abandon = effect.indexOf("abandonCheckoutReservation(sessionStorage)")
  const rotate = effect.indexOf("if (abandoned && abandoned === cartSessionIdRef.current) startNewCheckoutSession()")
  const release = effect.indexOf("releaseAbandonedCheckoutReservations(sessionStorage")
  assert.ok(abandon > 0 && rotate > abandon && release > rotate, "sincrónico primero, liberación después")
  assert.match(effect, /reserveCartStock\(\{ sessionId, items: \[\] \}\)/)
  assert.match(effect, /if \(released\.length\) router\.refresh\(\)/)
  assert.match(effect, /\[hasHydrated, pathname, router, startNewCheckoutSession\]/)
})
