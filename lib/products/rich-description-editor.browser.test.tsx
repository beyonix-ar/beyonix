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
    '<h3><span class="rt-color-green"><span class="rt-font-arial"><span class="rt-size-18">Subtítulo</span></span></span></h3>'
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
    for (const [label, selected] of [["Tamaño de letra", "18"], ["Tipografía", "Arial"], ["Color de texto", "Verde"]]) {
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
      for (const label of ["Tamaño de letra", "Tipografía", "Color de texto"]) {
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

test("título legacy se conserva; alineación, deshacer/rehacer, limpiar y lista", async () => {
  const page = await pageWithEditor("<h2>Uno</h2>")
  try {
    assert.equal(await page.getByRole("button", { name: "Tipo de bloque" }).count(), 0)
    await selectText(page, "Uno")
    await page.getByRole("button", { name: "Centrar" }).click()
    assert.equal(await page.evaluate(() => (window as unknown as { descriptionValue: string }).descriptionValue), '<h2 class="rt-align-center">Uno</h2>')
    await page.getByRole("button", { name: "Deshacer" }).click()
    assert.equal(await page.evaluate(() => (window as unknown as { descriptionValue: string }).descriptionValue), "<h2>Uno</h2>")
    await page.getByRole("button", { name: "Rehacer" }).click()
    assert.equal(await page.evaluate(() => (window as unknown as { descriptionValue: string }).descriptionValue), '<h2 class="rt-align-center">Uno</h2>')
    await page.getByRole("button", { name: "Deshacer" }).click()
    await selectText(page, "Uno")
    await page.getByRole("button", { name: "Limpiar formato" }).click()
    assert.equal(await page.evaluate(() => (window as unknown as { descriptionValue: string }).descriptionValue), "<p>Uno</p>")
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
    assert.equal(await page.evaluate(() => (window as unknown as { descriptionValue: string }).descriptionValue), "<p>Seguro</p>")
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

const descriptionValue = (page: Page) => page.evaluate(() => (window as unknown as { descriptionValue: string }).descriptionValue)
const editorHtml = (page: Page) => page.evaluate(() => document.querySelector("[data-rich-editor]")!.innerHTML)

async function paste(page: Page, html: string, plain = "") {
  await page.evaluate(([htmlData, plainData]) => {
    const target = document.querySelector("[data-rich-editor]")!
    const data = new DataTransfer()
    if (htmlData) data.setData("text/html", htmlData)
    data.setData("text/plain", plainData)
    target.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }))
  }, [html, plain] as const)
}

/** DOM no canónico (estilos anidados contradictorios) como el que dejaban ediciones previas. */
async function injectEditorHtml(page: Page, html: string) {
  await page.evaluate((markup) => { document.querySelector("[data-rich-editor]")!.innerHTML = markup }, html)
}

async function remount(page: Page, saved: string) {
  await page.evaluate(() => (window as unknown as { remountEditor: () => void }).remountEditor())
  await page.waitForFunction((html) => document.querySelector("[data-rich-editor]")?.innerHTML === html, saved)
}

async function storeStyles(page: Page, saved: string, needles: string[]) {
  const markup = renderToStaticMarkup(createElement("div", { className: "product-rich-description" },
    createElement(RichDescription, { blocks: parseRichDescription(saved) })))
  return page.evaluate(([html, texts]) => {
    // next/font define esta variable en producción.
    document.documentElement.style.setProperty("--font-montserrat", "Montserrat")
    document.querySelector("#store-preview")?.remove()
    document.body.insertAdjacentHTML("beforeend", `<div id="store-preview">${html}</div>`)
    const root = document.getElementById("store-preview")!
    return texts.map((text) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      while (walker.nextNode()) {
        if (walker.currentNode.textContent?.includes(text)) {
          const style = getComputedStyle(walker.currentNode.parentElement!)
          return { text, font: style.fontFamily, size: style.fontSize, weight: style.fontWeight, decoration: style.textDecorationLine }
        }
      }
      throw new Error("Texto no encontrado en tienda: " + text)
    })
  }, [markup, needles] as const)
}

test("selector Párrafo/Título/Subtítulo eliminado; toolbar en orden Tamaño, Fuente, Color, B, U, I", async () => {
  const page = await pageWithEditor("<p>Texto</p>")
  try {
    assert.equal(await page.getByRole("button", { name: "Tipo de bloque" }).count(), 0)
    const labels = await page.locator('[role="toolbar"] button').evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label") ?? button.getAttribute("title")))
    assert.deepEqual(labels.slice(0, 6), ["Tamaño de letra", "Tipografía", "Color de texto", "Negrita", "Subrayado", "Cursiva"])
    assert.deepEqual(labels.slice(-3), ["Deshacer", "Rehacer", "Limpiar formato"])
  } finally { await page.close() }
})

test("pegado limpio: Times New Roman, tamaño, color, fondo y clases externas no entran; texto, párrafos y listas sí", async () => {
  const page = await pageWithEditor()
  try {
    await page.getByRole("textbox", { name: "Descripción del producto" }).click()
    await paste(page,
      '<html><head><style>p{font-family:"Times New Roman"}</style></head><body><!--StartFragment-->' +
      '<p class="externa" style="font-family:\'Times New Roman\';font-size:18px;color:red;background:yellow">' +
      '<span style="font-family:Arial;font-size:24px;color:#ef4444;font-weight:700">Encendedor</span> <font face="Verdana" color="#34d399">eléctrico</font>\n   USB</p>' +
      '<p>Segunda<br>línea <b>¡ñandú!</b> <i>ü</i> <u>sí</u></p><ul><li>Uno</li><li>Dos</li></ul><!--EndFragment--></body></html>',
      "texto plano ignorado")
    assert.equal(await descriptionValue(page), "<p>Encendedor eléctrico USB</p><p>Segunda</p><p>línea ¡ñandú! ü sí</p><p>• Uno</p><p>• Dos</p>")
    const dom = await editorHtml(page)
    assert.doesNotMatch(dom, /style=|class=|<font|<b>|<strong|<span|<em|<u>/, dom)
  } finally { await page.close() }
})

test("pegado de texto plano conserva saltos razonables y toma el formato del cursor", async () => {
  const page = await pageWithEditor('<p><span class="rt-font-verdana"><span class="rt-size-20">Inicio</span></span></p>')
  try {
    await page.getByRole("textbox", { name: "Descripción del producto" }).focus()
    await page.evaluate(() => {
      const text = document.querySelector("[data-rich-editor] span span")!.firstChild!
      const range = document.createRange()
      range.setStart(text, 6)
      range.collapse(true)
      window.getSelection()!.removeAllRanges()
      window.getSelection()!.addRange(range)
    })
    await paste(page, "", " pegado\r\nWhatsApp\n\n\n\nfin")
    const value = await descriptionValue(page)
    assert.equal(value, '<p><span class="rt-font-verdana"><span class="rt-size-20">Inicio pegado</span></span></p>' +
      '<p><span class="rt-font-verdana"><span class="rt-size-20">WhatsApp</span></span></p><p><br></p>' +
      '<p><span class="rt-font-verdana"><span class="rt-size-20">fin</span></span></p>', value)
  } finally { await page.close() }
})

test("fuente: todo el rango mixto pasa a la elegida y reemplaza spans anidados contradictorios", async () => {
  const page = await pageWithEditor("<p>x</p>")
  try {
    await injectEditorHtml(page, '<p><span class="rt-font-verdana">Uno <span style="font-family: Calibri">Dos</span></span> <font face="Comic Sans MS">Tres</font> Cuatro</p>')
    await selectText(page, "Uno Dos Tres")
    assert.match(await page.getByRole("button", { name: "Tipografía" }).textContent() ?? "", /—/)
    await chooseToolbarOption(page, "Tipografía", "Montserrat")
    assert.equal(await descriptionValue(page), "<p>Uno Dos Tres Cuatro</p>")
    await selectText(page, "Dos Tres")
    await chooseToolbarOption(page, "Tipografía", "Arial")
    assert.equal(await descriptionValue(page), '<p>Uno <span class="rt-font-arial">Dos Tres</span> Cuatro</p>')
    await selectText(page, "Uno Dos")
    await chooseToolbarOption(page, "Tipografía", "Verdana")
    assert.equal(await descriptionValue(page), '<p><span class="rt-font-verdana">Uno Dos</span><span class="rt-font-arial"> Tres</span> Cuatro</p>')
    await selectText(page, "Uno Dos Tres Cuatro")
    await chooseToolbarOption(page, "Tipografía", "Calibri")
    assert.equal(await descriptionValue(page), '<p><span class="rt-font-calibri">Uno Dos Tres Cuatro</span></p>')
    assert.equal(await editorHtml(page), '<p><span class="rt-font-calibri">Uno Dos Tres Cuatro</span></p>')
    assert.match(await page.getByRole("button", { name: "Tipografía" }).textContent() ?? "", /Calibri/)
  } finally { await page.close() }
})

test("tamaño: reemplaza el tamaño previo en todo el rango y persiste al reabrir", async () => {
  const page = await pageWithEditor("<p>x</p>")
  try {
    await injectEditorHtml(page, '<p><span class="rt-size-24">Uno <span style="font-size: 12px">Dos</span></span> Tres</p>')
    await selectText(page, "Uno Dos Tres")
    assert.match(await page.getByRole("button", { name: "Tamaño de letra" }).textContent() ?? "", /—/)
    await chooseToolbarOption(page, "Tamaño de letra", "18")
    assert.equal(await descriptionValue(page), '<p><span class="rt-size-18">Uno Dos Tres</span></p>')
    await selectText(page, "Dos")
    await chooseToolbarOption(page, "Tamaño de letra", "32")
    const saved = await descriptionValue(page)
    assert.equal(saved, '<p><span class="rt-size-18">Uno </span><span class="rt-size-32">Dos</span><span class="rt-size-18"> Tres</span></p>')
    await remount(page, saved)
    await placeCursor(page, "Dos")
    assert.match(await page.getByRole("button", { name: "Tamaño de letra" }).textContent() ?? "", /32/)
    await page.addStyleTag({ content: css })
    const sizes = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("[data-rich-editor] span")].map((span) => getComputedStyle(span).fontSize))
    assert.deepEqual(sizes, ["18px", "32px", "18px"])
  } finally { await page.close() }
})

test("A Montserrat 18 negrita, B Arial 16, C Verdana 20 subrayado: idéntico en admin, reapertura y tienda", async () => {
  const page = await pageWithEditor("<p>Texto A</p><p>Texto B</p><p>Texto C</p>")
  try {
    await page.addStyleTag({ content: css })
    await selectText(page, "Texto A")
    await chooseToolbarOption(page, "Tipografía", "Montserrat")
    await chooseToolbarOption(page, "Tamaño de letra", "18")
    await page.getByRole("button", { name: "Negrita" }).click()
    await selectText(page, "Texto B")
    await chooseToolbarOption(page, "Tipografía", "Arial")
    await chooseToolbarOption(page, "Tamaño de letra", "16")
    await selectText(page, "Texto C")
    await chooseToolbarOption(page, "Tipografía", "Verdana")
    await chooseToolbarOption(page, "Tamaño de letra", "20")
    await page.getByRole("button", { name: "Subrayado" }).click()
    const saved = await descriptionValue(page)
    assert.equal(saved, '<p><span class="rt-size-18"><strong>Texto A</strong></span></p>' +
      '<p><span class="rt-font-arial"><span class="rt-size-16">Texto B</span></span></p>' +
      '<p><span class="rt-font-verdana"><span class="rt-size-20"><u>Texto C</u></span></span></p>')
    await remount(page, saved)
    for (const [text, font, size, bold, underline] of [["Texto A", "Montserrat", "18", "true", "false"], ["Texto B", "Arial", "16", "false", "false"], ["Texto C", "Verdana", "20", "false", "true"]] as const) {
      await placeCursor(page, text.slice(-1))
      assert.match(await page.getByRole("button", { name: "Tipografía" }).textContent() ?? "", new RegExp(font), text)
      assert.match(await page.getByRole("button", { name: "Tamaño de letra" }).textContent() ?? "", new RegExp(size), text)
      assert.equal(await pressed(page, "Negrita"), bold, text)
      assert.equal(await pressed(page, "Subrayado"), underline, text)
    }
    const store = await storeStyles(page, saved, ["Texto A", "Texto B", "Texto C"])
    assert.match(store[0].font, /Montserrat/, JSON.stringify(store))
    assert.equal(store[0].size, "18px")
    assert.ok(Number(store[0].weight) >= 600, JSON.stringify(store[0]))
    assert.match(store[1].font, /^Arial/)
    assert.equal(store[1].size, "16px")
    assert.equal(store[1].weight, "400")
    assert.match(store[2].font, /^Verdana/)
    assert.equal(store[2].size, "20px")
    assert.match(store[2].decoration, /underline/)
  } finally { await page.close() }
})

test("caso crítico: pegar externo, Montserrat 18, negrita on/off, guardar, reabrir y tienda", async () => {
  const page = await pageWithEditor()
  try {
    await page.addStyleTag({ content: css })
    await page.getByRole("textbox", { name: "Descripción del producto" }).click()
    await paste(page, '<div style="font-family:Times New Roman;font-size:18px;color:red"><p><b>Batería de litio recargable</b></p><p style="font-family:Arial">Incluye cable USB</p></div>')
    assert.equal(await descriptionValue(page), "<p>Batería de litio recargable</p><p>Incluye cable USB</p>")
    await selectText(page, "litio recargable")
    await chooseToolbarOption(page, "Tipografía", "Montserrat")
    await chooseToolbarOption(page, "Tamaño de letra", "18")
    await page.getByRole("button", { name: "Negrita" }).click()
    assert.equal(await pressed(page, "Negrita"), "true")
    await selectText(page, "Incluye cable USB")
    await page.getByRole("button", { name: "Negrita" }).click()
    await selectText(page, "cable")
    await page.getByRole("button", { name: "Negrita" }).click()
    assert.equal(await pressed(page, "Negrita"), "false")
    await selectText(page, "recargable")
    await page.getByRole("button", { name: "Negrita" }).click()
    const saved = await descriptionValue(page)
    assert.equal(saved, '<p>Batería de <span class="rt-size-18"><strong>litio </strong>recargable</span></p>' +
      "<p><strong>Incluye </strong>cable<strong> USB</strong></p>")
    await remount(page, saved)
    await placeCursor(page, "litio")
    assert.equal(await pressed(page, "Negrita"), "true")
    assert.match(await page.getByRole("button", { name: "Tamaño de letra" }).textContent() ?? "", /18/)
    assert.match(await page.getByRole("button", { name: "Tipografía" }).textContent() ?? "", /Montserrat/)
    const store = await storeStyles(page, saved, ["Batería", "litio", "recargable", "Incluye", "cable"])
    for (const item of store) assert.match(item.font, /Montserrat/, JSON.stringify(item))
    assert.notEqual(store[0].size, "18px")
    assert.equal(store[1].size, "18px")
    assert.ok(Number(store[1].weight) >= 600, JSON.stringify(store[1]))
    assert.equal(store[2].weight, "400")
    assert.ok(Number(store[3].weight) >= 600, JSON.stringify(store[3]))
    assert.equal(store[4].weight, "400")
  } finally { await page.close() }
})

test("cursiva y subrayado on/off; Enter y párrafos vacíos siguen funcionando", async () => {
  const page = await pageWithEditor("<p>Uno Dos</p>")
  try {
    await selectText(page, "Dos")
    await page.getByRole("button", { name: "Cursiva" }).click()
    await page.getByRole("button", { name: "Subrayado" }).click()
    assert.equal(await descriptionValue(page), "<p>Uno <em><u>Dos</u></em></p>")
    assert.equal(await pressed(page, "Cursiva"), "true")
    assert.equal(await pressed(page, "Subrayado"), "true")
    await page.getByRole("button", { name: "Cursiva" }).click()
    assert.equal(await descriptionValue(page), "<p>Uno <u>Dos</u></p>")
    await page.getByRole("button", { name: "Subrayado" }).click()
    assert.equal(await descriptionValue(page), "<p>Uno Dos</p>")
    await page.keyboard.press("End")
    await page.keyboard.press("Enter")
    await page.keyboard.press("Enter")
    await page.keyboard.type("Tres")
    assert.equal(await descriptionValue(page), "<p>Uno Dos</p><p><br></p><p>Tres</p>")
  } finally { await page.close() }
})

const hasCaretMark = (page: Page) => page.evaluate(() => document.querySelector("[data-rich-editor]")!.innerHTML.includes("​"))

test("formato sin selección: la marca invisible desaparece al escribir y nunca pide pulsaciones extra", async () => {
  const page = await pageWithEditor("<p>Inicio</p>")
  try {
    await page.getByRole("textbox", { name: "Descripción del producto" }).click()
    await page.keyboard.press("End")
    await page.getByRole("button", { name: "Negrita" }).click()
    await chooseToolbarOption(page, "Tamaño de letra", "20")
    assert.equal(await pressed(page, "Negrita"), "true")
    await page.keyboard.type("XY")
    assert.equal(await hasCaretMark(page), false)
    assert.equal(await descriptionValue(page), '<p>Inicio<span class="rt-size-20"><strong>XY</strong></span></p>')
    await page.keyboard.press("ArrowLeft")
    await page.keyboard.type("-")
    assert.equal(await descriptionValue(page), '<p>Inicio<span class="rt-size-20"><strong>X-Y</strong></span></p>')
    await page.keyboard.press("End")
    await page.keyboard.press("Backspace")
    assert.equal(await descriptionValue(page), '<p>Inicio<span class="rt-size-20"><strong>X-</strong></span></p>')
    await page.getByRole("button", { name: "Deshacer" }).click()
    assert.equal(await descriptionValue(page), '<p>Inicio<span class="rt-size-20"><strong>X-Y</strong></span></p>')
    await page.getByRole("button", { name: "Rehacer" }).click()
    assert.equal(await descriptionValue(page), '<p>Inicio<span class="rt-size-20"><strong>X-</strong></span></p>')
  } finally { await page.close() }
})

test("formato pendiente descartado: Backspace, flechas y clic actúan sobre el texto real", async () => {
  const page = await pageWithEditor("<p>Inicio</p>")
  try {
    await page.getByRole("textbox", { name: "Descripción del producto" }).click()
    await page.keyboard.press("End")
    await page.getByRole("button", { name: "Cursiva" }).click()
    assert.equal(await pressed(page, "Cursiva"), "true")
    await page.keyboard.press("Backspace")
    assert.equal(await hasCaretMark(page), false)
    assert.equal(await descriptionValue(page), "<p>Inici</p>")
    await page.getByRole("button", { name: "Subrayado" }).click()
    await page.keyboard.press("ArrowLeft")
    assert.equal(await hasCaretMark(page), false)
    assert.equal(await pressed(page, "Subrayado"), "false")
    await page.keyboard.type("Z")
    assert.equal(await descriptionValue(page), "<p>InicZi</p>")
    await page.keyboard.press("End")
    await page.getByRole("button", { name: "Negrita" }).click()
    await page.evaluate(() => {
      const range = document.createRange()
      range.setStart(document.querySelector("[data-rich-editor] p")!.firstChild!, 1)
      window.getSelection()!.removeAllRanges()
      window.getSelection()!.addRange(range)
    })
    await page.waitForFunction(() => !document.querySelector("[data-rich-editor]")!.innerHTML.includes("​"))
    assert.equal(await editorHtml(page), "<p>InicZi</p>")
  } finally { await page.close() }
})
