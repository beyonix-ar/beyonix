import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { build, type Plugin } from "esbuild"
import { chromium, type Browser } from "playwright-core"
import postcss from "postcss"
import tailwindcss from "@tailwindcss/postcss"

const stubs: Plugin = {
  name: "product-editor-fixture",
  setup(pluginBuild) {
    const modules: Record<string, string> = {
      "use-producto-form": `import { useState } from "react";
        export function useProductoForm() {
          const [form, setForm] = useState({ nombre: "Apoyabrazos ergonómico", slug: "apoyabrazos", sku: "AP01", categoria_id: "1", precio: "20000", precio_anterior: "25000", pricingMode: "manual", targetMarginPercent: "", descripcion: "", video_url: "", peso_empaquetado_kg: "1", largo_paquete_cm: "20", ancho_paquete_cm: "10", alto_paquete_cm: "5", destacado: false, activo: false });
          const setField = (key, value) => setForm((current) => ({ ...current, [key]: value }));
          window.formValue = form;
          return { form, error: "", success: "", saving: false, savedId: null, categorias: [{ id: 1, nombre: "Accesorios" }, { id: 2, nombre: "Hogar" }], logisticsFieldError: null, knownUnitCost: null, variantCosts: [], missingVariantCosts: [], priceRecalculation: null, setField, showError: () => {}, submit: async () => { window.saveCalls = (window.saveCalls || 0) + 1 }, handleNombreChange: (value) => setField("nombre", value) };
        }`,
      "use-site-settings": `export function useSiteSettings() { return { installmentsFinancing: {}, pricing: { transferDiscountPercent: 0 } } }`,
      "product-pricing": `export const calculateTargetMarginPrice = () => null; export const simulateProductProfitability = () => null;`,
      "product-activation": `export const getProductActivationStatus = () => ({ ready: true, checks: [] });`,
      "product-variants-editor": `import React from "react"; export function ProductVariantsEditor() { return <section aria-label="Variantes">Variantes</section> }; export function StockSummaryItem({label,value}) { return <div className="product-editor-metric">{label}: {value ?? 0}</div> }`,
      "product-specifications-editor": `import React from "react"; export function ProductSpecificationsEditor() { return <section aria-label="Especificaciones">Especificaciones</section> }`,
      "admin-product-preview-modal": `import React from "react"; export function AdminProductPreviewModal({onClose}) { return <div role="dialog" aria-label="Vista previa del producto"><button onClick={onClose}>Cerrar vista previa</button></div> }`,
      "product-requirements-popover": `import React from "react"; export function ProductRequirementsPopover() { return <button type="button" aria-label="Requisitos para activar">Requisitos para activar</button> }`,
    }
    pluginBuild.onResolve({ filter: /(?:use-producto-form|use-site-settings|product-pricing|product-activation|product-variants-editor|product-specifications-editor|admin-product-preview-modal|product-requirements-popover)$/ }, (args) => {
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
      contents: `import React from "react"; import { createRoot } from "react-dom/client"; import { ProductoForm } from "./app/admin/sections/productos/producto-form.tsx";
        createRoot(document.getElementById("root")).render(<ProductoForm producto={{ id: 1, nombre: "Apoyabrazos ergonómico", producto_variantes: [], producto_especificaciones: [] }} onSaved={() => {}} onCancel={() => { window.cancelCalls = (window.cancelCalls || 0) + 1 }} />);`,
      resolveDir: process.cwd(), loader: "tsx", sourcefile: "product-editor-fixture.tsx",
    },
    bundle: true, platform: "browser", format: "iife", write: false,
    alias: { "@": process.cwd() }, jsx: "automatic", plugins: [stubs],
  })
  bundle = result.outputFiles[0].text
  browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chrome", headless: true })
})

test.after(async () => { await browser?.close() })

for (const width of [1920, 1600, 1440, 1366, 1280, 1024, 768, 390]) {
  test(`editor de producto se adapta a ${width}px sin perder controles`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 900 } })
    try {
      await page.setContent(`<!doctype html><html data-admin-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><style>*{box-sizing:border-box}body{margin:0;background:#07111b}#root{width:calc(100% - 220px);margin-left:220px}@media(max-width:1100px){#root{width:100%;margin-left:0}}</style></head><body><div class="beyonix-admin-shell"><main class="beyonix-admin-main"><div id="root"></div></main></div><script>${bundle}</script></body></html>`)
      await page.getByRole("textbox", { name: "Nombre del producto" }).waitFor()
      const columns = await page.locator(".product-editor-workspace").evaluate((node) => getComputedStyle(node).gridTemplateColumns.split(" ").length)
      assert.equal(columns, width >= 1024 ? 2 : 1)
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `overflow a ${width}px`)
      assert.equal(await page.getByRole("button", { name: "Categoría" }).count(), 1)
      for (const name of ["Nombre del producto", "Peso en kg (obligatorio)", "Largo en cm (obligatorio)", "Ancho en cm (obligatorio)", "Profundidad en cm (obligatorio)", "URL del video"]) {
        assert.equal(await page.getByRole("textbox", { name }).count() + await page.getByRole("combobox", { name }).count(), 1, name)
      }
      assert.equal(await page.getByRole("button", { name: "Destacado" }).count(), 1)
      assert.equal(await page.getByRole("button", { name: "Guardar cambios" }).count(), 1)
      assert.equal(await page.getByRole("button", { name: "Cancelar" }).count(), 1)
      assert.equal(await page.getByRole("button", { name: "Vista previa" }).count(), 1)
      assert.equal(await page.getByRole("button", { name: "Requisitos para activar" }).count(), 1)
      assert.equal(await page.getByLabel("Resumen del inventario").locator(".product-editor-metric").count(), 7)
      assert.equal(await page.getByText("Precio y stock").count(), 1)
      assert.equal(await page.getByText("Logística", { exact: true }).count(), 1)
      assert.equal(await page.getByText("Descripción", { exact: true }).count(), 1)
    } finally { await page.close() }
  })
}

test("título, destacado, vista previa, guardado y cancelación comparten el estado del formulario", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  try {
    await page.setContent(`<!doctype html><html data-admin-theme="dark"><head><meta charset="utf-8"><style>${css}</style></head><body><div id="root"></div><script>${bundle}</script></body></html>`)
    const title = page.getByRole("textbox", { name: "Nombre del producto" })
    await title.fill("Nuevo título Ñandú")
    assert.equal(await page.evaluate(() => (window as unknown as { formValue: { nombre: string } }).formValue.nombre), "Nuevo título Ñandú")
    await page.getByRole("button", { name: "Destacado" }).click()
    assert.equal(await page.getByRole("button", { name: "Destacado" }).getAttribute("aria-pressed"), "true")
    assert.equal(await page.evaluate(() => (window as unknown as { formValue: { destacado: boolean } }).formValue.destacado), true)
    await page.getByRole("button", { name: "Categoría" }).click()
    await page.getByRole("option", { name: "Hogar" }).click()
    await page.locator("#precio").fill("30000")
    await page.locator("#precio_anterior").fill("35000")
    await page.locator("#peso_empaquetado_kg").fill("1,5")
    await page.locator("#largo_paquete_cm").fill("30")
    await page.locator("#ancho_paquete_cm").fill("20")
    await page.locator("#alto_paquete_cm").fill("10")
    await page.locator("#video_url").fill("https://example.com/video")
    const formValue = await page.evaluate(() => (window as unknown as { formValue: Record<string, string> }).formValue)
    assert.equal(formValue.categoria_id, "2")
    assert.equal(formValue.precio, "30000")
    assert.equal(formValue.precio_anterior, "35000")
    assert.equal(formValue.peso_empaquetado_kg, "1,5")
    assert.equal(formValue.largo_paquete_cm, "30")
    assert.equal(formValue.ancho_paquete_cm, "20")
    assert.equal(formValue.alto_paquete_cm, "10")
    assert.equal(formValue.video_url, "https://example.com/video")
    await page.getByRole("button", { name: "Vista previa" }).click()
    assert.equal(await page.getByRole("dialog", { name: "Vista previa del producto" }).count(), 1)
    await page.getByRole("button", { name: "Cerrar vista previa" }).click()
    await page.getByRole("button", { name: "Guardar cambios" }).click()
    assert.equal(await page.evaluate(() => (window as unknown as { saveCalls: number }).saveCalls), 1)
    await page.getByRole("button", { name: "Cancelar" }).click()
    assert.equal(await page.evaluate(() => (window as unknown as { cancelCalls: number }).cancelCalls), 1)
  } finally { await page.close() }
})

test("descripción mantiene cuatro selects uniformes y no muestra A− ni A+", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  try {
    await page.setContent(`<!doctype html><html data-admin-theme="dark"><head><meta charset="utf-8"><style>${css}</style></head><body><div id="root"></div><script>${bundle}</script></body></html>`)
    await page.getByRole("combobox", { name: "Tamaño de letra" }).waitFor()
    const styles = await page.locator(".product-rich-select").evaluateAll((selects) => selects.map((select) => {
      const style = getComputedStyle(select)
      return [style.height, style.borderRadius, style.borderColor, style.backgroundColor, style.paddingLeft, style.fontSize]
    }))
    assert.equal(styles.length, 4)
    assert.ok(styles.every((style) => JSON.stringify(style) === JSON.stringify(styles[0])))
    assert.equal(await page.getByRole("button", { name: "Achicar texto" }).count(), 0)
    assert.equal(await page.getByRole("button", { name: "Agrandar texto" }).count(), 0)
  } finally { await page.close() }
})
