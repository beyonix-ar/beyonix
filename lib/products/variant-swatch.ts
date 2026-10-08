import type { CSSProperties } from "react"

/**
 * Fondo de un swatch de variante: un color sólido o, en una variante bicolor,
 * mitad y mitad (50/50, corte vertical nítido). Sin colores inventados.
 */
export function variantSwatchStyle(
  colorHex: string | null | undefined,
  secondaryColorHex?: string | null,
): CSSProperties {
  if (!colorHex) return {}
  if (!secondaryColorHex) return { backgroundColor: colorHex }
  return {
    backgroundColor: colorHex,
    backgroundImage: `linear-gradient(90deg, ${colorHex} 0 50%, ${secondaryColorHex} 50% 100%)`,
  }
}
