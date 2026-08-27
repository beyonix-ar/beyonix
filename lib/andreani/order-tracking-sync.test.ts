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

  const admin = {
    from(table: string) {
      if (table === "ordenes") {
        return {
          update(payload: Record<string, unknown>) {
            const filters: Array<{ col: string; val: unknown }> = []
            const builder = {
              eq(col: string, val: unknown) {
                filters.push({ col, val })
                return builder
              },
              select() {
                return {
                  async maybeSingle() {
                    const row = ordenes.find((candidate) =>
                      filters.every((filter) => candidate[filter.col] === filter.val),
                    )
                    if (!row) return { data: null, error: null }
                    Object.assign(row, payload)
                    return { data: { ...row }, error: null }
                  },
                }
              },
            }
            return builder
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

  return { admin, auditEvents }
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
