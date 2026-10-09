// Venta por color de un producto (productos.modo_color):
//   especifico           el cliente elige color.
//   aleatorio_simple     un único artículo con stock total; el color físico no
//                        se sigue (a lo sumo una variante, llamada ALEATORIO).
//   aleatorio_variantes  random fulfillment: el cliente no elige, pero el stock,
//                        la reserva, el armado y la devolución son por variante.

export type ProductColorMode = "especifico" | "aleatorio_simple" | "aleatorio_variantes"

export const PRODUCT_COLOR_MODES: readonly ProductColorMode[] = ["especifico", "aleatorio_simple", "aleatorio_variantes"]

/** Nombre persistido de la variante única de un producto aleatorio simple. */
export const RANDOM_COLOR_NAME = "ALEATORIO"
/** Lo que ve el cliente en cualquier modo aleatorio (PDP, carrito, checkout). */
export const RANDOM_VARIANT_LABEL = "Aleatorio según disponibilidad"

export const COLOR_MODE_LABELS: Record<ProductColorMode, string> = {
  especifico: "Color específico",
  aleatorio_simple: "Aleatorio — sin seguimiento de color",
  aleatorio_variantes: "Aleatorio — con variantes físicas",
}

export const COLOR_MODE_HELP: Record<ProductColorMode, string> = {
  especifico: "El cliente elige el color y cada variante tiene su propio stock.",
  aleatorio_simple: "El cliente recibe cualquier color/modelo disponible. El stock y los códigos se gestionan como un único artículo.",
  aleatorio_variantes: "El cliente no elige color, pero BEYONIX mantiene stock y trazabilidad por variante física.",
}

export function isProductColorMode(value: unknown): value is ProductColorMode {
  return typeof value === "string" && (PRODUCT_COLOR_MODES as readonly string[]).includes(value)
}

/** Modo efectivo; sin la columna (datos viejos) se deriva de venta_aleatoria. */
export function getProductColorMode(product: { modo_color?: string | null; venta_aleatoria?: boolean | null }): ProductColorMode {
  if (isProductColorMode(product.modo_color)) return product.modo_color
  return product.venta_aleatoria ? "aleatorio_variantes" : "especifico"
}

/** Nombre de variante "aleatorio": el persistido o el que ve el cliente. */
export function isRandomColorName(name: string | null | undefined) {
  const value = name?.trim().toUpperCase()
  return value === RANDOM_COLOR_NAME || value === RANDOM_VARIANT_LABEL.toUpperCase()
}

/** Por qué un modo no se puede elegir con estas variantes (null = se puede). */
export function colorModeBlocker(mode: ProductColorMode, variantCount: number) {
  if (mode === "aleatorio_variantes" && variantCount < 2) return "Necesita al menos dos variantes físicas."
  if (mode === "aleatorio_simple" && variantCount > 1) {
    return `Tiene ${variantCount} variantes: dejá una sola (con el stock total) o usá “con variantes físicas”.`
  }
  return null
}
