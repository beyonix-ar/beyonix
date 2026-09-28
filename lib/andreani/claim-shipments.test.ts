import assert from "node:assert/strict"
import test from "node:test"

import { AndreaniError } from "./client.ts"
import {
  buildClaimReturnEnvio,
  chooseClaimReturnModality,
  chooseReplacementShipment,
  createAndreaniReplacementShipmentForClaim,
  createAndreaniReturnForClaim,
  getClaimShipmentLabel,
  reconcileClaimShipment,
  resolveAndreaniReturnConfig,
  resolveClaimShipmentPhase,
  runClaimShipmentTrackingBatch,
  syncClaimShipmentTracking,
} from "./claim-shipments.ts"
import { resolveAndreaniShipmentCreationConfig } from "./order-shipment.ts"
import type { AndreaniCreateShipmentInput, AndreaniCreateShipmentResponse } from "./types.ts"

// Envíos Andreani de un reclamo con cambio (sin red): Andreani falso y un
// cliente admin en memoria con la MISMA semántica que las RPCs de
// 20260928100000 (probadas contra PGlite en claim-andreani-shipments-sql.test.ts).

function qaEnv(overrides: Partial<NodeJS.ProcessEnv> = {}): NodeJS.ProcessEnv {
  return {
    ANDREANI_ENV: "QA",
    ANDREANI_TARIFF_ENV: "QA",
    ANDREANI_SHIPMENT_ENV: "QA",
    ANDREANI_QA_API_URL: "https://apisqa.andreani.com",
    ANDREANI_QA_USERNAME: "usuario-prueba",
    ANDREANI_QA_PASSWORD: "clave-prueba",
    ANDREANI_QA_CLIENT: "CLIENTE-QA",
    ANDREANI_QA_HOME_CONTRACT: "400042104",
    ANDREANI_QA_BRANCH_CONTRACT: "400042106",
    ANDREANI_QA_ORIGIN_BRANCH: "RAC",
    ANDREANI_QA_ORIGIN_BRANCH_ID: "20001",
    ANDREANI_QA_RETURN_PICKUP_CONTRACT: "CONTRATO-RETIRO",
    ANDREANI_QA_RETURN_DROPOFF_CONTRACT: "CONTRATO-DESPACHO",
    ANDREANI_REMITENTE_NOMBRE: "BEYONIX",
    ANDREANI_REMITENTE_EMAIL: "logistica@beyonix.test",
    ANDREANI_REMITENTE_TELEFONO: "1144445555",
    NODE_ENV: "test",
    ...overrides,
  }
}

/** PROD como indicó Andreani, con las barreras explícitas vigentes. */
function prodEnv(overrides: Partial<NodeJS.ProcessEnv> = {}): NodeJS.ProcessEnv {
  return {
    ...qaEnv(),
    ANDREANI_SHIPMENT_ENV: "PROD",
    ANDREANI_PROD_API_URL: "https://apis.andreani.com",
    ANDREANI_PROD_USERNAME: "u",
    ANDREANI_PROD_PASSWORD: "p",
    ANDREANI_PROD_CLIENT: "0012011683",
    ANDREANI_PROD_HOME_CONTRACT: "400042104",
    ANDREANI_PROD_BRANCH_CONTRACT: "400042106",
    ANDREANI_PROD_ORIGIN_BRANCH: "RAC",
    ANDREANI_PROD_ORIGIN_BRANCH_ID: "10179",
    ANDREANI_ALLOW_PROD_SHIPMENT_CREATION: "true",
    NODE_ENV: "production",
    ...overrides,
  }
}

const homeOrder = {
  id: 7,
  cliente_nombre: "María Núñez",
  cliente_email: "maria@example.test",
  cliente_telefono: "11 5555-6666",
  cliente_dni: "30123456",
  cliente_direccion: "Av. Corrientes 1234, Piso 3, Depto B",
  cp_destino: "1043",
  localidad: "CABA",
  provincia: "CABA",
  shipping_type: "domicilio",
  shipping_provider: "andreani",
  andreani_sucursal_id: null as string | null,
}

type Row = Record<string, unknown>

function fakeAdmin({
  order = homeOrder,
  claimStatus = "aprobado",
  returnCreation = "not_started",
  replacements = [] as Row[],
} = {}) {
  const tables: Record<string, Row[]> = {
    order_claims: [{ id: 50, order_id: 7, status: claimStatus, resolution: "cambio_producto", affected_items: [{ order_item_id: 70, quantity: 1 }] }],
    order_claim_shipments: [shipmentRow("devolucion", returnCreation)],
    ordenes: [order],
    orden_items: [
      { id: 70, orden_id: 7, producto_id: 3, variante_id: 30, conditioned_stock_id: null, cantidad: 2, precio: 45000 },
      { id: 71, orden_id: 7, producto_id: 4, variante_id: null, conditioned_stock_id: null, cantidad: 1, precio: 9000 },
    ],
    productos: [
      { id: 3, nombre: "Trípode Ñandú", sku: "T-1", peso_empaquetado_kg: 2, alto_paquete_cm: 30, ancho_paquete_cm: 20, largo_paquete_cm: 10 },
      { id: 4, nombre: "Funda", sku: "F-1", peso_empaquetado_kg: 1, alto_paquete_cm: 5, ancho_paquete_cm: 5, largo_paquete_cm: 5 },
    ],
    producto_variantes: [
      { id: 30, producto_id: 3, nombre: "Negro", sku: "T-1-N", peso_empaquetado_kg: 2, alto_paquete_cm: 30, ancho_paquete_cm: 20, largo_paquete_cm: 10 },
      { id: 31, producto_id: 3, nombre: "Rojo XL", sku: "T-1-R", peso_empaquetado_kg: 3.5, alto_paquete_cm: 40, ancho_paquete_cm: 25, largo_paquete_cm: 12 },
    ],
    order_replacements: replacements,
  }
  function shipmentRow(direction: string, creation: string): Row {
    return {
      id: direction === "devolucion" ? 1 : 2, claim_id: 50, order_id: 7, direction, status: "pendiente", modality: null,
      environment: null, contract: null, andreani_envio_id: null, andreani_tracking: null, andreani_estado: null,
      cost_amount: null, creation_status: creation, creation_token: null, creation_error: null, delivered_at: null, last_checked_at: null,
    }
  }
  const rpcs: Array<{ name: string; args: Row }> = []
  const find = (direction: unknown) => tables.order_claim_shipments.find((row) => row.direction === direction)
  const query = (table: string) => {
    const filters: Array<(row: Row) => boolean> = []
    let limit = Infinity
    // Copias, como Supabase: mutar la base no cambia lo ya leído.
    const rows = () => (tables[table] ?? []).filter((row) => filters.every((filter) => filter(row))).slice(0, limit).map((row) => ({ ...row }))
    const builder = {
      select: () => builder,
      eq: (key: string, value: unknown) => { filters.push((row) => row[key] === value); return builder },
      in: (key: string, values: unknown[]) => { filters.push((row) => values.includes(row[key])); return builder },
      order: () => builder,
      limit: (n: number) => { limit = n; return builder },
      maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      then: (resolve: (value: { data: Row[]; error: null }) => unknown) => resolve({ data: rows(), error: null }),
    }
    return builder
  }
  const rpc = async (name: string, args: Row) => {
    rpcs.push({ name, args })
    let row = find(args.p_direction)
    if (name === "claim_order_claim_shipment_creation") {
      if (!row) { row = shipmentRow(String(args.p_direction), "not_started"); tables.order_claim_shipments.push(row) }
      if (row.creation_status === "created") return { data: { ...row }, error: null }
      if (row.creation_status === "processing" || row.creation_status === "manual_review") return { data: null, error: null }
      Object.assign(row, { creation_status: "processing", creation_token: args.p_token, environment: args.p_environment,
        modality: args.p_modality, contract: args.p_contract, creation_error: null })
      return { data: { ...row }, error: null }
    }
    if (!row && name === "fail_order_claim_shipment_creation" && args.p_outcome === "blocked") {
      row = shipmentRow(String(args.p_direction), "not_started")
      tables.order_claim_shipments.push(row)
    }
    if (!row) return { data: null, error: { message: "CLAIM_SHIPMENT_NOT_FOUND" } }
    if (name === "complete_order_claim_shipment_creation") {
      if (row.creation_token !== args.p_token) return { data: null, error: { message: "CLAIM_SHIPMENT_NOT_CLAIMED" } }
      Object.assign(row, { creation_status: "created", status: "generada", creation_token: null, andreani_envio_id: args.p_envio_id,
        andreani_tracking: args.p_tracking, andreani_estado: args.p_estado, cost_amount: args.p_cost_amount })
      return { data: { ...row }, error: null }
    }
    if (name === "fail_order_claim_shipment_creation") {
      if (args.p_outcome === "blocked") Object.assign(row, { creation_error: args.p_error })
      else if (row.creation_token === args.p_token) Object.assign(row, { creation_status: args.p_outcome, creation_token: null, creation_error: args.p_error })
      return { data: { ...row }, error: null }
    }
    if (name === "resolve_order_claim_shipment_reconciliation") {
      if (row.creation_status !== "manual_review") return { data: null, error: { message: "CLAIM_SHIPMENT_RECONCILIATION_NOT_PENDING" } }
      Object.assign(row, args.p_resolution === "created"
        ? { creation_status: "created", status: "generada", andreani_envio_id: args.p_envio_id, andreani_tracking: args.p_tracking ?? args.p_envio_id }
        : { creation_status: "failed" })
      return { data: { ...row }, error: null }
    }
    if (name === "apply_order_claim_shipment_tracking") {
      if (args.p_phase === "entregada" && row.status !== "entregada") Object.assign(row, { status: "entregada", delivered_at: "ahora" })
      else if (args.p_phase === "en_transito" && ["generada", "incidencia"].includes(String(row.status))) row.status = "en_transito"
      else if (args.p_phase === "incidencia" && row.status !== "entregada") row.status = "incidencia"
      Object.assign(row, { andreani_estado: args.p_estado, last_checked_at: "ahora" })
      return { data: { ...row }, error: null }
    }
    throw new Error(`rpc inesperada ${name}`)
  }
  return { admin: { from: query, rpc } as never, rpcs, tables, shipment: (direction: string) => find(direction) as Row }
}

const created: AndreaniCreateShipmentResponse = {
  estado: "Creada",
  tipo: "B2C",
  bultos: [{ numeroDeBulto: "1", numeroDeEnvio: "360000012345678" }],
}

function recordingCrear(response: AndreaniCreateShipmentResponse | Error = created) {
  const calls: Array<{ input: AndreaniCreateShipmentInput; options: Row }> = []
  const crear = async (input: AndreaniCreateShipmentInput, options: Row) => {
    calls.push({ input, options })
    if (response instanceof Error) throw response
    return response
  }
  return { calls, crear: crear as never }
}

const enabled = async () => ({ enabled: true }) as never
const deps = (crear: never, env = qaEnv()) => ({ env, crearOrdenEnvio: crear, getAndreaniCommercialSettings: enabled })
const oneReplacement = [{ original_order_item_id: 70, replacement_variant_id: 31, quantity: 1, claim_id: 50 }]

// ── Devolución ──────────────────────────────────────────────────────────────

test("devolución sin contrato: no se llama a Andreani, queda pendiente con el motivo; nunca usa contratos de venta", async () => {
  const { admin, rpcs, shipment } = fakeAdmin()
  const { calls, crear } = recordingCrear()
  const env = qaEnv({ ANDREANI_QA_RETURN_PICKUP_CONTRACT: "", ANDREANI_QA_RETURN_DROPOFF_CONTRACT: "" })
  await assert.rejects(createAndreaniReturnForClaim(admin, 50, deps(crear, env)),
    (error: unknown) => error instanceof AndreaniError && error.code === "CONFIGURATION_ERROR")
  assert.equal(calls.length, 0)
  assert.deepEqual(rpcs.map((call) => [call.name, call.args.p_outcome]), [["fail_order_claim_shipment_creation", "blocked"]])
  assert.match(String(shipment("devolucion").creation_error), /contrato de devoluciones/)
  assert.equal(shipment("devolucion").status, "pendiente")
  assert.throws(() => resolveAndreaniReturnConfig(env), /devoluciones/)
})

test("devolución: retiro en el domicilio de entrega, destino sucursal BEYONIX, sólo lo reclamado", async () => {
  const { admin, shipment } = fakeAdmin()
  const { calls, crear } = recordingCrear()
  const result = await createAndreaniReturnForClaim(admin, 50, deps(crear))
  assert.equal(result.status, "created")
  const envio = calls[0].input.envio
  assert.equal(envio.contrato, "CONTRATO-RETIRO")
  assert.deepEqual(envio.origen, {
    postal: { codigoPostal: "1043", calle: "Av. Corrientes", numero: "1234", piso: "3", departamento: "B", localidad: "CABA", pais: "Argentina" },
  })
  assert.deepEqual(envio.destino, { sucursal: { id: "20001" } }, "sucursal Andreani de BEYONIX, no una dirección fija")
  assert.equal(envio.remitente.nombreCompleto, "María Núñez")
  assert.equal(envio.destinatario[0].nombreCompleto, "BEYONIX")
  assert.equal(envio.idPedido, "7-R50")
  assert.equal(calls[0].input.items[0].producto.peso_empaquetado_kg, 2, "sólo la unidad reclamada")
  assert.deepEqual([shipment("devolucion").modality, shipment("devolucion").contract, shipment("devolucion").cost_amount],
    ["retiro_domicilio", "CONTRATO-RETIRO", null])
})

test("devolución por despacho: desde la sucursal que eligió el cliente, nunca una elegida por BEYONIX", () => {
  const config = resolveAndreaniReturnConfig(qaEnv({ ANDREANI_QA_RETURN_PICKUP_CONTRACT: "" }))
  const branchOrder = { ...homeOrder, shipping_type: "sucursal", andreani_sucursal_id: "4567", cliente_direccion: null, cp_destino: null }
  const choice = chooseClaimReturnModality(config, branchOrder as never)
  assert.deepEqual(choice, { modality: "despacho_sucursal", contract: "CONTRATO-DESPACHO" })
  assert.deepEqual(buildClaimReturnEnvio(branchOrder as never, 50, config, choice).origen, { sucursal: { id: "4567" } })
  assert.equal(chooseClaimReturnModality(resolveAndreaniReturnConfig(qaEnv()), branchOrder as never).modality, "despacho_sucursal")
  assert.throws(() => chooseClaimReturnModality(config, { ...branchOrder, andreani_sucursal_id: null } as never), /origen válido/)
})

test("doble click / reintento: una sola operación; lo creado se reutiliza", async () => {
  const { admin } = fakeAdmin()
  const { calls, crear } = recordingCrear()
  const results = await Promise.allSettled([createAndreaniReturnForClaim(admin, 50, deps(crear)), createAndreaniReturnForClaim(admin, 50, deps(crear))])
  assert.equal(calls.length, 1, "un solo POST a Andreani")
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1)
  assert.equal((await createAndreaniReturnForClaim(admin, 50, deps(crear))).status, "reused")
  assert.equal(calls.length, 1)
})

test("rechazo explícito -> reintentable; timeout -> revisión manual sin segundo POST", async () => {
  const rejected = fakeAdmin()
  const rejecting = recordingCrear({ ...created, estado: "Rechazado", motivo: "Contrato inválido" })
  await assert.rejects(createAndreaniReturnForClaim(rejected.admin, 50, deps(rejecting.crear)))
  assert.equal(rejected.shipment("devolucion").creation_status, "failed")
  assert.match(String(rejected.shipment("devolucion").creation_error), /Contrato inválido/)

  const lost = fakeAdmin()
  const timingOut = recordingCrear(new AndreaniError("TIMEOUT", "Andreani no respondió.", { retryable: true }))
  await assert.rejects(createAndreaniReturnForClaim(lost.admin, 50, deps(timingOut.crear)))
  assert.equal(lost.shipment("devolucion").creation_status, "manual_review")
  await assert.rejects(createAndreaniReturnForClaim(lost.admin, 50, deps(timingOut.crear)), /conciliación manual/)
  assert.equal(timingOut.calls.length, 1, "nunca un segundo POST con resultado incierto")
})

test("cambio no aceptado o proveedor desactivado: no se genera nada", async () => {
  const { admin } = fakeAdmin({ claimStatus: "en_revision" })
  const { calls, crear } = recordingCrear()
  await assert.rejects(createAndreaniReturnForClaim(admin, 50, deps(crear)), /cambio aceptado/)
  const disabled = fakeAdmin()
  await assert.rejects(
    createAndreaniReturnForClaim(disabled.admin, 50, { env: qaEnv(), crearOrdenEnvio: crear, getAndreaniCommercialSettings: async () => ({ enabled: false }) as never }),
    (error: unknown) => error instanceof AndreaniError && error.code === "PROVIDER_DISABLED",
  )
  assert.equal(calls.length, 0)
})

// ── Reemplazo ───────────────────────────────────────────────────────────────

test("reemplazo a domicilio: contrato de venta domicilio, origen BEYONIX, variante realmente enviada", async () => {
  const { admin, shipment } = fakeAdmin({ replacements: oneReplacement })
  const { calls, crear } = recordingCrear()
  const result = await createAndreaniReplacementShipmentForClaim(admin, 50, deps(crear))
  assert.equal(result.status, "created")
  const { envio, items } = calls[0].input
  assert.equal(envio.contrato, "400042104", "contrato de VENTA domicilio, nunca el de devoluciones")
  assert.deepEqual(envio.origen, { sucursal: { id: "20001" } }, "origen BEYONIX actual")
  assert.equal((envio.destino as { postal: { calle: string } }).postal.calle, "Av. Corrientes")
  assert.equal(envio.idPedido, "7-C50")
  assert.equal(items[0].producto.peso_empaquetado_kg, 3.5, "peso/dimensiones de la variante de reemplazo (Rojo XL)")
  assert.equal(items[0].bulto?.valorDeclaradoConImpuestos, 45000, "valor declarado del producto reclamado")
  assert.deepEqual([shipment("reemplazo").modality, shipment("reemplazo").contract, shipment("reemplazo").status],
    ["entrega_domicilio", "400042104", "generada"])
})

test("reemplazo a sucursal: contrato de venta sucursal y la sucursal que eligió el cliente", () => {
  const config = resolveAndreaniShipmentCreationConfig(qaEnv())
  assert.deepEqual(chooseReplacementShipment(config, { shipping_type: "sucursal" }), { modality: "entrega_sucursal", contract: "400042106" })
  assert.deepEqual(chooseReplacementShipment(config, { shipping_type: "domicilio" }), { modality: "entrega_domicilio", contract: "400042104" })
  assert.throws(() => chooseReplacementShipment(config, { shipping_type: "retiro_local" }), /domicilio o sucursal/)
})

test("reemplazo sin todas las unidades registradas: no se llama a Andreani ni se toca stock", async () => {
  const { admin, rpcs, shipment } = fakeAdmin({ replacements: [] })
  const { calls, crear } = recordingCrear()
  await assert.rejects(createAndreaniReplacementShipmentForClaim(admin, 50, deps(crear)), /todas las unidades reclamadas/)
  assert.equal(calls.length, 0)
  assert.ok(rpcs.every((call) => !/replacement|stock/i.test(call.name)), "nunca llama a create_order_replacement ni mueve stock")
  assert.match(String(shipment("reemplazo").creation_error), /todas las unidades/)
})

test("PROD permitido con las barreras explícitas; sin autorización, bloqueado antes del candado", async () => {
  const allowed = fakeAdmin({ replacements: oneReplacement })
  const { calls, crear } = recordingCrear()
  await createAndreaniReplacementShipmentForClaim(allowed.admin, 50, deps(crear, prodEnv()))
  assert.equal(calls[0].input.envio.contrato, "400042104")
  assert.deepEqual(calls[0].input.envio.origen, { sucursal: { id: "10179" } })
  assert.equal((calls[0].options as { productionAccess?: string }).productionAccess, "shipment-creation")
  assert.equal(allowed.shipment("reemplazo").environment, "PROD")

  const blocked = fakeAdmin({ replacements: oneReplacement })
  const noCall = recordingCrear()
  await assert.rejects(
    createAndreaniReplacementShipmentForClaim(blocked.admin, 50, deps(noCall.crear, prodEnv({ ANDREANI_ALLOW_PROD_SHIPMENT_CREATION: "false" }))),
    (error: unknown) => error instanceof AndreaniError && error.code === "PRODUCTION_BLOCKED",
  )
  // Tests: NODE_ENV=test nunca habilita PROD aunque la autorización esté activa.
  await assert.rejects(
    createAndreaniReplacementShipmentForClaim(blocked.admin, 50, deps(noCall.crear, prodEnv({ NODE_ENV: "test" }))),
    (error: unknown) => error instanceof AndreaniError && error.code === "PRODUCTION_BLOCKED",
  )
  assert.equal(noCall.calls.length, 0)
  assert.ok(!blocked.rpcs.some((call) => call.name === "claim_order_claim_shipment_creation"))
})

// ── Etiqueta y conciliación ─────────────────────────────────────────────────

test("etiqueta: sólo de una orden creada y en el ambiente donde se creó (PROD = sólo lectura)", async () => {
  const seen: Array<{ id: string; options: Row }> = []
  const getEtiquetas = (async (id: string, _format: string, options: Row) => {
    seen.push({ id, options })
    return { contentType: "application/pdf", data: new ArrayBuffer(4) }
  }) as never
  const label = await getClaimShipmentLabel({ andreani_envio_id: "360000012345678", environment: "PROD", creation_status: "created" }, { getEtiquetas })
  assert.equal(label.contentType, "application/pdf")
  assert.equal(seen[0].id, "360000012345678")
  assert.equal((seen[0].options as { productionAccess?: string }).productionAccess, "shipment-read")
  assert.equal(((seen[0].options as { env: Row }).env).ANDREANI_ENV, "PROD")
  await assert.rejects(
    getClaimShipmentLabel({ andreani_envio_id: null, environment: null, creation_status: "not_started" }, { getEtiquetas }),
    /Todavía no hay una orden/,
  )
  assert.equal(seen.length, 1)
})

test("conciliación: 'existe' se verifica contra Andreani antes de vincular; 'no existe' libera sin consultar", async () => {
  const { admin, shipment } = fakeAdmin({ returnCreation: "manual_review" })
  Object.assign(shipment("devolucion"), { environment: "PROD", modality: "retiro_domicilio", contract: "R" })
  const lookups: string[] = []
  const getEstadoOrden = (async (id: string) => {
    lookups.push(id)
    return id === "RECHAZADA" ? { ...created, estado: "Rechazado", creada: false } : { ...created, creada: true }
  }) as never
  await assert.rejects(
    reconcileClaimShipment(admin, { claimId: 50, direction: "devolucion", actorId: "a", resolution: "created", envioId: "RECHAZADA", notes: "Revisado en Andreani" }, { getEstadoOrden }),
    /rechazada/,
  )
  const linked = await reconcileClaimShipment(admin, { claimId: 50, direction: "devolucion", actorId: "a", resolution: "created", envioId: "360000099", notes: "Revisado en Andreani" }, { getEstadoOrden })
  assert.deepEqual([linked.creation_status, linked.andreani_envio_id, linked.andreani_tracking], ["created", "360000099", "360000012345678"])

  const other = fakeAdmin({ returnCreation: "manual_review" })
  const noLookup = (async () => { throw new Error("no debería consultar") }) as never
  const released = await reconcileClaimShipment(other.admin, { claimId: 50, direction: "devolucion", actorId: "a", resolution: "not_created", notes: "No figura en Andreani" }, { getEstadoOrden: noLookup })
  assert.equal(released.creation_status, "failed")
  assert.deepEqual(lookups, ["RECHAZADA", "360000099"])
})

// ── Tracking ────────────────────────────────────────────────────────────────

test("fase desde eventos estables de Andreani", () => {
  const at = (Evento: string, Fecha: string) => ({ Evento, Fecha }) as never
  assert.equal(resolveClaimShipmentPhase([], false), "sin_cambio")
  assert.equal(resolveClaimShipmentPhase([at("OrdenDeEnvioCreada", "2026-09-28T10:00:00-03:00")], false), "sin_cambio")
  assert.equal(resolveClaimShipmentPhase([at("Distribucion", "2026-09-28T10:00:00-03:00")], false), "en_transito")
  assert.equal(resolveClaimShipmentPhase([at("Distribucion", "2026-09-28T10:00:00-03:00"), at("EnvioNoEntregado", "2026-09-28T11:00:00-03:00")], false), "incidencia")
  assert.equal(resolveClaimShipmentPhase([at("EnvioNoEntregado", "2026-09-28T09:00:00-03:00"), at("EnvioDespachado", "2026-09-28T12:00:00-03:00")], false), "en_transito")
  assert.equal(resolveClaimShipmentPhase([at("EnvioEntregado", "2026-09-28T12:00:00-03:00")], false), "entregada")
  assert.equal(resolveClaimShipmentPhase([at("Distribucion", "2026-09-28T10:00:00-03:00")], true), "incidencia")
})

test("tracking ida y vuelta: ambiente de creación, entrega una vez, el batch sólo sigue abiertos", async () => {
  const { admin, shipment, rpcs, tables } = fakeAdmin({ returnCreation: "created" })
  Object.assign(shipment("devolucion"), { status: "generada", andreani_envio_id: "R-1", andreani_tracking: "R-1", environment: "PROD" })
  tables.order_claim_shipments.push({ ...shipment("devolucion"), id: 2, direction: "reemplazo", andreani_envio_id: "C-1", andreani_tracking: "C-1" })
  const seen: Row[] = []
  const fetchSnapshot = (async (order: Row) => {
    seen.push(order)
    const delivered = order.andreani_envio_id === "C-1"
    const eventos = [{ Evento: delivered ? "EnvioEntregado" : "Distribucion", Fecha: "2026-09-28T12:00:00-03:00" }]
    return { logisticsEstado: "x", resolvedTracking: String(order.andreani_envio_id), etiquetaUrl: null, rejectedAfterCreation: false, eventos, latestEvent: eventos[0] }
  }) as never
  const batch = await runClaimShipmentTrackingBatch(admin, { fetchSnapshot })
  assert.deepEqual(batch, { checked: 2, updated: 2, delivered: 1, failed: 0 })
  assert.deepEqual(seen.map((row) => row.andreani_creation_environment), ["PROD", "PROD"])
  assert.equal(shipment("devolucion").status, "en_transito")
  assert.equal(shipment("reemplazo").status, "entregada")
  const again = await runClaimShipmentTrackingBatch(admin, { fetchSnapshot })
  assert.equal(again.checked, 1, "el reemplazo entregado no se vuelve a consultar")
  assert.equal(rpcs.filter((call) => call.name === "apply_order_claim_shipment_tracking" && call.args.p_direction === "reemplazo").length, 1)
  await assert.rejects(
    syncClaimShipmentTracking(admin, { ...shipment("devolucion"), creation_status: "not_started", andreani_envio_id: null } as never, { fetchSnapshot }),
    /todavía no tiene una orden/,
  )
})
