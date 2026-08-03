export function normalizeMercadoLibreSku(value: unknown) {
  return String(value ?? "").trim().toLocaleUpperCase("es")
}

export function getCanonicalCatalogSku(value: unknown) {
  return normalizeMercadoLibreSku(value)
}
