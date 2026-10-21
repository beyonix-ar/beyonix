import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { build } from "esbuild"
import { chromium } from "playwright-core"
import postcss from "postcss"
import tailwindcss from "@tailwindcss/postcss"

// Confirmar etiqueta Andreani en un navegador real: foco para el lector USB,
// Enter confirma, error claro con otra etiqueta y layout sin desbordes.
test("confirmar etiqueta: lector + Enter, etiqueta equivocada y layout a 390/430/1024/1440 px en light/dark", async () => {
  const bundle = await build({
    stdin: {
      contents: `
        import { createRoot } from "react-dom/client"
        import { OrderPreparationPanel } from "./app/admin/sections/despachos/order-preparation-panel"
        let identified = false
        window.__posts = []
        const detail = () => ({
          order: { id: 11, estado: "pagado", financial_status: "payment_confirmed", payment_status: "approved", invoice_status: "authorized", total: null, shipping_provider: "andreani", envio_proveedor: null, cancelled_at: null, andreani_handed_over_at: null, andreani_handed_over_batch_id: null, created_at: "2026-10-21T01:51:40Z", cliente_nombre: "Lucía Núñez", andreani_envio_id: "API0000174185509", andreani_tracking: "360003136911770", andreani_creation_status: "created" },
          package: { id: 11, order_id: 11, status: "prepared", attempt_number: 1, prepared_at: "2026-10-21T02:46:44Z", prepared_by: null, identification_method: identified ? "andreani" : null, identified_at: identified ? "2026-10-21T15:00:00Z" : null },
          lines: [{ order_item_id: 1, expected_sku: "ENC-01", expected_barcode: "7790000000011", expected_quantity: 1, scanned_quantity: 1, product_id: 1, variant_id: null, conditioned_stock_id: null, name: "Encendedor eléctrico", orderedQuantity: 1, unitPrice: null }],
          saleItems: [{ orderItemId: 1, sku: "ENC-01", productName: "Encendedor eléctrico", variantName: null, orderedQuantity: 1, unitPrice: null }],
          parcels: [], stage: identified ? "ready" : "label", itemCount: 1, expectedUnits: 1, membership: null, batch: null,
          shipping: { costsVisible: false, estimate: null, parcelQuote: null }, hold: null,
          shipment: { created: true, envioId: "API0000174185509", tracking: "360003136911770", creationStatus: "created" },
          adjustments: [], blocked: false, blockReason: null, packingBlocked: false, pendingBeforeDispatch: [], viewer: { costsVisible: false, canShip: false, canForce: false },
        })
        window.fetch = async (_url, init) => {
          if (!init || !init.body) return Response.json(detail())
          const body = JSON.parse(init.body)
          window.__posts.push(body)
          if (String(body.code).replace(/\\s+/g, "") !== "360003136911770") return Response.json({ error: "Esta etiqueta no corresponde al pedido BX-1011." }, { status: 409 })
          const duplicate = identified
          identified = true
          return Response.json({ ...detail(), labelConfirmation: { orderId: 11, code: "360003136911770", duplicate, confirmedAt: "2026-10-21T15:00:00Z" } })
        }
        createRoot(document.getElementById("root")).render(<OrderPreparationPanel orderId={11} />)
      `,
      resolveDir: process.cwd(),
      loader: "tsx",
    },
    bundle: true,
    platform: "browser",
    format: "iife",
    write: false,
    jsx: "automatic",
    alias: { "@": process.cwd() },
    define: { "process.env.NODE_ENV": '"test"' },
    plugins: [{
      name: "supabase-stub",
      setup(builder) {
        builder.onResolve({ filter: /lib\/supabase\/client$/ }, () => ({ path: "supabase-client", namespace: "stub" }))
        builder.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: `
          export const supabase = { auth: { getSession: async () => ({ data: { session: { access_token: "test" } } }) }, channel: () => ({ on() { return this }, subscribe() { return this } }), removeChannel: async () => {} }
          export const createClient = () => supabase
          export const isInvalidRefreshTokenError = () => false
          export const isMissingAuthSessionError = () => false
          export const clearSupabaseBrowserSession = () => {}
          export const getSafeSupabaseSession = async () => null
        `, loader: "js" }))
      },
    }],
  })
  const css = (await postcss([tailwindcss({ base: process.cwd() })]).process(readFileSync("app/globals.css", "utf8"), { from: "app/globals.css" })).css
  const browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chrome", headless: true })
  try {
    const page = await browser.newPage()
    for (const theme of ["light", "dark"]) for (const width of [390, 430, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 })
      await page.setContent(`<html data-admin-theme="${theme}"><head><style>${css}</style></head><body><div class="beyonix-admin-shell min-h-screen text-white"><main class="beyonix-admin-main min-w-0 bg-beyonix-page p-4"><div class="dispatch-surface @container"><div id="root"></div></div></main></div></body></html>`)
      await page.addScriptTag({ content: bundle.outputFiles[0].text })
      const input = page.getByRole("textbox", { name: "Escaneá o escribí el seguimiento" })
      await input.waitFor()
      const label = `${theme} ${width}`
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${label}: sin desborde`)
      assert.ok(await input.evaluate((element) => element === document.activeElement), `${label}: foco automático para el lector`)
      const box = await input.boundingBox()
      assert.ok(box && box.height >= 44 && box.width >= Math.min(300, width - 80), `${label}: input grande`)
      assert.equal(await page.getByRole("button", { name: "Escanear con cámara" }).count(), 0, `${label}: sin cámara`)
      assert.match(await page.locator(".dispatch-order-heading").innerText(), /Falta confirmar etiqueta/i)
      if (process.env.DISPATCH_SCREENSHOTS) await page.screenshot({ path: `${process.env.DISPATCH_SCREENSHOTS}/label-pending-${theme}-${width}.png`, fullPage: true })

      // Etiqueta equivocada: error claro, no avanza.
      await input.pressSequentially("360000000000")
      await input.press("Enter")
      await page.getByText("Esta etiqueta no corresponde al pedido BX-1011.").first().waitFor()
      assert.match(await page.locator(".dispatch-order-heading").innerText(), /Falta confirmar etiqueta/i)
      assert.ok(await input.evaluate((element) => element === document.activeElement), `${label}: el error devuelve el foco`)

      // Lector USB: tipeo rápido + Enter confirma.
      await page.keyboard.type("360003136911770", { delay: 2 })
      await page.keyboard.press("Enter")
      await page.locator(".dispatch-label-confirmed").waitFor()
      assert.match(await page.locator(".dispatch-order-heading").innerText(), /Listo para Bulto/i)
      assert.equal(await input.count(), 0, `${label}: confirmada, el campo desaparece`)
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${label}: sin desborde confirmada`)
      const posts = await page.evaluate(() => (window as unknown as { __posts: Array<{ action: string; code: string }> }).__posts)
      assert.deepEqual(posts.map((post) => post.action), ["confirm_label", "confirm_label"])
      if (process.env.DISPATCH_SCREENSHOTS) await page.screenshot({ path: `${process.env.DISPATCH_SCREENSHOTS}/label-${theme}-${width}.png`, fullPage: true })
    }
  } finally { await browser.close() }
})
