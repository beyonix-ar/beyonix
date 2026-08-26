import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { AndreaniError } from "./client.ts"
import type { AndreaniCreateShipmentInput, AndreaniCreateShipmentResponse } from "./types.ts"
import {
  assertAndreaniProdShipmentCreationAuthorized,
  buildAndreaniShipmentEnvio,
  createAndreaniShipmentForOrder,
  parseArgentineStreetAddress,
  resolveAndreaniShipmentCreationConfig,
  resolveAndreaniShipmentEnvironment,
  type AndreaniOrderRow,
  type AndreaniShipmentAttemptErrorContext,
} from "./order-shipment.ts"

function qaEnv(overrides: Partial<NodeJS.ProcessEnv> = {}): NodeJS.ProcessEnv {
  return {
    ANDREANI_ENV: "QA",
    ANDREANI_TARIFF_ENV: "QA",
    ANDREANI_QA_API_URL: "https://apisqa.andreani.com",
    ANDREANI_QA_USERNAME: "usuario-prueba",
    ANDREANI_QA_PASSWORD: "clave-prueba",
    ANDREANI_QA_CLIENT: "CLIENTE-QA",
    ANDREANI_QA_HOME_CONTRACT: "CONTRATO-QA",
    ANDREANI_QA_ORIGIN_BRANCH: "RAC",
    // idgla de sucursal para creación B2C, deliberadamente distinto del
    // código "RAC" de arriba (que solo usa /v1/tarifas) para poder detectar
    // si el código se reutiliza por error como si fuera el id.
    ANDREANI_QA_ORIGIN_BRANCH_ID: "20001",
    NODE_ENV: "test",
    ...overrides,
  }
}

function baseOrder(overrides: Partial<AndreaniOrderRow> = {}): AndreaniOrderRow {
  return {
    id: 42,
    cliente_nombre: "María Muñoz",
    cliente_email: "maria@example.com",
    cliente_telefono: "+54 11 5555-1234",
    cliente_dni: "30123456",
    cliente_direccion: "Macacha Guemes 28, Piso 2 Depto B",
    cp_destino: "1292",
    localidad: "C.A.B.A.",
    provincia: "CABA",
    shipping_type: "domicilio",
    estado: "pagado",
    payment_status: "confirmado",
    paid_at: "2026-08-16T12:00:00.000Z",
    payment_confirmed_amount: 10_000,
    financial_status: "payment_confirmed",
    invoice_status: "authorized",
    invoice_cae: "12345678901234",
    invoice_number: 123,
    invoice_point: 1,
    andreani_envio_id: null,
    andreani_tracking: null,
    andreani_etiqueta_url: null,
    andreani_estado: null,
    ...overrides,
  }
}

const officialOrderResponse: AndreaniCreateShipmentResponse = {
  estado: "Pendiente",
  tipo: "B2C",
  bultos: [
    {
      numeroDeBulto: "1",
      numeroDeEnvio: "360000101651699",
      totalizador: "1/1",
      linking: [
        {
          meta: "Etiqueta",
          contenido:
            "https://apisqa.andreani.com/v2/ordenes-de-envio/API0000000428931/etiquetas?bulto=1",
        },
      ],
    },
  ],
  agrupadorDeBultos: "API0000000428931",
  etiquetasPorAgrupador:
    "https://apisqa.andreani.com/v2/ordenes-de-envio/API0000000428931/etiquetas",
}

test("la RPC remota serializa ambientes y exige pago y factura", () => {
  const migration = readFileSync(
    new URL(
      "../../supabase/migrations/20260825110000_harden_andreani_shipment_lifecycle.sql",
      import.meta.url,
    ),
    "utf8",
  )

  assert.match(migration, /andreani_creation_status = 'reconciliation_required'/)
  assert.match(
    migration,
    /andreani_creation_status is null\s+or andreani_creation_status = 'failed'/,
  )
  assert.match(migration, /paid_at is not null/)
  assert.match(migration, /payment_confirmed_amount/)
  assert.match(migration, /financial_status[\s\S]*'refund_pending'/)
  assert.match(migration, /shipping_type = 'domicilio'/)
  assert.match(migration, /invoice_status = 'authorized'/)
  assert.doesNotMatch(migration, /lower\(coalesce\(estado[\s\S]*?'pagado'/)
})

test("la RPC remota permite reclamar un 'rejected' en el mismo ambiente, pero nunca un 'reconciliation_required'", () => {
  const migration = readFileSync(
    new URL(
      "../../supabase/migrations/20260825140000_andreani_rejected_retry_same_environment.sql",
      import.meta.url,
    ),
    "utf8",
  )

  // La condición de reclamo ya no exige que el ambiente cambie para
  // aceptar un 'rejected' previo.
  assert.match(
    migration,
    /andreani_creation_status is null\s+or andreani_creation_status = 'failed'[\s\S]*?or andreani_creation_status = 'rejected'/,
  )
  assert.doesNotMatch(migration, /andreani_creation_environment is distinct from p_environment/)
  // 'reconciliation_required' sigue sin ninguna vía de reclamo automático.
  assert.doesNotMatch(migration, /or andreani_creation_status = 'reconciliation_required'/)
})

test("parseArgentineStreetAddress separa calle, numero, piso y depto", () => {
  assert.deepEqual(
    parseArgentineStreetAddress("Macacha Guemes 28, Piso 2 Depto B"),
    { calle: "Macacha Guemes", numero: "28", piso: "2", departamento: "B" },
  )
})

test("parseArgentineStreetAddress no inventa un número cuando no puede identificarlo", () => {
  const result = parseArgentineStreetAddress("Ruta provincial sin altura")
  assert.equal(result.calle.length > 0, true)
  assert.equal(result.numero, "")
})

test("sin ANDREANI_SHIPMENT_ENV, la creación resuelve QA aunque ANDREANI_ENV/ANDREANI_TARIFF_ENV sean PROD", () => {
  const config = resolveAndreaniShipmentCreationConfig(
    qaEnv({
      ANDREANI_ENV: "PROD",
      ANDREANI_TARIFF_ENV: "PROD",
      ANDREANI_PROD_CLIENT: "CLIENTE-PROD",
      ANDREANI_PROD_HOME_CONTRACT: "CONTRATO-PROD",
      ANDREANI_PROD_ORIGIN_BRANCH: "OTRA-PROD",
      ANDREANI_QA_ORIGIN_BRANCH: "OTRA-QA",
    }),
  )

  assert.equal(config.environment, "QA")
  assert.equal(config.cliente, "CLIENTE-QA")
  assert.equal(config.domicilioContrato, "CONTRATO-QA")
  assert.equal(config.sucursalOrigenCodigo, "OTRA-QA")
  assert.equal(config.sucursalOrigenId, "20001")
  assert.equal(config.remitenteNombre, "BEYONIX")
})

test("resolveAndreaniShipmentEnvironment respeta ANDREANI_SHIPMENT_ENV explícito, independiente de ANDREANI_TARIFF_ENV", () => {
  assert.equal(
    resolveAndreaniShipmentEnvironment(qaEnv({ ANDREANI_TARIFF_ENV: "PROD" })),
    "QA",
  )
  assert.equal(
    resolveAndreaniShipmentEnvironment(
      qaEnv({ ANDREANI_SHIPMENT_ENV: "PROD", ANDREANI_TARIFF_ENV: "PROD" }),
    ),
    "PROD",
  )
  assert.equal(
    resolveAndreaniShipmentEnvironment(
      qaEnv({ ANDREANI_SHIPMENT_ENV: "qa", ANDREANI_TARIFF_ENV: "PROD" }),
    ),
    "QA",
  )
  assert.throws(
    () => resolveAndreaniShipmentEnvironment(qaEnv({ ANDREANI_SHIPMENT_ENV: "staging" })),
    (error: unknown) =>
      error instanceof AndreaniError && error.code === "CONFIGURATION_ERROR",
  )
})

test("resolveAndreaniShipmentCreationConfig resuelve PROD usando exclusivamente las variables PROD", () => {
  const config = resolveAndreaniShipmentCreationConfig(
    qaEnv({
      ANDREANI_SHIPMENT_ENV: "PROD",
      ANDREANI_PROD_CLIENT: "0012011683",
      ANDREANI_PROD_HOME_CONTRACT: "400042104",
      ANDREANI_PROD_ORIGIN_BRANCH: "RAC",
      ANDREANI_PROD_ORIGIN_BRANCH_ID: "10179",
    }),
  )

  assert.equal(config.environment, "PROD")
  assert.equal(config.cliente, "0012011683")
  assert.equal(config.domicilioContrato, "400042104")
  assert.equal(config.sucursalOrigenCodigo, "RAC")
  assert.equal(config.sucursalOrigenId, "10179")
})

test("resolveAndreaniShipmentCreationConfig exige el idgla de sucursal para creación, no alcanza con el código tarifario", () => {
  assert.throws(
    () =>
      resolveAndreaniShipmentCreationConfig(
        qaEnv({
          ANDREANI_SHIPMENT_ENV: "PROD",
          ANDREANI_PROD_CLIENT: "0012011683",
          ANDREANI_PROD_HOME_CONTRACT: "400042104",
          ANDREANI_PROD_ORIGIN_BRANCH: "RAC",
          ANDREANI_PROD_ORIGIN_BRANCH_ID: undefined,
        }),
      ),
    (error: unknown) =>
      error instanceof AndreaniError &&
      error.code === "CONFIGURATION_ERROR" &&
      error.message.includes("ANDREANI_PROD_ORIGIN_BRANCH_ID"),
  )
})

test("assertAndreaniProdShipmentCreationAuthorized bloquea PROD sin la autorización explícita", () => {
  assert.throws(
    () => assertAndreaniProdShipmentCreationAuthorized("PROD", qaEnv()),
    (error: unknown) =>
      error instanceof AndreaniError && error.code === "PRODUCTION_BLOCKED",
  )
  assert.throws(
    () =>
      assertAndreaniProdShipmentCreationAuthorized(
        "PROD",
        qaEnv({ ANDREANI_ALLOW_PROD_SHIPMENT_CREATION: "false" }),
      ),
    (error: unknown) =>
      error instanceof AndreaniError && error.code === "PRODUCTION_BLOCKED",
  )
  assert.doesNotThrow(() =>
    assertAndreaniProdShipmentCreationAuthorized(
      "PROD",
      qaEnv({
        ANDREANI_ALLOW_PROD_SHIPMENT_CREATION: "true",
        NODE_ENV: "production",
      }),
    ),
  )
  assert.throws(
    () =>
      assertAndreaniProdShipmentCreationAuthorized(
        "PROD",
        qaEnv({ ANDREANI_ALLOW_PROD_SHIPMENT_CREATION: "true" }),
      ),
    (error: unknown) =>
      error instanceof AndreaniError && error.code === "PRODUCTION_BLOCKED",
  )
  assert.doesNotThrow(() =>
    assertAndreaniProdShipmentCreationAuthorized("QA", qaEnv()),
  )
})

test("ANDREANI_ALLOW_PROD_SHIPMENT_CREATION_IN_DEV solo habilita PROD en desarrollo, nunca en test", () => {
  // NODE_ENV=test: PROD siempre bloqueado, aunque todas las flags estén en "true".
  assert.throws(
    () =>
      assertAndreaniProdShipmentCreationAuthorized(
        "PROD",
        qaEnv({
          NODE_ENV: "test",
          ANDREANI_ALLOW_PROD_SHIPMENT_CREATION: "true",
          ANDREANI_ALLOW_PROD_SHIPMENT_CREATION_IN_DEV: "true",
        }),
      ),
    (error: unknown) =>
      error instanceof AndreaniError && error.code === "PRODUCTION_BLOCKED",
  )

  // NODE_ENV=development: sin la bandera de desarrollo, sigue bloqueado.
  assert.throws(
    () =>
      assertAndreaniProdShipmentCreationAuthorized(
        "PROD",
        qaEnv({
          NODE_ENV: "development",
          ANDREANI_ALLOW_PROD_SHIPMENT_CREATION: "true",
        }),
      ),
    (error: unknown) =>
      error instanceof AndreaniError && error.code === "PRODUCTION_BLOCKED",
  )

  // NODE_ENV=development: con las tres flags activas, queda permitido.
  assert.doesNotThrow(() =>
    assertAndreaniProdShipmentCreationAuthorized(
      "PROD",
      qaEnv({
        NODE_ENV: "development",
        ANDREANI_ALLOW_PROD_SHIPMENT_CREATION: "true",
        ANDREANI_ALLOW_PROD_SHIPMENT_CREATION_IN_DEV: "true",
      }),
    ),
  )

  // NODE_ENV=development: la bandera de desarrollo sola no alcanza sin la
  // autorización general de PROD.
  assert.throws(
    () =>
      assertAndreaniProdShipmentCreationAuthorized(
        "PROD",
        qaEnv({
          NODE_ENV: "development",
          ANDREANI_ALLOW_PROD_SHIPMENT_CREATION: "false",
          ANDREANI_ALLOW_PROD_SHIPMENT_CREATION_IN_DEV: "true",
        }),
      ),
    (error: unknown) =>
      error instanceof AndreaniError && error.code === "PRODUCTION_BLOCKED",
  )

  // NODE_ENV=production: comportamiento actual, sin depender de la bandera
  // de desarrollo.
  assert.doesNotThrow(() =>
    assertAndreaniProdShipmentCreationAuthorized(
      "PROD",
      qaEnv({
        NODE_ENV: "production",
        ANDREANI_ALLOW_PROD_SHIPMENT_CREATION: "true",
      }),
    ),
  )
  assert.throws(
    () =>
      assertAndreaniProdShipmentCreationAuthorized(
        "PROD",
        qaEnv({
          NODE_ENV: "production",
          ANDREANI_ALLOW_PROD_SHIPMENT_CREATION: "false",
        }),
      ),
    (error: unknown) =>
      error instanceof AndreaniError && error.code === "PRODUCTION_BLOCKED",
  )
})

test("resolveAndreaniShipmentCreationConfig exige contrato de domicilio", () => {
  const env = qaEnv()
  delete env.ANDREANI_QA_HOME_CONTRACT
  env.ANDREANI_QA_BRANCH_CONTRACT = "CONTRATO-SUCURSAL"

  assert.throws(
    () => resolveAndreaniShipmentCreationConfig(env),
    (error: unknown) =>
      error instanceof AndreaniError && error.code === "CONFIGURATION_ERROR",
  )
})

test("resolveAndreaniShipmentCreationConfig valida los datos opcionales del remitente", () => {
  assert.throws(
    () =>
      resolveAndreaniShipmentCreationConfig(
        qaEnv({ ANDREANI_REMITENTE_DOCUMENTO_TIPO: "CUIT" }),
      ),
    (error: unknown) =>
      error instanceof AndreaniError && error.code === "CONFIGURATION_ERROR",
  )

  const config = resolveAndreaniShipmentCreationConfig(
    qaEnv({
      ANDREANI_REMITENTE_TELEFONO: "+54 11 5555-1234",
      ANDREANI_REMITENTE_DOCUMENTO_TIPO: "cuit",
      ANDREANI_REMITENTE_DOCUMENTO_NUMERO: "30-12345678-9",
    }),
  )
  assert.equal(config.remitenteTelefono, "541155551234")
  assert.equal(config.remitenteDocumentoTipo, "CUIT")
})

test("buildAndreaniShipmentEnvio arma domicilio con el idgla de sucursal (no el código tarifario) y contrato correctos", () => {
  const config = resolveAndreaniShipmentCreationConfig(qaEnv())
  const envio = buildAndreaniShipmentEnvio(baseOrder(), config)

  assert.equal(envio.contrato, "CONTRATO-QA")
  // origen.sucursal.id debe ser el idgla ("20001" en este entorno de test),
  // nunca el código tarifario "RAC" -- reutilizarlo produce el HTTP 400
  // "Sucursal con idgla RAC no encontrada" observado en el intento real.
  assert.deepEqual(envio.origen, { sucursal: { id: "20001" } })
  assert.deepEqual(envio.destino, {
    postal: {
      codigoPostal: "1292",
      calle: "Macacha Guemes",
      numero: "28",
      piso: "2",
      departamento: "B",
      localidad: "C.A.B.A.",
      pais: "Argentina",
    },
  })
  assert.equal(envio.destinatario[0].nombreCompleto, "María Muñoz")
  assert.equal(envio.destinatario[0].documentoNumero, "30123456")
  assert.equal(envio.destinatario[0].telefonos?.[0].numero, "541155551234")
  assert.equal(envio.remitente.nombreCompleto, "BEYONIX")
})

test("buildAndreaniShipmentEnvio bloquea sucursal sin inventar datos", () => {
  const config = resolveAndreaniShipmentCreationConfig(qaEnv())

  assert.throws(
    () =>
      buildAndreaniShipmentEnvio(
        baseOrder({ shipping_type: "sucursal" }),
        config,
      ),
    (error: unknown) =>
      error instanceof AndreaniError &&
      error.code === "VALIDATION_ERROR" &&
      error.message.includes("sucursal"),
  )
})

test("buildAndreaniShipmentEnvio rechaza pedidos sin información logística completa", () => {
  const config = resolveAndreaniShipmentCreationConfig(qaEnv())

  for (const overrides of [
    { cp_destino: null },
    { localidad: null },
    { provincia: null },
    { cliente_direccion: null },
    { cliente_direccion: "Ruta provincial sin altura" },
    { cliente_dni: null },
    { cliente_telefono: null },
    { shipping_type: null },
  ] satisfies Partial<AndreaniOrderRow>[]) {
    assert.throws(
      () => buildAndreaniShipmentEnvio(baseOrder(overrides), config),
      (error: unknown) =>
        error instanceof AndreaniError && error.code === "VALIDATION_ERROR",
    )
  }
})

interface FakeTable {
  ordenes: AndreaniOrderRow & Record<string, unknown>
  orden_items: Array<Record<string, unknown>>
  productos: Array<Record<string, unknown>>
  producto_variantes: Array<Record<string, unknown>>
}

function createFakeAdmin(tables: FakeTable) {
  const claimCalls: unknown[] = []

  function applyFilters<T extends Record<string, unknown>>(
    rows: T[],
    filters: Array<{ type: "eq" | "in"; col: string; val: unknown }>,
  ) {
    return rows.filter((row) =>
      filters.every((filter) =>
        filter.type === "eq"
          ? row[filter.col] === filter.val
          : (filter.val as unknown[]).includes(row[filter.col]),
      ),
    )
  }

  function selectBuilder(table: keyof FakeTable) {
    const filters: Array<{ type: "eq" | "in"; col: string; val: unknown }> = []
    const rowsSource = () =>
      table === "ordenes"
        ? [tables.ordenes as unknown as Record<string, unknown>]
        : (tables[table] as unknown as Record<string, unknown>[])

    const builder = {
      eq(col: string, val: unknown) {
        filters.push({ type: "eq", col, val })
        return builder
      },
      in(col: string, val: unknown[]) {
        filters.push({ type: "in", col, val })
        return builder
      },
      maybeSingle: async () => ({
        data: applyFilters(rowsSource(), filters)[0] ?? null,
        error: null,
      }),
      then(resolve: (value: { data: unknown; error: null }) => unknown) {
        return Promise.resolve({
          data: applyFilters(rowsSource(), filters),
          error: null,
        }).then(resolve)
      },
    }
    return builder
  }

  function updateBuilder(table: keyof FakeTable, patch: Record<string, unknown>) {
    const filters: Array<{ col: string; val: unknown }> = []
    const applyIfMatches = () => {
      const matches = filters.every((f) => (tables.ordenes as never)[f.col] === f.val)
      if (matches && table === "ordenes") {
        Object.assign(tables.ordenes, patch)
      }
      return matches
    }
    const builder = {
      eq(col: string, val: unknown) {
        filters.push({ col, val })
        return builder
      },
      select() {
        return builder
      },
      maybeSingle: async () => {
        const matched = applyIfMatches()
        return { data: matched ? { id: tables.ordenes.id } : null, error: null }
      },
      then(resolve: (value: { data: unknown; error: null }) => unknown) {
        applyIfMatches()
        return Promise.resolve({ data: null, error: null }).then(resolve)
      },
    }
    return builder
  }

  return {
    from(table: keyof FakeTable) {
      return {
        select: () => selectBuilder(table),
        update: (patch: Record<string, unknown>) => updateBuilder(table, patch),
      }
    },
    rpc: async (
      name: string,
      args: { p_order_id: number; p_claim_token: string; p_environment: string },
    ) => {
      assert.equal(name, "claim_andreani_shipment_creation")
      assert.ok(
        args.p_environment === "QA" || args.p_environment === "PROD",
        "p_environment debe ser QA o PROD",
      )
      claimCalls.push(args)
      const order = tables.ordenes
      const paymentConfirmed =
        Boolean(order.paid_at) ||
        Number(order.payment_confirmed_amount ?? 0) > 0 ||
        ["confirmado", "approved", "confirmed"].includes(
          String(order.payment_status ?? "").toLowerCase(),
        ) ||
        order.financial_status === "payment_confirmed"
      const claimedAt = order.andreani_creation_claimed_at
        ? new Date(String(order.andreani_creation_claimed_at)).getTime()
        : null
      // Igual que la RPC real: un claim vencido es ambiguo en cualquier
      // ambiente y bloquea hasta conciliación manual.
      if (
        order.andreani_creation_status === "claimed" &&
        claimedAt !== null &&
        Date.now() - claimedAt > 5 * 60 * 1000
      ) {
        order.andreani_creation_status = "reconciliation_required"
        order.andreani_creation_claim_token = null
      }
      // Igual que la RPC real (20260825140000_andreani_rejected_retry_same_environment.sql):
      // un rechazo determinístico ("rejected", HTTP 400/422) es reclamable en
      // cualquier ambiente, incluido el mismo que lo rechazó -- Andreani no
      // llegó a crear nada. Solo "reconciliation_required" (ambiguo) nunca
      // se reclama automáticamente.
      const reclaimable =
        !order.andreani_creation_status ||
        order.andreani_creation_status === "failed" ||
        order.andreani_creation_status === "rejected"
      const canClaim =
        !order.andreani_envio_id &&
        reclaimable &&
        order.shipping_type === "domicilio" &&
        order.estado !== "cancelado" &&
        !["cancellation_requested", "cancelled", "refund_pending", "refunded"].includes(
          String(order.financial_status ?? ""),
        ) &&
        paymentConfirmed &&
        order.invoice_status === "authorized" &&
        Boolean(order.invoice_cae) &&
        Boolean(order.invoice_number) &&
        Boolean(order.invoice_point)

      if (!canClaim) return { data: null, error: null }

      order.andreani_creation_status = "claimed"
      order.andreani_creation_claim_token = args.p_claim_token
      order.andreani_creation_claimed_at = new Date().toISOString()
      order.andreani_creation_environment = args.p_environment
      order.andreani_creation_attempts =
        Number(order.andreani_creation_attempts ?? 0) + 1
      return { data: order.andreani_creation_attempts, error: null }
    },
    claimCalls,
    tables,
  }
}

const productA = {
  id: 1,
  nombre: "Producto A",
  peso_empaquetado_kg: 2,
  alto_paquete_cm: 10,
  ancho_paquete_cm: 10,
  largo_paquete_cm: 10,
}
const productB = {
  id: 2,
  nombre: "Producto B",
  peso_empaquetado_kg: 1,
  alto_paquete_cm: 5,
  ancho_paquete_cm: 5,
  largo_paquete_cm: 5,
}

function singleItemTables(overrides: Partial<AndreaniOrderRow> = {}) {
  return {
    ordenes: baseOrder(overrides) as never,
    orden_items: [
      { orden_id: 42, producto_id: 1, variante_id: null, conditioned_stock_id: null, cantidad: 1, precio: 10_000 },
    ],
    productos: [productA],
    producto_variantes: [],
  }
}

test("reutiliza el envío existente sin volver a llamar a Andreani", async () => {
  const admin = createFakeAdmin(
    singleItemTables({ andreani_envio_id: "API-EXISTENTE", andreani_tracking: "TRK-1" }),
  )
  let creationCalls = 0

  const result = await createAndreaniShipmentForOrder(admin as never, 42, {
    env: qaEnv(),
    crearOrdenEnvio: async () => {
      creationCalls += 1
      return officialOrderResponse
    },
  })

  assert.equal(result.status, "reused")
  assert.equal(result.envioId, "API-EXISTENTE")
  assert.equal(creationCalls, 0)
  assert.equal(admin.claimCalls.length, 0)
})

test("crea el envío, consolida un único bulto y persiste la referencia", async () => {
  const tables = {
    ordenes: baseOrder() as never,
    orden_items: [
      { orden_id: 42, producto_id: 1, variante_id: null, conditioned_stock_id: null, cantidad: 2, precio: 10_000 },
      { orden_id: 42, producto_id: 2, variante_id: null, conditioned_stock_id: null, cantidad: 1, precio: 5_000 },
    ],
    productos: [productA, productB],
    producto_variantes: [],
  }
  const admin = createFakeAdmin(tables)
  const capturedInputs: AndreaniCreateShipmentInput[] = []
  const capturedEnvs: NodeJS.ProcessEnv[] = []

  const result = await createAndreaniShipmentForOrder(admin as never, 42, {
    env: qaEnv({ ANDREANI_TARIFF_ENV: "PROD" }),
    crearOrdenEnvio: async (input, options) => {
      capturedInputs.push(input)
      if (options?.env) capturedEnvs.push(options.env)
      return officialOrderResponse
    },
  })

  assert.equal(result.status, "created")
  assert.equal(result.envioId, "API0000000428931")
  assert.equal(result.tracking, "360000101651699")
  assert.equal(capturedEnvs[0]?.ANDREANI_ENV, "QA")
  assert.equal(capturedInputs[0]?.items.length, 1)
  assert.equal(capturedInputs[0]?.items[0].producto.peso_empaquetado_kg, 5)
  assert.equal(capturedInputs[0]?.items[0].bulto?.volumenCm, 2_125)
  assert.equal(capturedInputs[0]?.items[0].bulto?.valorDeclaradoConImpuestos, 25_000)
  assert.deepEqual(capturedInputs[0]?.items[0].bulto?.referencias, [
    { meta: "idCliente", contenido: "42" },
  ])
  assert.equal(capturedInputs[0]?.envio.destinatario[0].telefonos?.[0].tipo, 2)
  assert.equal(admin.tables.ordenes.andreani_creation_status, "created")
  assert.equal(admin.tables.ordenes.andreani_creation_claim_token, null)
  assert.equal(admin.tables.ordenes.andreani_contrato, "CONTRATO-QA")
})

test("rechaza un pedido con más de 50 kg consolidados sin llamar a la red", async () => {
  const admin = createFakeAdmin({
    ordenes: baseOrder() as never,
    orden_items: [
      { orden_id: 42, producto_id: 1, variante_id: null, conditioned_stock_id: null, cantidad: 30, precio: 10_000 },
    ],
    productos: [productA],
    producto_variantes: [],
  })

  await assert.rejects(
    () => createAndreaniShipmentForOrder(admin as never, 42, { env: qaEnv() }),
    (error: unknown) =>
      error instanceof AndreaniError && error.code === "VALIDATION_ERROR",
  )
  assert.equal(admin.tables.ordenes.andreani_creation_status, "failed")
})

test("no duplica el envío si ya hay un reclamo reciente en curso", async () => {
  const admin = createFakeAdmin(
    singleItemTables({
      andreani_creation_status: "claimed",
      andreani_creation_claimed_at: new Date().toISOString(),
      andreani_creation_claim_token: "otro-token",
    } as Partial<AndreaniOrderRow>),
  )
  let creationCalls = 0

  await assert.rejects(
    () =>
      createAndreaniShipmentForOrder(admin as never, 42, {
        env: qaEnv(),
        crearOrdenEnvio: async () => {
          creationCalls += 1
          return officialOrderResponse
        },
      }),
    (error: unknown) => error instanceof AndreaniError && !error.retryable,
  )
  assert.equal(creationCalls, 0)
  assert.equal(admin.tables.ordenes.andreani_creation_status, "claimed")
})

test("dos requests concurrentes adquieren un solo claim y ejecutan un solo POST", async () => {
  const admin = createFakeAdmin(singleItemTables())
  let creationCalls = 0
  let releaseCreation!: () => void
  let notifyStarted!: () => void
  const started = new Promise<void>((resolve) => {
    notifyStarted = resolve
  })
  const release = new Promise<void>((resolve) => {
    releaseCreation = resolve
  })

  const first = createAndreaniShipmentForOrder(admin as never, 42, {
    env: qaEnv(),
    crearOrdenEnvio: async () => {
      creationCalls += 1
      notifyStarted()
      await release
      return officialOrderResponse
    },
  })
  await started

  await assert.rejects(() =>
    createAndreaniShipmentForOrder(admin as never, 42, {
      env: qaEnv(),
      crearOrdenEnvio: async () => {
        creationCalls += 1
        return officialOrderResponse
      },
    }),
  )
  releaseCreation()
  const result = await first

  assert.equal(result.status, "created")
  assert.equal(creationCalls, 1)
})

test("un reclamo vencido no permite un POST ciego que podría duplicar el envío", async () => {
  const admin = createFakeAdmin(
    singleItemTables({
      andreani_creation_status: "claimed",
      andreani_creation_environment: "QA",
      andreani_creation_claimed_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      andreani_creation_claim_token: "token-viejo",
    } as Partial<AndreaniOrderRow>),
  )
  let creationCalls = 0

  await assert.rejects(
    () =>
      createAndreaniShipmentForOrder(admin as never, 42, {
        env: qaEnv(),
        crearOrdenEnvio: async () => {
          creationCalls += 1
          return officialOrderResponse
        },
      }),
    (error: unknown) =>
      error instanceof AndreaniError && !error.retryable,
  )
  assert.equal(creationCalls, 0)
  assert.equal(admin.tables.ordenes.andreani_creation_status, "reconciliation_required")
})

test("reintenta una única vez ante 401/403 y no duplica el envío", async () => {
  const admin = createFakeAdmin(singleItemTables())
  let calls = 0

  const result = await createAndreaniShipmentForOrder(admin as never, 42, {
    env: qaEnv(),
    crearOrdenEnvio: async () => {
      calls += 1
      if (calls === 1) {
        throw new AndreaniError("AUTHENTICATION_FAILED", "Andreani rechazó la autenticación.", {
          status: 401,
        })
      }
      return officialOrderResponse
    },
  })

  assert.equal(calls, 2)
  assert.equal(result.status, "created")
})

test("un 5xx queda bloqueado para conciliación y no se reintenta automáticamente", async () => {
  const admin = createFakeAdmin(singleItemTables())
  let calls = 0

  await assert.rejects(
    () =>
      createAndreaniShipmentForOrder(admin as never, 42, {
        env: qaEnv(),
        crearOrdenEnvio: async () => {
          calls += 1
          throw new AndreaniError("SERVICE_UNAVAILABLE", "Andreani no disponible.", {
            status: 503,
            retryable: true,
          })
        },
      }),
    (error: unknown) =>
      error instanceof AndreaniError && error.code === "SERVICE_UNAVAILABLE",
  )
  assert.equal(calls, 1)
  assert.equal(admin.tables.ordenes.andreani_creation_status, "reconciliation_required")
  assert.equal(admin.tables.ordenes.andreani_creation_claim_token, null)

  await assert.rejects(() =>
    createAndreaniShipmentForOrder(admin as never, 42, {
      env: qaEnv(),
      crearOrdenEnvio: async () => {
        calls += 1
        return officialOrderResponse
      },
    }),
  )
  assert.equal(calls, 1)
})

test("un timeout con respuesta perdida bloquea cualquier segundo POST", async () => {
  const admin = createFakeAdmin(singleItemTables())
  let calls = 0

  await assert.rejects(
    () =>
      createAndreaniShipmentForOrder(admin as never, 42, {
        env: qaEnv(),
        crearOrdenEnvio: async () => {
          calls += 1
          throw new AndreaniError("TIMEOUT", "Tiempo agotado.", { retryable: true })
        },
      }),
    (error: unknown) => error instanceof AndreaniError && error.code === "TIMEOUT",
  )
  assert.equal(admin.tables.ordenes.andreani_creation_status, "reconciliation_required")

  await assert.rejects(() =>
    createAndreaniShipmentForOrder(admin as never, 42, {
      env: qaEnv(),
      crearOrdenEnvio: async () => {
        calls += 1
        return officialOrderResponse
      },
    }),
  )
  assert.equal(calls, 1)
})

test("un 409 (ambiguo) se concilia y nunca se reclama solo, ni cambiando de ambiente", async () => {
  const admin = createFakeAdmin(singleItemTables())
  let calls = 0

  await assert.rejects(() =>
    createAndreaniShipmentForOrder(admin as never, 42, {
      env: qaEnv(),
      crearOrdenEnvio: async () => {
        calls += 1
        throw new AndreaniError("REQUEST_FAILED", "Solicitud rechazada.", {
          status: 409,
        })
      },
    }),
  )
  assert.equal(admin.tables.ordenes.andreani_creation_status, "reconciliation_required")

  await assert.rejects(() =>
    createAndreaniShipmentForOrder(admin as never, 42, {
      env: qaEnv(),
      crearOrdenEnvio: async () => {
        calls += 1
        return officialOrderResponse
      },
    }),
  )
  assert.equal(calls, 1)
})

test("un 400/422 determinístico (sin envío creado) queda rejected y SÍ es reintentable en el mismo ambiente", async () => {
  for (const status of [400, 422] as const) {
    const admin = createFakeAdmin(singleItemTables())
    let calls = 0

    await assert.rejects(() =>
      createAndreaniShipmentForOrder(admin as never, 42, {
        env: qaEnv(),
        crearOrdenEnvio: async () => {
          calls += 1
          throw new AndreaniError("REQUEST_FAILED", "Solicitud rechazada.", {
            status,
          })
        },
      }),
    )
    assert.equal(admin.tables.ordenes.andreani_creation_status, "rejected")
    assert.equal(admin.tables.ordenes.andreani_envio_id, null)

    // Mismo ambiente (QA) que el rechazo: antes de la migración
    // 20260825140000 esto quedaba bloqueado indefinidamente ("ya está en
    // curso o requiere conciliación manual"), aunque Andreani nunca hubiera
    // creado nada.
    const result = await createAndreaniShipmentForOrder(admin as never, 42, {
      env: qaEnv(),
      crearOrdenEnvio: async () => {
        calls += 1
        return officialOrderResponse
      },
    })
    assert.equal(result.status, "created")
    assert.equal(calls, 2)
  }
})

test("un 429 queda fallido y permite un único reintento posterior", async () => {
  const admin = createFakeAdmin(singleItemTables())
  let calls = 0

  await assert.rejects(() =>
    createAndreaniShipmentForOrder(admin as never, 42, {
      env: qaEnv(),
      crearOrdenEnvio: async () => {
        calls += 1
        throw new AndreaniError("REQUEST_FAILED", "Límite de solicitudes.", {
          status: 429,
        })
      },
    }),
  )
  assert.equal(admin.tables.ordenes.andreani_creation_status, "failed")

  const result = await createAndreaniShipmentForOrder(admin as never, 42, {
    env: qaEnv(),
    crearOrdenEnvio: async () => {
      calls += 1
      return officialOrderResponse
    },
  })
  assert.equal(result.status, "created")
  assert.equal(calls, 2)
})

test("no asocia una respuesta a la orden si el token del claim ya no coincide", async () => {
  const admin = createFakeAdmin(singleItemTables())

  await assert.rejects(
    () =>
      createAndreaniShipmentForOrder(admin as never, 42, {
        env: qaEnv(),
        crearOrdenEnvio: async () => {
          admin.tables.ordenes.andreani_creation_claim_token = "otro-claim"
          return officialOrderResponse
        },
      }),
    (error: unknown) =>
      error instanceof AndreaniError && error.code === "REQUEST_FAILED",
  )

  assert.equal(admin.tables.ordenes.andreani_envio_id, null)
  assert.equal(admin.tables.ordenes.andreani_creation_claim_token, "otro-claim")
  assert.equal(admin.tables.ordenes.andreani_creation_status, "claimed")
})

test("rechaza pedidos cancelados sin reclamar la creación", async () => {
  const admin = createFakeAdmin(
    singleItemTables({ estado: "cancelado", financial_status: "cancelled" }),
  )

  await assert.rejects(
    () => createAndreaniShipmentForOrder(admin as never, 42, { env: qaEnv() }),
    (error: unknown) =>
      error instanceof AndreaniError && error.code === "VALIDATION_ERROR",
  )
  assert.equal(admin.claimCalls.length, 0)
})

test("rechaza pedidos sin pago confirmado", async () => {
  const admin = createFakeAdmin(
    singleItemTables({
      estado: "pendiente",
      payment_status: "pendiente_comprobante",
      paid_at: null,
      payment_confirmed_amount: null,
      financial_status: "pending_payment",
    }),
  )

  await assert.rejects(
    () => createAndreaniShipmentForOrder(admin as never, 42, { env: qaEnv() }),
    (error: unknown) =>
      error instanceof AndreaniError && error.code === "VALIDATION_ERROR",
  )
  assert.equal(admin.claimCalls.length, 0)
})

test("rechaza pedidos con cancelación solicitada aunque el pago haya estado confirmado", async () => {
  const admin = createFakeAdmin(
    singleItemTables({
      estado: "pagado",
      financial_status: "cancellation_requested",
    }),
  )

  await assert.rejects(
    () => createAndreaniShipmentForOrder(admin as never, 42, { env: qaEnv() }),
    (error: unknown) =>
      error instanceof AndreaniError &&
      error.code === "VALIDATION_ERROR" &&
      /cancelado o con reintegro en curso/.test(error.message),
  )

  assert.equal(admin.claimCalls.length, 0)
})

test("rechaza pedidos sin Factura C autorizada antes de reclamar", async () => {
  const admin = createFakeAdmin(
    singleItemTables({
      invoice_status: "pending",
      invoice_cae: null,
      invoice_number: null,
      invoice_point: null,
    }),
  )

  await assert.rejects(
    () => createAndreaniShipmentForOrder(admin as never, 42, { env: qaEnv() }),
    (error: unknown) =>
      error instanceof AndreaniError &&
      error.code === "VALIDATION_ERROR" &&
      error.message.includes("Factura C autorizada"),
  )
  assert.equal(admin.claimCalls.length, 0)
})

test("una orden pagada tardíamente recién puede reclamar después de confirmarse", async () => {
  const admin = createFakeAdmin(
    singleItemTables({
      estado: "pendiente",
      payment_status: "pendiente_comprobante",
      paid_at: null,
      payment_confirmed_amount: null,
      financial_status: "pending_payment",
    }),
  )
  let calls = 0

  await assert.rejects(() =>
    createAndreaniShipmentForOrder(admin as never, 42, { env: qaEnv() }),
  )
  assert.equal(admin.claimCalls.length, 0)

  Object.assign(admin.tables.ordenes, {
    estado: "pagado",
    payment_status: "confirmado",
    paid_at: "2026-08-17T18:00:00.000Z",
    financial_status: "payment_confirmed",
  })
  const result = await createAndreaniShipmentForOrder(admin as never, 42, {
    env: qaEnv(),
    crearOrdenEnvio: async () => {
      calls += 1
      return officialOrderResponse
    },
  })

  assert.equal(result.status, "created")
  assert.equal(calls, 1)
})

test("rechaza asociaciones de variantes o stock condicionado con otro producto", async () => {
  const admin = createFakeAdmin({
    ordenes: baseOrder() as never,
    orden_items: [
      {
        orden_id: 42,
        producto_id: 1,
        variante_id: 20,
        conditioned_stock_id: null,
        cantidad: 1,
        precio: 10_000,
      },
    ],
    productos: [productA],
    producto_variantes: [
      {
        id: 20,
        producto_id: 2,
        nombre: "Variante ajena",
        peso_empaquetado_kg: 1,
        alto_paquete_cm: 5,
        ancho_paquete_cm: 5,
        largo_paquete_cm: 5,
      },
    ],
  })

  await assert.rejects(
    () => createAndreaniShipmentForOrder(admin as never, 42, { env: qaEnv() }),
    (error: unknown) =>
      error instanceof AndreaniError && error.code === "VALIDATION_ERROR",
  )
  assert.equal(admin.claimCalls.length, 0)
})

test("rechaza cuando el pedido eligió sucursal sin datos de sucursal", async () => {
  const admin = createFakeAdmin(singleItemTables({ shipping_type: "sucursal" }))

  await assert.rejects(
    () => createAndreaniShipmentForOrder(admin as never, 42, { env: qaEnv() }),
    (error: unknown) =>
      error instanceof AndreaniError &&
      error.code === "VALIDATION_ERROR" &&
      error.message.includes("sucursal"),
  )
})

test("rechaza cuando falta información logística (por ejemplo, transferencia histórica)", async () => {
  const admin = createFakeAdmin(singleItemTables({ cp_destino: null }))

  await assert.rejects(
    () => createAndreaniShipmentForOrder(admin as never, 42, { env: qaEnv() }),
    (error: unknown) =>
      error instanceof AndreaniError && error.code === "VALIDATION_ERROR",
  )
})

test("un estado Rechazado de Andreani se persiste como rechazo permanente", async () => {
  const admin = createFakeAdmin(singleItemTables())

  await assert.rejects(
    () =>
      createAndreaniShipmentForOrder(admin as never, 42, {
        env: qaEnv(),
        crearOrdenEnvio: async () => ({
          ...officialOrderResponse,
          estado: "Rechazado",
          motivo: "Domicilio no cubierto",
        }),
      }),
    (error: unknown) =>
      error instanceof AndreaniError && error.message === "Domicilio no cubierto",
  )
  assert.equal(admin.tables.ordenes.andreani_envio_id, null)
  assert.equal(admin.tables.ordenes.andreani_creation_status, "rejected")
  assert.equal(admin.tables.ordenes.andreani_estado, "Rechazado")
  assert.equal(admin.tables.ordenes.andreani_contrato, "CONTRATO-QA")
})

function prodShipmentEnv(overrides: Partial<NodeJS.ProcessEnv> = {}): NodeJS.ProcessEnv {
  return qaEnv({
    NODE_ENV: "production",
    ANDREANI_SHIPMENT_ENV: "PROD",
    ANDREANI_ALLOW_PROD_SHIPMENT_CREATION: "true",
    ANDREANI_PROD_API_URL: "https://apis.andreani.com",
    ANDREANI_PROD_USERNAME: "usuario-prod",
    ANDREANI_PROD_PASSWORD: "clave-prod",
    ANDREANI_PROD_CLIENT: "0012011683",
    ANDREANI_PROD_HOME_CONTRACT: "400042104",
    ANDREANI_PROD_ORIGIN_BRANCH: "RAC",
    ANDREANI_PROD_ORIGIN_BRANCH_ID: "10179",
    ...overrides,
  })
}

test("PROD sin ANDREANI_ALLOW_PROD_SHIPMENT_CREATION queda bloqueado antes de reclamar", async () => {
  const admin = createFakeAdmin(singleItemTables())
  let creationCalls = 0

  await assert.rejects(
    () =>
      createAndreaniShipmentForOrder(admin as never, 42, {
        env: prodShipmentEnv({ ANDREANI_ALLOW_PROD_SHIPMENT_CREATION: undefined }),
        crearOrdenEnvio: async () => {
          creationCalls += 1
          return officialOrderResponse
        },
      }),
    (error: unknown) =>
      error instanceof AndreaniError && error.code === "PRODUCTION_BLOCKED",
  )
  assert.equal(creationCalls, 0)
  assert.equal(admin.claimCalls.length, 0)
  assert.equal(admin.tables.ordenes.andreani_creation_status ?? null, null)
})

test("NODE_ENV=development con ANDREANI_ALLOW_PROD_SHIPMENT_CREATION_IN_DEV llega a las validaciones normales sin llamar a Andreani", async () => {
  const admin = createFakeAdmin(singleItemTables())
  let creationCalls = 0

  const result = await createAndreaniShipmentForOrder(admin as never, 42, {
    env: prodShipmentEnv({
      NODE_ENV: "development",
      ANDREANI_ALLOW_PROD_SHIPMENT_CREATION_IN_DEV: "true",
    }),
    // No se llega a la red real: este mock reemplaza crearOrdenEnvio y
    // confirma que el runtime ya no bloquea antes de llegar acá.
    crearOrdenEnvio: async () => {
      creationCalls += 1
      return officialOrderResponse
    },
  })

  assert.equal(result.status, "created")
  assert.equal(creationCalls, 1)
  assert.equal(admin.tables.ordenes.andreani_creation_environment, "PROD")
})

test("NODE_ENV=development sin ANDREANI_ALLOW_PROD_SHIPMENT_CREATION_IN_DEV sigue bloqueado antes de reclamar", async () => {
  const admin = createFakeAdmin(singleItemTables())
  let creationCalls = 0

  await assert.rejects(
    () =>
      createAndreaniShipmentForOrder(admin as never, 42, {
        env: prodShipmentEnv({ NODE_ENV: "development" }),
        crearOrdenEnvio: async () => {
          creationCalls += 1
          return officialOrderResponse
        },
      }),
    (error: unknown) =>
      error instanceof AndreaniError && error.code === "PRODUCTION_BLOCKED",
  )
  assert.equal(creationCalls, 0)
  assert.equal(admin.claimCalls.length, 0)
})

test("PROD autorizado usa cliente/contrato PROD y pide productionAccess shipment-creation", async () => {
  const admin = createFakeAdmin(singleItemTables())
  const capturedOptions: Array<{ env: NodeJS.ProcessEnv; productionAccess?: string }> = []
  const capturedInputs: AndreaniCreateShipmentInput[] = []

  const result = await createAndreaniShipmentForOrder(admin as never, 42, {
    env: prodShipmentEnv(),
    crearOrdenEnvio: async (input, options) => {
      capturedInputs.push(input)
      if (options) capturedOptions.push(options as never)
      return officialOrderResponse
    },
  })

  assert.equal(result.status, "created")
  assert.equal(capturedInputs[0]?.envio.contrato, "400042104")
  // El idgla de PROD (10179), nunca el código tarifario "RAC".
  assert.deepEqual(capturedInputs[0]?.envio.origen, { sucursal: { id: "10179" } })
  assert.equal(capturedOptions[0]?.env.ANDREANI_ENV, "PROD")
  assert.equal(capturedOptions[0]?.productionAccess, "shipment-creation")
  assert.equal(admin.tables.ordenes.andreani_creation_environment, "PROD")
})

test("PROD resuelve completo sin ANDREANI_QA_ORIGIN_BRANCH_ID, aislado de ANDREANI_ENV=qa", async () => {
  const admin = createFakeAdmin(singleItemTables())
  const capturedInputs: AndreaniCreateShipmentInput[] = []

  const result = await createAndreaniShipmentForOrder(admin as never, 42, {
    env: prodShipmentEnv({
      ANDREANI_ENV: "qa",
      ANDREANI_QA_ORIGIN_BRANCH_ID: undefined,
    }),
    crearOrdenEnvio: async (input) => {
      capturedInputs.push(input)
      return officialOrderResponse
    },
  })

  assert.equal(result.status, "created")
  assert.deepEqual(capturedInputs[0]?.envio.origen, { sucursal: { id: "10179" } })
  assert.equal(admin.tables.ordenes.andreani_creation_environment, "PROD")
})

test("un rechazo QA no bloquea un primer intento PROD legítimo (caso BX-1003)", async () => {
  const admin = createFakeAdmin(
    singleItemTables({
      andreani_creation_status: "rejected",
      andreani_creation_environment: "QA",
      andreani_creation_attempts: 1,
      andreani_error: "HTTP 400 · Numero de contrato 400042104 no existe.",
    } as Partial<AndreaniOrderRow>),
  )

  const result = await createAndreaniShipmentForOrder(admin as never, 42, {
    env: prodShipmentEnv(),
    crearOrdenEnvio: async () => officialOrderResponse,
  })

  assert.equal(result.status, "created")
  assert.equal(admin.tables.ordenes.andreani_creation_environment, "PROD")
})

test("un rechazo PROD no queda malinterpretado como intento QA (y viceversa)", async () => {
  const admin = createFakeAdmin(
    singleItemTables({
      andreani_creation_status: "rejected",
      andreani_creation_environment: "PROD",
      andreani_creation_attempts: 1,
    } as Partial<AndreaniOrderRow>),
  )

  const result = await createAndreaniShipmentForOrder(admin as never, 42, {
    env: qaEnv(),
    crearOrdenEnvio: async () => officialOrderResponse,
  })

  assert.equal(result.status, "created")
  assert.equal(admin.tables.ordenes.andreani_creation_environment, "QA")
})

test("dos intentos PROD concurrentes para la misma orden sólo permiten un claim", async () => {
  const admin = createFakeAdmin(singleItemTables())
  let creationCalls = 0
  let releaseCreation!: () => void
  let notifyStarted!: () => void
  const started = new Promise<void>((resolve) => {
    notifyStarted = resolve
  })
  const release = new Promise<void>((resolve) => {
    releaseCreation = resolve
  })

  const first = createAndreaniShipmentForOrder(admin as never, 42, {
    env: prodShipmentEnv(),
    crearOrdenEnvio: async () => {
      creationCalls += 1
      notifyStarted()
      await release
      return officialOrderResponse
    },
  })
  await started

  await assert.rejects(() =>
    createAndreaniShipmentForOrder(admin as never, 42, {
      env: prodShipmentEnv(),
      crearOrdenEnvio: async () => {
        creationCalls += 1
        return officialOrderResponse
      },
    }),
  )
  releaseCreation()
  const result = await first

  assert.equal(result.status, "created")
  assert.equal(creationCalls, 1)
})

test("un claim QA activo también bloquea un intento PROD concurrente", async () => {
  const admin = createFakeAdmin(
    singleItemTables({
      andreani_creation_status: "claimed",
      andreani_creation_environment: "QA",
      andreani_creation_claimed_at: new Date().toISOString(),
      andreani_creation_claim_token: "qa-activo",
    } as Partial<AndreaniOrderRow>),
  )
  let creationCalls = 0

  await assert.rejects(() =>
    createAndreaniShipmentForOrder(admin as never, 42, {
      env: prodShipmentEnv(),
      crearOrdenEnvio: async () => {
        creationCalls += 1
        return officialOrderResponse
      },
    }),
  )

  assert.equal(creationCalls, 0)
  assert.equal(admin.tables.ordenes.andreani_creation_claim_token, "qa-activo")
})

test("un timeout PROD queda en reconciliation_required y no se reintenta automáticamente", async () => {
  const admin = createFakeAdmin(singleItemTables())
  const loggedErrors: AndreaniShipmentAttemptErrorContext[] = []

  await assert.rejects(
    () =>
      createAndreaniShipmentForOrder(admin as never, 42, {
        env: prodShipmentEnv(),
        crearOrdenEnvio: async () => {
          throw new AndreaniError("TIMEOUT", "Andreani no respondió a tiempo.", {
            retryable: true,
          })
        },
        logAttemptError: (context) => loggedErrors.push(context),
      }),
    (error: unknown) => error instanceof AndreaniError && error.code === "TIMEOUT",
  )

  assert.equal(admin.tables.ordenes.andreani_creation_status, "reconciliation_required")
  assert.equal(admin.tables.ordenes.andreani_creation_environment, "PROD")
  assert.equal(admin.tables.ordenes.andreani_envio_id, null)
  assert.equal(loggedErrors.length, 1)
  assert.deepEqual(
    {
      orderId: loggedErrors[0]?.orderId,
      attemptNumber: loggedErrors[0]?.attemptNumber,
      environment: loggedErrors[0]?.environment,
      cliente: loggedErrors[0]?.cliente,
      contrato: loggedErrors[0]?.contrato,
      sucursalOrigenCodigo: loggedErrors[0]?.sucursalOrigenCodigo,
      sucursalOrigenId: loggedErrors[0]?.sucursalOrigenId,
      endpoint: loggedErrors[0]?.endpoint,
      code: loggedErrors[0]?.code,
      status: loggedErrors[0]?.status,
      error: loggedErrors[0]?.error,
    },
    {
      orderId: 42,
      attemptNumber: 1,
      environment: "PROD",
      cliente: "0012011683",
      contrato: "400042104",
      sucursalOrigenCodigo: "RAC",
      sucursalOrigenId: "10179",
      endpoint: "POST /v2/ordenes-de-envio",
      code: "TIMEOUT",
      status: null,
      error: "Andreani no respondió a tiempo.",
    },
  )
  assert.match(loggedErrors[0]?.attemptId ?? "", /^[0-9a-f-]{36}$/)
})
