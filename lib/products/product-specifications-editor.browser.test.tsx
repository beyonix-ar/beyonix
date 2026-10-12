import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { build, type Plugin } from "esbuild"
import { chromium, type Browser } from "playwright-core"
import postcss from "postcss"
import tailwindcss from "@tailwindcss/postcss"

const queryStub: Plugin = {
  name: "specification-queries",
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /lib\/supabase\/queries\/producto-especificaciones$/ }, () => ({ path: "queries", namespace: "stub" }))
    pluginBuild.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      contents: `export const getProductoEspecificaciones = async () => [];
        export const createProductoEspecificacion = async () => ({});
        export const updateProductoEspecificacion = async () => ({});
        export const deleteProductoEspecificacion = async () => {};
        export const updateProductoEspecificacionesOrden = async () => [];`,
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
        import { ProductSpecificationsEditor } from "./app/admin/sections/productos/product-specifications-editor.tsx";
        function App() {
          const [drafts, setDrafts] = useState([]);
          window.currentSpecifications = drafts;
          return <ProductSpecificationsEditor draftSpecifications={drafts} onDraftSpecificationsChange={setDrafts} />;
        }
        createRoot(document.getElementById("root")).render(<App />);`,
      resolveDir: process.cwd(), loader: "tsx", sourcefile: "specifications-fixture.tsx",
    },
    bundle: true, platform: "browser", format: "iife", write: false,
    alias: { "@": process.cwd() }, jsx: "automatic", plugins: [queryStub],
  })
  bundle = output.outputFiles[0].text
  browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chrome", headless: true })
})

test.after(async () => { await browser?.close() })

test("especificaciones: texto libre, +100 íconos, edición, borrado y scroll desde la quinta", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  try {
    await page.route("http://localhost/**", (route) => route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html data-admin-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div class="beyonix-admin-shell"><main class="beyonix-admin-main"><div class="product-editor-screen"><div class="product-editor-cell" style="width:520px"><div id="root"></div></div></div></main></div><script>${bundle}</script></body></html>`,
    }))
    await page.goto("http://localhost/spec-fixture")
    const input = page.getByRole("textbox", { name: "Característica" })
    assert.equal(await input.getAttribute("type"), "text")
    const controlHeights = await page.locator('.product-editor-spec-form-grid input[type="text"], .product-editor-spec-form-grid .admin-icon-picker-trigger, .product-editor-spec-add-button').evaluateAll((controls) => controls.map((control) => control.getBoundingClientRect().height))
    assert.deepEqual(controlHeights.map(Math.round), [36, 36, 36])
    assert.equal(await page.getByText("Activa", { exact: true }).count(), 0)
    assert.equal(await page.getByText("Arrastrá para reordenar.").count(), 0)
    await page.getByRole("button", { name: "Abrir buscador de iconos" }).click()
    assert.ok(await page.locator('[aria-label^="Elegir ícono "]').count() >= 100)
    await page.getByRole("button", { name: "Elegir ícono Notebook" }).click()
    for (let index = 1; index <= 5; index++) {
      await input.fill(`Característica ${index}`)
      await page.getByRole("button", { name: "Agregar especificación" }).click()
      assert.equal(await page.locator(".product-editor-spec-row").count(), index, await page.locator(".product-editor-specifications").innerText())
      if (index < 5) {
        await page.getByRole("button", { name: "Abrir buscador de iconos" }).click()
        await page.getByRole("button", { name: "Elegir ícono Notebook" }).click()
      }
    }
    assert.equal(await page.locator(".product-editor-spec-row").count(), 5)
    const list = page.locator("[data-specification-list]")
    const dimensions = await list.evaluate((element) => ({ client: element.clientHeight, scroll: element.scrollHeight }))
    assert.ok(dimensions.scroll > dimensions.client, JSON.stringify(dimensions))
    assert.ok(dimensions.client <= 264, JSON.stringify(dimensions))
    await page.getByRole("button", { name: "Editar especificación" }).first().click()
    assert.equal(await input.inputValue(), "Característica 1")
    await input.fill("Característica editada")
    await page.getByRole("button", { name: "Guardar especificación" }).click()
    assert.equal(await page.getByText("Característica editada").count(), 1)
    await page.getByRole("button", { name: "Eliminar especificación" }).last().click()
    assert.equal(await page.locator(".product-editor-spec-row").count(), 4)
    const afterDelete = await list.evaluate((element) => ({ client: element.clientHeight, scroll: element.scrollHeight }))
    assert.ok(afterDelete.scroll <= afterDelete.client + 1, JSON.stringify(afterDelete))
    await page.locator(".product-editor-spec-row").first().dragTo(page.locator(".product-editor-spec-row").nth(2))
    assert.match(await page.locator(".product-editor-spec-row").first().innerText(), /Característica 2/)
    await page.setViewportSize({ width: 390, height: 900 })
    await page.locator(".product-editor-cell").evaluate((cell: HTMLElement) => { cell.style.width = "100%" })
    const mobileHeights = await page.locator('.product-editor-spec-form-grid input[type="text"], .product-editor-spec-form-grid .admin-icon-picker-trigger, .product-editor-spec-add-button').evaluateAll((controls) => controls.map((control) => control.getBoundingClientRect().height))
    assert.deepEqual(mobileHeights.map(Math.round), [36, 36, 36])
  } finally { await page.close() }
})
