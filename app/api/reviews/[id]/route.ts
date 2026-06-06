import { getReviewUserRole, requireReviewUser } from "../_auth"

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireReviewUser(request)

    if ("error" in auth) return auth.error

    const { id } = await params
    const reviewId = Number(id)

    if (!Number.isInteger(reviewId) || reviewId <= 0) {
      return Response.json({ error: "Reseña inválida." }, { status: 400 })
    }

    const [reviewResult, role] = await Promise.all([
      auth.admin
        .schema("public")
        .from("reviews")
        .select("id, user_id")
        .eq("id", reviewId)
        .maybeSingle(),
      getReviewUserRole(auth.admin, auth.user.id),
    ])

    if (reviewResult.error) throw reviewResult.error

    if (!reviewResult.data) {
      return Response.json(
        { error: "No encontramos esa reseña." },
        { status: 404 }
      )
    }

    const isAdmin = role === "admin" || role === "super_admin"
    const isOwner = reviewResult.data.user_id === auth.user.id

    if (!isAdmin && !isOwner) {
      return Response.json(
        { error: "No tenés permiso para eliminar esta reseña." },
        { status: 403 }
      )
    }

    const { data, error } = await auth.admin
      .schema("public")
      .from("reviews")
      .delete()
      .eq("id", reviewId)
      .select("id")
      .maybeSingle()

    if (error) throw error

    if (!data) {
      return Response.json(
        { error: "No encontramos esa reseña." },
        { status: 404 }
      )
    }

    return Response.json({ ok: true })
  } catch (error) {
    console.error("REVIEWS DELETE ERROR:", error)

    return Response.json(
      { error: "No pudimos eliminar la reseña." },
      { status: 500 }
    )
  }
}
