import type { SupabasePedido, SupabasePedidoItem } from "@/lib/supabase/types"

export type CreditNoteItemAllocation = {
  orderItemId: number
  soldQuantity: number
  rawUnitAmount: number
  effectiveLineAmount: number
  effectiveUnitAmount: number
}

export function roundCreditMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

/**
 * Distribuye los descuentos comerciales del pedido entre las líneas.
 * El saldo usado es un medio de pago y no reduce el valor fiscal del artículo.
 * El envío se mantiene fuera de las líneas y puede acreditarse como ajuste.
 */
export function allocateEffectiveOrderItemAmounts(
  order: Pick<SupabasePedido, "total" | "shipping_cost_charged">,
  items: Array<Pick<SupabasePedidoItem, "id" | "cantidad" | "precio">>,
): CreditNoteItemAllocation[] {
  const validItems = items.filter(
    (item) =>
      Number.isInteger(Number(item.cantidad)) &&
      Number(item.cantidad) > 0 &&
      Number.isFinite(Number(item.precio)) &&
      Number(item.precio) >= 0,
  )
  const rawLines = validItems.map((item) =>
    roundCreditMoney(Number(item.precio) * Number(item.cantidad)),
  )
  const rawSubtotal = roundCreditMoney(
    rawLines.reduce((sum, amount) => sum + amount, 0),
  )
  const orderTotal = Math.max(0, Number(order.total ?? 0))
  const shipping = Math.max(0, Number(order.shipping_cost_charged ?? 0))
  const fiscalItemPool = roundCreditMoney(Math.max(0, orderTotal - shipping))
  const allocationPool =
    rawSubtotal > 0 && fiscalItemPool > 0 ? fiscalItemPool : rawSubtotal

  let allocated = 0
  return validItems.map((item, index) => {
    const quantity = Number(item.cantidad)
    const lineAmount =
      index === validItems.length - 1
        ? roundCreditMoney(allocationPool - allocated)
        : roundCreditMoney(
            rawSubtotal > 0
              ? (rawLines[index] / rawSubtotal) * allocationPool
              : 0,
          )
    allocated = roundCreditMoney(allocated + lineAmount)

    return {
      orderItemId: Number(item.id),
      soldQuantity: quantity,
      rawUnitAmount: roundCreditMoney(Number(item.precio)),
      effectiveLineAmount: lineAmount,
      effectiveUnitAmount:
        quantity > 0 ? Number((lineAmount / quantity).toFixed(4)) : 0,
    }
  })
}

export function calculatePartialLineAmount(
  allocation: CreditNoteItemAllocation,
  quantity: number,
) {
  if (quantity <= 0) return 0
  if (quantity >= allocation.soldQuantity) {
    return allocation.effectiveLineAmount
  }
  return roundCreditMoney(allocation.effectiveUnitAmount * quantity)
}
