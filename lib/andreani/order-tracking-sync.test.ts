import assert from "node:assert/strict"
import test from "node:test"

import {
  fetchAndreaniOrderTrackingSnapshot,
  resolveAndreaniTrackingEnvironment,
  syncAndreaniOrderTracking,
  type AndreaniOrderTrackingRow,
} from "./order-tracking-sync.ts"

const qaClientEnv: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  ANDREANI_ENV: "QA",
  ANDREANI_QA_API_URL: "https://apisqa.andreani.com",
  ANDREANI_QA_USERNAME: "usuario-prueba",
  ANDREANI_QA_PASSWORD: "clave-prueba",
}

function baseOrder(overrides: Partial<AndreaniOrderTrackingRow> = {}): AndreaniOrderTrackingRow {
  return {
    id: 2,
    estado: "pagado",
    delivered_at: null,
    andreani_envio_id: "API0000166828479",
    andreani_tracking: "360003080248490",
    andreani_creation_environment: "QA",
    shipping_type: "domicilio",
    cliente_email: "cliente@example.com",
    cliente_nombre: "Lucas Espinosa",
    tracking_number: null,
    tracking_url: null,
    ...overrides,
  }
}

function jsonResponse(body: unknown) {
  return Response.json(body)
}

const mixedDateTrackingFetch = async (input: string | URL | Request) => {
  const url = new URL(String(input))
  if (url.pathname === "/login") return jsonResponse({ token: "token-prueba" })
  if (url.pathname.endsWith("/trazas")) return jsonResponse({ eventos: [
    { Fecha: "2026-08-26T16:00:00Z", Evento: "OrdenDeEnvioCreada", Estado: "Creada" },
    { Fecha: "2026-08-26T14:00:00", Evento: "EnvioDespachado", Estado: "Despachado" },
  ] })
  return jsonResponse({ estado: "Creada", tipo: "B2C", bultos: [{ numeroDeBulto: "1", numeroDeEnvio: "360003080248490" }] })
}

test("tracking ordena correctamente eventos mezclados con offset y sin offset", async () => {
  const snapshot = await fetchAndreaniOrderTrackingSnapshot(baseOrder(), { env: qaClientEnv, fetch: mixedDateTrackingFetch })
  assert.equal(snapshot.latestEvent?.Evento, "EnvioDespachado")
  assert.equal(snapshot.logisticsEstado, "Despachado")
})

test("tracking atrasado no pisa un evento más reciente persistido concurrentemente", async () => {
  const row = { id: 2, estado: "pagado", delivered_at: null, andreani_tracking_event_at: "2026-08-26T18:00:00Z", andreani_estado: "En distribución" }
  const { admin, auditEvents } = createFakeAdmin([row])
  const result = await syncAndreaniOrderTracking(admin as never, baseOrder(), {
    actorType: "system", actorId: null, clientOptions: { env: qaClientEnv, fetch: mixedDateTrackingFetch },
  })
  assert.equal(result.statusChanged, false)
  assert.equal(row.andreani_estado, "En distribución")
  assert.equal(row.andreani_tracking_event_at, "2026-08-26T18:00:00Z")
  assert.equal(auditEvents.length, 0)
})

// Respuestas reales de Andreani PROD (2026-10-06) para una orden rechazada:
// GET /v2/ordenes-de-envio/{id} -> estado "Rechazada" (femenino) y la traza
// OrdenDeEnvioRechazada con ciclo DIRECTO.
test("tracking detecta el rechazo posterior a la creación con el estado real de PROD (\"Rechazada\")", async () => {
  const snapshot = await fetchAndreaniOrderTrackingSnapshot(baseOrder(), {
    env: qaClientEnv,
    fetch: async (input) => {
      const url = new URL(String(input))
      if (url.pathname === "/login") return jsonResponse({ token: "token-prueba" })
      if (url.pathname.endsWith("/trazas")) {
        return jsonResponse({
          eventos: [
            { Fecha: "2026-10-06T19:26:30.0000000", Evento: "OrdenDeEnvioSolicitada", Estado: "Pendiente de ingreso" },
            { Fecha: "2026-10-06T19:26:32.3345397", Ciclo: "DIRECTO", Evento: "OrdenDeEnvioRechazada", Motivo: "El contrato 400042104 no permite entrega en sucursal." },
          ],
        })
      }
      return jsonResponse({ estado: "Rechazada", motivo: "El contrato 400042104 no permite entrega en sucursal.", tipo: "B2C", bultos: [{ numeroDeBulto: "1", numeroDeEnvio: "360003123478040" }] })
    },
  })
  assert.equal(snapshot.rejectedAfterCreation, true)
  assert.equal(snapshot.logisticsEstado, "Rechazada")
})

test("tracking no falla durante el estado transitorio real de PROD (\"Solicitada\")", async () => {
  const snapshot = await fetchAndreaniOrderTrackingSnapshot(baseOrder(), {
    env: qaClientEnv,
    fetch: async (input) => {
      const url = new URL(String(input))
      if (url.pathname === "/login") return jsonResponse({ token: "token-prueba" })
      if (url.pathname.endsWith("/trazas")) {
        return jsonResponse({ eventos: [{ Fecha: "2026-10-06T19:26:30.0000000", Evento: "OrdenDeEnvioSolicitada", Estado: "Pendiente de ingreso" }] })
      }
      return jsonResponse({ estado: "Solicitada", tipo: "B2C", bultos: [{ numeroDeBulto: "1", numeroDeEnvio: "360003123479210" }] })
    },
  })
  assert.equal(snapshot.rejectedAfterCreation, false)
  assert.equal(snapshot.logisticsEstado, "Pendiente de ingreso")
})

test("resolveAndreaniTrackingEnvironment usa el ambiente donde se creó el envío, nunca el configurado hoy", () => {
  assert.equal(resolveAndreaniTrackingEnvironment({ andreani_creation_environment: "PROD" }), "PROD")
  assert.equal(resolveAndreaniTrackingEnvironment({ andreani_creation_environment: "QA" }), "QA")
  assert.equal(resolveAndreaniTrackingEnvironment({ andreani_creation_environment: null }), "QA")
})

test("fetchAndreaniOrderTrackingSnapshot rechaza sin llamar a Andreani si no hay envío generado", async () => {
  await assert.rejects(
    () =>
      fetchAndreaniOrderTrackingSnapshot(
        { andreani_envio_id: "", andreani_tracking: null, andreani_creation_environment: "QA" },
        { fetch: () => { throw new Error("no debería llamarse") } },
      ),
    (error: unknown) => error instanceof Error && error.message.includes("envío Andreani generado"),
  )
})

test("fetchAndreaniOrderTrackingSnapshot: el timestamp naive del evento se persiste como el instante UTC correcto", async () => {
  const snapshot = await fetchAndreaniOrderTrackingSnapshot(baseOrder(), {
    env: qaClientEnv,
    fetch: async (input) => {
      const url = new URL(String(input))
      if (url.pathname === "/login") return jsonResponse({ token: "token-prueba" })
      if (url.pathname.endsWith("/trazas")) {
        return jsonResponse({
          eventos: [
            { Fecha: "2026-08-26T15:11:00.0000000", Evento: "OrdenDeEnvioSolicitada", Estado: "Pendiente de ingreso" },
            { Fecha: "2026-08-26T15:11:02.4760000", Evento: "OrdenDeEnvioCreada" },
          ],
        })
      }
      return jsonResponse({
        estado: "Creada",
        tipo: "B2C",
        bultos: [{ numeroDeBulto: "1", numeroDeEnvio: "360003080248490" }],
        agrupadorDeBultos: "API0000166828479",
      })
    },
  })

  assert.equal(snapshot.logisticsEstado, "Pendiente de ingreso")
  assert.equal(snapshot.latestEvent?.Fecha, "2026-08-26T15:11:02.4760000")
  assert.equal(snapshot.rejectedAfterCreation, false)
})

interface FakeOrdenesRow extends Record<string, unknown> {
  id: number
  estado: string
  delivered_at: string | null
}

function createFakeAdmin(ordenes: FakeOrdenesRow[]) {
  const auditEvents: Array<Record<string, unknown>> = []
  // Simula UNIQUE(dedupe_key) + ON CONFLICT DO NOTHING de andreani_tracking_events.
  const historyRows: Array<Record<string, unknown>> = []

  const admin = {
    from(table: string) {
      if (table === "ordenes") {
        return {
          update(payload: Record<string, unknown>) {
            const filters: Array<{ col: string; val: unknown }> = []
            let eventPredicate: (row: Record<string, unknown>) => boolean = () => true
            const apply = () => {
              const row = ordenes.find((candidate) =>
                filters.every((filter) => candidate[filter.col] === filter.val) && eventPredicate(candidate),
              )
              if (row) Object.assign(row, payload)
              return row
            }
            const builder = {
              or(expression: string) {
                const timestamp = expression.split(".lte.")[1]
                eventPredicate = (row) => row.andreani_tracking_event_at == null ||
                  Date.parse(String(row.andreani_tracking_event_at)) <= Date.parse(timestamp)
                return builder
              },
              is(col: string) {
                eventPredicate = (row) => row[col] == null
                return builder
              },
              eq(col: string, val: unknown) {
                filters.push({ col, val })
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
              then(resolve: (value: { error: null }) => unknown) {
                apply()
                return resolve({ error: null })
              },
            }
            return builder
          },
        }
      }
      if (table === "andreani_tracking_events") {
        return {
          upsert(rows: Array<Record<string, unknown>>, options: { onConflict: string; ignoreDuplicates: boolean }) {
            assert.deepEqual(options, { onConflict: "dedupe_key", ignoreDuplicates: true })
            const inserted = rows.filter((row) => !historyRows.some((existing) => existing.dedupe_key === row.dedupe_key))
            historyRows.push(...inserted)
            return { select: async () => ({ data: inserted.map((row) => ({ dedupe_key: row.dedupe_key })), error: null }) }
          },
        }
      }
      if (table === "orden_items") {
        return {
          select() {
            return { eq: async () => ({ data: [], error: null }) }
          },
        }
      }
      if (table === "order_audit_events") {
        return {
          insert: async (payload: Record<string, unknown>) => {
            auditEvents.push(payload)
            return { error: null }
          },
        }
      }
      throw new Error(`tabla inesperada en el mock: ${table}`)
    },
  }

  return { admin, auditEvents, historyRows }
}

test("syncAndreaniOrderTracking: EnvioEntregado real marca entregado, setea delivered_at una sola vez y audita", async () => {
  const { admin, auditEvents } = createFakeAdmin([
    { id: 2, estado: "pagado", delivered_at: null },
  ])

  const result = await syncAndreaniOrderTracking(admin as never, baseOrder(), {
    actorType: "system",
    actorId: null,
    clientOptions: {
      env: qaClientEnv,
      fetch: async (input) => {
        const url = new URL(String(input))
        if (url.pathname === "/login") return jsonResponse({ token: "token-prueba" })
        if (url.pathname.endsWith("/trazas")) {
          return jsonResponse({
            eventos: [{ Fecha: "2026-08-26T15:11:02.0000000", Evento: "EnvioEntregado", Estado: "Entregado" }],
          })
        }
        return jsonResponse({
          estado: "Creada",
          tipo: "B2C",
          bultos: [{ numeroDeBulto: "1", numeroDeEnvio: "360003080248490" }],
        })
      },
    },
  })

  assert.equal(result.statusChanged, true)
  assert.equal(result.newEstado, "entregado")
  assert.equal(auditEvents.length, 1)
  assert.equal(auditEvents[0].action, "andreani_tracking_auto_status_changed")
  assert.equal(auditEvents[0].previous_status, "pagado")
  assert.equal(auditEvents[0].new_status, "entregado")
})

test("syncAndreaniOrderTracking: sin evidencia de despacho/entrega, sólo actualiza tracking sin tocar estado", async () => {
  const { admin, auditEvents } = createFakeAdmin([
    { id: 2, estado: "pagado", delivered_at: null },
  ])

  const result = await syncAndreaniOrderTracking(admin as never, baseOrder(), {
    actorType: "system",
    actorId: null,
    clientOptions: {
      env: qaClientEnv,
      fetch: async (input) => {
        const url = new URL(String(input))
        if (url.pathname === "/login") return jsonResponse({ token: "token-prueba" })
        if (url.pathname.endsWith("/trazas")) {
          return jsonResponse({
            eventos: [{ Fecha: "2026-08-26T15:11:00.0000000", Evento: "OrdenDeEnvioCreada" }],
          })
        }
        return jsonResponse({ estado: "Creada", tipo: "B2C", bultos: [{ numeroDeBulto: "1", numeroDeEnvio: "360003080248490" }] })
      },
    },
  })

  assert.equal(result.statusChanged, false)
  assert.equal(result.newEstado, null)
  assert.equal(auditEvents.length, 0)
})

test("syncAndreaniOrderTracking: no pisa un cambio manual concurrente (el estado ya no coincide con el leído)", async () => {
  // El pedido cambió a "cancelado" entre que se leyó y que terminó la
  // consulta a Andreani (ej. un admin lo canceló mientras tanto) -- la
  // sincronización automática no debe forzar "entregado" por encima.
  const { admin, auditEvents } = createFakeAdmin([
    { id: 2, estado: "cancelado", delivered_at: null },
  ])

  const result = await syncAndreaniOrderTracking(admin as never, baseOrder({ estado: "pagado" }), {
    actorType: "system",
    actorId: null,
    clientOptions: {
      env: qaClientEnv,
      fetch: async (input) => {
        const url = new URL(String(input))
        if (url.pathname === "/login") return jsonResponse({ token: "token-prueba" })
        if (url.pathname.endsWith("/trazas")) {
          return jsonResponse({ eventos: [{ Fecha: "2026-08-26T15:11:00.0000000", Evento: "EnvioEntregado" }] })
        }
        return jsonResponse({ estado: "Creada", tipo: "B2C", bultos: [{ numeroDeBulto: "1", numeroDeEnvio: "360003080248490" }] })
      },
    },
  })

  assert.equal(result.statusChanged, false)
  assert.equal(auditEvents.length, 0)
})

// ── Progresión automática de un pedido normal + historial ──────────────────

function trackingFetch(eventos: () => unknown[]) {
  return async (input: string | URL | Request) => {
    const url = new URL(String(input))
    if (url.pathname === "/login") return jsonResponse({ token: "token-prueba" })
    if (url.pathname.endsWith("/trazas")) return jsonResponse({ eventos: eventos() })
    return jsonResponse({ estado: "Creada", tipo: "B2C", bultos: [{ numeroDeBulto: "1", numeroDeEnvio: "360003080248490" }] })
  }
}

test("pedido normal a sucursal: creado -> admitido -> en camino -> en sucursal -> entregado, con historial sin duplicados", async () => {
  const row: FakeOrdenesRow = { id: 2, estado: "pagado", delivered_at: null }
  const { admin, auditEvents, historyRows } = createFakeAdmin([row])
  const eventos: unknown[] = [
    { Fecha: "2026-10-20T09:00:00.0000000", Evento: "OrdenDeEnvioCreada", Estado: "Pendiente de ingreso" },
  ]
  const sync = () => syncAndreaniOrderTracking(admin as never, baseOrder({ estado: row.estado, delivered_at: row.delivered_at, shipping_type: "sucursal" }), {
    actorType: "system", actorId: null, clientOptions: { env: qaClientEnv, fetch: trackingFetch(() => eventos) },
  })

  assert.equal((await sync()).statusChanged, false, "orden creada: no avanza")
  assert.equal(row.estado, "pagado")

  eventos.push({ Fecha: "2026-10-20T12:00:00.0000000", Evento: "Admision", Estado: "Ingresado" })
  assert.equal((await sync()).newEstado, "enviado", "admitido por Andreani")
  eventos.push({ Fecha: "2026-10-21T08:00:00.0000000", Evento: "EnvioDespachado", Estado: "En viaje" })
  assert.equal((await sync()).newEstado, "en_camino", "en tránsito")
  eventos.push({ Fecha: "2026-10-22T10:00:00.0000000", Evento: "RecepcionEnSucursalDestino", Estado: "En sucursal" })
  assert.equal((await sync()).newEstado, "en_sucursal", "llegada a sucursal")
  eventos.push({ Fecha: "2026-10-23T16:00:00.0000000", Evento: "EnvioEntregado", Estado: "Entregado" })
  const delivered = await sync()
  assert.equal(delivered.newEstado, "entregado")
  assert.ok(row.delivered_at, "delivered_at se setea al entregar")

  assert.deepEqual(
    auditEvents.map((event) => [event.previous_status, event.new_status]),
    [["pagado", "enviado"], ["enviado", "en_camino"], ["en_camino", "en_sucursal"], ["en_sucursal", "entregado"]],
  )
  // Un registro por evento, aunque el cron consultó 5 veces la misma traza.
  assert.deepEqual(historyRows.map((history) => history.event_code), [
    "OrdenDeEnvioCreada", "Admision", "EnvioDespachado", "RecepcionEnSucursalDestino", "EnvioEntregado",
  ])
  assert.deepEqual(
    historyRows.map((history) => [history.previous_status, history.new_status]),
    [[null, null], ["pagado", "enviado"], ["enviado", "en_camino"], ["en_camino", "en_sucursal"], ["en_sucursal", "entregado"]],
  )
  for (const history of historyRows) {
    assert.equal(history.source, "andreani")
    assert.equal(history.tracking, "360003080248490")
    assert.equal(history.recognized, true)
    assert.equal(history.order_id, 2)
    assert.equal(history.claim_shipment_id, null)
  }
  assert.equal(historyRows[1].event_text, "Ingresado")
  assert.equal(historyRows[1].event_at, "2026-10-20T15:00:00.000Z", "fecha naive de Andreani interpretada en hora argentina")

  // Mismo estado repetido: ni historial nuevo, ni auditoría, ni transición.
  const again = await sync()
  assert.equal(again.statusChanged, false)
  assert.deepEqual(again.newHistoryEvents, [])
  assert.equal(historyRows.length, 5)
  assert.equal(auditEvents.length, 4)
})

test("varios hitos en una sola consulta: una transición, atribuida al evento que la prueba", async () => {
  const row: FakeOrdenesRow = { id: 2, estado: "pagado", delivered_at: null }
  const { admin, historyRows } = createFakeAdmin([row])
  const result = await syncAndreaniOrderTracking(admin as never, baseOrder(), {
    actorType: "system", actorId: null,
    clientOptions: { env: qaClientEnv, fetch: trackingFetch(() => [
      { Fecha: "2026-10-20T12:00:00.0000000", Evento: "Admision", Estado: "Ingresado" },
      { Fecha: "2026-10-21T08:00:00.0000000", Evento: "EnvioDespachado", Estado: "En viaje" },
      { Fecha: "2026-10-21T18:00:00.0000000", Evento: "Distribucion", Estado: "En distribución" },
    ]) },
  })
  assert.equal(result.newEstado, "en_camino")
  assert.deepEqual(
    historyRows.map((history) => [history.event_code, history.previous_status, history.new_status]),
    [["Admision", null, null], ["EnvioDespachado", "pagado", "en_camino"], ["Distribucion", null, null]],
  )
})

test("estado desconocido: se guarda crudo, se marca para revisión una sola vez y nunca cambia el estado", async () => {
  const row: FakeOrdenesRow = { id: 2, estado: "en_camino", delivered_at: null }
  const { admin, auditEvents, historyRows } = createFakeAdmin([row])
  const warnings: unknown[][] = []
  const originalWarn = console.warn
  console.warn = (...args: unknown[]) => { warnings.push(args) }
  try {
    const eventos = [
      { Fecha: "2026-10-21T08:00:00.0000000", Evento: "EnvioDespachado", Estado: "En viaje" },
      { Fecha: "2026-10-22T09:30:00.0000000", Ciclo: "DIRECTO", Evento: "EnvioEnRevisionAduanera", Estado: "Retenido en aduana" },
    ]
    const sync = () => syncAndreaniOrderTracking(admin as never, baseOrder({ estado: row.estado }), {
      actorType: "system", actorId: null, clientOptions: { env: qaClientEnv, fetch: trackingFetch(() => eventos) },
    })
    const first = await sync()
    assert.equal(first.statusChanged, false, "no inventa una transición")
    assert.equal(row.estado, "en_camino", "el pedido no se rompe ni cambia a un estado incorrecto")
    assert.equal(first.snapshot.logisticsEstado, "En viaje", "el texto visible sigue saliendo de eventos conocidos")
    assert.deepEqual(first.snapshot.eventosNoReconocidos.map((event) => event.Evento), ["EnvioEnRevisionAduanera"])

    const unknown = historyRows.find((history) => history.event_code === "EnvioEnRevisionAduanera")
    assert.ok(unknown, "el evento desconocido no se pierde")
    assert.deepEqual([unknown.recognized, unknown.review_required, unknown.event_text, unknown.event_cycle, unknown.previous_status],
      [false, true, "Retenido en aduana", "DIRECTO", null])
    assert.equal(row.andreani_tracking_review_event, "EnvioEnRevisionAduanera · Retenido en aduana")
    assert.ok(row.andreani_tracking_review_at)
    assert.deepEqual(auditEvents.map((event) => event.action), ["andreani_tracking_unknown_event"])
    assert.equal((auditEvents[0].metadata as Record<string, unknown>).eventCode, "EnvioEnRevisionAduanera")
    assert.equal(warnings.filter(([tag]) => tag === "ANDREANI_TRACKING_UNKNOWN_EVENT").length, 1)

    // El cron lo vuelve a ver: sin auditoría, log ni historial duplicados.
    await sync()
    assert.equal(auditEvents.length, 1)
    assert.equal(historyRows.filter((history) => !history.recognized).length, 1)
    assert.equal(warnings.filter(([tag]) => tag === "ANDREANI_TRACKING_UNKNOWN_EVENT").length, 1)

    // Un desconocido posterior no pisa la primera marca de revisión.
    eventos.push({ Fecha: "2026-10-23T09:30:00.0000000", Ciclo: "DIRECTO", Evento: "OtroEventoNuevo", Estado: "Otro" })
    await sync()
    assert.equal(row.andreani_tracking_review_event, "EnvioEnRevisionAduanera · Retenido en aduana")
    assert.equal(auditEvents.length, 2)
  } finally {
    console.warn = originalWarn
  }
})

test("si el historial no se puede guardar, el tracking igual se aplica y lo desconocido queda en el log", async () => {
  const row: FakeOrdenesRow = { id: 2, estado: "pagado", delivered_at: null }
  const { admin } = createFakeAdmin([row])
  const failingAdmin = {
    from(table: string) {
      if (table === "andreani_tracking_events") {
        return { upsert: () => ({ select: async () => ({ data: null, error: { message: "relation does not exist" } }) }) }
      }
      return admin.from(table)
    },
  }
  const errors: unknown[][] = []
  const originalError = console.error
  console.error = (...args: unknown[]) => { errors.push(args) }
  try {
    const result = await syncAndreaniOrderTracking(failingAdmin as never, baseOrder(), {
      actorType: "system", actorId: null,
      clientOptions: { env: qaClientEnv, fetch: trackingFetch(() => [
        { Fecha: "2026-10-21T08:00:00.0000000", Evento: "EnvioDespachado", Estado: "En viaje" },
        { Fecha: "2026-10-22T09:30:00.0000000", Evento: "EventoNuevo", Estado: "Nuevo" },
      ]) },
    })
    assert.equal(result.newEstado, "en_camino")
    const [historyError] = errors.filter(([tag]) => tag === "ANDREANI_TRACKING_HISTORY_ERROR")
    assert.ok(historyError)
    assert.deepEqual((historyError[1] as { unrecognized: Array<{ code: string }> }).unrecognized.map((event) => event.code), ["EventoNuevo"])
  } finally {
    console.error = originalError
  }
})
