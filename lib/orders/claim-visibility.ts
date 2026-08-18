export type AdminClaimManagerMode = "all" | "messaging" | "claims"

/**
 * Determina si un claim debe listarse dentro de AdminClaimManager según el
 * modo activo. "all" (usado por la pestaña fusionada "Atención al
 * cliente") deliberadamente NO incluye `cancelar_compra`: las solicitudes
 * de cancelación tienen su propio flujo (RefundManagementPanel / pestaña
 * "Cancelación") y absorberlas acá duplicaría esa gestión.
 */
export function isClaimVisibleForMode(
  failureType: string | null | undefined,
  mode: AdminClaimManagerMode,
): boolean {
  if (mode === "messaging") return failureType === "consulta_pedido"
  if (mode === "claims") {
    return failureType !== "consulta_pedido" && failureType !== "cancelar_compra"
  }

  return failureType !== "cancelar_compra"
}

/**
 * El panel de decisión de stock devuelto (ReturnInventoryPanel) solo tiene
 * sentido para un reclamo formal con devolución física potencial: nunca
 * para un mensaje de ayuda (`consulta_pedido`) ni para una cancelación
 * (`cancelar_compra`), que no involucran reingreso de stock por esta vía.
 */
export function shouldShowReturnInventoryPanel(
  failureType: string | null | undefined,
): boolean {
  return failureType !== "consulta_pedido" && failureType !== "cancelar_compra"
}
