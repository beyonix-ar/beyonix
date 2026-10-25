import { sanitizeRichDescription } from "../../../../lib/products/rich-description.ts"
import type { SupabaseProductoVariante } from "../../../../lib/supabase/types.ts"
import type { ProductoFormState } from "./types.ts"

const TEXT_FIELDS = [
  "nombre",
  "sku",
  "slug",
  "video_url",
  "precio_anterior",
  "targetMarginPercent",
  "categoria_id",
  "peso_empaquetado_kg",
  "alto_paquete_cm",
  "ancho_paquete_cm",
  "largo_paquete_cm",
] as const satisfies readonly (keyof ProductoFormState)[]

/**
 * La ficha principal (todo lo que guarda updateProductoCatalog) difiere de la
 * última versión guardada. Imágenes, especificaciones y modo de color se
 * guardan al instante por su cuenta y no forman parte de este estado.
 */
export function hasProductFormChanges(
  current: ProductoFormState,
  saved: ProductoFormState,
) {
  if (TEXT_FIELDS.some((field) => current[field].trim() !== saved[field].trim())) return true
  if (current.pricingMode !== saved.pricingMode) return true
  if (current.destacado !== saved.destacado || current.activo !== saved.activo) return true
  if (
    sanitizeRichDescription(current.descripcion) !==
    sanitizeRichDescription(saved.descripcion)
  ) {
    return true
  }

  // Con margen objetivo el precio lo deriva la cuenta en vivo (y el servidor
  // lo recalcula al guardar): sólo cuenta como cambio si cambió el método o
  // el margen, ya comparados arriba.
  if (current.pricingMode === "target_margin") return false
  return current.precio.trim() !== saved.precio.trim()
}

/** Activación de variantes elegida en el editor y todavía no guardada. */
export function hasVariantStateChanges(
  pendingStates: Record<number, boolean>,
  persistedVariants: readonly SupabaseProductoVariante[],
) {
  return persistedVariants.some(
    (variant) =>
      variant.id in pendingStates &&
      pendingStates[variant.id] !== (variant.activo !== false),
  )
}
