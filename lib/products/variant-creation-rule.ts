import { ADMIN_ROUTES } from "../admin/admin-routes.ts"

// Una variante física nueva nace de una compra / ingreso de mercadería
// (Admin → Compras), nunca de un alta libre desde el editor de Productos: así
// no existen variantes sin compra, costo, stock ni trazabilidad.
export const VARIANT_CREATION_RULE_MESSAGE =
  "Las nuevas variantes se crean al registrar una compra de mercadería."

export const VARIANT_CREATION_RULE_CODE = "variant_creation_requires_purchase"

export const VARIANT_REMOVAL_RULE_TEXT =
  "Si la variante tuvo stock, compras, ventas, movimientos, reservas o códigos, no se borra: se archiva (queda inactiva) para conservar su historial. Sólo se elimina si nunca tuvo actividad."

/** Query param con el que Compras abre el ingreso preseleccionando el producto. */
export const PURCHASE_PRODUCT_QUERY_PARAM = "producto"

export function purchaseUrlForProduct(productId: number | null | undefined) {
  return productId && Number.isInteger(productId) && productId > 0
    ? `${ADMIN_ROUTES.compras}?${PURCHASE_PRODUCT_QUERY_PARAM}=${productId}`
    : ADMIN_ROUTES.compras
}

/** Lee el producto preseleccionado desde la URL de Compras (o null si no es válido). */
export function purchaseProductFromSearch(search: string) {
  const raw = new URLSearchParams(search).get(PURCHASE_PRODUCT_QUERY_PARAM)
  const parsed = Number(raw)
  return raw && Number.isInteger(parsed) && parsed > 0 ? parsed : null
}
