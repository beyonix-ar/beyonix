import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { build, type Plugin } from "esbuild"
import { chromium, type Browser, type Page } from "playwright-core"
import postcss from "postcss"
import tailwindcss from "@tailwindcss/postcss"

import {
  calculateTargetMarginPrice,
  getCashSaleProfitAmount,
  simulateProductProfitability,
} from "../pricing/product-pricing.ts"
import type { InstallmentsFinancingConfig } from "./installments.ts"

const CONFIG: InstallmentsFinancingConfig = {
  baseProcessingPercent: 6.42,
  ivaPercent: 21,
  surchargePercentByCount: { 2: 7.79, 3: 10.49, 6: 18.69 },
}
const TRANSFER_DISCOUNT_PERCENT = 10

interface PriceFixture {
  pricingMode: "manual" | "target_margin"
  targetMarginPercent: string
  knownUnitCost: number | null
  variantCosts: Array<{ variantId: number; variantName: string; unitCost: number | null }>
  missingVariantCosts: Array<{ variantId: number; variantName: string; unitCost: null }>
}

// Hook del formulario y settings stubeados; el cálculo de precio y
// rentabilidad es el REAL (lib/pricing/product-pricing.ts), igual que en Admin.
const stubs: Plugin = {
  name: "product-price-card-fixture",
  setup(pluginBuild) {
    const modules: Record<string, string> = {
      "use-producto-form": `import { useState } from "react";
        export function useProductoForm() {
          const fixture = window.priceFixture;
          const [form, setForm] = useState({ nombre: "Apoyabrazos ergonómico", slug: "apoyabrazos", sku: "AP01", categoria_id: "1", precio: "20000", precio_anterior: "45000", pricingMode: fixture.pricingMode, targetMarginPercent: fixture.targetMarginPercent, descripcion: "", video_url: "", peso_empaquetado_kg: "1", largo_paquete_cm: "20", ancho_paquete_cm: "10", alto_paquete_cm: "5", destacado: false, activo: false });
          const setField = (key, value) => setForm((current) => ({ ...current, [key]: value }));
          return { form, error: "", success: "", saving: false, savedId: null, categorias: [{ id: 1, nombre: "Accesorios" }], logisticsFieldError: null, knownUnitCost: fixture.knownUnitCost, variantCosts: fixture.variantCosts, missingVariantCosts: fixture.missingVariantCosts, priceRecalculation: null, setField, showError: () => {}, submit: async () => {}, handleNombreChange: (value) => setField("nombre", value) };
        }`,
      "navigation": `export function useRouter() { return { push: () => {} } }`,
      "use-site-settings": `export function useSiteSettings() { return { installmentsFinancing: ${JSON.stringify(CONFIG)}, pricing: { transferDiscountPercent: ${TRANSFER_DISCOUNT_PERCENT} } } }`,
      "product-activation": `export const getProductActivationStatus = () => ({ ready: true, firstError: null, requirements: [], primaryVariant: null });`,
      "product-variants-editor": `import React from "react"; export function ProductVariantsEditor() { return <section aria-label="Variantes">Variantes</section> }; export function StockSummaryItem({label,value}) { return <div className="product-editor-metric">{label}: {value ?? 0}</div> }`,
      "product-specifications-editor": `import React from "react"; export function ProductSpecificationsEditor() { return <section aria-label="Especificaciones">Especificaciones</section> }`,
      "admin-product-preview-modal": `import React from "react"; export function AdminProductPreviewModal() { return null }`,
      "product-requirements-popover": `import React from "react"; export function ProductRequirementsPopover() { return null }; export function PublicationChecklist() { return null }`,
    }
    pluginBuild.onResolve({ filter: /(?:use-producto-form|next\/navigation|use-site-settings|product-activation|product-variants-editor|product-specifications-editor|admin-product-preview-modal|product-requirements-popover)$/ }, (args) => {
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
        createRoot(document.getElementById("root")).render(<ProductoForm producto={{ id: 1, nombre: "Apoyabrazos ergonómico", producto_variantes: [], producto_especificaciones: [] }} onSaved={() => {}} onCancel={() => {}} />);`,
      resolveDir: process.cwd(), loader: "tsx", sourcefile: "product-price-card-fixture.tsx",
    },
    bundle: true, platform: "browser", format: "iife", write: false,
    alias: { "@": process.cwd() }, jsx: "automatic", plugins: [stubs],
    // lib/store-config.ts lee process.env (en Next lo inlinea el bundler).
    define: { "process.env.NODE_ENV": '"production"', "process.env": "{}" }, logLevel: "error",
  })
  bundle = result.outputFiles[0].text
  browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chrome", headless: true })
})

test.after(async () => { await browser?.close() })

const BASE_FIXTURE: PriceFixture = {
  pricingMode: "target_margin",
  targetMarginPercent: "40",
  knownUnitCost: 10_000,
  variantCosts: [],
  missingVariantCosts: [],
}

async function openEditor(width: number, theme: "dark" | "light", fixture: PriceFixture): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height: 900 } })
  await page.setContent(`<!doctype html><html data-admin-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><style>*,*::before,*::after{transition:none!important}</style></head><body><div class="beyonix-admin-shell min-h-screen text-white lg:flex"><div class="hidden lg:block"><aside class="beyonix-admin-sidebar"></aside></div><main class="beyonix-admin-main min-w-0 flex-1"><div id="root"></div></main></div><script>window.priceFixture = ${JSON.stringify(fixture)}</script><script>${bundle}</script></body></html>`)
  await page.getByRole("textbox", { name: "Nombre del producto" }).waitFor()
  return page
}

function readPriceRow(page: Page) {
  return page.locator(".product-editor-price-row").evaluate((row) => {
    const fields = Array.from(row.querySelectorAll(":scope > .product-editor-price-fields > label"), (label) => {
      const rect = label.getBoundingClientRect()
      const control = label.querySelector(".admin-ds-control, input")!
      const style = getComputedStyle(control)
      const labelText = label.querySelector(".product-editor-field-label")!
      return {
        label: labelText.textContent?.trim() ?? "",
        value: control instanceof HTMLInputElement ? control.value : control.textContent?.trim() ?? "",
        left: rect.left,
        right: rect.right,
        top: rect.top,
        width: rect.width,
        controlWidth: control.getBoundingClientRect().width,
        controlHeight: control.getBoundingClientRect().height,
        border: style.borderTopColor,
        labelOverflows: labelText.scrollWidth > labelText.clientWidth + 1,
        valueOverflows: control.scrollWidth > control.clientWidth + 1,
      }
    })
    const rowRect = row.getBoundingClientRect()
    const actions = row.querySelector(".product-editor-price-actions")!.getBoundingClientRect()
    return {
      fields,
      rowLeft: rowRect.left,
      rowRight: rowRect.right,
      rowHeight: rowRect.height,
      actionsTop: actions.top,
      actionsBottom: actions.bottom,
      actionsRight: actions.right,
      pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    }
  })
}

const LAYOUT_BY_WIDTH: Record<number, { columns: 2 | 4; actionsInline: boolean }> = {
  1920: { columns: 4, actionsInline: true },
  1440: { columns: 4, actionsInline: false },
  1366: { columns: 4, actionsInline: false },
  1280: { columns: 2, actionsInline: false },
  1024: { columns: 2, actionsInline: false },
  768: { columns: 4, actionsInline: true },
  390: { columns: 2, actionsInline: false },
}

for (const theme of ["dark", "light"] as const) {
  for (const width of [1920, 1440, 1366, 1280, 1024, 768, 390]) {
    test(`precio y stock: modo % en 4 columnas y modo $ intacto (${theme}, ${width}px)`, async () => {
      const page = await openEditor(width, theme, { ...BASE_FIXTURE, pricingMode: "manual" })
      try {
        const manual = await readPriceRow(page)
        assert.deepEqual(manual.fields.map((field) => field.label), ["Precio actual", "Precio anterior"])
        assert.equal(await page.locator(".product-editor-price-tone-profit").count(), 0, "el modo $ no lleva tonos de ganancia")
        assert.ok(Math.abs(manual.fields[0].top - manual.fields[1].top) < 1, `modo $ reacomodado a ${width}px`)
        assert.ok(Math.abs(manual.fields[0].width - manual.fields[1].width) < 1)
        assert.ok(Math.abs(manual.fields[1].top + manual.fields[1].controlHeight - manual.actionsBottom) < 40)
        assert.equal(manual.fields[0].border, manual.fields[1].border, "modo $ conserva un solo contorno")
        assert.ok(!manual.pageOverflow, `overflow horizontal en modo $ a ${width}px`)

        await page.getByRole("button", { name: "Ganancia por porcentaje" }).click()
        await page.getByText("Ganancia al contado").waitFor()
        await page.mouse.move(0, 0)
        const margin = await readPriceRow(page)
        assert.deepEqual(margin.fields.map((field) => field.label), [
          "Ganancia neta",
          "Ganancia al contado",
          "Precio calculado",
          "Precio anterior",
        ])

        const [neta, contado, calculado, anterior] = margin.fields
        const tops = margin.fields.map((field) => Math.round(field.top))
        const widths = margin.fields.map((field) => field.width)
        // Ancho real de la card (no del viewport): a 1024/1280px el editor reparte
        // ~345/464px por card y "Ganancia al contado" no entra en 4 columnas.
        const layout = LAYOUT_BY_WIDTH[width]
        if (layout.columns === 4) {
          assert.equal(new Set(tops).size, 1, `4 columnas en una fila a ${width}px: ${tops}`)
        } else {
          assert.ok(tops[0] === tops[1] && tops[2] === tops[3] && tops[2] > tops[0], `2 × 2 a ${width}px: ${tops}`)
        }
        assert.ok(Math.max(...widths) - Math.min(...widths) < 1.5, `columnas desbalanceadas a ${width}px: ${widths}`)
        for (const field of margin.fields) {
          assert.ok(field.controlWidth >= field.width - 1, `${field.label} no ocupa su columna a ${width}px`)
          assert.ok(!field.labelOverflows, `${field.label} recortado a ${width}px`)
          assert.ok(!field.valueOverflows, `${field.label}: valor desbordado a ${width}px`)
          assert.ok(field.left >= margin.rowLeft - 1 && field.right <= margin.rowRight + 1, `${field.label} fuera de la card a ${width}px`)
        }
        assert.ok(margin.actionsRight <= margin.rowRight + 1, `acciones fuera de la card a ${width}px`)
        if (layout.actionsInline) {
          assert.ok(margin.actionsTop < neta.top + neta.controlHeight + 20, `acciones $ / % / ojo fuera de la fila a ${width}px`)
          assert.ok(Math.abs(margin.rowHeight - manual.rowHeight) < 1, `la sección cambió de altura a ${width}px: ${manual.rowHeight} -> ${margin.rowHeight}`)
        }
        assert.ok(!margin.pageOverflow, `overflow horizontal en modo % a ${width}px`)

        // Verde = token de éxito del admin del tema activo; azul = contorno de control actual.
        assert.equal(neta.border, contado.border)
        assert.equal(calculado.border, anterior.border)
        assert.notEqual(neta.border, calculado.border)
        assert.equal(calculado.border, manual.fields[1].border, "Precio calculado/anterior conservan el contorno actual")
        const greenChannels = neta.border.match(/[\d.]+/g)!.map(Number)
        assert.ok(greenChannels[1] > greenChannels[0] && greenChannels[1] > greenChannels[2], `contorno no verde: ${neta.border}`)
      } finally { await page.close() }
    })
  }
}

const formatter = new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", minimumFractionDigits: 0, maximumFractionDigits: 2 })

function expectedCashProfit(cost: number, targetMarginPercent: number) {
  const target = calculateTargetMarginPrice({ cost, targetMarginPercent, config: CONFIG, transferDiscountPercent: TRANSFER_DISCOUNT_PERCENT })!
  const simulation = simulateProductProfitability({ price: target.commercialPrice, cost, config: CONFIG, transferDiscountPercent: TRANSFER_DISCOUNT_PERCENT })!
  return { price: target.commercialPrice, profit: getCashSaleProfitAmount(simulation) }
}

async function readMarginValues(page: Page) {
  const row = await readPriceRow(page)
  return Object.fromEntries(row.fields.map((field) => [field.label, field.value]))
}

test("ganancia al contado con costo conocido: misma cuenta que la rentabilidad del producto", async () => {
  const page = await openEditor(1440, "dark", BASE_FIXTURE)
  try {
    const expected = expectedCashProfit(10_000, 40)
    const values = await readMarginValues(page)
    assert.equal(values["Ganancia neta"], "40")
    assert.equal(values["Precio calculado"], formatter.format(expected.price))
    assert.equal(values["Ganancia al contado"], formatter.format(expected.profit))
    assert.equal(values["Precio anterior"], "45000")
    await page.locator("#target_margin_percent").fill("62")
    const updated = expectedCashProfit(10_000, 62)
    await page.waitForFunction((text) => document.body.textContent?.includes(text), formatter.format(updated.profit))
    assert.equal((await readMarginValues(page))["Ganancia al contado"], formatter.format(updated.profit))
  } finally { await page.close() }
})

test("ganancia al contado con variantes de distinto costo usa el mayor costo conocido", async () => {
  const page = await openEditor(1440, "dark", {
    ...BASE_FIXTURE,
    knownUnitCost: 12_000,
    variantCosts: [
      { variantId: 1, variantName: "Negro", unitCost: 9_000 },
      { variantId: 2, variantName: "Blanco", unitCost: 12_000 },
    ],
  })
  try {
    const expected = expectedCashProfit(12_000, 40)
    assert.equal((await readMarginValues(page))["Ganancia al contado"], formatter.format(expected.profit))
    await page.getByText("Las variantes tienen costos distintos").waitFor()
  } finally { await page.close() }
})

test("ganancia al contado sin costo: muestra — sin bloquear el borrador", async () => {
  const unknown = await openEditor(1440, "dark", { ...BASE_FIXTURE, knownUnitCost: null })
  try {
    const values = await readMarginValues(unknown)
    assert.equal(values["Ganancia al contado"], "—")
    await unknown.getByText(/Costo desconocido/).waitFor()
    assert.equal(await unknown.getByRole("button", { name: /Guardar/ }).first().isDisabled(), false)
  } finally { await unknown.close() }

  const missing = await openEditor(1440, "dark", {
    ...BASE_FIXTURE,
    knownUnitCost: 9_000,
    variantCosts: [
      { variantId: 1, variantName: "Negro", unitCost: 9_000 },
      { variantId: 2, variantName: "Blanco", unitCost: null },
    ],
    missingVariantCosts: [{ variantId: 2, variantName: "Blanco", unitCost: null }],
  })
  try {
    assert.equal((await readMarginValues(missing))["Ganancia al contado"], "—")
    await missing.getByText(/variantes vendibles sin costo conocido/).waitFor()
  } finally { await missing.close() }
})
