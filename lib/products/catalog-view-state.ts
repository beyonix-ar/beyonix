export type CatalogLoadStatus = "loading" | "ready" | "error"

export type CatalogViewState =
  | "loading"
  | "error"
  | "incomplete"
  | "empty"
  | "no-matches"
  | "results"

interface CatalogViewInput {
  loadStatus: CatalogLoadStatus
  totalProducts: number
  visibleProducts: number
}

/**
 * Qué mostrar en la grilla del catálogo. Un fallo de carga nunca se presenta
 * como "catálogo vacío" ni como "sin coincidencias": si la carga completa
 * falló, cero coincidencias sobre la primera página del servidor no prueba que
 * el catálogo completo no tenga resultados.
 */
export function getCatalogViewState({
  loadStatus,
  totalProducts,
  visibleProducts,
}: CatalogViewInput): CatalogViewState {
  if (visibleProducts > 0) return "results"
  if (loadStatus === "loading") return "loading"
  if (loadStatus === "error") return totalProducts > 0 ? "incomplete" : "error"
  return totalProducts > 0 ? "no-matches" : "empty"
}

/** Hay productos visibles pero la carga completa falló: se avisa sin ocultarlos. */
export function isCatalogPartiallyLoaded({
  loadStatus,
  visibleProducts,
}: Pick<CatalogViewInput, "loadStatus" | "visibleProducts">): boolean {
  return loadStatus === "error" && visibleProducts > 0
}
