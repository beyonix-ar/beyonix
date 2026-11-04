import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { matchesPostgrestOr } from "./fixtures/postgrest-filter.ts"
import { runAndreaniTrackingSyncBatch } from "./tracking-sync-batch.ts"

const qaClientEnv: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  ANDREANI_ENV: "QA",
  ANDREANI_QA_API_URL: "https://apisqa.andreani.com",
  ANDREANI_QA_USERNAME: "usuario-prueba",
  ANDREANI_QA_PASSWORD: "clave-prueba",
}

function jsonResponse(body: unknown) {
  return Response.json(body)
}

interface FakeOrdenRow extends Record<string, unknown> {
  id: number
  estado: string
  delivered_at: string | null
  andreani_envio_id: string
  andreani_tracking: string | null
  andreani_creation_environment: "QA" | "PROD"
  cliente_email: string | null
  cliente_nombre: string | null
  tracking_number: string | null
  tracking_url: string | null
}

function createFakeAdmin(seedOrders: FakeOrdenRow[]) {
  const auditEvents: Array<Record<string, unknown>> = []
  const historyRows: Array<Record<string, unknown>> = []
  const updates: Array<{ id: unknown; payload: Record<string, unknown> }> = []
  const listedLimits: number[] = []

  // Pedidos Andreani salvo que el test diga otra cosa; mismo WHERE que la base.
  for (const row of seedOrders) if (!("shipping_provider" in row)) row.shipping_provider = "andreani"
  type Predicate = (row: Record<string, unknown>) => boolean
  const matching = (predicates: Predicate[]) => seedOrders.find((candidate) => predicates.every((predicate) => predicate(candidate)))

  function ordenesTable() {
    return {
      select() {
        // Listado del lote (filtros de selección no simulados) o verificación puntual por id.
        const predicates: Predicate[] = []
        const chain = {
          not: () => chain,
          or: (expression: string) => { predicates.push((row) => matchesPostgrestOr(row, expression)); return chain },
          eq: (col: string, val: unknown) => { predicates.push((row) => row[col] === val); return chain },
          order: () => chain,
          // Como la base: el filtro (antigüedad + proveedor) se aplica ANTES del limit.
          limit: async (n: number) => {
            listedLimits.push(n)
            return {
              data: seedOrders.filter((row) => predicates.every((predicate) => predicate(row))).slice(0, n).map((row) => ({ ...row })),
              error: null,
            }
          },
          maybeSingle: async () => {
            const row = matching(predicates)
            return { data: row ? { id: row.id } : null, error: null }
          },
        }
        return chain
      },
      update(payload: Record<string, unknown>) {
        const predicates: Predicate[] = []
        let id: unknown
        const apply = () => {
          const row = matching(predicates)
          if (row) {
            Object.assign(row, payload)
            updates.push({ id, payload })
          }
          return row
        }
        const builder = {
          then(resolve: (value: { error: null }) => unknown) {
            apply()
            return resolve({ error: null })
          },
          or(expression: string) {
            predicates.push((row) => matchesPostgrestOr(row, expression))
            return builder
          },
          is(col: string) {
            predicates.push((row) => row[col] == null)
            return builder
          },
          eq(col: string, val: unknown) {
            if (col === "id") id = val
            predicates.push((row) => row[col] === val)
            return builder
          },
          select() {
            return {
              async maybeSingle() {
                const row = apply()
                return { data: row ? { ...row } : null, error: null }
              },
            }
          },
        }
        return builder
      },
    }
  }

  const admin = {
    from(table: string) {
      if (table === "ordenes") return ordenesTable()
      if (table === "orden_items") {
        return { select: () => ({ eq: async () => ({ data: [], error: null }) }) }
      }
      if (table === "order_audit_events") {
        return {
          insert: async (payload: Record<string, unknown>) => {
            auditEvents.push(payload)
            return { error: null }
          },
        }
      }
      if (table === "andreani_tracking_events") {
        return {
          upsert(rows: Array<Record<string, unknown>>) {
            const inserted = rows.filter((row) => !historyRows.some((existing) => existing.dedupe_key === row.dedupe_key))
            historyRows.push(...inserted)
            return { select: async () => ({ data: inserted.map((row) => ({ dedupe_key: row.dedupe_key })), error: null }) }
          },
        }
      }
      throw new Error(`tabla inesperada en el mock: ${table}`)
    },
  }

  return { admin, auditEvents, historyRows, updates, listedLimits }
}

function silenceConsole<T>(run: () => Promise<T>) {
  const { error, warn } = console
  console.error = () => {}
  console.warn = () => {}
  return run().finally(() => {
    console.error = error
    console.warn = warn
  })
}

function fakeAndreaniFetch(eventosByEnvio: Record<string, unknown[]>) {
  return async (input: string | URL | Request) => {
    const url = new URL(String(input))
    if (url.pathname === "/login") return jsonResponse({ token: "token-prueba" })
    if (url.pathname.endsWith("/trazas")) {
      const numero = decodeURIComponent(url.pathname.split("/")[3] ?? "")
      return jsonResponse({ eventos: eventosByEnvio[numero] ?? [] })
    }
    // GET /v2/ordenes-de-envio/:id
    const envioId = decodeURIComponent(url.pathname.split("/")[3] ?? "")
    return jsonResponse({
      estado: "Creada",
      tipo: "B2C",
      bultos: [{ numeroDeBulto: "1", numeroDeEnvio: `tracking-${envioId}` }],
    })
  }
}

test("procesa el lote, marca entregado con evidencia real y sigue aunque un pedido falle", async () => {
  const orders: FakeOrdenRow[] = [
    {
      id: 1,
      estado: "pagado",
      delivered_at: null,
      andreani_envio_id: "ENV1",
      andreani_tracking: "tracking-ENV1",
      andreani_creation_environment: "QA",
      cliente_email: "a@example.com",
      cliente_nombre: "A",
      tracking_number: null,
      tracking_url: null,
    },
    {
      id: 2,
      estado: "en_camino",
      delivered_at: null,
      andreani_envio_id: "ENV2",
      andreani_tracking: "tracking-ENV2",
      andreani_creation_environment: "QA",
      cliente_email: "b@example.com",
      cliente_nombre: "B",
      tracking_number: null,
      tracking_url: null,
    },
  ]
  const { admin, auditEvents } = createFakeAdmin(orders)

  const result = await runAndreaniTrackingSyncBatch(admin as never, {
    clientOptions: {
      env: qaClientEnv,
      fetch: fakeAndreaniFetch({
        "tracking-ENV1": [{ Fecha: "2026-08-26T15:11:00.0000000", Evento: "EnvioEntregado", Estado: "Entregado" }],
        "tracking-ENV2": [{ Fecha: "2026-08-26T15:11:00.0000000", Evento: "Distribucion", Estado: "En distribución" }],
      }),
    },
  })

  assert.equal(result.checked, 2)
  assert.equal(result.updated, 2)
  assert.equal(result.statusChanged, 1)
  assert.equal(result.errors, 0)
  assert.equal(auditEvents.length, 1)
  assert.equal(auditEvents[0].new_status, "entregado")
})

test("un pedido que falla no interrumpe el resto del lote", async () => {
  const orders: FakeOrdenRow[] = [
    {
      id: 1,
      estado: "pagado",
      delivered_at: null,
      // envio vacío -> fetchAndreaniOrderTrackingSnapshot rechaza antes de llamar a Andreani.
      andreani_envio_id: "",
      andreani_tracking: null,
      andreani_creation_environment: "QA",
      cliente_email: null,
      cliente_nombre: null,
      tracking_number: null,
      tracking_url: null,
    },
    {
      id: 2,
      estado: "pagado",
      delivered_at: null,
      andreani_envio_id: "ENV2",
      andreani_tracking: "tracking-ENV2",
      andreani_creation_environment: "QA",
      cliente_email: "b@example.com",
      cliente_nombre: "B",
      tracking_number: null,
      tracking_url: null,
    },
  ]
  const { admin } = createFakeAdmin(orders)

  const result = await runAndreaniTrackingSyncBatch(admin as never, {
    clientOptions: {
      env: qaClientEnv,
      fetch: fakeAndreaniFetch({
        "tracking-ENV2": [{ Fecha: "2026-08-26T15:11:00.0000000", Evento: "EnvioDespachado", Estado: "Despachado" }],
      }),
    },
  })

  assert.equal(result.checked, 2)
  assert.equal(result.errors, 1)
  assert.equal(result.updated, 1)
  assert.equal(result.statusChanged, 1)
})

// Investigación Gateway Timeout (2026-09-11): cuando la carga de pedidos
// fallaba (p. ej. Supabase/PostgREST devolviendo 504 "Gateway Timeout"), el
// código descartaba el error real y lanzaba siempre el mismo mensaje fijo --
// imposible de diagnosticar en producción. Ahora el detalle real queda
// incluido en el mensaje.
test("un error al cargar el lote propaga el detalle real de Supabase, no un mensaje genérico", async () => {
  const admin = {
    from(table: string) {
      if (table !== "ordenes") throw new Error(`tabla inesperada en el mock: ${table}`)
      return {
        select() {
          const chain = {
            not: () => chain,
            or: () => chain,
            order: () => chain,
            limit: async () => ({ data: null, error: { message: "Gateway Timeout" } }),
          }
          return chain
        },
      }
    },
  }

  await assert.rejects(
    runAndreaniTrackingSyncBatch(admin as never, { clientOptions: { env: qaClientEnv } }),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.equal((error as { code?: string }).code, "REQUEST_FAILED")
      assert.match(error.message, /Gateway Timeout/)
      return true
    },
  )
})

test("respeta el batchSize pasado por parámetro", async () => {
  const orders: FakeOrdenRow[] = Array.from({ length: 5 }, (_, index) => ({
    id: index + 1,
    estado: "pagado",
    delivered_at: null,
    andreani_envio_id: `ENV${index + 1}`,
    andreani_tracking: `tracking-ENV${index + 1}`,
    andreani_creation_environment: "QA" as const,
    cliente_email: null,
    cliente_nombre: null,
    tracking_number: null,
    tracking_url: null,
  }))
  const { admin } = createFakeAdmin(orders)

  const result = await runAndreaniTrackingSyncBatch(admin as never, {
    batchSize: 2,
    clientOptions: { env: qaClientEnv, fetch: fakeAndreaniFetch({}) },
  })

  assert.equal(result.checked, 2)
})

function activeOrder(id: number, overrides: Partial<FakeOrdenRow> = {}): FakeOrdenRow {
  return {
    id,
    estado: "pagado",
    delivered_at: null,
    andreani_envio_id: `ENV${id}`,
    andreani_tracking: `tracking-ENV${id}`,
    andreani_creation_environment: "PROD",
    cliente_email: null,
    cliente_nombre: null,
    tracking_number: null,
    tracking_url: null,
    ...overrides,
  }
}

test("fallo de un tracking (Andreani caído para ese envío): el resto del lote avanza y el fallido no bloquea la cabeza de la fila", async () => {
  const orders = [activeOrder(1), activeOrder(2), activeOrder(3)]
  const { admin, updates } = createFakeAdmin(orders)
  const now = new Date("2026-10-21T12:00:00.000Z")
  const fetch = fakeAndreaniFetch({
    "tracking-ENV1": [{ Fecha: "2026-10-21T08:00:00.0000000", Evento: "EnvioDespachado" }],
    "tracking-ENV3": [{ Fecha: "2026-10-21T08:00:00.0000000", Evento: "EnvioEntregado" }],
  })
  const result = await silenceConsole(() => runAndreaniTrackingSyncBatch(admin as never, {
    now: () => now,
    clientOptions: {
      env: qaClientEnv,
      fetch: async (input) => String(input).includes("tracking-ENV2")
        ? new Response("upstream caído", { status: 503 })
        : fetch(input),
    },
  }))

  assert.deepEqual(result, { checked: 3, updated: 2, statusChanged: 2, errors: 1, unknownEvents: 0, deferred: 0 })
  assert.deepEqual(orders.map((order) => order.estado), ["en_camino", "pagado", "entregado"])
  // El fallido queda "consultado hace 19 min": vuelve a entrar en el próximo
  // tick (cada 15 min) pero detrás de los pedidos más atrasados.
  const deferral = updates.find((update) => update.id === 2 && "andreani_tracking_checked_at" in update.payload)
  assert.equal(deferral?.payload.andreani_tracking_checked_at, "2026-10-21T11:41:00.000Z")
})

test("presupuesto de tiempo: pasado el límite no se empieza otro pedido (queda para el próximo tick)", async () => {
  const orders = [activeOrder(1), activeOrder(2)]
  const { admin } = createFakeAdmin(orders)
  const result = await runAndreaniTrackingSyncBatch(admin as never, {
    deadlineMs: Date.now() - 1,
    clientOptions: { env: qaClientEnv, fetch: async () => { throw new Error("no debería consultar") } },
  })
  assert.deepEqual(result, { checked: 2, updated: 0, statusChanged: 0, errors: 0, unknownEvents: 0, deferred: 2 })
})

test("el lote cuenta eventos desconocidos nuevos y no los vuelve a contar en la próxima corrida", async () => {
  const orders = [activeOrder(1, { estado: "en_camino" })]
  const { admin, historyRows } = createFakeAdmin(orders)
  const clientOptions = {
    env: qaClientEnv,
    fetch: fakeAndreaniFetch({
      "tracking-ENV1": [
        { Fecha: "2026-10-21T08:00:00.0000000", Evento: "EnvioDespachado" },
        { Fecha: "2026-10-21T09:00:00.0000000", Evento: "EventoQueNoExiste", Estado: "???" },
      ],
    }),
  }
  const first = await silenceConsole(() => runAndreaniTrackingSyncBatch(admin as never, { clientOptions }))
  assert.equal(first.unknownEvents, 1)
  assert.equal(first.errors, 0, "un evento desconocido no rompe el pedido")
  const second = await silenceConsole(() => runAndreaniTrackingSyncBatch(admin as never, { clientOptions }))
  assert.equal(second.unknownEvents, 0)
  assert.equal(historyRows.length, 2)
  assert.equal(orders[0].estado, "en_camino")
})

test("Envío BEYONIX con andreani_envio_id residual: el cron nunca lo consulta ni lo mueve; Andreani sigue igual", async () => {
  const base = { delivered_at: null, andreani_creation_environment: "QA" as const, cliente_email: null, cliente_nombre: null, tracking_number: null, tracking_url: null }
  const orders: FakeOrdenRow[] = [
    { ...base, id: 1, estado: "pagado", andreani_envio_id: "ENV-RESIDUAL", andreani_tracking: "tracking-ENV-RESIDUAL", shipping_provider: "beyonix" },
    { ...base, id: 2, estado: "pagado", andreani_envio_id: "ENV2", andreani_tracking: "tracking-ENV2", shipping_provider: "andreani" },
  ]
  const { admin, updates } = createFakeAdmin(orders)
  const consulted: string[] = []
  const andreaniFetch = fakeAndreaniFetch({
    "tracking-ENV-RESIDUAL": [{ Fecha: "2026-08-26T15:11:00.0000000", Evento: "EnvioEntregado", Estado: "Entregado" }],
    "tracking-ENV2": [{ Fecha: "2026-08-26T15:11:00.0000000", Evento: "EnvioEntregado", Estado: "Entregado" }],
  })
  const result = await runAndreaniTrackingSyncBatch(admin as never, {
    clientOptions: { env: qaClientEnv, fetch: async (input) => { consulted.push(String(input)); return andreaniFetch(input) } },
  })
  assert.equal(result.errors, 0)
  assert.equal(orders[0].estado, "pagado", "el pedido local no se mueve")
  assert.equal(updates.some((update) => update.id === 1), false)
  assert.equal(consulted.some((url) => url.includes("RESIDUAL")), false, "nunca se consulta a Andreani por él")
  assert.equal(orders[1].estado, "entregado", "Andreani sin regresión")
})

test("sync manual (botón Consultar): un pedido Envío BEYONIX se rechaza sin llamar a Andreani", async () => {
  const { syncAndreaniOrderTracking } = await import("./order-tracking-sync.ts")
  let calls = 0
  await assert.rejects(syncAndreaniOrderTracking({} as never, {
    id: 1, estado: "pagado", delivered_at: null, andreani_envio_id: "ENV-RESIDUAL", andreani_tracking: null, andreani_creation_environment: "QA",
    shipping_type: "domicilio", cliente_email: null, cliente_nombre: null, tracking_number: null, tracking_url: null, shipping_provider: "beyonix",
  }, { actorType: "admin", actorId: null, clientOptions: { env: qaClientEnv, fetch: async () => { calls += 1; return jsonResponse({}) } } }), /usa Envío BEYONIX/)
  assert.equal(calls, 0)
})

test("cron/lote: un pedido leído como Andreani que pasa a Envío BEYONIX durante la consulta => 0 writes, sin historial ni auditoría; el resto sigue igual", async () => {
  const base = { delivered_at: null, andreani_creation_environment: "QA" as const, cliente_email: null, cliente_nombre: null, tracking_number: null, tracking_url: null }
  const orders: FakeOrdenRow[] = [
    { ...base, id: 1, estado: "pagado", andreani_envio_id: "ENV1", andreani_tracking: "tracking-ENV1", shipping_provider: "andreani" },
    { ...base, id: 2, estado: "pagado", andreani_envio_id: "ENV2", andreani_tracking: "tracking-ENV2", shipping_provider: "andreani" },
  ]
  const { admin, auditEvents, historyRows, updates } = createFakeAdmin(orders)
  const delivered = [{ Fecha: "2026-08-26T15:11:00.0000000", Evento: "EnvioEntregado", Estado: "Entregado" }]
  const andreaniFetch = fakeAndreaniFetch({ "tracking-ENV1": delivered, "tracking-ENV2": delivered })
  const before = { ...orders[0] }
  const result = await runAndreaniTrackingSyncBatch(admin as never, {
    clientOptions: {
      env: qaClientEnv,
      fetch: async (input) => {
        // Mientras Andreani responde por ENV1, otro proceso pasa ese pedido a Envío BEYONIX.
        if (String(input).includes("tracking-ENV1")) orders[0].shipping_provider = "beyonix"
        return andreaniFetch(input)
      },
    },
  })
  assert.deepEqual(orders[0], { ...before, shipping_provider: "beyonix" }, "estado y tracking intactos")
  assert.equal(updates.some((update) => update.id === 1), false, "0 writes")
  assert.equal(historyRows.some((row) => row.order_id === 1), false)
  assert.equal(auditEvents.some((event) => event.order_id === 1), false)
  assert.deepEqual([result.updated, result.statusChanged, result.errors], [1, 1, 0])
  assert.equal(orders[1].estado, "entregado", "Andreani sin regresión")
})

test("cron/lote: el reintento diferido de un pedido que falló tampoco escribe si ya no es Andreani", async () => {
  const orders: FakeOrdenRow[] = [{ id: 1, estado: "pagado", delivered_at: null, andreani_envio_id: "ENV1", andreani_tracking: "tracking-ENV1", andreani_creation_environment: "QA", cliente_email: null, cliente_nombre: null, tracking_number: null, tracking_url: null, shipping_provider: "andreani" }]
  const { admin, updates } = createFakeAdmin(orders)
  const result = await silenceConsole(() => runAndreaniTrackingSyncBatch(admin as never, {
    clientOptions: {
      env: qaClientEnv,
      fetch: async () => {
        orders[0].shipping_provider = "beyonix"
        return new Response("caído", { status: 500 })
      },
    },
  }))
  assert.equal(result.errors, 1)
  assert.deepEqual(updates, [], "sin andreani_tracking_checked_at ni ningún otro write")
})

test("saturación: 20 pedidos Envío BEYONIX con andreani_envio_id residual al frente no ocupan lugares; entran los 10 Andreani válidos (limit 15)", async () => {
  const base = { delivered_at: null, andreani_creation_environment: "QA" as const, cliente_email: null, cliente_nombre: null, tracking_number: null, tracking_url: null, estado: "pagado" }
  const residual: FakeOrdenRow[] = Array.from({ length: 20 }, (_, index) => ({ ...base, id: index + 1, andreani_envio_id: `RES${index + 1}`, andreani_tracking: `tracking-RES${index + 1}`, shipping_provider: "beyonix" }))
  const andreani: FakeOrdenRow[] = Array.from({ length: 10 }, (_, index) => ({ ...base, id: 100 + index, andreani_envio_id: `AND${index}`, andreani_tracking: `tracking-AND${index}`, shipping_provider: "andreani" }))
  const { admin, listedLimits } = createFakeAdmin([...residual, ...andreani])
  const consulted: string[] = []
  const andreaniFetch = fakeAndreaniFetch({})
  const result = await runAndreaniTrackingSyncBatch(admin as never, {
    batchSize: 15,
    clientOptions: { env: qaClientEnv, fetch: async (input) => { consulted.push(String(input)); return andreaniFetch(input) } },
  })
  assert.deepEqual(listedLimits, [15])
  assert.deepEqual([result.checked, result.updated, result.errors], [10, 10, 0])
  assert.equal(consulted.some((url) => url.includes("RES")), false, "los residuales nunca se consultan")
  assert.equal(andreani.every((row) => row.andreani_tracking_checked_at), true, "los 10 Andreani se sincronizaron")
  assert.equal(residual.some((row) => row.andreani_tracking_checked_at), false)
})

test("selección del lote: regla canónica de Andreani (shipping_provider o envio_proveedor legacy), sin incluir BEYONIX", async () => {
  const base = { delivered_at: null, andreani_creation_environment: "QA" as const, cliente_email: null, cliente_nombre: null, tracking_number: null, tracking_url: null, estado: "pagado" }
  const orders: FakeOrdenRow[] = [
    { ...base, id: 1, andreani_envio_id: "E1", andreani_tracking: "tracking-E1", shipping_provider: "Andreani" },
    { ...base, id: 2, andreani_envio_id: "E2", andreani_tracking: "tracking-E2", shipping_provider: null, envio_proveedor: "andreani" },
    { ...base, id: 3, andreani_envio_id: "E3", andreani_tracking: "tracking-E3", shipping_provider: "beyonix", envio_proveedor: "andreani" },
    { ...base, id: 4, andreani_envio_id: "E4", andreani_tracking: "tracking-E4", shipping_provider: null, envio_proveedor: "beyonix" },
  ]
  const { admin } = createFakeAdmin(orders)
  const result = await runAndreaniTrackingSyncBatch(admin as never, { clientOptions: { env: qaClientEnv, fetch: fakeAndreaniFetch({}) } })
  assert.equal(result.checked, 2)
  assert.deepEqual(orders.filter((row) => row.andreani_tracking_checked_at).map((row) => row.id), [1, 2])
})

test("cron: reutiliza el lote (misma selección y mismos writes), sin consultas propias a pedidos", () => {
  const cron = readFileSync(new URL("../../app/api/cron/andreani-sync-tracking/route.ts", import.meta.url), "utf8")
  assert.match(cron, /await runAndreaniTrackingSyncBatch\(admin, \{ deadlineMs: startedAt \+ PEDIDOS_TIME_BUDGET_MS \}\)/)
  assert.doesNotMatch(cron, /from\("ordenes"\)/)
  const batch = readFileSync(new URL("./tracking-sync-batch.ts", import.meta.url), "utf8")
  assert.match(batch, /\.or\(withAndreaniProvider\(\["andreani_tracking_checked_at\.is\.null", `andreani_tracking_checked_at\.lt\.\$\{staleBefore\}`\]\)\)\s+\.order\("andreani_tracking_checked_at", \{ ascending: true, nullsFirst: true \}\)\s+\.limit\(batchSize\)/)
})
