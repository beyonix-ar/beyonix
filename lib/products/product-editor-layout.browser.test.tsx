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
      await page.setContent(`<!doctype html><html data-admin-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div class="beyonix-admin-shell min-h-screen text-white lg:flex"><div class="hidden lg:block"><aside class="beyonix-admin-sidebar"></aside></div><main class="beyonix-admin-main min-w-0 flex-1"><div id="root"></div></main></div><script>${bundle}</script></body></html>`)
      await page.getByRole("textbox", { name: "Nombre del producto" }).waitFor()
      const layout = await page.locator(".product-editor-workspace").evaluate((node) => {
        const workspace = node.getBoundingClientRect()
        const screen = document.querySelector(".product-editor-screen")!.getBoundingClientRect()
        const columns = Array.from(node.querySelectorAll(":scope > .product-editor-column"), (column) => column.getBoundingClientRect())
        const stockGrid = document.querySelector(".product-editor-stock-grid")!
        const stockMetrics = Array.from(stockGrid.querySelectorAll(".product-editor-metric"), (metric) => {
          const rect = metric.getBoundingClientRect()
          return { label: metric.textContent?.trim() ?? "", top: rect.top, width: rect.width, height: rect.height }
        })
        const logistics = document.querySelector("[data-logistics-row]")!
        const labels = Array.from(logistics.querySelectorAll(".product-editor-field-label"), (label) => {
          const rect = label.getBoundingClientRect()
          return { width: rect.width, height: rect.height, lineHeight: parseFloat(getComputedStyle(label).lineHeight) }
        })
        const fieldWidths = Array.from(logistics.querySelectorAll("input"), (input) => input.getBoundingClientRect().width)
        const logisticsCard = document.querySelector(".product-editor-dimensions-cell .product-editor-panel")!.getBoundingClientRect()
        const videoWidth = document.querySelector("#video_url")!.getBoundingClientRect().width
        const categoryWidth = document.querySelector(".product-editor-dimensions-cell .admin-control-select")!.getBoundingClientRect().width
        return {
          screenWidth: screen.width,
          workspaceWidth: workspace.width,
          workspaceRight: workspace.right,
          columnWidths: columns.map((column) => column.width),
          columnTops: columns.map((column) => column.top),
          stockColumns: getComputedStyle(stockGrid).gridTemplateColumns.split(" ").length,
          stockMetrics,
          logisticsColumns: getComputedStyle(logistics).gridTemplateColumns.split(" ").length,
          labels,
          fieldWidths,
          logisticsCardWidth: logisticsCard.width,
          videoWidth,
          categoryWidth,
        }
      })
      assert.equal(layout.columnWidths.length, 2)
      assert.ok(layout.workspaceWidth >= layout.screenWidth * 0.9, `el editor pierde ancho útil a ${width}px`)
      if (width >= 1024) {
        assert.ok(layout.columnWidths.every((columnWidth) => columnWidth > layout.workspaceWidth * 0.35), `columna colapsada a ${width}px: ${layout.columnWidths}`)
        assert.ok(Math.abs(layout.columnTops[0] - layout.columnTops[1]) < 1, `columnas apiladas a ${width}px`)
      } else {
        assert.ok(layout.columnTops[1] > layout.columnTops[0], `columnas no apiladas a ${width}px`)
      }
      assert.equal(layout.stockColumns, width >= 1280 || width === 768 ? 4 : 2, `columnas de stock a ${width}px`)
      assert.deepEqual(layout.stockMetrics.map((metric) => metric.label.split(":")[0]), [
        "Stock físico", "Stock normal", "Stock con descuento", "Disponible para vender",
        "Fallado / no vendible", "Pendiente de revisión", "Reservado (checkout)",
      ])
      assert.ok(layout.stockMetrics.every((metric) => Math.abs(metric.width - layout.stockMetrics[0].width) < 1 && Math.abs(metric.height - layout.stockMetrics[0].height) < 1), `cards de stock desiguales a ${width}px`)
      if (layout.stockColumns === 4) {
        assert.ok(layout.stockMetrics.slice(0, 4).every((metric) => Math.abs(metric.top - layout.stockMetrics[0].top) < 1), `primera fila de stock incorrecta a ${width}px`)
        assert.ok(layout.stockMetrics.slice(4).every((metric) => Math.abs(metric.top - layout.stockMetrics[4].top) < 1), `segunda fila de stock incorrecta a ${width}px`)
        assert.ok(layout.stockMetrics[4].top > layout.stockMetrics[0].top, `stock sin segunda fila a ${width}px`)
      }
      assert.ok(layout.logisticsColumns >= 2, `logística comprimida a ${width}px`)
      assert.ok(layout.labels.every((label) => label.width >= 60), `labels comprimidos a ${width}px`)
      assert.ok(layout.labels.every((label) => label.height <= label.lineHeight * 1.5), `labels partidos a ${width}px`)
      assert.ok(layout.fieldWidths.every((fieldWidth) => fieldWidth >= 60), `inputs comprimidos a ${width}px`)
      assert.ok(layout.categoryWidth > layout.logisticsCardWidth * 0.8, `categoría angosta a ${width}px`)
      assert.ok(layout.videoWidth > layout.logisticsCardWidth * 0.8, `video angosto a ${width}px`)
      assert.ok(layout.workspaceRight <= width + 1, `editor desborda a ${width}px`)
      assert.ok(await page.locator(".product-editor-specifications-cell").isVisible())
      assert.ok(await page.locator(".product-editor-description-cell").isVisible())
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

for (const width of [1440, 1280, 1024, 390]) {
  test(`título largo y controles de precio conservan su orden a ${width}px`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 900 } })
    try {
      await page.setContent(`<!doctype html><html data-admin-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div class="beyonix-admin-shell min-h-screen text-white lg:flex"><div class="hidden lg:block"><aside class="beyonix-admin-sidebar"></aside></div><main class="beyonix-admin-main min-w-0 flex-1"><div id="root"></div></main></div><script>${bundle}</script></body></html>`)
      const title = page.getByRole("textbox", { name: "Nombre del producto" })
      await title.fill("APOYABRAZOS DE ESCRITORIO ERGONÓMICO 360°")
      const geometry = await page.locator(".product-editor-screen").evaluate((screen) => {
        const input = screen.querySelector<HTMLInputElement>(".product-editor-title-input")!
        const titleRect = input.getBoundingClientRect()
        const headingRect = screen.querySelector(".product-editor-heading")!.getBoundingClientRect()
        const actionsRect = screen.querySelector(".product-editor-window-actions")!.getBoundingClientRect()
        const pencilRect = input.nextElementSibling!.getBoundingClientRect()
        const fields = Array.from(screen.querySelectorAll(".product-editor-price-fields label"), (field) => field.getBoundingClientRect())
        const priceActions = screen.querySelector(".product-editor-price-actions")!.getBoundingClientRect()
        const buttons = Array.from(screen.querySelectorAll(".product-editor-price-actions button"), (button) => button.getBoundingClientRect())
        const ctx = document.createElement("canvas").getContext("2d")!
        const inputStyle = getComputedStyle(input)
        ctx.font = inputStyle.font
        return {
          titleWidth: titleRect.width,
          textWidth: ctx.measureText(input.value).width,
          titlePadding: parseFloat(inputStyle.paddingLeft) + parseFloat(inputStyle.paddingRight),
          headingWidth: headingRect.width,
          headingTop: headingRect.top,
          headingBottom: headingRect.bottom,
          actionsTop: actionsRect.top,
          actionsBottom: actionsRect.bottom,
          pencilAfterTitle: pencilRect.left >= titleRect.right - 1,
          fieldLefts: fields.map((field) => field.left),
          fieldBottoms: fields.map((field) => field.bottom),
          priceActionsBottom: priceActions.bottom,
          buttonLefts: buttons.map((button) => button.left),
        }
      })
      assert.ok(geometry.titleWidth > geometry.headingWidth * (width >= 1024 ? 0.7 : 0.6), `título angosto a ${width}px`)
      assert.ok(geometry.pencilAfterTitle, `lápiz fuera de posición a ${width}px`)
      if (width >= 1024) {
        assert.ok(geometry.actionsTop >= geometry.headingTop && geometry.actionsBottom <= geometry.headingBottom, `acciones fuera del header a ${width}px`)
      }
      if (width >= 1280) {
        assert.ok(geometry.titleWidth >= geometry.textWidth + geometry.titlePadding, `nombre truncado a ${width}px: ${geometry.titleWidth} < ${geometry.textWidth + geometry.titlePadding}`)
      }
      assert.ok(geometry.fieldLefts[0] < geometry.fieldLefts[1], `precio actual y anterior invertidos a ${width}px`)
      assert.ok(geometry.fieldLefts[1] < geometry.buttonLefts[0], `acciones del precio antes de los campos a ${width}px`)
      assert.ok(geometry.buttonLefts[0] < geometry.buttonLefts[1] && geometry.buttonLefts[1] < geometry.buttonLefts[2], `orden $ / % / ojo incorrecto a ${width}px`)
      assert.ok(Math.abs(geometry.fieldBottoms[1] - geometry.priceActionsBottom) < 2, `controles del precio desalineados a ${width}px`)
      await page.getByRole("button", { name: "Ganancia por porcentaje" }).click()
      const marginLayout = await page.locator(".product-editor-price-row").evaluate((row) => {
        const rowRect = row.getBoundingClientRect()
        const fieldsRect = row.querySelector(".product-editor-price-fields")!.getBoundingClientRect()
        const actionsRect = row.querySelector(".product-editor-price-actions")!.getBoundingClientRect()
        return { rowRight: rowRect.right, fieldsRight: fieldsRect.right, actionsRight: actionsRect.right, fieldsTop: fieldsRect.top, actionsTop: actionsRect.top }
      })
      assert.equal(await page.getByRole("button", { name: "Ganancia por porcentaje" }).getAttribute("aria-pressed"), "true")
      assert.ok(marginLayout.fieldsRight <= marginLayout.rowRight + 1 && marginLayout.actionsRight <= marginLayout.rowRight + 1, `modo porcentaje desborda a ${width}px`)
      assert.ok(marginLayout.actionsTop >= marginLayout.fieldsTop, `controles del modo porcentaje encima del precio a ${width}px`)
      const profitabilityTrigger = page.getByRole("button", { name: "Ver rentabilidad estimada" })
      await profitabilityTrigger.focus()
      await profitabilityTrigger.press("Enter")
      await page.getByRole("dialog", { name: "Rentabilidad estimada" }).waitFor({ state: "visible", timeout: 3000 })
      const profitStyle = await page.getByRole("dialog", { name: "Rentabilidad estimada" }).evaluate((dialog) => {
        const style = getComputedStyle(dialog)
        return { background: style.backgroundColor, border: style.borderColor, shadow: style.boxShadow }
      })
      assert.equal(profitStyle.background, "rgb(27, 30, 34)")
      assert.equal(profitStyle.border, "rgba(80, 220, 160, 0.55)")
      assert.notEqual(profitStyle.shadow, "none")
      await page.evaluate(() => { document.documentElement.dataset.adminTheme = "light" })
      const lightProfitStyle = await page.getByRole("dialog", { name: "Rentabilidad estimada" }).evaluate((dialog) => {
        const style = getComputedStyle(dialog)
        return { background: style.backgroundColor, border: style.borderColor, shadow: style.boxShadow }
      })
      assert.deepEqual(lightProfitStyle, profitStyle)
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
    await page.getByRole("button", { name: "Tamaño de letra" }).waitFor()
    const styles = await page.locator(".product-rich-select").evaluateAll((selects) => selects.map((select) => {
      const style = getComputedStyle(select)
      return [style.height, style.borderRadius, style.borderColor, style.backgroundColor, style.paddingLeft, style.fontSize]
    }))
    assert.equal(styles.length, 3)
    assert.ok(styles.every((style) => JSON.stringify(style) === JSON.stringify(styles[0])))
    assert.equal(await page.getByRole("button", { name: "Achicar texto" }).count(), 0)
    assert.equal(await page.getByRole("button", { name: "Agrandar texto" }).count(), 0)
  } finally { await page.close() }
})
