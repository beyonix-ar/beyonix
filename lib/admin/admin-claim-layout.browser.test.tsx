import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { chromium, type Page } from "playwright-core"

// Layout real de "Atención al cliente" con el globals.css del proyecto:
// - el chat ocupa la altura que marca "Gestionar reclamo" (>= 1280 px),
//   Evidencia conserva su altura natural, el hilo scrollea adentro y el
//   composer queda abajo;
// - en layout apilado el chat tiene un alto razonable con scroll interno;
// - "Recepción del producto original": la card interior se distingue del
//   contenedor por tono (Light y Dark), no sólo por el borde.
//
// El marcado replica las clases de los componentes (se verifica contra el
// código fuente) y las pocas utilidades de Tailwind que usan se declaran acá:
// globals.css se carga sin compilar.

const css = readFileSync("app/globals.css", "utf8")
const claimsSource = readFileSync("components/claims/admin-claim-manager.tsx", "utf8")

const TAILWIND_SHIM = `
*, ::before, ::after { box-sizing: border-box; border-width: 0; border-style: solid; }
body { margin: 0; font-family: sans-serif; }
.grid { display: grid; } .flex { display: flex; } .flex-col { flex-direction: column; }
.flex-1 { flex: 1 1 0%; } .min-h-0 { min-height: 0; } .overflow-hidden { overflow: hidden; }
.overflow-y-auto { overflow-y: auto; } .gap-3 { gap: .75rem; } .p-3 { padding: .75rem; }
.p-2 { padding: .5rem; } .p-2\\.5 { padding: .625rem; } .rounded-xl { border-radius: .75rem; }
.border { border-width: 1px; } .border-b { border-bottom-width: 1px; } .border-t { border-top-width: 1px; }
.space-y-3 > :not(:last-child) { margin-bottom: .75rem; } .space-y-2 > :not(:last-child) { margin-bottom: .5rem; }
`

function workspaceMarkup({ messages, asideHeight }: { messages: number; asideHeight: number }) {
  const bubbles = Array.from(
    { length: messages },
    (_, index) =>
      `<div class="admin-claim-chat-bubble rounded-lg border px-3 py-2"><p>Cliente</p><p>Mensaje ${index + 1}: el producto llegó con la caja golpeada.</p></div>`,
  ).join("")
  return `
<main class="beyonix-admin-main">
  <section class="admin-claim-manager admin-ds-surface">
    <div class="admin-claim-workspace grid gap-3 p-3">
      <main class="space-y-3">
        <section class="admin-claim-card rounded-xl border p-3" data-evidence><h4>Evidencia</h4><p>El cliente no adjuntó imágenes ni videos.</p></section>
        <section class="admin-claim-chat-panel flex flex-col overflow-hidden rounded-xl border" data-chat>
          <div class="admin-claim-header border-b">Conversación con el cliente</div>
          <div class="admin-claim-chat-thread min-h-0 flex-1 space-y-2 overflow-y-auto p-2.5" data-thread>${bubbles}</div>
          <div class="admin-claim-composer border-t p-2" data-composer><textarea rows="1"></textarea><button>Enviar respuesta</button></div>
        </section>
      </main>
      <aside><section class="admin-claim-card rounded-xl border p-3" data-manage style="height:${asideHeight}px">Gestionar reclamo</section></aside>
    </div>
  </section>
</main>`
}

const receptionMarkup = `
<main class="beyonix-admin-main">
  <section class="admin-claim-card admin-claim-reception-panel rounded-xl border p-4" data-outer>
    <h4 class="admin-claim-reception-heading">Recepción del producto original</h4>
    <article class="admin-claim-reception-item" data-inner>
      <dl class="admin-claim-reception-counts"><div class="admin-claim-reception-count" data-count><dt>Reclamadas</dt><dd>1</dd></div></dl>
      <div class="admin-claim-reception-block">
        <button type="button" aria-pressed="false" class="admin-claim-choice admin-claim-flow-control is-restock" data-tile>
          <span class="admin-claim-choice-title">Volver al stock</span>
        </button>
      </div>
      <label class="admin-claim-reception-block"><textarea class="admin-claim-note" data-note></textarea></label>
      <p class="admin-claim-reception-missing" data-missing>Elegí qué hacer con la unidad.</p>
    </article>
  </section>
</main>`

async function load(page: Page, body: string, theme: "dark" | "light" = "dark") {
  await page.setContent(
    `<html data-admin-theme="${theme}"><head><style>${css}</style><style>${TAILWIND_SHIM}</style></head><body>${body}</body></html>`,
  )
}

async function rect(page: Page, selector: string) {
  return page.locator(selector).evaluate((element) => {
    const box = element.getBoundingClientRect()
    return { top: box.top, bottom: box.bottom, height: box.height }
  })
}

function rootFontSize(page: Page) {
  return page.evaluate(() => Number.parseFloat(getComputedStyle(document.documentElement).fontSize))
}

function parseColor(value: string): [number, number, number, number] | null {
  const match = value.match(/rgba?\(([^)]+)\)/)
  if (!match) return null
  const [r, g, b, a = "1"] = match[1].split(",").map((part) => part.trim())
  return [Number(r), Number(g), Number(b), Number(a)]
}

function luminance([r, g, b]: [number, number, number, number]) {
  const channel = (value: number) => {
    const scaled = value / 255
    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

function contrast(a: [number, number, number, number], b: [number, number, number, number]) {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (light + 0.05) / (dark + 0.05)
}

test("el marcado del test replica las clases reales del componente", () => {
  for (const className of [
    'className="admin-claim-workspace grid gap-3 p-3 sm:p-4"',
    '<main className="space-y-3">',
    'className="admin-claim-chat-panel flex flex-col overflow-hidden rounded-xl border"',
    'className="admin-claim-chat-thread min-h-0 flex-1 space-y-2 overflow-y-auto p-2.5"',
    'className="admin-claim-composer border-t p-2"',
    'className="admin-claim-reception-item"',
  ]) {
    assert.ok(claimsSource.includes(className), className)
  }
})

test("chat: usa la altura disponible, scroll interno y composer abajo (1280-1920 y apilado)", async () => {
  const browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chrome", headless: true })
  try {
    const page = await browser.newPage()
    await page.route("**/*", (route) => route.abort())

    for (const width of [1280, 1366, 1440, 1920]) {
      await page.setViewportSize({ width, height: 900 })

      // Muchos mensajes y panel derecho alto: el chat llega al mismo pie.
      await load(page, workspaceMarkup({ messages: 40, asideHeight: 980 }))
      const aside = await rect(page, "[data-manage]")
      const chat = await rect(page, "[data-chat]")
      const composer = await rect(page, "[data-composer]")
      const evidence = await rect(page, "[data-evidence]")
      assert.ok(Math.abs(chat.bottom - aside.bottom) <= 1.5, `${width}: chat ${chat.bottom} vs panel ${aside.bottom}`)
      assert.ok(Math.abs(composer.bottom - chat.bottom) <= 2, `${width}: composer abajo`)
      const thread = await page.locator("[data-thread]").evaluate((element) => ({
        overflowY: getComputedStyle(element).overflowY,
        scrollable: element.scrollHeight > element.clientHeight + 1,
      }))
      assert.equal(thread.overflowY, "auto")
      assert.ok(thread.scrollable, `${width}: el hilo scrollea adentro`)
      const workspace = await rect(page, ".admin-claim-workspace")
      assert.ok(workspace.height <= 980 + 24 + 2, `${width}: los mensajes no agrandan la página (${workspace.height})`)

      // Pocos mensajes: igual ocupa el espacio disponible (sin hueco abajo).
      await load(page, workspaceMarkup({ messages: 2, asideHeight: 980 }))
      const shortChat = await rect(page, "[data-chat]")
      const shortAside = await rect(page, "[data-manage]")
      assert.ok(Math.abs(shortChat.bottom - shortAside.bottom) <= 1.5, `${width}: chat corto también llega al pie`)

      // Panel derecho bajo: el chat mantiene un mínimo usable.
      await load(page, workspaceMarkup({ messages: 40, asideHeight: 160 }))
      const naturalEvidence = await rect(page, "[data-evidence]")
      assert.ok(
        Math.abs(evidence.height - naturalEvidence.height) <= 0.5,
        `${width}: Evidencia no se estira (${evidence.height} vs ${naturalEvidence.height})`,
      )
      const minThread = await rect(page, "[data-thread]")
      const rem = await rootFontSize(page)
      assert.ok(minThread.height >= 18 * rem - 1, `${width}: hilo mínimo 18rem (${minThread.height})`)
    }

    for (const width of [390, 1024]) {
      await page.setViewportSize({ width, height: 800 })
      await load(page, workspaceMarkup({ messages: 40, asideHeight: 700 }))
      const chat = await rect(page, "[data-chat]")
      const aside = await rect(page, "[data-manage]")
      const thread = await rect(page, "[data-thread]")
      const composer = await rect(page, "[data-composer]")
      const rem = await rootFontSize(page)
      assert.ok(aside.top >= chat.bottom, `${width}: layout apilado`)
      assert.ok(Math.abs(thread.height - 18 * rem) <= 1, `${width}: hilo de 18rem (${thread.height})`)
      assert.ok(Math.abs(composer.bottom - chat.bottom) <= 2, `${width}: composer abajo`)
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${width}: sin scroll horizontal`)
    }
  } finally {
    await browser.close()
  }
})

test("recepción: la card interior se distingue del contenedor por tono en Light y Dark", async () => {
  const browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chrome", headless: true })
  try {
    const page = await browser.newPage()
    await page.route("**/*", (route) => route.abort())
    await page.setViewportSize({ width: 1366, height: 900 })

    for (const theme of ["light", "dark"] as const) {
      await load(page, receptionMarkup, theme)
      const background = (selector: string) =>
        page.locator(selector).evaluate((element) => ({
          color: getComputedStyle(element).backgroundColor,
          image: getComputedStyle(element).backgroundImage,
        }))
      const colors = {
        outer: await background("[data-outer]"),
        inner: await background("[data-inner]"),
        tile: await background("[data-tile]"),
        note: await background("[data-note]"),
        count: await background("[data-count]"),
        missing: await page.locator("[data-missing]").evaluate((element) => getComputedStyle(element).color),
      }
      const inner = parseColor(colors.inner.color)
      assert.ok(inner && inner[3] === 1, `${theme}: card interior con fondo propio opaco (${colors.inner.color})`)
      // Colores del contenedor: fondo plano o paradas del gradiente.
      const outerColors = [colors.outer.color, ...(colors.outer.image.match(/rgba?\([^)]+\)/g) ?? [])]
        .map(parseColor)
        .filter((color): color is [number, number, number, number] => color !== null && color[3] > 0.5)
      assert.ok(outerColors.length > 0, `${theme}: contenedor con fondo`)
      for (const outer of outerColors) {
        const ratio = contrast(inner, outer)
        assert.ok(ratio >= 1.04 && ratio <= 1.4, `${theme}: diferencia sutil pero visible (${ratio.toFixed(3)})`)
      }
      if (theme === "light") {
        assert.deepEqual(parseColor(colors.inner.color), [237, 242, 247, 1], "Light: #EDF2F7")
        for (const [name, value] of Object.entries({ tile: colors.tile.color, note: colors.note.color, count: colors.count.color })) {
          assert.deepEqual(parseColor(value), [255, 255, 255, 1], `Light: ${name} elevado en blanco`)
        }
        const missing = parseColor(colors.missing)!
        assert.ok(contrast(missing, inner) >= 4.5, "Light: texto secundario legible sobre la card")
      } else {
        assert.deepEqual(parseColor(colors.inner.color), [15, 28, 43, 1], "Dark: #0F1C2B")
      }
    }
  } finally {
    await browser.close()
  }
})
