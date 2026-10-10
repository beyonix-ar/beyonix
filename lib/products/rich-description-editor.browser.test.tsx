import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { build } from "esbuild"
import { chromium, type Browser, type Page } from "playwright-core"
import postcss from "postcss"
import tailwindcss from "@tailwindcss/postcss"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { RichDescription } from "@/components/products/rich-description"
import { parseRichDescription } from "./rich-description"

let browser: Browser
let bundle: string
let css: string

test.before(async () => {
  css = (await postcss([tailwindcss({ base: process.cwd() })])
    .process(readFileSync("app/globals.css", "utf8"), { from: "app/globals.css" })).css
  const output = await build({
    stdin: {
      contents: `
        import React, { useState } from "react";
        import { createRoot } from "react-dom/client";
        import { RichDescriptionEditor } from "./app/admin/sections/productos/rich-description-editor.tsx";
        function App() {
          const [value, setValue] = useState("");
          window.descriptionValue = value;
          window.setDescription = setValue;
          return <RichDescriptionEditor value={value} onChange={setValue} placeholder="Escribí una descripción" />;
        }
        createRoot(document.getElementById("root")).render(<App />);
      `,
      resolveDir: process.cwd(),
      sourcefile: "rich-editor-browser-entry.tsx",
      loader: "tsx",
    },
    bundle: true, platform: "browser", format: "iife", write: false,
    alias: { "@": process.cwd() }, jsx: "automatic",
  })
  bundle = output.outputFiles[0].text
  browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chrome", headless: true })
})

test.after(async () => { await browser?.close() })

test("PDP renderiza títulos, tamaños, alineación y listas como elementos seguros", () => {
  const html = '<h2 class="rt-align-center"><span class="rt-size-32">Título</span></h2><p>Texto <strong>fuerte</strong></p><ul><li>Uno</li><li><em>Dos</em></li></ul>'
  const markup = renderToStaticMarkup(createElement(RichDescription, { blocks: parseRichDescription(html) }))
  assert.match(markup, /<h3[^>]*text-center[^>]*><span[^>]*text-\[32px\][^>]*>Título<\/span><\/h3>/)
  assert.match(markup, /<ul[^>]*list-disc[^>]*><li>Uno<\/li><li><em>Dos<\/em><\/li><\/ul>/)
  assert.doesNotMatch(markup, /<script|onclick|style=/)
})

async function pageWithEditor(value = "") {
  const page = await browser.newPage()
  await page.setContent('<div id="root"></div>')
  await page.addScriptTag({ content: bundle })
  await page.getByRole("textbox", { name: "Descripción del producto" }).waitFor()
  if (value) {
    await page.evaluate((html) => (window as unknown as { setDescription: (value: string) => void }).setDescription(html), value)
    await page.waitForFunction((html) => document.querySelector("[data-rich-editor]")?.innerHTML === html, value)
  }
  return page
}

async function selectText(page: Page, text: string) {
  await page.evaluate((needle) => {
    const editor = document.querySelector("[data-rich-editor]")!
    const start = editor.textContent?.indexOf(needle) ?? -1
    if (start < 0) throw new Error("Texto no encontrado: " + needle)
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
    let offset = 0
    let startNode: Node | null = null
    let startOffset = 0
    let endNode: Node | null = null
    let endOffset = 0
    while (walker.nextNode()) {
      const node = walker.currentNode
      const length = node.textContent?.length ?? 0
      if (!startNode && start >= offset && start < offset + length) {
        startNode = node; startOffset = start - offset
      }
      if (!endNode && start + needle.length > offset && start + needle.length <= offset + length) {
        endNode = node; endOffset = start + needle.length - offset
      }
      offset += length
    }
    if (!startNode || !endNode) throw new Error("Rango no encontrado: " + needle)
    const range = document.createRange()
    range.setStart(startNode, startOffset)
    range.setEnd(endNode, endOffset)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
  }, text)
}

test("Enter crea párrafo, Shift+Enter crea salto en el mismo párrafo", async () => {
  const page = await pageWithEditor()
  try {
    const editor = page.getByRole("textbox", { name: "Descripción del producto" })
    await editor.click()
    await page.keyboard.type("Uno")
    await page.keyboard.press("Enter")
    await page.keyboard.type("Dos")
    await page.keyboard.press("Shift+Enter")
    await page.keyboard.type("Tres")
    assert.equal(await page.evaluate(() => (window as unknown as { descriptionValue: string }).descriptionValue), "<p>Uno</p><p>Dos<br>Tres</p>")
  } finally { await page.close() }
})

test("selección parcial, toolbar y tamaño mixto", async () => {
  const page = await pageWithEditor("<p>Encendedor eléctrico recargable USB</p>")
  try {
    await selectText(page, "eléctrico")
    await page.getByRole("button", { name: "Negrita" }).click()
    assert.match(await page.evaluate(() => (window as unknown as { descriptionValue: string }).descriptionValue), /Encendedor <strong>eléctrico<\/strong> recargable USB/)
    await selectText(page, "recargable USB")
    await page.getByRole("combobox", { name: "Tamaño de letra" }).selectOption("24")
    assert.match(await page.evaluate(() => (window as unknown as { descriptionValue: string }).descriptionValue), /<span class="rt-size-24">recargable USB<\/span>/)
    await selectText(page, "eléctrico recargable")
    assert.equal(await page.getByRole("combobox", { name: "Tamaño de letra" }).inputValue(), "mixed")
  } finally { await page.close() }
})

test("bloque actual, lista, alineación, deshacer y limpiar formato", async () => {
  const page = await pageWithEditor("<p>Uno</p>")
  try {
    await selectText(page, "Uno")
    await page.getByRole("combobox", { name: "Tipo de bloque" }).selectOption("h2")
    assert.equal(await page.evaluate(() => (window as unknown as { descriptionValue: string }).descriptionValue), "<h2>Uno</h2>")
    await page.getByRole("button", { name: "Centrar" }).click()
    assert.equal(await page.evaluate(() => (window as unknown as { descriptionValue: string }).descriptionValue), '<h2 class="rt-align-center">Uno</h2>')
    await page.getByRole("button", { name: "Deshacer" }).click()
    assert.equal(await page.evaluate(() => (window as unknown as { descriptionValue: string }).descriptionValue), "<h2>Uno</h2>")
    await page.getByRole("button", { name: "Rehacer" }).click()
    assert.equal(await page.evaluate(() => (window as unknown as { descriptionValue: string }).descriptionValue), '<h2 class="rt-align-center">Uno</h2>')
    await page.getByRole("button", { name: "Deshacer" }).click()
    await page.getByRole("combobox", { name: "Tipo de bloque" }).selectOption("p")
    await page.getByRole("button", { name: "Lista con viñetas" }).click()
    const afterList = await page.evaluate(() => ({ value: (window as unknown as { descriptionValue: string }).descriptionValue, dom: document.querySelector("[data-rich-editor]")?.innerHTML, selection: window.getSelection()?.toString() }))
    assert.match(afterList.value, /<ul><li>Uno<\/li><\/ul>/, JSON.stringify(afterList))
  } finally { await page.close() }
})

test("cursiva, subrayado, A+/A− y limpiar formato", async () => {
  const page = await pageWithEditor("<p>Texto para editar</p>")
  try {
    await selectText(page, "para")
    await page.getByRole("button", { name: "Cursiva" }).click()
    await selectText(page, "editar")
    await page.getByRole("button", { name: "Subrayado" }).click()
    await selectText(page, "para")
    await page.getByRole("button", { name: "Agrandar texto" }).click()
    assert.equal(await page.getByRole("combobox", { name: "Tamaño de letra" }).inputValue(), "18")
    await page.getByRole("button", { name: "Achicar texto" }).click()
    assert.equal(await page.getByRole("combobox", { name: "Tamaño de letra" }).inputValue(), "16")
    await selectText(page, "Texto para editar")
    await page.getByRole("button", { name: "Limpiar formato" }).click()
    assert.equal(await page.evaluate(() => (window as unknown as { descriptionValue: string }).descriptionValue), "<p>Texto para editar</p>")
  } finally { await page.close() }
})

test("Enter después del título pasa a párrafo y lista permite crear/salir de ítems", async () => {
  const page = await pageWithEditor("<h2>Título</h2>")
  try {
    const editor = page.getByRole("textbox", { name: "Descripción del producto" })
    await editor.click()
    await page.keyboard.press("End")
    await page.keyboard.press("Enter")
    await page.keyboard.type("Párrafo")
    assert.equal(await page.evaluate(() => (window as unknown as { descriptionValue: string }).descriptionValue), "<h2>Título</h2><p>Párrafo</p>")
    await page.getByRole("button", { name: "Lista numerada" }).click()
    await page.keyboard.press("End")
    await page.keyboard.press("Enter")
    await page.keyboard.type("Segundo")
    const value = await page.evaluate(() => (window as unknown as { descriptionValue: string }).descriptionValue)
    assert.match(value, /<ol><li>Párrafo<\/li><li>Segundo<\/li><\/ol>/)
    await page.keyboard.press("Enter")
    await page.keyboard.press("Enter")
    await page.keyboard.type("Fuera")
    assert.match(await page.evaluate(() => (window as unknown as { descriptionValue: string }).descriptionValue), /<ol><li>Párrafo<\/li><li>Segundo<\/li><\/ol><p>Fuera<\/p>/)
  } finally { await page.close() }
})

test("pegado hostil se sanea y vacío no guarda placeholder", async () => {
  const page = await pageWithEditor()
  try {
    const editor = page.getByRole("textbox", { name: "Descripción del producto" })
    assert.equal(await page.evaluate(() => (window as unknown as { descriptionValue: string }).descriptionValue), "")
    await editor.click()
    await page.evaluate(() => {
      const target = document.querySelector("[data-rich-editor]")!
      const data = new DataTransfer()
      data.setData("text/html", '<p style="color:red" onclick="evil()"><font face="Arial"><strong>Seguro</strong></font><img src=x onerror=evil()><script>evil()</script></p>')
      target.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }))
    })
    assert.equal(await page.evaluate(() => (window as unknown as { descriptionValue: string }).descriptionValue), "<p><strong>Seguro</strong></p>")
    await page.keyboard.press("ControlOrMeta+A")
    await page.keyboard.press("Backspace")
    assert.equal(await page.evaluate(() => (window as unknown as { descriptionValue: string }).descriptionValue), "")
  } finally { await page.close() }
})

test("atajos B/I/U y undo/redo actúan sólo con foco en el editor", async () => {
  const page = await pageWithEditor("<p>Atajos</p>")
  try {
    await selectText(page, "Atajos")
    await page.keyboard.press("ControlOrMeta+B")
    assert.equal(await page.evaluate(() => (window as unknown as { descriptionValue: string }).descriptionValue), "<p><strong>Atajos</strong></p>")
    await page.keyboard.press("ControlOrMeta+Z")
    assert.equal(await page.evaluate(() => (window as unknown as { descriptionValue: string }).descriptionValue), "<p>Atajos</p>")
    await page.keyboard.press("ControlOrMeta+Y")
    assert.equal(await page.evaluate(() => (window as unknown as { descriptionValue: string }).descriptionValue), "<p><strong>Atajos</strong></p>")
    await selectText(page, "Atajos")
    await page.keyboard.press("ControlOrMeta+I")
    assert.match(await page.evaluate(() => (window as unknown as { descriptionValue: string }).descriptionValue), /<em>Atajos<\/em>/)
    await selectText(page, "Atajos")
    await page.keyboard.press("ControlOrMeta+U")
    assert.match(await page.evaluate(() => (window as unknown as { descriptionValue: string }).descriptionValue), /<u>Atajos<\/u>/)
  } finally { await page.close() }
})

test("scroll del editor conserva la selección para el toolbar", async () => {
  const page = await pageWithEditor("<p>Encendedor eléctrico</p>" + "<p>Texto largo de descripción.</p>".repeat(30))
  try {
    await selectText(page, "eléctrico")
    await page.evaluate(() => { document.querySelector("[data-rich-editor]")!.scrollTop = 400 })
    await page.getByRole("button", { name: "Negrita" }).click()
    assert.match(await page.evaluate(() => (window as unknown as { descriptionValue: string }).descriptionValue), /Encendedor <strong>eléctrico<\/strong>/)
  } finally { await page.close() }
})

test("tamaño y negrita con cursor vacío quedan activos para texto nuevo", async () => {
  const page = await pageWithEditor("<p>Inicio </p>")
  try {
    const editor = page.getByRole("textbox", { name: "Descripción del producto" })
    await editor.click()
    await page.keyboard.press("End")
    await page.getByRole("combobox", { name: "Tamaño de letra" }).selectOption("24")
    assert.equal(await page.getByRole("combobox", { name: "Tamaño de letra" }).inputValue(), "24")
    await page.getByRole("button", { name: "Negrita" }).click()
    assert.equal(await page.getByRole("button", { name: "Negrita" }).getAttribute("aria-pressed"), "true")
    await page.keyboard.type("nuevo")
    const value = await page.evaluate(() => (window as unknown as { descriptionValue: string }).descriptionValue)
    assert.match(value, /<span class="rt-size-24">.*nuevo/)
    assert.match(value, /<strong>nuevo<\/strong>/)
  } finally { await page.close() }
})

for (const [width, height] of [[1366, 768], [1440, 900], [1920, 1080]] as const) {
  for (const theme of ["light", "dark"] as const) {
    test(`toolbar y descripción larga en ${width}×${height} (${theme})`, async () => {
      const page = await pageWithEditor("<h2>Título</h2>" + "<p>Texto largo de descripción con información útil para el cliente.</p>".repeat(20))
      try {
        await page.setViewportSize({ width, height })
        await page.addStyleTag({ content: css })
        await page.evaluate((mode) => {
          document.documentElement.dataset.adminTheme = mode
          const root = document.getElementById("root")!
          root.style.width = "min(640px, calc(100vw - 32px))"
          root.style.margin = "16px"
          document.body.style.background = mode === "dark" ? "#07111b" : "#ffffff"
        }, theme)
        const sizes = await page.evaluate(() => {
          const toolbar = document.querySelector('[role="toolbar"]')!
          const editor = document.querySelector("[data-rich-editor]")!
          return { toolbarHeight: toolbar.getBoundingClientRect().height, editorWidth: editor.getBoundingClientRect().width,
            overflow: document.documentElement.scrollWidth - window.innerWidth, editorHeight: editor.getBoundingClientRect().height,
            maxHeight: Number.parseFloat(getComputedStyle(editor).maxHeight) }
        })
        assert.ok(sizes.toolbarHeight <= 140, JSON.stringify(sizes))
        assert.ok(sizes.editorWidth >= 400, JSON.stringify(sizes))
        assert.ok(sizes.overflow <= 0, JSON.stringify(sizes))
        assert.ok(sizes.editorHeight <= sizes.maxHeight + 1, JSON.stringify(sizes))
      } finally { await page.close() }
    })
  }
}
