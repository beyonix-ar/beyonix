// Destacado en Home: lo decide únicamente el Admin (admin/super_admin) desde
// /api/admin/reviews. La base lo vuelve a exigir (trigger enforce_review_rules
// y sin permisos de INSERT/UPDATE para anon/authenticated).
export const REVIEW_FEATURE_ROLES = ["admin", "super_admin"] as const

export const FEATURE_EXPERIENCE_ONLY_ERROR =
  "Las reseñas de producto no se muestran en Home: solo se destacan experiencias de compra."

/** El Home sólo muestra experiencias generales (reseñas sin producto). */
export function canFeatureReview(review: { product_id: number | null }) {
  return review.product_id == null
}

export function getFeatureReviewError(
  review: { approved: boolean; comment: string | null; product_id: number | null },
  featured: boolean,
) {
  if (!featured) return ""
  if (!canFeatureReview(review)) return FEATURE_EXPERIENCE_ONLY_ERROR
  if (!review.approved) return "Solo se pueden destacar reseñas publicadas."
  if (!review.comment?.trim()) return "Solo se pueden destacar reseñas con comentario."
  return ""
}
