import assert from "node:assert/strict"
import test, { mock } from "node:test"
import { JSDOM } from "jsdom"
import { act } from "react"
import { AuthClient } from "@supabase/supabase-js"

test("ML real: componente → helper → API, primera revisión, corrección, 409 y doble click", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, navigator: dom.window.navigator, BroadcastChannel: undefined, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  }
  const env = { ...process.env }
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://ml-test.invalid"
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon"
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service"
  const { supabase } = await import("../supabase/client")
  const auth = mock.method(supabase.auth, "getSession", async () => ({ data: { session: { access_token: "test-token" } }, error: null }))
  const claims = mock.method(AuthClient.prototype, "getClaims", async () => ({ data: { claims: { sub: "actor" } }, error: null }))
  const { POST } = await import("../../app/api/admin/mercadolibre-sales/[id]/return-review/route")
  const { AdminMercadoLibreSales } = await import("../../app/admin/sections/dashboard/admin-mercadolibre-sales")
  const { SearchParamsContext } = await import("next/dist/shared/lib/hooks-client-context.shared-runtime")
  const { createRoot } = await import("react-dom/client")
  const root = createRoot(document.getElementById("root")!)
  let version: string | null = null
  let storedReview: Record<string, unknown> | null = null
  let requests = 0
  let rpcCalls = 0
  let role = "admin"
  const fetchMock = mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input)
    if (path === "/api/admin/mercadolibre-sales") return Response.json({ rows: [{ id: "sale-1", product_id: 1, product_name: "Ñandú", quantity: 3, sku: "ML-1", sale_date: "2026-09-20", raw_data: { parsed: { status: "Devolución" } }, return_review: storedReview, costing: { costable_units: 3, unit_cost: 100 } }], catalog: [] })
    if (path === "/api/admin/mercadolibre-sales/sale-1/return-review") {
      requests++
      return POST(new Request(`http://localhost${path}`, init), { params: Promise.resolve({ id: "sale-1" }) })
    }
    if (path.includes("/rest/v1/profiles")) return Response.json({ id: "actor", rol: role })
    if (path.includes("/rest/v1/mercadolibre_sales")) return Response.json({ id: "sale-1", sku: "ML-1", product_id: 1 })
    if (path.includes("/rest/v1/rpc/review_mercadolibre_return")) {
      rpcCalls++
      const body = JSON.parse(String(init?.body))
      if (body.p_expected_approved_at !== version) return Response.json({ message: "ML_RETURN_CONFLICT", code: "P0001" }, { status: 400 })
      assert.equal(body.p_received_quantity, 3)
      assert.equal(body.p_sellable_quantity, 1)
      assert.equal(body.p_discounted_quantity, 1)
      assert.equal(body.p_non_sellable_quantity, 1)
      if (version) assert.equal(body.p_correction_reason, "Revisión contrastada con depósito")
      version = version ? "2026-09-20T12:01:00.000Z" : "2026-09-20T12:00:00.000Z"
      storedReview = { received_quantity: 3, sellable_quantity: 1, discounted_quantity: 1, non_sellable_quantity: 1, discount_percent: 10, discount_reason: "Caja dañada", non_sellable_reason: "Roto", approved_at: version }
      return Response.json(storedReview)
    }
    throw new Error(`Petición inesperada: ${path}`)
  })
  const button = (label: string) => [...document.querySelectorAll("button")].find((node) => node.textContent?.includes(label))!
  const input = async (node: HTMLInputElement | HTMLTextAreaElement, value: string) => {
    const prototype = node.tagName === "TEXTAREA" ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype
    await act(async () => { Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(node, value); node.dispatchEvent(new dom.window.Event("input", { bubbles: true })) })
  }
  const openReview = async () => act(async () => document.querySelector<HTMLButtonElement>('button[aria-label^="Revisar devolución"],button[aria-label="Editar revisión física"]')!.click())
  try {
    await act(async () => root.render(<SearchParamsContext.Provider value={new URLSearchParams()}><AdminMercadoLibreSales /></SearchParamsContext.Provider>))
    await openReview()
    for (const label of ["Vendibles", "Con descuento", "No vendibles"]) {
      await act(async () => document.querySelector<HTMLButtonElement>(`button[aria-label="Sumar una unidad en ${label}"]`)!.click())
    }
    const dialog = document.querySelector('[role="dialog"]')!
    const textInputs = dialog.querySelectorAll<HTMLInputElement>('input[type="text"]:not([role="spinbutton"])')
    await input(textInputs[0], "10")
    await input(textInputs[1], "Caja dañada")
    await input(textInputs[2], "Roto")
    await act(async () => { button("Guardar revisión").click(); button("Guardar revisión").click() })
    assert.equal(requests, 1)
    assert.equal(rpcCalls, 1)
    assert.equal(document.querySelector('[role="dialog"]'), null)
    role = "super_admin"
    await openReview()
    assert.equal(button("Guardar revisión").disabled, true)
    await input(document.querySelector("textarea")!, "Revisión contrastada con depósito")
    await act(async () => button("Guardar revisión").click())
    assert.equal(rpcCalls, 2)
    await openReview()
    await input(document.querySelector("textarea")!, "Revisión contrastada con depósito")
    version = "2026-09-20T12:02:00.000Z"
    await act(async () => button("Guardar revisión").click())
    assert.match(document.querySelector('[role="dialog"]')!.textContent || "", /Esta devolución fue modificada por otro administrador. Recargá los datos antes de continuar./)
    assert.equal(version, "2026-09-20T12:02:00.000Z", "el conflicto no pisa la revisión ajena")
    role = "operador"
    const forbidden = await POST(new Request("http://localhost/review", { method: "POST", headers: { Authorization: "Bearer test-token" }, body: "{}" }), { params: Promise.resolve({ id: "sale-1" }) })
    assert.equal(forbidden.status, 403)
    assert.equal(rpcCalls, 3, "el operador no alcanza la RPC")
  } finally {
    await act(async () => root.unmount())
    fetchMock.mock.restore(); auth.mock.restore(); claims.mock.restore()
    await supabase.auth.stopAutoRefresh()
    for (const key of ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"]) {
      if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key]
    }
    dom.window.close()
    for (const [key, descriptor] of originals) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key)
  }
})
