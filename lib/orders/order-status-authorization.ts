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
 * BLOQUEANTE 1 (auditoría Andreani Parte 3/4): "cancelado" nunca es un
 * estado operativo más -- tiene su propio flujo administrativo dedicado
 * (public.admin_cancel_order, con todas sus guardas de negocio: Andreani en
 * curso, ya facturado, ya despachado). Ningún rol puede aplicarlo a través
 * de este mecanismo genérico -- ver app/api/admin/pedidos/[id]/status/route.ts,
 * que además lo rechaza explícitamente ANTES de leer el pedido.
 */
const NEVER_VIA_GENERIC_STATUS_CHANGE = ["cancelado"] as const

/**
 * Determina si `role` puede llevar un pedido al estado `estado` a través del
 * mecanismo GENÉRICO de cambio de estado. Asume que `role` ya fue validado
 * como un rol interno habilitado (operador, admin o super_admin) por el
 * guard de autenticación de la ruta; esta función sólo aplica las
 * restricciones adicionales sobre estados reservados o completamente
 * excluidos de este mecanismo.
 */
export function canChangeOrderStatus(role: string, estado: string): boolean {
  if ((NEVER_VIA_GENERIC_STATUS_CHANGE as readonly string[]).includes(estado)) {
    return false
  }

  if (
    (SUPER_ADMIN_ONLY_ORDER_STATUSES as readonly string[]).includes(estado)
  ) {
    return role === "super_admin"
  }

  return true
}
