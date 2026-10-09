import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test, { mock } from "node:test"
import { PGlite } from "@electric-sql/pglite"
import { AuthClient } from "@supabase/supabase-js"

// Admin → Etiquetas: permisos de las rutas (anon 401, cliente/operador 403,
// Admin/Super Admin pasan), validación de entrada antes de tocar datos y la
// migración (RLS sin acceso para anon/authenticated, límites en la base).

type Call = { path: string; method: string; body: unknown }

async function withRoutes(role: string | null, run: (calls: Call[], responders: Map<string, (method: string, body: unknown) => Response>) => Promise<void>) {
  const previousEnv = { ...process.env }
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://labels-routes.invalid"
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon"
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service"
  const calls: Call[] = []
  const responders = new Map<string, (method: string, body: unknown) => Response>()
  const claims = mock.method(AuthClient.prototype, "getClaims", async () => (
    role === null ? { data: null, error: new Error("invalid") } : { data: { claims: { sub: "10000000-0000-4000-8000-000000000001" } }, error: null }))
  const fetchMock = mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : null
    calls.push({ path: url.pathname, method: init?.method ?? "GET", body })
    if (url.pathname === "/rest/v1/profiles") return Response.json({ id: "10000000-0000-4000-8000-000000000001", email: null, rol: role })
    const responder = responders.get(url.pathname)
    if (responder) return responder(init?.method ?? "GET", body)
    return Response.json([])
  })
  try {
    await run(calls, responders)
  } finally {
    claims.mock.restore(); fetchMock.mock.restore()
    for (const key of ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"]) {
      if (previousEnv[key] === undefined) delete process.env[key]; else process.env[key] = previousEnv[key]
    }
  }
}

const request = (method: string, path: string, body?: unknown, token: string | null = "user-token") => new Request(`http://localhost${path}`, {
  method,
  headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
  body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
})

test("permisos: anon 401, cliente y operador 403; Admin y Super Admin pasan la validación", async () => {
  const catalog = await import("../../app/api/admin/labels/catalog/route")
  const patterns = await import("../../app/api/admin/labels/patterns/route")
  const config = await import("../../app/api/admin/labels/config/route")
  const presets = await import("../../app/api/admin/labels/presets/route")
  const batches = await import("../../app/api/admin/labels/batches/route")
  // Entradas inválidas: un rol permitido recibe 400 sin tocar datos.
  const checks = [
    () => catalog.GET(request("GET", "/api/admin/labels/catalog?ids=abc")),
    () => patterns.POST(request("POST", "/api/admin/labels/patterns", { codes: [] })),
    () => config.PUT(request("PUT", "/api/admin/labels/config", { settings: "x" })),
    () => presets.POST(request("POST", "/api/admin/labels/presets", { name: " ", settings: {} })),
    () => presets.DELETE(request("DELETE", "/api/admin/labels/presets?id=1")),
    () => batches.POST(request("POST", "/api/admin/labels/batches", { items: [], output: "pdf" })),
  ]
  await withRoutes(null, async () => {
    assert.equal((await config.GET(request("GET", "/api/admin/labels/config", undefined, null))).status, 401, "sin token")
    for (const check of checks) assert.equal((await check()).status, 401, "token inválido")
  })
  for (const role of ["cliente", "operador", "admin", "super_admin"]) {
    await withRoutes(role, async (calls) => {
      const allowed = role === "admin" || role === "super_admin"
      for (const check of checks) assert.equal((await check()).status, allowed ? 400 : 403, role)
      assert.ok(calls.every((call) => call.path === "/rest/v1/profiles"), "un rechazo nunca toca datos")
    })
  }
})

test("patrones: genera barras sólo para códigos imprimibles, sin datos de la base", async () => {
  const { POST } = await import("../../app/api/admin/labels/patterns/route")
  await withRoutes("admin", async (calls) => {
    const response = await POST(request("POST", "/api/admin/labels/patterns", { codes: ["7790001000019", "BX-AUR-000001", "7790001000019"] }))
    assert.equal(response.status, 200)
    const payload = await response.json() as { patterns: Record<string, { symbology: string; bars: number[] }> }
    assert.deepEqual(Object.keys(payload.patterns), ["7790001000019", "BX-AUR-000001"])
    assert.equal(payload.patterns["7790001000019"].symbology, "ean13")
    assert.equal(payload.patterns["BX-AUR-000001"].symbology, "code128")
    assert.equal((await POST(request("POST", "/api/admin/labels/patterns", { codes: ["CÓDIGO"] }))).status, 400)
    assert.equal((await POST(request("POST", "/api/admin/labels/patterns", { codes: Array.from({ length: 501 }, (_, index) => `C${index}`) }))).status, 400)
    assert.ok(calls.every((call) => call.path === "/rest/v1/profiles"))
  })
})

test("configuración: sin migración responde modo local; la preferencia se normaliza en el servidor", async () => {
  const config = await import("../../app/api/admin/labels/config/route")
  await withRoutes("admin", async (calls, responders) => {
    responders.set("/rest/v1/label_print_presets", () => Response.json({ code: "PGRST205", message: "Could not find the table 'public.label_print_presets'" }, { status: 404 }))
    const response = await config.GET(request("GET", "/api/admin/labels/config"))
    assert.equal(response.status, 200)
    assert.equal((await response.json() as { storageUnavailable: boolean }).storageUnavailable, true)
    responders.delete("/rest/v1/label_print_presets")
    responders.set("/rest/v1/label_print_preferences", () => new Response(null, { status: 201 }))
    const saved = await config.PUT(request("PUT", "/api/admin/labels/config", { settings: { widthMm: 0, dpi: 7, mode: "thermal" } }))
    assert.equal(saved.status, 200)
    const upsert = calls.find((call) => call.path === "/rest/v1/label_print_preferences" && call.method === "POST")
    const stored = upsert?.body as { user_id: string; settings: { widthMm: number; dpi: number; mode: string } }
    assert.equal(stored.user_id, "10000000-0000-4000-8000-000000000001", "siempre la del usuario autenticado")
    assert.deepEqual([stored.settings.widthMm, stored.settings.dpi, stored.settings.mode], [20, 600, "thermal"])
  })
})

test("historial: valida copias, códigos y tope de 500 etiquetas antes de guardar", async () => {
  const { POST } = await import("../../app/api/admin/labels/batches/route")
  const item = { productId: 10, variantId: 101, code: "7790001000019", copies: 5, labelName: null }
  await withRoutes("admin", async (calls, responders) => {
    for (const invalid of [
      { items: [{ ...item, copies: 0 }], output: "pdf" },
      { items: [{ ...item, copies: -1 }], output: "pdf" },
      { items: [{ ...item, copies: "5" }], output: "pdf" },
      { items: [{ ...item, code: "CÓDIGO" }], output: "pdf" },
      { items: [{ ...item, copies: 300 }, { ...item, variantId: 102, copies: 201 }], output: "pdf" },
      { items: [item], output: "email" },
    ]) {
      assert.equal((await POST(request("POST", "/api/admin/labels/batches", invalid))).status, 400)
    }
    assert.ok(calls.every((call) => call.path === "/rest/v1/profiles"))
    responders.set("/rest/v1/label_print_batches", (_method, body) => Response.json({ id: "20000000-0000-4000-8000-000000000001", created_at: "2026-10-09T12:00:00Z", ...(body as Record<string, unknown>) }))
    const response = await POST(request("POST", "/api/admin/labels/batches", { name: "  Encendedores   + Botellas ", items: [item], output: "print" }))
    assert.equal(response.status, 200)
    const insert = calls.find((call) => call.path === "/rest/v1/label_print_batches")?.body as { name: string; label_count: number; created_by: string }
    assert.deepEqual([insert.name, insert.label_count, insert.created_by], ["Encendedores + Botellas", 5, "10000000-0000-4000-8000-000000000001"])
  })
})

test("migración: tablas con RLS sin acceso directo para anon/authenticated y límites en la base", async () => {
  const db = new PGlite()
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create table auth.users(id uuid primary key);
      insert into auth.users values ('10000000-0000-4000-8000-000000000001');
    `)
    await db.exec(readFileSync("supabase/migrations/20261009150000_label_printing.sql", "utf8"))
    for (const table of ["label_print_presets", "label_print_preferences", "label_print_batches"]) {
      const { rows } = await db.query<{ rls: boolean }>("select relrowsecurity rls from pg_class where relname = $1", [table])
      assert.equal(rows[0]?.rls, true, `${table} con RLS`)
      for (const role of ["anon", "authenticated"]) {
        const grants = await db.query<{ allowed: boolean }>(`select has_table_privilege('${role}', 'public.${table}', 'select') allowed`)
        assert.equal(grants.rows[0].allowed, false, `${role} no lee ${table}`)
      }
    }
    await db.exec(`insert into label_print_presets(name, settings) values ('Zebra estándar', '{"widthMm":40}')`)
    await assert.rejects(db.exec(`insert into label_print_presets(name, settings) values (' zebra ESTÁNDAR', '{}')`).then(() => db.exec(`insert into label_print_presets(name, settings) values ('zebra estándar', '{}')`)), /duplicate key/)
    await assert.rejects(db.exec(`insert into label_print_presets(name, settings) values ('X', '[]')`), /check/)
    await assert.rejects(db.exec(`insert into label_print_batches(name, items, label_count, output) values ('T', '[{"copies":1}]', 501, 'pdf')`), /check/)
    await assert.rejects(db.exec(`insert into label_print_batches(name, items, label_count, output) values ('T', '[]', 1, 'pdf')`), /check/)
    await db.exec(`insert into label_print_batches(name, items, label_count, output) values ('Encendedores + Botellas', '[{"productId":10,"copies":14}]', 14, 'print')`)
  } finally {
    await db.close()
  }
})
