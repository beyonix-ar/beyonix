import assert from "node:assert/strict"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"

import { cartCheckoutButtonState } from "../../lib/cart/cart-checkout-button.ts"

// Fase 5: contratos de integración de la fuente única de stock vendible
// (lib/inventory/sellable-stock.ts) en catálogo, carrito, checkout y Admin.

const root = process.cwd()
const read = (path: string) => readFileSync(join(root, path), "utf8").replace(/\r\n/g, "\n")

const store = read("lib/supabase/queries/store.ts")
const storeServer = read("lib/supabase/queries/store-server.ts")
const favorites = read("app/cuenta/favoritos/favoritos-client.tsx")
const cartContext = read("context/cart-context.tsx")
const cartItem = read("components/cart/cart-item.tsx")
const cartDrawer = read("components/cart/cart-drawer.tsx")
const cartSummary = read("components/cart/cart-summary.tsx")
const checkout = read("app/checkout/page.tsx")
const detailsPanel = read("components/products/product-details-panel.tsx")
const productCard = read("components/products/shared/shared-product-card.tsx")
const adminQueries = read("lib/supabase/queries/productos.ts")
const adminRow = read("app/admin/sections/productos/productos-row.tsx")
const adminVariant = read("app/admin/sections/productos/admin-variant-item.tsx")
const adminForm = read("app/admin/sections/productos/producto-form.tsx")
const adminRoute = read("app/api/admin/products/[id]/stock-reservations/route.ts")
const migration = read("supabase/migrations/20260926130000_active_stock_reservation_totals.sql")

function between(source: string, start: string, end: string) {
  const from = source.indexOf(start)
  assert.ok(from >= 0, `no se encontró ${start}`)
  const to = source.indexOf(end, from + start.length)
  assert.ok(to > from, `no se encontró ${end}`)
  return source.slice(from, to)
}

test("listados y detalle: todo el catálogo público pasa por prepareStoreProducts (físico visible, disponible comprable)", () => {
  const prepare = between(store, "export async function prepareStoreProducts", "\n}\n")
  assert.match(prepare, /Promise\.all\(\[\s*attachStoreConditionedStock\(supabase, products\),\s*fetchActiveReservationTotals\(/)
  assert.ok(
    prepare.indexOf("filter(hasPurchasableStock)") < prepare.indexOf("applyAvailableStock("),
    "la visibilidad se decide con el físico ANTES de aplicar reservas",
  )
  assert.equal((store.match(/prepareStoreProducts\(\s*\(data \|\| \[\]\) as SupabaseProducto\[\],\s*\{ onlyWithStock: true \},?\s*\)/g) ?? []).length, 5)
  assert.match(store, /prepareStoreProducts\(\[data as SupabaseProducto\], \{ onlyWithStock: true \}\)/)
  // Las reseñas no pisan el stock disponible con el físico de la fila cruda.
  assert.doesNotMatch(store, /\{ \.\.\.conditionedProduct, \.\.\.reviewProduct \}/)
  assert.doesNotMatch(store, /attachStoreConditionedStock\(\s*supabase,\s*\(data/)
  assert.match(storeServer, /applyAvailableStock\(\[candidate as FeaturedProductRow\], reservations\)/)
  assert.match(favorites, /await prepareStoreProducts\(favoriteProducts\)/)
})

test("carrito: el refresco excluye la reserva propia y no borra líneas por stock", () => {
  assert.match(store, /export async function getStoreCartProducts\(\s*productIds: number\[\],\s*options: \{ excludeSessionId\?: string \| null \} = \{\},/)
  assert.match(cartContext, /getStoreCartProducts\(productIds, \{\s*excludeSessionId: cartSessionIdRef\.current \|\| null,/)
  const normalize = between(cartContext, "function normalizeCart(", "\nexport function CartProvider")
  assert.doesNotMatch(normalize, /getProductStock|if \(!hasStock\) return acc/)
})

test("carrito: tope = min(3, disponible); bajar siempre se permite para corregir", () => {
  const add = between(cartContext, "const addToCart = (", "const removeFromCart")
  assert.match(add, /const maxQuantity = getMaxPurchasableQuantity\(product, variantColor\)/)
  assert.match(add, /if \(existing\.quantity >= maxQuantity\) return prev/)
  const update = between(cartContext, "const updateQuantity = (", "const getQuantity")
  assert.match(update, /clampedQuantity > item\.quantity &&\s*clampedQuantity > getMaxPurchasableQuantity\(item\.product, item\.color\)/)
  assert.match(detailsPanel, /cartQuantity >= Math\.min\(MAX_CART_ITEM_QUANTITY, selectedStock\)/)
  assert.match(productCard, /quantity >= Math\.min\(MAX_CART_ITEM_QUANTITY, defaultVariant\.stock\)/)
})

test("carrito: informa la línea, deshabilita Finalizar compra y no avanza con cantidad inválida", () => {
  assert.match(cartItem, /const stockIssue = getCartStockIssues\(\[item\]\)\[0\]/)
  assert.match(cartItem, /\{getCartStockIssueMessage\(stockIssue\)\}/)
  assert.match(cartItem, /disabled=\{isMaxQuantity\}/)
  assert.match(cartItem, /disabled=\{quantity <= 1\}/)
  assert.match(cartDrawer, /getCartStockIssues\(items\)\.length > 0\s*\?\s*CART_STOCK_ISSUES_MESSAGE/)
  assert.match(cartSummary, /\{\.\.\.cartCheckoutButtonState\(Boolean\(checkoutBlockedReason\)\)\}/)
  assert.deepEqual(
    [cartCheckoutButtonState(true).disabled, cartCheckoutButtonState(false).disabled],
    [true, false],
  )
  assert.match(cartSummary, /if \(checkoutBlockedReason\) return/)
})

test("checkout: Pasos 1-2 no reservan ni avanzan con cantidades inválidas; Paso 2 -> 3 sigue usando la reserva atómica", () => {
  const next = between(checkout, "const goToNextStep = () => {", "const canSubmitCheckout")
  assert.ok(next.indexOf("if (hasCartStockIssues)") < next.indexOf("reserveCheckoutItems("))
  assert.match(next, /setCheckoutError\(CART_STOCK_ISSUES_MESSAGE\)/)
  assert.match(next, /if \(currentStep === 2\) \{\s*void reserveCheckoutItems\(cartReservationItems, \(\) => setCurrentStep\(3\)\)/)
  // Si otro cliente gana la última unidad: error existente, se queda en Paso 2
  // (onSuccess sólo corre si la reserva tuvo éxito) y se refresca el disponible.
  const failure = between(checkout, "const showReservationFailure = (", "const reserveCheckoutItems")
  assert.match(failure, /void refreshCommercialData\(true\)/)
  assert.match(failure, /acaba de quedarse sin stock/)
  const reserveBlock = between(checkout, "const reserveCheckoutItems = async (", "} catch {")
  assert.ok(reserveBlock.indexOf("showReservationFailure(result, requestedItems)") < reserveBlock.indexOf("onSuccess()"))
  assert.match(checkout, /const maxQuantity = getMaxPurchasableQuantity\(item\.product, item\.color\)/)
})

test("Admin: físico, reservado y disponible distinguibles, con y sin variantes", () => {
  assert.match(adminQueries, /return attachReservedStock\(productos\.map/)
  assert.match(adminQueries, /fetchActiveReservationTotals\(supabase, productIds\)/)
  assert.match(adminRow, /calculateAvailableStock\(normalStockTotal, normalReserved\)/)
  assert.match(adminRow, /<StockReservationBreakdown\s*reserved=\{reservedStockTotal\}\s*available=\{availableStockTotal\}/)
  assert.match(adminRow, /reservedStock=\{variante\.reserved_stock \?\? 0\}/)
  assert.match(adminRow, /reservedStock=\{item\.reserved_quantity \?\? 0\}/)
  assert.match(adminRow, /const canExpand = hasDetails \|\| reservedStockTotal > 0/)
  assert.match(adminVariant, /const availableStock = calculateAvailableStock\(stock, reservedStock\)/)
  assert.match(adminForm, /label="Reservado \(checkout\)" value=\{variantDistribution\?\.reservedStock\}/)
  assert.match(adminForm, /label="Disponible para vender" value=\{variantDistribution\?\.availableStock\}/)
})

test("Admin: el detalle de reservas sólo trae activas y no expone datos del cliente", () => {
  assert.match(adminRoute, /requireInternalUser\(request\)/)
  assert.match(adminRoute, /\.select\("variant_id, conditioned_stock_id, quantity, expires_at, order_id"\)/)
  assert.match(adminRoute, /\.gt\("expires_at", new Date\(\)\.toISOString\(\)\)/)
  const code = adminRoute.replace(/\/\*\*[\s\S]*?\*\//g, "")
  assert.doesNotMatch(code, /session_id|user_id|email|nombre/)
})

test("migración: agregado seguro (security definer, sólo lectura), mismo predicado de reserva activa", () => {
  assert.match(migration, /reservations\.expires_at > now\(\)/)
  assert.match(migration, /security definer\s*\nset search_path = public/)
  assert.match(migration, /stable/)
  assert.doesNotMatch(migration, /\b(insert|update|delete)\s+(into|public\.|from)/i)
  assert.match(migration, /grant execute on function public\.active_stock_reservation_totals\(bigint\[\], text\)\s*to anon, authenticated, service_role;/)
  assert.doesNotMatch(migration, /grant\s+select[^;]*stock_reservations/i)
})

test("bloqueo del +: el motivo real aparece como tooltip y como texto visible", () => {
  const toggle = read("components/products/product-cart-toggle-button.tsx")
  const purchaseBox = read("components/products/product-purchase-box.tsx")
  const cardPricing = read("components/products/shared/product-card-pricing.tsx")
  // Un botón deshabilitado no muestra title: el tooltip vive en el contenedor.
  assert.equal((toggle.match(/<span title=\{blockedTitle\}/g) ?? []).length, 2)
  assert.equal((toggle.match(/disabled:pointer-events-none/g) ?? []).length, 2)
  assert.match(cardPricing, /limitMessage=\{limitMessage\}/)
  assert.match(purchaseBox, /\{maxReached && limitMessage && \(/)
  assert.match(productCard, /limitMessage=\{getQuantityLimitMessage\(product, defaultVariant\.value, quantity\)\}/)
  assert.match(detailsPanel, /limitMessage=\{getQuantityLimitMessage\(\s*product,\s*selectedOption\?\.value \?\? selectedColor,\s*cartQuantity,\s*\)\}/)
  assert.match(cartItem, /getQuantityLimitMessage\(product, color, quantity\)/)
  assert.match(cartItem, /<span\s*title=\{limitMessage \?\? undefined\}/)
  assert.match(checkout, /getQuantityLimitMessage\(item\.product, item\.color, item\.quantity\)/)
  assert.match(checkout, /<span\s*title=\{limitMessage \?\? undefined\}/)
  assert.doesNotMatch(cartItem + checkout, /"Máximo disponible"/)
})

test("Admin: sólo el número del bloque Stock toma color según su significado", () => {
  const editor = read("app/admin/sections/productos/product-variants-editor.tsx")
  const css = read("app/globals.css")
  assert.match(editor, /tone === "neutral" \? "text-white" : `product-editor-metric-value-\$\{tone\}`/)
  const tones = new Map(
    [...adminForm.matchAll(/<StockSummaryItem label="([^"]+)" value=\{[^}]+\}(?: tone="(\w+)")? \/>/g)]
      .map((match) => [match[1], match[2] ?? "neutral"]),
  )
  assert.deepEqual(Object.fromEntries(tones), {
    "Stock físico": "neutral",
    "Stock normal": "success",
    "Stock con descuento": "neutral",
    "Fallado / no vendible": "danger",
    "Pendiente de revisión": "neutral",
    "Reservado (checkout)": "success",
    "Disponible para vender": "success",
  })
  assert.match(css, /html\[data-admin-theme="light"\] \.product-editor-screen \.product-editor-metric-value-success \{\n  color: #15803d !important;\n\}/)
  assert.match(css, /html\[data-admin-theme="light"\] \.product-editor-screen \.product-editor-metric-value-danger \{\n  color: #b91c1c !important;\n\}/)
  assert.match(css, /\n\.product-editor-screen \.product-editor-metric-value-success \{\n  color: #22c55e;\n\}/)
  assert.match(css, /\n\.product-editor-screen \.product-editor-metric-value-danger \{\n  color: #f87171;\n\}/)
})

test("migración de certeza: 'ajena' sólo es otra cuenta autenticada; mismos permisos y sin identidades", () => {
  const foreign = read("supabase/migrations/20260926140000_active_stock_reservation_foreign_totals.sql")
  const code = foreign.replace(/--.*$/gm, "")
  assert.match(code, /drop function if exists public\.active_stock_reservation_totals\(bigint\[\], text\);/)
  assert.match(code, /where v_viewer is not null\s*and reservations\.user_id is not null\s*and reservations\.user_id <> v_viewer/)
  assert.match(code, /v_viewer uuid := auth\.uid\(\);/)
  assert.match(code, /reservations\.expires_at > now\(\)/)
  assert.match(code, /grant execute on function public\.active_stock_reservation_totals\(bigint\[\], text\)\s*to anon, authenticated, service_role;/)
  // La salida sigue siendo sólo agregados: ninguna columna con identidad.
  const returns = code.slice(code.indexOf("returns table"), code.indexOf("language plpgsql"))
  assert.doesNotMatch(returns, /session|user_id|order_id|expires_at/)
  assert.doesNotMatch(code, /\b(insert|update|delete)\s+(into|public\.|from)/i)
})

test("el navegador nunca consulta reserva por reserva", () => {
  const clientDirs = ["components", "context", "hooks", "app"]
  const offenders: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(root, dir))) {
      const path = join(dir, entry)
      if (statSync(join(root, path)).isDirectory()) {
        if (path.replace(/\\/g, "/") === "app/api") continue
        walk(path)
      } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
        if (/from\(["']stock_reservations["']\)|available_stock_for_session/.test(read(path))) offenders.push(path)
      }
    }
  }
  clientDirs.forEach(walk)
  assert.deepEqual(offenders, [])
})
