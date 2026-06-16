import type { User } from "@supabase/supabase-js"

import { createAdminClient } from "@/lib/supabase/admin"
import {
  isInternalRole,
  isUserRole,
  type UserRole,
} from "@/lib/auth/roles"

export interface AdminApiAuth {
  admin: ReturnType<typeof createAdminClient>
  user: User
  profile: {
    id: string
    email: string | null
    rol: UserRole
  }
}

export async function requireInternalUser(
  request: Request,
  allowedRoles?: UserRole[]
): Promise<AdminApiAuth | { error: Response }> {
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
    .select("id, email, rol")
    .eq("id", user.id)
    .single()

  const role = profile?.rol

  if (
    profileError ||
    !profile ||
    !isUserRole(role) ||
    !isInternalRole(role) ||
    (allowedRoles && !allowedRoles.includes(role))
  ) {
    return {
      error: Response.json({ error: "Acceso denegado." }, { status: 403 }),
    }
  }

  return {
    admin,
    user,
    profile: {
      id: profile.id,
      email: profile.email,
      rol: role,
    },
  }
}
