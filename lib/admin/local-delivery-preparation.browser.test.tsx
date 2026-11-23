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
            postalCode: "2000", phone: "341 555-0000", date: "03/11/2026",
            deliveryUrl: "https://beyonix.com.ar/delivery/q8Jv2mN4pT7xR1sK9wZ3bH6cY0dF5gLe" })) })
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
      // QR de gestión de entrega: el mismo en cada bulto, generado desde deliveryUrl.
      assert.equal(printed.match(/<div class="ld-qr-code"><svg/g)?.length, 2, `${label}: un QR por etiqueta`)
      assert.equal(printed.includes("q8Jv2mN4pT7xR1sK9wZ3bH6cY0dF5gLe"), false, `${label}: el token no se imprime como texto`)

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

// Envío BEYONIX ya entregado al cadete ("Pedido bloqueado · Envío ya en curso"):
// el bloqueo de preparación NO impide los documentos. Admin reimprime con los
// mismos códigos y QR, ve el QR del cadete y corrige una entrega marcada por
// error con motivo; un operador no reimprime ni corrige.
test("Envío BEYONIX En camino: reimprimir, QR del cadete y corregir entrega al cadete (Admin vs operador)", async () => {
  const bundle = await build({
    stdin: {
      contents: `
        import { createRoot } from "react-dom/client"
        import { OrderPreparationPanel } from "./app/admin/sections/despachos/order-preparation-panel"
        let keys = 0
        if (!globalThis.crypto.randomUUID) globalThis.crypto.randomUUID = () => "20000000-0000-4000-8000-" + String(++keys).padStart(12, "0")
        const admin = window.__role === "admin"
        let estado = "en_camino"
        window.__posts = []
        window.__printed = []
        new MutationObserver((records) => {
          for (const record of records) for (const node of record.addedNodes) if (node.tagName === "IFRAME" && node.srcdoc) window.__printed.push(node.srcdoc)
        }).observe(document.body, { childList: true })
        const parcels = [1, 2].map((index) => ({ id: 100 + index, parcel_index: index, parcel_count: 2, attempt_number: 1, barcode: "BX-PKG-1011-0" + index, label_confirmed_at: "2026-11-03T16:00:00Z" }))
        const detail = () => {
          const dispatched = estado === "en_camino"
          return {
            order: { id: 11, estado, financial_status: "payment_confirmed", payment_status: "approved", invoice_status: "authorized", total: null, shipping_provider: "beyonix", envio_proveedor: null, cancelled_at: null, andreani_handed_over_at: null, andreani_handed_over_batch_id: null, created_at: "2026-11-03T12:00:00Z", cliente_nombre: "María José Peña", andreani_envio_id: null, andreani_tracking: null, andreani_creation_status: null },
            package: { id: 11, order_id: 11, status: "prepared", attempt_number: 1, prepared_at: "2026-11-03T15:00:00Z", prepared_by: null, parcel_count: 2, identification_method: null, identified_at: null },
            lines: [{ order_item_id: 1, expected_sku: "ENC-01", expected_barcode: "7790000000011", expected_quantity: 2, scanned_quantity: 2, product_id: 1, variant_id: null, conditioned_stock_id: null, name: "Encendedor eléctrico", orderedQuantity: 2, unitPrice: null }],
            saleItems: [{ orderItemId: 1, sku: "ENC-01", productName: "Encendedor eléctrico", variantName: null, orderedQuantity: 2, unitPrice: null }],
            parcels, stage: dispatched ? "handed_over" : "ready", itemCount: 1, expectedUnits: 2, membership: null, batch: null,
            localDelivery: { preparation: { packageStatus: "prepared", parcelCount: 2, confirmedParcels: 2 }, preparationError: null },
            shipping: { costsVisible: false, estimate: null, parcelQuote: null }, hold: null,
            shipment: { created: false, envioId: null, tracking: null, creationStatus: null },
            adjustments: [], blocked: dispatched, blockReason: dispatched ? "Envío ya en curso" : null, packingBlocked: dispatched, pendingBeforeDispatch: [],
            // canRevertLocalHandover: regla de la base (local_delivery_revert_blockers); __retried = incidencia reintentada.
            viewer: { costsVisible: admin, canShip: admin, canForce: false, canCorrectLocalDispatch: admin, canRevertLocalHandover: admin && dispatched && !window.__retried },
          }
        }
        window.fetch = async (url, init) => {
          const path = String(url)
          if (path === "/api/admin/barcodes") {
            const { codes } = JSON.parse(init.body)
            return Response.json({ svgs: Object.fromEntries(codes.map((code) => [code, '<svg viewBox="0 0 10 10" data-code="' + code + '"></svg>'])) })
          }
          if (!init || !init.body) return Response.json(detail())
          const body = JSON.parse(init.body)
          window.__posts.push({ path, ...body })
          if (path.endsWith("/local-label")) return Response.json({ labels: parcels.map((parcel) => ({
            kind: "local_delivery", code: parcel.barcode, orderCode: "BX-1011", index: parcel.parcel_index, count: 2,
            recipient: "María José Peña", address: "Córdoba 1234", reference: "Portón verde", locality: "Rosario", province: "Santa Fe",
            postalCode: "2000", phone: "341 555-0000", date: "03/11/2026", deliveryUrl: "https://beyonix.com.ar/delivery/q8Jv2mN4pT7xR1sK9wZ3bH6cY0dF5gLe" })) })
          if (path.endsWith("/courier-qr")) return Response.json({ orderCode: "BX-1011", url: "https://beyonix.com.ar/delivery/q8Jv2mN4pT7xR1sK9wZ3bH6cY0dF5gLe", courierCanAct: true, screen: "actions" })
          if (path.endsWith("/dispatch/local") && body.action === "revert_in_transit") { estado = "pagado"; return Response.json({ ok: true, order: { id: 11, estado, stage: "preparing" } }) }
          return Response.json({ error: "acción inesperada" }, { status: 400 })
        }
        createRoot(document.getElementById("root")).render(<OrderPreparationPanel orderId={11} />)
      `,
      resolveDir: process.cwd(),
      loader: "tsx",
    },
    bundle: true, platform: "browser", format: "iife", write: false, jsx: "automatic",
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
  type Post = { action?: string; path: string; reason?: string; requestKey?: string; orderId?: number }
  try {
    const page = await browser.newPage()
    for (const role of ["admin", "operador"] as const) for (const theme of ["light", "dark"]) for (const width of [390, 1280]) {
      const label = `${role} ${theme} ${width}`
      await page.setViewportSize({ width, height: 900 })
      await page.setContent(`<html data-admin-theme="${theme}"><head><style>${css}</style></head><body><div class="beyonix-admin-shell min-h-screen text-white"><main class="beyonix-admin-main min-w-0 bg-beyonix-page p-4"><div class="dispatch-surface @container"><div id="root"></div></div></main></div></body></html>`)
      await page.evaluate((value) => { (window as unknown as { __role: string }).__role = value }, role)
      await page.addScriptTag({ content: bundle.outputFiles[0].text })
      const heading = page.locator(".dispatch-order-heading")
      await heading.waitFor()
      assert.match(await heading.innerText(), /Entregado al cadete/i, label)
      assert.match(await page.locator(".dispatch-order").innerText(), /Pedido bloqueado · Envío ya en curso/, `${label}: el bloqueo de preparación sigue visible`)

      await page.getByRole("button", { name: "Etiquetas" }).click()
      const reprint = page.getByRole("menuitem", { name: "Reimprimir etiquetas BEYONIX" })
      await reprint.waitFor()
      assert.equal(await reprint.isDisabled(), role !== "admin", `${label}: reimpresión sólo Admin con el envío en curso`)
      assert.equal(await page.getByRole("menuitem", { name: "Ver QR del cadete" }).isDisabled(), false, label)
      if (role === "admin") {
        await reprint.click()
        await page.waitForFunction(() => (window as unknown as { __printed: string[] }).__printed.length > 0)
        const printed = await page.evaluate(() => (window as unknown as { __printed: string[] }).__printed.at(-1) ?? "")
        for (const text of ["BX-PKG-1011-01", "BX-PKG-1011-02", "BULTO 1/2", "BULTO 2/2"]) assert.ok(printed.includes(text), `${label}: ${text}`)
        assert.equal(printed.match(/<div class="ld-qr-code"><svg/g)?.length, 2, `${label}: mismo QR en cada etiqueta`)
        await page.getByText(/para reimprimir: mismos códigos y el QR vigente del pedido \(si estaba revocado, sale uno nuevo y el anterior deja de funcionar\)/).first().waitFor()
      } else {
        await page.keyboard.press("Escape")
      }

      // QR del cadete: escaneable desde el celular, con el enlace de la etiqueta.
      await page.getByRole("button", { name: "Etiquetas" }).click()
      await page.getByRole("menuitem", { name: "Ver QR del cadete" }).click()
      const qr = page.locator("[data-courier-qr-image]")
      await qr.waitFor()
      assert.ok((await qr.getAttribute("src"))?.startsWith("data:image/png;base64,"), `${label}: QR renderizado`)
      assert.equal(await page.getByRole("link", { name: "Abrir página del cadete" }).getAttribute("href"), "https://beyonix.com.ar/delivery/q8Jv2mN4pT7xR1sK9wZ3bH6cY0dF5gLe")
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${label}: sin desborde con el QR abierto`)
      if (process.env.DISPATCH_SCREENSHOTS) await page.screenshot({ path: `${process.env.DISPATCH_SCREENSHOTS}/local-courier-qr-${role}-${theme}-${width}.png` })
      await page.getByRole("button", { name: "Cerrar" }).last().click()
      await qr.waitFor({ state: "detached" })

      await page.getByRole("button", { name: "Pedido" }).click()
      const correct = page.getByRole("menuitem", { name: "Corregir entrega al cadete" })
      if (role !== "admin") {
        assert.equal(await correct.count(), 0, `${label}: un operador no corrige`)
        await page.keyboard.press("Escape")
      } else {
        await correct.click()
        const confirm = page.getByRole("button", { name: "Confirmar corrección" })
        await confirm.waitFor()
        assert.equal(await confirm.isDisabled(), true, `${label}: motivo obligatorio`)
        await page.getByRole("textbox", { name: "Motivo obligatorio" }).fill("corto")
        assert.equal(await confirm.isDisabled(), true, `${label}: mínimo 10 caracteres`)
        await page.getByRole("textbox", { name: "Motivo obligatorio" }).fill("Se marcó por error, sigue en el depósito.")
        await confirm.click()
        await page.getByText(/Entrega al cadete corregida/).first().waitFor()
        await page.waitForFunction(() => /Listo para el cadete/i.test(document.querySelector(".dispatch-order-heading")?.textContent ?? ""))
        assert.doesNotMatch(await page.locator(".dispatch-order").innerText(), /Envío ya en curso/, `${label}: vuelve al flujo normal`)
      }
      const posts = await page.evaluate(() => (window as unknown as { __posts: Post[] }).__posts)
      const reverts = posts.filter((post) => post.action === "revert_in_transit")
      if (role === "admin") {
        assert.equal(reverts.length, 1, `${label}: una sola corrección`)
        assert.deepEqual([reverts[0].orderId, reverts[0].reason], [11, "Se marcó por error, sigue en el depósito."])
        assert.match(reverts[0].requestKey ?? "", /^[0-9a-f-]{36}$/)
      } else {
        assert.equal(reverts.length, 0)
        assert.equal(posts.some((post) => post.path.endsWith("/local-label")), false, `${label}: el operador no reimprime`)
      }
      assert.equal(posts.some((post) => ["ship", "reset", "local_parcels", "confirm_parcel", "en_camino"].includes(post.action ?? "")), false, `${label}: ninguna operación logística extra`)
    }

    // Incidencia registrada y "Reintentar entrega": la base rechaza la corrección, así que Admin no la ve.
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.setContent(`<html data-admin-theme="dark"><head><style>${css}</style></head><body><div class="beyonix-admin-shell min-h-screen text-white"><main class="beyonix-admin-main min-w-0 bg-beyonix-page p-4"><div class="dispatch-surface @container"><div id="root"></div></div></main></div></body></html>`)
    await page.evaluate(() => { Object.assign(window, { __role: "admin", __retried: true }) })
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    await page.locator(".dispatch-order-heading").waitFor()
    await page.getByRole("button", { name: "Pedido" }).click()
    await page.getByRole("menuitem", { name: "Ver historial" }).waitFor()
    assert.equal(await page.getByRole("menuitem", { name: "Corregir entrega al cadete" }).count(), 0, "incidencia reintentada: sin corrección")
    await page.keyboard.press("Escape")
    await page.getByRole("button", { name: "Etiquetas" }).click()
    assert.equal(await page.getByRole("menuitem", { name: "Reimprimir etiquetas BEYONIX" }).isDisabled(), false, "Admin sigue pudiendo reimprimir")
  } finally { await browser.close() }
})
