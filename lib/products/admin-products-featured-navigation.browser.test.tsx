import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { build, type Plugin } from "esbuild"
import { chromium, type Browser, type Page } from "playwright-core"
import postcss from "postcss"
import tailwindcss from "@tailwindcss/postcss"

// Admin → Productos: (1) "Productos" del menú lateral vuelve al listado
// principal desde cualquier subvista y arriba de todo (AdminProductos real,
// subcomponentes simulados); (2) controles reales de la columna Acciones:
// destacado con posición y ojo de ganancia estimada al contado.

const PRODUCTS = [
  { id: 1, nombre: "TRÍPODE ÑANDÚ 360º", precio: 30000, destacado: true, featured_position: 2, activo: true },
  { id: 2, nombre: "LÁMPARA ÁMBAR", precio: 20000, destacado: false, featured_position: null, activo: true },
]

const ESTIMATES: Record<number, unknown> = {
  1: { status: "available", cashPrice: 30000, feePercent: 5, feeSource: "manual", minProfit: 18500, maxProfit: 18500, variants: [{ variantId: null, variantName: null, unitCost: 10000, profitAmount: 18500 }], missingCostVariants: [] },
  2: { status: "available", cashPrice: 30000, feePercent: 5, feeSource: "manual", minProfit: 16500, maxProfit: 18500, variants: [{ variantId: 11, variantName: "NEGRO", unitCost: 10000, profitAmount: 18500 }, { variantId: 12, variantName: "ÁMBAR", unitCost: 12000, profitAmount: 16500 }], missingCostVariants: [{ variantId: 13, variantName: "AZUL" }] },
  3: { status: "unavailable", reason: "fee_unconfigured", message: "Falta configurar el costo de Mercado Pago en 1 pago (Admin → Financiación)." },
  4: { status: "available", cashPrice: 20000, feePercent: 5, feeSource: "manual", minProfit: -2000, maxProfit: -2000, variants: [{ variantId: null, variantName: null, unitCost: 21000, profitAmount: -2000 }], missingCostVariants: [] },
  5: { status: "available", cashPrice: 20000, feePercent: 5, feeSource: "manual", minProfit: 0, maxProfit: 0, variants: [{ variantId: null, variantName: null, unitCost: 19000, profitAmount: 0 }], missingCostVariants: [] },
}

const stubs: Plugin = {
  name: "admin-products-featured-navigation-fixture",
  setup(pluginBuild) {
    const modules: Record<string, string> = {
      "auth-context": `export function useAuth() { return { isSuperAdmin: false, user: { rol: "admin" } } }`,
      "force-delete-dialog": `export function ForceDeleteDialog() { return null }`,
      "use-categorias": `export function useCategorias() { return { categorias: [] } }`,
      "use-product-colors": `export function useProductColors() { return [] }`,
      "use-site-settings": `export function useSiteSettings() { return { stock: { criticalStockThreshold: 1, lowStockThreshold: 3, availableStockThreshold: 4 } } }`,
      "use-productos": `const products = ${JSON.stringify(PRODUCTS)};
        export function useProductos() { return { productos: products, total: products.length, variantIssues: { count: 0, hasIssues: false }, loading: false, error: null, actionMessage: null, actionError: null, deleteProducto: async () => true, toggleProductoActivo: async () => true, setProductoFeatured: async () => {}, applyFeaturedLocally: () => {}, reloadProductos: async () => {} } }`,
      "productos": `const estimates = ${JSON.stringify(ESTIMATES)};
        export async function getProductoById(id) { return ${JSON.stringify(PRODUCTS)}.find((item) => item.id === id) }
        export async function getProductosPage() { return { productos: [], total: 0 } }
        export async function mergeProducto() {}
        export async function getProductCashProfit(id) {
          window.profitCalls = [...(window.profitCalls || []), id]
          if (id === 9) throw new Error("No se pudo calcular la ganancia estimada.")
          return estimates[id]
        }`,
      "admin-categorias": `import React from "react"; export function AdminCategorias() { return <section aria-label="Listado de categorías">Categorías</section> }`,
      "producto-form": `import React from "react"; export function ProductoForm({ producto, onCancel }) { return <section aria-label="Editor de producto"><h2>Editando {producto.nombre}</h2><button type="button" onClick={onCancel}>Volver a productos</button></section> }`,
      "productos-table": `import React from "react"; export function ProductosTable({ productos, onEdit }) { return <section aria-label="Listado de productos">{productos.map((item) => <button key={item.id} type="button" onClick={() => onEdit(item)}>Editar {item.nombre}</button>)}</section> }`,
      "productos-toolbar": `import React from "react"; export function ProductosToolbar({ onViewChange }) { return <div><button type="button" onClick={() => onViewChange("productos")}>Pestaña productos</button><button type="button" onClick={() => onViewChange("categorias")}>Pestaña categorías</button></div> }`,
      "image": `export default function Image() { return null }`,
    }
    pluginBuild.onResolve({ filter: /(?:context\/auth-context|force-delete-dialog|hooks\/use-categorias|hooks\/use-product-colors|hooks\/use-site-settings|hooks\/use-productos|queries\/productos|categorias\/admin-categorias|\.\/producto-form|\.\/productos-table|\.\/productos-toolbar|next\/image)$/ }, (args) => {
      const name = args.path.split(/[\\/]/).at(-1)!
      return { path: name, namespace: "fixture" }
    })
    pluginBuild.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({ contents: modules[args.path], loader: "tsx", resolveDir: process.cwd() }))
  },
}

// Editor REAL (ProductoForm + useProductoForm + su dirty guard) dentro de
// AdminProductos real: sólo se simulan datos y subcomponentes pesados.
const EDITOR_PRODUCT = {
  id: 1, nombre: "TRÍPODE ÑANDÚ 360º", slug: "tripode", descripcion: "<p>Trípode</p>", video_url: null,
  precio: 30000, precio_anterior: null, descuento: null, stock: 4, categoria_id: 1, destacado: false, activo: false,
  imagen_principal: null, sku: null, created_at: "2026-10-09T00:00:00.000Z",
  peso_empaquetado_kg: 0.3, alto_paquete_cm: 8, ancho_paquete_cm: 18, largo_paquete_cm: 20, catalog_revision: 3, modo_color: "especifico",
  producto_variantes: [{ id: 9, producto_id: 1, nombre: "NEGRO", sku: "TR01", color_hex: "#000000", stock: 4, imagenes: [], activo: false, orden: 1, created_at: "2026-10-09T00:00:00.000Z" }],
  producto_especificaciones: [],
}
const realEditorStubs: Plugin = {
  name: "admin-products-real-editor-fixture",
  setup(pluginBuild) {
    const modules: Record<string, string> = {
      "auth-context": `export function useAuth() { return { isSuperAdmin: false, user: { rol: "admin" } } }`,
      "force-delete-dialog": `export function ForceDeleteDialog() { return null }`,
      "use-categorias": `export function useCategorias() { return { categorias: [] } }`,
      "use-product-colors": `export function useProductColors() { return [] }`,
      "use-site-settings": `export function useSiteSettings() { return { stock: { criticalStockThreshold: 1, lowStockThreshold: 3, availableStockThreshold: 4 }, installmentsFinancing: {}, pricing: { transferDiscountPercent: 0 } } }`,
      "use-productos": `const products = ${JSON.stringify(PRODUCTS)};
        export function useProductos() { return { productos: products, total: products.length, variantIssues: { count: 0, hasIssues: false }, loading: false, error: null, actionMessage: null, actionError: null, deleteProducto: async () => true, toggleProductoActivo: async () => true, setProductoFeatured: async () => {}, applyFeaturedLocally: () => {}, reloadProductos: async () => {} } }`,
      "productos": `
        export async function getProductoById() { return ${JSON.stringify(EDITOR_PRODUCT)} }
        export async function getProductosPage() { return { productos: [], total: 0 } }
        export async function mergeProducto() {}
        export async function getCategorias() { return [{ id: 1, nombre: "Accesorios" }] }
        export async function getProductPricing() { return { knownUnitCost: null, variantCosts: [], missingVariantCosts: [], requiresRecalculation: false, recalculatedPrice: null, recalculationBlockedReason: null, pricingMode: "manual", targetMarginPercent: null } }
        export async function updateProductoCatalog() { throw new Error("no se usa") }
        export async function setProductoFeatured() { throw new Error("no se usa") }
        export async function createProductoCompleto() { throw new Error("no se usa") }`,
      "producto-especificaciones": `export async function saveDraftProductoEspecificaciones() {}`,
      "producto-imagenes": `export async function uploadProductoDraftImages() { return [] } export async function deleteProductoImagesByUrls() {}`,
      "navigation": `export function useRouter() { return { push: (href) => { window.pushedHref = href } } }`,
      "product-pricing": `export const calculateTargetMarginPrice = () => null; export const simulateProductProfitability = () => null; export const getSinglePaymentProfitAmount = () => null;`,
      "product-variants-editor": `import React from "react"; export function ProductVariantsEditor() { return <section aria-label="Variantes">Variantes</section> }; export function StockSummaryItem({ label, value }) { return <div className="product-editor-metric">{label}: {value ?? 0}</div> }`,
      "product-specifications-editor": `import React from "react"; export function ProductSpecificationsEditor() { return <section aria-label="Especificaciones">Especificaciones</section> }`,
      "admin-product-preview-modal": `import React from "react"; export function AdminProductPreviewModal() { return null }`,
      "admin-categorias": `import React from "react"; export function AdminCategorias() { return <section aria-label="Listado de categorías">Categorías</section> }`,
      "productos-table": `import React from "react"; export function ProductosTable({ productos, onEdit }) { return <section aria-label="Listado de productos">{productos.map((item) => <button key={item.id} type="button" onClick={() => onEdit(item)}>Editar {item.nombre}</button>)}</section> }`,
      "productos-toolbar": `import React from "react"; export function ProductosToolbar() { return null }`,
      "image": `export default function Image() { return null }`,
    }
    pluginBuild.onResolve({ filter: /(?:context\/auth-context|force-delete-dialog|hooks\/use-categorias|hooks\/use-product-colors|hooks\/use-site-settings|hooks\/use-productos|queries\/(?:productos|producto-especificaciones|producto-imagenes)|next\/navigation|product-pricing|product-variants-editor|product-specifications-editor|admin-product-preview-modal|categorias\/admin-categorias|\.\/productos-table|\.\/productos-toolbar|next\/image)$/ }, (args) => {
      const name = args.path.split(/[\\/]/).at(-1)!
      return { path: name, namespace: "fixture" }
    })
    pluginBuild.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({ contents: modules[args.path], loader: "tsx", resolveDir: process.cwd() }))
  },
}

// Caché REAL del ojo (getProductCashProfit) y activación REAL
// (toggleProductoActivo → PATCH /api/admin/products/:id), con la red simulada.
const realCacheStubs: Plugin = {
  name: "admin-products-cash-profit-cache-fixture",
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /(?:lib\/supabase\/client|next\/image)$/ }, (args) => ({ path: args.path.split(/[\\/]/).at(-1)!, namespace: "fixture" }))
    pluginBuild.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
      contents: args.path === "client"
        ? `export const supabase = { auth: { getSession: async () => ({ data: { session: { access_token: "admin-token" } } }) } }`
        : `export default function Image() { return null }`,
      loader: "tsx",
      resolveDir: process.cwd(),
    }))
  },
}

let browser: Browser
let bundle: string
let combinedBundle: string
let cacheBundle: string
let css: string

test.before(async () => {
  css = (await postcss([tailwindcss({ base: process.cwd() })]).process(readFileSync("app/globals.css", "utf8"), { from: "app/globals.css" })).css
  const result = await build({
    stdin: {
      contents: `import React, { useState } from "react"; import { createRoot } from "react-dom/client";
        import { AdminProductos } from "./app/admin/sections/productos/admin-productos.tsx";
        import { ProductFeaturedControl } from "./app/admin/sections/productos/product-featured-control.tsx";
        import { ProductCashProfitPopover } from "./app/admin/sections/productos/product-cash-profit-popover.tsx";
        import { isSameAdminLocation, notifyAdminRouteReselect } from "./lib/admin/admin-route-reselect.ts";

        // Mismo criterio que el menú lateral de AdminClient: click en la sección activa.
        document.getElementById("nav-productos").addEventListener("click", (event) => {
          event.preventDefault();
          if (isSameAdminLocation("/admin/productos")) notifyAdminRouteReselect("/admin/productos");
        });

        function Featured({ id, name, initial, disabledReason = null }) {
          const [state, setState] = useState(initial);
          return <ProductFeaturedControl variant="row" productName={name} state={state} disabledReason={disabledReason} onChange={async (next) => {
            window.featuredChanges = [...(window.featuredChanges || []), { id, ...next }];
            if (window.featuredError) throw new Error(window.featuredError);
            setState(next);
          }} />
        }
        function Actions({ id, name, initial, disabledReason }) {
          return <div className="admin-product-actions flex items-center justify-center gap-1.5 *:shrink-0" data-row={id}>
            <Featured id={id} name={name} initial={initial} disabledReason={disabledReason} />
            <ProductCashProfitPopover productId={id} productName={name} price={30000} />
            <button type="button" aria-label={"Editar " + name} className="flex size-9 items-center justify-center rounded-xl border">E</button>
            <button type="button" aria-label={"Más acciones para " + name} className="flex size-9 items-center justify-center rounded-xl border">⋮</button>
          </div>
        }
        function Row(props) {
          return <div className="admin-product-row"><div className="admin-product-row-grid grid grid-cols-admin-product-parent items-center gap-3 px-4 py-3">
            <div>{props.name}</div><span data-label="SKU" /><span data-label="Cantidad">1</span><span data-label="Color" /><span data-label="Precio">$30.000</span><span data-label="Estado">Activo</span>
            <Actions {...props} />
          </div></div>
        }
        function Controls() {
          return <div className="admin-products-table">
            <Row id={1} name="TRÍPODE ÑANDÚ 360º" initial={{ destacado: true, featuredPosition: 2 }} />
            <Row id={2} name="LÁMPARA ÁMBAR" initial={{ destacado: false, featuredPosition: null }} />
            <Row id={3} name="PARLANTE" initial={{ destacado: true, featuredPosition: null }} />
            <Row id={4} name="MOUSE" initial={{ destacado: true, featuredPosition: 12 }} />
            <Row id={5} name="TECLADO" initial={{ destacado: false, featuredPosition: null }} disabledReason="Sin permiso para cambiar destacados." />
            <Row id={9} name="CABLE" initial={{ destacado: false, featuredPosition: null }} />
          </div>
        }
        createRoot(document.getElementById("root")).render(window.FIXTURE === "controls" ? <Controls /> : <AdminProductos />);`,
      resolveDir: process.cwd(), loader: "tsx", sourcefile: "admin-products-featured-navigation-fixture.tsx",
    },
    bundle: true, platform: "browser", format: "iife", write: false,
    alias: { "@": process.cwd() }, jsx: "automatic", plugins: [stubs],
    define: { "process.env.NODE_ENV": '"production"' },
  })
  bundle = result.outputFiles[0].text
  const combined = await build({
    stdin: {
      contents: `import React from "react"; import { createRoot } from "react-dom/client";
        import { AdminProductos } from "./app/admin/sections/productos/admin-productos.tsx";
        import { isSameAdminLocation, notifyAdminRouteReselect } from "./lib/admin/admin-route-reselect.ts";
        // Mismo criterio que el Link del menú lateral de AdminClient (listener en el propio link).
        document.getElementById("nav-productos").addEventListener("click", (event) => {
          event.preventDefault();
          if (isSameAdminLocation("/admin/productos")) notifyAdminRouteReselect("/admin/productos");
        });
        createRoot(document.getElementById("root")).render(<AdminProductos />);`,
      resolveDir: process.cwd(), loader: "tsx", sourcefile: "admin-products-real-editor-fixture.tsx",
    },
    bundle: true, platform: "browser", format: "iife", write: false,
    alias: { "@": process.cwd() }, jsx: "automatic", plugins: [realEditorStubs],
    define: { "process.env.NODE_ENV": '"production"' },
  })
  combinedBundle = combined.outputFiles[0].text
  const cache = await build({
    stdin: {
      contents: `import React, { useState } from "react"; import { createRoot } from "react-dom/client";
        import { ProductCashProfitPopover } from "./app/admin/sections/productos/product-cash-profit-popover.tsx";
        import { toggleProductoActivo } from "./lib/supabase/queries/productos.ts";
        function Harness() {
          const [product, setProduct] = useState(window.INITIAL_PRODUCT);
          return <div>
            {/* Mismo merge que useProductos.handleToggle tras el PATCH real. */}
            <button type="button" onClick={async () => { const updated = await toggleProductoActivo(product); setProduct((current) => ({ ...current, ...updated })) }}>
              {product.activo ? "Desactivar producto" : "Activar producto"}
            </button>
            <button type="button" onClick={() => setProduct((current) => ({ ...current, precio: 40000 }))}>Cambiar precio</button>
            <ProductCashProfitPopover productId={product.id} productName={product.nombre} price={product.precio} active={product.activo === true} catalogRevision={product.catalog_revision ?? null} />
          </div>
        }
        createRoot(document.getElementById("root")).render(<Harness />);`,
      resolveDir: process.cwd(), loader: "tsx", sourcefile: "admin-products-cash-profit-cache-fixture.tsx",
    },
    bundle: true, platform: "browser", format: "iife", write: false,
    alias: { "@": process.cwd() }, jsx: "automatic", plugins: [realCacheStubs],
    define: { "process.env.NODE_ENV": '"production"' },
  })
  cacheBundle = cache.outputFiles[0].text
  browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chrome", headless: true })
})

test.after(async () => { await browser?.close() })

async function open(fixture: "navigation" | "controls" | "combined", width = 1440, theme: "dark" | "light" = "dark") {
  const page = await browser.newPage({ viewport: { width, height: 900 } })
  const html = `<!doctype html><html lang="es" data-admin-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div class="beyonix-admin-shell min-h-screen text-white lg:flex"><nav aria-label="Secciones"><a id="nav-productos" href="/admin/productos">Productos</a></nav><main class="beyonix-admin-main min-w-0 flex-1"><div><div id="root"></div><div style="height:3000px" aria-hidden="true"></div></div></main></div><script>window.FIXTURE = ${JSON.stringify(fixture)}</script><script>${fixture === "combined" ? combinedBundle : bundle}</script></body></html>`
  await page.route("http://beyonix.test/**", (route) => route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html }))
  await page.goto("http://beyonix.test/admin/productos")
  return page
}

const read = <T,>(page: Page, key: string) => page.evaluate((name) => (window as unknown as Record<string, unknown>)[name], key) as Promise<T>
const sidebarProducts = (page: Page) => page.getByRole("link", { name: "Productos", exact: true })

test("editor → Productos del menú lateral → listado principal y scroll arriba", async () => {
  const page = await open("navigation")
  try {
    await page.getByRole("button", { name: "Editar TRÍPODE ÑANDÚ 360º" }).click()
    await page.getByRole("region", { name: "Editor de producto" }).waitFor()
    await page.evaluate(() => window.scrollTo(0, 1800))
    assert.ok(await page.evaluate(() => window.scrollY) > 1000)

    await sidebarProducts(page).click()
    await page.getByRole("region", { name: "Listado de productos" }).waitFor()
    assert.equal(await page.getByRole("region", { name: "Editor de producto" }).count(), 0, "cierra el editor")
    assert.equal(await page.evaluate(() => window.scrollY), 0, "no conserva el scroll profundo")
  } finally { await page.close() }
})

test("combinado: editor con cambios → Productos lateral → dirty guard → salir → listado y scroll arriba", async () => {
  const page = await open("combined")
  try {
    await page.getByRole("button", { name: "Editar TRÍPODE ÑANDÚ 360º" }).click()
    await page.getByRole("textbox", { name: "Nombre del producto" }).waitFor()
    await page.locator("#precio").fill("31500")
    await page.getByRole("status").filter({ hasText: "Cambios sin guardar" }).waitFor()
    await page.evaluate(() => window.scrollTo(0, 1800))
    assert.ok(await page.evaluate(() => window.scrollY) > 1000, "scroll profundo en el editor")

    const leaveDialog = page.getByRole("dialog", { name: "Cambios sin guardar" })
    await sidebarProducts(page).click()
    await leaveDialog.waitFor()
    assert.equal(await page.getByRole("region", { name: "Listado de productos" }).count(), 0, "no sale antes de confirmar")

    await leaveDialog.getByRole("button", { name: "Seguir editando" }).click()
    assert.equal(await page.locator("#precio").inputValue(), "31500", "seguir editando conserva la edición")

    await sidebarProducts(page).click()
    await leaveDialog.getByRole("button", { name: "Salir sin guardar" }).click()
    await page.getByRole("region", { name: "Listado de productos" }).waitFor()
    assert.equal(await page.getByRole("textbox", { name: "Nombre del producto" }).count(), 0, "el editor se cerró")
    assert.equal(await page.evaluate(() => window.scrollY), 0, "listado arriba de todo")
    assert.equal(await read<string | undefined>(page, "pushedHref"), undefined, "misma sección: sin navegación extra")
  } finally { await page.close() }
})

test("categorías → Productos del menú lateral → listado (no queda la pestaña Categorías)", async () => {
  const page = await open("navigation")
  try {
    await page.getByRole("button", { name: "Pestaña categorías" }).click()
    await page.getByRole("region", { name: "Listado de categorías" }).waitFor()
    await page.evaluate(() => window.scrollTo(0, 1500))
    await sidebarProducts(page).click()
    await page.getByRole("region", { name: "Listado de productos" }).waitFor()
    assert.equal(await page.getByRole("region", { name: "Listado de categorías" }).count(), 0)
    assert.equal(await page.evaluate(() => window.scrollY), 0)
  } finally { await page.close() }
})

test("la flecha de regreso del editor sigue volviendo al listado", async () => {
  const page = await open("navigation")
  try {
    await page.getByRole("button", { name: "Editar LÁMPARA ÁMBAR" }).click()
    await page.getByRole("button", { name: "Volver a productos" }).click()
    await page.getByRole("region", { name: "Listado de productos" }).waitFor()
  } finally { await page.close() }
})

test("destacado en la tabla: ☆ / ★ N visibles, panel para destacar, cambiar posición y quitar", async () => {
  const page = await open("controls")
  try {
    const featured = page.getByRole("button", { name: /^Destacado en la posición 2\. Cambiar destacado de TRÍPODE/ })
    assert.match(await featured.textContent() ?? "", /^\s*2\s*$/, "★ 2 visible sin entrar al editor")
    assert.equal(await page.getByRole("button", { name: /^No destacado\. Cambiar destacado de LÁMPARA ÁMBAR/ }).textContent(), "", "☆ sin número")
    assert.equal(await page.getByRole("button", { name: /^Destacado sin posición\. Cambiar destacado de PARLANTE/ }).textContent(), "")

    // Destacar con posición desde la fila.
    await page.getByRole("button", { name: /Cambiar destacado de LÁMPARA ÁMBAR/ }).click()
    const panel = page.getByRole("dialog", { name: "Destacado de LÁMPARA ÁMBAR" })
    assert.equal(await panel.getByRole("button", { name: "Quitar destacado" }).count(), 0)
    await panel.getByRole("spinbutton", { name: "Posición" }).fill("1")
    await panel.getByRole("button", { name: "Destacar" }).click()
    await panel.waitFor({ state: "detached" })
    assert.match(await page.getByRole("button", { name: /^Destacado en la posición 1\. Cambiar destacado de LÁMPARA/ }).textContent() ?? "", /1/)

    // Posición inválida: no llama a la API.
    await featured.click()
    const tripodPanel = page.getByRole("dialog", { name: "Destacado de TRÍPODE ÑANDÚ 360º" })
    assert.equal(await tripodPanel.getByRole("spinbutton", { name: "Posición" }).inputValue(), "2", "precarga la posición actual")
    await tripodPanel.getByRole("spinbutton", { name: "Posición" }).fill("0")
    await tripodPanel.getByRole("button", { name: "Guardar posición" }).click()
    await tripodPanel.getByRole("alert").filter({ hasText: "entre 1 y 99" }).waitFor()

    // Posición ocupada: el mensaje de la base queda en el panel y nada cambia.
    await page.evaluate(() => { (window as unknown as { featuredError: string }).featuredError = 'La posición 1 ya está ocupada por "LÁMPARA ÁMBAR".' })
    await tripodPanel.getByRole("spinbutton", { name: "Posición" }).fill("1")
    await tripodPanel.getByRole("button", { name: "Guardar posición" }).click()
    await tripodPanel.getByRole("alert").filter({ hasText: 'ocupada por "LÁMPARA ÁMBAR"' }).waitFor()
    await page.evaluate(() => { (window as unknown as { featuredError: string | null }).featuredError = null })

    await tripodPanel.getByRole("button", { name: "Quitar destacado" }).click()
    await tripodPanel.waitFor({ state: "detached" })
    await page.getByRole("button", { name: /^No destacado\. Cambiar destacado de TRÍPODE/ }).waitFor()
    const changes = await read<Array<Record<string, unknown>>>(page, "featuredChanges")
    assert.deepEqual(changes.at(-1), { id: 1, destacado: false, featuredPosition: null }, "quitar limpia la posición")
    assert.ok(!changes.some((change) => change.featuredPosition === 0))

    assert.equal(await page.getByRole("button", { name: /Cambiar destacado de TECLADO|Sin permiso/ }).isDisabled(), true, "sin permiso: sólo lectura")
  } finally { await page.close() }
})

test("ojo: ganancia estimada al contado con valor, rango, advertencias, No disponible y teclado", async () => {
  const page = await open("controls")
  try {
    const eye = (name: string) => page.getByRole("button", { name: `Ver ganancia estimada al contado de ${name}` })
    const dialog = (name: string) => page.getByRole("dialog", { name: `Ganancia estimada al contado de ${name}` })

    await eye("TRÍPODE ÑANDÚ 360º").click()
    const single = dialog("TRÍPODE ÑANDÚ 360º")
    await single.getByText("$18.500").waitFor()
    assert.match(await single.textContent() ?? "", /Ganancia estimada al contado/)
    assert.match(await single.textContent() ?? "", /Mercado Pago · 1 pago \(5%, configurado\)/)
    assert.equal(await single.getByText("$18.500").evaluate((node) => node.className.includes("text-green-400")), true, "positivo en verde")
    await page.keyboard.press("Escape")
    await single.waitFor({ state: "detached" })
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Ver ganancia estimada al contado de TRÍPODE ÑANDÚ 360º", "Escape devuelve el foco")

    // Teclado: Enter abre.
    await eye("LÁMPARA ÁMBAR").focus()
    await page.keyboard.press("Enter")
    const range = dialog("LÁMPARA ÁMBAR")
    await range.getByText("Desde", { exact: false }).waitFor()
    assert.match(await range.textContent() ?? "", /Desde \$16\.500 hasta \$18\.500/)
    assert.match(await range.textContent() ?? "", /Costo incompleto: sin costo de compra en AZUL/)
    assert.match(await range.textContent() ?? "", /NEGRO\$18\.500ÁMBAR\$16\.500/)
    await page.keyboard.press("Escape")

    await eye("PARLANTE").click()
    await dialog("PARLANTE").getByText("No disponible").waitFor()
    assert.match(await dialog("PARLANTE").textContent() ?? "", /Falta configurar el costo de Mercado Pago en 1 pago/)
    await page.keyboard.press("Escape")

    await eye("MOUSE").click()
    await dialog("MOUSE").getByText("-$2.000").waitFor()
    assert.equal(await dialog("MOUSE").getByText("-$2.000").evaluate((node) => node.className.includes("text-red-400")), true, "negativo en rojo")
    await page.keyboard.press("Escape")

    await eye("TECLADO").click()
    await dialog("TECLADO").getByText("$0").waitFor()
    assert.equal(await dialog("TECLADO").getByText("$0").evaluate((node) => node.className.includes("text-white/70")), true, "cero neutro")
    await page.keyboard.press("Escape")

    await eye("CABLE").click()
    await dialog("CABLE").getByText("No disponible").waitFor()
    await dialog("CABLE").getByRole("alert").filter({ hasText: "No se pudo calcular" }).waitFor()
    await page.keyboard.press("Escape")

    assert.deepEqual(await read<number[]>(page, "profitCalls"), [1, 2, 3, 4, 5, 9], "una consulta por apertura, nunca al renderizar las filas")
  } finally { await page.close() }
})

test("ojo: pasar el mouse por el listado no dispara consultas; quedarse sobre el ojo sí", async () => {
  const page = await open("controls")
  try {
    for (const name of ["TRÍPODE ÑANDÚ 360º", "LÁMPARA ÁMBAR", "PARLANTE", "MOUSE"]) {
      await page.getByRole("button", { name: `Ver ganancia estimada al contado de ${name}` }).hover()
    }
    await page.mouse.move(5, 5)
    await page.waitForTimeout(400)
    assert.equal(await read<number[] | undefined>(page, "profitCalls"), undefined, "recorrer filas no consulta costos")
    await page.getByRole("button", { name: "Ver ganancia estimada al contado de MOUSE" }).hover()
    await page.getByRole("dialog", { name: "Ganancia estimada al contado de MOUSE" }).waitFor()
    assert.deepEqual(await read<number[]>(page, "profitCalls"), [4])
  } finally { await page.close() }
})

for (const [width, theme] of [[1920, "dark"], [1920, "light"], [1600, "dark"], [1280, "dark"], [390, "light"]] as const) {
  test(`columna Acciones: 4 botones alineados, mismo alto y sin desbordar a ${width}px (${theme})`, async () => {
    const page = await open("controls", width, theme)
    try {
      const layout = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>(".admin-product-actions"), (actions) => {
        const box = actions.getBoundingClientRect()
        const buttons = Array.from(actions.querySelectorAll("button"), (button) => button.getBoundingClientRect())
        return {
          count: buttons.filter((rect) => rect.width > 0 && rect.height > 0).length,
          widths: [...new Set(buttons.slice(1).map((rect) => Math.round(rect.width)))],
          inside: buttons.every((rect) => rect.left >= box.left - 0.5 && rect.right <= box.right + 0.5),
          heights: [...new Set(buttons.map((rect) => Math.round(rect.height)))],
          centers: [...new Set(buttons.map((rect) => Math.round(rect.top + rect.height / 2)))],
          overlap: buttons.some((rect, index) => index > 0 && rect.left < buttons[index - 1].right - 0.5),
          scrollable: actions.scrollWidth > actions.clientWidth + 1,
        }
      }))
      for (const [index, row] of layout.entries()) {
        assert.equal(row.count, 4, `fila ${index + 1}: deben verse los 4 controles`)
        assert.equal(row.widths.length, 1, `fila ${index + 1}: ojo, lápiz y menú con anchos distintos ${row.widths}`)
        assert.ok(row.inside, `fila ${index + 1}: botones fuera de la columna`)
        assert.equal(row.heights.length, 1, `fila ${index + 1}: alturas distintas ${row.heights}`)
        assert.ok(row.centers.length === 1, `fila ${index + 1}: desalineados ${row.centers}`)
        assert.equal(row.overlap, false, `fila ${index + 1}: botones superpuestos`)
        assert.equal(row.scrollable, false)
      }
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "sin scroll horizontal")
    } finally { await page.close() }
  })
}

// "Servidor" simulado: la ruta de ganancia responde según el estado REAL del
// producto (como la ruta verdadera, que corta con "Producto inactivo").
async function openCache(initialActive: boolean) {
  const server = { active: initialActive, price: 30000, profitCalls: 0, patchCalls: 0 }
  const product = { id: 1, nombre: "TRÍPODE ÑANDÚ 360º", precio: 30000, activo: initialActive, catalog_revision: 7 }
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const html = `<!doctype html><html lang="es" data-admin-theme="dark"><head><meta charset="utf-8"><style>${css}</style></head><body><div class="beyonix-admin-shell min-h-screen text-white"><main class="beyonix-admin-main"><div id="root"></div></main></div><script>window.INITIAL_PRODUCT = ${JSON.stringify(product)}</script><script>${cacheBundle}</script></body></html>`
  await page.route("http://beyonix.test/**", async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/api/admin/products/1/cash-profit") {
      server.profitCalls += 1
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(server.active
          ? { status: "available", cashPrice: server.price, feePercent: 5, feeSource: "manual", minProfit: server.price * 0.95 - 10000, maxProfit: server.price * 0.95 - 10000, variants: [], missingCostVariants: [] }
          : { status: "unavailable", reason: "product_inactive", message: "Producto inactivo." }),
      })
    }
    if (url.pathname === "/api/admin/products/1" && route.request().method() === "PATCH") {
      server.patchCalls += 1
      server.active = (route.request().postDataJSON() as { activo: boolean }).activo
      // Sin subir catalog_revision: `activo` solo tiene que alcanzar para invalidar.
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ product: { ...product, activo: server.active } }) })
    }
    return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html })
  })
  await page.goto("http://beyonix.test/admin/productos")
  return { page, server }
}

const eyeOf = (page: Page) => page.getByRole("button", { name: "Ver ganancia estimada al contado de TRÍPODE ÑANDÚ 360º" })
const panelOf = (page: Page) => page.getByRole("dialog", { name: "Ganancia estimada al contado de TRÍPODE ÑANDÚ 360º" })
async function openEye(page: Page) {
  await eyeOf(page).click()
  await panelOf(page).getByText(/^\$|No disponible/).first().waitFor()
  const text = await panelOf(page).textContent() ?? ""
  await page.keyboard.press("Escape")
  await panelOf(page).waitFor({ state: "detached" })
  return text
}

test("caché del ojo: activo → desactivar (flujo real) → reabrir antes de 60 s muestra Producto inactivo", async () => {
  const { page, server } = await openCache(true)
  try {
    assert.match(await openEye(page), /\$18\.500/)
    assert.match(await openEye(page), /\$18\.500/)
    assert.equal(server.profitCalls, 1, "sin cambios: reabrir usa la caché (TTL 60 s)")

    await page.getByRole("button", { name: "Desactivar producto" }).click()
    await page.getByRole("button", { name: "Activar producto" }).waitFor()
    assert.equal(server.patchCalls, 1)

    const after = await openEye(page)
    assert.doesNotMatch(after, /\$18\.500/, "nunca la ganancia cacheada")
    assert.match(after, /No disponible/)
    assert.match(after, /Producto inactivo\./)
    assert.equal(server.profitCalls, 2, "el cambio de activo forzó una consulta nueva")
  } finally { await page.close() }
})

test("caché del ojo: inactivo → activar → reabrir recalcula la ganancia (no reutiliza Producto inactivo)", async () => {
  const { page, server } = await openCache(false)
  try {
    assert.match(await openEye(page), /Producto inactivo\./)
    await page.getByRole("button", { name: "Activar producto" }).click()
    await page.getByRole("button", { name: "Desactivar producto" }).waitFor()
    const after = await openEye(page)
    assert.match(after, /\$18\.500/)
    assert.doesNotMatch(after, /Producto inactivo/)
    assert.equal(server.profitCalls, 2)

    // Y si vuelve a desactivarse dentro de los 60 s, tampoco revive la entrada vieja.
    await page.getByRole("button", { name: "Desactivar producto" }).click()
    await page.getByRole("button", { name: "Activar producto" }).waitFor()
    assert.match(await openEye(page), /Producto inactivo\./)
    assert.equal(server.profitCalls, 3)
  } finally { await page.close() }
})

test("caché del ojo: cambiar el precio no reutiliza la estimación del precio anterior", async () => {
  const { page, server } = await openCache(true)
  try {
    assert.match(await openEye(page), /\$18\.500/)
    server.price = 40000
    await page.getByRole("button", { name: "Cambiar precio" }).click()
    assert.match(await openEye(page), /\$28\.000/)
    assert.equal(server.profitCalls, 2)
    assert.match(await openEye(page), /\$28\.000/)
    assert.equal(server.profitCalls, 2, "mismo estado: vuelve a usar la caché")
  } finally { await page.close() }
})

test("el menú lateral avisa la reselección de la sección activa", () => {
  const source = readFileSync("app/admin/admin-client.tsx", "utf8")
  assert.match(source, /if \(pathname === ADMIN_ROUTES\[item\.key\]\) \{\s*notifyAdminRouteReselect\(ADMIN_ROUTES\[item\.key\]\)/)
})
