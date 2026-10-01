/**
 * Selección de unidades afectadas al iniciar un reclamo. Cada unidad del
 * pedido se elige por separado (aunque sean varias del mismo producto); al
 * enviar se agrupan por ítem en `{ order_item_id, quantity }`, el mismo
 * contrato que ya valida la API de reclamos.
 */

export const WHOLE_ORDER_SELECTION = "order"

export interface ClaimableOrderItem {
  id: number
  cantidad: number
}

export interface ClaimUnit {
  key: string
  itemId: number
  unitNumber: number
  unitCount: number
}

export function buildClaimUnits(items: ClaimableOrderItem[]): ClaimUnit[] {
  return items.flatMap((item) => {
    const unitCount = Math.max(0, Math.floor(Number(item.cantidad) || 0))
    return Array.from({ length: unitCount }, (_, index) => ({
      key: `${item.id}:${index + 1}`,
      itemId: item.id,
      unitNumber: index + 1,
      unitCount,
    }))
  })
}

/** Con una única unidad en todo el pedido, esa unidad es el reclamo: queda fija. */
export function isSingleUnitClaim(units: ClaimUnit[]) {
  return units.length === 1
}

/** Una sola unidad: seleccionada. Dos o más: ninguna, el cliente marca las que fallan. */
export function getInitialClaimSelection(units: ClaimUnit[]): string[] {
  return isSingleUnitClaim(units) ? [units[0].key] : []
}

export function toggleClaimUnit(selection: string[], key: string, units: ClaimUnit[]): string[] {
  if (isSingleUnitClaim(units)) return getInitialClaimSelection(units)
  const withoutWholeOrder = selection.filter((item) => item !== WHOLE_ORDER_SELECTION)
  return withoutWholeOrder.includes(key)
    ? withoutWholeOrder.filter((item) => item !== key)
    : [...withoutWholeOrder, key]
}

export function isWholeOrderSelection(selection: string[]) {
  return selection.includes(WHOLE_ORDER_SELECTION)
}

/** Unidades elegidas agrupadas por ítem, en el formato de la API de reclamos. */
export function toClaimAffectedItems(
  selection: string[],
  units: ClaimUnit[],
): Array<{ order_item_id: number; quantity: number }> {
  if (isWholeOrderSelection(selection)) return []
  const quantities = new Map<number, number>()
  for (const unit of units) {
    if (selection.includes(unit.key)) {
      quantities.set(unit.itemId, (quantities.get(unit.itemId) ?? 0) + 1)
    }
  }
  return [...quantities].map(([order_item_id, quantity]) => ({ order_item_id, quantity }))
}
