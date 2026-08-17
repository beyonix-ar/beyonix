import {
  getStoreCategorias,
  getStoreProductos,
} from "@/lib/supabase/queries/store"
import { ProductsPageLayout } from "@/components/products/products-page-layout"

export const revalidate = 60

const INITIAL_PRODUCTS_LIMIT = 24

// Nota: intencionalmente no se lee `searchParams` acá. Hacerlo forzaría
// esta página a renderizar 100% dinámico en cada request (pierde el
// prerender/ISR de `revalidate`), sólo para precargar el buscador en el
// caso poco frecuente de un deep-link "/productos?search=...". Ese caso
// se resuelve client-side (ver SearchParamSync en ProductsPageLayout)
// sin bloquear el contenido principal, que es lo que sí importa server-first.
export default async function ProductosPage() {
  const [initialProducts, initialCategories] = await Promise.all([
    getStoreProductos({ limit: INITIAL_PRODUCTS_LIMIT }).catch(() => []),
    getStoreCategorias().catch(() => []),
  ])

  return (
    <ProductsPageLayout
      initialProducts={initialProducts}
      initialCategories={initialCategories}
    />
  )
}