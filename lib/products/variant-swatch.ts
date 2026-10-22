import type { CSSProperties } from "react"

import { isRandomColorName } from "./color-mode.ts"

/** Colores del swatch "Aleatorio" (no representan ningún color físico). */
export const RANDOM_SWATCH_COLORS = ["#EF4444", "#FACC15", "#22C55E", "#38BDF8", "#6366F1", "#EC4899"] as const

/** Swatch "Aleatorio": varios colores (no representa ningún color físico). */
export const RANDOM_SWATCH_STYLE: CSSProperties = {
  backgroundColor: "#64748B",
  backgroundImage: `conic-gradient(${RANDOM_SWATCH_COLORS.map((color, index) => `${color} ${index * 60}deg ${(index + 1) * 60}deg`).join(", ")})`,
}

/**
 * Fondo de un swatch de variante: un color sólido o, en una variante bicolor,
 * mitad y mitad (50/50, corte vertical nítido). Sin colores inventados. Con
 * `variantName` = ALEATORIO (aleatorio simple) usa el swatch multicolor.
 */
export function variantSwatchStyle(
  colorHex: string | null | undefined,
  secondaryColorHex?: string | null,
  variantName?: string | null,
): CSSProperties {
  if (isRandomColorName(variantName)) return RANDOM_SWATCH_STYLE
  if (!colorHex) return {}
  if (!secondaryColorHex) return { backgroundColor: colorHex }
  return {
    backgroundColor: colorHex,
    backgroundImage: `linear-gradient(90deg, ${colorHex} 0 50%, ${secondaryColorHex} 50% 100%)`,
  }
}
