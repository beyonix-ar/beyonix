import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { build, type Plugin } from "esbuild"
import { chromium, type Browser, type Page } from "playwright-core"
import postcss from "postcss"
import tailwindcss from "@tailwindcss/postcss"

import {
  calculateTargetMarginPrice,
  getSinglePaymentProfitAmount,
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
        borderSides: [style.borderTopColor, style.borderRightColor, style.borderBottomColor, style.borderLeftColor],
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

// Ancho real de la card (no del viewport): el editor reparte dos cards por
// fila desde 1024px, así que a 1024 la card mide ~345px y las cuatro no
// entran sin recortar "Ganancia al contado"; ahí (y en mobile) va 2 × 2.
const LAYOUT_BY_WIDTH: Record<number, { singleRow: boolean; actionsInline: boolean }> = {
  1920: { singleRow: true, actionsInline: true },
  1440: { singleRow: true, actionsInline: false },
  1366: { singleRow: true, actionsInline: false },
  1280: { singleRow: true, actionsInline: false },
  1024: { singleRow: false, actionsInline: false },
  768: { singleRow: true, actionsInline: true },
  390: { singleRow: false, actionsInline: false },
}

// Mismo tono que el botón % activo (.product-editor-pricing-mode-active).
const PROFIT_GREEN = "rgba(110, 231, 183, 0.75)"

for (const theme of ["dark", "light"] as const) {
  for (const width of Object.keys(LAYOUT_BY_WIDTH).map(Number)) {
    test(`precio y stock: modo % en una fila y modo $ intacto (${theme}, ${width}px)`, async () => {
      const page = await openEditor(width, theme, { ...BASE_FIXTURE, pricingMode: "manual" })
      try {
        const manual = await readPriceRow(page)
        assert.deepEqual(manual.fields.map((field) => field.label), ["Precio actual", "Precio anterior"])
        assert.equal(await page.locator(".product-editor-price-tone-profit").count(), 0, "el modo $ no lleva tonos de ganancia")
        assert.ok(Math.abs(manual.fields[0].top - manual.fields[1].top) < 1, `modo $ reacomodado a ${width}px`)
        assert.ok(Math.abs(manual.fields[0].width - manual.fields[1].width) < 1)
        assert.equal(manual.fields[0].border, manual.fields[1].border, "modo $ conserva un solo contorno")
        assert.notEqual(manual.fields[0].border, PROFIT_GREEN)
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
        const layout = LAYOUT_BY_WIDTH[width]
        if (layout.singleRow) {
          assert.equal(new Set(tops).size, 1, `4 columnas en una fila a ${width}px: ${tops}`)
          assert.ok(neta.width < contado.width * 0.8, `Ganancia neta no es más angosta a ${width}px: ${neta.width} vs ${contado.width}`)
          const wide = [contado.width, calculado.width, anterior.width]
          assert.ok(Math.max(...wide) - Math.min(...wide) < 1, `las 3 columnas de $ no son iguales a ${width}px: ${wide}`)
          assert.ok(neta.left < contado.left && contado.left < calculado.left && calculado.left < anterior.left)
        } else {
          assert.ok(tops[0] === tops[1] && tops[2] === tops[3] && tops[2] > tops[0], `2 × 2 a ${width}px: ${tops}`)
        }
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

        // Verde: borde completo de las dos de ganancia; azul: el contorno actual de control.
        for (const field of [neta, contado]) {
          assert.deepEqual(field.borderSides, [PROFIT_GREEN, PROFIT_GREEN, PROFIT_GREEN, PROFIT_GREEN], `${field.label} sin borde verde completo`)
        }
        for (const field of [calculado, anterior]) {
          assert.equal(field.border, manual.fields[1].border, `${field.label} perdió el contorno azul actual`)
        }

        await page.getByRole("button", { name: "Precio manual" }).click()
        await page.mouse.move(0, 0)
        // El valor de "Precio actual" cambia a propósito (el modo % sincroniza
        // el precio calculado); la geometría y los contornos no.
        const withoutValues = (row: typeof manual) => ({ ...row, fields: row.fields.map((field) => ({ ...field, value: "" })) })
        const manualAgain = await readPriceRow(page)
        assert.deepEqual(withoutValues(manualAgain), withoutValues(manual), `volver a $ no restaura el layout a ${width}px`)
      } finally { await page.close() }
    })
  }
}

const formatter = new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", minimumFractionDigits: 0, maximumFractionDigits: 2 })

function expectedSinglePaymentProfit(cost: number, targetMarginPercent: number) {
  const target = calculateTargetMarginPrice({ cost, targetMarginPercent, config: CONFIG, transferDiscountPercent: TRANSFER_DISCOUNT_PERCENT })!
  const simulation = simulateProductProfitability({ price: target.commercialPrice, cost, config: CONFIG, transferDiscountPercent: TRANSFER_DISCOUNT_PERCENT })!
  return { price: target.commercialPrice, profit: getSinglePaymentProfitAmount(simulation)! }
}

async function readMarginValues(page: Page) {
  const row = await readPriceRow(page)
  return Object.fromEntries(row.fields.map((field) => [field.label, field.value]))
}

async function readPopoverProfits(page: Page) {
  const trigger = page.getByRole("button", { name: "Ver rentabilidad estimada" })
  await trigger.focus()
  await trigger.press("Enter")
  const dialog = page.getByRole("dialog", { name: "Rentabilidad estimada" })
  await dialog.waitFor({ state: "visible", timeout: 3000 })
  const rows = await dialog.locator(":scope > div > div").evaluateAll((nodes) =>
    nodes.map((node) => ({
      label: node.querySelector("span")?.firstChild?.textContent?.trim() ?? "",
      profit: /Ganancia: (.+?) ·/.exec(node.textContent ?? "")?.[1]?.trim() ?? "",
    })),
  )
  await page.keyboard.press("Escape")
  return Object.fromEntries(rows.map((row) => [row.label, row.profit]))
}

test("ganancia al contado = ganancia de Mercado Pago — 1 pago en Rentabilidad estimada, y sigue al margen", async () => {
  const page = await openEditor(1440, "dark", BASE_FIXTURE)
  try {
    const expected = expectedSinglePaymentProfit(10_000, 40)
    const values = await readMarginValues(page)
    assert.equal(values["Ganancia neta"], "40")
    assert.equal(values["Precio calculado"], formatter.format(expected.price))
    assert.equal(values["Ganancia al contado"], formatter.format(expected.profit))
    assert.equal(values["Precio anterior"], "45000")

    const popover = await readPopoverProfits(page)
    assert.equal(values["Ganancia al contado"], popover["Mercado Pago — 1 pago"])
    // Transferencia no interviene: su ganancia es otra (el cliente paga con descuento).
    assert.ok(popover["Transferencia"], "falta la fila de transferencia en el popover")
    assert.notEqual(values["Ganancia al contado"], popover["Transferencia"])

    await page.locator("#target_margin_percent").fill("62")
    const updated = expectedSinglePaymentProfit(10_000, 62)
    await page.waitForFunction((text) => document.body.textContent?.includes(text), formatter.format(updated.profit))
    const updatedValues = await readMarginValues(page)
    assert.notEqual(updatedValues["Ganancia al contado"], values["Ganancia al contado"])
    assert.equal(updatedValues["Ganancia al contado"], formatter.format(updated.profit))
    assert.equal(updatedValues["Ganancia al contado"], (await readPopoverProfits(page))["Mercado Pago — 1 pago"])
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
    const expected = expectedSinglePaymentProfit(12_000, 40)
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
