import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { build, type Plugin } from "esbuild"
import { chromium, type Browser } from "playwright-core"
import postcss from "postcss"
import tailwindcss from "@tailwindcss/postcss"

// Admin → Productos, columna Acciones con la fila REAL (ProductosTable →
// ProductosRow → AdminVariantItem) y un SUPER ADMIN: ⭐ 👁 ✏️ ⋮ siempre
// visibles. Regresión: con la columna angosta el lápiz (hijo flex sin
// shrink-0) quedaba en ~2px y en pantalla sólo se veía ⭐ 👁 ⋮.

const variant = (id: number, nombre: string, hex: string) => ({
  id, producto_id: 1, nombre, sku: `SKU${id}`, color_hex: hex, stock: 4, reserved_stock: 0,
  imagenes: [], activo: true, orden: id, codigo_barra: null, created_at: "2026-10-09T00:00:00.000Z",
})
const PRODUCTS = [
  { id: 1, nombre: "TRÍPODE ÑANDÚ 360º CON CONTROL REMOTO BLUETOOTH Y ESTUCHE", precio: 30000, stock: 8, destacado: true, featured_position: 12, activo: true, catalog_revision: 1, producto_variantes: [variant(11, "NEGRO", "#000000"), variant(12, "BLANCO", "#ffffff")] },
  { id: 2, nombre: "LÁMPARA ÁMBAR", precio: 20000, stock: 3, destacado: false, featured_position: null, activo: true, catalog_revision: 1, producto_variantes: [] },
  { id: 3, nombre: "PARLANTE", precio: 120000, stock: 0, destacado: true, featured_position: 123, activo: false, catalog_revision: 1, producto_variantes: [] },
]

const modules: Record<string, string> = {
  "auth-context": `export function useAuth() { return { isSuperAdmin: true, user: { rol: "super_admin" } } }`,
  "force-delete-dialog": `export function ForceDeleteDialog() { return null }`,
  "use-categorias": `export function useCategorias() { return { categorias: [] } }`,
  "use-product-colors": `export function useProductColors() { return [] }`,
  "use-site-settings": `export function useSiteSettings() { return { stock: { criticalStockThreshold: 1, lowStockThreshold: 3, availableStockThreshold: 4 } } }`,
  "use-productos": `const products = ${JSON.stringify(PRODUCTS)};
    export function useProductos() { return { productos: products, total: products.length, variantIssues: { count: 0, hasIssues: false }, loading: false, error: null, actionMessage: null, actionError: null, deleteProducto: async () => true, toggleProductoActivo: async () => true, setProductoFeatured: async () => {}, applyFeaturedLocally: () => {}, reloadProductos: async () => {} } }`,
  "client": `const supabase = { auth: { getSession: async () => ({ data: { session: null } }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) }, from: () => ({}) };
    module.exports = new Proxy({ supabase, __esModule: true }, { get: (target, key) => (key in target ? target[key] : () => undefined) })`,
  "productos": `const products = ${JSON.stringify(PRODUCTS)};
    const queries = { __esModule: true, getProductoById: async (id) => products.find((item) => item.id === id) };
    module.exports = new Proxy(queries, { get: (target, key) => (key in target ? target[key] : async () => undefined) })`,
  "admin-categorias": `export function AdminCategorias() { return null }`,
  "producto-form": `import React from "react"; export function ProductoForm({ producto }) { return <section aria-label="Editor de producto"><h2>Editando {producto.nombre}</h2></section> }`,
  "productos-toolbar": `export function ProductosToolbar() { return null }`,
  "navigation": `export function useRouter() { return { push() {}, replace() {} } }; export function usePathname() { return "/admin/productos" }; export function useSearchParams() { return new URLSearchParams() }`,
  "server-only": `export {}`,
  "image": `export default function Image() { return null }`,
}

const stubs: Plugin = {
  name: "admin-products-actions-layout-fixture",
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^node:/ }, (args) => ({ path: args.path, namespace: "node-stub" }))
    pluginBuild.onLoad({ filter: /.*/, namespace: "node-stub" }, () => ({ contents: "module.exports = new Proxy({}, { get: () => () => undefined })", loader: "js" }))
    pluginBuild.onResolve({ filter: /(?:context\/auth-context|force-delete-dialog|hooks\/use-categorias|hooks\/use-product-colors|hooks\/use-site-settings|hooks\/use-productos|queries\/productos|supabase\/client|categorias\/admin-categorias|\.\/producto-form|\.\/productos-toolbar|next\/navigation|next\/image|^server-only)$/ }, (args) => ({ path: args.path.split(/[\\/]/).at(-1)!, namespace: "fixture" }))
    pluginBuild.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({ contents: modules[args.path], loader: args.path === "client" || args.path === "productos" ? "js" : "tsx", resolveDir: process.cwd() }))
  },
}

let browser: Browser
let bundle: string
let css: string

test.before(async () => {
  css = (await postcss([tailwindcss({ base: process.cwd() })]).process(readFileSync("app/globals.css", "utf8"), { from: "app/globals.css" })).css
  const result = await build({
    stdin: {
      contents: `import React from "react"; import { createRoot } from "react-dom/client";
        import { AdminProductos } from "./app/admin/sections/productos/admin-productos.tsx";
        createRoot(document.getElementById("root")).render(<AdminProductos />);`,
      resolveDir: process.cwd(), loader: "tsx", sourcefile: "admin-products-actions-layout-fixture.tsx",
    },
    bundle: true, platform: "browser", format: "iife", write: false,
    alias: { "@": process.cwd() }, jsx: "automatic", plugins: [stubs],
    define: { "process.env.NODE_ENV": '"production"' },
  })
  bundle = result.outputFiles[0].text
  browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chrome", headless: true })
})

test.after(async () => { await browser?.close() })

async function open(width: number, theme: "dark" | "light") {
  const page = await browser.newPage({ viewport: { width, height: 1000 } })
  const html = `<!doctype html><html lang="es" data-admin-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div class="beyonix-admin-shell min-h-screen text-white lg:flex"><div class="hidden lg:block"><aside class="beyonix-admin-sidebar admin-ds-sidebar flex h-full flex-col border-r">Menú</aside></div><main class="beyonix-admin-main admin-solid-surface min-w-0 flex-1 bg-beyonix-page"><div id="root"></div></main></div><script>window.process = { env: { NODE_ENV: "production" } }</script><script>${bundle}</script></body></html>`
  await page.route("http://beyonix.test/**", (route) => route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html }))
  await page.goto("http://beyonix.test/admin/productos")
  await page.locator(".admin-product-actions").first().waitFor()
  await page.getByRole("button", { name: `Ver detalle de ${PRODUCTS[0].nombre}` }).click()
  await page.locator(".admin-variant-item").first().waitFor()
  return page
}

for (const [width, theme] of [[1920, "dark"], [1920, "light"], [1600, "dark"], [1536, "dark"], [1440, "dark"], [1280, "light"], [390, "dark"]] as const) {
  test(`fila real: ⭐ 👁 ✏️ ⋮ visibles, mismo tamaño y sin recortes a ${width}px (${theme})`, async () => {
    const page = await open(width, theme)
    try {
      const rows = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>(".admin-product-actions"), (actions) => {
        const box = actions.getBoundingClientRect()
        const buttons = Array.from(actions.querySelectorAll("button"), (button) => {
          const rect = button.getBoundingClientRect()
          return { label: button.getAttribute("aria-label") ?? "", left: rect.left, right: rect.right, width: rect.width, height: rect.height, center: rect.top + rect.height / 2 }
        })
        return { variant: !!actions.closest(".admin-variant-item"), left: box.left, right: box.right, buttons }
      }))
      const parents = rows.filter((row) => !row.variant)
      const variants = rows.filter((row) => row.variant)
      assert.equal(parents.length, PRODUCTS.length)
      assert.equal(variants.length, 2)

      for (const row of rows) {
        const name = row.buttons.map((button) => button.label).join(" | ")
        assert.equal(row.buttons.length, row.variant ? 2 : 4, `controles: ${name}`)
        if (!row.variant) {
          assert.ok(row.buttons[2].label.startsWith("Editar "), `el tercer control es el lápiz: ${name}`)
          assert.equal(new Set(row.buttons.slice(1).map((button) => Math.round(button.width))).size, 1, `ojo, lápiz y menú con el mismo ancho: ${name}`)
        }
        for (const [index, button] of row.buttons.entries()) {
          assert.ok(button.width >= 30, `${button.label}: ancho ${button.width}px`)
          assert.ok(button.left >= row.left - 0.5 && button.right <= row.right + 0.5, `${button.label}: recortado`)
          if (index > 0) assert.ok(button.left >= row.buttons[index - 1].right + 3, `${button.label}: pegado o superpuesto`)
        }
        assert.equal(new Set(row.buttons.map((button) => Math.round(button.height))).size, 1, `alturas: ${name}`)
        assert.equal(new Set(row.buttons.map((button) => Math.round(button.center))).size, 1, `alineación: ${name}`)
      }

      if (width >= 1536) {
        // Escritorio: misma columna Acciones para producto y variantes.
        for (const row of variants) {
          assert.ok(Math.abs(row.left - parents[0].left) <= 1 && Math.abs(row.right - parents[0].right) <= 1, "variantes alineadas con el producto")
        }
      }
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "sin scroll horizontal")

      await page.getByRole("button", { name: `Editar ${PRODUCTS[1].nombre}`, exact: true }).click()
      await page.getByRole("region", { name: "Editor de producto" }).getByText(`Editando ${PRODUCTS[1].nombre}`).waitFor()
    } finally { await page.close() }
  })
}
