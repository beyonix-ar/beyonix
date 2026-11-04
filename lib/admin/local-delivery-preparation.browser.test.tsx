import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { build } from "esbuild"
import { chromium } from "playwright-core"
import postcss from "postcss"
import tailwindcss from "@tailwindcss/postcss"

// Envío BEYONIX con el panel REAL de Despachos: mismo pickeo, bultos propios,
// etiqueta BEYONIX impresa por bulto y confirmación escaneando cada BX-PKG.
// Nunca aparece una acción Andreani.
test("Envío BEYONIX: definir bultos, imprimir etiqueta BEYONIX y confirmar cada BX-PKG, sin Andreani (390/1280 px, light/dark)", async () => {
  const bundle = await build({
    stdin: {
      contents: `
        import { createRoot } from "react-dom/client"
        import { OrderPreparationPanel } from "./app/admin/sections/despachos/order-preparation-panel"
        // about:blank no es contexto seguro: sin crypto.randomUUID (en el Admin real sí existe).
        let keys = 0
        if (!globalThis.crypto.randomUUID) globalThis.crypto.randomUUID = () => "10000000-0000-4000-8000-" + String(++keys).padStart(12, "0")
        let parcelCount = null
        const confirmed = new Set()
        window.__posts = []
        window.__printed = []
        new MutationObserver((records) => {
          for (const record of records) for (const node of record.addedNodes) if (node.tagName === "IFRAME" && node.srcdoc) window.__printed.push(node.srcdoc)
        }).observe(document.body, { childList: true })
        const parcels = () => Array.from({ length: parcelCount ?? 0 }, (_, index) => ({
          id: 100 + index, parcel_index: index + 1, parcel_count: parcelCount, attempt_number: 1,
          barcode: "BX-PKG-1011-0" + (index + 1), label_confirmed_at: confirmed.has(index + 1) ? "2026-11-03T16:00:00Z" : null,
        }))
        const stage = () => !parcelCount ? "shipment" : confirmed.size === parcelCount ? "ready" : "label"
        const detail = () => ({
          order: { id: 11, estado: "pagado", financial_status: "payment_confirmed", payment_status: "approved", invoice_status: "authorized", total: null, shipping_provider: "beyonix", envio_proveedor: null, cancelled_at: null, andreani_handed_over_at: null, andreani_handed_over_batch_id: null, created_at: "2026-11-03T12:00:00Z", cliente_nombre: "María José Peña", andreani_envio_id: null, andreani_tracking: null, andreani_creation_status: null },
          package: { id: 11, order_id: 11, status: "prepared", attempt_number: 1, prepared_at: "2026-11-03T15:00:00Z", prepared_by: null, parcel_count: parcelCount, identification_method: null, identified_at: null },
          lines: [{ order_item_id: 1, expected_sku: "ENC-01", expected_barcode: "7790000000011", expected_quantity: 2, scanned_quantity: 2, product_id: 1, variant_id: null, conditioned_stock_id: null, name: "Encendedor eléctrico", orderedQuantity: 2, unitPrice: null }],
          saleItems: [{ orderItemId: 1, sku: "ENC-01", productName: "Encendedor eléctrico", variantName: null, orderedQuantity: 2, unitPrice: null }],
          parcels: parcels(), stage: stage(), itemCount: 1, expectedUnits: 2, membership: null, batch: null,
          localDelivery: { preparation: { packageStatus: "prepared", parcelCount, confirmedParcels: confirmed.size }, preparationError: stage() === "ready" ? null : "Faltan bultos" },
          shipping: { costsVisible: false, estimate: null, parcelQuote: null }, hold: null,
          shipment: { created: false, envioId: null, tracking: null, creationStatus: null },
          adjustments: [], blocked: false, blockReason: null, packingBlocked: false, pendingBeforeDispatch: [], viewer: { costsVisible: false, canShip: true, canForce: true },
        })
        window.fetch = async (url, init) => {
          const path = String(url)
          if (path === "/api/admin/barcodes") {
            const { codes } = JSON.parse(init.body)
            return Response.json({ svgs: Object.fromEntries(codes.map((code) => [code, '<svg viewBox="0 0 10 10" data-code="' + code + '"></svg>'])) })
          }
          if (!init || !init.body) return Response.json(detail())
          const body = JSON.parse(init.body)
          window.__posts.push({ path, ...body })
          if (path.endsWith("/local-label")) return Response.json({ labels: parcels().map((parcel) => ({
            kind: "local_delivery", code: parcel.barcode, orderCode: "BX-1011", index: parcel.parcel_index, count: parcelCount,
            recipient: "María José Peña", address: "Córdoba 1234", reference: "Portón verde", locality: "Rosario", province: "Santa Fe",
            postalCode: "2000", phone: "341 555-0000", date: "03/11/2026" })) })
          if (body.action === "local_parcels") { parcelCount = body.parcelCount; return Response.json(detail()) }
          if (body.action === "confirm_parcel") {
            const parcel = parcels().find((item) => item.barcode === String(body.code).trim().toUpperCase())
            if (!parcel) return Response.json({ error: "Escaneá el código BX-PKG de la etiqueta BEYONIX del bulto." }, { status: 409 })
            const duplicate = confirmed.has(parcel.parcel_index)
            confirmed.add(parcel.parcel_index)
            return Response.json({ ...detail(), parcelConfirmation: { orderId: 11, code: parcel.barcode, parcelIndex: parcel.parcel_index, parcelCount, confirmed: confirmed.size, complete: confirmed.size === parcelCount, duplicate } })
          }
          return Response.json({ error: "acción inesperada" }, { status: 400 })
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
    for (const theme of ["light", "dark"]) for (const width of [390, 1280]) {
      const label = `${theme} ${width}`
      await page.setViewportSize({ width, height: 900 })
      await page.setContent(`<html data-admin-theme="${theme}"><head><style>${css}</style></head><body><div class="beyonix-admin-shell min-h-screen text-white"><main class="beyonix-admin-main min-w-0 bg-beyonix-page p-4"><div class="dispatch-surface @container"><div id="root"></div></div></main></div></body></html>`)
      await page.addScriptTag({ content: bundle.outputFiles[0].text })
      const heading = page.locator(".dispatch-order-heading")
      await heading.waitFor()
      assert.match(await heading.innerText(), /Envío BEYONIX/, label)
      assert.match(await heading.innerText(), /faltan bultos/i, label)
      assert.doesNotMatch(await page.locator(".dispatch-order").innerText(), /Andreani/i, `${label}: ninguna acción Andreani`)

      // Bultos físicos: 2.
      await page.getByRole("button", { name: "Definir bultos" }).click()
      await page.getByRole("textbox", { name: "Cantidad de bultos" }).fill("2")
      await page.getByRole("button", { name: "Confirmar bultos" }).click()
      await page.getByRole("button", { name: "Imprimir etiqueta BEYONIX" }).waitFor()
      assert.equal(await page.locator("[data-local-parcel]").count(), 2)
      assert.doesNotMatch(await page.locator(".dispatch-order").innerText(), /Andreani/i, `${label}: ninguna acción Andreani`)

      // Etiqueta propia: una por bulto, con sus datos y sin información financiera.
      await page.getByRole("button", { name: "Imprimir etiqueta BEYONIX" }).click()
      await page.waitForFunction(() => (window as unknown as { __printed: string[] }).__printed.length > 0)
      const printed = await page.evaluate(() => (window as unknown as { __printed: string[] }).__printed.at(-1) ?? "")
      for (const text of ["ENVÍO BEYONIX", "PEDIDO BX-1011", "BULTO 1/2", "BULTO 2/2", "María José Peña", "Córdoba 1234", "CP 2000", "341 555-0000", "BX-PKG-1011-01", "BX-PKG-1011-02", "size: 101.6mm 50.8mm"]) {
        assert.ok(printed.includes(text), `${label}: ${text}`)
      }
      assert.doesNotMatch(printed, /Andreani|\$|total|pago/i, `${label}: sin datos financieros ni Andreani`)

      // Confirmación física: código equivocado, luego cada BX-PKG con el lector.
      const input = page.getByRole("textbox", { name: "Escaneá el código BX-PKG de cada bulto" })
      await input.waitFor()
      assert.ok(await input.evaluate((element) => element === document.activeElement), `${label}: foco para el lector`)
      await input.pressSequentially("7790000000011")
      await input.press("Enter")
      await page.getByText("Escaneá el código BX-PKG de la etiqueta BEYONIX del bulto.").first().waitFor()
      await page.keyboard.type("BX-PKG-1011-01", { delay: 2 })
      await page.keyboard.press("Enter")
      await page.getByText(/Bulto confirmado · 1 de 2 · 1\/2 listos/).first().waitFor()
      await page.keyboard.type("BX-PKG-1011-02", { delay: 2 })
      await page.keyboard.press("Enter")
      await page.locator(".dispatch-label-confirmed").waitFor()
      assert.match(await heading.innerText(), /Listo para el cadete/i, label)
      assert.equal(await page.locator('[data-local-parcel][data-confirmed="true"]').count(), 2)
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${label}: sin desborde`)
      const posts = await page.evaluate(() => (window as unknown as { __posts: Array<{ action?: string; path: string }> }).__posts)
      assert.deepEqual(posts.map((post) => post.action ?? post.path.split("/").at(-1)), ["local_parcels", "local-label", "confirm_parcel", "confirm_parcel", "confirm_parcel"])
      assert.equal(posts.some((post) => post.action === "ship" || post.action === "confirm_label" || post.path.includes("andreani")), false)
      if (process.env.DISPATCH_SCREENSHOTS) await page.screenshot({ path: `${process.env.DISPATCH_SCREENSHOTS}/local-ready-${theme}-${width}.png`, fullPage: true })
    }
  } finally { await browser.close() }
})
