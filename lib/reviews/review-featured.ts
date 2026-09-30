// Destacado en Home: lo decide únicamente el Admin (admin/super_admin) desde
// /api/admin/reviews. La base lo vuelve a exigir (trigger enforce_review_rules
// y sin permisos de INSERT/UPDATE para anon/authenticated).
export const REVIEW_FEATURE_ROLES = ["admin", "super_admin"] as const

export function getFeatureReviewError(
  review: { approved: boolean; comment: string | null },
  featured: boolean,
) {
  if (!featured) return ""
  if (!review.approved) return "Solo se pueden destacar reseñas publicadas."
  if (!review.comment?.trim()) return "Solo se pueden destacar reseñas con comentario."
  return ""
}
