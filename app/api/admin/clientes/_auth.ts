import { createAdminClient } from "@/lib/supabase/admin"

export async function requireAdmin(request: Request) {
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "")

  if (!token) {
    return {
      error: Response.json({ error: "No autorizado." }, { status: 401 }),
    }
  }

  const admin = createAdminClient()
  const { data: userData, error: userError } = await admin.auth.getUser(token)
  const user = userData.user

  if (userError || !user) {
    return {
      error: Response.json({ error: "No autorizado." }, { status: 401 }),
    }
  }

  const { data: profile, error: profileError } = await admin
    .from("profiles")
    .select("id, rol")
    .eq("id", user.id)
    .single()

  if (profileError || !profile || !["admin", "super_admin"].includes(profile.rol)) {
    return {
      error: Response.json({ error: "Acceso restringido." }, { status: 403 }),
    }
  }

  return {
    admin,
    user,
  }
}
