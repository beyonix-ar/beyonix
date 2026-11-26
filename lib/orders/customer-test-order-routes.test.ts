import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, resolve } from "node:path"
import test from "node:test"
import { build, type Plugin } from "esbuild"

// Compras de prueba (test_order_at) fuera de la experiencia del cliente, sobre
// las rutas REALES del cliente y las reglas reales (visibilidad, titularidad,
// DTO y acceso a reclamos). Supabase se simula en memoria; el resto de las
// dependencias de cada ruta son stubs que fallan si se llegan a usar.

type Row = Record<string, unknown>
type Filter = { op: string; column: string; value: unknown }

const OWNER = { id: "cliente-1", email: "cliente@beyonix.test", email_confirmed_at: "2026-10-01T00:00:00Z" }
const OTHER = { id: "cliente-2", email: "otro@beyonix.test", email_confirmed_at: "2026-10-01T00:00:00Z" }

const BASE: Row = {
  usuario_id: OWNER.id, cliente_email: OWNER.email, created_at: "2026-11-20T12:00:00Z", total: 1000,
  estado: "entregado", payment_method_id: "mercadopago", payment_status: "approved", financial_status: "payment_confirmed",
  paid_at: "2026-11-20T12:00:00Z", admin_visible_at: "2026-11-20T12:00:00Z", delivered_at: "2026-11-21T12:00:00Z",
  invoice_status: "authorized", invoice_cae: "CAE", customer_hidden_at: null, test_order_at: null, archived_at: null,
  refund_proof_url: null, orden_items: [], order_claims: [], order_audit_events: [],
}
// Reproduce la cuenta del propietario: BX-1019/1020 de prueba y una compra real.
const ITEMS = [{ producto_id: 22, variante_id: 22, conditioned_stock_id: null, cantidad: 1 }]
const ORDERS: Row[] = [
  { ...BASE, id: 18, created_at: "2026-11-18T12:00:00Z", payment_confirmed_amount: 1000, orden_items: ITEMS },
  { ...BASE, id: 19, payment_confirmed_amount: 20, orden_items: ITEMS, test_order_at: "2026-11-25T15:52:02Z", archived_at: "2026-11-25T15:52:02Z", order_claims: [{ id: 8, status: "cerrado" }] },
  { ...BASE, id: 20, test_order_at: "2026-11-25T15:51:14Z", archived_at: "2026-11-25T15:51:14Z" },
  { ...BASE, id: 21, usuario_id: OTHER.id, cliente_email: OTHER.email },
  { ...BASE, id: 22, usuario_id: OTHER.id, cliente_email: OTHER.email, test_order_at: "2026-11-25T15:00:00Z" },
  // Pedido histórico sin usuario (acceso por email legado) y de prueba.
  { ...BASE, id: 23, usuario_id: null, payment_confirmed_amount: 50, orden_items: ITEMS, test_order_at: "2026-11-25T15:00:00Z" },
  // Compra real de invitado (otro email): su token la habilita.
  { ...BASE, id: 24, usuario_id: null, cliente_email: "invitado@beyonix.test", payment_confirmed_amount: 50, orden_items: ITEMS },
]
const CLAIMS: Row[] = [{ id: 8, order_id: 19, status: "cerrado", created_at: "2026-11-21T12:00:00Z" }, { id: 9, order_id: 18, status: "abierto", created_at: "2026-11-21T12:00:00Z" }]

class MemoryQuery {
  readonly filters: Filter[] = []
  private limitValue: number | null = null

  constructor(private readonly table: string, private readonly rows: Row[], private readonly log: Array<{ table: string; filters: Filter[] }>) {
    log.push({ table, filters: this.filters })
  }

  select() { return this }
  order() { return this }
  limit(value: number) { this.limitValue = value; return this }
  eq(column: string, value: unknown) { this.filters.push({ op: "eq", column, value }); return this }
  is(column: string, value: unknown) { this.filters.push({ op: "is", column, value }); return this }
  ilike(column: string, value: unknown) { this.filters.push({ op: "ilike", column, value }); return this }
  in(column: string, value: unknown[]) { this.filters.push({ op: "in", column, value }); return this }

  private matches(row: Row) {
    return this.filters.every(({ op, column, value }) => {
      if (op === "eq") return row[column] === value
      if (op === "is") return (row[column] ?? null) === value
      if (op === "ilike") return String(row[column] ?? "").toLowerCase() === String(value).toLowerCase()
      if (op === "in") return (value as unknown[]).includes(row[column])
      return true
    })
  }

  private data() {
    const rows = this.rows.filter((row) => this.matches(row))
    return this.limitValue == null ? rows : rows.slice(0, this.limitValue)
  }

  then<T>(onFulfilled: (result: { data: Row[]; error: null }) => T, onRejected?: (reason: unknown) => T) {
    return Promise.resolve({ data: this.data(), error: null }).then(onFulfilled, onRejected)
  }
  async maybeSingle() { return { data: this.data()[0] ?? null, error: null } }
  async single() {
    const row = this.data()[0]
    return row ? { data: row, error: null } : { data: null, error: { message: "not found", code: "PGRST116" } }
  }
}

type Runtime = {
  user: typeof OWNER | null
  log: Array<{ table: string; filters: Filter[] }>
}

function createRuntime(user: typeof OWNER | null): Runtime & { auth: unknown; admin: unknown } {
  const log: Runtime["log"] = []
  const tables: Record<string, Row[]> = { ordenes: ORDERS, order_claims: CLAIMS, order_claim_customer_reads: [], order_packages: [] }
  return {
    user,
    log,
    auth: { auth: { getUser: async () => ({ data: { user } }) } },
    admin: {
      from: (table: string) => new MemoryQuery(table, tables[table] ?? [], log),
      rpc: () => { throw new Error("RPC inesperada") },
      storage: { from: () => { throw new Error("Storage inesperado") } },
    },
  }
}

const ROOT = process.cwd()
const REAL = new Set([
  "@/lib/orders/order-visibility",
  "@/lib/orders/customer-order-ownership",
  "@/lib/orders/customer-order-dto",
  "@/lib/orders/customer-claim-access",
  "@/lib/orders/purchase-status",
])
const RUNTIME = "globalThis.__customerTestOrderRoutes"
const EXPLICIT_MOCKS: Record<string, string> = {
  "@/lib/supabase/server": `export const createClient = async () => ${RUNTIME}.auth`,
  "@/lib/supabase/admin": `export const createAdminClient = () => ${RUNTIME}.admin`,
  "../supabase/server.ts": `export const createClient = async () => ${RUNTIME}.auth`,
  "../supabase/admin.ts": `export const createAdminClient = () => ${RUNTIME}.admin`,
  "server-only": "",
  "@/lib/orders/guest-order-token": "export const verifyGuestOrderAccessToken = (token, orderId) => token === `token-${orderId}`",
  "./claim-server.ts": `import { NextResponse } from "next/server"
    export const claimErrorResponse = (error) => NextResponse.json({ error: String(error?.message ?? error) }, { status: /FORBIDDEN/.test(String(error?.message)) ? 403 : 400 })`,
  "@/lib/orders/claim-server": `import { NextResponse } from "next/server"
    export const CUSTOMER_CLAIM_SELECT = "id, order_id, status, created_at"
    export const claimErrorResponse = (error) => NextResponse.json({ error: String(error?.message ?? error) }, { status: 500 })
    export const signClaims = async (_admin, claims) => claims
    export const prepareClaimUploads = () => { throw new Error("stub prepareClaimUploads") }
    export const submitCustomerClaim = () => { throw new Error("stub submitCustomerClaim") }`,
  "@/lib/orders/transfer-expiration": "export const expireOverdueTransferOrders = async () => {}\nexport const expireTransferOrderIfNeeded = async (_admin, order) => order",
  "@/lib/orders/customer-order-audit-view": "export const toCustomerSafeOrderAuditEvents = (events) => events ?? []",
  "@/lib/orders/dispatch-cutoff-server": "export const attachDispatchCutoff = async (_admin, orders) => orders",
  "@/lib/orders/local-delivery-outcomes-server": "export const attachCustomerLocalDeliveryOutcomes = async (_admin, orders) => orders",
  "@/lib/orders/transfer-reservation-window": "export const attachTransferReservationDeadlines = async (_admin, orders) => orders\nexport const loadTransferReservationDeadline = async () => null\nexport const isTransferReservationActive = () => true",
}

// Nombres importados por valor desde `specifier` en el archivo `importer`.
function importedNames(importer: string, specifier: string) {
  const source = readFileSync(importer, "utf8")
  const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const names = new Set<string>()
  for (const match of source.matchAll(new RegExp(`import\\s+(type\\s+)?\\{([^}]*)\\}\\s+from\\s+["']${escaped}["']`, "g"))) {
    if (match[1]) continue
    for (const raw of match[2].split(",")) {
      const name = raw.trim()
      if (!name || name.startsWith("type ")) continue
      names.add(name.split(/\s+as\s+/)[0].trim())
    }
  }
  return [...names]
}

const harness: Plugin = {
  name: "customer-test-order-routes",
  setup(plugin) {
    plugin.onResolve({ filter: /.*/ }, (args) => {
      if (args.kind === "entry-point" || args.path === "next/server") return undefined
      if (REAL.has(args.path)) return { path: resolve(ROOT, `${args.path.slice(2)}.ts`) }
      if (EXPLICIT_MOCKS[args.path] !== undefined) return { path: args.path, namespace: "mock", pluginData: { importer: args.importer } }
      if (args.path.startsWith("@/")) return { path: args.path, namespace: "stub", pluginData: { importer: args.importer } }
      if (args.path.startsWith(".")) return { path: resolve(dirname(args.importer), args.path) }
      return undefined
    })
    plugin.onLoad({ filter: /.*/, namespace: "mock" }, (args) => ({ contents: EXPLICIT_MOCKS[args.path], loader: "ts", resolveDir: ROOT }))
    plugin.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({
      contents: importedNames(args.pluginData.importer, args.path)
        .map((name) => `export const ${name} = new Proxy(function () {}, { apply() { throw new Error("stub ${args.path}#${name}") }, get(_t, key) { if (key === "then") return undefined; throw new Error("stub ${args.path}#${name}." + String(key)) } })`)
        .join("\n"),
      loader: "js",
    }))
  },
}

type RouteModule = Record<string, (...args: unknown[]) => Promise<Response>>
const routeCache = new Map<string, RouteModule>()

async function loadRoute(path: string) {
  const cached = routeCache.get(path)
  if (cached) return cached
  const result = await build({
    entryPoints: [resolve(ROOT, path)], bundle: true, platform: "node", format: "cjs", write: false,
    external: ["next/server"], plugins: [harness], logLevel: "silent",
  })
  const loaded: { exports: RouteModule } = { exports: {} }
  new Function("require", "module", "exports", result.outputFiles[0].text)(createRequire(import.meta.url), loaded, loaded.exports)
  routeCache.set(path, loaded.exports)
  return loaded.exports
}

async function withUser<T>(user: typeof OWNER | null, run: (runtime: Runtime) => Promise<T>) {
  const runtime = createRuntime(user)
  Object.assign(globalThis, { __customerTestOrderRoutes: runtime })
  try {
    return await run(runtime)
  } finally {
    Reflect.deleteProperty(globalThis, "__customerTestOrderRoutes")
  }
}

const params = (id: number) => ({ params: Promise.resolve({ id: String(id) }) })
const json = (body: unknown) => new Request("http://localhost/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

test("Mis compras: excluye compras de prueba desde la consulta y conserva las legítimas del mismo cliente", async () => {
  const { GET } = await loadRoute("app/api/orders/route.ts")
  await withUser(OWNER, async (runtime) => {
    const response = await GET()
    assert.equal(response.status, 200)
    const body = await response.json() as { orders: Array<Record<string, unknown>> }
    assert.deepEqual(body.orders.map((order) => order.id), [18], "sólo la compra real propia")
    assert.ok(body.orders.every((order) => !("test_order_at" in order)), "test_order_at nunca viaja al navegador")
    const orderQueries = runtime.log.filter((entry) => entry.table === "ordenes")
    assert.equal(orderQueries.length, 2, "por usuario y por email legado")
    for (const query of orderQueries) {
      assert.ok(query.filters.some((f) => f.op === "is" && f.column === "test_order_at" && f.value === null), "filtro en la consulta")
    }
    // Reclamos del listado (badge "Ver reclamo"): sin el reclamo #8 de BX-1019.
    const claimIds = body.orders.flatMap((order) => (order.order_claims as Array<{ id: number }> | undefined ?? []).map((claim) => claim.id))
    assert.equal(claimIds.includes(8), false)
  })
  await withUser(OTHER, async () => {
    const body = await (await GET()).json() as { orders: Array<{ id: number }> }
    assert.deepEqual(body.orders.map((order) => order.id), [21], "aislamiento entre usuarios y sin la prueba ajena")
  })
})

test("Detalle por URL directa: la prueba propia es 404; la real propia 200; la ajena 404", async () => {
  const { GET } = await loadRoute("app/api/orders/[id]/route.ts")
  await withUser(OWNER, async () => {
    for (const [id, status] of [[18, 200], [19, 404], [20, 404], [21, 404], [22, 404], [23, 404]] as const) {
      const response = await GET(new Request(`http://localhost/api/orders/${id}`), params(id))
      assert.equal(response.status, status, `BX-${1000 + id}`)
      if (status === 200) {
        const body = await response.json() as { order: Record<string, unknown> }
        assert.equal("test_order_at" in body.order, false)
      }
    }
  })
})

test("Reclamos: listar, leer, crear y etiqueta de devolución bloqueados en pruebas; reales y ajenos igual que antes", async () => {
  const claims = await loadRoute("app/api/orders/[id]/claims/route.ts")
  await withUser(OWNER, async () => {
    const legit = await claims.GET(new Request("http://localhost"), params(18))
    assert.equal(legit.status, 200)
    assert.deepEqual(((await legit.json()) as { claims: Array<{ id: number }> }).claims.map((claim) => claim.id), [9])

    const hidden = await claims.GET(new Request("http://localhost"), params(19))
    assert.equal(hidden.status, 404, "Mis reclamos: el #8 de BX-1019 no se lista")
    assert.equal((await hidden.json() as { error: string }).error, "No encontramos el pedido.")
    assert.equal((await claims.POST(new Request("http://localhost", { method: "POST" }), params(19))).status, 404, "sin reclamos nuevos")
    assert.equal((await claims.POST(new Request("http://localhost", { method: "POST" }), params(23))).status, 404, "tampoco por email legado")
  })
  await withUser(OTHER, async () => {
    // Un tercero recibe el mismo 403 que con cualquier pedido ajeno: no distingue pruebas.
    assert.equal((await claims.GET(new Request("http://localhost"), params(19))).status, 403)
    assert.equal((await claims.GET(new Request("http://localhost"), params(18))).status, 403)
  })
  await withUser(null, async () => {
    assert.equal((await claims.GET(new Request("http://localhost"), params(19))).status, 401)
  })

  const read = await loadRoute("app/api/orders/[id]/claims/read/route.ts")
  const readHandler = read.POST ?? read.GET
  await withUser(OWNER, async () => {
    assert.equal((await readHandler(json({ claimId: 8 }), params(19))).status, 404)
  })
  const label = await loadRoute("app/api/orders/[id]/claims/[claimId]/return-label/route.ts")
  await withUser(OWNER, async () => {
    const response = await label.GET(new Request("http://localhost"), { params: Promise.resolve({ id: "19", claimId: "8" }) })
    assert.equal(response.status, 404)
  })
})

test("Acciones comerciales posteriores: cancelar, factura/NC y comprobante de reintegro devuelven 404 en pruebas", async () => {
  const cancel = await loadRoute("app/api/orders/[id]/cancel/route.ts")
  const invoice = await loadRoute("app/api/orders/[id]/invoice/route.ts")
  const refundProof = await loadRoute("app/api/orders/[id]/refund-proof/route.ts")
  await withUser(OWNER, async () => {
    assert.equal((await cancel.POST(json({ reason: "Ya no lo necesito" }), params(19))).status, 404)
    for (const type of ["invoice", "credit_note"]) {
      assert.equal((await invoice.GET(new Request(`http://localhost/api/orders/19/invoice?type=${type}`), params(19))).status, 404, type)
      assert.equal((await invoice.GET(new Request(`http://localhost/api/orders/23/invoice?type=${type}`), params(23))).status, 404, `${type} legado`)
    }
    assert.equal((await refundProof.GET(new Request("http://localhost"), params(19))).status, 404)
    const legit = await refundProof.GET(new Request("http://localhost"), params(18))
    assert.equal(legit.status, 200)
    assert.deepEqual(await legit.json(), { signedUrl: null, fileName: null })
  })
  await withUser(OTHER, async () => {
    assert.equal((await cancel.POST(json({ reason: "Ya no lo necesito" }), params(19))).status, 403, "ajeno: mismo 403")
    assert.equal((await refundProof.GET(new Request("http://localhost"), params(19))).status, 403)
  })
})

test("Transferencia y comprobantes por URL directa: 404 en pruebas, 403 para terceros", async () => {
  const proof = await loadRoute("app/api/payment-proofs/[orderId]/route.ts")
  const titular = await loadRoute("app/api/transferencia/[orderId]/titular/route.ts")
  const verify = await loadRoute("app/api/transferencia/[orderId]/verificar/route.ts")
  const orderParams = (id: number) => ({ params: Promise.resolve({ orderId: String(id) }) })
  await withUser(OWNER, async () => {
    assert.equal((await proof.GET(new Request("http://localhost"), orderParams(19))).status, 404)
    assert.equal((await titular.POST(json({ firstName: "Lucía", lastName: "Peña", dni: "30111222" }), orderParams(19))).status, 404)
    assert.equal((await verify.POST(json({}), orderParams(19))).status, 404)
  })
  await withUser(OTHER, async () => {
    assert.equal((await proof.GET(new Request("http://localhost"), orderParams(19))).status, 403)
    assert.equal((await titular.POST(json({ firstName: "Lucía", lastName: "Peña", dni: "30111222" }), orderParams(19))).status, 403)
    assert.equal((await verify.POST(json({}), orderParams(19))).status, 403)
  })
})

test("purchase-status (carrito): la compra de prueba responde unknown sin ítems, autenticado e invitado; las reales siguen limpiando el carrito", async () => {
  const { POST } = await loadRoute("app/api/checkout/purchase-status/route.ts")
  const purchased = [{ productId: 22, variantId: 22, conditionedStockId: null, quantity: 1 }]
  await withUser(OWNER, async (runtime) => {
    const response = await POST(json({ orders: [{ orderId: 19 }, { orderId: 20 }, { orderId: 18 }, { orderId: 23, guestToken: "token-23" }, { orderId: 24, guestToken: "token-24" }] }))
    assert.equal(response.status, 200)
    const body = await response.json() as { orders: Array<Record<string, unknown>> }
    assert.deepEqual(body.orders, [
      { orderId: 19, status: "unknown" },
      { orderId: 20, status: "unknown" },
      { orderId: 18, status: "paid", items: purchased },
      { orderId: 23, status: "unknown" },
      { orderId: 24, status: "paid", items: purchased },
    ])
    const query = runtime.log.find((entry) => entry.table === "ordenes")
    assert.ok(query?.filters.some((f) => f.op === "is" && f.column === "test_order_at" && f.value === null), "filtro en la consulta del servidor")
  })
  await withUser(null, async () => {
    const body = await (await POST(json({ orders: [{ orderId: 23, guestToken: "token-23" }, { orderId: 24, guestToken: "token-24" }] }))).json() as { orders: unknown[] }
    assert.deepEqual(body.orders, [{ orderId: 23, status: "unknown" }, { orderId: 24, status: "paid", items: purchased }], "invitado sin sesión")
  })
  await withUser(OTHER, async () => {
    const body = await (await POST(json({ orders: [{ orderId: 18 }, { orderId: 19 }] }))).json() as { orders: unknown[] }
    assert.deepEqual(body.orders, [{ orderId: 18, status: "unknown" }, { orderId: 19, status: "unknown" }], "otro cliente: ni reales ni pruebas ajenas")
  })
})
