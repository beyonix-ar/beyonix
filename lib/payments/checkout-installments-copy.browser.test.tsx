import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import postcss from "postcss"
import tailwindcss from "@tailwindcss/postcss"
import { build, type Plugin } from "esbuild"
import { chromium, type Browser, type Page } from "playwright-core"

// Opción de cuotas del checkout con los componentes REALES que la dibujan
// (CheckoutPaymentOptionCard + CheckoutPaymentMediaPanel), alimentados por el
// motor REAL de precios del checkout (calculateMercadoPagoCheckoutPricing) y
// el copy compartido, conectados igual que app/checkout/page.tsx (ese
// cableado lo fijan los contratos de components/checkout/*.test.ts).
// cover_costs: total financiado > contado -> "Cuotas con Mercado Pago",
// "6 cuotas de $X" y el total financiado; nunca "sin interés".

const stubs: Plugin = {
  name: "checkout-installments-copy-stubs",
  setup(pluginBuild) {
    const modules: Record<string, string> = {
      "@/lib/payments/use-payment-method-logos": `export function usePaymentMethodLogos() { return [] }`,
    }
    for (const name of Object.keys(modules)) {
      pluginBuild.onResolve({ filter: new RegExp(`^${name.replace(/[/.]/g, "\\$&")}$`) }, () => ({ path: name, namespace: "stub" }))
    }
    pluginBuild.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({ contents: modules[args.path], loader: "js", resolveDir: process.cwd() }))
  },
}

const ENTRY = `
import { useState } from "react"
import { createRoot } from "react-dom/client"
import { CreditCard, Wallet } from "lucide-react"
import { CheckoutPaymentMediaPanel, CheckoutPaymentOptionCard } from "@/components/checkout/checkout-payment-media-panel"
import { calculateMercadoPagoCheckoutPricing } from "@/lib/pricing/checkout-pricing"
import { getCheckoutInstallmentsLabels, getCheckoutInstallmentsOptionCopy } from "@/lib/pricing/financed-pricing"

const FINANCING = { baseProcessingPercent: 3.46, ivaPercent: 21, surchargePercentByCount: { 2: 7.79, 3: 10.49, 6: 18.69 } }
// Referencia de Mercado Pago: 2/3 cuotas desde $35.000 y 6 desde $60.000 (sobre lo que se cobra).
const lookup = (amount) => (amount >= 60000 ? [2, 3, 6] : amount >= 35000 ? [2, 3] : [])
// Mismo formateador que app/checkout/page.tsx.
const formatPrice = (price) => new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", minimumFractionDigits: 0 }).format(price)

function Checkout({ policy, price }) {
  const [option, setOption] = useState("mercadopago_installments")
  const pricing = calculateMercadoPagoCheckoutPricing({
    lines: [{ productId: 1, variantId: 1, conditionedStockId: null, quantity: 1, unitPrice: price }],
    shippingCharged: 0,
    storeBenefitPercent: null,
    requestedCustomerCredit: 0,
    settings: { installmentsFinancing: FINANCING, transferDiscountPercent: 10, nationalTaxesIncidencePercent: 21, financedPricePolicy: policy },
    interestFreeLookup: lookup,
  })
  const financedPreviewQuote = pricing.financed
  const installmentsLabels = getCheckoutInstallmentsLabels(policy)
  const installmentsOptionCopy = getCheckoutInstallmentsOptionCopy(
    pricing.installmentPlans.map((plan) => plan.count),
    policy,
    financedPreviewQuote?.externalAmountDue ?? null,
  )
  return (
    <section data-checkout-case={policy + "-" + price} className="checkout-payment-layout grid min-w-0 gap-3 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
      <fieldset className="grid gap-2 min-w-0" data-payment-options>
        <CheckoutPaymentOptionCard option="mercadopago_cash" checked={option === "mercadopago_cash"} onSelect={setOption} icon={Wallet} title="Mercado Pago · 1 pago" description="Precio contado" amountLabel="Total" amount={formatPrice(pricing.cash.externalAmountDue)} />
        {installmentsOptionCopy && financedPreviewQuote ? (
          <CheckoutPaymentOptionCard
            option="mercadopago_installments"
            checked={option === "mercadopago_installments"}
            onSelect={setOption}
            icon={CreditCard}
            title={installmentsLabels.optionTitle}
            description={installmentsOptionCopy.headline}
            badge={<span className="checkout-badge checkout-badge-info">{installmentsLabels.financedBadge}</span>}
            highlight={<span data-installments-available>{installmentsOptionCopy.available}</span>}
            amountLabel={installmentsLabels.financedTotalLabel}
            amount={formatPrice(financedPreviewQuote.externalAmountDue)}
          />
        ) : null}
      </fieldset>
      <CheckoutPaymentMediaPanel option={option} installmentBrands={["visa", "master"]} installmentsLabels={installmentsLabels} transferDiscountPercent={10} />
    </section>
  )
}

const CASES = [["cover_costs", 53900], ["cover_costs", 58900], ["same_as_cash", 53900], ["same_as_cash", 66000]]
createRoot(document.getElementById("root")).render(
  <main className="checkout-page" data-checkout-step="3" style={{ maxWidth: 760, margin: "0 auto", padding: 16 }}>
    {CASES.map(([policy, price]) => <div key={policy + price} style={{ marginBottom: 24 }}><Checkout policy={policy} price={price} /></div>)}
  </main>,
)
`

let browser: Browser
let css: string
let bundle: string

test.before(async () => {
  css = (await postcss([tailwindcss({ base: process.cwd() })]).process(readFileSync("app/globals.css", "utf8"), { from: "app/globals.css" })).css
  const result = await build({
    stdin: { contents: ENTRY, resolveDir: process.cwd(), loader: "tsx", sourcefile: "checkout-installments-copy-fixture.tsx" },
    bundle: true, format: "iife", write: false, jsx: "automatic", plugins: [stubs],
    alias: { "@": process.cwd() }, define: { "process.env.NODE_ENV": '"production"' }, logLevel: "error",
  })
  bundle = result.outputFiles[0].text
  browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chrome", headless: true })
})

test.after(async () => { await browser?.close() })

async function open(theme: "dark" | "light", width: number): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height: 1600 } })
  await page.setContent(`<!doctype html><html lang="es" data-account-theme="${theme}" data-account-scope><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-beyonix-page"><div id="root"></div><script>window.process={env:{NODE_ENV:"production"}}</script><script>${bundle}</script></body></html>`)
  await page.locator("[data-checkout-case]").first().waitFor()
  return page
}

const text = async (page: Page, selector: string) => (await page.locator(selector).innerText()).replace(/ /g, " ")

for (const [theme, width] of [["dark", 1280], ["light", 1280], ["dark", 390], ["light", 390]] as const) {
  test(`A. cover_costs (${theme} ${width}px): "Cuotas con Mercado Pago", cuota y total financiado; nunca "sin interés"`, async () => {
    const page = await open(theme, width)
    try {
      for (const [price, installment, total, cash] of [[53900, "$12.306", "73.836", "53.900"], [58900, "$13.448", "80.688", "58.900"]] as const) {
        const scope = `[data-checkout-case="cover_costs-${price}"]`
        const option = await text(page, `${scope} [data-payment-option="mercadopago_installments"]`)
        assert.match(option, /Cuotas con Mercado Pago/)
        assert.match(option, new RegExp(`6 cuotas de \\${installment}`))
        assert.match(option, new RegExp(`Total financiado[\\s\\S]*\\$ ?${total.replace(".", "\\.")}`))
        assert.match(option, /Precio financiado/)
        assert.match(option, /Disponibles: 2, 3 y 6 cuotas/)
        assert.match(await text(page, `${scope} [data-payment-option="mercadopago_cash"]`), new RegExp(cash.replace(".", "\\.")))
        assert.equal((await text(page, `${scope} [data-payment-media] h3`)).trim(), "Cuotas con Mercado Pago")
        assert.doesNotMatch(await text(page, scope), /sin interés/i, `checkout $${price}`)
      }
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "sin scroll horizontal")
    } finally { await page.close() }
  })
}

test("B. same_as_cash: total en cuotas = contado; \"sin interés\" sólo con el plan que Mercado Pago confirma para ese total", async () => {
  const page = await open("dark", 1280)
  try {
    const below = await text(page, '[data-checkout-case="same_as_cash-53900"] [data-payment-option="mercadopago_installments"]')
    assert.match(below, /Mercado Pago · Cuotas sin interés/)
    assert.match(below, /Hasta 3 cuotas sin interés/, "$53.900 no alcanza $60.000: sólo hasta 3")
    assert.match(below, /Total \(igual al contado\)[\s\S]*53\.900/)
    assert.doesNotMatch(below, /Total financiado/)

    const above = await text(page, '[data-checkout-case="same_as_cash-66000"] [data-payment-option="mercadopago_installments"]')
    assert.match(above, /Hasta 6 cuotas sin interés/)
    assert.match(above, /66\.000/)
    assert.equal((await text(page, '[data-checkout-case="same_as_cash-66000"] [data-payment-media] h3')).trim(), "Mercado Pago · Cuotas sin interés")
  } finally { await page.close() }
})
