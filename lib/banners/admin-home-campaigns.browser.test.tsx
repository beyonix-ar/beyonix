import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { build, type Plugin } from "esbuild"
import { chromium, type Browser, type Page } from "playwright-core"
import postcss from "postcss"
import tailwindcss from "@tailwindcss/postcss"

import { adminPageHtml } from "../admin/admin-config-browser-harness.ts"

// Configuración → Visuales → Banners con el componente REAL: pestañas Home y
// Productos, estados calculados con la hora del servidor, prioridad visible,
// alta con imágenes (firma real), fechas argentinas 24 h con fin inclusivo,
// validaciones antes de enviar, activar/desactivar, editar y eliminar.

const BUCKET = "https://eqxoupwuijobktxkmagr.supabase.co/storage/v1/object/public/site-banners/"
// 24/12/2026 12:00 en Argentina.
const SERVER_NOW = "2026-12-24T15:00:00.000Z"

const campaign = (id: string, overrides: Record<string, unknown>) => ({
  id, placement: "home", campaign_name: id, image_url: `${BUCKET}home/${id}.jpg`, mobile_image_url: null, alt_text: id, active: true,
  sort_order: 0, starts_at: null, ends_at: null, destination_url: null, created_at: "2026-11-01T00:00:00.000Z", updated_at: `2026-11-01T00:00:00.000000+00:00`, ...overrides,
})
const HOME = [
  campaign("Navidad", { sort_order: 0, starts_at: "2026-12-20T03:00:00.000Z", ends_at: "2026-12-27T03:00:00.000Z", destination_url: "/productos", mobile_image_url: `${BUCKET}home/mobile/n.jpg` }),
  campaign("Permanente", { sort_order: 5 }),
  campaign("Año nuevo", { sort_order: -1, starts_at: "2026-12-31T03:00:00.000Z", ends_at: "2027-01-02T03:00:00.000Z" }),
  campaign("Black Friday", { sort_order: 1, starts_at: "2026-11-27T03:00:00.000Z", ends_at: "2026-11-30T03:00:00.000Z" }),
  campaign("Pausada", { sort_order: -5, active: false }),
]
const PRODUCTS = [{ id: "p1", placement: "products", image_url: `${BUCKET}products/1.jpg`, alt_text: "Banner A", active: true, sort_order: 0, updated_at: "2026-11-01T00:00:00.000000+00:00" }]

const stubs: Plugin = {
  name: "admin-home-campaigns-stubs",
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^@\/lib\/supabase\/client$/ }, () => ({ path: "supabase", namespace: "stub" }))
    pluginBuild.onLoad({ filter: /^supabase$/, namespace: "stub" }, () => ({
      loader: "js",
      contents: `
        export const supabase = {
          auth: { getSession: async () => ({ data: { session: { access_token: "t" } }, error: null }) },
          storage: { from: (bucket) => ({
            upload: async (path, file, options) => { window.__uploads.push({ bucket, path, contentType: options.contentType, size: file.size }); return { data: { path }, error: null } },
            getPublicUrl: (path) => ({ data: { publicUrl: "${BUCKET}" + path } }),
          }) },
        }`,
    }))
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
        import { AdminBanners } from "@/app/admin/sections/banners/admin-banners";
        window.__uploads = []; window.__requests = []; window.__saves = 0;
        window.confirm = () => true;
        // createImageBitmap real necesita una imagen decodificable: para el aviso de medidas alcanza con el tamaño.
        window.createImageBitmap = async () => ({ width: 1920, height: 600, close() {} });
        window.fetch = async (url, init = {}) => {
          const method = init.method || "GET";
          const body = init.body ? JSON.parse(init.body) : null;
          window.__requests.push({ url: String(url), method, body });
          const placement = new URL(String(url), location.href).searchParams.get("placement");
          if (method === "GET") return Response.json({ banners: placement === "home" ? window.__HOME : window.__PRODUCTS, server_now: "${SERVER_NOW}" });
          if (method === "POST") { const saved = { ...body, id: "nueva", created_at: "${SERVER_NOW}" }; window.__HOME = [...window.__HOME, saved]; return Response.json({ banner: saved }); }
          if (method === "PATCH") {
            // Mismo control optimista que la API: versión distinta => 409 sin cambios.
            const list = placement === "products" || body.placement === "products" ? "__PRODUCTS" : "__HOME";
            const current = window[list].find((item) => item.id === body.id);
            if (!current) return Response.json({ error: "Banner no encontrado." }, { status: 404 });
            if (body.expected_updated_at !== current.updated_at) return Response.json({ error: "Este banner cambió desde que lo abriste (otro administrador lo modificó). Recargá los datos y revisalos antes de volver a guardar.", conflict: true }, { status: 409 });
            const { expected_updated_at, ...changes } = body;
            const saved = { ...current, ...changes, updated_at: "2026-12-24T15:" + String(++window.__saves).padStart(2, "0") + ":00.000000+00:00" };
            window[list] = window[list].map((item) => item.id === body.id ? saved : item);
            return Response.json({ banner: saved });
          }
          if (method === "DELETE") { const id = new URL(String(url), location.href).searchParams.get("id"); window.__HOME = window.__HOME.filter((item) => item.id !== id); return Response.json({ ok: true }); }
          return Response.json({ error: "?" }, { status: 400 });
        };
        createRoot(document.getElementById("root")).render(<AdminBanners embedded />);`,
      resolveDir: process.cwd(), loader: "tsx", sourcefile: "admin-home-campaigns-fixture.tsx",
    },
    bundle: true, platform: "browser", format: "iife", write: false,
    alias: { "@": process.cwd() }, jsx: "automatic", plugins: [stubs],
    define: { "process.env.NODE_ENV": '"production"', "process.env.NEXT_PUBLIC_SUPABASE_URL": '"https://eqxoupwuijobktxkmagr.supabase.co"' },
    logLevel: "error",
  })
  bundle = result.outputFiles[0].text
  browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chrome", headless: true })
})

test.after(async () => { await browser?.close() })

async function open(theme: "dark" | "light" = "dark", width = 1280) {
  const page = await browser.newPage({ viewport: { width, height: 1000 } })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.route("http://admin.test/**", (route) => route.fulfill({ contentType: "text/html; charset=utf-8", body: adminPageHtml(theme, css, bundle) }))
  await page.addInitScript(({ home, products }) => {
    Object.assign(window, { __HOME: home, __PRODUCTS: products })
  }, { home: HOME, products: PRODUCTS })
  await page.goto("http://admin.test/")
  await page.locator("[data-home-campaign-row]").first().waitFor({ timeout: 10_000 })
  return { page, errors }
}

const row = (page: Page, id: string) => page.locator(`[data-home-campaign-row='${id}']`)
const requests = (page: Page) => page.evaluate(() => (window as unknown as { __requests: Array<{ url: string; method: string; body: Record<string, unknown> | null }> }).__requests)
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1])

for (const theme of ["dark", "light"] as const) {
  test(`${theme}: estados con la hora del servidor y qué campaña se ve ahora en el Home`, async () => {
    const { page, errors } = await open(theme)
    try {
      assert.equal(await page.getByRole("tab", { name: "Home" }).getAttribute("aria-selected"), "true")
      const status = async (id: string) => row(page, id).getAttribute("data-home-campaign-status")
      assert.deepEqual(
        [await status("Navidad"), await status("Permanente"), await status("Año nuevo"), await status("Black Friday"), await status("Pausada")],
        ["active", "active", "scheduled", "ended", "disabled"],
      )
      assert.equal(await page.locator("[data-home-campaign-showing]").count(), 1)
      assert.equal(await row(page, "Navidad").locator("[data-home-campaign-showing]").count(), 1, "la vigente de menor prioridad")
      assert.match(await row(page, "Permanente").innerText(), /Vigente, con menor prioridad/i)
      assert.match(await row(page, "Navidad").innerText(), /Desde [a-záéíóú]{3} 20\/12\/2026 00:00 · hasta [a-záéíóú]{3} 26\/12\/2026 23:59 inclusive/)
      assert.match(await row(page, "Permanente").innerText(), /Permanente/)
      for (const label of ["Activa", "Programada", "Finalizada", "Desactivada"]) assert.match(await page.locator("[data-home-campaigns]").innerText(), new RegExp(label, "i"))
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "sin desborde")
      if (process.env.HOME_CAMPAIGN_SCREENSHOTS) await page.screenshot({ path: `${process.env.HOME_CAMPAIGN_SCREENSHOTS}/admin-home-campaigns-${theme}.png`, fullPage: true })
      assert.deepEqual(errors, [])
    } finally { await page.close() }
  })
}

test("crear campaña: imágenes con su tipo real, fechas en hora argentina 24 h (fin inclusivo) y enlace interno", async () => {
  const { page, errors } = await open()
  try {
    await page.getByRole("textbox", { name: "Nombre de la campaña" }).fill("Reyes 2027")
    await page.locator("[data-home-campaign-file='desktop']").setInputFiles({ name: "reyes.JPG", mimeType: "image/jpeg", buffer: JPEG })
    await page.getByText("Imagen subida. Guardá la campaña para aplicarla.").waitFor()
    await page.locator("[data-home-campaign-file='mobile']").setInputFiles({ name: "reyes móvil.jpeg", mimeType: "image/jpeg", buffer: JPEG })
    await page.getByText(/se recomienda 1920 × 480 px/).waitFor()
    const uploads = await page.evaluate(() => (window as unknown as { __uploads: Array<{ bucket: string; path: string; contentType: string }> }).__uploads)
    assert.deepEqual(uploads.map((upload) => [upload.bucket, upload.contentType]), [["site-banners", "image/jpeg"], ["site-banners", "image/jpeg"]])
    assert.match(uploads[0].path, /^home\/\d+-reyes\.jpg$/)
    assert.match(uploads[1].path, /^home\/mobile\/\d+-reyes-movil\.jpg$/)
    assert.equal(await page.locator("[data-home-campaign-previews] img").count(), 2, "vista previa de escritorio y celular")

    await page.getByRole("textbox", { name: "Inicio: fecha" }).fill("05012027")
    await page.getByRole("textbox", { name: "Inicio: hora" }).fill("0900")
    assert.equal(await page.getByRole("textbox", { name: "Inicio: hora" }).inputValue(), "09:00")
    await page.getByRole("textbox", { name: "Fin: fecha" }).fill("06012027")
    await page.getByRole("textbox", { name: "Fin: hora" }).fill("2359")
    await page.getByRole("textbox", { name: "Enlace de destino" }).fill("/productos?categoria=juguetes")
    await page.getByRole("textbox", { name: "Orden de prioridad" }).fill("3")
    await page.getByRole("button", { name: "Guardar campaña" }).click()
    await page.getByText("Campaña creada.").waitFor()
    const post = (await requests(page)).find((request) => request.method === "POST")
    assert.deepEqual({ ...post?.body, image_url: undefined, mobile_image_url: undefined }, {
      id: null, placement: "home", campaign_name: "Reyes 2027", alt_text: "", active: true, sort_order: 3,
      starts_at: "2027-01-05T12:00:00.000Z", ends_at: "2027-01-07T03:00:00.000Z", destination_url: "/productos?categoria=juguetes",
      image_url: undefined, mobile_image_url: undefined,
    })
    assert.match(String(post?.body?.image_url), /^https:\/\/eqxoupwuijobktxkmagr\.supabase\.co\/storage\/v1\/object\/public\/site-banners\/home\//)
    await row(page, "nueva").waitFor()
    assert.equal(await row(page, "nueva").getAttribute("data-home-campaign-status"), "scheduled")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("validaciones antes de enviar: SVG, archivo grande, enlace peligroso, fin anterior al inicio, hora inválida", async () => {
  const { page } = await open()
  try {
    await page.locator("[data-home-campaign-file='desktop']").setInputFiles({ name: "logo.svg", mimeType: "image/svg+xml", buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>') })
    await page.getByText("Formato no admitido. Usá JPG, PNG, WebP o AVIF.").waitFor()
    await page.locator("[data-home-campaign-file='desktop']").setInputFiles({ name: "falso.jpg", mimeType: "image/jpeg", buffer: Buffer.from("<html>no soy una imagen</html>") })
    await page.getByText("Formato no admitido. Usá JPG, PNG, WebP o AVIF.").waitFor()
    await page.locator("[data-home-campaign-file='desktop']").setInputFiles({ name: "enorme.jpg", mimeType: "image/jpeg", buffer: Buffer.concat([JPEG, Buffer.alloc(5 * 1024 * 1024)]) })
    await page.getByText("La imagen supera los 5 MB.").waitFor()
    assert.equal((await page.evaluate(() => (window as unknown as { __uploads: unknown[] }).__uploads)).length, 0, "nada llegó al bucket")

    await page.locator("[data-home-campaign-file='desktop']").setInputFiles({ name: "ok.jpg", mimeType: "image/jpeg", buffer: JPEG })
    await page.getByText("Imagen subida. Guardá la campaña para aplicarla.").waitFor()
    await page.getByRole("textbox", { name: "Nombre de la campaña" }).fill("Prueba")
    const save = page.getByRole("button", { name: "Guardar campaña" })
    const error = page.locator("[data-home-campaigns-error]")

    await page.getByRole("textbox", { name: "Enlace de destino" }).fill("javascript:alert(1)")
    await save.click()
    assert.match(await error.innerText(), /enlace/i)
    await page.getByRole("textbox", { name: "Enlace de destino" }).fill("https://evil.example/")
    await save.click()
    assert.match(await error.innerText(), /Dominio externo no admitido/)
    await page.getByRole("textbox", { name: "Enlace de destino" }).fill("")

    await page.getByRole("textbox", { name: "Inicio: fecha" }).fill("10012027")
    await page.getByRole("textbox", { name: "Fin: fecha" }).fill("10012027")
    await page.getByRole("textbox", { name: "Inicio: hora" }).fill("1000")
    await page.getByRole("textbox", { name: "Fin: hora" }).fill("0900")
    await save.click()
    assert.match(await error.innerText(), /posterior a la de inicio/)
    await page.getByRole("textbox", { name: "Fin: hora" }).fill("9999")
    await save.click()
    assert.match(await error.innerText(), /HH:MM \(24 horas\)/)
    assert.equal((await requests(page)).filter((request) => request.method !== "GET").length, 0, "no se envió nada")
  } finally { await page.close() }
})

test("editar (fin inclusivo de vuelta en el formulario), desactivar sin perder datos y eliminar", async () => {
  const { page, errors } = await open("light", 390)
  try {
    await row(page, "Navidad").getByRole("button", { name: "Editar campaña" }).click()
    assert.equal(await page.getByRole("textbox", { name: "Nombre de la campaña" }).inputValue(), "Navidad")
    assert.equal(await page.getByRole("textbox", { name: "Fin: fecha" }).inputValue(), "26/12/2026")
    assert.equal(await page.getByRole("textbox", { name: "Fin: hora" }).inputValue(), "23:59")
    assert.equal(await page.getByRole("textbox", { name: "Inicio: hora" }).inputValue(), "00:00")

    await row(page, "Navidad").getByRole("button", { name: "Desactivar", exact: true }).click()
    await page.getByText("Campaña desactivada.").waitFor()
    const patch = (await requests(page)).find((request) => request.method === "PATCH")
    assert.deepEqual(patch?.body, { id: "Navidad", active: false, expected_updated_at: "2026-11-01T00:00:00.000000+00:00" }, "sólo el estado y la versión vista: el resto lo conserva el servidor")
    await page.waitForFunction(() => document.querySelector("[data-home-campaign-row='Navidad']")?.getAttribute("data-home-campaign-status") === "disabled")
    assert.equal(await row(page, "Permanente").locator("[data-home-campaign-showing]").count(), 1, "pasa a verse la permanente")

    await row(page, "Black Friday").getByRole("button", { name: "Eliminar campaña" }).click()
    await page.getByText("Campaña eliminada.").waitFor()
    assert.ok((await requests(page)).some((request) => request.method === "DELETE" && request.url.endsWith("?id=Black%20Friday")))
    assert.equal(await row(page, "Black Friday").count(), 0)
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "sin desborde en celular")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("pestaña Productos: el panel de siempre, con sus banners y sin campos de campaña", async () => {
  const { page, errors } = await open()
  try {
    await page.getByRole("tab", { name: "Productos" }).click()
    await page.getByText("Banners cargados").waitFor()
    assert.match(await page.locator("body").innerText(), /Banner A/)
    assert.ok((await requests(page)).some((request) => request.url === "/api/admin/banners?placement=products"))
    assert.equal(await page.getByRole("textbox", { name: "Nombre de la campaña" }).count(), 0)
    assert.equal(await page.getByRole("button", { name: "Guardar banner" }).count(), 1)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

/** Otro administrador (en otra pestaña) guarda la campaña: cambia su versión. */
const otherAdminSaves = (page: Page, id: string, changes: Record<string, unknown>) => page.evaluate(([target, values]) => {
  const scope = window as unknown as { __HOME: Array<Record<string, unknown>> }
  scope.__HOME = scope.__HOME.map((item) => item.id === target ? { ...item, ...values, updated_at: "2026-12-24T16:00:00.000000+00:00" } : item)
}, [id, changes] as const)

test("dos administradores: guardar un formulario viejo no reactiva lo que otro desactivó; 'Recargar datos' trae lo actual", async () => {
  const { page, errors } = await open()
  try {
    await row(page, "Navidad").getByRole("button", { name: "Editar campaña" }).click()
    const stateButton = page.locator("[data-home-campaigns] button", { hasText: /^Activada$|^Desactivada$/ })
    assert.equal((await stateButton.innerText()).trim(), "Activada", "el formulario la abrió activada")
    // Mientras tanto, otro administrador la desactiva.
    await otherAdminSaves(page, "Navidad", { active: false })
    await page.getByRole("textbox", { name: "Nombre de la campaña" }).fill("Navidad 2026")
    await page.getByRole("button", { name: "Guardar campaña" }).click()
    const error = page.locator("[data-home-campaigns-error]")
    await error.waitFor()
    assert.match(await error.innerText(), /otro administrador/)
    const stored = await page.evaluate(() => (window as unknown as { __HOME: Array<{ id: string; active: boolean; campaign_name: string }> }).__HOME.find((item) => item.id === "Navidad"))
    assert.deepEqual([stored?.active, stored?.campaign_name], [false, "Navidad"], "nada se pisó")

    await page.getByRole("button", { name: "Recargar datos" }).click()
    await page.getByText("Datos actualizados. Revisalos y volvé a guardar si hace falta.").waitFor()
    assert.equal((await stateButton.innerText()).trim(), "Desactivada", "el formulario muestra lo guardado por el otro")
    assert.equal(await page.getByRole("textbox", { name: "Nombre de la campaña" }).inputValue(), "Navidad")
    // Ahora sí guarda sobre la versión nueva, sin reactivarla.
    await page.getByRole("textbox", { name: "Nombre de la campaña" }).fill("Navidad 2026")
    await page.getByRole("button", { name: "Guardar campaña" }).click()
    await page.getByText("Campaña actualizada.").waitFor()
    const saved = await page.evaluate(() => (window as unknown as { __HOME: Array<{ id: string; active: boolean; campaign_name: string }> }).__HOME.find((item) => item.id === "Navidad"))
    assert.deepEqual([saved?.active, saved?.campaign_name], [false, "Navidad 2026"])

    // Activar/desactivar desde una lista vieja también se rechaza.
    await otherAdminSaves(page, "Permanente", { campaign_name: "Permanente editada" })
    await row(page, "Permanente").getByRole("button", { name: "Desactivar", exact: true }).click()
    await error.waitFor()
    assert.match(await error.innerText(), /otro administrador/)
    const permanent = await page.evaluate(() => (window as unknown as { __HOME: Array<{ id: string; active: boolean }> }).__HOME.find((item) => item.id === "Permanente"))
    assert.equal(permanent?.active, true)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("prioridad inválida: se avisa antes de enviar (decimal, texto, vacía o fuera de rango)", async () => {
  const { page } = await open()
  try {
    await page.locator("[data-home-campaign-file='desktop']").setInputFiles({ name: "ok.jpg", mimeType: "image/jpeg", buffer: JPEG })
    await page.getByText("Imagen subida. Guardá la campaña para aplicarla.").waitFor()
    await page.getByRole("textbox", { name: "Nombre de la campaña" }).fill("Prueba")
    for (const value of ["1.5", "abc", "", "1000"]) {
      await page.getByRole("textbox", { name: "Orden de prioridad" }).fill(value)
      await page.getByRole("button", { name: "Guardar campaña" }).click()
      assert.match(await page.locator("[data-home-campaigns-error]").innerText(), /número entero entre -999 y 999/, value)
    }
    assert.equal((await requests(page)).filter((request) => request.method !== "GET").length, 0)
  } finally { await page.close() }
})

test("formatos: el Home rechaza GIF; Productos lo sigue aceptando (con su tipo real)", async () => {
  const GIF = Buffer.from("GIF89a\u0001\u0000\u0001\u0000", "latin1")
  const { page, errors } = await open()
  try {
    await page.locator("[data-home-campaign-file='desktop']").setInputFiles({ name: "animado.gif", mimeType: "image/gif", buffer: GIF })
    await page.getByText("Formato no admitido. Usá JPG, PNG, WebP o AVIF.").waitFor()
    assert.equal((await page.evaluate(() => (window as unknown as { __uploads: unknown[] }).__uploads)).length, 0)

    await page.getByRole("tab", { name: "Productos" }).click()
    await page.getByText("Banners cargados").waitFor()
    assert.match(await page.locator("input[type='file']").getAttribute("accept") ?? "", /image\/gif/)
    await page.locator("input[type='file']").setInputFiles({ name: "animado.gif", mimeType: "image/gif", buffer: GIF })
    await page.getByText("Imagen subida y banner guardado.").waitFor()
    const uploads = await page.evaluate(() => (window as unknown as { __uploads: Array<{ path: string; contentType: string }> }).__uploads)
    assert.deepEqual(uploads.map((upload) => upload.contentType), ["image/gif"])
    assert.match(uploads[0].path, /^products\/\d+-animado\.gif$/)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
