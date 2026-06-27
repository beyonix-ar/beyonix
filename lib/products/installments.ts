import type { SupabaseProducto } from "@/lib/supabase/types"

export function getInstallmentsLabel(product: SupabaseProducto) {
  if (
    product.cuotas_sin_interes !== true ||
    (product.cuotas_maximas !== 3 && product.cuotas_maximas !== 6)
  ) {
    return null
  }

  return `${product.cuotas_maximas} cuotas sin interés`
}
