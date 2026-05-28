import { getProductDiscount, getShippingCost } from "@/lib/store-config"

interface CartTotalItem {
  product: {
    id: number
    precio: number
  }
  quantity: number
}

export function calculateCartTotals(items: CartTotalItem[]) {
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
  const shipping = getShippingCost(productsTotal)
  const total = productsTotal + shipping

  return {
    subtotal,
    discount,
    productsTotal,
    shipping,
    total,
  }
}
