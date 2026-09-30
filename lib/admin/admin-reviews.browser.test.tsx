import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import postcss from "postcss"
import tailwindcss from "@tailwindcss/postcss"
import { build, type Plugin } from "esbuild"
import { chromium, type Browser, type Page } from "playwright-core"

// Admin → Reseñas con el componente REAL (AdminResenas, bundle esbuild):
// "Destacar en Home" / "Quitar de Home" sólo para experiencias generales;
// una reseña de producto se identifica como tal y no ofrece destacar (la API
// y la base también lo rechazan). Stubs sólo de infraestructura.

const stubs: Plugin = {
  name: "admin-reviews-stubs",
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^@\/lib\/supabase\/client$/ }, () => ({ path: "supabase", namespace: "stub" }))
    pluginBuild.onLoad({ filter: /^supabase$/, namespace: "stub" }, () => ({
      loader: "js",
      contents: `
        export const supabase = { auth: { getSession: async () => ({ data: { session: { access_token: "t" } }, error: null }) } }
        export async function getSafeSupabaseSession() { return { access_token: "t" } }`,
    }))
  },
}

const REVIEWS = [
  { id: 6, orderId: 60, productId: null, productName: null, rating: 5, comment: "Excelente atención, llegó rápido", nickname: "antares", city: "Rosario", province: "Santa Fe", approved: true, featured: false, featuredAt: null, createdAt: "2026-09-30T12:00:00Z" },
  { id: 5, orderId: 60, productId: 1, productName: "Auricular Ñandú", rating: 4, comment: "Muy buen producto", nickname: "antares", city: "Rosario", province: "Santa Fe", approved: true, featured: false, featuredAt: null, createdAt: "2026-09-30T12:00:00Z" },
  { id: 4, orderId: 61, productId: 2, productName: "Trípode", rating: 5, comment: "Excelente trípode", nickname: "otro", city: "Córdoba", province: "Córdoba", approved: true, featured: true, featuredAt: "2026-09-20T12:00:00Z", createdAt: "2026-09-19T12:00:00Z" },
]

const ENTRY = `
import { createElement } from "react"
import { createRoot } from "react-dom/client"
import { AdminResenas } from "@/app/admin/sections/resenas/admin-resenas"
window.__patches = []
window.fetch = async (input, init) => {
  if (init && init.method === "PATCH") { window.__patches.push(JSON.parse(init.body)); return Response.json({ review: { featured: JSON.parse(init.body).featured, featuredAt: null } }) }
  return Response.json({ reviews: ${JSON.stringify(REVIEWS)}, page: 1, pageCount: 1, total: 3 })
}
createRoot(document.getElementById("root")).render(createElement(AdminResenas))
`

const pageHtml = (theme: "dark" | "light", css: string, bundle: string) => `<!doctype html>
<html data-admin-theme="${theme}"><head><meta charset="utf-8"><style>${css}</style></head><body>
<div class="beyonix-admin-shell"><main class="beyonix-admin-main"><div id="root"></div></main></div>
<script>window.process = { env: { NODE_ENV: "production" } }</script>
<script>${bundle}</script></body></html>`

let browser: Browser
let css: string
let bundle: string

test.before(async () => {
  css = (await postcss([tailwindcss({ base: process.cwd() })]).process(readFileSync("app/globals.css", "utf8"), { from: "app/globals.css" })).css
  const result = await build({
    stdin: { contents: ENTRY, resolveDir: process.cwd(), loader: "tsx", sourcefile: "admin-reviews-entry.tsx" },
    bundle: true, format: "iife", write: false, jsx: "automatic", plugins: [stubs],
    define: { "process.env.NODE_ENV": '"production"' }, logLevel: "error",
  })
  bundle = result.outputFiles[0].text
  browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chrome", headless: true })
})

test.after(async () => {
  await browser?.close()
})

async function open(theme: "dark" | "light"): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.route("**/*", (route) =>
    route.request().url() === "http://admin.test/"
      ? route.fulfill({ contentType: "text/html; charset=utf-8", body: pageHtml(theme, css, bundle) })
      : route.abort(),
  )
  await page.goto("http://admin.test/")
  try {
    await page.getByText("Excelente atención, llegó rápido").waitFor({ timeout: 10_000 })
  } catch (error) {
    await page.close()
    throw new Error(`No renderizó: ${errors.join(" | ") || String(error)}`)
  }
  return page
}

for (const theme of ["light", "dark"] as const) {
  test(`E. ${theme}: experiencias ofrecen "Destacar en Home"; reseñas de producto no`, async () => {
    const page = await open(theme)
    try {
      const card = (comment: string) => page.locator(".admin-ds-card", { hasText: comment })

      const experience = card("Excelente atención, llegó rápido")
      assert.equal(await experience.getByText("Experiencia", { exact: true }).count(), 1)
      assert.equal(await experience.getByRole("button", { name: /Destacar en Home/ }).count(), 1)

      const product = card("Muy buen producto")
      assert.equal(await product.getByText("Reseña de producto", { exact: true }).count(), 1)
      assert.equal(await product.getByRole("button", { name: /Destacar en Home/ }).count(), 0, "sin acción de destacar")
      assert.equal(await product.getByRole("button").count(), 0, "ninguna acción de Home")
      assert.ok(await product.locator("[data-product-review-note]").isVisible())

      // Reseña de producto destacada de antes: sólo se puede quitar.
      const legacy = card("Excelente trípode")
      assert.equal(await legacy.getByRole("button", { name: /Destacar en Home/ }).count(), 0)
      await legacy.getByRole("button", { name: /Quitar de Home/ }).click()
      await experience.getByRole("button", { name: /Destacar en Home/ }).click()
      await page.getByText("Reseña destacada en Home.").waitFor()
      assert.deepEqual(await page.evaluate("window.__patches"), [{ id: 4, featured: false }, { id: 6, featured: true }])
    } finally {
      await page.close()
    }
  })
}
