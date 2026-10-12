import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { build, type Plugin } from "esbuild"
import { chromium, type Browser } from "playwright-core"
import postcss from "postcss"
import tailwindcss from "@tailwindcss/postcss"

const queries: Plugin = {
  name: "sales-option-queries",
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /lib\/supabase\/queries\/producto-variantes$/ }, () => ({ path: "queries", namespace: "stub" }))
    pluginBuild.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      contents: `export const listBarcodeAliases = async () => [];
        export const setProductoColorMode = async (_id, colorMode) => ({ colorMode });
        export const addBarcodeAlias = async (_id, barcode, variantId) => ({ barcode, variantId, variantName: variantId == null ? null : "Rojo" });
        export const removeBarcodeAlias = async () => {};`,
      loader: "js",
    }))
  },
}

let browser: Browser
let bundle: string
let css: string

test.before(async () => {
  css = (await postcss([tailwindcss({ base: process.cwd() })]).process(readFileSync("app/globals.css", "utf8"), { from: "app/globals.css" })).css
  const output = await build({
    stdin: {
      contents: `import React, { useState } from "react";
        import { createRoot } from "react-dom/client";
        import { ProductSalesOptions } from "./app/admin/sections/productos/product-sales-options.tsx";
        function App() {
          const [colorMode, setColorMode] = useState("especifico");
          window.currentColorMode = colorMode;
          const variants = Array.from({ length: window.variantCount }, (_, index) => ({ id: index + 1, nombre: index ? "Azul" : "Rojo", codigoBarra: null }));
          return <ProductSalesOptions productId={1} variants={variants} productBarcode="PRINCIPAL" colorMode={colorMode} onColorModeChange={setColorMode} />;
        }
        createRoot(document.getElementById("root")).render(<App />);`,
      resolveDir: process.cwd(), loader: "tsx", sourcefile: "sales-options-fixture.tsx",
    },
    bundle: true, platform: "browser", format: "iife", write: false,
    alias: { "@": process.cwd() }, jsx: "automatic", plugins: [queries],
  })
  bundle = output.outputFiles[0].text
  browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chrome", headless: true })
})

test.after(async () => { await browser?.close() })

for (const variantCount of [1, 2]) {
  test(`venta por color y códigos vinculados con ${variantCount} variante(s)`, async () => {
    const page = await browser.newPage()
    try {
      await page.setContent(`<div id="root"></div><script>window.variantCount=${variantCount}</script><script>${bundle}</script>`)
      assert.equal(await page.locator('[data-color-mode-option]').count(), 3)
      assert.equal(await page.locator('[data-barcode-principal]').getByText("PRINCIPAL").count(), 1)
      const nextMode = variantCount === 1 ? "aleatorio_simple" : "aleatorio_variantes"
      await page.locator(`[data-color-mode-option="${nextMode}"] input`).check()
      await page.waitForFunction((mode) => (window as unknown as { currentColorMode: string }).currentColorMode === mode, nextMode)
      assert.equal(await page.locator(`[data-color-mode-option="${nextMode}"] input`).isChecked(), true)
      await page.getByRole("textbox", { name: "Nuevo código de barra vinculado" }).fill("ALIAS-001")
      if (variantCount === 2) {
        await page.getByRole("button", { name: "Vincular a" }).click()
        await page.getByRole("option", { name: "Variante: Rojo" }).click()
      }
      await page.getByRole("button", { name: "Vincular", exact: true }).click()
      assert.equal(await page.locator('[data-barcode-linked]').getByText("ALIAS-001").count(), 1)
      assert.equal(await page.locator('[data-barcode-linked]').getByText(variantCount === 1 ? "Producto completo" : "Variante: Rojo").count(), 1)
      await page.getByRole("button", { name: "Quitar código vinculado ALIAS-001" }).click()
      assert.equal(await page.locator('[data-barcode-linked]').count(), 0)
    } finally { await page.close() }
  })
}

for (const width of [1920, 1440, 1366, 1280, 1024, 768, 390]) {
  test(`venta por color distribuye tarjetas independientes a ${width}px`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 900 } })
    try {
      await page.setContent(`<!doctype html><html data-admin-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div class="beyonix-admin-shell min-h-screen text-white lg:flex"><div class="hidden lg:block"><aside class="beyonix-admin-sidebar"></aside></div><main class="beyonix-admin-main min-w-0 flex-1"><div class="product-editor-screen"><div class="product-editor-workspace grid min-w-0 gap-3"><div class="product-editor-column min-w-0"><div class="product-editor-cell product-editor-variants-cell"><div id="root"></div></div></div><div class="product-editor-column min-w-0"></div></div></div></main></div><script>window.variantCount=2</script><script>${bundle}</script></body></html>`)
      await page.locator("[data-color-mode-options]").waitFor()
      const layout = await page.locator("[data-color-mode-options]").evaluate((grid) => {
        const rect = grid.getBoundingClientRect()
        const cards = Array.from(grid.querySelectorAll("[data-color-mode-option]"), (card) => {
          const cardRect = card.getBoundingClientRect()
          return {
            left: cardRect.left,
            right: cardRect.right,
            top: cardRect.top,
            width: cardRect.width,
            background: getComputedStyle(card).backgroundColor,
            selected: card.classList.contains("admin-toggle-on"),
          }
        })
        return { gridWidth: rect.width, columns: getComputedStyle(grid).gridTemplateColumns.split(" ").length, cards }
      })
      assert.equal(layout.cards.length, 3)
      assert.equal(layout.columns, width >= 1280 || width === 768 ? 3 : 2, `columnas de venta por color a ${width}px`)
      assert.ok(layout.cards[1].left - layout.cards[0].right >= 4, `sin gap entre tarjetas a ${width}px`)
      assert.ok(layout.cards.every((card) => Math.abs(card.width - layout.cards[0].width) < 1), `tarjetas de ancho distinto a ${width}px`)
      if (layout.columns === 3) {
        assert.ok(layout.cards.every((card) => Math.abs(card.top - layout.cards[0].top) < 1), `tarjetas fuera de una fila a ${width}px`)
        assert.ok(layout.cards[0].width < layout.gridWidth * 0.4, `tarjeta seleccionada ocupa toda la fila a ${width}px`)
      }
      assert.deepEqual(layout.cards.map((card) => card.selected), [true, false, false])
      assert.ok(layout.cards[0].background !== layout.cards[1].background && layout.cards[1].background === layout.cards[2].background, `selección verde invade otras tarjetas a ${width}px`)
      await page.locator('[data-color-mode-option="aleatorio_variantes"] input').check()
      await page.waitForFunction(() => (window as unknown as { currentColorMode: string }).currentColorMode === "aleatorio_variantes")
      assert.equal(await page.locator("[data-color-mode-option].admin-toggle-on").count(), 1)
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `overflow a ${width}px`)
    } finally { await page.close() }
  })
}
