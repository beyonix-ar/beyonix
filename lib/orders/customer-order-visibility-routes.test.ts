import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { resolve } from "node:path"
import test from "node:test"
import { build } from "esbuild"

type OrderRow = Record<string, unknown> & { id: number; usuario_id: string | null }
type QueryResult = { data: Record<string, unknown>[]; error: null }

function selectedFields(select: string) {
  const fields: string[] = []
  let depth = 0
  let start = 0
  for (let index = 0; index < select.length; index += 1) {
    if (select[index] === "(") depth += 1
    if (select[index] === ")") depth -= 1
    if (select[index] === "," && depth === 0) {
      fields.push(select.slice(start, index).trim().split("(")[0])
      start = index + 1
    }
  }
  fields.push(select.slice(start).trim().split("(")[0])
  return fields
}

class OrderQuery {
  private fields: string[] = []
  private predicates: Array<(row: OrderRow) => boolean> = []

  constructor(private readonly rows: OrderRow[]) {}

  select(columns: string) {
    this.fields = selectedFields(columns)
    return this
  }

  eq(column: string, value: unknown) {
    this.predicates.push((row) => row[column] === value)
    return this
  }

  is(column: string, value: null) {
    this.predicates.push((row) => row[column] === value)
    return this
  }

  ilike(column: string, value: string) {
    this.predicates.push((row) => String(row[column] ?? "").toLowerCase() === value.toLowerCase())
    return this
  }

  order() {
    return this
  }

  private result(): QueryResult {
    return {
      data: this.rows.filter((row) => this.predicates.every((predicate) => predicate(row))).map((row) =>
        Object.fromEntries(this.fields.filter((field) => field in row).map((field) => [field, row[field]]))),
      error: null,
    }
  }

  then(resolve: (result: QueryResult) => unknown, reject?: (reason: unknown) => unknown) {
    return Promise.resolve(this.result()).then(resolve, reject)
  }

  async maybeSingle() {
    return { data: this.result().data[0] ?? null, error: null }
  }
}

type RouteRuntime = {
  auth: { auth: { getUser: () => Promise<{ data: { user: { id: string; email: string } } }> } }
  admin: { from: (table: string) => OrderQuery }
}

async function loadRoute(path: string) {
  const mocks: Record<string, string> = {
    "@/lib/supabase/server": "export const createClient = async () => globalThis.__customerOrderRouteVisibilityTest.auth",
    "@/lib/supabase/admin": "export const createAdminClient = () => globalThis.__customerOrderRouteVisibilityTest.admin",
    "@/lib/orders/transfer-expiration": "export const expireOverdueTransferOrders = async () => {}",
    "@/lib/orders/customer-order-audit-view": "export const toCustomerSafeOrderAuditEvents = (events) => events ?? []",
    "@/lib/orders/customer-claim-access": "export const attachCustomerClaimReads = async () => []",
    "@/lib/orders/transfer-reservation-window": "export const attachTransferReservationDeadlines = async (_admin, orders) => orders",
  }
  const result = await build({
    entryPoints: [resolve(process.cwd(), path)],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    external: ["next/server"],
    plugins: [{
      name: "customer-order-route-dependencies",
      setup(plugin) {
        plugin.onResolve({ filter: /^@\/lib\/orders\/(order-visibility|customer-order-dto)$/ }, (args) => ({
          path: resolve(process.cwd(), `${args.path.slice(2)}.ts`),
        }))
        plugin.onResolve({ filter: /^@\// }, (args) => ({ path: args.path, namespace: "route-test-mock" }))
        plugin.onLoad({ filter: /.*/, namespace: "route-test-mock" }, (args) => {
          const contents = mocks[args.path]
          if (!contents) throw new Error(`Falta mock para ${args.path}`)
          return { contents, loader: "js" }
        })
      },
    }],
  })
  const loadedModule: { exports: Record<string, unknown> } = { exports: {} }
  const execute = new Function("require", "module", "exports", result.outputFiles[0].text)
  execute(createRequire(import.meta.url), loadedModule, loadedModule.exports)
  return loadedModule.exports as { GET: (...args: unknown[]) => Promise<Response> }
}

test("listado y detalle aplican la misma visibilidad a pedidos propios y ajenos", async () => {
  const user = { id: "cliente-1", email: "cliente@beyonix.test" }
  const base = {
    usuario_id: user.id,
    cliente_email: user.email,
    created_at: "2026-10-15T12:00:00Z",
    total: 1000,
    orden_items: [],
    order_claims: [],
    order_audit_events: [],
  }
  const rows: OrderRow[] = [
    { ...base, id: 1, estado: "pagado", payment_method_id: "mercadopago", payment_status: "approved", paid_at: base.created_at },
    { ...base, id: 2, estado: "cancelado", payment_method_id: "mercadopago", payment_status: "checkout_superseded", financial_status: "cancelled", admin_visible_at: null },
    { ...base, id: 3, estado: "cancelado", payment_method_id: "mercadopago", payment_status: "checkout_superseded", financial_status: "cancelled", admin_visible_at: null, invoice_cae: "CAE-REAL" },
    { ...base, id: 4, estado: "pagado", payment_method_id: "mercadopago", payment_status: "approved", customer_hidden_at: base.created_at },
    { ...base, id: 5, usuario_id: "otro-cliente", estado: "pagado", payment_method_id: "mercadopago", payment_status: "approved" },
    { ...base, id: 6, estado: "pendiente", payment_method_id: "transferencia", payment_status: "pendiente_comprobante" },
    { ...base, id: 7, estado: "cancelado", payment_method_id: "mercadopago", payment_status: "refunded", financial_status: "refunded", invoice_cae: "CAE-REINTEGRO", credit_note_cae: "NC-REAL", refunded_at: base.created_at },
  ]
  const runtime: RouteRuntime = {
    auth: { auth: { getUser: async () => ({ data: { user } }) } },
    admin: { from: (table) => {
      assert.equal(table, "ordenes")
      return new OrderQuery(rows)
    } },
  }
  Object.assign(globalThis, { __customerOrderRouteVisibilityTest: runtime })
  try {
    const list = await loadRoute("app/api/orders/route.ts")
    const detail = await loadRoute("app/api/orders/[id]/route.ts")
    const listResponse = await list.GET()
    assert.equal(listResponse.status, 200)
    const listed = (await listResponse.json()) as { orders: Array<{ id: number; customer_hidden_at?: string; admin_visible_at?: string; andreani_envio_id?: string }> }
    assert.deepEqual(listed.orders.map((order) => order.id), [1, 3, 6, 7])
    for (const order of listed.orders) {
      assert.equal("customer_hidden_at" in order, false)
      assert.equal("admin_visible_at" in order, false)
      assert.equal("andreani_envio_id" in order, false)
    }

    for (const id of [1, 2, 3, 4, 5, 6, 7]) {
      const response = await detail.GET(new Request(`http://localhost/api/orders/${id}`), { params: Promise.resolve({ id: String(id) }) })
      assert.equal(response.status, [2, 4, 5].includes(id) ? 404 : 200, `pedido ${id}`)
      if (response.status === 200) {
        const body = (await response.json()) as { order: Record<string, unknown> }
        assert.equal(body.order.id, id)
        assert.equal("customer_hidden_at" in body.order, false)
        assert.equal("admin_visible_at" in body.order, false)
        assert.equal("andreani_envio_id" in body.order, false)
      }
    }
  } finally {
    Reflect.deleteProperty(globalThis, "__customerOrderRouteVisibilityTest")
  }
})
