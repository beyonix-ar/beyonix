import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { build, type Plugin } from "esbuild"
import { chromium, type Browser, type Page } from "playwright-core"

// Wizard de resolución (Etapa 6) con el componente real y globals.css, en
// Light/Dark y en ancho de teléfono: superficies sólidas, contraste legible,
// sin scroll horizontal y altura estable entre pasos.

const globalsCss = readFileSync("app/globals.css", "utf8").replace(/@theme inline\s*\{/g, ":root {")

const supabaseStub: Plugin = {
  name: "supabase-stub",
  setup(builder) {
    builder.onResolve({ filter: /^@\/lib\/supabase\/client$/ }, () => ({ path: "supabase-stub", namespace: "stub" }))
    builder.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      contents: "export const supabase = { auth: { getSession: async () => ({ data: { session: { access_token: 't' } } }) } }",
      loader: "js",
    }))
  },
}

const ENTRY = `
import { createElement } from "react"
import { createRoot } from "react-dom/client"
import { FinancialResolutionWizard } from "./app/admin/sections/pedidos/financial-resolution-wizard"

const option = (type, label) => ({ type, label, requiresConfirmation: true })
const views = {
  wizard: { mode: "wizard", amount: 125000, status: "Pendiente", product: "no_return", reception: "not_applicable",
    financialOptions: [option("beyonix_credit", "Saldo BEYONIX"), option("mercadopago_refund", "Reembolsar al medio de pago original"), option("manual_refund", "Reintegro manual")],
    receptionOptions: [], notice: null, resolution: null },
  pending: { mode: "resolution", amount: 125000, status: "Requiere acción", product: "no_return", reception: "not_applicable",
    financialOptions: [], receptionOptions: [], notice: null,
    resolution: { id: "r1", type: "manual_refund", status: "requires_action", amount: 125000, detail: "Detalle" } },
}
// Mismas clases que el panel existente (RefundManagementPanel): panel -> cards -> subcards.
const LEGACY = '<section class="admin-order-cancellation-panel rounded-xl border p-3" data-testid="financial-resolution">' +
  '<div class="admin-order-cancellation-header border-b pb-3"><h3 class="text-base font-black">Cancelación / reintegro</h3></div>' +
  '<div class="mt-3 grid gap-2.5"><div id="card" class="admin-order-cancellation-mini-card rounded-lg border px-3 py-2.5"><p>Medio de pago</p></div></div>' +
  '<section id="action" class="admin-order-cancellation-action-panel mt-3 rounded-xl border p-3"><div id="sub" class="admin-order-cancellation-mini-card rounded-lg border px-3 py-2.5">Paso 1 de 2</div></section>' +
  '<div id="form" class="admin-order-cancellation-form-panel min-w-0 rounded-xl border p-3"><input id="input" class="admin-order-cancellation-file-zone min-h-10 w-full rounded-xl border px-3 py-2" value="Referencia" /></div>' +
  '</section>'
window.__mount = (name) => {
  if (name === "legacy") { document.getElementById("root").innerHTML = LEGACY; return }
  createRoot(document.getElementById("root")).render(createElement(FinancialResolutionWizard, {
    pedido: { id: 31, order_credit_notes: [] }, view: views[name], orderNumber: "BX-1031", customerName: "Begoña Núñez",
    reason: "Arrepentimiento del cliente", onChanged() {}, onOpenBilling() {}, onOpenAttention() {}, onDownloadCreditNote() {},
  }))
}
`

const pageHtml = (theme: "dark" | "light", bundle: string) => `<!doctype html>
<html data-admin-theme="${theme}"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${globalsCss}</style></head><body>
<div class="beyonix-admin-shell"><main class="beyonix-admin-main">
  <div class="admin-order-detail-scope"><div class="admin-order-detail-content"><div id="root"></div></div></div>
</main></div>
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
    stdin: { contents: ENTRY, resolveDir: process.cwd(), loader: "tsx", sourcefile: "financial-wizard-entry.tsx" },
    bundle: true, format: "iife", write: false, jsx: "automatic", plugins: [supabaseStub],
    define: { "process.env.NODE_ENV": '"production"' }, logLevel: "silent",
  })
  bundle = result.outputFiles[0].text
  browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chrome", headless: true })
})

test.after(async () => { await browser?.close() })

async function mount(theme: "dark" | "light", view: "wizard" | "pending" | "legacy", width = 1366): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height: 900 } })
  await page.route("**/*", (route) => route.abort())
  await page.setContent(pageHtml(theme, bundle))
  await page.evaluate((name) => (window as unknown as { __mount: (name: string) => void }).__mount(name), view)
  await page.waitForSelector("[data-testid='financial-resolution']")
  return page
}

// Fondo efectivo: color base sólido + tinte del token semántico (si lo hay).
const style = async (page: Page, selector: string) => {
  const computed = await page.locator(selector).first().evaluate((element) => {
    const value = getComputedStyle(element)
    return { color: value.color, base: value.backgroundColor, tint: value.backgroundImage.match(/rgba?\([^)]+\)/)?.[0] ?? null }
  })
  const base = parse(computed.base)
  if (!computed.tint || base[3] !== 1) return { color: computed.color, background: computed.base }
  const [r, g, b, a] = parse(computed.tint)
  const mix = (top: number, bottom: number) => Math.round(top * a + bottom * (1 - a))
  return { color: computed.color, background: `rgb(${mix(r, base[0])}, ${mix(g, base[1])}, ${mix(b, base[2])})` }
}

const surface = (page: Page, selector: string) => page.locator(selector).first().evaluate((element) => {
  const value = getComputedStyle(element)
  return { background: value.backgroundColor, image: value.backgroundImage }
})

test("panel Dark: superficie sólida y jerarquía panel → cards → subcards", async () => {
  for (const view of ["legacy", "wizard"] as const) {
    const page = await mount("dark", view)
    try {
      const panel = await surface(page, "[data-testid='financial-resolution']")
      assert.equal(parse(panel.background)[3], 1, `${view}: panel transparente`)
      assert.equal(panel.image, "none", `${view}: sin gradiente translúcido sobre el fondo`)
      if (view === "legacy") {
        const [card, action, sub, input] = await Promise.all(["#card", "#action", "#sub", "#input"].map((selector) => surface(page, selector)))
        for (const item of [card, action, sub, input]) {
          assert.equal(parse(item.background)[3], 1, "card/subcard sólida")
          assert.equal(item.image, "none")
        }
        const levels = [panel, card, sub].map((item) => luminance(parse(item.background)))
        assert.ok(levels[0] < levels[1] && levels[1] < levels[2], `jerarquía por fondo: ${[panel, card, sub].map((item) => item.background).join(" < ")}`)
        assert.equal(action.background, card.background)
        assert.equal(input.background, sub.background)
      }
    } finally { await page.close() }
  }
})

test("panel Light: sin cambios", async () => {
  const page = await mount("light", "legacy")
  try {
    // Valor del panel Light antes de esta corrección (superficie de sección).
    assert.equal((await surface(page, "[data-testid='financial-resolution']")).background, "rgb(209, 217, 226)")
  } finally { await page.close() }
})

for (const theme of ["light", "dark"] as const) {
  test(`M. ${theme}: superficies sólidas y texto legible en cada paso`, async () => {
    const page = await mount(theme, "wizard")
    try {
      const step = await style(page, ".admin-financial-wizard-steps li.is-current")
      assert.equal(parse(step.background)[3], 1, "el paso actual no debe ser transparente")
      assert.ok(contrast(parse(step.color), parse(step.background)) >= 4.5, `contraste paso ${theme} ${JSON.stringify(step)}`)
      const option = await style(page, ".admin-financial-wizard-option")
      const title = await style(page, ".admin-financial-wizard-option-title")
      assert.equal(parse(option.background)[3], 1, "la opción no debe ser transparente")
      assert.ok(contrast(parse(title.color), parse(option.background)) >= 4.5, `contraste opción ${theme}`)
      const heights: number[] = []
      heights.push(await page.locator(".admin-financial-wizard-body").boundingBox().then((box) => box!.height))
      await page.getByRole("button", { name: "Continuar" }).click()
      await page.getByRole("radio", { name: /Saldo BEYONIX/ }).click()
      const selected = await style(page, ".admin-financial-wizard-option.is-selected")
      const selectedTitle = await style(page, ".admin-financial-wizard-option.is-selected .admin-financial-wizard-option-title")
      assert.ok(contrast(parse(selectedTitle.color), parse(selected.background)) >= 4.5, `contraste seleccionada ${theme}`)
      heights.push(await page.locator(".admin-financial-wizard-body").boundingBox().then((box) => box!.height))
      await page.getByRole("button", { name: "Continuar" }).click()
      const summary = await style(page, ".admin-financial-wizard-summary")
      const value = await style(page, ".admin-financial-wizard-summary-row dd")
      assert.equal(parse(summary.background)[3], 1)
      assert.ok(contrast(parse(value.color), parse(summary.background)) >= 4.5, `contraste resumen ${theme}`)
      heights.push(await page.locator(".admin-financial-wizard-body").boundingBox().then((box) => box!.height))
      assert.ok(Math.max(...heights) - Math.min(...heights) <= 120, `altura estable entre pasos: ${heights.join(", ")}`)
      assert.equal(await page.locator("fieldset, dl").count(), 1, "un solo paso visible")
    } finally { await page.close() }
  })

  test(`M. ${theme}: teléfono sin scroll horizontal y aviso legible`, async () => {
    for (const view of ["wizard", "pending", "legacy"] as const) {
      const page = await mount(theme, view, 375)
      try {
        // El contenedor del detalle es del arnés: se mide que el panel no desborde su propio ancho.
        const overflow = await page.locator("[data-testid='financial-resolution']").evaluate((panel) => {
          const right = panel.getBoundingClientRect().right
          const widest = Math.max(...[...panel.querySelectorAll("*")].map((child) => child.getBoundingClientRect().right))
          return Math.max(panel.scrollWidth - panel.clientWidth, widest - right)
        })
        assert.ok(overflow <= 1, `scroll horizontal ${view}: ${overflow}px`)
        if (view === "pending") {
          const notice = await style(page, ".admin-financial-wizard-notice")
          assert.equal(parse(notice.background)[3], 1)
          assert.ok(contrast(parse(notice.color), parse(notice.background)) >= 4.5, `contraste aviso ${theme} ${JSON.stringify(notice)}`)
        } else {
          const widths = await page.locator(".admin-financial-wizard-option").evaluateAll((items) => items.map((item) => item.getBoundingClientRect().width))
          assert.ok(widths.every((width) => width <= 375), "opciones dentro del ancho")
        }
      } finally { await page.close() }
    }
  })
}
