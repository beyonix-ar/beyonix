import assert from "node:assert/strict"
import test, { mock } from "node:test"
import { AuthClient } from "@supabase/supabase-js"

// Rutas de Admin > Ventas externas con Supabase simulado a nivel HTTP: roles,
// contrato de cada operación y traducción de errores de las RPC.

const ADMIN = "10000000-0000-4000-8000-000000000001"
const SALE = "20000000-0000-4000-8000-000000000001"
const BATCH = "30000000-0000-4000-8000-000000000001"
const ENV_KEYS = ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"] as const

type RpcCall = { name: string; body: Record<string, unknown> }

async function withSupabase(
  options: { role: string; rpc?: (call: RpcCall) => Response; rest?: (url: URL, init?: RequestInit) => Response | undefined },
  run: (rpcCalls: RpcCall[]) => Promise<void>,
) {
  const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://external-sales.invalid"
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon"
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key-with-enough-length"
  const rpcCalls: RpcCall[] = []
  const claims = mock.method(AuthClient.prototype, "getClaims", async () => ({ data: { claims: { sub: ADMIN } }, error: null }))
  const fetchMock = mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.pathname === "/rest/v1/profiles") return Response.json({ id: ADMIN, email: null, rol: options.role })
    const rpc = /^\/rest\/v1\/rpc\/(\w+)$/.exec(url.pathname)
    if (rpc) {
      const call = { name: rpc[1], body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> }
      rpcCalls.push(call)
      return options.rpc?.(call) ?? Response.json({ id: SALE, status: "completed", stock_effect: "consume", quantity: 1, gross_amount: 100 })
    }
    return options.rest?.(url, init) ?? new Response("inesperado", { status: 599 })
  })
  try {
    await run(rpcCalls)
  } finally {
    claims.mock.restore()
    fetchMock.mock.restore()
    for (const key of ENV_KEYS) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
  }
}

const json = (method: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/admin/external-sales", {
    method,
    headers: { Authorization: "Bearer test", "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  })
const params = (id: string) => ({ params: Promise.resolve({ id }) })
const importRow = {
  source_row_number: 2, sale_date: "2026-03-15", customer_name: "Lucía Pérez", channel: "whatsapp", channel_label: "WhatsApp",
  sku: "AUR-1", product_name: "Auricular Ñandú", quantity: 1, shipping_amount: 0, payment_method: "Transferencia",
  payment_method_code: "transfer", status: "delivered", gross_amount: 15000, declared_profit: 4000, notes: null,
  source_values: { Fecha: "15/03/2026", Costo: "$ 11.000" },
}

test("operador: 403 en todas las operaciones y ninguna RPC ejecutada", async () => {
  const sales = await import("../../app/api/admin/external-sales/route")
  const detail = await import("../../app/api/admin/external-sales/[id]/route")
  const cancel = await import("../../app/api/admin/external-sales/[id]/cancel/route")
  const preview = await import("../../app/api/admin/external-sales/import/preview/route")
  const importRoute = await import("../../app/api/admin/external-sales/import/route")
  const revert = await import("../../app/api/admin/external-sales/import-batches/[id]/revert/route")
  await withSupabase({ role: "operador" }, async (rpcCalls) => {
    for (const response of [
      await sales.GET(json("GET", undefined)),
      await sales.POST(json("POST", {}, { "Idempotency-Key": "key-12345678" })),
      await detail.PATCH(json("PATCH", { version: 1, changes: { notes: "x" } }), params(SALE)),
      await cancel.POST(json("POST", {}), params(SALE)),
      await preview.POST(json("POST", { rows: [importRow] })),
      await importRoute.POST(json("POST", { stockMode: "none", source: "paste", rows: [importRow] }, { "Idempotency-Key": "key-12345678" })),
      await revert.POST(json("POST", { expectedCount: 1, reason: "Motivo suficiente" }), params(BATCH)),
    ]) {
      assert.equal(response.status, 403)
    }
    assert.equal(rpcCalls.length, 0)
  })
})

test("importar: el modo Histórica/Nueva es obligatorio, el actor sale de la sesión y las filas se validan", async () => {
  const importRoute = await import("../../app/api/admin/external-sales/import/route")
  await withSupabase({ role: "admin", rpc: () => Response.json({ batch_id: BATCH, imported: 1, stock_mode: "none", replayed: false }) }, async (rpcCalls) => {
    const key = { "Idempotency-Key": "import:0001-abcdef" }
    assert.equal((await importRoute.POST(json("POST", { source: "paste", rows: [importRow] }, key))).status, 400, "sin modo explícito")
    assert.equal((await importRoute.POST(json("POST", { stockMode: "none", source: "paste", rows: [importRow] }))).status, 400, "sin clave de idempotencia")
    assert.equal((await importRoute.POST(json("POST", { stockMode: "none", source: "paste", rows: [{ ...importRow, product_id: 9 }] }, key))).status, 400)
    assert.equal((await importRoute.POST(json("POST", { stockMode: "none", source: "file", rows: [importRow] }, key))).status, 400, "archivo sin nombre")
    assert.equal(rpcCalls.length, 0)

    const response = await importRoute.POST(json("POST", {
      stockMode: "none", source: "paste", rowsRead: 3, rows: [importRow], actorId: "otro", p_actor_id: "otro",
    }, key))
    assert.equal(response.status, 201)
    assert.equal(rpcCalls.length, 1)
    assert.equal(rpcCalls[0].name, "import_external_sales_batch")
    assert.deepEqual(rpcCalls[0].body.p_batch, { source: "paste", file_name: null, stock_mode: "none", rows_read: 3 })
    assert.equal(rpcCalls[0].body.p_actor_id, ADMIN)
    assert.equal(rpcCalls[0].body.p_idempotency_key, "import:0001-abcdef")
    assert.deepEqual(rpcCalls[0].body.p_rows, [importRow])
  })
})

test("alta, edición y anulación: contrato con las RPC", async () => {
  const sales = await import("../../app/api/admin/external-sales/route")
  const detail = await import("../../app/api/admin/external-sales/[id]/route")
  const cancel = await import("../../app/api/admin/external-sales/[id]/cancel/route")
  await withSupabase({ role: "super_admin" }, async (rpcCalls) => {
    const fields = { saleDate: "2026-10-01", channel: "instagram", sku: "FUN-AZU", quantity: 2, finalPrice: 20000, shippingAmount: 0, paymentMethodCode: "mercadopago", status: "completed" }
    assert.equal((await sales.POST(json("POST", fields, { "Idempotency-Key": "external-sale:abc12345" }))).status, 400, "sin tipo de stock")
    assert.equal((await sales.POST(json("POST", { ...fields, stockEffect: "consume" }, { "Idempotency-Key": "external-sale:abc12345" }))).status, 201)
    assert.deepEqual(rpcCalls.at(-1), {
      name: "create_external_sale_idempotent",
      body: {
        p_payload: {
          sale_date: "2026-10-01", channel: "instagram", sku: "FUN-AZU", quantity: 2, gross_amount: 20000, shipping_amount: 0,
          payment_method_code: "mercadopago", payment_method: "Mercado Pago", status: "completed", stock_effect: "consume",
        },
        p_actor_id: ADMIN,
        p_idempotency_key: "external-sale:abc12345",
      },
    })

    assert.equal((await detail.PATCH(json("PATCH", { version: 3, changes: { stockEffect: "none" } }), params(SALE))).status, 400, "el tipo de stock no se edita")
    assert.equal((await detail.PATCH(json("PATCH", { version: 3, changes: { quantity: 1, finalPrice: 10000 }, reason: "Cantidad mal cargada" }), params(SALE))).status, 200)
    assert.deepEqual(rpcCalls.at(-1)?.body, {
      p_id: SALE, p_expected_version: 3, p_patch: { quantity: 1, gross_amount: 10000 }, p_actor_id: ADMIN, p_reason: "Cantidad mal cargada",
    })

    assert.equal((await cancel.POST(json("POST", { kind: "return", reason: "Devolvió el producto", idempotencyKey: "cancel:12345678" }), params(SALE))).status, 400, "devolución sin condición")
    assert.equal((await cancel.POST(json("POST", { kind: "return", returnCondition: "damaged", reason: "Llegó roto al local", idempotencyKey: "cancel:12345678", version: 4 }), params(SALE))).status, 200)
    assert.deepEqual(rpcCalls.at(-1)?.body, {
      p_id: SALE, p_kind: "return", p_return_condition: "damaged", p_reason: "Llegó roto al local", p_actor_id: ADMIN,
      p_idempotency_key: "cancel:12345678", p_expected_version: 4,
    })
  })
})

test("errores de la base: mensajes claros sin detalles internos", async () => {
  const importRoute = await import("../../app/api/admin/external-sales/import/route")
  const revert = await import("../../app/api/admin/external-sales/import-batches/[id]/revert/route")
  const detail = await import("../../app/api/admin/external-sales/[id]/route")
  const failures: Record<string, string> = {
    import_external_sales_batch: "EXTERNAL_SALE_STOCK_UNAVAILABLE: AUR-1 tiene 1 unidades disponibles (descontando reservas web) y la tanda pide 2.",
    revert_external_sale_import_batch: "EXTERNAL_SALE_BATCH_HAS_MODIFIED_SALES: 1 ventas de la tanda fueron modificadas o anuladas.",
    update_external_sale: "EXTERNAL_SALE_VERSION_CONFLICT",
  }
  await withSupabase({ role: "admin", rpc: (call) => Response.json({ message: failures[call.name], code: "P0001" }, { status: 400 }) }, async () => {
    const stock = await importRoute.POST(json("POST", { stockMode: "consume", source: "paste", rows: [importRow] }, { "Idempotency-Key": "import:0002-abcdef" }))
    assert.equal(stock.status, 409)
    assert.equal((await stock.json()).error, "Stock insuficiente: AUR-1 tiene 1 unidades disponibles (descontando reservas web) y la tanda pide 2.")
    const blocked = await revert.POST(json("POST", { expectedCount: 2, reason: "Tanda duplicada por error" }), params(BATCH))
    assert.equal(blocked.status, 409)
    assert.equal((await blocked.json()).error, "Esta tanda contiene ventas modificadas. Revisalas individualmente.")
    const conflict = await detail.PATCH(json("PATCH", { version: 1, changes: { notes: "Nota" } }), params(SALE))
    assert.equal(conflict.status, 409)
    assert.match((await conflict.json()).error, /Otro administrador modificó esta venta/)
  })
})

test("el endpoint anterior ya no escribe ventas externas; su GET sigue leyendo", async () => {
  const ledger = await import("../../app/api/admin/sales-ledger/route")
  const restCalls: string[] = []
  const rest = (url: URL, init?: RequestInit) => {
    if (!/^\/rest\/v1\/(productos|product_cost_entries|external_sales|mercadolibre_sales)$/.test(url.pathname)) return undefined
    restCalls.push(`${init?.method ?? "GET"} ${url.pathname}`)
    if (url.pathname === "/rest/v1/external_sales") {
      return Response.json([{ id: SALE, sale_date: "2026-03-15", product_name: "Auricular Ñandú", quantity: 1, gross_amount: 15000, status: "completed", notes: null }])
    }
    return Response.json([])
  }
  await withSupabase({ role: "admin", rest }, async (rpcCalls) => {
    assert.equal((await ledger.POST(json("POST", { channel: "external", saleDate: "2026-01-01", productName: "x", quantity: 1 }))).status, 410)
    assert.equal((await ledger.PATCH(json("PATCH", { channel: "external", id: SALE }))).status, 410)
    const removal = await ledger.DELETE(new Request(`http://localhost/api/admin/sales-ledger?channel=external&id=${SALE}`, {
      method: "DELETE", headers: { Authorization: "Bearer test" },
    }))
    assert.equal(removal.status, 405)
    assert.equal(rpcCalls.length, 0, "ninguna RPC (ni reverse_external_sale ni create)")
    assert.equal(restCalls.length, 0, "ninguna escritura llegó a external_sales")

    const read = await ledger.GET(new Request("http://localhost/api/admin/sales-ledger", { headers: { Authorization: "Bearer test" } }))
    assert.equal(read.status, 200)
    const body = await read.json() as { externalSales: Array<{ id: string; product_name: string }>; mlSales: unknown[] }
    assert.deepEqual(body.externalSales.map((sale) => [sale.id, sale.product_name]), [[SALE, "Auricular Ñandú"]])
    assert.deepEqual(body.mlSales, [])
    assert.ok(restCalls.every((call) => call.startsWith("GET ")), "el GET sólo lee")
  })
})

test("contrato: ningún código de la app llama escrituras viejas de ventas externas", async () => {
  const { readdirSync, readFileSync, statSync } = await import("node:fs")
  const { join } = await import("node:path")
  const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? files(path) : /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : []
  })
  const sources = ["app", "components", "lib", "hooks", "context"].flatMap((dir) => {
    try { return files(dir) } catch { return [] }
  }).map((path) => ({ path, text: readFileSync(path, "utf8") }))
  assert.ok(sources.length > 100)
  const offenders = (pattern: RegExp) => sources.filter((source) => pattern.test(source.text)).map((source) => source.path)
  assert.deepEqual(offenders(/\/api\/admin\/sales-ledger/), [], "ningún componente usa el endpoint viejo")
  assert.deepEqual(offenders(/reverse_external_sale/), [], "nadie llama la RPC retirada")
  assert.deepEqual(offenders(/from\(\s*["']external_sales["']\s*\)\s*\.\s*(insert|update|upsert|delete)/), [], "external_sales sólo se escribe por RPC")
  const migration = readFileSync("supabase/migrations/20261027210000_external_sales_imports_and_lifecycle.sql", "utf8")
  assert.match(migration, /drop function if exists public\.reverse_external_sale\(uuid, text, uuid, text\);/)
})
