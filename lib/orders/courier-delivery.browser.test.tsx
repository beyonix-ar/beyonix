import assert from "node:assert/strict"
import test from "node:test"
import { mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import postcss from "postcss"
import tailwindcss from "@tailwindcss/postcss"
import { build } from "esbuild"
import { chromium, type Browser, type Page } from "playwright-core"

// Página del cadete (QR de la etiqueta Envío BEYONIX) con el componente REAL,
// en celulares angostos (320 px), Android (360×800) e iPhone (390×844), claro.
// La API del cadete se simula en la página: se verifica qué se envía y qué se
// muestra. COURIER_SCREENSHOTS_DIR=<dir> guarda capturas.

const entry = `
import { createElement } from "react"
import { createRoot } from "react-dom/client"
import { CourierDeliveryClient, CourierPageFrame } from "@/app/delivery/[token]/courier-delivery-client"
const params = new URLSearchParams(location.search)
const base = { orderCode: "BX-2041", customerName: "María José Peña", address: "Córdoba 1234 Piso 3 Dto B",
  reference: "Portón verde, timbre 2", locality: "Rosario · CP 2000", parcels: 2 }
const screens = {
  actions: { ...base, screen: { kind: "actions", failedAttempts: 0 }, failedAttempts: 0 },
  second: { ...base, screen: { kind: "actions", failedAttempts: 1 }, failedAttempts: 1 },
  delivered: { ...base, screen: { kind: "delivered" }, failedAttempts: 0 },
  returning: { ...base, screen: { kind: "returning" }, failedAttempts: 2 },
  returned: { ...base, screen: { kind: "returned" }, failedAttempts: 2 },
  incident: { ...base, screen: { kind: "incident" }, failedAttempts: 0 },
  cancelled: { ...base, screen: { kind: "cancelled" }, failedAttempts: 0 },
  preparing: { ...base, screen: { kind: "preparing" }, failedAttempts: 0 },
}
window.__requests = []
window.fetch = async (input, init) => {
  const body = JSON.parse(init.body)
  window.__requests.push({ url: String(input), body })
  await new Promise((resolve) => setTimeout(resolve, 150))
  const next = body.action === "delivered" ? screens.delivered
    : body.action === "incident" ? screens.incident
    : body.expectedAttempts === 0 ? screens.second : screens.returning
  const message = body.action === "delivered" ? "Entrega registrada. ¡Gracias!"
    : body.action === "incident" ? "Registramos el problema. BEYONIX lo va a revisar."
    : body.expectedAttempts === 0 ? "Registramos el primer intento. El pedido queda para un segundo intento."
    : "Registramos el segundo intento. El pedido debe regresar a BEYONIX."
  return Response.json({ ok: true, message, view: next })
}
// Mismo body que la tienda (negro, globals.css): la página tiene que verse clara igual.
createRoot(document.getElementById("root")).render(
  createElement(CourierPageFrame, null,
    createElement(CourierDeliveryClient, { token: "QrTokenDePrueba1234567890", initialView: screens[params.get("screen") ?? "actions"] })))
`

const DEVICES = [
  { name: "angosto-320", width: 320, height: 640 },
  { name: "android-360", width: 360, height: 800 },
  { name: "iphone-390", width: 390, height: 844 },
] as const

let browser: Browser
let css: string
let bundle: string
const screenshotsDir = process.env.COURIER_SCREENSHOTS_DIR

test.before(async () => {
  css = (await postcss([tailwindcss({ base: process.cwd() })]).process(readFileSync("app/globals.css", "utf8"), { from: "app/globals.css" })).css
  const result = await build({
    stdin: { contents: entry, resolveDir: process.cwd(), loader: "tsx", sourcefile: "courier-delivery-entry.tsx" },
    bundle: true, format: "iife", write: false, jsx: "automatic", alias: { "@": process.cwd() },
    define: { "process.env.NODE_ENV": '"production"' }, logLevel: "error",
  })
  bundle = result.outputFiles[0].text
  browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chrome", headless: true })
  if (screenshotsDir) mkdirSync(screenshotsDir, { recursive: true })
})

test.after(async () => { await browser?.close() })

async function open(screen: string, device: (typeof DEVICES)[number]): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({ viewport: { width: device.width, height: device.height }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()) })
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script>${bundle}</script></body></html>`
  await page.route("**/*", (route) => route.request().url().startsWith("http://localhost/delivery")
    ? route.fulfill({ contentType: "text/html", body: html }) : route.abort())
  await page.goto(`http://localhost/delivery/QrTokenDePrueba1234567890?screen=${screen}`)
  await page.getByText("BX-2041").waitFor({ timeout: 15000 })
  return { page, errors }
}

const requests = (page: Page) => page.evaluate(() => (window as unknown as { __requests: Array<{ url: string; body: Record<string, unknown> }> }).__requests)
const shot = async (page: Page, name: string) => { if (screenshotsDir) await page.screenshot({ path: join(screenshotsDir, `${name}.png`), fullPage: true }) }

for (const device of DEVICES) {
  test(`pantalla inicial (${device.name}): datos mínimos y 3 botones grandes, sin desbordar`, async () => {
    const { page, errors } = await open("actions", device)
    try {
      const text = await page.locator("body").innerText()
      for (const expected of ["BEYONIX", "Pedido", "BX-2041", "Cliente", "María José Peña", "Dirección", "Córdoba 1234 Piso 3 Dto B", "Referencia", "Portón verde, timbre 2", "Bultos", "2 bultos"]) {
        // Los rótulos se muestran en mayúsculas por CSS.
        assert.ok(text.toLocaleLowerCase("es-AR").includes(expected.toLocaleLowerCase("es-AR")), expected)
      }
      // Nada financiero ni administrativo, ni navegación.
      assert.doesNotMatch(text, /\$|precio|pago|email|@|DNI|CUIT|saldo|Admin|Mis compras|Productos/i)
      assert.equal(await page.locator("nav, header, footer, a").count(), 0)
      const buttons = page.getByRole("button")
      assert.deepEqual((await buttons.allInnerTexts()).map((label) => label.replace(/\s+/g, " ")), ["✅ Entregado", "🏠 Cliente ausente", "⚠️ Problema con la entrega"])
      for (const box of await buttons.evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().toJSON() as DOMRect))) {
        assert.ok(box.height >= 60, `alto ${box.height}`)
        assert.ok(box.left >= 0 && box.right <= device.width, "dentro del ancho")
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "sin scroll horizontal")
      // Claro y legible: fondo blanco y texto oscuro de verdad (globals.css no los pisa).
      const colors = await page.locator("[data-courier-page]").evaluate((element) => {
        const order = element.querySelector("[data-courier-order]")!
        return { background: getComputedStyle(element).backgroundColor, text: getComputedStyle(order).color }
      })
      assert.equal(colors.background, "rgb(255, 255, 255)")
      assert.notEqual(colors.text, "rgb(255, 255, 255)", `texto oscuro: ${colors.text}`)
      assert.notEqual(colors.text, "rgba(0, 0, 0, 0)", `texto visible: ${colors.text}`)
      assert.deepEqual(errors, [])
      await shot(page, `cadete-inicial-${device.name}`)
    } finally { await page.close() }
  })
}

test("Entregado: confirmación corta, Volver no envía nada, Confirmar envía una sola vez aunque se toque dos veces", async () => {
  const { page, errors } = await open("actions", DEVICES[1])
  try {
    await page.getByRole("button", { name: /Entregado/ }).click()
    assert.ok((await page.locator("body").innerText()).includes("¿Confirmar que el pedido fue entregado?"))
    await shot(page, "cadete-confirmar-entregado")
    await page.getByRole("button", { name: "Volver" }).click()
    assert.equal(await page.getByRole("button", { name: /Cliente ausente/ }).count(), 1)
    assert.deepEqual(await requests(page), [])
    await page.getByRole("button", { name: /Entregado/ }).click()
    const confirm = page.getByRole("button", { name: "Confirmar" })
    await confirm.dblclick()
    await page.getByText("Pedido ya entregado").waitFor()
    const sent = await requests(page)
    assert.equal(sent.length, 1, "doble toque => un solo envío")
    assert.deepEqual(sent[0], { url: "/api/delivery/QrTokenDePrueba1234567890", body: { action: "delivered", expectedAttempts: 0 } })
    assert.ok((await page.locator("body").innerText()).includes("Entrega registrada. ¡Gracias!"))
    assert.equal(await page.getByRole("button").count(), 0, "terminado: sin acciones")
    assert.deepEqual(errors, [])
    await shot(page, "cadete-entregado")
  } finally { await page.close() }
})

test("Cliente ausente: 1.er intento queda pendiente; el 2.º avisa que vuelve a BEYONIX y ya no hay más ausencias", async () => {
  const { page, errors } = await open("actions", DEVICES[2])
  try {
    await page.getByRole("button", { name: /Cliente ausente/ }).click()
    assert.ok((await page.locator("body").innerText()).includes("¿Confirmar que no había nadie en el domicilio?"))
    await page.getByRole("button", { name: "Confirmar" }).click()
    await page.getByText("1 intento de entrega fallido").waitFor()
    await shot(page, "cadete-primer-intento")
    await page.getByRole("button", { name: /Cliente ausente/ }).click()
    const text = await page.locator("body").innerText()
    assert.ok(text.includes("Es el segundo intento: el pedido deberá regresar a BEYONIX."))
    await shot(page, "cadete-confirmar-segundo-intento")
    await page.getByRole("button", { name: "Confirmar" }).click()
    await page.getByText("El pedido debe regresar a BEYONIX.").first().waitFor()
    assert.deepEqual((await requests(page)).map((request) => request.body), [
      { action: "absent", expectedAttempts: 0 },
      { action: "absent", expectedAttempts: 1 },
    ])
    assert.equal(await page.getByRole("button", { name: /Cliente ausente/ }).count(), 0, "no existe un tercer intento")
    assert.deepEqual(errors, [])
    await shot(page, "cadete-regresando")
  } finally { await page.close() }
})

test("Problema con la entrega: opciones simples; 'Otro' exige comentario breve", async () => {
  const { page, errors } = await open("actions", DEVICES[0])
  try {
    await page.getByRole("button", { name: /Problema con la entrega/ }).click()
    const confirm = page.getByRole("button", { name: "Confirmar" })
    assert.equal(await confirm.isDisabled(), true, "sin opción elegida")
    for (const option of ["Dirección incorrecta", "No se pudo acceder al domicilio", "Cliente rechazó el pedido", "Otro"]) {
      assert.equal(await page.getByRole("radio", { name: option }).count(), 1, option)
    }
    await page.getByRole("radio", { name: "Otro" }).click()
    assert.equal(await confirm.isDisabled(), true, "Otro sin comentario")
    await page.getByRole("textbox").fill("Edificio sin portero, nadie responde")
    await shot(page, "cadete-problema-otro")
    await confirm.click()
    await page.getByText("Problema registrado").waitFor()
    assert.deepEqual((await requests(page)).map((request) => request.body), [
      { action: "incident", expectedAttempts: 0, reason: "other", comment: "Edificio sin portero, nadie responde" },
    ])
    assert.equal(await page.getByRole("button").count(), 0)
    assert.deepEqual(errors, [])
    await shot(page, "cadete-problema-registrado")
  } finally { await page.close() }
})

test("pedido ya finalizado o fuera de reparto: sólo estado informativo, sin acciones", async () => {
  for (const [screen, expected] of [
    ["delivered", "Pedido ya entregado"],
    ["returning", "El pedido debe regresar a BEYONIX."],
    ["returned", "Devuelto a BEYONIX"],
    ["incident", "Problema registrado"],
    ["cancelled", "Pedido cancelado"],
    ["preparing", "El pedido todavía no salió a reparto"],
  ] as const) {
    const { page, errors } = await open(screen, DEVICES[1])
    try {
      assert.ok((await page.locator("body").innerText()).includes(expected), screen)
      assert.equal(await page.getByRole("button").count(), 0, `${screen}: sin botones`)
      assert.deepEqual(errors, [])
      await shot(page, `cadete-final-${screen}`)
    } finally { await page.close() }
  }
})
