import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import postcss from "postcss"
import tailwindcss from "@tailwindcss/postcss"
import { build, type Plugin } from "esbuild"
import { chromium, type Browser, type Page } from "playwright-core"

import { adminConfigStubs, adminPageHtml } from "./admin-config-browser-harness.ts"

// Admin → Compras con el panel REAL (bundle esbuild) y la lógica server REAL
// de búsqueda/escaneo/pendientes corriendo en el navegador contra un PostgREST
// en memoria con 1500 productos y el mismo tope de 1000 filas por respuesta.
// No hay lector físico: los códigos se escriben a mano en el input.

const authStub: Plugin = {
  name: "costs-auth-stub",
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^@\/context\/auth-context$/ }, () => ({ path: "auth", namespace: "costs-stub" }))
    pluginBuild.onLoad({ filter: /^auth$/, namespace: "costs-stub" }, () => ({
      loader: "ts",
      contents: `export function useAuth() { return { isSuperAdmin: true } }`,
    }))
  },
}

const ENTRY = `
import { createElement } from "react"
import { createRoot } from "react-dom/client"
import { AdminCostsPanel } from "@/app/admin/sections/dashboard/admin-costs-panel"
import { findCatalogArticleByCode } from "@/lib/barcodes/catalog-lookup"
import { createSupabaseCatalogCodeStore } from "@/lib/barcodes/catalog-lookup-store"
import { loadCatalogProductsByIds, loadPendingPurchaseTargets, searchCostCatalog, withPurchaseBarcode } from "@/lib/business/cost-catalog-server"
import { createFakeCostCatalogDb } from "@/lib/business/fixtures/cost-catalog-fake-db"

const productos = Array.from({ length: 1500 }, (_, index) => ({ id: index + 1, nombre: "Producto " + String(index + 1).padStart(4, "0"), sku: "P-" + (index + 1) }))
const producto_variantes = productos.map((product) => ({
  id: 100000 + product.id, producto_id: product.id, nombre: "Color " + product.id, sku: "P-" + product.id + "-V",
  color_hex: "#123456", codigo_barra: "779" + String(product.id).padStart(10, "0"),
}))
producto_variantes[1399].codigo_barra = "BX-PRO-001400"
const purchase = (id, product_id, variant_id, article_name, sku, quantity, unit_cost, purchase_date) => ({
  id, product_id, variant_id, article_name, sku, purchase_date, quantity, received_quantity: quantity, reception_status: "recibida",
  unit_cost, freight_cost: 0, tax_cost: 0, commission_cost: 0, other_cost: 0, total_cost: quantity * unit_cost,
  supplier: null, document_type: null, document_number: null, payment_method: null, notes: null, created_at: purchase_date + "T10:00:00Z",
})
const db = createFakeCostCatalogDb({
  productos,
  producto_variantes,
  product_cost_entries: [
    purchase("c1", 1499, 101499, null, "P-1499-V", 4, 1000, "2026-10-01"),
    purchase("c2", 1400, 101400, null, "P-1400-V", 10, 2500, "2026-10-02"),
    purchase("c3", null, null, "CINTA DE EMBALAR", "CINTA", 2, 300, "2026-10-03"),
  ],
})
window.__requests = []
window.__posts = []
window.__postStatuses = []
window.fetch = async (input, init) => {
  const url = new URL(String(input), "http://admin.test")
  window.__requests.push(url.pathname + url.search)
  if (url.pathname === "/api/admin/costs" && init && init.method === "POST") {
    const headers = new Headers(init.headers)
    window.__posts.push({ key: headers.get("Idempotency-Key"), body: JSON.parse(init.body) })
    await new Promise((resolve) => setTimeout(resolve, 250))
    const status = window.__postStatuses.shift() ?? 201
    return status >= 400
      ? Response.json({ error: "Tiempo de espera agotado." }, { status })
      : Response.json({ item: { id: "nueva" }, productId: 9001, variantId: 99001, replayed: false }, { status })
  }
  if (url.pathname === "/api/admin/costs/new-article" && init && init.method === "POST") {
    const body = JSON.parse(init.body)
    window.__articlePosts = [...(window.__articlePosts ?? []), body]
    const variant = producto_variantes.find((item) => item.id === Number(body.variantId))
    if (body.replaceBarcode && variant) {
      const code = (body.barcode ?? "").trim() || null
      const owner = code && producto_variantes.find((item) => item.id !== variant.id && item.codigo_barra === code)
      if (owner) {
        const product = productos.find((item) => item.id === owner.producto_id)
        return Response.json({ error: "El código de barra " + code + " ya está asignado a " + product.nombre + " · " + owner.nombre + ". Usá un código distinto para esta variante." }, { status: 409 })
      }
      variant.codigo_barra = code
    }
    return Response.json({ productId: Number(body.productId), variantId: Number(body.variantId) })
  }
  if (url.pathname === "/api/admin/costs" && init && init.method === "PATCH") {
    window.__patches = [...(window.__patches ?? []), JSON.parse(init.body)]
    return Response.json({ item: { id: JSON.parse(init.body).id } })
  }
  if (url.pathname === "/api/admin/costs") {
    const costRows = (await db.from("product_cost_entries").select("*").order("purchase_date", { ascending: false }).range(0, 999)).data.map(withPurchaseBarcode)
    return Response.json({
      catalog: await loadCatalogProductsByIds(db, costRows.flatMap((row) => row.product_id == null ? [] : [row.product_id])),
      productCosts: costRows,
      expenses: [],
      pendingTargets: await loadPendingPurchaseTargets(db),
    })
  }
  if (url.pathname === "/api/admin/costs/articles") {
    const productId = url.searchParams.get("productId")
    const page = productId
      ? { items: await loadCatalogProductsByIds(db, [Number(productId)]), hasMore: false }
      : await searchCostCatalog(db, url.searchParams.get("q") ?? "", Number(url.searchParams.get("offset") ?? 0))
    window.__maxItems = Math.max(window.__maxItems ?? 0, page.items.length)
    return Response.json(page)
  }
  if (url.pathname === "/api/admin/costs/article-by-code") {
    return Response.json({ match: await findCatalogArticleByCode(createSupabaseCatalogCodeStore(db), url.searchParams.get("code") ?? "") })
  }
  return Response.json({ error: "No simulado" }, { status: 404 })
}
createRoot(document.getElementById("root")).render(createElement(AdminCostsPanel))
`

let browser: Browser
let css: string
let bundle: string

test.before(async () => {
  css = (await postcss([tailwindcss({ base: process.cwd() })]).process(readFileSync("app/globals.css", "utf8"), { from: "app/globals.css" })).css
  const result = await build({
    stdin: { contents: ENTRY, resolveDir: process.cwd(), loader: "tsx", sourcefile: "admin-costs-purchases-entry.tsx" },
    bundle: true, format: "iife", write: false, jsx: "automatic", plugins: [adminConfigStubs, authStub],
    define: { "process.env.NODE_ENV": '"production"' }, logLevel: "error",
  })
  bundle = result.outputFiles[0].text
  browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chrome", headless: true })
})

test.after(async () => {
  await browser?.close()
})

async function open(): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  // http://admin.test no es contexto seguro: el admin real (HTTPS) sí tiene
  // crypto.randomUUID, con el que se generan las claves idempotentes.
  await page.addInitScript({
    content: `if (typeof crypto.randomUUID !== "function") {
      Object.defineProperty(crypto, "randomUUID", { value: () => "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (d) =>
        (Number(d) ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (Number(d) / 4)))).toString(16)) })
    }`,
  })
  await page.route("**/*", (route) =>
    route.request().url() === "http://admin.test/"
      ? route.fulfill({ contentType: "text/html; charset=utf-8", body: adminPageHtml("dark", css, bundle) })
      : route.abort(),
  )
  await page.goto("http://admin.test/")
  await page.getByText("Historial de compras").waitFor()
  return { page, errors }
}

const scanInput = (page: Page) => page.getByLabel("Escanear o escribir código de barra o SKU")
const articleButton = (page: Page) => page.locator("button[aria-haspopup='listbox']").first()
// Field envuelve cada control en un <label>: se ubica por el texto exacto.
const field = (page: Page, label: string) =>
  page.locator("label").filter({ has: page.locator("span", { hasText: new RegExp(`^${label}$`) }) })
const skuInput = (page: Page) => page.locator("label", { hasText: "SKU (opcional)" }).locator("input")

async function scan(page: Page, code: string) {
  await scanInput(page).fill(code)
  await scanInput(page).press("Enter")
  await page.locator("p[role='status']").waitFor()
  return (await page.locator("p[role='status']").textContent())?.trim() ?? ""
}

test("escaneo manual: BEYONIX, fabricante, SKU e inexistente autocompletan igual que antes", async () => {
  const { page, errors } = await open()
  try {
    assert.equal(await scan(page, "BX-PRO-001400"), "✓ Producto 1400 · Color 1400")
    assert.equal((await articleButton(page).textContent())?.trim(), "Producto 1400 · Color 1400")
    assert.equal(await skuInput(page).inputValue(), "P-1400-V")
    const barcodeField = page.locator("label", { hasText: "Código de barra" }).first()
    assert.match((await barcodeField.textContent()) ?? "", /BX-PRO-001400\s*BEYONIX/)

    // Fuera de las 1000 primeras filas y fuera del catálogo cargado.
    assert.equal(await scan(page, "7790000001450"), "✓ Producto 1450 · Color 1450")
    assert.equal((await articleButton(page).textContent())?.trim(), "Producto 1450 · Color 1450")
    assert.equal(await skuInput(page).inputValue(), "P-1450-V")
    assert.match((await barcodeField.textContent()) ?? "", /7790000001450\s*Fabricante/)

    assert.equal(await scan(page, "p-1460-v"), "✓ Producto 1460 · Color 1460")
    assert.equal(await skuInput(page).inputValue(), "P-1460-V")

    assert.match(await scan(page, "7790000009999"), /^Código no reconocido\.\s*Crear artículo con este código$/)
    assert.equal(await scanInput(page).inputValue(), "7790000009999")
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
  }
})

test("historial: filtra por nombre o código de barra persistido, con cantidad y precio", async () => {
  const { page, errors } = await open()
  try {
    const rows = page.locator("table tbody tr")
    const filter = page.getByLabel("Filtrar historial por nombre o código de barra")
    assert.equal(await page.locator("label", { hasText: "Nombre / código de barra" }).count(), 1)
    assert.equal(await rows.count(), 3)
    const visibleNames = async () => (await rows.allTextContents()).map((text) => text.match(/Producto \d{4} · Color \d{4}|CINTA DE EMBALAR/)?.[0])

    await filter.fill("BX-PRO")
    assert.deepEqual(await visibleNames(), ["Producto 1400 · Color 1400"])
    await filter.fill("bx-pro-001400")
    assert.deepEqual(await visibleNames(), ["Producto 1400 · Color 1400"])
    await filter.fill("0001499")
    assert.deepEqual(await visibleNames(), ["Producto 1499 · Color 1499"])
    await filter.fill("cinta")
    assert.deepEqual(await visibleNames(), ["CINTA DE EMBALAR"])
    await filter.fill("producto")
    assert.equal(await rows.count(), 2)

    const quantity = field(page, "Cantidad").locator("input")
    await quantity.first().fill("5")
    assert.deepEqual(await visibleNames(), ["Producto 1400 · Color 1400"])
    await quantity.first().fill("")
    const price = field(page, "Precio unitario").locator("input")
    await price.nth(1).fill("2000")
    assert.deepEqual(await visibleNames(), ["Producto 1499 · Color 1499"])
    await price.nth(1).fill("")

    await filter.fill("no-existe")
    assert.equal(await page.getByText("Producto 1499 · Color 1499", { exact: true }).count(), 0)
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
  }
})

test("selector manual: 1500 productos paginados y buscables server-side", async () => {
  const { page, errors } = await open()
  try {
    await articleButton(page).click()
    const list = page.locator("[role='listbox']")
    const productOptions = list.locator("button[role='option'].text-sm")
    await page.getByText("Cargar más").waitFor()
    // "Crear artículo nuevo" + 30 productos de la primera página.
    assert.equal(await productOptions.count(), 31)
    await page.getByText("Cargar más").click()
    await page.waitForFunction(() => document.querySelectorAll("[role='listbox'] button[role='option'].text-sm").length === 61)

    const search = page.getByLabel("Buscar artículo por nombre, SKU o código de barra")
    await search.fill("producto 1499")
    await page.waitForFunction(() => document.querySelectorAll("[role='listbox'] button[role='option'].text-sm").length === 2)
    await list.getByText("↳ Color 1499").click()
    assert.equal((await articleButton(page).textContent())?.trim(), "Producto 1499 · Color 1499")
    assert.equal(await skuInput(page).inputValue(), "P-1499-V")

    await articleButton(page).click()
    await search.fill("bx-pro-0014")
    await page.waitForFunction(() => [...document.querySelectorAll("[role='listbox'] button[role='option']")].some((option) => option.textContent?.includes("Producto 1400")))
    await search.fill("zzz inexistente")
    await page.getByText("No se encontraron productos.").waitFor()

    const requests: string[] = await page.evaluate(() => (window as unknown as { __requests: string[] }).__requests)
    assert.ok(requests.some((request) => request.startsWith("/api/admin/costs/articles?q=&offset=30")))
    const maxItems: number = await page.evaluate(() => (window as unknown as { __maxItems: number }).__maxItems)
    assert.ok(maxItems <= 30, `ninguna respuesta trae más de una página (máximo ${maxItems})`)
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
  }
})

test("pendientes y código BEYONIX pendiente: se calculan en la base y el texto queda claro", async () => {
  const { page, errors } = await open()
  try {
    await page.getByText("1498 pendientes").waitFor()
    const firstTarget = page.locator("div", { hasText: /^Producto 0001 · Color 1Registrar$/ }).last()
    await firstTarget.getByRole("button", { name: "Registrar" }).click()
    await page.waitForFunction(() => document.querySelector("button[aria-haspopup='listbox']")?.textContent?.includes("Producto 0001 · Color 1"))
    assert.equal(await skuInput(page).inputValue(), "P-1-V")

    await articleButton(page).click()
    await page.getByRole("option", { name: "Crear artículo nuevo" }).click()
    await page.getByTitle("Generar código BEYONIX").click()
    const pending = page.getByText("Se generará al guardar", { exact: true })
    await pending.waitFor()
    const fits = await pending.evaluate((element) => element.scrollWidth <= element.clientWidth)
    assert.equal(fits, true, "el texto no queda cortado")
    const pendingBox = page.getByTitle("El código BEYONIX se asigna recién cuando guardás la compra.")
    assert.equal(await pendingBox.count(), 1)
    await pendingBox.locator("button", { hasText: "Cancelar" }).click()
    assert.equal(await page.getByText("Se generará al guardar").count(), 0)
    assert.equal(await page.getByPlaceholder("Escaneá el código del fabricante").count(), 1)
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
  }
})

test("artículo nuevo: variante + compra en UNA request; doble click y reintento tras timeout no duplican", async () => {
  const { page, errors } = await open()
  try {
    assert.match(await scan(page, "7790000009999"), /Código no reconocido/)
    await page.getByRole("button", { name: "Crear artículo con este código" }).click()
    await page.getByPlaceholder("Por ej: Auricular").fill("AURICULAR NUEVO")
    await page.getByLabel("Elegir color").fill("#eca2a2")
    await page.getByLabel("Nombre del color").fill("Rosa")
    await page.getByPlaceholder("Por ej: Aur-01").fill("aurnew01")
    await field(page, "Cantidad comprada").locator("input").fill("2")
    await field(page, "Costo unitario").locator("input").fill("8852")
    await field(page, "Flete").locator("input").fill("0")

    // Primer intento: doble click y el servidor no responde a tiempo.
    await page.evaluate(() => { (window as unknown as { __postStatuses: number[] }).__postStatuses = [504, 201] })
    await page.getByRole("button", { name: "Guardar", exact: true }).dblclick()
    await page.getByText("Tiempo de espera agotado.").waitFor()
    const posts = () => page.evaluate(() => (window as unknown as { __posts: { key: string; body: Record<string, unknown> }[] }).__posts)
    assert.equal((await posts()).length, 1, "doble click = una sola request")

    // Reintento: misma clave, el servidor devuelve la operación una sola vez.
    await page.getByRole("button", { name: "Guardar", exact: true }).click()
    await page.getByText("Compra guardada correctamente.").waitFor()
    const sent = await posts()
    assert.equal(sent.length, 2)
    assert.equal(sent[1].key, sent[0].key, "el reintento reutiliza la clave idempotente")
    const newVariant = sent[0].body.newVariant as Record<string, unknown>
    assert.deepEqual(
      [newVariant.productId, newVariant.productName, newVariant.colorHex, newVariant.colorName, newVariant.sku, newVariant.barcode],
      [null, "AURICULAR NUEVO", "#ECA2A2", "ROSA", "AURNEW01", "7790000009999"],
    )
    assert.equal(sent[0].body.unitCost, "8852")
    assert.equal(sent[0].body.productId, null, "la variante y el producto los resuelve la transacción")
    const requests = await page.evaluate(() => (window as unknown as { __requests: string[] }).__requests)
    assert.equal(requests.filter((path) => path.startsWith("/api/admin/costs/new-article")).length, 0, "sin alta previa sin compra")
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
  }
})

const editPurchaseOf = async (page: Page, name: string) => {
  await page.locator("table tbody tr", { hasText: name }).getByRole("button", { name: "Editar compra" }).click()
  await page.getByRole("heading", { name: "Editar compra" }).waitFor()
}
const barcodeInput = (page: Page) => page.getByRole("textbox", { name: "Código de barra", exact: true })
const sentBodies = (page: Page, key: "__articlePosts" | "__patches") =>
  page.evaluate((name) => (window as unknown as Record<string, Record<string, unknown>[] | undefined>)[name] ?? [], key)

test("editar compra: el código de barra de la variante es editable, se guarda en la variante y se ve al volver (A/B/E/F/H)", async () => {
  const { page, errors } = await open()
  try {
    await editPurchaseOf(page, "Producto 1499 · Color 1499")
    const input = barcodeInput(page)
    assert.equal(await input.isEditable(), true, "el campo ya no está bloqueado")
    assert.equal(await input.inputValue(), "7790000001499", "muestra el código actual de la variante")

    await input.fill("7791234500017")
    await page.getByRole("button", { name: "Actualizar", exact: true }).click()
    await page.getByText("Compra actualizada correctamente.").waitFor()

    const [article] = await sentBodies(page, "__articlePosts")
    assert.deepEqual(
      [article.productId, article.variantId, article.barcode, article.generateBarcode, article.replaceBarcode, article.purchaseId],
      ["1499", "101499", "7791234500017", false, true, "c1"],
    )
    const [purchase] = await sentBodies(page, "__patches")
    assert.deepEqual(
      [purchase.id, purchase.quantity, purchase.unitCost, purchase.receivedQuantity, purchase.supplier, purchase.sku],
      ["c1", "4", "1000", "4", "", "P-1499-V"],
      "cantidad, costo, recepción, proveedor y SKU se mandan sin cambios",
    )

    // Refresh: la compra vuelve a cargarse con el código nuevo de la variante.
    await editPurchaseOf(page, "Producto 1499 · Color 1499")
    assert.equal(await barcodeInput(page).inputValue(), "7791234500017")
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
  }
})

test("editar compra: un código que ya usa otra variante bloquea el guardado y dice dónde está (C)", async () => {
  const { page, errors } = await open()
  try {
    await editPurchaseOf(page, "Producto 1499 · Color 1499")
    await barcodeInput(page).fill("BX-PRO-001400")
    await page.getByRole("button", { name: "Actualizar", exact: true }).click()
    await page.getByText("El código de barra BX-PRO-001400 ya está asignado a Producto 1400 · Color 1400", { exact: false }).waitFor()
    assert.deepEqual(await sentBodies(page, "__patches"), [], "la compra no se guarda")
    assert.equal(await page.getByRole("heading", { name: "Editar compra" }).count(), 1, "sigue editando con el valor ingresado")
    assert.equal(await barcodeInput(page).inputValue(), "BX-PRO-001400")
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
  }
})

test("editar compra sin tocar el código: se guarda igual (idempotente) y una compra nueva sigue sin pisar códigos (D)", async () => {
  const { page, errors } = await open()
  try {
    await editPurchaseOf(page, "Producto 1400 · Color 1400")
    assert.equal(await barcodeInput(page).inputValue(), "BX-PRO-001400")
    await page.getByRole("button", { name: "Actualizar", exact: true }).click()
    await page.getByText("Compra actualizada correctamente.").waitFor()
    const [article] = await sentBodies(page, "__articlePosts")
    assert.equal(article.barcode, "BX-PRO-001400")
    assert.equal(article.replaceBarcode, true)
    assert.equal((await sentBodies(page, "__patches")).length, 1)

    // Compra NUEVA de una variante con código: sigue mostrándose fijo.
    assert.match(await scan(page, "BX-PRO-001400"), /Producto 1400/)
    assert.equal(await barcodeInput(page).count(), 0)
    assert.match((await page.locator("label", { hasText: "Código de barra" }).first().textContent()) ?? "", /BX-PRO-001400\s*BEYONIX/)
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
  }
})

for (const width of [390, 1440]) {
  test(`editar compra: el código editable entra sin scroll horizontal a ${width}px (I)`, async () => {
    const { page, errors } = await open()
    try {
      await page.setViewportSize({ width, height: 900 })
      await editPurchaseOf(page, "Producto 1499 · Color 1499")
      const box = await barcodeInput(page).boundingBox()
      assert.ok(box && box.width >= 120 && box.x >= 0 && box.x + box.width <= width, `input visible y usable: ${JSON.stringify(box)}`)
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "sin scroll horizontal")
      assert.deepEqual(errors, [])
    } finally {
      await page.close()
    }
  })
}