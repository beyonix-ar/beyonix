/**
 * Auditoría 4/7 (P0): cuánto de una venta ya devuelta físicamente todavía no
 * está cubierto por una nota de crédito autorizada. costOfGoodsSold ya
 * descontaba las unidades restockeadas, pero el ingreso (grossSales) recién
 * se ajusta cuando la NC llega a `authorized` -- que puede tardar o no
 * llegar. Mientras tanto, `getPendingReturnAdjustment` da el monto a restar
 * de trueProfit para no mostrar ganancia por una venta ya revertida. Una vez
 * la NC cubre la cantidad recibida, el resultado es 0 -- el ajuste normal de
 * `webCompletedRefunds` toma la posta, sin descontar dos veces.
 */
export function getUncoveredReturnedQuantity(
  receivedQuantity: number,
  creditedQuantity: number,
): number {
  const received = Math.max(0, receivedQuantity)
  const credited = Math.min(received, Math.max(0, creditedQuantity))
  return received - credited
}

export function getPendingReturnAdjustment(
  unitPrice: number,
  receivedQuantity: number,
  creditedQuantity: number,
): number {
  if (receivedQuantity <= 0) return 0
  return unitPrice * getUncoveredReturnedQuantity(receivedQuantity, creditedQuantity)
}
