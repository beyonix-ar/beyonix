import {
  getEligibleReview,
  getEligibleProductReview,
  getOwnOrderReviewWindow,
  toPublicReview,
  type EligibleReview,
} from "@/lib/reviews/server"
import type { ReviewWindow } from "@/lib/reviews/review-window"
import { validateReviewComment } from "@/lib/reviews/review-text"

import {
  getOptionalReviewUser,
  getReviewUserRole,
  requireReviewUser,
} from "./_auth"

export const dynamic = "force-dynamic"

const HOME_FEATURED_REVIEWS_LIMIT = 12
const PUBLIC_REVIEW_COLUMNS = "id, product_id, rating, comment, nickname, city, province, created_at"

export async function GET(request: Request) {
  try {
    const { admin, user } = await getOptionalReviewUser(request)
    const productId = Number(new URL(request.url).searchParams.get("productId"))
    const orderId = Number(new URL(request.url).searchParams.get("orderId"))
    const hasProduct = Number.isInteger(productId) && productId > 0
    const hasOrder = Number.isInteger(orderId) && orderId > 0

    // Producto: todas sus reseñas aprobadas. Home: solo las que el Admin
    // destacó; el promedio sigue calculándose sobre todas las experiencias
    // aprobadas para no mostrar un puntaje curado.
    const reviewsQuery = hasProduct
      ? admin
          .schema("public")
          .from("reviews")
          .select(PUBLIC_REVIEW_COLUMNS)
          .eq("approved", true)
          .eq("product_id", productId)
          .order("created_at", { ascending: false })
      : admin
          .schema("public")
          .from("reviews")
          .select(PUBLIC_REVIEW_COLUMNS)
          .eq("approved", true)
          .eq("featured", true)
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
          .limit(HOME_FEATURED_REVIEWS_LIMIT)

    const [reviewsResult, summaryResult] = await Promise.all([
      reviewsQuery,
      hasProduct
        ? null
        : admin
            .schema("public")
            .from("reviews")
            .select("rating")
            .eq("approved", true)
            .is("product_id", null),
    ])

    if (reviewsResult.error) throw reviewsResult.error
    if (summaryResult?.error) throw summaryResult.error

    const data = reviewsResult.data ?? []
    const summaryRatings = (summaryResult?.data ?? []).map((row) => Number(row.rating))
    const summary = hasProduct
      ? undefined
      : {
          count: summaryRatings.length,
          average: summaryRatings.length
            ? summaryRatings.reduce((total, rating) => total + rating, 0) / summaryRatings.length
            : 0,
        }

    let ownReviewIds = new Set<number>()
    let eligibleReview: EligibleReview | null = null
    let ownProductReviews: Array<Record<string, unknown>> = []
    let ownExperienceReview: Record<string, unknown> | null = null
    let reviewWindow: ReviewWindow | null = null

    if (user) {
      const [ownReviewsResult, role] = await Promise.all([
        admin
          .schema("public")
          .from("reviews")
          .select("id")
          .eq("user_id", user.id),
        getReviewUserRole(admin, user.id),
      ])

      if (!ownReviewsResult.error) {
        ownReviewIds = new Set(
          (ownReviewsResult.data ?? []).map((review) => Number(review.id))
        )
      }

      if (hasOrder) {
        const [ownProductResult, ownExperienceResult, orderWindow] = await Promise.all([
          admin
            .schema("public")
            .from("reviews")
            .select("product_id, rating, comment")
            .eq("user_id", user.id)
            .eq("order_id", orderId)
            .not("product_id", "is", null),
          admin
            .schema("public")
            .from("reviews")
            .select("id, order_id, rating, comment, created_at")
            .eq("user_id", user.id)
            .eq("order_id", orderId)
            .is("product_id", null)
            .maybeSingle(),
          getOwnOrderReviewWindow(admin, user.id, orderId).catch((windowError: unknown) => {
            console.error("REVIEW WINDOW ERROR:", windowError)
            return null
          }),
        ])

        if (!ownProductResult.error) {
          ownProductReviews = ownProductResult.data ?? []
        }

        if (!ownExperienceResult.error) {
          ownExperienceReview = ownExperienceResult.data ?? null
        }

        reviewWindow = orderWindow
      }

      if (role === "admin" || role === "super_admin") {
        ownReviewIds = new Set(data.map((review) => Number(review.id)))
      }

      try {
        const eligibility = await getEligibleReview(
          admin,
          user,
          hasOrder ? orderId : undefined,
        )
        eligibleReview = eligibility.ok ? eligibility.review : null
      } catch (eligibilityError) {
        console.error("REVIEW ELIGIBILITY ERROR:", eligibilityError)
      }
    }

    return Response.json(
      {
        reviews: data.map((review) =>
          toPublicReview(review, ownReviewIds.has(Number(review.id)))
        ),
        summary,
        eligibleReview,
        ownProductReviews,
        ownExperienceReview,
        reviewWindow,
      },
      {
        headers: {
          "Cache-Control": "no-store",
        },
      }
    )
  } catch (error) {
    console.error("REVIEWS GET ERROR:", error)

    return Response.json(
      { error: "No pudimos cargar las reseñas." },
      { status: 500 }
    )
  }
}

export async function POST(request: Request) {
  try {
    const auth = await requireReviewUser(request)

    if ("error" in auth) return auth.error

    const body = (await request.json()) as {
      orderId?: number
      rating?: number
      comment?: string
      productId?: number
    }
    const rating = Number(body.rating)
    const productId = Number(body.productId)
    const orderId = Number(body.orderId)
    const hasProduct = Number.isInteger(productId) && productId > 0
    const commentValidation = validateReviewComment(body.comment)

    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return Response.json(
        { error: "Elegí una calificación entre 1 y 5 estrellas." },
        { status: 400 }
      )
    }

    if (commentValidation.error) {
      return Response.json(
        { error: commentValidation.error },
        { status: 400 }
      )
    }

    if (!Number.isInteger(orderId) || orderId <= 0) {
      return Response.json(
        { error: "No encontramos una compra verificada disponible para reseñar." },
        { status: 403 }
      )
    }

    const eligibility = hasProduct
      ? await getEligibleProductReview(
          auth.admin,
          auth.user,
          orderId,
          productId,
        )
      : await getEligibleReview(auth.admin, auth.user, orderId)

    if (!eligibility.ok || eligibility.review.orderId !== orderId) {
      return Response.json(
        {
          error: eligibility.ok
            ? "No encontramos una compra verificada disponible para reseñar."
            : eligibility.error,
        },
        { status: 403 }
      )
    }

    const eligibleReview = eligibility.review
    const { data, error } = await auth.admin
      .schema("public")
      .from("reviews")
      .insert({
        user_id: auth.user.id,
        order_id: eligibleReview.orderId,
        product_id: hasProduct ? productId : null,
        rating,
        comment: commentValidation.comment,
        nickname: eligibleReview.nickname,
        city: eligibleReview.city,
        province: eligibleReview.province,
        approved: true,
      })
      .select(
        "id, rating, comment, nickname, city, province, created_at"
      )
      .single()

    if (error?.code === "23505") {
      return Response.json(
        { error: hasProduct ? "Este producto ya tiene una reseña." : "Esta compra ya tiene una reseña." },
        { status: 409 }
      )
    }

    // El trigger de la base vuelve a validar plazo y comentario: si el plazo
    // venció entre la validación y el insert, se informa igual que arriba.
    if (error?.message?.includes("REVIEW_WINDOW_EXPIRED")) {
      return Response.json(
        { error: "El período para dejar una reseña finalizó." },
        { status: 403 }
      )
    }

    if (error) throw error

    return Response.json(
      { review: toPublicReview(data, true) },
      { status: 201 }
    )
  } catch (error) {
    console.error("REVIEWS POST ERROR:", error)

    return Response.json(
      { error: "No pudimos guardar la reseña. Intentá nuevamente." },
      { status: 500 }
    )
  }
}
