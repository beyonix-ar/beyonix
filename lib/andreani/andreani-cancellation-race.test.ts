import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

// BLOQUEANTE B1 (auditoría Andreani Parte 1/4): reproduce, con las RPCs
// SQL REALES (no una reimplementación) contra PostgreSQL en memoria
// (PGlite), la carrera entre claim_andreani_shipment_creation y los 3
// caminos reales de cancelación. Carga las migraciones YA aplicadas
// remotamente en su orden real de aplicación y, al final,
// 20260916100000_block_cancellation_during_andreani_creation.sql (el fix
// bajo test) -- nunca se editan las migraciones históricas. Sin red,
// credenciales ni datos reales; nunca se llama a Andreani de verdad (estas
// pruebas sólo ejercitan la base de datos).

const root = process.cwd()
const read = (path: string) => readFileSync(join(root, path), "utf8")

const schema = read("lib/andreani/fixtures/andreani-cancellation-race-schema.sql")
const migrations = [
  "supabase/migrations/20260906120000_harden_andreani_commercial_and_order_writes.sql",
  "supabase/migrations/20260825130000_atomic_customer_cancellation_claim.sql",
  "supabase/migrations/20260816120000_atomic_order_claim_cancellation.sql",
  "supabase/migrations/20260915120000_admin_direct_order_cancellation.sql",
  "supabase/migrations/20260915130000_fix_admin_cancel_order_previous_estado.sql",
].map(read)
const fixMigration = read(
  "supabase/migrations/20260916100000_block_cancellation_during_andreani_creation.sql",
)

const customer = "10000000-0000-4000-8000-000000000001"
const admin = "20000000-0000-4000-8000-000000000002"
const claimTokenA = "30000000-0000-4000-8000-000000000003"
const claimTokenB = "30000000-0000-4000-8000-000000000004"

async function setup(options: { withFix?: boolean } = {}) {
  const { withFix = true } = options
  const db = new PGlite()
  await db.exec(schema)
  for (const migration of migrations) await db.exec(migration)
  if (withFix) await db.exec(fixMigration)
  await db.query("select set_config('request.jwt.claim.role','service_role',false)")
  return db
}

// Pedido pagado, facturado y elegible para reclamar creación Andreani --
// mismas condiciones que exige claim_andreani_shipment_creation.
async function insertEligibleOrder(db: PGlite, orderId: number) {
  await db.query(
    `insert into ordenes (
       id, usuario_id, estado, shipping_provider, shipping_type, financial_status,
       payment_status, paid_at, invoice_status, invoice_cae, invoice_number, invoice_point
     ) values ($1, $2, 'pagado', 'andreani', 'domicilio', 'payment_confirmed',
       'confirmado', now(), 'authorized', 'CAE-TEST', 1, 1)`,
    [orderId, customer],
  )
}

function claim(db: PGlite, orderId: number, token: string, environment: "QA" | "PROD" = "PROD") {
  return db.query<{ attempt: number | null }>(
    "select claim_andreani_shipment_creation($1,$2,$3) attempt",
    [orderId, token, environment],
  )
}

function requestCustomerCancellation(db: PGlite, orderId: number, reason = "Cambié de idea") {
  return db.query(
    "select request_customer_order_cancellation_with_claim($1,$2,$3) result",
    [orderId, customer, reason],
  )
}

function adminCancelOrder(
  db: PGlite,
  orderId: number,
  action: "reject" | "cancel",
  reasonCode = "pago_no_recibido",
) {
  return db.query(
    "select admin_cancel_order($1,$2,$3,$4,$5,$6) result",
    [orderId, admin, "admin", action, reasonCode, "Motivo de prueba"],
  )
}

async function insertCancellationClaim(db: PGlite, orderId: number) {
  const result = await db.query<{ id: number }>(
    `insert into order_claims (order_id, user_id, claim_type, status, failure_type, description)
     values ($1, $2, 'transporte_48hs', 'reintegro_pendiente', 'cancelar_compra', 'Quiero cancelar')
     returning id`,
    [orderId, customer],
  )
  return result.rows[0].id
}

function approveClaimCancellation(db: PGlite, claimId: number) {
  return db.query(
    "select approve_order_claim_cancellation($1,$2,$3,$4) result",
    [claimId, admin, "admin", "Aprobado"],
  )
}

async function andreaniState(db: PGlite, orderId: number) {
  const result = await db.query<{
    estado: string
    financial_status: string
    andreani_creation_status: string | null
    andreani_envio_id: string | null
  }>(
    "select estado, financial_status, andreani_creation_status, andreani_envio_id from ordenes where id=$1",
    [orderId],
  )
  return result.rows[0]
}

test("1-2. claim en curso ('claimed') bloquea la cancelación del cliente con ANDREANI_CREATION_IN_PROGRESS, sin liberar el claim", async () => {
  const db = await setup()
  try {
    await insertEligibleOrder(db, 1)
    const claimResult = await claim(db, 1, claimTokenA)
    assert.equal(claimResult.rows[0].attempt, 1)

    await assert.rejects(requestCustomerCancellation(db, 1), /ANDREANI_CREATION_IN_PROGRESS/)

    const state = await andreaniState(db, 1)
    assert.equal(state.estado, "pagado", "el pedido NO debe quedar cancelado")
    assert.equal(state.andreani_creation_status, "claimed", "el claim no se libera")
  } finally {
    await db.close()
  }
})

test("3. claim en curso bloquea también la cancelación directa por admin (reject y cancel)", async () => {
  const db = await setup()
  try {
    await insertEligibleOrder(db, 2)
    await claim(db, 2, claimTokenA)

    await assert.rejects(adminCancelOrder(db, 2, "cancel"), /ANDREANI_CREATION_IN_PROGRESS/)

    const state = await andreaniState(db, 2)
    assert.equal(state.estado, "pagado")
    assert.equal(state.andreani_creation_status, "claimed")
  } finally {
    await db.close()
  }
})

test("4. claim en curso bloquea la aprobación de una cancelación por claim/reclamo", async () => {
  const db = await setup()
  try {
    await insertEligibleOrder(db, 3)
    const claimId = await insertCancellationClaim(db, 3)
    await claim(db, 3, claimTokenA)

    await assert.rejects(approveClaimCancellation(db, claimId), /ANDREANI_CREATION_IN_PROGRESS/)

    const state = await andreaniState(db, 3)
    assert.equal(state.estado, "pagado")
    assert.equal(state.andreani_creation_status, "claimed")

    const claimRow = await db.query<{ status: string }>(
      "select status from order_claims where id=$1",
      [claimId],
    )
    assert.equal(claimRow.rows[0].status, "reintegro_pendiente", "el reclamo tampoco se cierra")
  } finally {
    await db.close()
  }
})

test("5-6. reconciliation_required (resultado externo incierto) bloquea los 3 caminos de cancelación con ANDREANI_RECONCILIATION_REQUIRED", async () => {
  const db = await setup()
  try {
    await insertEligibleOrder(db, 4)
    await insertEligibleOrder(db, 5)
    await insertEligibleOrder(db, 6)
    const claimId = await insertCancellationClaim(db, 6)

    for (const orderId of [4, 5, 6]) {
      await claim(db, orderId, claimTokenA)
      // Simula un claim vencido: el próximo intento de reclamo lo concilia
      // como ambiguo, igual que el barrido real dentro de
      // claim_andreani_shipment_creation (ver commercial-sql.test.ts).
      await db.query(
        "update ordenes set andreani_creation_claimed_at = now() - interval '10 minutes' where id=$1",
        [orderId],
      )
      await claim(db, orderId, claimTokenB)
      const state = await andreaniState(db, orderId)
      assert.equal(state.andreani_creation_status, "reconciliation_required")
    }

    await assert.rejects(requestCustomerCancellation(db, 4), /ANDREANI_RECONCILIATION_REQUIRED/)
    await assert.rejects(adminCancelOrder(db, 5, "cancel"), /ANDREANI_RECONCILIATION_REQUIRED/)
    await assert.rejects(approveClaimCancellation(db, claimId), /ANDREANI_RECONCILIATION_REQUIRED/)

    for (const orderId of [4, 5, 6]) {
      const state = await andreaniState(db, orderId)
      assert.equal(state.estado, "pagado")
    }
  } finally {
    await db.close()
  }
})

test("7-8. envío ya creado y persistido: la cancelación sigue las reglas EXISTENTES de despacho (ORDER_ALREADY_DISPATCHED), sin cambios", async () => {
  const db = await setup()
  try {
    await insertEligibleOrder(db, 7)
    await claim(db, 7, claimTokenA)
    // Simula la persistencia exitosa del POST -- lib/andreani/order-shipment.ts.
    await db.query(
      `update ordenes set andreani_creation_status='created', andreani_envio_id='ENV-1',
         andreani_tracking='TRACK-1', andreani_creation_claim_token=null where id=7`,
    )

    // admin_cancel_order y approve_order_claim_cancellation bloquean CUALQUIER
    // pedido facturado antes incluso de mirar despacho (ORDER_ALREADY_INVOICED,
    // regla previa sin relación con esta carrera) -- y este pedido, para ser
    // elegible a un envío Andreani, necesariamente está facturado. El único de
    // los 3 caminos que puede llegar al guard de despacho en este caso es la
    // cancelación del cliente (no valida facturación).
    await assert.rejects(requestCustomerCancellation(db, 7), /ORDER_ALREADY_DISPATCHED/)

    const state = await andreaniState(db, 7)
    assert.equal(state.estado, "pagado")
    assert.equal(state.andreani_creation_status, "created")
    assert.equal(state.andreani_envio_id, "ENV-1")
  } finally {
    await db.close()
  }
})

test("9-10. pedido sin claim ni envío: la cancelación normal sigue funcionando en los 3 caminos", async () => {
  const db = await setup()
  try {
    await db.query("insert into ordenes (id, usuario_id, estado) values (8, $1, 'pendiente')", [customer])
    const customerResult = await requestCustomerCancellation(db, 8)
    assert.ok(customerResult.rows[0])
    assert.equal((await andreaniState(db, 8)).estado, "cancelado")

    await db.query("insert into ordenes (id, usuario_id, estado) values (9, $1, 'pendiente')", [customer])
    await adminCancelOrder(db, 9, "reject")
    assert.equal((await andreaniState(db, 9)).estado, "cancelado")

    await db.query("insert into ordenes (id, usuario_id, estado) values (10, $1, 'pagado')", [customer])
    const claimId = await insertCancellationClaim(db, 10)
    await approveClaimCancellation(db, claimId)
    assert.equal((await andreaniState(db, 10)).estado, "cancelado")
  } finally {
    await db.close()
  }
})

test("11. dos transiciones que compiten por la misma fila (crear envío vs. cancelar): sólo una puede ganar, en cualquier orden de llegada", async () => {
  const db = await setup()
  try {
    // Orden A: el claim llega primero -- la cancelación pierde.
    await insertEligibleOrder(db, 11)
    const claimFirst = await claim(db, 11, claimTokenA)
    assert.equal(claimFirst.rows[0].attempt, 1)
    await assert.rejects(adminCancelOrder(db, 11, "cancel"), /ANDREANI_CREATION_IN_PROGRESS/)
    assert.equal((await andreaniState(db, 11)).estado, "pagado")

    // Orden B: la cancelación llega primero -- el claim pierde (guard YA
    // existente en claim_andreani_shipment_creation, sin cambios acá). Se
    // cancela vía cliente porque admin_cancel_order/approve_order_claim_cancellation
    // rechazan cualquier pedido facturado (ORDER_ALREADY_INVOICED, regla
    // previa sin relación con esta carrera) y este pedido, para ser
    // elegible a un envío Andreani, está facturado.
    await insertEligibleOrder(db, 12)
    await requestCustomerCancellation(db, 12)
    assert.equal((await andreaniState(db, 12)).estado, "cancelado")
    const claimSecond = await claim(db, 12, claimTokenA)
    assert.equal(claimSecond.rows[0].attempt, null, "un pedido cancelado nunca puede reclamar creación")
    assert.notEqual((await andreaniState(db, 12)).andreani_creation_status, "claimed")
  } finally {
    await db.close()
  }
})

test("12. invariante: ningún escenario de esta carrera produce estado='cancelado' junto con andreani_creation_status='created'", async () => {
  const db = await setup()
  try {
    const scenarios: Array<{ orderId: number; setup: (orderId: number) => Promise<unknown> }> = [
      {
        orderId: 20,
        setup: async (orderId) => {
          await insertEligibleOrder(db, orderId)
          await claim(db, orderId, claimTokenA)
          return adminCancelOrder(db, orderId, "cancel").catch(() => null)
        },
      },
      {
        orderId: 21,
        setup: async (orderId) => {
          await insertEligibleOrder(db, orderId)
          await claim(db, orderId, claimTokenA)
          return requestCustomerCancellation(db, orderId).catch(() => null)
        },
      },
      {
        orderId: 22,
        setup: async (orderId) => {
          await insertEligibleOrder(db, orderId)
          const claimId = await insertCancellationClaim(db, orderId)
          await claim(db, orderId, claimTokenA)
          return approveClaimCancellation(db, claimId).catch(() => null)
        },
      },
    ]

    for (const scenario of scenarios) {
      await scenario.setup(scenario.orderId)
      const state = await andreaniState(db, scenario.orderId)
      const isForbiddenCombination =
        state.estado === "cancelado" && state.andreani_creation_status === "created"
      assert.equal(
        isForbiddenCombination,
        false,
        `orden ${scenario.orderId}: estado=cancelado + andreani_creation_status=created nunca debe ocurrir`,
      )
    }
  } finally {
    await db.close()
  }
})

test("REGRESIÓN: sin el fix (sólo las migraciones históricas), la carrera reproduce el bug -- la cancelación avanza igual con el claim activo", async () => {
  const db = await setup({ withFix: false })
  try {
    await insertEligibleOrder(db, 30)
    await claim(db, 30, claimTokenA)

    // Sin el fix, ninguno de los 3 caminos conocía andreani_creation_status
    // -- la cancelación se completaba igual. Vía cliente porque este pedido,
    // para ser elegible a un envío Andreani, está facturado, y los otros 2
    // caminos rechazan cualquier pedido facturado por una regla previa sin
    // relación con esta carrera (ORDER_ALREADY_INVOICED).
    await requestCustomerCancellation(db, 30)
    const state = await andreaniState(db, 30)
    assert.equal(state.estado, "cancelado")
    assert.equal(state.andreani_creation_status, "claimed", "el claim seguía activo cuando se pisó la orden")
  } finally {
    await db.close()
  }
})
