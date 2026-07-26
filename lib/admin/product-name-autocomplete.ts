const PRODUCT_COLOR_SUFFIXES = [
  "azul marino",
  "azul francia",
  "azul eléctrico",
  "blanco hueso",
  "gris espacial",
  "negro mate",
  "negro brillante",
  "rosa gold",
  "rose gold",
  "verde agua",
  "verde lima",
  "verde militar",
  "amarillo",
  "amarilla",
  "azul",
  "beige",
  "blanco",
  "blanca",
  "bordó",
  "bordo",
  "celeste",
  "cian",
  "crema",
  "dorado",
  "dorada",
  "fucsia",
  "gris",
  "lila",
  "magenta",
  "marrón",
  "marron",
  "morado",
  "morada",
  "multicolor",
  "naranja",
  "natural",
  "negro",
  "negra",
  "oro",
  "plateado",
  "plateada",
  "rojo",
  "roja",
  "rosa",
  "rosado",
  "rosada",
  "transparente",
  "turquesa",
  "verde",
  "violeta",
] as const

const COLOR_SUFFIX_PATTERN = new RegExp(
  String.raw`(?:^|\s+|\s*[-–—|/,·]\s*)(?:\(\s*)?(?:color\s*:?\s*)?(?:${PRODUCT_COLOR_SUFFIXES
    .map((color) => color.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .sort((left, right) => right.length - left.length)
    .join("|")})(?:\s*\))?\s*$`,
  "iu",
)

export function withoutTrailingProductColor(value: string) {
  let result = value.trim()

  while (result && COLOR_SUFFIX_PATTERN.test(result)) {
    const next = result
      .replace(COLOR_SUFFIX_PATTERN, "")
      .replace(/\s*[-–—|/,·]\s*$/, "")
      .trim()

    if (!next || next === result) break
    result = next
  }

  return result
}

export function uniqueAutocompleteValues(
  values: Array<string | null | undefined>,
) {
  const seen = new Set<string>()
  const suggestions: string[] = []

  for (const rawValue of values) {
    const value = rawValue?.trim()
    if (!value) continue

    const key = value
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLocaleLowerCase("es")

    if (seen.has(key)) continue
    seen.add(key)
    suggestions.push(value)
  }

  return suggestions
}
