/**
 * Canonicalización de ítems de carrito para claves de caché/dedupe de
 * cotización de envío (prefetch del carrito, caché cliente del checkout,
 * dedupe server-side de `quoteAndreaniCheckout`). Deliberadamente NO es
 * `server-only`: la usa tanto código de servidor como el módulo cliente
 * `lib/andreani/checkout-quote-client.ts`.
 *
 * Es conceptualmente compatible con `canonicalizeQuoteBinding` en
 * `lib/cart/checkout-shipping.ts` (mismo agrupado por
 * productId+variantId+conditionedStockId, mismo orden), pero deliberadamente
 * separada de ese archivo: esa canonicalización es parte de la firma HMAC y
 * no debe depender de ni ser modificada por cambios en lógica de caché.
 */

export interface CheckoutQuoteItemInput {
  productId: number
  quantity: number
  variantId: number | null
  conditionedStockId: string | null
}

interface CheckoutQuoteItemLike {
  productId: number
  quantity: number
  variantId?: number | null
  conditionedStockId?: string | null
}

/**
 * Agrupa líneas duplicadas (mismo producto+variante+stock condicionado)
 * sumando cantidades, y ordena de forma determinística. El resultado es
 * estable sin importar el orden de entrada -- dos carritos con los mismos
 * ítems en distinto orden producen la misma secuencia canónica.
 */
export function canonicalizeCheckoutQuoteItems(
  items: readonly CheckoutQuoteItemLike[],
): CheckoutQuoteItemInput[] {
  const grouped = new Map<string, CheckoutQuoteItemInput>()

  for (const item of items) {
    const conditionedStockId = item.conditionedStockId ?? null
    const variantId = conditionedStockId ? null : item.variantId ?? null
    const key = `${item.productId}:${variantId ?? ""}:${conditionedStockId ?? ""}`
    const existing = grouped.get(key)

    grouped.set(key, {
      productId: item.productId,
      quantity: (existing?.quantity ?? 0) + item.quantity,
      variantId,
      conditionedStockId,
    })
  }

  return [...grouped.values()].sort(
    (left, right) =>
      left.productId - right.productId ||
      (left.variantId ?? 0) - (right.variantId ?? 0) ||
      (left.conditionedStockId ?? "").localeCompare(
        right.conditionedStockId ?? "",
      ),
  )
}
