export type DestructiveKind = "purchase" | "product" | "variant"
export interface DestructiveImpact {
  kind: DestructiveKind
  id: string
  product: string
  variant: string | null
  sku: string | null
  receivedQuantity: number
  totalCost: number
  currentStock: number
  projectedStock: number
  affectedSales: number
  variants: number
  references: { table: string; column: string; count: number; onDelete: string }[]
  confirmation: string
  fingerprint: string
}
export function canConfirmDestructiveOperation(impact: DestructiveImpact | null, confirmation: string, busy: boolean) {
  return Boolean(impact && confirmation === impact.confirmation && !busy)
}
export const destructiveReferenceLabels: Record<string, string> = {
  producto_variantes: "Variantes", product_cost_entries: "Compras", orden_items: "Ítems vendidos en pedidos",
  external_sales: "Ventas externas", mercadolibre_sales: "Ventas de Mercado Libre", business_expenses: "Gastos / donaciones",
  inventory_return_movements: "Devoluciones físicas", inventory_operation_log: "Registros auxiliares de inventario",
  inventory_variant_allocations: "Asignaciones de stock", stock_reservations: "Reservas activas",
  order_replacements: "Reemplazos", imagenes_producto: "Imágenes", producto_especificaciones: "Especificaciones",
  audit_logs: "Historial de auditoría conservado",
}
