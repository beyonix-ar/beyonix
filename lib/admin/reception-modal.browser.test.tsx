import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { build } from "esbuild"
import { chromium, type Browser, type Page } from "playwright-core"

// Modal "Confirmar movimiento" (recepción de inventario) con el COMPONENTE
// REACT REAL, empaquetado y montado en Edge/Chrome con el globals.css del
// proyecto. El árbol React se monta DENTRO de un .admin-order-detail-scope
// (igual que en el detalle de pedido) que además trae una regla hostil que
// pinta todo de oscuro. El modal debe salir por Portal a document.body y
// ninguna regla del detalle puede alcanzarlo.

const globalsCss = readFileSync("app/globals.css", "utf8").replace(/@theme inline\s*\{/g, ":root {")
const claimsSource = readFileSync("components/claims/admin-claim-manager.tsx", "utf8").replace(/\r\n/g, "\n")
const modalSource = readFileSync("components/claims/reception-confirmation-modal.tsx", "utf8").replace(/\r\n/g, "\n")

// Reglas agresivas del contexto: si el modal quedara dentro del detalle,
// todo su texto y fondo serían #0b1220 / #151515 (texto oscuro sobre oscuro).
const HOSTILE_CSS = `
.admin-order-detail-scope, .admin-order-detail-scope * { color: #0b1220 !important; background: #151515 !important; }
.admin-order-detail-scope h4, .admin-order-detail-scope p, .admin-order-detail-scope section { color: #0b1220 !important; }
`

const ENTRY = `
import { createElement } from "react"
import { createRoot } from "react-dom/client"
import { ReceptionConfirmationModal } from "./components/claims/reception-confirmation-modal"

const calls = { cancel: 0, confirm: 0 }
window.__receptionCalls = calls
window.__mountReception = (saving) => {
  const root = createRoot(document.getElementById("detail-react-root"))
  root.render(createElement(ReceptionConfirmationModal, {
    productName: "Auricular Ñandú",
    restocked: 1,
    writtenOff: 0,
    productStock: 4,
    stockDelta: 1,
    variant: { name: "Negro", stock: 2 },
    saving,
    onCancel: () => { calls.cancel++ },
    onConfirm: () => { calls.confirm++ },
  }))
}
`

const pageHtml = (theme: "dark" | "light", bundle: string) => `<!doctype html>
<html data-admin-theme="${theme}"><head><style>${globalsCss}</style><style>${HOSTILE_CSS}</style></head><body>
<div class="beyonix-admin-shell"><main class="beyonix-admin-main"><div>
  <div class="admin-order-detail-scope bx-surface bx-surface-section rounded-xl border border-white/10 bg-[#05070A]" style="position:relative;z-index:5;transform:translateZ(0)">
    <div class="admin-order-detail-content">
      <section class="admin-claim-manager admin-ds-surface border-[#7f2d3a]/65 bg-[#0D1117]">
        <section class="admin-claim-card admin-claim-reception-panel bx-surface bx-surface-section">
          <div id="detail-react-root"></div>
        </section>
      </section>
    </div>
  </div>
</div></main></div>
<script>${bundle}</script>
</body></html>`

type Rgba = [number, number, number, number]

function parse(value: string): Rgba {
  const match = value.match(/rgba?\(([^)]+)\)/)
  assert.ok(match, `color no RGB: ${value}`)
  const [r, g, b, a = "1"] = match[1].split(",").map((part) => part.trim())
  return [Number(r), Number(g), Number(b), Number(a)]
}

function luminance([r, g, b]: Rgba) {
  const channel = (value: number) => {
    const scaled = value / 255
    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

function contrast(a: Rgba, b: Rgba) {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (light + 0.05) / (dark + 0.05)
}

let browser: Browser
let bundle: string

test.before(async () => {
  const result = await build({
    stdin: { contents: ENTRY, resolveDir: process.cwd(), loader: "tsx", sourcefile: "reception-modal-entry.tsx" },
    bundle: true,
    format: "iife",
    write: false,
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "silent",
  })
  bundle = result.outputFiles[0].text
  browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chrome", headless: true })
})

test.after(async () => {
  await browser?.close()
})

async function mount(theme: "dark" | "light", width = 1366, saving = false): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height: 900 } })
  await page.route("**/*", (route) => route.abort())
  await page.setContent(pageHtml(theme, bundle))
  await page.evaluate((isSaving) => {
    ;(window as unknown as { __mountReception: (saving: boolean) => void }).__mountReception(isSaving)
  }, saving)
  await page.waitForSelector('[role="dialog"]')
  return page
}

const colorOf = (page: Page, selector: string, property: "color" | "backgroundColor") =>
  page.locator(selector).first().evaluate((element, prop) => getComputedStyle(element)[prop], property)

test("contrato: el panel usa el componente con Portal y el componente no depende de clases del admin", () => {
  assert.match(modalSource, /import \{ createPortal \} from "react-dom"/)
  assert.match(modalSource, /if \(typeof document === "undefined"\) return null/)
  assert.match(modalSource, /document\.body,\n  \)/)
  const classes = [...modalSource.matchAll(/className="([^"]+)"/g)].map((match) => match[1])
  assert.ok(classes.length > 10)
  for (const value of classes) {
    assert.match(value, /^admin-reception-modal__?[a-z-]*( is-[a-z]+)?$|^admin-reception-modal$/, `clase ajena al modal: ${value}`)
  }
  assert.doesNotMatch(modalSource, /!important/)
  // El panel sólo le pasa los mismos valores y handlers de antes.
  const usage = claimsSource.slice(claimsSource.indexOf("<ReceptionConfirmationModal"), claimsSource.indexOf("/>", claimsSource.indexOf("<ReceptionConfirmationModal")))
  assert.match(usage, /restocked=\{confirmationRestocked\}/)
  assert.match(usage, /writtenOff=\{confirmationWrittenOff\}/)
  assert.match(usage, /stockDelta=\{confirmationStockDelta\}/)
  assert.match(usage, /saving=\{savingItemId !== null\}/)
  assert.match(usage, /onCancel=\{\(\) => setConfirmationItemId\(null\)\}/)
  assert.match(usage, /onConfirm=\{\(\) => void saveItem\(confirmationItem, true\)\}/)
  // No quedó un modal inline en el panel.
  assert.doesNotMatch(claimsSource, /aria-labelledby="return-inventory-confirmation-title"/)
  // El bloque CSS del modal no usa !important ni selectores del admin.
  const css = readFileSync("app/globals.css", "utf8")
  const blockStart = css.lastIndexOf("/* ====", css.indexOf('   Modal "Confirmar movimiento" de la recepción de inventario'))
  // Sólo este bloque: hasta el encabezado del siguiente bloque (si hay).
  const nextBlock = css.indexOf("/* ====", blockStart + 1)
  const block = css.slice(blockStart, nextBlock === -1 ? undefined : nextBlock).replace(/\/\*[\s\S]*?\*\//g, "")
  assert.doesNotMatch(block, /!important/)
  assert.doesNotMatch(block, /admin-order-detail-scope|beyonix-admin-main|beyonix-admin-shell/)
})

test("DOM: el modal se monta en document.body, fuera de .admin-order-detail-scope", async () => {
  const page = await mount("dark")
  try {
    const placement = await page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"]')!
      const backdrop = dialog.parentElement!
      return {
        backdropParent: backdrop.parentElement === document.body,
        insideScope: Boolean(dialog.closest(".admin-order-detail-scope")),
        insideShell: Boolean(dialog.closest(".beyonix-admin-shell")),
        reactRootEmpty: document.getElementById("detail-react-root")!.children.length === 0,
      }
    })
    assert.deepEqual(placement, { backdropParent: true, insideScope: false, insideShell: false, reactRootEmpty: true })
  } finally {
    await page.close()
  }
})

test("CSS: ninguna regla .admin-order-detail-scope (reales + hostiles) matchea elementos del modal", async () => {
  const page = await mount("dark")
  try {
    const leaks = (await page.evaluate(`(() => {
      const rules = []
      function collect(list) {
        for (const rule of list) {
          if (rule instanceof CSSStyleRule) rules.push(rule)
          else if (rule.cssRules) collect(rule.cssRules)
        }
      }
      for (const sheet of document.styleSheets) collect(sheet.cssRules)
      const scoped = rules.filter((rule) => rule.selectorText.includes("admin-order-detail-scope"))
      const backdrop = document.querySelector('[role="dialog"]').parentElement
      const elements = [backdrop, ...backdrop.querySelectorAll("*")]
      const leaks = []
      for (const rule of scoped) {
        for (const element of elements) {
          let matches = false
          try { matches = element.matches(rule.selectorText) } catch (error) { matches = false }
          if (matches) leaks.push(rule.selectorText.slice(0, 120))
        }
      }
      return { leaks, scoped: scoped.length, elements: elements.length }
    })()`)) as { leaks: string[]; scoped: number; elements: number }
    assert.ok(leaks.scoped > 20, "el CSS real trae reglas del detalle")
    assert.ok(leaks.elements > 15)
    assert.deepEqual(leaks.leaks, [])
  } finally {
    await page.close()
  }
})

for (const theme of ["dark", "light"] as const) {
  test(`${theme}: eyebrow, título, subtítulo, cards, advertencia y botones legibles pese a las reglas hostiles`, async () => {
    const page = await mount(theme)
    try {
      const dialog = parse(await colorOf(page, '[role="dialog"]', "backgroundColor"))
      assert.equal(dialog[3], 1)
      const title = parse(await colorOf(page, ".admin-reception-modal__title", "color"))
      if (theme === "dark") {
        assert.deepEqual(dialog.slice(0, 3), [11, 23, 36], "Dark: fondo #0B1724")
        assert.ok(luminance(title) > 0.9, "Dark: título blanco / casi blanco")
      } else {
        assert.deepEqual(dialog.slice(0, 3), [255, 255, 255], "Light: fondo blanco")
        assert.deepEqual(title.slice(0, 3), [17, 42, 67], "Light: título #112A43")
      }
      const minimums: Array<[string, number]> = [
        [".admin-reception-modal__eyebrow", 4.5],
        [".admin-reception-modal__title", 7],
        [".admin-reception-modal__subtitle", 4.5],
      ]
      for (const [selector, minimum] of minimums) {
        const color = parse(await colorOf(page, selector, "color"))
        assert.equal(color[3], 1, `${selector} sin atenuar`)
        assert.ok(contrast(color, dialog) >= minimum, `${theme} ${selector}: ${contrast(color, dialog).toFixed(2)}`)
      }
      const boxes: Array<[string, string[], number]> = [
        [".admin-reception-modal__metric.is-restock", [".admin-reception-modal__metric.is-restock .admin-reception-modal__metric-label", ".admin-reception-modal__metric.is-restock .admin-reception-modal__metric-value"], 4.5],
        [".admin-reception-modal__metric.is-writeoff", [".admin-reception-modal__metric.is-writeoff .admin-reception-modal__metric-label", ".admin-reception-modal__metric.is-writeoff .admin-reception-modal__metric-value"], 4.5],
        [".admin-reception-modal__stock", [".admin-reception-modal__stock-label", ".admin-reception-modal__stock-lines p"], 4.5],
        [".admin-reception-modal__warning", [".admin-reception-modal__warning"], 7],
        [".admin-reception-modal__button.is-primary", [".admin-reception-modal__button.is-primary"], 4.5],
        [".admin-reception-modal__button.is-secondary", [".admin-reception-modal__button.is-secondary"], 4.5],
      ]
      const tones = new Set<string>()
      for (const [box, texts, minimum] of boxes) {
        const background = parse(await colorOf(page, box, "backgroundColor"))
        assert.equal(background[3], 1, `${box}: fondo propio`)
        tones.add(background.slice(0, 3).join(","))
        for (const text of texts) {
          const ratio = contrast(parse(await colorOf(page, text, "color")), background)
          assert.ok(ratio >= minimum, `${theme} ${text}: ${ratio.toFixed(2)}`)
        }
      }
      assert.equal(tones.size, boxes.length, "verde, rojo, neutro, ámbar, primario y secundario distintos")
      assert.ok(!tones.has("21,21,21"), "ninguna caja con el #151515 de la regla hostil")
    } finally {
      await page.close()
    }
  })
}

test("overlay cubre todo el viewport, por encima del detalle, y el modal tiene escala correcta", async () => {
  for (const [width, theme] of [[1366, "dark"], [1920, "light"], [390, "dark"]] as const) {
    const page = await mount(theme, width)
    try {
      const layout = await page.evaluate(() => {
        const dialog = document.querySelector('[role="dialog"]') as HTMLElement
        const backdrop = dialog.parentElement as HTMLElement
        const box = backdrop.getBoundingClientRect()
        const dialogBox = dialog.getBoundingClientRect()
        const style = getComputedStyle(backdrop)
        const metrics = getComputedStyle(dialog.querySelector(".admin-reception-modal__metrics")!).gridTemplateColumns.split(" ").length
        // El elemento visible en el centro de la pantalla debe ser el modal
        // (no el detalle con su propio stacking context).
        const center = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2)
        return {
          top: box.top, left: box.left, width: box.width, height: box.height,
          viewport: { width: window.innerWidth, height: window.innerHeight },
          position: style.position,
          zIndex: Number(style.zIndex),
          backdropAlpha: style.backgroundColor,
          dialogWidth: dialogBox.width,
          gutter: Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight),
          centered: Math.abs(dialogBox.left + dialogBox.width / 2 - window.innerWidth / 2) <= 1,
          metricColumns: metrics,
          centerInsideModal: Boolean(center && backdrop.contains(center)),
        }
      })
      assert.equal(layout.position, "fixed")
      assert.deepEqual([layout.top, layout.left, layout.width, layout.height], [0, 0, layout.viewport.width, layout.viewport.height])
      assert.ok(layout.zIndex >= 1000)
      assert.ok(parse(layout.backdropAlpha)[3] < 1, "overlay translúcido: oscurece sin tapar del todo")
      assert.ok(layout.centered, `${width}: modal centrado`)
      assert.ok(layout.centerInsideModal, `${width}: nada del detalle queda por encima del modal`)
      if (width >= 1280) {
        assert.ok(layout.dialogWidth >= 460 && layout.dialogWidth <= 540, `${width}: ancho ${layout.dialogWidth}`)
        assert.equal(layout.metricColumns, 2)
      } else {
        assert.ok(layout.gutter >= 24 && layout.gutter <= 40, `${width}: margen lateral (${layout.gutter})`)
        assert.ok(Math.abs(layout.dialogWidth - (layout.viewport.width - layout.gutter)) <= 1, `${width}: ancho disponible con márgenes (${layout.dialogWidth})`)
        assert.equal(layout.metricColumns, 1)
      }
    } finally {
      await page.close()
    }
  }
})

test("comportamiento intacto: Cancelar, Confirmar, overlay y estado guardando", async () => {
  const page = await mount("dark")
  try {
    await page.click(".admin-reception-modal__button.is-primary")
    await page.click(".admin-reception-modal__button.is-secondary")
    await page.mouse.click(5, 5)
    const calls = await page.evaluate(() => (window as unknown as { __receptionCalls: { cancel: number; confirm: number } }).__receptionCalls)
    assert.deepEqual(calls, { cancel: 2, confirm: 1 }, "Confirmar llama onConfirm; Cancelar y el overlay, onCancel")
    const text = await page.locator('[role="dialog"]').innerText()
    assert.match(text, /Stock general del producto: 4 → 5/)
    assert.match(text, /Variante Negro: 2 → 3/)
  } finally {
    await page.close()
  }
  const saving = await mount("light", 1366, true)
  try {
    const disabled = await saving.$$eval(".admin-reception-modal__button", (buttons) => buttons.map((button) => (button as HTMLButtonElement).disabled))
    assert.deepEqual(disabled, [true, true])
    const background = parse(await colorOf(saving, ".admin-reception-modal__button.is-primary", "backgroundColor"))
    const color = parse(await colorOf(saving, ".admin-reception-modal__button.is-primary", "color"))
    assert.ok(contrast(color, background) >= 4.5, "deshabilitado legible")
  } finally {
    await saving.close()
  }
})
