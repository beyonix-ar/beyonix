import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { getReviewRatingLabel, REVIEW_RATING_LABELS } from "./rating-label.ts"

test("etiqueta por estrellas: 1 Muy mala · 2 Mala · 3 Buena · 4 Muy buena · 5 Excelente", () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5].map(getReviewRatingLabel),
    ["Muy mala", "Mala", "Buena", "Muy buena", "Excelente"],
  )
  assert.equal(Object.keys(REVIEW_RATING_LABELS).length, 5)
})

test("fuera de rango o sin selección: sin etiqueta (nunca altera la puntuación)", () => {
  for (const rating of [0, 6, 2.5, Number.NaN]) assert.equal(getReviewRatingLabel(rating), "")
})

test("la cuenta del cliente usa la etiqueta compartida; no queda 'Regular' en superficies públicas", () => {
  const account = readFileSync(new URL("../../components/account/account-order-components.tsx", import.meta.url), "utf8")
  assert.match(account, /getReviewRatingLabel\(submittedReview\.rating\)/)
  assert.match(account, /getReviewRatingLabel\(visualRating\)/)
  assert.doesNotMatch(account, /"Regular"/)
})
