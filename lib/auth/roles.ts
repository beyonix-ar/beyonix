export const USER_ROLES = [
  "cliente",
  "operador",
  "admin",
  "super_admin",
] as const

export type UserRole = (typeof USER_ROLES)[number]

export const INTERNAL_ROLES: UserRole[] = [
  "operador",
  "admin",
  "super_admin",
]

export const PROTECTED_SUPER_ADMIN_EMAIL = "espinosatrabajo@gmail.com"

export function isUserRole(value: unknown): value is UserRole {
  return USER_ROLES.includes(value as UserRole)
}

export function isInternalRole(role: UserRole | null | undefined) {
  return Boolean(role && INTERNAL_ROLES.includes(role))
}

export function canManageUsers(role: UserRole | null | undefined) {
  return role === "admin" || role === "super_admin"
}

export function canViewSensitiveNumbers(role: UserRole | null | undefined) {
  return role === "admin" || role === "super_admin"
}

export function canViewAudit(role: UserRole | null | undefined) {
  return role === "super_admin"
}

export const ROLE_LABELS: Record<UserRole, string> = {
  cliente: "Cliente",
  operador: "Operador",
  admin: "Admin",
  super_admin: "Super admin",
}
