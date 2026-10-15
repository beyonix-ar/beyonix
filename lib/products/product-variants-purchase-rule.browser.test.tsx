import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { build, type Plugin } from "esbuild"
import { chromium, type Browser, type Page } from "playwright-core"
import postcss from "postcss"
import tailwindcss from "@tailwindcss/postcss"

// Editor de variantes REAL (ProductVariantsEditor) con las consultas
// simuladas desde la página: en un producto guardado no hay alta libre (sólo
// la leyenda + "Ir a Compras"), el doble click en "Eliminar" dispara una sola
// baja, una variante con historial queda archivada y una respuesta vieja de
// otro producto nunca pisa la vista actual. El borrador de un producto nuevo
// sigue armando sus variantes.

const stubs: Plugin = {
  name: "variants-editor-fixture",
  setup(pluginBuild) {
    const modules: Record<string, string> = {
      "producto-variantes": `
        const record = (name, args) => { (window.__calls ||= []).push({ name, args }); };
        export async function getProductoVariantes(productId) { record("getProductoVariantes", [productId]); return window.__getVariants(productId) }
        export async function getProductVariantDistribution(productId) { const variants = await window.__getVariants(productId, true); return { totalStock: 0, normalStock: 0, discountedStock: 0, nonSellableStock: 0, pendingReviewStock: 0, sellableStock: 0, quarantineStock: 0, physicalStock: 0, reservedStock: 0, availableStock: 0, genericBalance: 0, assignableQuantity: 0, allocatedQuantity: 0, unassignedQuantity: 0, allocationOverflow: 0, variants: variants.map((variant) => ({ variant_id: variant.id, allocated_quantity: 0, reserved_quantity: 0, available_quantity: 0 })) } }
        export async function deleteProductoVariante(productId, id) { record("deleteProductoVariante", [productId, id]); return window.__delete(productId, id) }
        export async function generateProductoVarianteBarcode() { throw new Error("no usado") }
        export async function reorderProductoVariantes() { throw new Error("no usado") }
        export async function updateProductoVariante() { throw new Error("no usado") }
      `,
      "producto-imagenes": `export async function deleteProductoImageByUrl() {} export async function uploadProductoVariantImages() { return [] }`,
      "add-to-label-queue-dialog": `export function AddToLabelQueueDialog() { return null }`,
      "use-stock-adjustment": `export function useStockAdjustment() { return { openStockAdjustment: () => {}, stockAdjustmentModal: null } }`,
      "product-sales-options": `export function ProductSalesOptions() { return null }`,
      "link": `import React from "react"; export default function Link({ href, children, ...props }) { return <a href={href} {...props}>{children}</a> }`,
    }
    pluginBuild.onResolve({ filter: /(?:queries[\\/]producto-variantes|queries[\\/]producto-imagenes|add-to-label-queue-dialog|use-stock-adjustment|product-sales-options|^next\/link)$/ }, (args) => {
      const name = args.path.split(/[\\/]/).at(-1)!
      return { path: name, namespace: "fixture" }
    })
    pluginBuild.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({ contents: modules[args.path], loader: "tsx", resolveDir: process.cwd() }))
  },
}

let browser: Browser
let bundle: string
let css: string

test.before(async () => {
  css = (await postcss([tailwindcss({ base: process.cwd() })]).process(readFileSync("app/globals.css", "utf8"), { from: "app/globals.css" })).css
  const result = await build({
    stdin: {
      contents: `import React, { useState } from "react"; import { createRoot } from "react-dom/client";
        import { ProductVariantsEditor } from "./app/admin/sections/productos/product-variants-editor.tsx";
        function Harness() {
          const [productId, setProductId] = useState(window.__initialProduct);
          const [drafts, setDrafts] = useState([]);
          return <div>
            <button type="button" onClick={() => setProductId(13)}>Cambiar de producto</button>
            <ProductVariantsEditor productoId={productId ?? undefined} productName="AURICULAR INALAMBRICO LEGATUS" draftVariants={drafts} onDraftVariantsChange={setDrafts} />
          </div>
        }
        createRoot(document.getElementById("root")).render(<Harness />);`,
      resolveDir: process.cwd(), loader: "tsx", sourcefile: "variants-editor-fixture.tsx",
    },
    bundle: true, platform: "browser", format: "iife", write: false,
    alias: { "@": process.cwd() }, jsx: "automatic", plugins: [stubs],
    define: { "process.env.NODE_ENV": '"production"' }, logLevel: "error",
  })
  bundle = result.outputFiles[0].text
  browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chrome", headless: true })
})

test.after(async () => { await browser?.close() })

const variant = (id: number, productId: number, nombre: string, color: string, extra: Record<string, unknown> = {}) => ({
  id, producto_id: productId, nombre, color_hex: color, color_hex_secundario: null, sku: `SKU${id}`, codigo_barra: null,
  stock: 0, activo: true, orden: id, imagenes: [], peso_empaquetado_kg: null, alto_paquete_cm: null, ancho_paquete_cm: null, largo_paquete_cm: null, ...extra,
})

async function open(setup: string): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  // localhost es contexto seguro (crypto.randomUUID existe, como en el admin real por HTTPS).
  const html = `<!doctype html><html data-admin-theme="dark"><head><meta charset="utf-8"><style>${css}</style></head><body><main class="beyonix-admin-main"><div id="root"></div></main><script>${setup}</script><script>${bundle}</script></body></html>`
  await page.route("**/*", (route) =>
    route.request().url() === "http://localhost/"
      ? route.fulfill({ contentType: "text/html; charset=utf-8", body: html })
      : route.abort(),
  )
  await page.goto("http://localhost/")
  if (errors.length) throw new Error(errors.join(" | "))
  return page
}

const calls = (page: Page, name: string) =>
  page.evaluate((callName) => (window as unknown as { __calls?: { name: string }[] }).__calls?.filter((call) => call.name === callName).length ?? 0, name)

test("producto guardado: sin alta libre, leyenda e 'Ir a Compras' con el producto; doble click archiva una sola vez", async () => {
  const azul = variant(6, 12, "AZUL", "#C2D8EB", { stock: 4, codigo_barra: "7796350519950" })
  const rosa = variant(12, 12, "ROSA", "#ECA2A2")
  const page = await open(`
    window.__initialProduct = 12;
    window.__variants = ${JSON.stringify([azul, rosa])};
    window.__getVariants = async () => window.__variants;
    window.__delete = async (productId, id) => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      window.__variants = window.__variants.map((item) => item.id === id ? { ...item, activo: false } : item);
      return { mode: "archived", reasons: ["tiene stock"], message: "La variante se archivó (quedó inactiva) para conservar su historial: tiene stock.", variant: window.__variants.find((item) => item.id === id) };
    };
  `)
  try {
    const rule = page.locator("[data-variant-creation-rule]")
    await rule.waitFor()
    assert.match(await rule.innerText(), /Las nuevas variantes se crean al registrar una compra de mercadería\./)
    assert.equal(await rule.getByRole("link", { name: /Ir a Compras/ }).getAttribute("href"), "/admin/compras?producto=12")
    assert.equal(await page.getByRole("button", { name: "Agregar una variante" }).count(), 0, "sin alta directa")
    assert.equal(await page.getByRole("button", { name: "Crear variante" }).count(), 0)
    assert.equal(await page.getByText("Nueva variante", { exact: true }).count(), 0)

    await page.getByRole("button", { name: "Eliminar variante AZUL" }).first().click()
    const dialog = page.getByRole("dialog")
    await dialog.getByText(/no se borra: se archiva/).waitFor()
    await dialog.getByRole("button", { name: "Eliminar variante", exact: true }).dblclick()
    await page.getByText(/se archivó \(quedó inactiva\)/).waitFor()
    assert.equal(await calls(page, "deleteProductoVariante"), 1, "doble click = una sola baja")
    assert.equal(await page.getByRole("button", { name: "Eliminar variante AZUL" }).count() > 0, true, "la variante archivada sigue en la lista")
  } finally {
    await page.close()
  }
})

test("respuesta vieja de otro producto no pisa la vista actual", async () => {
  const page = await open(`
    window.__initialProduct = 12;
    window.__getVariants = async (productId) => {
      if (productId === 12) {
        await new Promise((resolve) => setTimeout(resolve, 700));
        return ${JSON.stringify([variant(6, 12, "AZUL", "#C2D8EB")])};
      }
      return ${JSON.stringify([variant(30, 13, "VERDE", "#00AA00")])};
    };
    window.__delete = async () => { throw new Error("no usado") };
  `)
  try {
    await page.getByRole("button", { name: "Cambiar de producto" }).click()
    await page.getByRole("button", { name: "Eliminar variante VERDE" }).first().waitFor()
    await page.waitForTimeout(1000)
    assert.equal(await page.getByRole("button", { name: "Eliminar variante AZUL" }).count(), 0, "la respuesta tardía del producto anterior se descarta")
    assert.ok(await page.getByRole("button", { name: "Eliminar variante VERDE" }).first().isVisible())
  } finally {
    await page.close()
  }
})

test("producto nuevo (borrador): sigue armando sus variantes antes del primer guardado", async () => {
  const page = await open(`
    window.__initialProduct = null;
    window.__getVariants = async () => [];
    window.__delete = async () => { throw new Error("no usado") };
  `)
  try {
    await page.getByText("Nueva variante", { exact: true }).waitFor()
    await page.getByRole("button", { name: "Crear variante" }).click()
    await page.getByText("Variante agregada al borrador.").waitFor()
    assert.equal(await page.locator("[data-variant-creation-rule]").count(), 0)
    assert.equal(await calls(page, "deleteProductoVariante"), 0)
  } finally {
    await page.close()
  }
})
