import { getProductDiscount, getShippingCost } from "@/lib/store-config"

interface CartTotalItem {
  product: {
    id: number
    precio: number
  }
  quantity: number
}

interface CartTotalsOptions {
  shippingCost?: number
}

export function calculateCartTotals(
  items: CartTotalItem[],
  options: CartTotalsOptions = {}
) {
  const subtotal = items.reduce((acc, item) => {
    const price = Number.isFinite(item.product.precio) ? item.product.precio : 0
    return acc + price * item.quantity
  }, 0)

  const discount = items.reduce((acc, item) => {
    const price = Number.isFinite(item.product.precio) ? item.product.precio : 0
    const rate = getProductDiscount(item.product.id)

    return acc + price * rate * item.quantity
  }, 0)

  const productsTotal = Math.max(subtotal - discount, 0)
  const shipping =
    typeof options.shippingCost === "number"
      ? Math.max(options.shippingCost, 0)
      : getShippingCost(productsTotal)
  const total = productsTotal + shipping

  return {
    subtotal,
    discount,
    productsTotal,
    shipping,
    total,
  }
}
