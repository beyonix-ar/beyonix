/**
 * Tipos de gestion que el backend (app/api/admin/orders/[id]/credit-note/route.ts)
 * acepta sin exigir productos seleccionados, siempre que el ajuste manual
 * resultante sea mayor a cero. El backend solo valida `totalAmount > 0`
 * (itemsAmount + manualAmount) sin importar el tipo de operacion; esta lista
 * refleja unicamente los dos tipos de gestion cuya semantica ya asume que
 * pueden no involucrar productos puntuales.
 */
export const CREDIT_NOTE_OPERATION_TYPES_WITHOUT_REQUIRED_ITEMS = [
  "ajuste_manual",
  "reembolso_excepcional",
] as const

/**
 * Determina si el wizard puede avanzar del paso 1 (Productos) al paso 2
 * (Resolucion) sin bloquear artificialmente los casos que el backend ya
 * admite sin productos seleccionados.
 */
export function canProceedPastProductsStep(
  operationType: string,
  selectedCreditUnits: number,
): boolean {
  if (selectedCreditUnits > 0) return true

  return (
    CREDIT_NOTE_OPERATION_TYPES_WITHOUT_REQUIRED_ITEMS as readonly string[]
  ).includes(operationType)
}

/**
 * Determina si un tipo de gestion representa una devolucion iniciada por el
 * cliente (y por lo tanto exige un order_claims real para el pedido) o un
 * ajuste administrativo/contable (que no depende de que exista un reclamo).
 * Misma regla que el RPC begin_partial_credit_note
 * (supabase/migrations/20260825090000_credit_note_requires_claim.sql) exige
 * de forma autoritativa; esta funcion solo permite dar un mensaje mas claro
 * antes de llamar al RPC.
 */
export function operationRequiresClaim(operationType: string): boolean {
  return !(
    CREDIT_NOTE_OPERATION_TYPES_WITHOUT_REQUIRED_ITEMS as readonly string[]
  ).includes(operationType)
}
