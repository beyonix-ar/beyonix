import assert from "node:assert/strict"
import test, { mock } from "node:test"
import { AuthClient } from "@supabase/supabase-js"

// Dashboard real (app/api/admin/dashboard/route.ts) contra PostgREST simulado:
// las compras de prueba (test_order_at) no cuentan en "Pedidos totales",
// "Pedidos pagos", ventas ni productos vendidos, pero sí en los controles
// fiscales (facturas) — sin tocar pagos ni facturación.

const COMMERCIAL = {
  id: 7, estado: "entregado", total: 1000, original_total: 1000, payment_status: "approved", payment_method_id: "mercadopago",
  financial_status: "payment_confirmed", paid_at: "2026-11-20T15:00:00.000Z", payment_confirmed_amount: 1000,
  invoice_status: "authorized", test_order_at: null, created_at: "2026-11-20T15:00:00.000Z",
}
const TEST_ORDER = { ...COMMERCIAL, id: 19, total: 20, original_total: 20, payment_confirmed_amount: 20, test_order_at: "2026-11-24T20:00:00.000Z" }
const ITEMS = [
  { id: 1, orden_id: 7, producto_id: 1, variante_id: 1, cantidad: 1, precio: 1000, productos: { id: 1, nombre: "PAVA ÁMBAR", categorias: null }, producto_variantes: null },
  { id: 26, orden_id: 19, producto_id: 22, variante_id: 22, cantidad: 1, precio: 20, productos: { id: 22, nombre: "AURICULAR ÑANDÚ", categorias: null }, producto_variantes: null },
]

test("dashboard: pedidos totales, pagos y ventas excluyen compras de prueba; facturación las conserva", async () => {
  const previousEnv = { ...process.env }
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://dashboard-tests.invalid"
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon"
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service"
  const countRequests: URLSearchParams[] = []
  const claims = mock.method(AuthClient.prototype, "getClaims", async () => ({ data: { claims: { sub: "owner" } }, error: null }))
  const errors = mock.method(console, "error", () => {})
  const fetchMock = mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = init?.method ?? "GET"
    if (url.pathname === "/rest/v1/profiles" && url.searchParams.get("id")) return Response.json({ id: "owner", email: null, rol: "super_admin" })
    if (url.pathname === "/rest/v1/ordenes" && method === "HEAD") {
      countRequests.push(url.searchParams)
      // Base simulada: 3 pedidos visibles, 1 de ellos prueba.
      const total = url.searchParams.get("test_order_at") === "is.null" ? 2 : 3
      return new Response(null, { status: 200, headers: { "content-range": `*/${total}` } })
    }
    if (url.pathname === "/rest/v1/ordenes" && (url.searchParams.get("select") ?? "").includes("original_total")) {
      return Number(url.searchParams.get("offset") ?? 0) === 0 ? Response.json([COMMERCIAL, TEST_ORDER]) : Response.json([])
    }
    if (url.pathname === "/rest/v1/orden_items") {
      return Number(url.searchParams.get("offset") ?? 0) === 0 ? Response.json(ITEMS) : Response.json([])
    }
    return Response.json([])
  })
  try {
    const route = await import("../../app/api/admin/dashboard/route")
    const response = await route.GET(new Request("http://localhost/api/admin/dashboard?refresh=1", { headers: { Authorization: "Bearer token" } }))
    assert.equal(response.status, 200)
    const payload = await response.json() as {
      stats: { totalOrdenes: number; pedidosPagados: number }
      financialSummary: { paidOrders: number; invoicedOrders: number; ordersWithoutInvoice: number }
      commercialSales: Array<{ orderId: string | null; productName: string }>
    }

    const total = countRequests.find((params) => params.get("admin_visible_at") === "not.is.null" && [...params.keys()].every((key) => ["select", "admin_visible_at", "test_order_at"].includes(key)))
    assert.equal(total?.get("test_order_at"), "is.null", "Pedidos totales filtra test_order_at")
    assert.equal(payload.stats.totalOrdenes, 2)
    assert.equal(payload.stats.pedidosPagados, 2)

    assert.equal(payload.financialSummary.paidOrders, 1, "ventas comerciales: sin la prueba")
    assert.equal(payload.financialSummary.invoicedOrders, 2, "facturación: la prueba sigue facturada")
    assert.equal(payload.financialSummary.ordersWithoutInvoice, 0)
    assert.ok(payload.commercialSales.length > 0)
    assert.ok(payload.commercialSales.every((sale) => sale.orderId !== "19" && sale.productName !== "AURICULAR ÑANDÚ"), "productos vendidos sin la prueba")
  } finally {
    claims.mock.restore(); fetchMock.mock.restore(); errors.mock.restore()
    for (const key of ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"]) {
      if (previousEnv[key] === undefined) delete process.env[key]; else process.env[key] = previousEnv[key]
    }
  }
})
