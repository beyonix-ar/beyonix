import { requireInternalUser } from "@/lib/auth/admin-api"

export async function requireAdmin(request: Request) {
  return requireInternalUser(request, ["admin", "super_admin"])
}

export async function requireOperator(request: Request) {
  return requireInternalUser(request, ["operador", "admin", "super_admin"])
}
