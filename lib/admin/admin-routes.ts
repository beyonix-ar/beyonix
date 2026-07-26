import type { UserRole } from "@/lib/auth/roles"

export const ADMIN_ROUTES = {
  dashboard: "/admin/dashboard",
  productos: "/admin/productos",
  compras: "/admin/compras",
  pedidos: "/admin/pedidos",
  modificaciones: "/admin/modificaciones",
  notificaciones: "/admin/notificaciones",
  "editor-masivo": "/admin/editor-masivo",
  eventos: "/admin/eventos",
  facturacion: "/admin/facturacion",
  clientes: "/admin/clientes",
  giftcard: "/admin/giftcard",
  "usuarios-roles": "/admin/usuarios-roles",
  auditoria: "/admin/auditoria",
} as const

export type AdminRouteKey = keyof typeof ADMIN_ROUTES

export const ADMIN_ROUTE_KEYS = Object.keys(ADMIN_ROUTES) as AdminRouteKey[]

const LEGACY_ADMIN_SECTION_KEYS: Record<string, AdminRouteKey> = {
  dashboard: "dashboard",
  productos: "productos",
  compras: "compras",
  pedidos: "pedidos",
  modificaciones: "modificaciones",
  banners: "modificaciones",
  notificaciones: "notificaciones",
  "editor-masivo": "editor-masivo",
  "acciones-masivas": "editor-masivo",
  eventos: "eventos",
  facturacion: "facturacion",
  clientes: "clientes",
  giftcard: "giftcard",
  creditos: "giftcard",
  "usuarios-roles": "usuarios-roles",
  usuarios: "usuarios-roles",
  auditoria: "auditoria",
}

const OPERATOR_ROUTES = new Set<AdminRouteKey>([
  "dashboard",
  "productos",
  "pedidos",
])

export function normalizeAdminRouteKey(value: string | null | undefined) {
  if (!value) return null
  return LEGACY_ADMIN_SECTION_KEYS[value] ?? null
}

export function getAdminRouteFromLegacySection(
  value: string | null | undefined,
) {
  const key = normalizeAdminRouteKey(value)
  return key ? ADMIN_ROUTES[key] : ADMIN_ROUTES.dashboard
}

export type LegacyAdminSearchParams = Record<
  string,
  string | string[] | undefined
>

export function getLegacyAdminRedirectTarget(
  params: LegacyAdminSearchParams,
) {
  const sectionValue = Array.isArray(params.section)
    ? params.section[0]
    : params.section
  const destination = getAdminRouteFromLegacySection(sectionValue)
  const preservedParams = new URLSearchParams()

  for (const [key, value] of Object.entries(params)) {
    if (key === "section" || value == null) continue

    if (Array.isArray(value)) {
      for (const item of value) preservedParams.append(key, item)
    } else {
      preservedParams.set(key, value)
    }
  }

  const query = preservedParams.toString()
  return query ? `${destination}?${query}` : destination
}

export function getAdminRouteKeyFromPathname(pathname: string) {
  for (const key of ADMIN_ROUTE_KEYS) {
    const href = ADMIN_ROUTES[key]
    if (pathname === href || pathname.startsWith(`${href}/`)) return key
  }

  return null
}

export function canAccessAdminRoute(
  role: UserRole | null | undefined,
  key: AdminRouteKey | null,
) {
  if (!key) return true
  if (role === "super_admin") return true
  if (role === "admin") return key !== "auditoria"
  if (role === "operador") return OPERATOR_ROUTES.has(key)
  return false
}
