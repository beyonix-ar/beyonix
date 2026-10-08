import { deriveVariantNameFromColor } from "./variant-color.ts"

/** Colores base del filtro de la tienda, en el orden en que se muestran. */
export const BASE_COLOR_ORDER = [
  "negro",
  "blanco",
  "gris",
  "azul",
  "rojo",
  "amarillo",
  "verde",
  "rosa",
  "violeta",
  "beige",
] as const

export type BaseColor = (typeof BASE_COLOR_ORDER)[number]

const BASE_COLOR_KEYWORDS: Record<BaseColor, string[]> = {
  negro: ["negro", "black"],
  blanco: ["blanco", "white"],
  gris: ["gris", "plata", "silver", "titanio", "grafito"],
  azul: ["azul", "celeste", "turquesa", "cyan", "sky", "lavanda"],
  rojo: ["rojo", "bordo", "coral"],
  amarillo: ["amarillo", "mostaza", "dorado"],
  verde: ["verde", "oliva", "menta", "mint", "sage", "lima", "lime", "aqua"],
  rosa: ["rosa", "fucsia", "salmon", "durazno", "terracota"],
  violeta: ["violeta", "morado", "lila", "purple"],
  beige: ["beige", "crema", "arena"],
}

function normalizeColorText(value: string) {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
}

/**
 * Color base de un hex (HSL). Permite filtrar por colores personalizados
 * cuyo nombre técnico es "COLOR #RRGGBB" y por el segundo color de una
 * variante bicolor, sin crear un color artificial "Azul/Rosa".
 */
export function hexToBaseColor(hex: string | null | undefined): BaseColor | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex?.trim() ?? "")
  if (!match) return null
  const value = Number.parseInt(match[1], 16)
  const [r, g, b] = [(value >> 16) & 255, (value >> 8) & 255, value & 255].map((channel) => channel / 255)
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const lightness = (max + min) / 2
  const delta = max - min
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1))
  let hue = 0
  if (delta !== 0) {
    if (max === r) hue = 60 * (((g - b) / delta) % 6)
    else if (max === g) hue = 60 * ((b - r) / delta + 2)
    else hue = 60 * ((r - g) / delta + 4)
  }
  if (hue < 0) hue += 360

  if (lightness <= 0.12) return "negro"
  if (lightness >= 0.94 && saturation < 0.5) return "blanco"
  if (saturation < 0.15) return lightness < 0.2 ? "negro" : "gris"
  if (hue >= 20 && hue < 55 && saturation < 0.75 && lightness >= 0.75) return "beige"
  if (hue < 15 || hue >= 345) return lightness >= 0.75 ? "rosa" : "rojo"
  if (hue < 40) return "rojo"
  if (hue < 70) return "amarillo"
  if (hue < 170) return "verde"
  if (hue < 255) return "azul"
  if (hue < 290) return "violeta"
  return "rosa"
}

export interface ColorFilterVariant {
  name: string
  colorHex: string | null
  secondaryColorHex?: string | null
}

/** Colores base de una variante: por nombre y por cada uno de sus colores. */
export function variantBaseColors(variant: ColorFilterVariant, productName = "") {
  const colors = new Set<BaseColor>()
  const text = normalizeColorText(`${variant.name} ${productName}`)
  for (const baseColor of BASE_COLOR_ORDER) {
    if (BASE_COLOR_KEYWORDS[baseColor].some((keyword) => text.includes(keyword))) colors.add(baseColor)
  }
  for (const hex of [variant.colorHex, variant.secondaryColorHex]) {
    const baseColor = hexToBaseColor(hex)
    if (baseColor) colors.add(baseColor)
  }
  return colors
}

/** Nombre legible de un color suelto: paleta conocida o, si no, su color base. */
export function readableColorName(hex: string | null | undefined) {
  const named = deriveVariantNameFromColor(hex)
  if (!named.startsWith("COLOR #")) return named
  return hexToBaseColor(hex)?.toUpperCase() ?? named
}

/** Color principal de un nombre persistido ("AZUL / ROSA" → "AZUL"). */
export function primaryColorName(variantName: string) {
  return variantName.split(" / ")[0].trim()
}

/**
 * Nombre persistido de una variante: el principal elegido y, si es bicolor,
 * " / " + el segundo color ("AZUL / ROSA"). Sin segundo color queda igual.
 */
export function deriveDualColorVariantName(primaryName: string, secondaryHex: string | null | undefined) {
  const primary = primaryColorName(primaryName)
  return secondaryHex ? `${primary} / ${readableColorName(secondaryHex)}` : primary
}
