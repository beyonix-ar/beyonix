import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { build, type Plugin } from "esbuild"
import { chromium, type Browser, type Page } from "playwright-core"
import postcss from "postcss"
import tailwindcss from "@tailwindcss/postcss"

// Comunicación de cuotas en la tarjeta REAL (SharedProductCard → Home,
// populares, categorías) y en el bloque de compra de la ficha, con la oferta
// pública armada por el helper real. Con `cover_costs` el total en cuotas es
// mayor que el contado: nunca "Hasta 6 cuotas sin interés" junto a $53.900.

const FINANCING = { baseProcessingPercent: 3.46, ivaPercent: 21, surchargePercentByCount: { 2: 7.79, 3: 10.49, 6: 18.69 } }
const MP_MINIMUMS = { 2: 35_000, 3: 35_000, 6: 60_000 }

const product = (id: number, precio: number) => ({
  id, nombre: `PRODUCTO ${id}`, slug: `producto-${id}`, precio, precio_anterior: null, stock: 5, activo: true,
  imagen_principal: null, categoria_id: 1, created_at: "2026-10-09T00:00:00.000Z",
  producto_variantes: [{ id: id * 10, producto_id: id, nombre: "NEGRO", sku: null, color_hex: "#000000", stock: 5, imagenes: [], activo: true, orden: 1, created_at: "2026-10-09T00:00:00.000Z" }],
})
const PRODUCTS = [product(1, 53_900), product(2, 58_900), product(3, 66_000)]

const modules: Record<string, string> = {
  "@/context/cart-context": `export function useCart() { return { getQuantity() { return 0 }, increaseQuantity() {}, decreaseQuantity() {} } }`,
  "@/context/auth-context": `export function useAuth() { return { user: null } }`,
  "@/lib/supabase/client": `export const supabase = {}`,
  "@/hooks/use-site-settings": `import { buildPublicInterestFreeOffer } from "@/lib/pricing/interest-free-communication";
    const now = new Date();
    const interestFreeOffer = buildPublicInterestFreeOffer({
      reference: { checkedAt: now.toISOString(), minimumAmountByCount: ${JSON.stringify(MP_MINIMUMS)}, brandsByCount: { 2: ["visa", "master"], 3: ["visa", "master"], 6: ["visa", "master"] }, maxProbedAmount: 2000000 },
      lastAttemptAt: now.toISOString(), lastError: null, lastFailure: null,
    }, { enabled: true }, now);
    export function useSiteSettings() {
      return { pricing: { transferDiscountPercent: 10, nationalTaxesIncidencePercent: 21 }, interestFreeOffer, installmentsFinancing: ${JSON.stringify(FINANCING)}, financedPricePolicy: window.POLICY };
    }`,
  "next/image": `import { createElement } from "react"; export default function Image({ src, alt, fill, priority, sizes, ...props }) { return createElement("img", { ...props, src: String(src), alt }) }`,
  "next/link": `import { createElement } from "react"; export default function Link({ href, prefetch, ...props }) { return createElement("a", { ...props, href: String(href) }) }`,
}

const stubs: Plugin = {
  name: "installments-communication-fixture",
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
        import SharedProductCard from "@/components/products/shared/shared-product-card";
        import { ProductPurchaseBox } from "@/components/products/product-purchase-box";
        import { HeroSection } from "@/components/hero-section";
        import { getProductInterestFreeMessage } from "@/lib/pricing/interest-free-communication";
        import { useSiteSettings } from "@/hooks/use-site-settings";
        const products = ${JSON.stringify(PRODUCTS)};
        function Box({ product }) {
          // Mismo cálculo que ProductDetailsPanel (ficha y modal).
          const { interestFreeOffer, installmentsFinancing, financedPricePolicy } = useSiteSettings();
          const message = getProductInterestFreeMessage(interestFreeOffer, product.precio, installmentsFinancing, financedPricePolicy);
          return <section data-box={product.id}><ProductPurchaseBox price={product.precio} interestFreeText={message?.text ?? null} financedTotalText={message?.financedTotalText ?? null} onAddToCart={() => {}} onDecreaseCart={() => {}} onRemoveFromCart={() => {}} onViewCart={() => {}} /></section>;
        }
        createRoot(document.getElementById("root")).render(<>
          <div data-hero><HeroSection featuredProduct={products[0]} onOpenPreview={() => {}} /></div>
          <div className="grid gap-6 p-4 sm:grid-cols-3">
            {products.map((product) => <div key={product.id} data-card={product.id} className="max-w-xs"><SharedProductCard product={product} showFavorite={false} showRating={false} /></div>)}
            {products.map((product) => <Box key={"box" + product.id} product={product} />)}
          </div>
        </>);`,
      resolveDir: process.cwd(), loader: "tsx", sourcefile: "installments-communication-fixture.tsx",
    },
    bundle: true, platform: "browser", format: "iife", write: false,
    alias: { "@": process.cwd() }, jsx: "automatic", plugins: [stubs],
    define: { "process.env.NODE_ENV": '"production"' },
  })
  bundle = result.outputFiles[0].text
  browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chrome", headless: true })
})

test.after(async () => { await browser?.close() })

async function open(policy: "cover_costs" | "same_as_cash", width = 1280, theme: "dark" | "light" = "dark") {
  const page = await browser.newPage({ viewport: { width, height: 1400 } })
  const html = `<!doctype html><html lang="es" data-account-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body class="bg-beyonix-page text-white"><div id="root"></div><script>window.process = { env: { NODE_ENV: "production" } }; window.POLICY = ${JSON.stringify(policy)}</script><script>${bundle}</script></body></html>`
  await page.route("http://beyonix.test/**", (route) => route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html }))
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto("http://beyonix.test/")
  try { await page.locator("[data-card='1'] [data-installments-badge]").waitFor({ timeout: 10_000 }) }
  catch (error) { await page.close(); throw new Error(`No renderizó: ${errors.join(" | ") || String(error)}`) }
  return page
}

const nbsp = (value: string | null) => value?.replace(/ /g, " ").trim() ?? null
const badge = (page: Page, id: number) => page.locator(`[data-card='${id}'] [data-installments-badge]`)

/** Visible sin hover: con caja propia, opaco y dentro de su contenedor (card/hero). */
async function visibleInside(page: Page, selector: string, container: string) {
  const locator = page.locator(selector)
  assert.ok(await locator.isVisible(), `${selector} visible`)
  return locator.evaluate((element, containerSelector) => {
    const rect = element.getBoundingClientRect()
    const box = element.closest(containerSelector)!.getBoundingClientRect()
    const style = getComputedStyle(element)
    return {
      height: rect.height,
      inside: rect.left >= box.left - 0.5 && rect.right <= box.right + 0.5,
      shown: style.visibility === "visible" && Number(style.opacity) > 0 && rect.width > 0,
    }
  }, container)
}

for (const [width, theme] of [[1280, "dark"], [1280, "light"], [390, "dark"], [390, "light"]] as const) {
  test(`cover_costs a ${width}px (${theme}): card, hero y ficha muestran "6 cuotas de $X" y el total financiado visible sin hover; nunca "sin interés"`, async () => {
    const page = await open("cover_costs", width, theme)
    try {
      await page.mouse.move(0, 0)
      for (const [id, installment, total] of [[1, "$12.306", "$73.836"], [2, "$13.448", "$80.688"]] as const) {
        const card = page.locator(`[data-card='${id}']`)
        assert.doesNotMatch(nbsp(await card.textContent())!, /sin interés/, `card ${id}`)
        assert.equal(nbsp(await badge(page, id).textContent()), `6 cuotas de ${installment}`)
        assert.equal(nbsp(await card.locator("[data-installments-total]").textContent()), `Total financiado: ${total}`)
        const totalLine = await visibleInside(page, `[data-card='${id}'] [data-installments-total]`, "[data-card]")
        assert.ok(totalLine.shown && totalLine.inside, `total financiado visible en la card ${id}`)
        assert.ok(totalLine.height <= 16, `total compacto en una línea (${totalLine.height}px)`)

        const box = page.locator(`[data-box='${id}']`)
        assert.doesNotMatch(nbsp(await box.textContent())!, /sin interés/, `ficha ${id}`)
        assert.equal(nbsp(await box.locator("[data-financed-total]").textContent()), `Total financiado: ${total}`)

        // Badge compacto: una sola línea, dentro de la tarjeta.
        const layout = await visibleInside(page, `[data-card='${id}'] [data-installments-badge]`, "[data-card]")
        assert.ok(layout.height <= 32, `badge en una línea (${layout.height}px)`)
        assert.ok(layout.inside, "badge dentro de la tarjeta")
      }

      // Hero de Home: mismo mensaje que la tarjeta del mismo producto ($53.900).
      const hero = page.locator("[data-hero]")
      assert.doesNotMatch(nbsp(await hero.textContent())!, /sin interés/, "hero")
      assert.equal(nbsp(await hero.locator("[data-installments-badge]").textContent()), "6 cuotas de $12.306")
      assert.equal(nbsp(await hero.locator("[data-installments-total]").textContent()), "Total financiado: $73.836")
      const heroTotal = await visibleInside(page, "[data-hero] [data-installments-total]", "[data-hero]")
      assert.ok(heroTotal.shown && heroTotal.inside, "total financiado visible en el hero")

      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "sin scroll horizontal")
    } finally { await page.close() }
  })
}

test("same_as_cash: total en cuotas = contado; \"sin interés\" sólo si el contado alcanza el mínimo", async () => {
  const page = await open("same_as_cash")
  try {
    // $53.900 / $58.900 no alcanzan $60.000 de 6 cuotas: sólo 3 (mínimo $35.000).
    assert.equal(nbsp(await badge(page, 1).textContent()), "Hasta 3 cuotas sin interés")
    assert.equal(nbsp(await badge(page, 2).textContent()), "Hasta 3 cuotas sin interés")
    assert.equal(nbsp(await badge(page, 3).textContent()), "Hasta 6 cuotas sin interés")
    // Sin total financiado distinto del contado: no hay línea de total en card, hero ni ficha.
    assert.equal(await page.locator("[data-card] [data-installments-total]").count(), 0)
    assert.equal(nbsp(await page.locator("[data-hero] [data-installments-badge]").textContent()), "Hasta 3 cuotas sin interés")
    assert.equal(await page.locator("[data-hero] [data-installments-total]").count(), 0)
    assert.equal(await page.locator("[data-box='3'] [data-financed-total]").count(), 0)
  } finally { await page.close() }
})
