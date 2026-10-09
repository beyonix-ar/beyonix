import type { CSSProperties } from "react"

import { isRandomColorName } from "./color-mode.ts"

/** Swatch "Aleatorio": varios colores (no representa ningún color físico). */
export const RANDOM_SWATCH_STYLE: CSSProperties = {
  backgroundColor: "#64748B",
  backgroundImage: "conic-gradient(#EF4444 0 60deg, #FACC15 60deg 120deg, #22C55E 120deg 180deg, #38BDF8 180deg 240deg, #6366F1 240deg 300deg, #EC4899 300deg 360deg)",
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
