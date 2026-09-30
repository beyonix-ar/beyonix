import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import postcss from "postcss"
import tailwindcss from "@tailwindcss/postcss"
import { build, type Plugin } from "esbuild"
import { chromium, type Browser, type Page } from "playwright-core"

// Reseñas con los componentes REALES (bundle esbuild) y el CSS del proyecto
// compilado por Tailwind, en Light y Dark del storefront:
// - Home: comentario, nombre, localidad/provincia y estrellas legibles (AA)
//   contra el fondo real de la tarjeta, y solo se pintan las reseñas que
//   devuelve la API (destacadas).
// - Mis compras + formulario de Home: todas las estrellas de calificación
//   tienen el mismo tamaño.
// Stubs solo de infraestructura: cliente de Supabase y fetch de /api/reviews.

const stubs: Plugin = {
  name: "reviews-test-stubs",
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^@\/lib\/supabase\/client$/ }, () => ({ path: "supabase", namespace: "stub" }))
    pluginBuild.onLoad({ filter: /^supabase$/, namespace: "stub" }, () => ({
      contents: `
        export const supabase = {
          auth: {
            getSession: async () => ({ data: { session: { access_token: "t" } }, error: null }),
            onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
          },
        }
        export async function getSafeSupabaseSession() { return { access_token: "t" } }
      `,
      loader: "js",
    }))
  },
}

const ENTRY = `
import { createElement, Fragment } from "react"
import { createRoot } from "react-dom/client"
import { ReviewsSection } from "@/components/reviews-section"
import { OrderExperienceFeedback, OrderProductFeedback } from "@/components/account/account-order-components"

const producto = { id: 1, nombre: "Auricular Ñandú", imagen_principal: null }
const order = {
  id: 50, estado: "entregado", delivered_at: new Date(Date.now() - 2 * 86400000).toISOString(),
  orden_items: [{ id: 7, orden_id: 50, producto_id: 1, cantidad: 1, precio: 1000, productos: producto }],
}
createRoot(document.getElementById("home-root")).render(createElement(ReviewsSection))
createRoot(document.getElementById("account-root")).render(
  createElement(Fragment, null, createElement(OrderProductFeedback, { order }), createElement(OrderExperienceFeedback, { order })),
)
`

const API_STUB = `
window.process = { env: { NODE_ENV: "production" } }
window.fetch = async (input) => {
  const url = String(input)
  const body = url.includes("orderId=")
    ? { ownProductReviews: [], ownExperienceReview: null, reviewWindow: { status: "open", deadline: null } }
    : {
        reviews: [
          { id: 2, rating: 5, comment: "Excelente atención, llegó rápido y muy bien embalado", nickname: "Lucía", city: "Rosario", province: "Santa Fe", createdAt: "2026-09-29T12:00:00Z", canDelete: false },
          { id: 5, rating: 4, comment: "Muy buen producto, lo recomiendo", nickname: "Martín", city: "Córdoba", province: "Córdoba", createdAt: "2026-09-20T12:00:00Z", canDelete: false },
        ],
        summary: { count: 7, average: 4.3 },
        eligibleReview: { orderId: 50, nickname: "Lucas", city: "Rosario", province: "Santa Fe" },
      }
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } })
}
`

const pageHtml = (theme: "dark" | "light", css: string, bundle: string) => `<!doctype html>
<html data-account-theme="${theme}" data-account-scope><head><meta charset="utf-8"><style>${css}</style></head>
<body class="bg-beyonix-page">
<div id="home-root"></div>
<div id="account-root" class="max-w-3xl p-4"></div>
<script>${API_STUB}</script>
<script>${bundle}</script></body></html>`

// Mismos helpers que el resto de los tests de contraste (colores vía canvas).
const BROWSER_HELPERS = `
  const canvas = document.createElement("canvas")
  canvas.width = canvas.height = 1
  const ctx = canvas.getContext("2d", { willReadFrequently: true })
  function parse(value) {
    if (!value || value === "transparent") return [0, 0, 0, 0]
    ctx.clearRect(0, 0, 1, 1)
    ctx.fillStyle = "rgba(0,0,0,0)"
    ctx.fillStyle = value
    ctx.fillRect(0, 0, 1, 1)
    const d = ctx.getImageData(0, 0, 1, 1).data
    return [d[0], d[1], d[2], d[3] / 255]
  }
  function firstStop(image) {
    const re = /(rgba?|lab|oklab|oklch|lch|hsla?|color)\\(/g
    const match = re.exec(image)
    if (!match) return null
    let i = match.index + match[0].length, level = 1
    while (i < image.length && level > 0) { if (image[i] === "(") level++; else if (image[i] === ")") level--; i++ }
    return image.slice(match.index, i)
  }
  function lum(c) {
    const ch = (v) => { v = v / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }
    return 0.2126 * ch(c[0]) + 0.7152 * ch(c[1]) + 0.0722 * ch(c[2])
  }
  function ratio(a, b) { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) }
  function over(top, bottom) { const a = top[3]; return [top[0] * a + bottom[0] * (1 - a), top[1] * a + bottom[1] * (1 - a), top[2] * a + bottom[2] * (1 - a), 1] }
  function background(el) {
    const layers = []
    for (let node = el; node; node = node.parentElement) {
      const s = getComputedStyle(node)
      const stop = firstStop(s.backgroundImage)
      if (stop) { const c = parse(stop); layers.push(c); if (c[3] >= 0.95) break }
      const color = parse(s.backgroundColor)
      if (color[3] > 0) { layers.push(color); if (color[3] >= 0.95) break }
    }
    let result = [255, 255, 255, 1]
    for (let i = layers.length - 1; i >= 0; i--) result = over(layers[i], result)
    return result
  }
`

const AUDIT_HOME_CARDS = `(() => {
  ${BROWSER_HELPERS}
  const failures = []
  const texts = []
  for (const card of document.querySelectorAll("[data-testid=home-review-card]")) {
    for (const el of card.querySelectorAll("*")) {
      const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(" ").trim()
      if (!own || own === "·") continue
      const s = getComputedStyle(el)
      const bg = background(el)
      const r = ratio(over(parse(s.color), bg), bg)
      texts.push(own)
      if (r < 4.5) failures.push(own.slice(0, 40) + " -> " + r.toFixed(2))
    }
    for (const star of card.querySelectorAll("[role=img] svg")) {
      const bg = background(star.parentElement)
      const stroke = over(parse(getComputedStyle(star).color), bg)
      const r = ratio(stroke, bg)
      if (r < 3) failures.push("estrella -> " + r.toFixed(2))
    }
  }
  return { texts, failures }
})()`

let browser: Browser
let css: string
let bundle: string

test.before(async () => {
  const source = readFileSync("app/globals.css", "utf8")
  css = (await postcss([tailwindcss({ base: process.cwd() })]).process(source, { from: "app/globals.css" })).css
  const result = await build({
    stdin: { contents: ENTRY, resolveDir: process.cwd(), loader: "tsx", sourcefile: "reviews-ui-entry.tsx" },
    bundle: true,
    format: "iife",
    write: false,
    jsx: "automatic",
    plugins: [stubs],
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "error",
  })
  bundle = result.outputFiles[0].text
  browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chrome", headless: true })
})

test.after(async () => {
  await browser?.close()
})

async function open(theme: "dark" | "light"): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1600 } })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  // Origen http (no about:blank): la sección de Home usa localStorage.
  await page.route("**/*", (route) =>
    route.request().url() === "http://reviews.test/"
      ? route.fulfill({ contentType: "text/html; charset=utf-8", body: pageHtml(theme, css, bundle) })
      : route.abort(),
  )
  await page.goto("http://reviews.test/")
  try {
    await page.waitForSelector("[data-testid=home-review-card]", { timeout: 10_000 })
    await page.waitForSelector("[data-review-rating-selector]", { timeout: 10_000 })
  } catch (error) {
    await page.close()
    throw new Error(`No renderizó: ${errors.join(" | ") || String(error)}`)
  }
  return page
}

for (const theme of ["light", "dark"] as const) {
  test(`B/C. ${theme}: comentario, nombre, localidad/provincia y estrellas de Home cumplen contraste AA`, async () => {
    const page = await open(theme)
    try {
      const { texts, failures } = (await page.evaluate(AUDIT_HOME_CARDS)) as { texts: string[]; failures: string[] }
      const compact = (value: string) => value.replace(/\s+/g, "")
      for (const expected of ["“Excelente atención, llegó rápido y muy bien embalado”", "Lucía", "Rosario, Santa Fe", "29/09/2026", "Martín", "Córdoba, Córdoba"]) {
        assert.ok(texts.some((text) => compact(text).includes(compact(expected))), `visible: ${expected} (${texts.join(" | ")})`)
      }
      assert.deepEqual(failures, [])
    } finally {
      await page.close()
    }
  })

  test(`N. ${theme}: Home pinta solo las reseñas que devuelve la API (destacadas) y el promedio general`, async () => {
    const page = await open(theme)
    try {
      assert.equal(await page.locator("[data-testid=home-review-card]").count(), 2)
      assert.ok(await page.getByText("4.3/5 basado en 7 experiencias verificadas").isVisible())
    } finally {
      await page.close()
    }
  })

  test(`A. ${theme}: todas las estrellas de calificación tienen el mismo tamaño`, async () => {
    const page = await open(theme)
    try {
      const sizes = (await page.evaluate(`(() => {
        const measure = (element) => {
          const rect = element.getBoundingClientRect()
          return Math.round(rect.width) + "x" + Math.round(rect.height)
        }
        const selectors = [...document.querySelectorAll("[data-review-rating-selector]")]
        return {
          groups: selectors.map((group) => group.getAttribute("aria-label")),
          account: selectors.flatMap((group) => [...group.querySelectorAll("svg")].map(measure)),
          accountButtons: selectors.flatMap((group) => [...group.querySelectorAll("button")].map(measure)),
          home: [...document.querySelectorAll("button[aria-label^='Calificar con']")].map((button) => measure(button.querySelector("svg"))),
        }
      })()`)) as { groups: string[]; account: string[]; accountButtons: string[]; home: string[] }
      assert.deepEqual(sizes.groups, ["Calificar Auricular Ñandú", "Calificar experiencia en BEYONIX"])
      assert.equal(sizes.account.length, 10)
      assert.equal(sizes.home.length, 5)
      assert.deepEqual(new Set([...sizes.account, ...sizes.home]), new Set(["14x14"]), JSON.stringify(sizes))
      assert.deepEqual(new Set(sizes.accountButtons), new Set(["24x24"]))
    } finally {
      await page.close()
    }
  })
}

test("comentario obligatorio en Mis compras: elegir estrellas sin escribir no envía la reseña", async () => {
  const page = await open("light")
  try {
    const posts: string[] = []
    await page.exposeFunction("recordPost", (body: string) => posts.push(body))
    await page.evaluate(() => {
      const original = window.fetch
      window.fetch = async (input, init) => {
        if (init?.method === "POST") (window as unknown as { recordPost: (body: string) => void }).recordPost(String(init.body))
        return original(input, init)
      }
    })
    await page.getByRole("group", { name: "Calificar experiencia en BEYONIX" }).getByRole("button", { name: "5 estrellas" }).click()
    await page.getByRole("button", { name: "Enviar experiencia en BEYONIX" }).click()
    await page.getByText("Escribí un comentario sobre tu experiencia.").waitFor()
    await page.getByLabel(/Comentario \(mín\. 8 caracteres\)/).last().fill("aaaaaaaaaaaa")
    await page.getByRole("button", { name: "Enviar experiencia en BEYONIX" }).click()
    await page.getByText("Contanos con palabras cómo fue tu experiencia.").waitFor()
    assert.deepEqual(posts, [])
  } finally {
    await page.close()
  }
})
