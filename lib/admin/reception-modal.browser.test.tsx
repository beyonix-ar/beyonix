import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { chromium, type Browser, type Page } from "playwright-core"

// Modal "Confirmar movimiento" (recepción de inventario) medido en Edge real
// con el globals.css del proyecto, DENTRO de la misma cadena de contenedores
// del detalle de pedido. Ahí viven las reglas globales que lo volvían
// ilegible: [class*="bg-"] -> #151515, [rounded][border] -> #202020,
// .admin-ds-surface, tracking-widest -> texto atenuado y el navy genérico
// de botones.

const css = readFileSync("app/globals.css", "utf8").replace(/@theme inline\s*\{/g, ":root {")
const claimsSource = readFileSync("components/claims/admin-claim-manager.tsx", "utf8").replace(/\r\n/g, "\n")

const SHIM = `
*, ::before, ::after { box-sizing: border-box; border-width: 0; border-style: solid; }
body { margin: 0; font-family: sans-serif; }
.flex { display: flex; } .grid { display: grid; } .fixed { position: fixed; } .inset-0 { inset: 0; }
.p-4 { padding: 1rem; } .gap-2 { gap: .5rem; } .gap-3 { gap: .75rem; }
`

// Mismo marcado que el componente (verificado abajo contra el código fuente).
const modal = `
<div class="admin-reception-modal__backdrop fixed inset-0 z-120 flex items-center justify-center p-4" role="presentation" data-backdrop>
  <section role="dialog" class="admin-reception-modal w-full max-w-md p-4 sm:p-5" data-dialog>
    <div class="flex items-start gap-3">
      <span class="admin-reception-modal__icon" data-icon><svg class="lucide lucide-package-check size-5" data-icon-svg viewBox="0 0 24 24"></svg></span>
      <div class="min-w-0">
        <p class="admin-reception-modal__eyebrow" data-eyebrow>Confirmar movimiento</p>
        <h4 class="admin-reception-modal__title mt-1" data-title>Recepción de Auricular Ñandú</h4>
        <p class="admin-reception-modal__subtitle mt-1" data-subtitle>Revisá el destino de las unidades antes de modificar el inventario.</p>
      </div>
    </div>
    <div class="mt-4 grid gap-2 sm:grid-cols-2">
      <div class="admin-reception-modal__metric is-restock" data-restock>
        <p class="admin-reception-modal__metric-label" data-restock-label>Vuelven al stock</p>
        <p class="admin-reception-modal__metric-value mt-1" data-restock-value>1</p>
      </div>
      <div class="admin-reception-modal__metric is-writeoff" data-writeoff>
        <p class="admin-reception-modal__metric-label" data-writeoff-label>Baja o pérdida</p>
        <p class="admin-reception-modal__metric-value mt-1" data-writeoff-value>0</p>
      </div>
    </div>
    <div class="admin-reception-modal__stock mt-3" data-stock>
      <p class="admin-reception-modal__stock-label" data-stock-label>Stock resultante</p>
      <div class="admin-reception-modal__stock-lines mt-1 space-y-0.5"><p data-stock-line>Stock general del producto: 4 → 5</p></div>
    </div>
    <p class="admin-reception-modal__warning mt-3" data-warning>Al confirmar se registra la recepción y su impacto de stock.</p>
    <div class="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
      <button type="button" class="admin-claim-flow-button admin-claim-flow-control is-secondary is-large" data-cancel>Cancelar</button>
      <button type="button" class="admin-claim-flow-button admin-claim-flow-control is-primary is-large" data-confirm>Confirmar recepción</button>
      <button type="button" disabled class="admin-claim-flow-button admin-claim-flow-control is-primary is-large" data-disabled>Confirmar recepción</button>
    </div>
  </section>
</div>`

// Cadena real: shell > main > módulo del pedido > contenido > gestor del
// reclamo (tinte "sensible") > panel de recepción > modal.
const pageHtml = (theme: "dark" | "light") => `<!doctype html><html data-admin-theme="${theme}"><head>
<style>${css}</style><style>${SHIM}</style></head><body>
<div class="beyonix-admin-shell"><main class="beyonix-admin-main"><div>
  <div class="admin-order-detail-scope bx-surface bx-surface-section rounded-xl border border-white/10 bg-[#05070A]">
    <div class="bx-surface-inherit bg-[#05070A]"><div class="admin-order-detail-content min-w-0 flex-1">
      <section class="admin-claim-manager admin-ds-surface mt-3 overflow-hidden border-[#7f2d3a]/65 bg-[#0D1117]">
        <section class="admin-claim-card admin-claim-reception-panel bx-surface bx-surface-section p-4">${modal}</section>
      </section>
    </div></div>
  </div>
</div></main></div></body></html>`

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

async function style(page: Page, selector: string) {
  return page.locator(selector).evaluate((element) => {
    const computed = getComputedStyle(element)
    const firstStop = computed.backgroundImage.match(/rgba?\([^)]+\)/)?.[0]
    const color = computed.backgroundColor
    return {
      color: computed.color,
      background: color === "rgba(0, 0, 0, 0)" && firstStop ? firstStop : color,
    }
  })
}

let browser: Browser

test.before(async () => {
  browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chrome", headless: true })
})

test.after(async () => {
  await browser.close()
})

test("el componente usa sólo las clases propias del modal (ninguna que las reglas globales reescriban)", () => {
  const start = claimsSource.indexOf("{confirmationItem && (")
  const end = claimsSource.indexOf("\n      )}\n", start)
  assert.ok(start > 0 && end > start)
  const jsx = claimsSource.slice(start, end)
  const classes = [...jsx.matchAll(/className="([^"]+)"/g)].map((match) => match[1])
  for (const value of classes) {
    assert.doesNotMatch(value, /\bbg-|text-white|tracking-widest|admin-ds-surface|admin-ds-button/, value)
    assert.ok(!(value.includes("rounded") && /\bborder\b/.test(value)), value)
  }
  for (const part of ["__backdrop", "__icon", "__eyebrow", "__title", "__subtitle", "__metric is-restock", "__metric is-writeoff", "__metric-label", "__metric-value", "__stock", "__stock-label", "__stock-lines", "__warning"]) {
    assert.ok(jsx.includes(`admin-reception-modal${part}`), part)
  }
  assert.match(jsx, /className="admin-claim-flow-button admin-claim-flow-control is-secondary is-large"[\s\S]*?Cancelar/)
  assert.match(jsx, /className="admin-claim-flow-button admin-claim-flow-control is-primary is-large"[\s\S]*?Confirmar recepción/)
  // Lógica intacta: mismos handlers y valores.
  assert.match(jsx, /onClick=\{\(\) => setConfirmationItemId\(null\)\}/)
  assert.match(jsx, /onClick=\{\(\) => void saveItem\(confirmationItem, true\)\}/)
  assert.match(jsx, /\{confirmationProductStock\} → \{confirmationProductStock \+ confirmationStockDelta\}/)
  assert.match(jsx, /disabled=\{savingItemId !== null\}/)
})

for (const theme of ["dark", "light"] as const) {
  test(`${theme}: título, subtítulo, cards, stock, advertencia y botones legibles`, async () => {
    const page = await browser.newPage()
    await page.route("**/*", (route) => route.abort())
    await page.setContent(pageHtml(theme))
    try {
      const dialog = parse((await style(page, "[data-dialog]")).background)
      assert.equal(dialog[3], 1, "fondo del modal opaco y propio")
      if (theme === "dark") assert.deepEqual(dialog.slice(0, 3), [11, 23, 36], "Dark: #0B1724")
      else assert.deepEqual(dialog.slice(0, 3), [255, 255, 255], "Light: blanco")

      // El overlay sigue siendo translúcido (la regla [class*="bg-"] lo volvía opaco).
      const backdrop = parse((await style(page, "[data-backdrop]")).background)
      assert.ok(backdrop[3] < 1, `overlay translúcido (${backdrop[3]})`)

      const onDialog = async (selector: string, minimum: number) => {
        const color = parse((await style(page, selector)).color)
        assert.equal(color[3], 1, `${selector}: color sólido, sin atenuar`)
        const ratio = contrast(color, dialog)
        assert.ok(ratio >= minimum, `${theme} ${selector}: ${ratio.toFixed(2)}`)
      }
      await onDialog("[data-title]", 7)
      await onDialog("[data-subtitle]", 4.5)
      await onDialog("[data-eyebrow]", 4.5)

      const onOwn = async (box: string, texts: string[], minimum: number) => {
        const background = parse((await style(page, box)).background)
        assert.equal(background[3], 1, `${box}: fondo propio`)
        for (const text of texts) {
          const ratio = contrast(parse((await style(page, text)).color), background)
          assert.ok(ratio >= minimum, `${theme} ${text} sobre ${box}: ${ratio.toFixed(2)}`)
        }
        return background
      }
      const restock = await onOwn("[data-restock]", ["[data-restock-label]", "[data-restock-value]"], 4.5)
      const writeoff = await onOwn("[data-writeoff]", ["[data-writeoff-label]", "[data-writeoff-value]"], 4.5)
      const stock = await onOwn("[data-stock]", ["[data-stock-label]", "[data-stock-line]"], 4.5)
      const warning = await onOwn("[data-warning]", ["[data-warning]"], 7)

      // Tonos semánticos: verde, rojo, neutro y ámbar distintos entre sí y
      // distintos de los grises globales (#151515 / #202020) que los pisaban.
      const tones = [restock, writeoff, stock, warning].map((color) => color.slice(0, 3).join(","))
      assert.equal(new Set(tones).size, 4)
      for (const tone of tones) assert.ok(!["21,21,21", "32,32,32"].includes(tone), tone)
      const [rr, rg] = restock
      assert.ok(rg > rr, "Vuelven al stock en tono verde")
      const [wr, wg] = writeoff
      assert.ok(wr > wg, "Baja o pérdida en tono rojo")
      const [ar, ag, ab] = warning
      assert.ok(ar > ab && ag > ab, "advertencia en tono ámbar")

      // Ícono con color propio (no el remapeo global de svg.lucide).
      const icon = await page.locator("[data-icon-svg]").evaluate((element) => getComputedStyle(element).color)
      const iconBox = await style(page, "[data-icon]")
      assert.ok(contrast(parse(icon), parse(iconBox.background)) >= 4.5, `${theme}: ícono`)

      // Botones: secundario y primario distintos, ambos legibles.
      const cancel = await style(page, "[data-cancel]")
      const confirm = await style(page, "[data-confirm]")
      assert.notEqual(cancel.background, confirm.background, "Cancelar no se confunde con Confirmar")
      assert.ok(contrast(parse(confirm.color), parse(confirm.background)) >= 4.5, `${theme}: Confirmar`)
      const cancelBackground = parse(cancel.background)
      const cancelSolid = cancelBackground[3] < 1 ? dialog : cancelBackground
      assert.ok(contrast(parse(cancel.color), cancelSolid) >= 4.5, `${theme}: Cancelar`)
      if (theme === "light") {
        const disabled = await style(page, "[data-disabled]")
        assert.ok(contrast(parse(disabled.color), parse(disabled.background)) >= 4.5, "Light: deshabilitado legible")
      }
    } finally {
      await page.close()
    }
  })
}

test("CSS: la isla del modal tiene variantes Dark/Light y foco visible en botones", () => {
  assert.match(css, /\.admin-reception-modal \{\n  --reception-modal-bg: #0b1724;/)
  assert.match(css, /html\[data-admin-theme="light"\] \.admin-reception-modal \{\n  --reception-modal-bg: #ffffff;/)
  assert.match(css, /\.admin-claim-flow-button:focus-visible \{/)
  // Los botones del modal están excluidos del navy genérico del detalle.
  assert.ok(css.includes(":not(.admin-claim-decision-button):not(.admin-claim-flow-control)"))
})
