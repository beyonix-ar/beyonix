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
          const [editorKey, setEditorKey] = useState(0);
          window.descriptionValue = value;
          window.setDescription = setValue;
          window.remountEditor = () => setEditorKey((current) => current + 1);
          return <RichDescriptionEditor key={editorKey} value={value} onChange={setValue} placeholder="Escribí una descripción" />;
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

test("PDP renderiza fuente y color manual sólo desde clases permitidas", () => {
  const html = '<p><span class="rt-color-sky"><span class="rt-font-verdana">Celeste</span></span> <strong>Automático</strong></p>'
  const markup = renderToStaticMarkup(createElement(RichDescription, { blocks: parseRichDescription(html) }))
  assert.match(markup, /class="rt-color-sky"/)
  assert.match(markup, /class="rt-font-verdana"/)
  assert.match(markup, /<strong class="font-bold">Automático<\/strong>/)
  assert.doesNotMatch(markup, /style=|text-white/)
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

async function chooseToolbarOption(page: Page, label: string, option: string) {
  await page.getByRole("button", { name: label, exact: true }).click()
  await page.getByRole("listbox", { name: label }).getByRole("option", { name: option, exact: true }).click()
}

async function placeCursor(page: Page, text: string) {
  await selectText(page, text)
  await page.evaluate(() => window.getSelection()?.collapseToStart())
  await page.waitForTimeout(30)
}

async function pressed(page: Page, label: string) {
  return page.getByRole("button", { name: label, exact: true }).getAttribute("aria-pressed")
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

test("reabrir una descripción conserva la línea vacía entre título y párrafo", async () => {
  const page = await pageWithEditor()
  try {
    const editor = page.getByRole("textbox", { name: "Descripción del producto" })
    await editor.click()
    await page.keyboard.type("TÍTULO")
    await page.keyboard.press("Enter")
    await page.keyboard.press("Enter")
    await page.keyboard.type("Párrafo")
    const saved = await page.evaluate(() => (window as unknown as { descriptionValue: string }).descriptionValue)
    assert.equal(saved, "<p>TÍTULO</p><p><br></p><p>Párrafo</p>")
    await page.evaluate(() => (window as unknown as { remountEditor: () => void }).remountEditor())
    await page.waitForFunction((html) => document.querySelector("[data-rich-editor]")?.innerHTML === html, saved)
    const gap = await page.evaluate(() => {
      const paragraphs = document.querySelectorAll("[data-rich-editor] p")
      return paragraphs[2].getBoundingClientRect().top - paragraphs[0].getBoundingClientRect().bottom
    })
    assert.ok(gap >= 25, `se perdió la separación visual: ${gap}px`)
  } finally { await page.close() }
})

test("selección parcial, toolbar y tamaño mixto", async () => {
  const page = await pageWithEditor("<p>Encendedor eléctrico recargable USB</p>")
  try {
    await selectText(page, "eléctrico")
    await page.getByRole("button", { name: "Negrita" }).click()
    assert.match(await page.evaluate(() => (window as unknown as { descriptionValue: string }).descriptionValue), /Encendedor <strong>eléctrico<\/strong> recargable USB/)
    await selectText(page, "recargable USB")
    await chooseToolbarOption(page, "Tamaño de letra", "24")
    assert.match(await page.evaluate(() => (window as unknown as { descriptionValue: string }).descriptionValue), /<span class="rt-size-24">recargable USB<\/span>/)
    await selectText(page, "eléctrico recargable")
    assert.match(await page.getByRole("button", { name: "Tamaño de letra" }).textContent() ?? "", /—/)
  } finally { await page.close() }
})

test("quitar negrita a un fragmento conserva los vecinos", async () => {
  const page = await pageWithEditor("<p><strong>Uno Dos Tres</strong></p>")
  try {
    await selectText(page, "Dos")
    await page.getByRole("button", { name: "Negrita" }).click()
    const snapshot = await page.evaluate(() => ({
      html: document.querySelector("[data-rich-editor]")?.innerHTML,
      value: (window as unknown as { descriptionValue: string }).descriptionValue,
    }))
    assert.match(snapshot.value, /<strong>Uno <\/strong>Dos<strong> Tres<\/strong>/, JSON.stringify(snapshot))
  } finally { await page.close() }
})

test("quitar negrita dentro de un título se conserva en la tienda", async () => {
  const page = await pageWithEditor("<h2>Uno <strong>Dos</strong> Tres</h2>")
  try {
    await selectText(page, "Dos")
    await page.getByRole("button", { name: "Negrita" }).click()
    const snapshot = await page.evaluate(() => ({
      html: document.querySelector("[data-rich-editor]")?.innerHTML,
      value: (window as unknown as { descriptionValue: string }).descriptionValue,
    }))
    assert.match(snapshot.value, /<span class="rt-weight-normal">Dos<\/span>/, JSON.stringify(snapshot))
    await page.evaluate(() => (window as unknown as { remountEditor: () => void }).remountEditor())
    await page.waitForFunction((html) => document.querySelector("[data-rich-editor]")?.innerHTML === html, snapshot.value)
    await placeCursor(page, "Dos")
    assert.equal(await pressed(page, "Negrita"), "false")
    const markup = renderToStaticMarkup(createElement("div", { className: "product-rich-description" },
      createElement(RichDescription, { blocks: parseRichDescription(snapshot.value) })))
    await page.addStyleTag({ content: css })
    const weights = await page.evaluate((html) => {
      document.body.insertAdjacentHTML("beforeend", html)
      const title = document.querySelector<HTMLElement>(".product-rich-description h3")!
      const normal = title.querySelector<HTMLElement>(".rt-weight-normal")!
      return { title: getComputedStyle(title).fontWeight, normal: getComputedStyle(normal).fontWeight }
    }, markup)
    assert.equal(weights.normal, "400")
    assert.ok(Number(weights.title) >= 600, JSON.stringify(weights))
  } finally { await page.close() }
})

test("cursor sincroniza negrita, subrayado, cursiva, listas, alineación y los cuatro menús", async () => {
  const html = '<p><strong>Negrita</strong> normal <u>Subrayado</u> <em>Cursiva</em></p>' +
    '<ul><li>Lista</li></ul><ol><li>Numerada</li></ol>' +
    '<p class="rt-align-center">Centrado</p><p class="rt-align-right">Derecha</p>' +
    '<h3><span class="rt-size-18"><span class="rt-font-arial"><span class="rt-color-green">Subtítulo</span></span></span></h3>'
  const page = await pageWithEditor(html)
  try {
    await placeCursor(page, "Negrita")
    assert.equal(await pressed(page, "Negrita"), "true")
    await placeCursor(page, "normal")
    assert.equal(await pressed(page, "Negrita"), "false")
    assert.equal(await pressed(page, "Subrayado"), "false")
    assert.equal(await pressed(page, "Cursiva"), "false")
    await placeCursor(page, "Subrayado")
    assert.equal(await pressed(page, "Subrayado"), "true")
    await placeCursor(page, "Cursiva")
    assert.equal(await pressed(page, "Cursiva"), "true")
    await placeCursor(page, "Lista")
    assert.equal(await pressed(page, "Lista con viñetas"), "true")
    await placeCursor(page, "Numerada")
    assert.equal(await pressed(page, "Lista numerada"), "true")
    await placeCursor(page, "Centrado")
    assert.equal(await pressed(page, "Centrar"), "true")
    await placeCursor(page, "Derecha")
    assert.equal(await pressed(page, "Alinear a la derecha"), "true")
    await placeCursor(page, "Subtítulo")
    for (const [label, selected] of [["Tipo de bloque", "Subtítulo"], ["Tamaño de letra", "18"], ["Tipografía", "Arial"], ["Color de texto", "Verde"]]) {
      assert.match(await page.getByRole("button", { name: label }).textContent() ?? "", new RegExp(selected), label)
    }
    await placeCursor(page, "normal")
    assert.match(await page.getByRole("button", { name: "Tipografía" }).textContent() ?? "", /Montserrat/)
    assert.match(await page.getByRole("button", { name: "Color de texto" }).textContent() ?? "", /Automático/)
  } finally { await page.close() }
})

test("A negrita, B normal, C subrayado y D cursiva sobreviven guardado y reapertura", async () => {
  const page = await pageWithEditor("<p><strong>A B</strong> C D</p>")
  try {
    await selectText(page, "B")
    await page.getByRole("button", { name: "Negrita" }).click()
    await selectText(page, "C")
    await page.getByRole("button", { name: "Subrayado" }).click()
    await selectText(page, "D")
    await page.getByRole("button", { name: "Cursiva" }).click()
    const saved = await page.evaluate(() => (window as unknown as { descriptionValue: string }).descriptionValue)
    assert.match(saved, /<strong>A <\/strong>B/)
    assert.match(saved, /<u>C<\/u>/)
    assert.match(saved, /<em>D<\/em>/)
    await page.evaluate(() => (window as unknown as { remountEditor: () => void }).remountEditor())
    await page.waitForFunction((html) => document.querySelector("[data-rich-editor]")?.innerHTML === html, saved)
    const markup = renderToStaticMarkup(createElement("div", { className: "product-rich-description" },
      createElement(RichDescription, { blocks: parseRichDescription(saved) })))
    await page.addStyleTag({ content: css })
    const styles = await page.evaluate((html) => {
      document.body.insertAdjacentHTML("beforeend", html)
      const paragraph = document.querySelector<HTMLElement>(".product-rich-description p")!
      return { bold: getComputedStyle(paragraph.querySelector("strong")!).fontWeight,
        normal: getComputedStyle(paragraph).fontWeight,
        underline: getComputedStyle(paragraph.querySelector("u")!).textDecorationLine,
        italic: getComputedStyle(paragraph.querySelector("em")!).fontStyle }
    }, markup)
    assert.ok(Number(styles.bold) >= 600, JSON.stringify(styles))
    assert.equal(styles.normal, "400")
    assert.match(styles.underline, /underline/)
    assert.equal(styles.italic, "italic")
  } finally { await page.close() }
})

for (const [width, theme] of [[1440, "dark"], [1366, "light"], [390, "dark"]] as const) {
  test(`menús del toolbar BEYONIX en ${width}px (${theme})`, async () => {
    const page = await pageWithEditor("<p>Texto</p>")
    try {
      await page.setViewportSize({ width, height: 900 })
      await page.addStyleTag({ content: css })
      await page.evaluate((mode) => {
        document.documentElement.dataset.adminTheme = mode
        document.body.classList.add("beyonix-admin-shell")
        document.getElementById("root")!.classList.add("beyonix-admin-main", "product-editor-screen")
      }, theme)
      assert.equal(await page.locator('.product-rich-description-editor [role="toolbar"] select').count(), 0)
      for (const label of ["Tipo de bloque", "Tamaño de letra", "Tipografía", "Color de texto"]) {
        await page.getByRole("button", { name: label }).click()
        const menu = page.getByRole("listbox", { name: label })
        const appearance = await menu.evaluate((element) => {
          const style = getComputedStyle(element)
          const selected = element.querySelector('[role="option"][aria-selected="true"]')
          return { background: style.backgroundColor, radius: style.borderRadius,
            width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height,
            right: element.getBoundingClientRect().right, selected: Boolean(selected) }
        })
        assert.notEqual(appearance.background, "rgba(0, 0, 0, 0)")
        assert.ok(Number.parseFloat(appearance.radius) >= 8, JSON.stringify(appearance))
        assert.ok(appearance.width <= 180 && appearance.height <= 304, JSON.stringify(appearance))
        assert.ok(appearance.right <= width, JSON.stringify(appearance))
        assert.equal(appearance.selected, true)
        await page.getByRole("button", { name: label }).click()
      }
    } finally { await page.close() }
  })
}

for (const theme of ["dark", "light"] as const) {
  test(`negrita activa se distingue visualmente de inactiva en ${theme}`, async () => {
    const page = await pageWithEditor("<p><strong>Negrita</strong> normal</p>")
    try {
      await page.addStyleTag({ content: css })
      await page.evaluate((mode) => {
        document.documentElement.dataset.adminTheme = mode
        document.body.classList.add("beyonix-admin-shell")
        document.getElementById("root")!.classList.add("beyonix-admin-main", "product-editor-screen")
      }, theme)
      await placeCursor(page, "Negrita")
      const active = await page.getByRole("button", { name: "Negrita" }).evaluate((button) => getComputedStyle(button).backgroundColor)
      await placeCursor(page, "normal")
      const inactive = await page.getByRole("button", { name: "Negrita" }).evaluate((button) => getComputedStyle(button).backgroundColor)
      assert.notEqual(active, inactive)
    } finally { await page.close() }
  })
}

test("bloque actual, lista, alineación, deshacer y limpiar formato", async () => {
  const page = await pageWithEditor("<p>Uno</p>")
  try {
    await selectText(page, "Uno")
    await chooseToolbarOption(page, "Tipo de bloque", "Título")
    assert.equal(await page.evaluate(() => (window as unknown as { descriptionValue: string }).descriptionValue), "<h2>Uno</h2>")
    await page.getByRole("button", { name: "Centrar" }).click()
    assert.equal(await page.evaluate(() => (window as unknown as { descriptionValue: string }).descriptionValue), '<h2 class="rt-align-center">Uno</h2>')
    await page.getByRole("button", { name: "Deshacer" }).click()
    assert.equal(await page.evaluate(() => (window as unknown as { descriptionValue: string }).descriptionValue), "<h2>Uno</h2>")
    await page.getByRole("button", { name: "Rehacer" }).click()
    assert.equal(await page.evaluate(() => (window as unknown as { descriptionValue: string }).descriptionValue), '<h2 class="rt-align-center">Uno</h2>')
    await page.getByRole("button", { name: "Deshacer" }).click()
    await chooseToolbarOption(page, "Tipo de bloque", "Párrafo")
    await page.getByRole("button", { name: "Lista con viñetas" }).click()
    const afterList = await page.evaluate(() => ({ value: (window as unknown as { descriptionValue: string }).descriptionValue, dom: document.querySelector("[data-rich-editor]")?.innerHTML, selection: window.getSelection()?.toString() }))
    assert.match(afterList.value, /<ul><li>Uno<\/li><\/ul>/, JSON.stringify(afterList))
  } finally { await page.close() }
})

test("cursiva, subrayado, tamaño por select y limpiar formato", async () => {
  const page = await pageWithEditor("<p>Texto para editar</p>")
  try {
    await selectText(page, "para")
    await page.getByRole("button", { name: "Cursiva" }).click()
    await selectText(page, "editar")
    await page.getByRole("button", { name: "Subrayado" }).click()
    await selectText(page, "para")
    assert.equal(await page.getByRole("button", { name: "Agrandar texto" }).count(), 0)
    assert.equal(await page.getByRole("button", { name: "Achicar texto" }).count(), 0)
    await chooseToolbarOption(page, "Tamaño de letra", "18")
    assert.match(await page.getByRole("button", { name: "Tamaño de letra" }).textContent() ?? "", /18/)
    await chooseToolbarOption(page, "Tamaño de letra", "16")
    assert.match(await page.getByRole("button", { name: "Tamaño de letra" }).textContent() ?? "", /16/)
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
    assert.equal(await page.evaluate(() => (window as unknown as { descriptionValue: string }).descriptionValue), '<p><span class="rt-font-arial"><strong>Seguro</strong></span></p>')
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
    await chooseToolbarOption(page, "Tamaño de letra", "24")
    assert.match(await page.getByRole("button", { name: "Tamaño de letra" }).textContent() ?? "", /24/)
    await page.getByRole("button", { name: "Negrita" }).click()
    assert.equal(await page.getByRole("button", { name: "Negrita" }).getAttribute("aria-pressed"), "true")
    await page.keyboard.type("nuevo")
    const value = await page.evaluate(() => (window as unknown as { descriptionValue: string }).descriptionValue)
    assert.match(value, /<span class="rt-size-24">.*nuevo/)
    assert.match(value, /<strong>nuevo<\/strong>/)
  } finally { await page.close() }
})

test("selector de tipografía y color aplica sólo las opciones elegidas y permite volver a automático", async () => {
  const page = await pageWithEditor("<p>Texto editable</p>")
  try {
    await page.addStyleTag({ content: css })
    await page.evaluate(() => {
      document.body.classList.add("beyonix-admin-shell")
      document.getElementById("root")!.classList.add("beyonix-admin-main")
    })
    await page.getByRole("button", { name: "Tipografía" }).click()
    assert.deepEqual(await page.getByRole("listbox", { name: "Tipografía" }).getByRole("option").allTextContents(), ["—", "Montserrat", "Arial", "Calibri", "Verdana", "Comic Sans MS"])
    await page.getByRole("button", { name: "Tipografía" }).click()
    await page.getByRole("button", { name: "Color de texto" }).click()
    assert.deepEqual(await page.getByRole("listbox", { name: "Color de texto" }).getByRole("option").allTextContents(), ["—", "Automático", "Negro", "Blanco", "Gris", "Azul BEYONIX", "Celeste", "Verde", "Rojo", "Ámbar"])
    await page.getByRole("button", { name: "Color de texto" }).click()
    for (const [label, expected] of [["Arial", "rt-font-arial"], ["Calibri", "rt-font-calibri"], ["Verdana", "rt-font-verdana"], ["Comic Sans MS", "rt-font-comic-sans"]] as const) {
      await selectText(page, "Texto editable")
      await chooseToolbarOption(page, "Tipografía", label)
      assert.match(await page.evaluate(() => (window as unknown as { descriptionValue: string }).descriptionValue), new RegExp(expected), label)
    }
    for (const [id, label] of [["black", "Negro"], ["white", "Blanco"], ["gray", "Gris"], ["beyonix-blue", "Azul BEYONIX"], ["sky", "Celeste"], ["green", "Verde"], ["red", "Rojo"], ["amber", "Ámbar"]] as const) {
      await selectText(page, "Texto editable")
      await chooseToolbarOption(page, "Color de texto", label)
      const snapshot = await page.evaluate(() => ({ value: (window as unknown as { descriptionValue: string }).descriptionValue, dom: document.querySelector("[data-rich-editor]")?.innerHTML }))
      assert.match(snapshot.value, new RegExp(`rt-color-${id}`), `${id}: ${JSON.stringify(snapshot)}`)
    }
    await selectText(page, "Texto editable")
    await chooseToolbarOption(page, "Color de texto", "Automático")
    assert.doesNotMatch(await page.evaluate(() => (window as unknown as { descriptionValue: string }).descriptionValue), /rt-color-/)
    await selectText(page, "Texto editable")
    await chooseToolbarOption(page, "Tipografía", "Montserrat")
    assert.doesNotMatch(await page.evaluate(() => (window as unknown as { descriptionValue: string }).descriptionValue), /rt-font-/)
  } finally { await page.close() }
})

test("sin color manual, editor Light/Dark y descripción PDP heredan colores legibles", async () => {
  const page = await pageWithEditor("<p><strong>Sin color fijo</strong></p>")
  try {
    await page.addStyleTag({ content: css })
    await page.evaluate(() => {
      document.body.classList.add("beyonix-admin-shell")
      document.getElementById("root")!.classList.add("beyonix-admin-main")
    })
    const markup = renderToStaticMarkup(createElement("div", { className: "beyonix-modal-body product-rich-description" },
      createElement(RichDescription, { blocks: parseRichDescription("<p><strong>Sin color fijo</strong></p>") })))
    await page.evaluate((html) => { document.body.insertAdjacentHTML("beforeend", html) }, markup)
    for (const mode of ["light", "dark"] as const) {
      const colors = await page.evaluate((theme) => {
        document.documentElement.dataset.adminTheme = theme
        document.documentElement.dataset.accountTheme = theme
        document.documentElement.dataset.accountScope = ""
        const editor = document.querySelector<HTMLElement>("[data-rich-editor]")!
        const product = document.querySelector<HTMLElement>(".product-rich-description strong")!
        return { editor: getComputedStyle(editor).color, product: getComputedStyle(product).color }
      }, mode)
      assert.equal(colors.editor, mode === "light" ? "rgb(15, 23, 42)" : "rgb(248, 250, 252)", JSON.stringify(colors))
      if (mode === "light") assert.equal(colors.product, "rgb(38, 43, 51)", JSON.stringify(colors))
      else assert.ok(colors.product === "oklch(0.98 0 0)" || colors.product === "rgba(255, 255, 255, 0.8)", JSON.stringify(colors))
    }
    assert.doesNotMatch(await page.evaluate(() => (window as unknown as { descriptionValue: string }).descriptionValue), /rt-color-|#[0-9a-f]{6}/i)
  } finally { await page.close() }
})

test("Negro manual en Light se guarda explícito y Automático vuelve a heredar", async () => {
  const page = await pageWithEditor("<p>Texto negro</p>")
  try {
    await page.addStyleTag({ content: css })
    await page.evaluate(() => {
      document.documentElement.dataset.adminTheme = "light"
      document.body.classList.add("beyonix-admin-shell")
      document.getElementById("root")!.classList.add("beyonix-admin-main")
    })
    await selectText(page, "Texto negro")
    await chooseToolbarOption(page, "Color de texto", "Negro")
    assert.match(await page.evaluate(() => (window as unknown as { descriptionValue: string }).descriptionValue), /rt-color-black/)
    await selectText(page, "Texto negro")
    await chooseToolbarOption(page, "Color de texto", "Automático")
    assert.equal(await page.evaluate(() => (window as unknown as { descriptionValue: string }).descriptionValue), "<p>Texto negro</p>")
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
