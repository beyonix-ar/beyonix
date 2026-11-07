import assert from "node:assert/strict"
import test, { mock } from "node:test"
import { AuthClient } from "@supabase/supabase-js"

// Ruta Admin del retiro por cadete: la API valida el contrato antes de la base
// (que vuelve a validarlo todo). Supabase simulado: sin datos reales.

type Call = { method: string; path: string; body: unknown }

const SUPABASE = "https://claim-local-pickup.invalid"

async function withSupabase(run: (calls: Call[]) => Promise<void>, role = "admin") {
  const previousEnv = { ...process.env }
  process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon"
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service"
  const calls: Call[] = []
  const claims = mock.method(AuthClient.prototype, "getClaims", async () => ({ data: { claims: { sub: "actor" } }, error: null }))
  const fetchMock = mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : null
    calls.push({ method: init?.method ?? "GET", path: url.pathname, body })
    if (url.pathname === "/rest/v1/profiles") return Response.json({ id: "actor", email: null, rol: role })
    if (url.pathname === "/rest/v1/order_claims") return Response.json({ id: 900, order_claim_files: [] })
    return Response.json(null)
  })
  try {
    await run(calls)
  } finally {
    claims.mock.restore(); fetchMock.mock.restore()
    for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key]
    Object.assign(process.env, previousEnv)
  }
}

const post = async (body: unknown) => {
  const { POST } = await import("../../app/api/admin/order-claims/[claimId]/local-pickup/route")
  return POST(new Request("http://localhost/api/admin/order-claims/900/local-pickup", {
    method: "POST", headers: { Authorization: "Bearer user-token", "Content-Type": "application/json" }, body: JSON.stringify(body),
  }), { params: Promise.resolve({ claimId: "900" }) })
}
const rpcCalls = (calls: Call[]) => calls.filter((call) => call.path.startsWith("/rest/v1/rpc/"))
const KEY = "claim-local-pickup:abcdef123456"

test("pérdida en traslado: exige confirmación explícita, motivo, cantidades enteras y clave; llama sólo a su RPC", async () => {
  await withSupabase(async (calls) => {
    const valid = { action: "loss", items: [{ orderItemId: 71, quantity: 1 }], notes: "El cadete extravió el paquete", confirmed: true, idempotencyKey: KEY }
    for (const [body, message] of [
      [{ ...valid, confirmed: undefined }, /Confirmá explícitamente/],
      [{ ...valid, confirmed: "true" }, /Confirmá explícitamente/],
      [{ ...valid, notes: "corto" }, /mínimo 10 caracteres/],
      [{ ...valid, items: [{ orderItemId: 71, quantity: 0 }] }, /unidades que se perdieron/],
      [{ ...valid, items: [{ orderItemId: 71, quantity: 1.5 }] }, /unidades que se perdieron/],
      [{ ...valid, items: [{ orderItemId: 71, quantity: 1 }, { orderItemId: 71, quantity: 1 }] }, /unidades que se perdieron/],
      [{ ...valid, idempotencyKey: "corta" }, /clave de idempotencia/],
    ] as const) {
      const response = await post(body)
      assert.equal(response.status, 400)
      assert.match(((await response.json()) as { error: string }).error, message)
    }
    assert.equal(rpcCalls(calls).length, 0, "nada llega a la base")
    const response = await post(valid)
    assert.equal(response.status, 200)
    const [rpc] = rpcCalls(calls)
    assert.equal(rpc.path, "/rest/v1/rpc/confirm_order_claim_local_pickup_loss")
    assert.deepEqual(rpc.body, { p_claim_id: 900, p_actor_id: "actor", p_items: [{ order_item_id: 71, quantity: 1 }], p_note: "El cadete extravió el paquete", p_idempotency_key: KEY })
  })
})

test("recepción: la novedad sólo sobre unidades recibidas; 'cantidad incorrecta' no es una novedad de lo recibido", async () => {
  await withSupabase(async (calls) => {
    const base = { action: "receive", idempotencyKey: KEY, notes: "Llegó con la caja rota" }
    for (const items of [
      [{ orderItemId: 71, quantity: 1, incidentType: "cantidad_incorrecta" }],
      [{ orderItemId: 71, quantity: 0, incidentType: "dano_estado" }],
      [{ orderItemId: 71, quantity: 1, incidentType: "dano_estado", incidentQuantity: 2 }],
      [{ orderItemId: 71, quantity: 1, incidentQuantity: 1 }],
      [{ orderItemId: 71, quantity: 0 }],
    ]) {
      assert.equal((await post({ ...base, items })).status, 400, JSON.stringify(items))
    }
    const withoutNote = await post({ ...base, notes: "", items: [{ orderItemId: 71, quantity: 1, incidentType: "dano_estado" }] })
    assert.equal(withoutNote.status, 400)
    assert.equal(rpcCalls(calls).length, 0)

    assert.equal((await post({ ...base, items: [{ orderItemId: 71, quantity: 2, incidentType: "dano_estado", incidentQuantity: 1 }, { orderItemId: 72, quantity: 0 }] })).status, 200)
    assert.deepEqual((rpcCalls(calls)[0].body as { p_items: unknown }).p_items, [
      { order_item_id: 71, quantity: 2, incident_type: "dano_estado", incident_quantity: 1 },
      { order_item_id: 72, quantity: 0 },
    ])
  })
})

test("sólo administradores: un operador no registra pérdidas", async () => {
  await withSupabase(async (calls) => {
    const response = await post({ action: "loss", items: [{ orderItemId: 71, quantity: 1 }], notes: "El cadete extravió el paquete", confirmed: true, idempotencyKey: KEY })
    assert.equal(response.status, 403)
    assert.equal(rpcCalls(calls).length, 0)
  }, "operador")
})
