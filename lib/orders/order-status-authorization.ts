/**
 * Estados que la UI del panel admin reserva explícitamente a super_admin,
 * porque normalmente los actualiza Andreani y forzarlos a mano tiene
 * consecuencias operativas (ver ForcedStatusConfirmModal /
 * "Solo un superadministrador puede cambiarlo manualmente" en
 * app/admin/sections/pedidos/admin-pedidos.tsx). Esta misma restricción se
 * aplica server-side para que no pueda evadirse llamando a la API
 * directamente con un rol de menor jerarquía.
 */
export const SUPER_ADMIN_ONLY_ORDER_STATUSES = ["en_camino", "entregado"] as const

/**
 * Determina si `role` puede llevar un pedido al estado `estado`. Asume que
 * `role` ya fue validado como un rol interno habilitado (operador, admin o
 * super_admin) por el guard de autenticación de la ruta; esta función solo
 * aplica la restricción adicional sobre los estados reservados.
 */
export function canChangeOrderStatus(role: string, estado: string): boolean {
  if (
    (SUPER_ADMIN_ONLY_ORDER_STATUSES as readonly string[]).includes(estado)
  ) {
    return role === "super_admin"
  }

  return true
}
