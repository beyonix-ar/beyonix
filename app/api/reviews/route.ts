import {
  getEligibleReview,
  getEligibleProductReview,
  toPublicReview,
  validateReviewComment,
} from "@/lib/reviews/server"

import {
  getOptionalReviewUser,
  getReviewUserRole,
  requireReviewUser,
} from "./_auth"

export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  try {
    const { admin, user } = await getOptionalReviewUser(request)
    const productId = Number(new URL(request.url).searchParams.get("productId"))
    const orderId = Number(new URL(request.url).searchParams.get("orderId"))
    let reviewsQuery = admin
      .schema("public")
      .from("reviews")
      .select("id, product_id, rating, comment, nickname, city, province, created_at")
      .eq("approved", true)
      .order("created_at", { ascending: false })

    if (Number.isInteger(productId) && productId > 0) {
      reviewsQuery = reviewsQuery.eq("product_id", productId)
    } else {
      reviewsQuery = reviewsQuery.is("product_id", null)
    }

    const { data, error } = await reviewsQuery

    if (error) throw error

    let ownReviewIds = new Set<number>()
    let eligibleReview = null
    let ownProductReviews: Array<Record<string, unknown>> = []
    let ownExperienceReview: Record<string, unknown> | null = null

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

      if (Number.isInteger(orderId) && orderId > 0) {
        const [ownProductResult, ownExperienceResult] = await Promise.all([
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
        ])

        if (!ownProductResult.error) {
          ownProductReviews = ownProductResult.data ?? []
        }

        if (!ownExperienceResult.error) {
          ownExperienceReview = ownExperienceResult.data ?? null
        }
      }

      if (role === "admin" || role === "super_admin") {
        ownReviewIds = new Set((data ?? []).map((review) => Number(review.id)))
      }

      try {
        eligibleReview = await getEligibleReview(
          admin,
          user,
          Number.isInteger(orderId) && orderId > 0 ? orderId : undefined,
        )
      } catch (eligibilityError) {
        console.error("REVIEW ELIGIBILITY ERROR:", eligibilityError)
      }
    }

    return Response.json(
      {
        reviews: (data ?? []).map((review) =>
          toPublicReview(review, ownReviewIds.has(Number(review.id)))
        ),
        eligibleReview,
        ownProductReviews,
        ownExperienceReview,
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

    const eligibleReview = hasProduct
      ? await getEligibleProductReview(
          auth.admin,
          auth.user,
          orderId,
          productId,
        )
      : await getEligibleReview(auth.admin, auth.user, orderId)

    if (!eligibleReview || eligibleReview.orderId !== orderId) {
      return Response.json(
        { error: "No encontramos una compra verificada disponible para reseñar." },
        { status: 403 }
      )
    }

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
