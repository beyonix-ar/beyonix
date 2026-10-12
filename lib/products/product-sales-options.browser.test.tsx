import assert from "node:assert/strict"
import test from "node:test"
import { build, type Plugin } from "esbuild"
import { chromium, type Browser } from "playwright-core"

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

test.before(async () => {
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
