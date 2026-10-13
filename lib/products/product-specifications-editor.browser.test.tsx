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
    pluginBuild.onResolve({ filter: /lib\/supabase\/queries\/spec-icon-aliases$/ }, () => ({ path: "icon-aliases", namespace: "stub" }))
    pluginBuild.onLoad({ filter: /^queries$/, namespace: "stub" }, () => ({
      contents: `export const getProductoEspecificaciones = async () => [];
        export const createProductoEspecificacion = async () => ({});
        export const updateProductoEspecificacion = async () => ({});
        export const deleteProductoEspecificacion = async () => {};
        export const updateProductoEspecificacionesOrden = async () => [];`,
      loader: "js",
    }))
    pluginBuild.onLoad({ filter: /icon-aliases/, namespace: "stub" }, () => ({
      contents: `export const loadSpecIconAliases = async () => window.specIconAliases || {};
        export const saveSpecIconAlias = async (id, label) => { window.specIconAliases = { ...(window.specIconAliases || {}), [id]: label }; };
        export const resetSpecIconAlias = async (id) => { const next = { ...(window.specIconAliases || {}) }; delete next[id]; window.specIconAliases = next; };`,
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

test("especificaciones: texto libre, catálogo de íconos único, edición, borrado y scroll desde la quinta", async () => {
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
    const entries = await page.locator('[aria-label^="Elegir ícono "]').evaluateAll((buttons) => buttons.map((button) => ({
      label: button.getAttribute("aria-label"), icon: button.getAttribute("data-icon-name"),
    })))
    assert.ok(entries.length >= 100, `catálogo de ${entries.length} entradas`)
    assert.equal(new Set(entries.map((entry) => entry.icon)).size, entries.length, "iconName repetido en el selector")
    assert.equal(new Set(entries.map((entry) => entry.label?.toLocaleLowerCase("es-AR"))).size, entries.length, "nombre repetido en el selector")
    await page.getByRole("button", { name: "Elegir ícono Notebook", exact: true }).click()
    for (let index = 1; index <= 5; index++) {
      await input.fill(`Característica ${index}`)
      await page.getByRole("button", { name: "Agregar especificación" }).click()
      assert.equal(await page.locator(".product-editor-spec-row").count(), index, await page.locator(".product-editor-specifications").innerText())
      if (index < 5) {
        await page.getByRole("button", { name: "Abrir buscador de iconos" }).click()
        await page.getByRole("button", { name: "Elegir ícono Notebook", exact: true }).click()
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

type AliasWindow = {
  specIconAliases?: Record<string, string>
  currentSpecifications: Array<{ icono: string; texto: string; orden: number; activo: boolean }>
}

test("alias: renombrar reemplaza el nombre en Admin, persiste por iconName y nunca toca la característica", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  try {
    await page.route("http://localhost/**", (route) => route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html data-admin-theme="dark"><head><meta charset="utf-8"><style>${css}</style></head><body><div class="product-editor-screen"><div id="root"></div></div><script>${bundle}</script></body></html>`,
    }))
    await page.goto("http://localhost/spec-alias-fixture")
    const trigger = page.getByRole("button", { name: "Abrir buscador de iconos" })
    const characteristic = page.getByRole("textbox", { name: "Característica" })
    const specifications = () => page.evaluate(() => (window as unknown as AliasWindow).currentSpecifications)
    const aliases = () => page.evaluate(() => (window as unknown as AliasWindow).specIconAliases ?? {})

    // Especificación existente con el nombre base del ícono.
    await trigger.click()
    await page.getByRole("button", { name: "Elegir ícono Seguridad", exact: true }).click()
    await characteristic.fill("Soporte metálico firme y duradero")
    await page.getByRole("button", { name: "Agregar especificación" }).click()
    const before = await specifications()
    assert.deepEqual(before.map(({ icono, texto }) => ({ icono, texto })), [{ icono: "ShieldCheck", texto: "Soporte metálico firme y duradero" }])

    // Renombrar: el nombre nuevo reemplaza al viejo en todo el Admin, al instante.
    await trigger.click()
    await page.getByRole("button", { name: "Editar nombre de Seguridad", exact: true }).click()
    await page.getByRole("textbox", { name: "Nombre visible" }).fill("Protección premium")
    await page.getByRole("button", { name: "Guardar", exact: true }).click()
    await page.getByRole("button", { name: "Elegir ícono Protección premium", exact: true }).waitFor()
    assert.equal(await page.getByRole("button", { name: "Elegir ícono Seguridad", exact: true }).count(), 0)
    assert.equal(await page.locator('[aria-label^="Elegir ícono "]').filter({ hasText: /Seguridad/ }).count(), 0)
    assert.deepEqual(await aliases(), { ShieldCheck: "Protección premium" })
    assert.deepEqual(await specifications(), before, "renombrar no cambia iconName, texto, orden ni estado")
    const row = page.locator(".product-editor-spec-row").first()
    assert.match((await row.textContent() ?? ""), /Protección premium/)
    assert.match((await row.textContent() ?? ""), /Soporte metálico firme y duradero/)
    assert.doesNotMatch((await row.textContent() ?? ""), /Seguridad/)

    // Cerrar y reabrir conserva el nombre nuevo.
    await page.getByRole("button", { name: "Cerrar buscador de iconos" }).click()
    await trigger.click()
    await page.getByRole("button", { name: "Elegir ícono Protección premium", exact: true }).waitFor()

    // Búsqueda por alias, nombre base e iconName; siempre se ve el alias.
    const search = page.getByRole("searchbox", { name: "Buscar ícono" })
    for (const query of ["premium", "seguridad", "shieldcheck"]) {
      await search.fill(query)
      assert.equal(await page.getByRole("button", { name: "Elegir ícono Protección premium", exact: true }).count(), 1, query)
    }

    // Nueva especificación: el label del selector no se copia a la característica.
    await page.getByRole("button", { name: "Elegir ícono Protección premium", exact: true }).click()
    assert.equal(await page.locator("[data-icon-picker-label]").innerText(), "Protección premium")
    assert.equal(await characteristic.inputValue(), "")
    await characteristic.fill("Fijación por abrazadera, sin perforaciones")
    await page.getByRole("button", { name: "Agregar especificación" }).click()
    assert.deepEqual((await specifications()).map(({ icono, texto }) => ({ icono, texto })), [
      { icono: "ShieldCheck", texto: "Soporte metálico firme y duradero" },
      { icono: "ShieldCheck", texto: "Fijación por abrazadera, sin perforaciones" },
    ])

    // Nombres únicos: no se puede usar el nombre de otro ícono (normalizado).
    await trigger.click()
    await page.getByRole("searchbox", { name: "Buscar ícono" }).fill("")
    await page.getByRole("button", { name: "Editar nombre de Protección", exact: true }).click()
    await page.getByRole("textbox", { name: "Nombre visible" }).fill("  PROTECCION   premium ")
    await page.getByRole("button", { name: "Guardar", exact: true }).click()
    assert.match(await page.getByRole("alert").innerText(), /Ya existe un ícono llamado "Protección premium"/)
    assert.deepEqual(await aliases(), { ShieldCheck: "Protección premium" })
    await page.getByRole("button", { name: "Cancelar", exact: true }).click()
    await page.getByRole("button", { name: "Cerrar buscador de iconos" }).click()

    // Recargar: el alias vuelve desde la persistencia (clave por iconName).
    const persisted = await aliases()
    await page.addInitScript((saved) => { (window as unknown as AliasWindow).specIconAliases = saved }, persisted)
    await page.reload()
    await trigger.click()
    await page.getByRole("button", { name: "Elegir ícono Protección premium", exact: true }).waitFor()
    assert.equal(await page.getByRole("button", { name: "Elegir ícono Seguridad", exact: true }).count(), 0)
    await page.getByRole("button", { name: "Elegir ícono Protección premium", exact: true }).click()
    assert.equal(await page.locator("[data-icon-picker-label]").innerText(), "Protección premium")
    await characteristic.fill("Texto propio")
    await page.getByRole("button", { name: "Agregar especificación" }).click()

    // Restablecer: vuelve al nombre base sólo en el selector; la característica no cambia.
    await trigger.click()
    await page.getByRole("button", { name: "Editar nombre de Protección premium", exact: true }).click()
    await page.getByRole("button", { name: "Restablecer nombre" }).click()
    await page.getByRole("button", { name: "Elegir ícono Seguridad", exact: true }).waitFor()
    assert.equal(await page.getByRole("button", { name: "Elegir ícono Protección premium", exact: true }).count(), 0)
    assert.deepEqual(await aliases(), {})
    assert.deepEqual((await specifications()).map(({ icono, texto }) => ({ icono, texto })), [{ icono: "ShieldCheck", texto: "Texto propio" }])
    assert.match((await page.locator(".product-editor-spec-row").first().textContent()) ?? "", /Seguridad[\s\S]*Texto propio/)
  } finally { await page.close() }
})
