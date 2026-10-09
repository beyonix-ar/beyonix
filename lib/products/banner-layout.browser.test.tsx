import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { deflateSync } from "node:zlib"
import postcss from "postcss"
import tailwindcss from "@tailwindcss/postcss"
import { build, type Plugin } from "esbuild"
import { chromium, type Browser, type Page } from "playwright-core"

// Banner de categoría con el CategoryPageLayout REAL y el CSS del proyecto.
// Regresión cubierta: con un tope de alto + object-contain la imagen quedaba
// más angosta que la caja (bandas negras laterales). Ahora la caja ocupa todo
// el ancho y la imagen la cubre (object-cover), sin deformarse, con recorte
// moderado; sin banner no se reserva espacio vacío.

const SHOTS = process.env.BANNER_LAYOUT_SHOTS

const stubs: Plugin = {
  name: "banner-layout-stubs",
  setup(pluginBuild) {
    const modules: Record<string, string> = {
      "@/context/cart-context": `export function useCart() { return { cart: [], addToCart() {}, decreaseQuantity() {}, removeFromCart() {}, getQuantity() { return 0 }, isInCart() { return false }, openCart() {} } }`,
      "@/context/auth-context": `export function useAuth() { return { user: null, isLoading: false, isInternal: false } }`,
      "@/lib/supabase/client": `
        const channel = { on() { return channel }, subscribe() { return channel } }
        const query = { select() { return query }, eq() { return query }, in() { return query }, order() { return query }, then(resolve) { return Promise.resolve({ data: [], error: null }).then(resolve) } }
        export const supabase = { from: () => query, auth: { getSession: async () => ({ data: { session: null } }) }, channel: () => channel, removeChannel: async () => "ok" }
        export async function getSafeSupabaseSession() { return null }`,
      "next/navigation": `
        export function useRouter() { return { push() {}, replace() {}, prefetch() {} } }
        export function usePathname() { return "/categorias/test" }
        export function useSearchParams() { return new URLSearchParams() }`,
      "next/link": `import { createElement, forwardRef } from "react"; export default forwardRef(function Link({ href, prefetch, ...props }, ref) { return createElement("a", { ...props, href: String(href), ref }) })`,
      "next/image": `import { createElement } from "react"; export default function Image({ src, alt, fill, priority, sizes, ...props }) { return createElement("img", { ...props, src: String(src), alt }) }`,
    }
    for (const name of Object.keys(modules)) {
      pluginBuild.onResolve({ filter: new RegExp(`^${name.replace(/[/.]/g, "\\$&")}$`) }, () => ({ path: name, namespace: "stub" }))
    }
    pluginBuild.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({ contents: modules[args.path], loader: "js", resolveDir: process.cwd() }))
  },
}

const ENTRY = `
import { createElement as h } from "react"
import { createRoot } from "react-dom/client"
import { CategoryPageLayout } from "@/components/category/layout/category-page-layout"
createRoot(document.getElementById("root")).render(h(CategoryPageLayout, {
  title: "Accesorios y utilidades", description: "", currentSlug: "test", products: [],
  image: window.__BANNER ? "https://img.test/banner.png" : null,
}))
`

// PNG con la proporción real de los banners de categoría (6534x2500 ≈ 2.61:1).
function crc32(bytes: Buffer) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}
function makePng(width: number, height: number) {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data])
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([length, body, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 2, 0, 0, 0], 8)
  const raw = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) raw.set([20, 60, 120], y * (width * 3 + 1) + 1 + x * 3)
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))])
}
const BANNER_PNG = makePng(654, 250)

let browser: Browser
let css: string
let bundle: string

test.before(async () => {
  css = (await postcss([tailwindcss({ base: process.cwd() })]).process(readFileSync("app/globals.css", "utf8"), { from: "app/globals.css" })).css
  const result = await build({
    stdin: { contents: ENTRY, resolveDir: process.cwd(), loader: "tsx", sourcefile: "banner-layout-fixture.tsx" },
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

test.after(async () => { await browser?.close() })

async function open(width: number, height: number, withBanner: boolean, theme: "light" | "dark" = "dark"): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height } })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.route("**/*", (route) => (route.request().url() === "https://img.test/banner.png"
    ? route.fulfill({ contentType: "image/png", body: BANNER_PNG })
    : route.abort()))
  await page.setContent(`<!doctype html><html lang="es" data-account-theme="${theme}" data-account-scope><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-beyonix-page"><div id="root"></div><script>window.process={env:{NODE_ENV:"production"}};window.__BANNER=${withBanner}</script><script>${bundle}</script></body></html>`)
  try {
    await page.waitForSelector(".beyonix-hero-banner", { timeout: 10_000 })
    if (withBanner) await page.waitForFunction(() => { const image = document.querySelector("[data-banner-media] img") as HTMLImageElement | null; return Boolean(image?.complete && image.naturalWidth) })
  } catch (error) { await page.close(); throw new Error(`No renderizó: ${errors.join(" | ") || String(error)}`) }
  return page
}

type BannerMetrics = { banner: number; media: number; height: number; fit: string; paintedFill: number; crop: number; overflow: number }

async function metrics(page: Page) {
  return (await page.evaluate(`(() => {
    const banner = document.querySelector(".beyonix-hero-banner").getBoundingClientRect()
    const image = document.querySelector("[data-banner-media] img")
    const box = image.getBoundingClientRect()
    const style = getComputedStyle(image)
    const ratio = image.naturalWidth / image.naturalHeight
    const painted = style.objectFit === "contain" ? Math.min(box.width, box.height * ratio) : box.width
    return {
      banner: banner.width, media: document.querySelector("[data-banner-media]").getBoundingClientRect().width, height: box.height,
      fit: style.objectFit, paintedFill: painted / banner.width,
      crop: 1 - Math.min(box.width / (box.height * ratio), (box.height * ratio) / box.width),
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    }
  })()`)) as BannerMetrics
}

const VIEWPORTS: [number, number][] = [[320, 568], [390, 844], [768, 1024], [1366, 657], [1366, 768], [1440, 900], [1920, 1080], [2560, 1440]]

for (const theme of ["dark", "light"] as const) {
  for (const [width, height] of VIEWPORTS) {
    test(`banner de categoría ${theme} ${width}x${height}: llena el ancho (sin bandas laterales), sin deformar, recorte moderado`, async () => {
      const page = await open(width, height, true, theme)
      try {
        const m = await metrics(page)
        assert.ok(m.overflow <= 0, `scroll horizontal ${m.overflow}px`)
        assert.equal(m.fit, "cover", "la imagen cubre la caja (nunca contain con bandas)")
        assert.ok(m.paintedFill >= 0.98, `imagen pintada en ${Math.round(m.paintedFill * 100)}% del ancho del banner`)
        assert.ok(Math.abs(m.media - m.banner) <= 3, "la caja de la imagen ocupa todo el ancho del banner")
        assert.ok(m.crop <= 0.25, `recorte moderado (${Math.round(m.crop * 100)}%)`)
        if (width >= 1024) assert.ok(m.height <= Math.max(0.6 * height, 290), `alto razonable en desktop (${Math.round(m.height)}px)`)
        if (SHOTS) await page.screenshot({ path: `${SHOTS}/category-banner-${theme}-${width}x${height}.png` })
      } finally { await page.close() }
    })
  }
}

test("sin banner: no se reserva un recuadro vacío", async () => {
  for (const [width, height] of [[390, 844], [1366, 657], [1920, 1080]] as const) {
    const page = await open(width, height, false)
    try {
      const layout = await page.evaluate(() => {
        const banner = document.querySelector(".beyonix-hero-banner")!.getBoundingClientRect()
        const search = document.querySelector(".global-search-wrapper")!.getBoundingClientRect()
        return { media: document.querySelectorAll("[data-banner-media]").length, gapAboveSearch: search.top - banner.top }
      })
      assert.equal(layout.media, 0)
      assert.ok(layout.gapAboveSearch <= 90, `${width}: el buscador arranca arriba, sólo con el padding normal (${Math.round(layout.gapAboveSearch)}px)`)
    } finally { await page.close() }
  }
})
