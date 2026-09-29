import assert from "node:assert/strict"
import test from "node:test"

import { AndreaniError } from "./client.ts"
import {
  chooseClaimShipmentModality,
  claimShipmentReference,
  createClaimShipment,
  getClaimShipmentLabel,
  isUncertainClaimCreationFailure,
  reconcileClaimShipment,
  resolveAndreaniClaimContracts,
  resolveClaimBranch,
  resolveClaimShipmentTracking,
  resolveDefaultClaimBranch,
  searchClaimBranches,
  runClaimShipmentTrackingBatch,
  syncClaimShipmentTracking,
} from "./claim-shipments.ts"
import type { AndreaniCreateShipmentInput, AndreaniCreateShipmentResponse } from "./types.ts"

// Operaciones Andreani de un reclamo (sin red): Andreani falso y un cliente
// admin en memoria con la MISMA semántica que las RPCs de 20260928100000
// (probadas contra PGlite en lib/orders/claim-andreani-shipments-sql.test.ts).

// Venta (sin cambios) + postventa SÓLO sucursal.
const CONTRACTS = {
  HOME_CONTRACT: "400042104",
  BRANCH_CONTRACT: "400042106",
  EXCHANGE_BRANCH_CONTRACT: "400042110",
  RETURN_DROPOFF_CONTRACT: "400042114",
}

function qaEnv(overrides: Partial<NodeJS.ProcessEnv> = {}): NodeJS.ProcessEnv {
  return {
    ANDREANI_ENV: "QA",
    ANDREANI_TARIFF_ENV: "QA",
    ANDREANI_SHIPMENT_ENV: "QA",
    ANDREANI_QA_API_URL: "https://apisqa.andreani.com",
    ANDREANI_QA_USERNAME: "usuario-prueba",
    ANDREANI_QA_PASSWORD: "clave-prueba",
    ANDREANI_QA_CLIENT: "CLIENTE-QA",
    ...Object.fromEntries(Object.entries(CONTRACTS).map(([key, value]) => [`ANDREANI_QA_${key}`, value])),
    ANDREANI_QA_ORIGIN_BRANCH: "RAC",
    ANDREANI_QA_ORIGIN_BRANCH_ID: "20001",
    ANDREANI_REMITENTE_NOMBRE: "BEYONIX",
    ANDREANI_REMITENTE_EMAIL: "logistica@beyonix.test",
    ANDREANI_REMITENTE_TELEFONO: "1144445555",
    NODE_ENV: "test",
    ...overrides,
  }
}

/** PROD (Andreani indicó usarlo para pruebas) con las barreras explícitas vigentes. */
function prodEnv(overrides: Partial<NodeJS.ProcessEnv> = {}): NodeJS.ProcessEnv {
  return {
    ...qaEnv(),
    ANDREANI_SHIPMENT_ENV: "PROD",
    ANDREANI_PROD_API_URL: "https://apis.andreani.com",
    ANDREANI_PROD_USERNAME: "u",
    ANDREANI_PROD_PASSWORD: "p",
    ANDREANI_PROD_CLIENT: "0012011683",
    ...Object.fromEntries(Object.entries(CONTRACTS).map(([key, value]) => [`ANDREANI_PROD_${key}`, value])),
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
const branchOrder = { ...homeOrder, shipping_type: "sucursal", andreani_sucursal_id: "4567" }

type Row = Record<string, unknown>

function legRow(direction: string, overrides: Row = {}): Row {
  return {
    id: 1, claim_id: 50, order_id: 7, direction, attempt: 1, status: "pendiente", exchange_outcome: null, modality: null,
    branch_id: "4567", branch_name: "Sucursal Once", branch_address: null,
    environment: null, contract: null, andreani_envio_id: null, andreani_tracking: null, andreani_estado: null,
    andreani_last_event: null, andreani_last_event_at: null, incident_open: false, incident_event: null,
    branch_custody_since: null, cost_amount: null, creation_status: "not_started", creation_token: null,
    creation_error: null, creation_started_at: null, delivered_at: null, closed_at: null, last_checked_at: null,
    ...overrides,
  }
}

function fakeAdmin({ order = homeOrder as Row, direction = "cambio", leg = {} as Row, claimStatus = "aprobado" } = {}) {
  const tables: Record<string, Row[]> = {
    order_claims: [{ id: 50, order_id: 7, status: claimStatus, resolution: "cambio_producto" }],
    order_claim_shipments: [legRow(direction, leg)],
    ordenes: [order],
    orden_items: [
      { id: 70, orden_id: 7, producto_id: 3, variante_id: 30, conditioned_stock_id: null, cantidad: 3, precio: 45000 },
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
    // 2 de 3 unidades del ítem 70 reclamadas, con su reemplazo reservado (variante 31).
    order_claim_units: [
      { id: 1, claim_id: 50, order_item_id: 70, role: "original", location: "con_cliente", shipment_id: null, replacement_id: null },
      { id: 2, claim_id: 50, order_item_id: 70, role: "original", location: "con_cliente", shipment_id: null, replacement_id: null },
      { id: 3, claim_id: 50, order_item_id: 70, role: "reemplazo", location: "reservada", shipment_id: null, replacement_id: 900 },
      { id: 4, claim_id: 50, order_item_id: 70, role: "reemplazo", location: "reservada", shipment_id: null, replacement_id: 900 },
    ],
    order_replacements: [{ id: 900, original_order_item_id: 70, replacement_variant_id: 31 }],
  }
  const rpcs: Array<{ name: string; args: Row }> = []
  const query = (table: string) => {
    const filters: Array<(row: Row) => boolean> = []
    let limit = Infinity
    // Copias, como Supabase: mutar la base no cambia lo ya leído.
    const rows = () => (tables[table] ?? []).filter((row) => filters.every((filter) => filter(row))).slice(0, limit).map((row) => ({ ...row }))
    const builder = {
      select: () => builder,
      eq: (key: string, value: unknown) => { filters.push((row) => row[key] === value); return builder },
      neq: (key: string, value: unknown) => { filters.push((row) => row[key] !== value); return builder },
      is: (key: string, value: unknown) => { filters.push((row) => (row[key] ?? null) === value); return builder },
      in: (key: string, values: unknown[]) => { filters.push((row) => values.includes(row[key])); return builder },
      order: () => builder,
      limit: (n: number) => { limit = n; return builder },
      maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      then: (resolve: (value: { data: Row[]; error: null }) => unknown) => resolve({ data: rows(), error: null }),
    }
    return builder
  }
  const legOf = (id: unknown) => tables.order_claim_shipments.find((row) => row.id === id)
  const rpc = async (name: string, args: Row) => {
    rpcs.push({ name, args })
    const row = legOf(args.p_shipment_id)
    if (!row) return { data: null, error: { message: "CLAIM_SHIPMENT_NOT_FOUND" } }
    if (name === "claim_order_claim_shipment_creation") {
      if (row.creation_status === "created") return { data: { ...row }, error: null }
      if (row.creation_status === "processing" || row.creation_status === "manual_review") return { data: null, error: null }
      Object.assign(row, { creation_status: "processing", creation_token: args.p_token, environment: args.p_environment,
        modality: args.p_modality, contract: args.p_contract, creation_error: null })
      const role = row.direction === "devolucion" ? "original" : "reemplazo"
      for (const unit of tables.order_claim_units) if (unit.role === role && !unit.shipment_id) unit.shipment_id = row.id
      return { data: { ...row }, error: null }
    }
    if (name === "complete_order_claim_shipment_creation") {
      if (row.creation_token !== args.p_token) return { data: null, error: { message: "CLAIM_SHIPMENT_NOT_CLAIMED" } }
      Object.assign(row, { creation_status: "created", status: "generada", creation_token: null, andreani_envio_id: args.p_envio_id,
        andreani_tracking: args.p_tracking, andreani_estado: args.p_estado, cost_amount: args.p_cost_amount })
      return { data: { ...row }, error: null }
    }
    if (name === "fail_order_claim_shipment_creation") {
      if (args.p_outcome === "blocked") Object.assign(row, { creation_error: args.p_error })
      else if (row.creation_token === args.p_token) {
        Object.assign(row, { creation_status: args.p_outcome, creation_token: null, creation_error: args.p_error })
        if (args.p_outcome === "failed") for (const unit of tables.order_claim_units) if (unit.shipment_id === row.id) unit.shipment_id = null
      }
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
      const rank = ["pendiente", "generada", "en_transito", "en_sucursal", "entregada"]
      if (args.p_phase !== "sin_cambio" && rank.indexOf(String(args.p_phase)) > rank.indexOf(String(row.status))) row.status = args.p_phase
      if (row.status === "entregada") Object.assign(row, { delivered_at: row.delivered_at ?? "ahora", closed_at: row.closed_at ?? "ahora" })
      Object.assign(row, { andreani_estado: args.p_estado, incident_open: args.p_incident, last_checked_at: "ahora" })
      if (args.p_review_event) Object.assign(row, { review_required: true, review_event: args.p_review_event })
      return { data: { ...row }, error: null }
    }
    if (name === "flag_order_claim_shipment_review") {
      Object.assign(row, { review_required: true, review_event: args.p_event })
      return { data: { ...row }, error: null }
    }
    throw new Error(`rpc inesperada ${name}`)
  }
  return { admin: { from: query, rpc } as never, rpcs, tables, leg: () => tables.order_claim_shipments[0] }
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

// ── Contratos y modalidad ───────────────────────────────────────────────────

test("postventa SÓLO sucursal: CAMBIO 400042110, RETIRO 400042114, reenvío VENTA sucursal 400042106; nunca domicilio ni fallback", () => {
  const contracts = resolveAndreaniClaimContracts(prodEnv())
  assert.deepEqual(chooseClaimShipmentModality("cambio", contracts), { modality: "cambio_sucursal", contract: "400042110" })
  assert.deepEqual(chooseClaimShipmentModality("devolucion", contracts), { modality: "despacho_sucursal", contract: "400042114" })
  assert.deepEqual(chooseClaimShipmentModality("reemplazo", contracts), { modality: "entrega_sucursal", contract: "400042106" })
  // Aunque existan variables de domicilio, la postventa nunca las lee.
  const withHome = resolveAndreaniClaimContracts(prodEnv({ ANDREANI_PROD_EXCHANGE_HOME_CONTRACT: "400042108", ANDREANI_PROD_RETURN_PICKUP_CONTRACT: "400042112" }))
  assert.doesNotMatch(JSON.stringify(Object.values(withHome).slice(1)), /400042108|400042112/)
  for (const [key, direction, name] of [
    ["ANDREANI_PROD_EXCHANGE_BRANCH_CONTRACT", "cambio", /CAMBIO sucursal/],
    ["ANDREANI_PROD_RETURN_DROPOFF_CONTRACT", "devolucion", /RETIRO sucursal/],
    ["ANDREANI_PROD_BRANCH_CONTRACT", "reemplazo", /VENTA sucursal/],
  ] as const) {
    assert.throws(() => chooseClaimShipmentModality(direction, resolveAndreaniClaimContracts(prodEnv({ [key]: "" }))),
      (error: unknown) => error instanceof AndreaniError && error.code === "CONFIGURATION_ERROR" && name.test(error.message))
  }
  // Nunca mezcla ambientes: QA lee sólo variables QA.
  assert.equal(resolveAndreaniClaimContracts(qaEnv({ ANDREANI_QA_EXCHANGE_BRANCH_CONTRACT: "QA-1" })).exchangeBranchContract, "QA-1")
  assert.equal(claimShipmentReference(7, 50, "cambio", 1), "7-C50")
  assert.equal(claimShipmentReference(7, 50, "devolucion", 2), "7-R50-2")
})

// ── Creación ────────────────────────────────────────────────────────────────

test("CAMBIO de una compra a DOMICILIO: igual va a la sucursal del tramo con CAMBIO sucursal; bulto = reemplazo reservado", async () => {
  const { admin, leg, tables } = fakeAdmin()
  const { calls, crear } = recordingCrear()
  const result = await createClaimShipment(admin, 1, deps(crear, prodEnv()))
  assert.equal(result.status, "created")
  const { envio, items } = calls[0].input
  assert.equal(envio.contrato, "400042110")
  assert.deepEqual(envio.origen, { sucursal: { id: "10179" } }, "origen BEYONIX (configuración autoritativa)")
  assert.deepEqual(envio.destino, { sucursal: { id: "4567" } }, "nunca el domicilio del cliente")
  assert.equal(envio.destinatario[0].nombreCompleto, "María Núñez")
  assert.equal(envio.idPedido, "7-C50")
  assert.equal(items[0].producto.peso_empaquetado_kg, 7, "2 unidades de la variante de reemplazo (3,5 kg c/u)")
  assert.equal((calls[0].options as { productionAccess?: string }).productionAccess, "shipment-creation")
  assert.deepEqual([leg().modality, leg().contract, leg().status, leg().environment], ["cambio_sucursal", "400042110", "generada", "PROD"])
  assert.equal(tables.order_claim_units.filter((unit) => unit.shipment_id === 1 && unit.role === "reemplazo").length, 2)
})

test("RETIRO: el cliente despacha en la sucursal del tramo hacia la sucursal de BEYONIX; bulto = originales", async () => {
  const { admin, leg } = fakeAdmin({ direction: "devolucion", leg: { attempt: 2 } })
  const { calls, crear } = recordingCrear()
  await createClaimShipment(admin, 1, deps(crear))
  const envio = calls[0].input.envio
  assert.equal(envio.contrato, "400042114")
  assert.deepEqual(envio.origen, { sucursal: { id: "4567" } }, "compra a domicilio: igual por sucursal, nunca retiro en domicilio")
  assert.deepEqual(envio.destino, { sucursal: { id: "20001" } })
  assert.equal(envio.remitente.nombreCompleto, "María Núñez")
  assert.equal(envio.destinatario[0].nombreCompleto, "BEYONIX")
  assert.equal(envio.idPedido, "7-R50-2", "cada intento con su propia referencia")
  assert.equal(calls[0].input.items[0].producto.peso_empaquetado_kg, 4, "2 unidades originales")
  assert.equal(leg().modality, "despacho_sucursal")
})

test("REENVÍO del reemplazo: VENTA sucursal a la sucursal del tramo, nunca a domicilio", async () => {
  const { admin, leg } = fakeAdmin({ direction: "reemplazo" })
  const { calls, crear } = recordingCrear()
  await createClaimShipment(admin, 1, deps(crear))
  const envio = calls[0].input.envio
  assert.equal(envio.contrato, "400042106")
  assert.deepEqual(envio.destino, { sucursal: { id: "4567" } })
  assert.equal(envio.idPedido, "7-E50")
  assert.equal(leg().modality, "entrega_sucursal")
})

const catalogBranch = (id: number, descripcion: string, localidad: string, calle = "Av. Siempre Viva", numero = "100") => ({
  id, codigo: `S${id}`, numero: String(id), descripcion, canal: "B2C",
  direccion: { calle, numero, localidad, provincia: "Buenos Aires", region: "AMBA", pais: "Argentina", codigoPostal: "1832" },
  codigosPostalesAtendidos: ["1832"],
})
const CATALOG = [
  catalogBranch(4567, "Sucursal Lomas de Zamora", "Lomas de Zamora", "Av. Meeks", "150"),
  catalogBranch(5555, "Sucursal Banfield", "Banfield"),
  catalogBranch(10179, "Sucursal Centro", "C.a.b.a.", "Av. Corrientes", "1234"),
]

test("sucursales del catálogo real: búsqueda por localidad/dirección, validación server-side, Andreani caído = error claro", async () => {
  const environments: string[] = []
  const loadCatalog = (async (environment: string) => { environments.push(environment); return CATALOG }) as never
  const env = prodEnv()
  const found = await searchClaimBranches("lomas meeks", { env, loadCatalog })
  assert.deepEqual(found.map((branch) => branch.id), ["4567"], "sin tildes/mayúsculas, todos los términos")
  assert.deepEqual(found[0], { id: "4567", name: "Sucursal Lomas de Zamora", address: "Av. Meeks 150", locality: "Lomas de Zamora", province: "Buenos Aires", postalCode: "1832" })
  assert.equal((await searchClaimBranches("1832", { env, loadCatalog })).length, 3, "por código postal")
  assert.deepEqual(environments, ["PROD", "PROD"], "catálogo del ambiente donde se crean las operaciones")
  await assert.rejects(searchClaimBranches("lo", { env, loadCatalog }), /al menos 3 letras/)
  // Validación: sólo ids que existen hoy en el catálogo; datos del catálogo, nunca del navegador.
  assert.equal((await resolveClaimBranch("10179", { env, loadCatalog })).name, "Sucursal Centro")
  await assert.rejects(resolveClaimBranch("9999", { env, loadCatalog }), /ya no figura como disponible/)
  await assert.rejects(resolveClaimBranch("Av. Corrientes 1234", { env, loadCatalog }), /Elegí una sucursal Andreani del buscador/)
  const down = (async () => { throw new AndreaniError("SERVICE_UNAVAILABLE", "detalle interno 503") }) as never
  const errors = console.error
  console.error = () => {}
  try {
    await assert.rejects(resolveClaimBranch("4567", { env, loadCatalog: down }),
      (error: unknown) => error instanceof AndreaniError && error.code === "SERVICE_UNAVAILABLE" &&
        /sin una sucursal válida no se puede generar la logística/.test(error.message) && !/detalle interno/.test(error.message))
  } finally {
    console.error = errors
  }
})

test("sucursal sugerida: la del tramo anterior o la de BEYONIX (10179 en PROD), siempre revalidada contra Andreani", async () => {
  const loadCatalog = (async () => CATALOG) as never
  // Sin tramo previo: la sucursal de BEYONIX configurada, con los datos ACTUALES del catálogo.
  const first = fakeAdmin({ order: branchOrder as Row, leg: { status: "cancelada", branch_id: null } })
  const suggested = await resolveDefaultClaimBranch(first.admin, 50, "cambio", { env: prodEnv(), loadCatalog })
  assert.deepEqual([suggested?.id, suggested?.name, suggested?.address], ["10179", "Sucursal Centro", "Av. Corrientes 1234"],
    "10179 validada: nombre/dirección del catálogo, no de la compra ni del navegador")
  // 10179 dada de baja en Andreani: no se usa y el Admin elige otra.
  const withoutBeyonix = (async () => CATALOG.filter((branch) => branch.id !== 10179)) as never
  assert.equal(await resolveDefaultClaimBranch(first.admin, 50, "cambio", { env: prodEnv(), loadCatalog: withoutBeyonix }), null)
  // Sin sucursal de BEYONIX configurada (p. ej. QA incompleto): nada precargado.
  assert.equal(await resolveDefaultClaimBranch(first.admin, 50, "cambio", { env: qaEnv({ ANDREANI_QA_ORIGIN_BRANCH_ID: "" }), loadCatalog }), null)
  // Reenvío / reintento: la sucursal del tramo anterior del reclamo.
  const resend = fakeAdmin({ direction: "devolucion", leg: { status: "entregada", branch_id: "5555" } })
  assert.equal((await resolveDefaultClaimBranch(resend.admin, 50, "reemplazo", { env: prodEnv(), loadCatalog }))?.id, "5555", "reenvío: la sucursal del retiro")
  // Tramo anterior en una sucursal que ya no existe: se descarta y se sugiere la de BEYONIX.
  const gone = fakeAdmin({ direction: "devolucion", leg: { status: "entregada", branch_id: "8888" } })
  assert.equal((await resolveDefaultClaimBranch(gone.admin, 50, "reemplazo", { env: prodEnv(), loadCatalog }))?.id, "10179")
  // Andreani caído: error claro (no una sugerida inventada).
  const down = (async () => { throw new AndreaniError("SERVICE_UNAVAILABLE", "detalle interno") }) as never
  const errors = console.error
  console.error = () => {}
  try {
    await assert.rejects(resolveDefaultClaimBranch(first.admin, 50, "cambio", { env: prodEnv(), loadCatalog: down }), /sin una sucursal válida/)
  } finally {
    console.error = errors
  }
})

test("tracking: eventos no clasificables piden revisión (sin inventar estado); respuesta fuera del maestro se registra", async () => {
  const at = (Evento: string, Fecha: string) => ({ Evento, Fecha }) as never
  const annulled = resolveClaimShipmentTracking([at("Distribucion", "2026-09-28T10:00:00-03:00"), at("EnvioAnulado", "2026-09-28T11:00:00-03:00")], false)
  assert.deepEqual([annulled.phase, annulled.reviewEvent], ["en_transito", "EnvioAnulado"])
  assert.equal(resolveClaimShipmentTracking([at("Distribucion", "2026-09-28T10:00:00-03:00")], false).reviewEvent, null)
  assert.equal(resolveClaimShipmentTracking([], true).reviewEvent, "OrdenDeEnvioRechazada")
  const { admin, leg } = fakeAdmin({ leg: { creation_status: "created", status: "generada", andreani_envio_id: "R-1", environment: "PROD" } })
  const unreadable = (async () => { throw new AndreaniError("INVALID_RESPONSE", "Andreani devolvió un evento fuera del maestro documentado.") }) as never
  await assert.rejects(syncClaimShipmentTracking(admin, leg() as never, { fetchSnapshot: unreadable }))
  assert.deepEqual([leg().review_required, leg().status], [true, "generada"], "guardado y en revisión; sin avanzar")
  assert.match(String(leg().review_event), /fuera del maestro/)
})

test("doble click / reintento: una sola orden; lo creado se reutiliza", async () => {
  const { admin } = fakeAdmin()
  const { calls, crear } = recordingCrear()
  const results = await Promise.allSettled([createClaimShipment(admin, 1, deps(crear)), createClaimShipment(admin, 1, deps(crear))])
  assert.equal(calls.length, 1, "un solo POST a Andreani")
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1)
  assert.equal((await createClaimShipment(admin, 1, deps(crear))).status, "reused")
  assert.equal(calls.length, 1)
})

test("timeout / 409 / 5xx: resultado incierto -> revisión manual, sin segundo POST; rechazo explícito -> reintentable", async () => {
  for (const error of [
    new AndreaniError("TIMEOUT", "Andreani no respondió.", { retryable: true }),
    new AndreaniError("REQUEST_FAILED", "Conflicto", { status: 409 }),
    new AndreaniError("SERVICE_UNAVAILABLE", "Caída", { status: 503 }),
    new AndreaniError("INVALID_RESPONSE", "Cuerpo inválido"),
  ]) {
    const lost = fakeAdmin()
    const failing = recordingCrear(error)
    await assert.rejects(createClaimShipment(lost.admin, 1, deps(failing.crear)))
    assert.equal(lost.leg().creation_status, "manual_review", error.message)
    await assert.rejects(createClaimShipment(lost.admin, 1, deps(failing.crear)), /conciliación manual/)
    assert.equal(failing.calls.length, 1, "nunca un segundo POST con resultado incierto")
  }
  const rejected = fakeAdmin()
  const rejecting = recordingCrear({ ...created, estado: "Rechazado", motivo: "Contrato inválido" })
  await assert.rejects(createClaimShipment(rejected.admin, 1, deps(rejecting.crear)))
  assert.equal(rejected.leg().creation_status, "failed")
  assert.match(String(rejected.leg().creation_error), /Contrato inválido/)
  assert.equal(rejected.tables.order_claim_units.filter((unit) => unit.shipment_id).length, 0, "no creada: unidades liberadas")
  assert.equal(isUncertainClaimCreationFailure(new AndreaniError("REQUEST_FAILED", "Datos", { status: 400 })), false)
  assert.equal(isUncertainClaimCreationFailure(new AndreaniError("REQUEST_FAILED", "Timeout", { status: 408 })), true)
  assert.equal(isUncertainClaimCreationFailure(new Error("desconocido")), true)
})

test("bloqueos antes del candado: sin contrato o proveedor desactivado no se llama a Andreani; queda el motivo", async () => {
  const { admin, rpcs, leg } = fakeAdmin()
  const { calls, crear } = recordingCrear()
  await assert.rejects(createClaimShipment(admin, 1, deps(crear, qaEnv({ ANDREANI_QA_EXCHANGE_BRANCH_CONTRACT: "" }))),
    (error: unknown) => error instanceof AndreaniError && error.code === "CONFIGURATION_ERROR")
  assert.deepEqual(rpcs.map((call) => [call.name, call.args.p_outcome]), [["fail_order_claim_shipment_creation", "blocked"]])
  assert.match(String(leg().creation_error), /CAMBIO sucursal/)
  assert.equal(leg().status, "pendiente")
  const disabled = fakeAdmin()
  await assert.rejects(
    createClaimShipment(disabled.admin, 1, { env: qaEnv(), crearOrdenEnvio: crear, getAndreaniCommercialSettings: async () => ({ enabled: false }) as never }),
    (error: unknown) => error instanceof AndreaniError && error.code === "PROVIDER_DISABLED",
  )
  assert.equal(calls.length, 0)
})

test("PROD sin autorización explícita: bloqueado antes del candado (también en tests)", async () => {
  const blocked = fakeAdmin()
  const noCall = recordingCrear()
  for (const env of [prodEnv({ ANDREANI_ALLOW_PROD_SHIPMENT_CREATION: "false" }), prodEnv({ NODE_ENV: "test" })]) {
    await assert.rejects(createClaimShipment(blocked.admin, 1, deps(noCall.crear, env)),
      (error: unknown) => error instanceof AndreaniError && error.code === "PRODUCTION_BLOCKED")
  }
  assert.equal(noCall.calls.length, 0)
  assert.ok(!blocked.rpcs.some((call) => call.name === "claim_order_claim_shipment_creation"))
})

test("tramo cerrado o sin reclamo: no se genera nada", async () => {
  const { admin } = fakeAdmin({ leg: { closed_at: "ayer", status: "cancelada" } })
  const { calls, crear } = recordingCrear()
  await assert.rejects(createClaimShipment(admin, 1, deps(crear)), /cerrada/)
  await assert.rejects(createClaimShipment(admin, 99, deps(crear)), /no tiene esa operación/)
  assert.equal(calls.length, 0)
})

// ── Conciliación, etiqueta ──────────────────────────────────────────────────

test("conciliación: 'existe' se verifica contra Andreani antes de vincular; 'no existe' libera sin consultar", async () => {
  const { admin, leg } = fakeAdmin({ leg: { creation_status: "manual_review", environment: "PROD", modality: "cambio_domicilio", contract: "C" } })
  const lookups: string[] = []
  const getEstadoOrden = (async (id: string) => {
    lookups.push(id)
    return id === "RECHAZADA" ? { ...created, estado: "Rechazado", creada: false } : { ...created, creada: true }
  }) as never
  await assert.rejects(
    reconcileClaimShipment(admin, { shipmentId: 1, actorId: "a", resolution: "created", envioId: "RECHAZADA", notes: "Revisado en Andreani" }, { getEstadoOrden }),
    /rechazada/,
  )
  const linked = await reconcileClaimShipment(admin, { shipmentId: 1, actorId: "a", resolution: "created", envioId: "360000099", notes: "Revisado en Andreani" }, { getEstadoOrden })
  assert.deepEqual([linked.creation_status, linked.andreani_envio_id, linked.andreani_tracking], ["created", "360000099", "360000012345678"])
  assert.equal(leg().creation_status, "created")

  const other = fakeAdmin({ leg: { creation_status: "manual_review" } })
  const noLookup = (async () => { throw new Error("no debería consultar") }) as never
  const released = await reconcileClaimShipment(other.admin, { shipmentId: 1, actorId: "a", resolution: "not_created", notes: "No figura en Andreani" }, { getEstadoOrden: noLookup })
  assert.equal(released.creation_status, "failed")
  assert.deepEqual(lookups, ["RECHAZADA", "360000099"])
})

test("etiqueta: sólo de una orden creada y vigente, en el ambiente donde se creó (PROD = sólo lectura)", async () => {
  const seen: Array<{ id: string; options: Row }> = []
  const getEtiquetas = (async (id: string, _format: string, options: Row) => {
    seen.push({ id, options })
    return { contentType: "application/pdf", data: new ArrayBuffer(4) }
  }) as never
  const label = await getClaimShipmentLabel({ andreani_envio_id: "360000012345678", environment: "PROD", creation_status: "created", status: "generada" }, { getEtiquetas })
  assert.equal(label.contentType, "application/pdf")
  assert.equal((seen[0].options as { productionAccess?: string }).productionAccess, "shipment-read")
  assert.equal(((seen[0].options as { env: Row }).env).ANDREANI_ENV, "PROD")
  for (const shipment of [
    { andreani_envio_id: null, environment: null, creation_status: "not_started", status: "pendiente" },
    { andreani_envio_id: "36", environment: "PROD", creation_status: "created", status: "cancelada" },
  ]) {
    await assert.rejects(getClaimShipmentLabel(shipment as never, { getEtiquetas }), /Todavía no hay una orden/)
  }
  assert.equal(seen.length, 1)
})

// ── Tracking ────────────────────────────────────────────────────────────────

test("tracking: máximo avance (repetidos/desordenados no retroceden), custodia informada, novedad sólo si es lo último", () => {
  const at = (Evento: string, Fecha: string) => ({ Evento, Fecha }) as never
  assert.deepEqual(resolveClaimShipmentTracking([], false), { phase: "sin_cambio", incident: false, custodySince: null, reviewEvent: null })
  assert.equal(resolveClaimShipmentTracking([at("OrdenDeEnvioCreada", "2026-09-28T10:00:00-03:00")], false).phase, "sin_cambio")
  const custody = resolveClaimShipmentTracking([
    at("ComienzoCustodiaEnSucursal", "2026-09-29T10:00:00-03:00"),
    at("Distribucion", "2026-09-28T10:00:00-03:00"),
    at("ComienzoCustodiaEnSucursal", "2026-09-29T10:00:00-03:00"),
  ], false)
  assert.deepEqual([custody.phase, custody.incident], ["en_sucursal", false])
  assert.equal(new Date(String(custody.custodySince)).toISOString(), "2026-09-29T13:00:00.000Z")
  const outOfOrder = resolveClaimShipmentTracking([
    at("EnvioEntregado", "2026-09-30T12:00:00-03:00"),
    at("Distribucion", "2026-09-28T12:00:00-03:00"),
  ], false)
  assert.deepEqual([outOfOrder.phase, outOfOrder.incident], ["entregada", false], "entregado nunca retrocede")
  assert.equal(resolveClaimShipmentTracking([at("Distribucion", "2026-09-28T10:00:00-03:00"), at("EnvioNoEntregado", "2026-09-28T11:00:00-03:00")], false).incident, true)
  assert.equal(resolveClaimShipmentTracking([at("EnvioNoEntregado", "2026-09-28T09:00:00-03:00"), at("EnvioDespachado", "2026-09-28T12:00:00-03:00")], false).incident, false)
  assert.equal(resolveClaimShipmentTracking([at("Distribucion", "2026-09-28T10:00:00-03:00")], true).incident, true)
})

test("cron: sólo tramos creados y abiertos, ambiente de creación, sólo GET; un fallo no frena al resto", async () => {
  const { admin, tables, rpcs } = fakeAdmin({ leg: { creation_status: "created", status: "generada", andreani_envio_id: "R-1", andreani_tracking: "R-1", environment: "PROD" } })
  tables.order_claim_shipments.push(
    legRow("devolucion", { id: 2, claim_id: 51, creation_status: "created", status: "en_transito", andreani_envio_id: "C-1", environment: "QA" }),
    legRow("cambio", { id: 3, claim_id: 52, creation_status: "created", status: "entregada", andreani_envio_id: "X", closed_at: "ayer" }),
    legRow("cambio", { id: 4, claim_id: 53, creation_status: "not_started" }),
    legRow("reemplazo", { id: 5, claim_id: 54, creation_status: "created", status: "generada", andreani_envio_id: "FALLA", environment: "QA" }),
  )
  const seen: Row[] = []
  const fetchSnapshot = (async (order: Row) => {
    seen.push(order)
    if (order.andreani_envio_id === "FALLA") throw new AndreaniError("SERVICE_UNAVAILABLE", "Caída", { status: 503 })
    const delivered = order.andreani_envio_id === "C-1"
    const eventos = [{ Evento: delivered ? "EnvioEntregado" : "Distribucion", Fecha: "2026-09-28T12:00:00-03:00" }]
    return { logisticsEstado: "x", resolvedTracking: String(order.andreani_envio_id), etiquetaUrl: null, rejectedAfterCreation: false, eventos, latestEvent: eventos[0] }
  }) as never
  const errors = console.error
  console.error = () => {}
  try {
    const batch = await runClaimShipmentTrackingBatch(admin, { fetchSnapshot })
    assert.deepEqual(batch, { checked: 3, updated: 2, delivered: 1, failed: 1, review: 0 })
    assert.deepEqual(seen.map((row) => row.andreani_creation_environment), ["PROD", "QA", "QA"])
    assert.ok(!rpcs.some((call) => /claim_order_claim_shipment_creation|complete_order/.test(call.name)), "el cron nunca genera operaciones")
    const again = await runClaimShipmentTrackingBatch(admin, { fetchSnapshot: (async () => { throw new AndreaniError("TIMEOUT", "x") }) as never })
    assert.equal(again.checked, 2, "lo entregado/cerrado no se vuelve a consultar")
  } finally {
    console.error = errors
  }
  await assert.rejects(
    syncClaimShipmentTracking(admin, { ...tables.order_claim_shipments[3], creation_status: "not_started" } as never, { fetchSnapshot }),
    /todavía no tiene una orden/,
  )
})
