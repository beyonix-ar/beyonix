import type { User } from "@supabase/supabase-js"

import { createAdminClient } from "@/lib/supabase/admin"

export type ReviewUserRole = "cliente" | "admin" | "super_admin"

export async function getReviewUserRole(
  admin: ReturnType<typeof createAdminClient>,
  userId: string
): Promise<ReviewUserRole> {
  const { data, error } = await admin
    .schema("public")
    .from("profiles")
    .select("rol")
    .eq("id", userId)
    .maybeSingle()

  if (error || !data) return "cliente"

  return data.rol as ReviewUserRole
}

export async function getOptionalReviewUser(request: Request) {
  const admin = createAdminClient()
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "")

  if (!token) {
    return { admin, user: null as User | null }
  }

  const { data, error } = await admin.auth.getUser(token)

  return {
    admin,
    user: error ? null : data.user,
  }
}

export async function requireReviewUser(request: Request) {
  const auth = await getOptionalReviewUser(request)

  if (!auth.user) {
    return {
      error: Response.json(
        { error: "Tenés que iniciar sesión para dejar una reseña." },
        { status: 401 }
      ),
    }
  }

  return {
    admin: auth.admin,
    user: auth.user,
  }
}
