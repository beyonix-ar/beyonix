import { createAdminClient } from "@/lib/supabase/admin"
import {
  isInternalRole,
  isUserRole,
  type UserRole,
} from "@/lib/auth/roles"

export interface AdminApiAuth {
  admin: ReturnType<typeof createAdminClient>
  user: {
    id: string
    email: string | null
  }
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
  // getClaims() verifica firma y expiración. Con claves asimétricas reutiliza
  // el JWKS cacheado; si el token usa firma simétrica, el SDK vuelve de forma
  // segura a getUser(). El rol efectivo siempre se relee desde `profiles`.
  const { data: claimsData, error: claimsError } = await admin.auth.getClaims(token)
  const claims = claimsData?.claims
  const userId = typeof claims?.sub === "string" ? claims.sub : null

  if (claimsError || !userId) {
    return {
      error: Response.json({ error: "No autorizado." }, { status: 401 }),
    }
  }

  const user = {
    id: userId,
    email: typeof claims?.email === "string" ? claims.email : null,
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
