import { requireInternalUser } from "@/lib/auth/admin-api"
import {
  PROTECTED_SUPER_ADMIN_EMAIL,
  isUserRole,
  type UserRole,
} from "@/lib/auth/roles"

const MANAGE_ROLES: UserRole[] = ["admin", "super_admin"]

export async function GET(request: Request) {
  const auth = await requireInternalUser(request, MANAGE_ROLES)
  if ("error" in auth) return auth.error

  const { data, error } = await auth.admin
    .from("profiles")
    .select("id, email, username, nombre, rol, created_at")
    .order("created_at", { ascending: false })

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  return Response.json({ users: data ?? [] })
}

export async function PATCH(request: Request) {
  const auth = await requireInternalUser(request, MANAGE_ROLES)
  if ("error" in auth) return auth.error

  const body = (await request.json()) as { userId?: string; role?: unknown }
  const userId = body.userId?.trim()
  const nextRole = body.role

  if (!userId || !isUserRole(nextRole)) {
    return Response.json({ error: "Solicitud inválida." }, { status: 400 })
  }

  const { data: target, error: targetError } = await auth.admin
    .from("profiles")
    .select("id, email, username, nombre, rol")
    .eq("id", userId)
    .single()

  if (targetError || !target || !isUserRole(target.rol)) {
    return Response.json({ error: "Usuario no encontrado." }, { status: 404 })
  }

  const targetEmail = target.email?.trim().toLowerCase()
  if (targetEmail === PROTECTED_SUPER_ADMIN_EMAIL) {
    return Response.json(
      { error: "El super administrador principal está protegido." },
      { status: 403 }
    )
  }

  if (
    auth.profile.rol === "admin" &&
    (target.rol === "super_admin" || nextRole === "super_admin")
  ) {
    return Response.json(
      { error: "Un admin no puede asignar ni modificar super administradores." },
      { status: 403 }
    )
  }

  const { data: updated, error: updateError } = await auth.admin
    .from("profiles")
    .update({ rol: nextRole })
    .eq("id", userId)
    .eq("rol", target.rol)
    .select("id, email, username, nombre, rol, created_at")
    .single()

  if (updateError || !updated) {
    return Response.json(
      { error: updateError?.message ?? "No se pudo cambiar el rol." },
      { status: 409 }
    )
  }

  await auth.admin.from("audit_logs").insert({
    table_name: "profiles",
    action: "UPDATE",
    record_id: userId,
    actor_user_id: auth.user.id,
    actor_email: auth.user.email ?? auth.profile.email,
    before_data: { rol: target.rol },
    after_data: { rol: nextRole },
  })

  return Response.json({ user: updated })
}
