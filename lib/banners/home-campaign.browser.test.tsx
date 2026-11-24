import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { build, type Plugin } from "esbuild"
import { chromium, type Browser, type Page } from "playwright-core"
import postcss from "postcss"
import tailwindcss from "@tailwindcss/postcss"

// HOME con los componentes REALES (useHomeCampaign + HomeCampaignBanner +
// HeroSection, igual que HomeClient) y next/image real (getImageProps):
// campaña vigente, sin campaña, escritorio y celular, temas claro y oscuro,
// enlaces seguros y cambios de vigencia con la página abierta (reloj simulado).

const BUCKET = "https://eqxoupwuijobktxkmagr.supabase.co/storage/v1/object/public/site-banners/"
// 26/12 23:50 en Argentina (UTC-3); la campaña es "visible hasta el 26/12 23:59" → fin 27/12 00:00 (03:00 UTC).
const SERVER_NOW = "2026-12-27T02:50:00.000Z"
const banner = (overrides: Record<string, unknown> = {}) => ({
  id: "navidad", placement: "home", image_url: `${BUCKET}home/navidad.webp`, mobile_image_url: `${BUCKET}home/mobile/navidad.webp`,
  alt_text: "Navidad BEYONIX: hasta 30% off", destination_url: "/productos?categoria=audio", active: true, sort_order: 0,
  ends_at: "2026-12-27T03:00:00.000Z", updated_at: null, ...overrides,
})

const modules: Record<string, string> = {
  "@/hooks/use-site-settings": `export function useSiteSettings() { return { interestFreeOffer: null, installmentsFinancing: null, financedPricePolicy: null } }`,
  "next/link": `import { createElement } from "react"; export default function Link({ href, prefetch, ...props }) { return createElement("a", { ...props, href: String(href) }) }`,
}

const stubs: Plugin = {
  name: "home-campaign-fixture",
  setup(pluginBuild) {
    for (const name of Object.keys(modules)) {
      pluginBuild.onResolve({ filter: new RegExp(`^${name.replace(/[/.]/g, "\\$&")}$`) }, () => ({ path: name, namespace: "stub" }))
    }
    pluginBuild.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({ contents: modules[args.path], loader: "js", resolveDir: process.cwd() }))
  },
}

let browser: Browser
let bundle: string
let css: string

test.before(async () => {
  css = (await postcss([tailwindcss({ base: process.cwd() })]).process(readFileSync("app/globals.css", "utf8"), { from: "app/globals.css" })).css
  const result = await build({
    stdin: {
      contents: `import React from "react"; import { createRoot } from "react-dom/client";
        import { HeroSection } from "@/components/hero-section";
        import { HomeCampaignBanner, useHomeCampaign } from "@/components/home-campaign-banner";
        window.__fetches = 0;
        window.fetch = async (url) => {
          window.__fetches += 1;
          window.__fetchUrls = [...(window.__fetchUrls || []), String(url)];
          const next = window.__API.length > 1 ? window.__API.shift() : window.__API[0];
          if (!next || next.fail) return new Response("{}", { status: 503 });
          return Response.json(next);
        };
        function Home() {
          const campaign = useHomeCampaign(window.__INITIAL).banner;
          return <section id="inicio">
            {campaign ? <HomeCampaignBanner key={campaign.id} banner={campaign} /> : null}
            <HeroSection featuredProduct={null} onOpenPreview={() => {}} compact={Boolean(campaign)} />
          </section>;
        }
        createRoot(document.getElementById("root")).render(<Home />);`,
      resolveDir: process.cwd(), loader: "tsx", sourcefile: "home-campaign-fixture.tsx",
    },
    bundle: true, platform: "browser", format: "iife", write: false,
    alias: { "@": process.cwd() }, jsx: "automatic", plugins: [stubs],
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "error",
  })
  bundle = result.outputFiles[0].text
  browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chrome", headless: true })
})

test.after(async () => { await browser?.close() })


// Capturas opcionales (HOME_CAMPAIGN_SCREENSHOTS=dir): arte de prueba con la proporción de cada imagen.
const SCREENSHOTS = process.env.HOME_CAMPAIGN_SCREENSHOTS
const artwork = (mobile: boolean) => {
  const [width, height] = mobile ? [960, 640] : [1920, 480]
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#112A43"/><rect x="0" y="${height - 8}" width="100%" height="8" fill="#38bdf8"/><text x="${mobile ? 60 : 160}" y="${height / 2}" fill="#fff" font-family="Montserrat, Arial" font-weight="700" font-size="${mobile ? 64 : 72}">Navidad BEYONIX</text><text x="${mobile ? 60 : 160}" y="${height / 2 + (mobile ? 80 : 70)}" fill="#cbd5e1" font-family="Montserrat, Arial" font-size="${mobile ? 40 : 36}">Hasta 30% off · ${width} × ${height}</text></svg>`
}

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64")

type Initial = { banner: ReturnType<typeof banner> | null; nextChangeAt: string | null; serverNow: string }
async function open(initial: Initial, { width = 1280, theme = "dark", api = [] as unknown[], clockAt = initial.serverNow } = {}) {
  const page = await browser.newPage({ viewport: { width, height: 900 } })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()) })
  await page.clock.install({ time: new Date(clockAt) })
  const html = `<!doctype html><html lang="es" data-account-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body class="bg-beyonix-page text-white"><div id="root"></div><script>window.process = { env: { NODE_ENV: "production" } }; window.__INITIAL = ${JSON.stringify(initial)}; window.__API = ${JSON.stringify(api)};</script><script>${bundle}</script></body></html>`
  await page.route("http://beyonix.test/**", (route) => {
    const url = route.request().url()
    if (url.startsWith("http://beyonix.test/_next/image")) {
      return SCREENSHOTS
        ? route.fulfill({ status: 200, contentType: "image/svg+xml", body: artwork(decodeURIComponent(url).includes("/mobile/")) })
        : route.fulfill({ status: 200, contentType: "image/png", body: PNG })
    }
    return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html })
  })
  await page.goto("http://beyonix.test/")
  await page.locator(".beyonix-featured-product-card").waitFor({ timeout: 10_000 })
  return { page, errors }
}

const box = (page: Page, selector: string) => page.locator(selector).evaluate((element) => {
  const rect = element.getBoundingClientRect()
  return { top: rect.top, width: rect.width, height: rect.height }
})
const fetches = (page: Page) => page.evaluate(() => (window as unknown as { __fetches: number }).__fetches)

for (const theme of ["dark", "light"] as const) {
  test(`${theme} 1280px: campaña vigente panorámica (4:1) debajo del header, con enlace interno, imagen optimizada y Hero compacto`, async () => {
    const { page, errors } = await open({ banner: banner(), nextChangeAt: "2026-12-27T03:00:00.000Z", serverNow: SERVER_NOW }, { theme })
    try {
      const section = page.locator("[data-home-campaign='navidad']")
      assert.equal(await section.count(), 1)
      const frame = await box(page, "[data-home-campaign] > div")
      assert.ok(Math.abs(frame.width / frame.height - 4) < 0.05, `4:1 (${frame.width}×${frame.height})`)
      assert.ok(frame.top >= 70 && frame.top <= 82, `deja el espacio del header (${frame.top}px)`)
      const link = section.getByRole("link", { name: "Navidad BEYONIX: hasta 30% off" })
      assert.equal(await link.getAttribute("href"), "/productos?categoria=audio")
      assert.equal(await link.getAttribute("target"), null, "interno: misma pestaña")
      const image = section.locator("img[data-home-campaign-image]")
      assert.equal(await image.getAttribute("fetchpriority"), "high")
      assert.equal(await image.getAttribute("loading"), "eager")
      assert.equal(await image.getAttribute("alt"), "Navidad BEYONIX: hasta 30% off")
      assert.match(await image.getAttribute("srcset") ?? "", /\/_next\/image\?url=.*navidad\.webp&w=1920/)
      await page.waitForFunction(() => (document.querySelector("img[data-home-campaign-image]") as HTMLImageElement | null)?.complete === true)
      assert.equal(await page.locator("[data-hero-compact]").count(), 1, "el Hero cede el protagonismo")
      const hero = await box(page, "[data-hero-compact]")
      assert.ok(hero.top >= frame.top + frame.height - 1, "el Hero empieza debajo del banner")
      assert.equal(await fetches(page), 0, "página recién renderizada: no consulta de más")
      if (SCREENSHOTS) await page.screenshot({ path: `${SCREENSHOTS}/home-campaign-${theme}-1280.png` })
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "sin desborde horizontal")
      assert.deepEqual(errors, [])
    } finally { await page.close() }
  })
}

test("celular 390px: usa la imagen para celular (3:2); sin ella, la de escritorio sin recortar (4:1)", async () => {
  for (const [mobileImage, ratio, expectedSrc] of [[`${BUCKET}home/mobile/navidad.webp`, 1.5, "mobile%2Fnavidad.webp"], [null, 4, "home%2Fnavidad.webp"]] as const) {
    const { page, errors } = await open({ banner: banner({ mobile_image_url: mobileImage }), nextChangeAt: null, serverNow: SERVER_NOW }, { width: 390, theme: "light" })
    try {
      const frame = await box(page, "[data-home-campaign] > div")
      assert.ok(Math.abs(frame.width / frame.height - ratio) < 0.05, `${ratio}:1 (${frame.width}×${frame.height})`)
      assert.ok(frame.width >= 389, "ancho completo")
      if (SCREENSHOTS) await page.screenshot({ path: `${SCREENSHOTS}/home-campaign-390-${mobileImage ? "mobile" : "desktop-image"}.png` })
      await page.waitForFunction(() => Boolean((document.querySelector("img[data-home-campaign-image]") as HTMLImageElement | null)?.currentSrc))
      const currentSrc = await page.locator("img[data-home-campaign-image]").evaluate((image) => (image as HTMLImageElement).currentSrc)
      assert.ok(currentSrc.includes(expectedSrc), currentSrc)
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "sin desborde horizontal")
      assert.deepEqual(errors, [])
    } finally { await page.close() }
  }
})

test("sin campaña: Home de siempre, sin espacio reservado ni placeholder; el Hero conserva su altura", async () => {
  for (const width of [1280, 390]) {
    const { page, errors } = await open({ banner: null, nextChangeAt: null, serverNow: SERVER_NOW }, { width })
    try {
      assert.equal(await page.locator("[data-home-campaign]").count(), 0)
      assert.equal(await page.locator("[data-hero-compact]").count(), 0)
      const hero = await box(page, "#inicio > section")
      assert.equal(hero.top, 0, "nada encima del Hero")
      assert.ok(hero.height >= 480, `altura de primera pantalla (${hero.height}px)`)
      assert.equal(await fetches(page), 0)
      assert.deepEqual(errors, [])
    } finally { await page.close() }
  }
})

test("enlace externo admitido: pestaña nueva con noopener noreferrer; sin enlace: imagen sin link", async () => {
  let { page } = await open({ banner: banner({ destination_url: "https://www.instagram.com/beyonix" }), nextChangeAt: null, serverNow: SERVER_NOW })
  try {
    const link = page.locator("[data-home-campaign] a")
    assert.equal(await link.getAttribute("href"), "https://www.instagram.com/beyonix")
    assert.equal(await link.getAttribute("target"), "_blank")
    assert.equal(await link.getAttribute("rel"), "noopener noreferrer")
  } finally { await page.close() }
  ;({ page } = await open({ banner: banner({ destination_url: null }), nextChangeAt: null, serverNow: SERVER_NOW }))
  try {
    assert.equal(await page.locator("[data-home-campaign] a").count(), 0)
    assert.equal(await page.locator("[data-home-campaign] img").count(), 1)
  } finally { await page.close() }
})

// 26/12 23:59:30 en Argentina: a 30 s del fin de la campaña de Navidad.
const BEFORE_END = "2026-12-27T02:59:30.000Z"

test("página abierta: la campaña termina a la hora exacta (27/12 00:00 Argentina) sin recargar, y el Hero recupera su altura", async () => {
  const { page, errors } = await open({ banner: banner(), nextChangeAt: "2026-12-27T03:00:00.000Z", serverNow: BEFORE_END }, {
    api: [{ banner: null, nextChangeAt: null, serverNow: "2026-12-27T03:00:01.000Z" }],
  })
  try {
    await page.clock.fastForward("00:20") // 23:59:50: sigue, sin consultar.
    assert.equal(await page.locator("[data-home-campaign]").count(), 1)
    assert.equal(await fetches(page), 0)
    await page.clock.fastForward("00:15") // 00:00:05 del 27/12.
    await page.locator("[data-home-campaign]").waitFor({ state: "detached", timeout: 5000 })
    assert.equal(await page.locator("[data-hero-compact]").count(), 0)
    assert.deepEqual(await page.evaluate(() => (window as unknown as { __fetchUrls: string[] }).__fetchUrls), ["/api/store/banners?placement=home"])
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("página abierta: una campaña programada aparece sola al empezar; si el servidor no responde al terminar, igual se oculta", async () => {
  let { page } = await open({ banner: null, nextChangeAt: "2026-12-27T03:00:00.000Z", serverNow: BEFORE_END }, {
    api: [{ banner: banner({ id: "anio-nuevo", ends_at: null }), nextChangeAt: null, serverNow: "2026-12-27T03:00:01.000Z" }],
  })
  try {
    await page.clock.fastForward("00:35")
    await page.locator("[data-home-campaign='anio-nuevo']").waitFor({ timeout: 5000 })
    assert.equal(await page.locator("[data-hero-compact]").count(), 1)
  } finally { await page.close() }

  ;({ page } = await open({ banner: banner(), nextChangeAt: "2026-12-27T03:00:00.000Z", serverNow: BEFORE_END }, { api: [{ fail: true }] }))
  try {
    await page.clock.fastForward("00:35")
    await page.locator("[data-home-campaign]").waitFor({ state: "detached", timeout: 5000 })
  } finally { await page.close() }

  // Falla al EMPEZAR otra: no se inventa nada (sigue la vigente).
  ;({ page } = await open({ banner: banner({ ends_at: null }), nextChangeAt: "2026-12-27T03:00:00.000Z", serverNow: BEFORE_END }, { api: [{ fail: true }] }))
  try {
    await page.clock.fastForward("00:35")
    await page.waitForFunction(() => (window as unknown as { __fetches: number }).__fetches >= 1)
    assert.equal(await page.locator("[data-home-campaign='navidad']").count(), 1)
  } finally { await page.close() }
})

// Admin cambia una campaña PERMANENTE (sin límites programados): el Home abierto se entera solo en a lo sumo 1 minuto.
const permanent = (overrides: Record<string, unknown> = {}) => banner({ id: "permanente", ends_at: null, ...overrides })
const afterChange = (value: ReturnType<typeof banner> | null) => ({ banner: value, nextChangeAt: null, serverNow: "2026-12-27T02:51:00.000Z" })

test("página abierta: una campaña permanente desactivada o eliminada desaparece sola en menos de 1 minuto", async () => {
  const { page, errors } = await open({ banner: permanent(), nextChangeAt: null, serverNow: SERVER_NOW }, { api: [afterChange(null)] })
  try {
    await page.clock.fastForward("00:30")
    assert.equal(await page.locator("[data-home-campaign='permanente']").count(), 1, "todavía no tocaba revisar")
    assert.equal(await fetches(page), 0)
    await page.clock.fastForward("00:31")
    await page.locator("[data-home-campaign]").waitFor({ state: "detached", timeout: 5000 })
    assert.equal(await fetches(page), 1, "una sola consulta")
    assert.equal(await page.locator("[data-hero-compact]").count(), 0)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("página abierta: una campaña editada (otra imagen) o reemplazada por otra se actualiza sola", async () => {
  const { page, errors } = await open({ banner: permanent(), nextChangeAt: null, serverNow: SERVER_NOW }, {
    api: [afterChange(permanent({ image_url: `${BUCKET}home/navidad-v2.webp`, alt_text: "Navidad: envío gratis" })), afterChange(banner({ id: "reyes", ends_at: null }))],
  })
  try {
    await page.clock.fastForward("01:01")
    await page.getByRole("link", { name: "Navidad: envío gratis" }).waitFor({ timeout: 5000 })
    assert.match(await page.locator("img[data-home-campaign-image]").getAttribute("srcset") ?? "", /navidad-v2\.webp/)
    await page.clock.fastForward("01:01")
    await page.locator("[data-home-campaign='reyes']").waitFor({ timeout: 5000 })
    assert.equal(await page.locator("[data-home-campaign='permanente']").count(), 0)
    assert.equal(await fetches(page), 2)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("pestaña oculta: no consulta; al volver revisa una sola vez y aplica el cambio", async () => {
  const { page, errors } = await open({ banner: permanent(), nextChangeAt: null, serverNow: SERVER_NOW }, { api: [afterChange(null)] })
  try {
    // Script en texto: tsx agrega un helper a las funciones con nombre que el navegador no tiene.
    const setVisibility = (state: "hidden" | "visible", times = 1) => page.evaluate(`
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "${state}" });
      for (let index = 0; index < ${times}; index += 1) document.dispatchEvent(new Event("visibilitychange"));
    `)
    await setVisibility("hidden")
    await page.clock.fastForward("05:00")
    assert.equal(await fetches(page), 0, "en segundo plano no consulta")
    assert.equal(await page.locator("[data-home-campaign='permanente']").count(), 1)
    // Volver varias veces seguidas no duplica la consulta.
    await setVisibility("visible", 3)
    await page.locator("[data-home-campaign]").waitFor({ state: "detached", timeout: 5000 })
    assert.equal(await fetches(page), 1)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})


test("render viejo (pestaña restaurada o caché tras horas): se confirma con el servidor al cargar y deja de mostrar la vencida", async () => {
  const { page, errors } = await open({ banner: banner(), nextChangeAt: "2026-12-27T03:00:00.000Z", serverNow: SERVER_NOW }, {
    clockAt: "2026-12-27T12:00:00.000Z",
    api: [{ banner: banner({ id: "permanente", ends_at: null }), nextChangeAt: null, serverNow: "2026-12-27T12:00:00.000Z" }],
  })
  try {
    await page.locator("[data-home-campaign='permanente']").waitFor({ timeout: 5000 })
    assert.equal(await page.locator("[data-home-campaign='navidad']").count(), 0)
    assert.equal(await fetches(page), 1)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
