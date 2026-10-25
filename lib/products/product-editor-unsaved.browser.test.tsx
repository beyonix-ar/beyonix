import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { build, type Plugin } from "esbuild"
import { chromium, type Browser, type Page } from "playwright-core"
import postcss from "postcss"
import tailwindcss from "@tailwindcss/postcss"

// Editor de producto real (ProductoForm + useProductoForm) con las queries de
// Supabase simuladas: la ficha comercial nunca se pierde sin aviso al salir,
// mientras imágenes y especificaciones siguen con guardado inmediato.

const CONFLICT_MESSAGE =
  "El producto cambió desde que abriste el editor (otra pestaña, otro usuario o un evento comercial). Recargalo antes de guardar para no pisar esos cambios."

const stubs: Plugin = {
  name: "product-editor-unsaved-fixture",
  setup(pluginBuild) {
    const modules: Record<string, string> = {
      "productos": `
        export async function getCategorias() { return [{ id: 1, nombre: "Accesorios" }, { id: 2, nombre: "Audio" }] }
        export async function getProductPricing() {
          return { knownUnitCost: null, variantCosts: [], missingVariantCosts: [], requiresRecalculation: false, recalculatedPrice: null, recalculationBlockedReason: null, pricingMode: "manual", targetMarginPercent: null }
        }
        export async function updateProductoCatalog(id, payload, sku, states, revision) {
          window.updateCalls = [...(window.updateCalls || []), { id, payload, states, revision }]
          if (window.nextUpdateError) {
            const message = window.nextUpdateError
            window.nextUpdateError = null
            throw Object.assign(new Error(message), { code: "40001" })
          }
          return { id, catalog_revision: revision + 1 }
        }
        export async function createProductoCompleto() { throw new Error("no se usa") }`,
      "producto-especificaciones": `export async function saveDraftProductoEspecificaciones() {}`,
      "producto-imagenes": `export async function uploadProductoDraftImages() { return [] } export async function deleteProductoImagesByUrls() {}`,
      "navigation": `export function useRouter() { return { push: (href) => { window.pushedHref = href } } }`,
      "use-site-settings": `export function useSiteSettings() { return { installmentsFinancing: {}, pricing: { transferDiscountPercent: 0 } } }`,
      "product-pricing": `export const calculateTargetMarginPrice = () => null; export const simulateProductProfitability = () => null;`,
      "product-activation": `export const getProductActivationStatus = () => ({ ready: true, checks: [] });`,
      "product-variants-editor": `import React from "react";
        export function ProductVariantsEditor({ persistedVariantStates, onPersistedVariantStatesChange, onPersistedVariantsChange }) {
          const variant = { id: 9, producto_id: 9, nombre: "NEGRO", sku: "AUMN01", color_hex: "#000000", stock: 6, activo: false, orden: 1, created_at: "2026-10-09T00:00:00.000Z" };
          return <section aria-label="Variantes">
            <button type="button" onClick={() => onPersistedVariantsChange([{ ...variant, imagenes: ["https://example.com/negro-1.png", "https://example.com/negro-2.png"] }])}>Subir imagen de variante</button>
            <button type="button" onClick={() => onPersistedVariantStatesChange({ ...persistedVariantStates, 9: !persistedVariantStates[9] })}>Alternar variante NEGRO</button>
          </section>
        }
        export function StockSummaryItem({ label, value }) { return <div className="product-editor-metric">{label}: {value ?? 0}</div> }`,
      "product-specifications-editor": `import React from "react";
        export function ProductSpecificationsEditor({ onPersistedSpecificationsChange }) {
          return <section aria-label="Especificaciones"><button type="button" onClick={() => onPersistedSpecificationsChange([{ id: 106, producto_id: 9, icono: "Headphones", texto: "Almohadillas que rodean las orejas", orden: 1, activo: true, created_at: "2026-10-25T00:00:00.000Z" }])}>Guardar especificación</button></section>
        }`,
      "admin-product-preview-modal": `import React from "react"; export function AdminProductPreviewModal({ onClose }) { return <div role="dialog" aria-label="Vista previa del producto"><button onClick={onClose}>Cerrar vista previa</button></div> }`,
      "product-requirements-popover": `import React from "react"; export function ProductRequirementsPopover() { return <button type="button" aria-label="Requisitos para activar">Requisitos para activar</button> }`,
    }
    pluginBuild.onResolve({ filter: /(?:queries\/(?:productos|producto-especificaciones|producto-imagenes)|next\/navigation|use-site-settings|product-pricing|product-activation|product-variants-editor|product-specifications-editor|admin-product-preview-modal|product-requirements-popover)$/ }, (args) => {
      const name = args.path.split(/[\\/]/).at(-1)!
      return { path: name, namespace: "fixture" }
    })
    pluginBuild.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({ contents: modules[args.path], loader: "tsx", resolveDir: process.cwd() }))
  },
}

const PRODUCT = {
  id: 9,
  nombre: "AURICULAR INALÁMBRICO MALIBU",
  slug: "auricular-inalambrico-malibu",
  descripcion: "<p>Sonido envolvente</p>",
  video_url: null,
  precio: 20000,
  precio_anterior: null,
  descuento: null,
  stock: 12,
  categoria_id: 2,
  destacado: false,
  activo: false,
  imagen_principal: null,
  sku: null,
  created_at: "2026-10-09T00:00:00.000Z",
  peso_empaquetado_kg: 0.3,
  alto_paquete_cm: 8,
  ancho_paquete_cm: 18,
  largo_paquete_cm: 20,
  catalog_revision: 3,
  modo_color: "especifico",
  producto_variantes: [{ id: 9, producto_id: 9, nombre: "NEGRO", sku: "AUMN01", color_hex: "#000000", stock: 6, imagenes: [], activo: false, orden: 1, created_at: "2026-10-09T00:00:00.000Z" }],
  producto_especificaciones: [],
}

let browser: Browser
let bundle: string
let css: string

test.before(async () => {
  css = (await postcss([tailwindcss({ base: process.cwd() })]).process(readFileSync("app/globals.css", "utf8"), { from: "app/globals.css" })).css
  const result = await build({
    stdin: {
      contents: `import React from "react"; import { createRoot } from "react-dom/client"; import { ProductoForm } from "./app/admin/sections/productos/producto-form.tsx";
        createRoot(document.getElementById("root")).render(<ProductoForm producto={${JSON.stringify(PRODUCT)}} onSaved={() => { window.savedCalls = (window.savedCalls || 0) + 1 }} onCancel={() => { window.cancelCalls = (window.cancelCalls || 0) + 1 }} />);`,
      resolveDir: process.cwd(), loader: "tsx", sourcefile: "product-editor-unsaved-fixture.tsx",
    },
    bundle: true, platform: "browser", format: "iife", write: false,
    alias: { "@": process.cwd() }, jsx: "automatic", plugins: [stubs],
    define: { "process.env.NODE_ENV": '"production"' },
  })
  bundle = result.outputFiles[0].text
  browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chrome", headless: true })
})

test.after(async () => { await browser?.close() })

async function openEditor(width = 1440, theme: "dark" | "light" = "dark") {
  const page = await browser.newPage({ viewport: { width, height: 900 } })
  const html = `<!doctype html><html lang="es" data-admin-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div class="beyonix-admin-shell min-h-screen text-white lg:flex"><nav aria-label="Secciones"><a href="/admin/pedidos">Pedidos</a> <a href="/admin/productos#variantes">Ancla</a></nav><main class="beyonix-admin-main min-w-0 flex-1"><div id="root"></div></main></div><script>${bundle}</script></body></html>`
  await page.route("http://beyonix.test/**", (route) => route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html }))
  await page.goto("http://beyonix.test/admin/productos")
  await page.getByRole("textbox", { name: "Nombre del producto" }).waitFor()
  return page
}

const unsavedBadge = (page: Page) => page.getByRole("status").filter({ hasText: "Cambios sin guardar" })
const leaveDialog = (page: Page) => page.getByRole("dialog", { name: "Cambios sin guardar" })
const read = <T,>(page: Page, key: string) => page.evaluate((name) => (window as unknown as Record<string, unknown>)[name], key) as Promise<T>
const beforeUnloadBlocks = (page: Page) => page.evaluate(() => {
  const event = new Event("beforeunload", { cancelable: true })
  window.dispatchEvent(event)
  return event.defaultPrevented
})

test("editar el precio avisa, guardar limpia y sin cambios se sale directo", async () => {
  const page = await openEditor()
  try {
    assert.equal(await unsavedBadge(page).count(), 0)
    assert.equal(await beforeUnloadBlocks(page), false, "sin cambios no hay beforeunload")
    await page.locator("#precio").fill("21500")
    await unsavedBadge(page).waitFor()
    assert.equal(await beforeUnloadBlocks(page), true, "con cambios el refresh/cierre advierte")

    await page.getByRole("button", { name: "Guardar cambios" }).click()
    await page.getByText("Producto actualizado correctamente.").waitFor()
    const [call] = await read<Array<{ payload: { precio: number }; revision: number }>>(page, "updateCalls")
    assert.equal(call.payload.precio, 21500)
    assert.equal(call.revision, 3)
    assert.equal(await unsavedBadge(page).count(), 0, "guardar quita el aviso")
    assert.equal(await beforeUnloadBlocks(page), false, "guardar quita el listener")

    await page.getByRole("button", { name: "Volver a productos" }).click()
    assert.equal(await leaveDialog(page).count(), 0)
    assert.equal(await read<number>(page, "cancelCalls"), 1)
  } finally { await page.close() }
})

test("flecha, X y navegación interna con cambios piden confirmación", async () => {
  const page = await openEditor()
  try {
    await page.getByRole("button", { name: "Categoría" }).click()
    await page.getByRole("option", { name: "Accesorios" }).click()
    await unsavedBadge(page).waitFor()

    await page.getByRole("button", { name: "Volver a productos" }).click()
    await leaveDialog(page).getByText("Tenés cambios sin guardar. ¿Querés salir igualmente?").waitFor()
    assert.equal(await read<number | undefined>(page, "cancelCalls"), undefined, "la flecha no sale sola")
    await leaveDialog(page).getByRole("button", { name: "Seguir editando" }).click()
    assert.equal(await leaveDialog(page).count(), 0)
    assert.match(await page.getByRole("button", { name: "Categoría" }).textContent() ?? "", /Accesorios/, "seguir editando conserva los cambios")

    await page.getByRole("button", { name: "Cancelar" }).click()
    await leaveDialog(page).waitFor()
    await leaveDialog(page).getByRole("button", { name: "Salir sin guardar" }).click()
    assert.equal(await read<number>(page, "cancelCalls"), 1)

    await page.getByRole("link", { name: "Pedidos" }).click()
    await leaveDialog(page).waitFor()
    assert.equal(page.url(), "http://beyonix.test/admin/productos", "el link no navega antes de confirmar")
    assert.equal(await read<string | undefined>(page, "pushedHref"), undefined)
    await leaveDialog(page).getByRole("button", { name: "Salir sin guardar" }).click()
    assert.equal(await read<string>(page, "pushedHref"), "/admin/pedidos")
    assert.equal(await read<number>(page, "cancelCalls"), 2)
  } finally { await page.close() }
})

test("un guardado fallido o un conflicto de revisión conserva los cambios y el aviso", async () => {
  const page = await openEditor()
  try {
    await page.locator("#peso_empaquetado_kg").fill("0,45")
    await page.locator("#video_url").fill("https://example.com/malibu.mp4")
    await unsavedBadge(page).waitFor()
    await page.evaluate((message) => { (window as unknown as { nextUpdateError: string }).nextUpdateError = message }, CONFLICT_MESSAGE)

    await page.getByRole("button", { name: "Guardar cambios" }).click()
    await page.getByText(CONFLICT_MESSAGE, { exact: false }).waitFor()
    assert.equal(await unsavedBadge(page).count(), 1, "el conflicto no descarta los cambios")
    assert.equal(await page.locator("#peso_empaquetado_kg").inputValue(), "0,45")
    assert.equal(await page.locator("#video_url").inputValue(), "https://example.com/malibu.mp4")
    assert.equal(await read<number | undefined>(page, "savedCalls"), undefined)
    assert.equal(await beforeUnloadBlocks(page), true)

    await page.getByRole("button", { name: "Volver a productos" }).click()
    await leaveDialog(page).waitFor()
  } finally { await page.close() }
})

test("imágenes y especificaciones guardadas no marcan la ficha; la activación pendiente sí", async () => {
  const page = await openEditor()
  try {
    await page.getByRole("button", { name: "Subir imagen de variante" }).click()
    await page.getByRole("button", { name: "Guardar especificación" }).click()
    assert.equal(await unsavedBadge(page).count(), 0, "guardado inmediato sin falso aviso")
    await page.getByRole("button", { name: "Volver a productos" }).click()
    assert.equal(await leaveDialog(page).count(), 0)
    assert.equal(await read<number>(page, "cancelCalls"), 1)

    await page.getByRole("button", { name: "Alternar variante NEGRO" }).click()
    await unsavedBadge(page).waitFor()
    await page.getByRole("button", { name: "Guardar cambios" }).click()
    await page.getByText("Producto actualizado correctamente.").waitFor()
    const [call] = await read<Array<{ states: Record<string, boolean> }>>(page, "updateCalls")
    assert.deepEqual(call.states, { 9: true })
    assert.equal(await unsavedBadge(page).count(), 0)
  } finally { await page.close() }
})

for (const [width, theme] of [[1440, "dark"], [1440, "light"], [390, "dark"], [390, "light"]] as const) {
  test(`aviso de cambios sin guardar visible y sin scroll horizontal a ${width}px (${theme})`, async () => {
    const page = await openEditor(width, theme)
    try {
      await page.locator("#precio").fill("19999")
      await unsavedBadge(page).waitFor()
      const layout = await page.evaluate(() => {
        const badge = document.querySelector(".product-editor-unsaved")!
        const rect = badge.getBoundingClientRect()
        const actions = document.querySelector(".product-editor-window-actions")!.getBoundingClientRect()
        return {
          color: getComputedStyle(badge).color,
          background: getComputedStyle(document.body).backgroundColor,
          left: rect.left,
          right: rect.right,
          insideActions: rect.top >= actions.top - 1 && rect.bottom <= actions.bottom + 1,
          overflow: document.documentElement.scrollWidth > innerWidth,
        }
      })
      assert.equal(layout.overflow, false, "sin scroll horizontal nuevo")
      assert.ok(layout.left >= 0 && layout.right <= width, "el aviso entra en pantalla")
      assert.ok(layout.insideActions, "el aviso queda junto a Guardar")
      if (theme === "light") assert.equal(layout.color, "rgb(180, 83, 9)", "ámbar legible sobre fondo claro")
      else assert.ok(!["rgb(180, 83, 9)", "rgb(255, 255, 255)"].includes(layout.color), `ámbar claro sobre fondo oscuro: ${layout.color}`)
      await page.getByRole("button", { name: "Cancelar" }).click()
      await leaveDialog(page).waitFor()
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "el diálogo no agrega scroll")
    } finally { await page.close() }
  })
}
