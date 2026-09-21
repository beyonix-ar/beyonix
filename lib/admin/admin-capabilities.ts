import type { UserRole } from "@/lib/auth/roles"

export type AdminCapability =
  | "view_admin"
  | "manage_catalog"
  | "adjust_stock"
  | "manage_financials"
  | "manage_returns"
  | "manage_replacements"
  | "manage_settings"
  | "force_delete"
  | "view_audit"

const ROLE_CAPABILITIES: Record<UserRole, ReadonlySet<AdminCapability>> = {
  cliente: new Set(),
  operador: new Set(["view_admin"]),
  admin: new Set([
    "view_admin",
    "manage_catalog",
    "adjust_stock",
    "manage_financials",
    "manage_returns",
    "manage_replacements",
    "manage_settings",
  ]),
  super_admin: new Set([
    "view_admin",
    "manage_catalog",
    "adjust_stock",
    "manage_financials",
    "manage_returns",
    "manage_replacements",
    "manage_settings",
    "force_delete",
    "view_audit",
  ]),
}

export function hasAdminCapability(
  role: UserRole | string | null | undefined,
  capability: AdminCapability,
) {
  if (!role || !Object.hasOwn(ROLE_CAPABILITIES, role)) return false
  return ROLE_CAPABILITIES[role as UserRole].has(capability)
}

export function getAdminCapabilities(role: UserRole | string | null | undefined) {
  return {
    canViewAdmin: hasAdminCapability(role, "view_admin"),
    canManageCatalog: hasAdminCapability(role, "manage_catalog"),
    canAdjustStock: hasAdminCapability(role, "adjust_stock"),
    canManageFinancials: hasAdminCapability(role, "manage_financials"),
    canManageReturns: hasAdminCapability(role, "manage_returns"),
    canManageReplacements: hasAdminCapability(role, "manage_replacements"),
    canManageSettings: hasAdminCapability(role, "manage_settings"),
    canForceDelete: hasAdminCapability(role, "force_delete"),
    canViewAudit: hasAdminCapability(role, "view_audit"),
  } as const
}
