import assert from "node:assert/strict"
import test from "node:test"

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

  function ordenesTable() {
    return {
      select() {
        const chain = {
          not: () => chain,
          or: () => chain,
          order: () => chain,
          limit: async (n: number) => ({
            data: seedOrders.slice(0, n).map((row) => ({ ...row })),
            error: null,
          }),
        }
        return chain
      },
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
                const row = seedOrders.find((candidate) =>
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
      throw new Error(`tabla inesperada en el mock: ${table}`)
    },
  }

  return { admin, auditEvents }
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
