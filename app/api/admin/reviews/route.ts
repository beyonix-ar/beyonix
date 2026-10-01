import { requireInternalUser } from "@/lib/auth/admin-api"
import {
  FEATURE_EXPERIENCE_ONLY_ERROR,
  getFeatureReviewError,
  REVIEW_FEATURE_ROLES,
} from "@/lib/reviews/review-featured"

const PAGE_SIZE = 30
const ADMIN_REVIEW_COLUMNS =
  "id, order_id, product_id, rating, comment, nickname, city, province, approved, featured, featured_at, created_at, productos(nombre)"

type AdminReviewFilter = "all" | "experiences" | "featured" | "not_featured"

function parseFilter(value: string | null): AdminReviewFilter {
  return value === "experiences" || value === "featured" || value === "not_featured" ? value : "all"
}

export async function GET(request: Request) {
  const auth = await requireInternalUser(request, [...REVIEW_FEATURE_ROLES])
  if ("error" in auth) return auth.error

  const { searchParams } = new URL(request.url)
  const filter = parseFilter(searchParams.get("filter"))
  const requestedPage = Number.parseInt(searchParams.get("page") ?? "1", 10)
  const page = Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1
  const from = (page - 1) * PAGE_SIZE

  let query = auth.admin
    .from("reviews")
    .select(ADMIN_REVIEW_COLUMNS, { count: "exact" })
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(from, from + PAGE_SIZE - 1)

  if (filter === "experiences") query = query.is("product_id", null)
  if (filter === "featured") query = query.eq("featured", true)
  if (filter === "not_featured") query = query.eq("featured", false)

  const { data, error, count } = await query

  if (error) {
    console.error("ADMIN REVIEWS GET ERROR:", error)
    return Response.json({ error: "No se pudieron cargar las reseñas." }, { status: 500 })
  }

  return Response.json(
    {
      reviews: (data ?? []).map((row) => {
        const product = Array.isArray(row.productos) ? row.productos[0] : row.productos
        return {
          id: Number(row.id),
          orderId: Number(row.order_id),
          productId: row.product_id === null ? null : Number(row.product_id),
          productName: typeof product?.nombre === "string" ? product.nombre : null,
          rating: Number(row.rating),
          comment: String(row.comment ?? ""),
          nickname: String(row.nickname),
          city: String(row.city),
          province: String(row.province),
          approved: Boolean(row.approved),
          featured: Boolean(row.featured),
          featuredAt: row.featured_at ? String(row.featured_at) : null,
          createdAt: String(row.created_at),
        }
      }),
      page,
      pageCount: Math.max(1, Math.ceil((count ?? 0) / PAGE_SIZE)),
      total: count ?? 0,
    },
    { headers: { "Cache-Control": "no-store" } },
  )
}

export async function PATCH(request: Request) {
  const auth = await requireInternalUser(request, [...REVIEW_FEATURE_ROLES])
  if ("error" in auth) return auth.error

  const body = (await request.json().catch(() => null)) as {
    id?: unknown
    featured?: unknown
  } | null
  const reviewId = Number(body?.id)

  if (!Number.isInteger(reviewId) || reviewId <= 0 || typeof body?.featured !== "boolean") {
    return Response.json({ error: "Datos inválidos." }, { status: 400 })
  }

  const featured = body.featured
  const before = await auth.admin
    .from("reviews")
    .select("id, product_id, approved, comment, featured, featured_at")
    .eq("id", reviewId)
    .maybeSingle()

  if (before.error) {
    console.error("ADMIN REVIEWS PATCH ERROR:", before.error)
    return Response.json({ error: "No se pudo actualizar la reseña." }, { status: 500 })
  }

  if (!before.data) {
    return Response.json({ error: "No encontramos esa reseña." }, { status: 404 })
  }

  const featureError = getFeatureReviewError(before.data, featured)
  if (featureError) {
    return Response.json({ error: featureError }, { status: 400 })
  }

  if (before.data.featured === featured) {
    return Response.json({ review: { id: reviewId, featured, featuredAt: before.data.featured_at } })
  }

  const { data, error } = await auth.admin
    .from("reviews")
    .update({ featured })
    .eq("id", reviewId)
    .select("id, featured, featured_at")
    .single()

  // El trigger vuelve a exigir la regla (carrera: el tipo cambió entre la
  // lectura y el update): se informa igual que la validación de arriba.
  if (error?.message?.includes("REVIEW_FEATURED_EXPERIENCE_ONLY")) {
    return Response.json({ error: FEATURE_EXPERIENCE_ONLY_ERROR }, { status: 400 })
  }

  if (error) {
    console.error("ADMIN REVIEWS PATCH ERROR:", error)
    return Response.json({ error: "No se pudo actualizar la reseña." }, { status: 500 })
  }

  await auth.admin.from("audit_logs").insert({
    table_name: "reviews",
    action: "UPDATE",
    record_id: String(reviewId),
    actor_user_id: auth.user.id,
    actor_email: auth.user.email ?? auth.profile.email,
    before_data: { featured: before.data.featured, featured_at: before.data.featured_at },
    after_data: { featured: data.featured, featured_at: data.featured_at },
  })

  return Response.json({
    review: { id: reviewId, featured: Boolean(data.featured), featuredAt: data.featured_at },
  })
}
