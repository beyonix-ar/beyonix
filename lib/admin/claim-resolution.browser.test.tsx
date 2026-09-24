import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import postcss from "postcss"
import tailwindcss from "@tailwindcss/postcss"
import { build, type Plugin } from "esbuild"
import { chromium, type Browser, type Page } from "playwright-core"

// Resolución de un reclamo finalizado con los componentes REALES (bundle
// esbuild) y el CSS del proyecto: "Mi cuenta > Reclamo" (CustomerClaimExperience)
// y "Admin > Pedido > Atención al cliente" (AdminClaimManager), leyendo el
// mismo order_claims.resolution_summary que congela la base.
// Stubs sólo de infraestructura: auth, Supabase, router y fetch.

const stubs: Plugin = {
  name: "claim-resolution-stubs",
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^@\/context\/auth-context$/ }, () => ({ path: "auth", namespace: "stub" }))
    pluginBuild.onResolve({ filter: /^@\/lib\/supabase\/client$/ }, () => ({ path: "supabase", namespace: "stub" }))
    pluginBuild.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: "navigation", namespace: "stub" }))
    pluginBuild.onLoad({ filter: /^auth$/, namespace: "stub" }, () => ({
      contents: `export function useAuth() { return { user: { rol: "admin" } } }`,
      loader: "js",
    }))
    pluginBuild.onLoad({ filter: /^navigation$/, namespace: "stub" }, () => ({
      contents: `const router = { push() {}, replace() {}, refresh() {}, back() {}, prefetch() {} }
        export function useRouter() { return router }
        export function usePathname() { return "/cuenta/compras/500/ayuda" }
        export function useSearchParams() { return new URLSearchParams() }`,
      loader: "js",
    }))
    pluginBuild.onLoad({ filter: /^supabase$/, namespace: "stub" }, () => ({
      contents: `
        const channel = { on() { return channel }, subscribe() { return channel } }
        export const supabase = {
          auth: { getSession: async () => ({ data: { session: null }, error: null }) },
          channel: () => channel,
          removeChannel: async () => "ok",
        }
        export function createClient() { return supabase }
        export function isInvalidRefreshTokenError() { return false }
        export function isMissingAuthSessionError() { return false }
        export function clearSupabaseBrowserSession() {}
        export async function getSafeSupabaseSession() { return null }
      `,
      loader: "js",
    }))
  },
}

const ENTRY = `
import { createElement } from "react"
import { createRoot } from "react-dom/client"
import { AdminClaimManager } from "@/components/claims/admin-claim-manager"
import { CustomerClaimExperience } from "@/components/claims/customer-claim-experience"

const scenario = new URLSearchParams(location.search).get("scenario")
const summaries = {
  saldo: { kind: "saldo_a_favor", label: "Saldo a favor", detail: "Se acreditaron $27.900 en tu cuenta BEYONIX.", amount: 27900, notice: "Se acreditó saldo a favor en tu cuenta." },
  rechazado: { kind: "rechazado", label: "Reclamo no aprobado", detail: "Motivo: El producto presenta daño por mal uso.", amount: null, notice: "El reclamo no fue aprobado." },
  cambio: { kind: "cambio_producto", label: "Cambio de producto", detail: "Se registró el reemplazo correspondiente.", amount: null, notice: "Se aprobó un cambio de producto." },
  historico: null,
}
const summary = summaries[scenario]
const status = scenario === "rechazado" ? "rechazado" : "cerrado"
const resolution = { saldo: "saldo_a_favor", rechazado: "rechazado", cambio: "cambio_producto", historico: "cambio_producto" }[scenario]
const closingMessage = summary
  ? "BEYONIX resolvió el reclamo.\\nResolución: " + summary.label + "." + (summary.detail ? "\\n" + summary.detail : "")
  : "BEYONIX finalizó el reclamo."
const producto = { id: 1, nombre: "Auricular Ñandú", slug: "a", descripcion: null, precio: 20000, precio_anterior: null, descuento: null, cuotas_2_habilitadas: false, cuotas_3_habilitadas: false, cuotas_6_habilitadas: false, stock: 4, categoria_id: null, destacado: false, activo: true, imagen_principal: null, video_url: null, created_at: "2026-09-01" }
const claim = {
  id: 900, order_id: 500, user_id: "c", claim_type: "garantia_beyonix", failure_type: "falla",
  status, resolution, resolution_summary: summary,
  rejection_reason: scenario === "rechazado" ? "El producto presenta daño por mal uso." : null,
  description: "Producto afectado: Auricular Ñandú\\n\\nNo enciende.",
  affected_items: [{ order_item_id: 71, quantity: 1 }],
  order_claim_messages: [
    { id: 1, claim_id: 900, author_role: "cliente", message: "El auricular no enciende.", created_at: "2026-09-20T10:00:00Z" },
    { id: 2, claim_id: 900, author_role: "admin", message: closingMessage, created_at: "2026-09-21T10:05:00Z" },
  ],
  order_claim_files: [],
  closed_at: "2026-09-21T10:05:00Z", created_at: "2026-09-20T10:00:00Z", updated_at: "2026-09-21T10:05:00Z",
}
const pedido = {
  id: 500, usuario_id: "c", estado: "entregado", delivered_at: "2026-09-18T12:00:00Z", total: 20000, created_at: "2026-09-15T12:00:00Z",
  payment_method_id: "mercadopago", shipping_type: "domicilio",
  orden_items: [{ id: 71, orden_id: 500, producto_id: 1, cantidad: 1, precio: 20000, productos: producto }],
  order_claims: [claim],
}
window.fetch = async (input) => {
  const url = String(input)
  if (url.endsWith("/api/orders/500/claims")) return Response.json({ claims: [claim] })
  if (url.endsWith("/claims/read")) return Response.json({ ok: true })
  return Response.json({ error: "sin datos en el test" }, { status: 404 })
}
createRoot(document.getElementById("customer-root")).render(createElement(CustomerClaimExperience, { order: pedido, claimsVerified: true }))
createRoot(document.getElementById("admin-root")).render(createElement(AdminClaimManager, {
  pedido, mode: "all", onClaimChange: () => {}, onOpenBilling: () => {}, onInventoryUpdated: () => {},
  registeredReplacements: scenario === "cambio" ? [{ original_order_id: 500, original_order_item_id: 71, claim_id: 900, quantity: 1 }] : [], replacementLoadState: "ready",
}))
`

const pageHtml = (theme: "dark" | "light", css: string, bundle: string) => `<!doctype html>
<html data-admin-theme="${theme}"><head><style>${css}</style></head><body>
<main><div id="customer-root"></div></main>
<div class="beyonix-admin-shell"><main class="beyonix-admin-main"><div>
  <div class="admin-order-detail-scope bx-surface bx-surface-section mx-auto flex w-full max-w-[1420px] flex-col overflow-hidden rounded-xl border border-white/10 bg-[#05070A]">
    <div class="bx-surface-inherit min-h-0 flex-1 bg-[#05070A]">
      <div class="admin-order-detail-content min-w-0 flex-1"><div id="admin-root"></div></div>
    </div>
  </div>
</div></main></div>
<script>${bundle}</script></body></html>`

let browser: Browser
let css: string
let bundle: string

test.before(async () => {
  const source = readFileSync("app/globals.css", "utf8")
  css = (await postcss([tailwindcss({ base: process.cwd() })]).process(source, { from: "app/globals.css" })).css
  const result = await build({
    stdin: { contents: ENTRY, resolveDir: process.cwd(), loader: "tsx", sourcefile: "claim-resolution-entry.tsx" },
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

test.after(async () => {
  await browser?.close()
})

async function open(scenario: string, theme: "dark" | "light" = "dark"): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1400 } })
  const html = pageHtml(theme, css, bundle)
  await page.route("**/*", (route) =>
    route.request().url().startsWith("http://localhost/claim") ? route.fulfill({ contentType: "text/html", body: html }) : route.abort(),
  )
  await page.goto(`http://localhost/claim?scenario=${scenario}`)
  await page.waitForSelector("[data-testid=customer-claim-resolution]")
  await page.waitForSelector("[data-testid=admin-claim-resolution]")
  return page
}

const text = async (page: Page, selector: string) => (await page.locator(selector).innerText()).replace(/\s+/g, " ").trim()
const CUSTOMER = "[data-testid=customer-claim-resolution]"
const ADMIN = "[data-testid=admin-claim-resolution]"

test("8-9. saldo a favor: cliente y admin muestran resolución, detalle y monto", async () => {
  const page = await open("saldo")
  try {
    const customer = await text(page, CUSTOMER)
    assert.match(customer, /^Resolución del reclamo Resolución Saldo a favor Detalle Se acreditaron \$27\.900 en tu cuenta BEYONIX\. Saldo acreditado \$\s?27\.900$/)
    const admin = await text(page, ADMIN)
    assert.match(admin, /^Reclamo finalizado Resolución Saldo a favor Detalle Se acreditaron \$27\.900 en tu cuenta BEYONIX\. Saldo acreditado \$\s?27\.900/)
    assert.equal(await page.locator(CUSTOMER).isVisible(), true)
    assert.equal(await page.locator(ADMIN).isVisible(), true)
    // El aviso de "solución en proceso" no convive con la resolución final.
    assert.equal(await page.getByText("Solución en proceso").count(), 0)
  } finally { await page.close() }
})

test("7. rechazo: bloque único con motivo (sin duplicar el aviso anterior)", async () => {
  const page = await open("rechazado", "light")
  try {
    assert.equal(await text(page, CUSTOMER), "Resolución del reclamo Resolución Reclamo no aprobado Detalle Motivo: El producto presenta daño por mal uso.")
    // Motivo: una vez en el bloque y otra en el mensaje de cierre del chat
    // (el bloque de rechazo anterior lo repetía una tercera vez).
    const customerText = await page.locator("#customer-root").innerText()
    assert.equal(customerText.split("daño por mal uso").length - 1, 2, "sin el bloque de rechazo anterior")
    assert.match(await text(page, ADMIN), /^Reclamo rechazado Resolución Reclamo no aprobado Detalle Motivo: El producto presenta daño por mal uso\./)
  } finally { await page.close() }
})

test("admin: cambio de producto suma las unidades de reemplazo registradas", async () => {
  const page = await open("cambio")
  try {
    assert.match(await text(page, ADMIN), /Resolución Cambio de producto Detalle Se registró el reemplazo correspondiente\. Reemplazo 1 unidad registrada con salida de stock\./)
    assert.match(await page.locator("#customer-root").innerText(), /Resolución: Cambio de producto\./, "el mensaje de cierre queda en el chat")
  } finally { await page.close() }
})

test("13. histórico sin resumen: 'Reclamo finalizado' sin inventar resolución", async () => {
  const page = await open("historico")
  try {
    assert.equal(await text(page, CUSTOMER), "Resolución del reclamo Resolución Reclamo finalizado")
    assert.equal(await page.locator(`${ADMIN} dl`).count(), 0)
    assert.equal(await page.locator(CUSTOMER).getByText("Cambio de producto").count(), 0)
  } finally { await page.close() }
})

test("historial y campana: contratos de integración", () => {
  const pedidos = readFileSync("app/admin/sections/pedidos/admin-pedidos.tsx", "utf8")
  assert.match(pedidos, /title: claimIsHelpMessage \? baseTitle : getClaimResolutionHistoryTitle\(baseTitle, claim\),/)
  const bell = readFileSync("components/customer-notifications-bell.tsx", "utf8")
  assert.match(bell, /if \(type === "claim_resolved"\) return BadgeCheck/)
  assert.match(bell, /notification\.type === "claim_resolved" \|\|/)
})
