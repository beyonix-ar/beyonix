/**
 * Etiqueta textual de una puntuación (1 a 5 estrellas). Sólo describe la
 * puntuación: nunca la modifica ni interviene en promedios.
 */
export const REVIEW_RATING_LABELS: Readonly<Record<1 | 2 | 3 | 4 | 5, string>> = {
  1: "Muy mala",
  2: "Mala",
  3: "Buena",
  4: "Muy buena",
  5: "Excelente",
}

export function getReviewRatingLabel(rating: number): string {
  return Number.isInteger(rating) && rating >= 1 && rating <= 5
    ? REVIEW_RATING_LABELS[rating as 1 | 2 | 3 | 4 | 5]
    : ""
}
