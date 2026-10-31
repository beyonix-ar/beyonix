import assert from "node:assert/strict"
import test, { mock } from "node:test"
import { AuthClient } from "@supabase/supabase-js"

// Rutas de Admin > Ventas Mercado Libre con Supabase simulado a nivel HTTP:
// el bloqueo de líneas sin vínculo en lotes que descuentan stock y la
// ausencia de vinculaciones automáticas de ventas consume legadas.

const ADMIN = "10000000-0000-4000-8000-000000000001"
const BATCH = "30000000-0000-4000-8000-000000000001"
const ENV_KEYS = ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"] as const

type Row = Record<string, unknown>
type Request_ = { method: string; table: string; url: URL; body: unknown }

/** Aplica los filtros PostgREST simples que usan estas rutas (eq / is.null / not.is.null / in). */
function matches(row: Row, url: URL) {
  for (const [column, condition] of url.searchParams) {
    if (["select", "order", "limit", "offset"].includes(column)) continue
    const value = row[column] ?? null
    if (condition === "is.null" && value !== null) return false
    if (condition === "not.is.null" && value === null) return false
    if (condition.startsWith("eq.") && String(value) !== condition.slice(3)) return false
    if (condition.startsWith("in.(")) {
      const list = condition.slice(4, -1).split(",").map((item) => item.replace(/^"|"$/g, ""))
      if (!list.includes(String(value))) return false
    }
  }
  return true
}

async function withSupabase(tables: Record<string, Row[]>, run: (requests: Request_[]) => Promise<void>) {
  const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://ml-import.invalid"
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon"
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key-with-enough-length"
  const requests: Request_[] = []
  const claims = mock.method(AuthClient.prototype, "getClaims", async () => ({ data: { claims: { sub: ADMIN } }, error: null }))
  const fetchMock = mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const method = init?.method ?? "GET"
    if (url.pathname === "/rest/v1/profiles") return Response.json({ id: ADMIN, email: null, rol: "admin" })
    const table = url.pathname.replace(/^\/rest\/v1\//, "")
    const body = init?.body ? JSON.parse(String(init.body)) : null
    requests.push({ method, table, url, body })
    if (table.startsWith("rpc/")) return Response.json({ received: 1, inserted: 1, updated: 0, unchanged: 0, duplicate_rows: 0 })
    const rows = (tables[table] ?? []).filter((row) => matches(row, url))
    if (method === "PATCH") return Response.json([])
    if (method === "HEAD") return new Response(null, { status: 200, headers: { "Content-Range": `0-0/${rows.length}` } })
    const accept = new Headers(init?.headers).get("Accept") ?? ""
    if (accept.includes("vnd.pgrst.object")) return Response.json(rows[0] ?? null)
    return Response.json(rows)
  })
  try {
    await run(requests)
  } finally {
    claims.mock.restore()
    fetchMock.mock.restore()
    for (const key of ENV_KEYS) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
  }
}

const catalog = [{ id: 10, nombre: "Apoyabrazos", sku: "AP01", activo: true, producto_variantes: [] }]

function importRow(operation: string, sku: string) {
  return {
    sale_date: "2026-05-13T10:00:00-03:00",
    operation_id: operation,
    order_id: operation,
    product_name: "Producto",
    sku,
    quantity: 2,
    gross_amount: 20000,
    fee_amount: 2600,
    shipping_amount: 0,
    net_amount: 17400,
    raw_data: {
      report_format: "mercadolibre_ventas_ar",
      parsed: { status: "Entregado", units: 2, listing_id: `MLA${operation.slice(-6)}`, variant: null },
      grouped: {},
      source: { sheet: "Ventas AR", row_number: 7, cells: [] },
    },
  }
}

const post = (body: unknown) =>
  new Request("http://localhost/api/admin/mercadolibre-sales/import", {
    method: "POST",
    headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })

test("HTTP: un lote que descuenta stock con una línea nueva sin vínculo responde 409 y no llama a la RPC", async () => {
  const route = await import("../../app/api/admin/mercadolibre-sales/import/route")
  await withSupabase(
    { productos: catalog, mercadolibre_import_batches: [{ id: BATCH, stock_effect: "consume" }] },
    async (requests) => {
      const response = await route.POST(post({
        batchId: BATCH,
        // Aun pidiendo "Importar sin vincular": con consume no hay excepción.
        allowUnlinked: true,
        rows: [importRow("2000000000000001", "AP01"), importRow("2000000000000002", "SKU-DESCONOCIDO")],
      }))
      assert.equal(response.status, 409)
      const payload = (await response.json()) as { error: string; unlinked: number }
      assert.match(payload.error, /descuenta stock y hay líneas sin producto vinculado/)
      assert.equal(payload.unlinked, 1)
      assert.equal(requests.filter((request) => request.table.startsWith("rpc/")).length, 0, "no se guarda nada")
    },
  )
})

test("HTTP: sin impacto en stock, la línea sin vínculo pasa sólo con aceptación explícita", async () => {
  const route = await import("../../app/api/admin/mercadolibre-sales/import/route")
  await withSupabase(
    { productos: catalog, mercadolibre_import_batches: [{ id: BATCH, stock_effect: "none" }] },
    async (requests) => {
      const rows = [importRow("2000000000000003", "SKU-DESCONOCIDO")]
      const refused = await route.POST(post({ batchId: BATCH, rows }))
      assert.equal(refused.status, 409)
      const accepted = await route.POST(post({ batchId: BATCH, rows, allowUnlinked: true }))
      assert.equal(accepted.status, 200)
      const rpc = requests.filter((request) => request.table === "rpc/import_mercadolibre_sales_batch")
      assert.equal(rpc.length, 1)
      assert.equal((rpc[0].body as { p_rows: Array<{ product_id?: number }> }).p_rows[0].product_id, undefined)
    },
  )
})

test("HTTP: un lote consume con una venta legada sin vínculo ya existente no la vincula ni bloquea", async () => {
  const route = await import("../../app/api/admin/mercadolibre-sales/import/route")
  const legacy = importRow("2000000000000004", "AP01")
  await withSupabase(
    {
      productos: catalog,
      mercadolibre_import_batches: [{ id: BATCH, stock_effect: "consume" }],
      mercadolibre_sales: [{ id: "legacy", ...legacy, product_id: null, unit_cost: 0, stock_effect: "consume" }],
    },
    async (requests) => {
      const response = await route.POST(post({ batchId: BATCH, rows: [legacy] }))
      assert.equal(response.status, 200)
      const rpc = requests.find((request) => request.table === "rpc/import_mercadolibre_sales_batch")!
      const [sent] = (rpc.body as { p_rows: Array<{ product_id?: number; raw_data: Row }> }).p_rows
      assert.equal(sent.product_id, undefined, "AP01 existe en el catálogo, pero la venta legada sólo se vincula a mano")
      assert.equal(sent.raw_data.beyonix_cost_mapping, undefined)
    },
  )
})

test("HTTP: GET Admin no vincula sola una venta consume legada sin vínculo", async () => {
  const route = await import("../../app/api/admin/mercadolibre-sales/route")
  await withSupabase(
    {
      productos: catalog,
      mercadolibre_sales: [
        { id: "legacy", operation_id: "2000000000000005", sku: "AP01", product_id: null, stock_effect: "consume", quantity: 2, raw_data: { parsed: { status: "Entregado" } } },
      ],
    },
    async (requests) => {
      const response = await route.GET(new Request("http://localhost/api/admin/mercadolibre-sales", { headers: { Authorization: "Bearer test" } }))
      assert.equal(response.status, 200)
      assert.equal(requests.filter((request) => request.method === "PATCH").length, 0, "ninguna escritura")
      const reconciliation = requests.filter((request) => request.table === "mercadolibre_sales" && request.url.searchParams.get("product_id") === "is.null")
      assert.ok(reconciliation.length > 0)
      assert.ok(reconciliation.every((request) => request.url.searchParams.get("stock_effect") === "eq.none"))
    },
  )
})
