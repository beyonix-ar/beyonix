const SKU_ALIASES: Record<string, string> = {
  MATEINOXNEGRO001: "MTN01",
  MATEINOXROSA001: "MTR01",
  MATEINOXVERDE001: "MTV01",
}

export function normalizeMercadoLibreSku(value: unknown) {
  return String(value ?? "").trim().toLocaleUpperCase("es")
}

export function getCanonicalCatalogSku(value: unknown) {
  const normalizedSku = normalizeMercadoLibreSku(value)
  return SKU_ALIASES[normalizedSku] ?? normalizedSku
}
