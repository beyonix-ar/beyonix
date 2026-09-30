import assert from "node:assert/strict"
import test from "node:test"

import { getReviewWindow, REVIEW_WINDOW_DAYS, REVIEW_WINDOW_MESSAGES } from "./review-window.ts"

const DAY = 24 * 60 * 60 * 1000
const deliveredAt = "2026-09-10T15:30:00.000Z"
const delivered = Date.parse(deliveredAt)
const order = { estado: "entregado", delivered_at: deliveredAt }

test("D. dentro de los 15 días desde la entrega: permitido", () => {
  assert.equal(REVIEW_WINDOW_DAYS, 15)
  for (const offset of [0, 1, DAY, 7 * DAY, 15 * DAY - 1]) {
    assert.equal(getReviewWindow(order, delivered + offset).status, "open", `offset ${offset}`)
  }
})

test("borde exacto: delivered_at + 15 días todavía permitido (inclusive)", () => {
  const result = getReviewWindow(order, delivered + 15 * DAY)
  assert.equal(result.status, "open")
  assert.equal(result.deadline, "2026-09-25T15:30:00.000Z")
})

test("E. después del plazo (día 16): rechazado con mensaje claro", () => {
  assert.equal(getReviewWindow(order, delivered + 15 * DAY + 1).status, "expired")
  assert.equal(getReviewWindow(order, delivered + 16 * DAY).status, "expired")
  assert.equal(REVIEW_WINDOW_MESSAGES.expired, "El período para dejar una reseña finalizó.")
})

test("sin fecha de entrega, cancelado o entrega futura: todavía no se puede reseñar", () => {
  assert.equal(getReviewWindow({ estado: "entregado", delivered_at: null }).status, "not_delivered")
  assert.equal(getReviewWindow({ estado: "pagado", delivered_at: null }).status, "not_delivered")
  assert.equal(getReviewWindow({ estado: "cancelado", delivered_at: deliveredAt }, delivered + DAY).status, "not_delivered")
  assert.equal(getReviewWindow(order, delivered - 1).status, "not_delivered")
  assert.equal(getReviewWindow({ estado: "entregado", delivered_at: "fecha-invalida" }).status, "not_delivered")
})

test("instantes absolutos: la misma entrega con offset -03:00 da el mismo plazo", () => {
  const argentina = getReviewWindow({ estado: "entregado", delivered_at: "2026-09-10T12:30:00-03:00" }, delivered + 15 * DAY)
  assert.equal(argentina.status, "open")
  assert.equal(argentina.deadline, "2026-09-25T15:30:00.000Z")
})
