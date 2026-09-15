import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

// Tests contra PostgreSQL real (PGlite), no mocks: exactamente las tres
// migraciones apiladas (schema + 20260913120000 + 20260914090000 +
// 20260914100000), corriendo sobre un esquema aislado
// (lib/orders/fixtures/transfer-verification-schema.sql). Mismo patrón que
// lib/orders/claim-atomic.test.ts.
//
// LIMITACIÓN DOCUMENTADA (pedida explícitamente en la tercera auditoría):
// PGlite es un motor Postgres embebido de UN solo proceso WASM -- no expone
// múltiples conexiones/backends independientes como un servidor Postgres
// real. Las carreras de "dos requests simultáneas" de este archivo (ej.:
// Promise.allSettled con dos db.query() sobre el MISMO `db`) prueban
// correctamente la ATOMICIDAD SQL (unique constraints, FOR UPDATE,
// serialización de la transacción que gana vs. la que ve el estado ya
// resuelto), pero NO ejercen el escenario de dos backends de Postgres
// reales bloqueándose entre sí por un lock de fila mientras uno espera a que
// el otro haga COMMIT/ROLLBACK. Se verificó en este entorno: no hay Docker,
// no hay un servidor Postgres local, y el proyecto no tiene el driver `pg`
// como dependencia -- no existe infraestructura razonable para levantar dos
// conexiones reales sin agregar dependencias nuevas ni tocar producción, así
// que esa prueba específica NO se agregó (en vez de simularla de forma
// engañosa). Los tests de abajo siguen siendo la mejor cobertura disponible
// en este entorno para los tres escenarios pedidos (dos órdenes reclamando
// el mismo payment.id, lease A/B sobre la misma orden, intento viejo
// escribiendo después del nuevo).

const schema = readFileSync(
  new URL("./fixtures/transfer-verification-schema.sql", import.meta.url),
  "utf8",
)
const migration = readFileSync(
  new URL(
    "../../supabase/migrations/20260913120000_transfer_auto_verification.sql",
    import.meta.url,
  ),
  "utf8",
)
// Revisión posterior (no aplicada aún remotamente al momento de este
// commit): revalida monto bajo lock y reclama transfer_matched_payment_id
// de forma atómica ante conflicto de stock. Se aplica DESPUÉS de la
// migración original, igual que en el proyecto real (CREATE OR REPLACE
// sobre una función ya aplicada, nunca reescribe la migración anterior).
const amountLockMigration = readFileSync(
  new URL(
    "../../supabase/migrations/20260914090000_transfer_auto_verification_amount_lock_and_stock_claim.sql",
    import.meta.url,
  ),
  "utf8",
)
// Segunda auditoría (cda0d38..dcd4fb0): lease id por intento (fencing token)
// + claim histórico insert-only de payment.id, independiente del valor
// actual de ordenes.transfer_matched_payment_id. Aplicada DESPUÉS de las dos
// anteriores, igual que en el proyecto real.
const leaseAndClaimsMigration = readFileSync(
  new URL(
    "../../supabase/migrations/20260914100000_transfer_verification_lease_and_payment_claims.sql",
    import.meta.url,
  ),
  "utf8",
)

const PAYMENT_ID = "177895301225"

async function setup() {
  const db = new PGlite()
  await db.exec(schema)
  await db.exec(migration)
  await db.exec(amountLockMigration)
  await db.exec(leaseAndClaimsMigration)
  // Config leída por auth.role() dentro de las funciones (chequeo interno,
  // independiente del rol real de Postgres usado para el ACL de EXECUTE).
  await db.query("select set_config('request.jwt.claim.role','service_role',false)")
  return db
}

/** Reclama un intento y devuelve el lease id generado, para poder pasarlo a CONFIRM_SQL. */
async function claimLease(db: PGlite, orderId: number): Promise<string> {
  const result = await db.query<{ transfer_verification_lease_id: string }>(
    "select transfer_verification_lease_id from claim_transfer_verification_attempt($1)",
    [orderId],
  )
  return result.rows[0].transfer_verification_lease_id
}

async function insertOrder(
  db: PGlite,
  id: number,
  overrides: Record<string, unknown> = {},
) {
  const row = {
    estado: "pendiente",
    payment_method_id: "transferencia",
    payment_status: "pendiente_comprobante",
    total: 900,
    external_amount_due: 900,
    ...overrides,
  }
  await db.query(
    `insert into ordenes(id, estado, payment_method_id, payment_status, total, external_amount_due)
     values ($1,$2,$3,$4,$5,$6)`,
    [id, row.estado, row.payment_method_id, row.payment_status, row.total, row.external_amount_due],
  )
}

// leaseId=null por defecto: la mayoría de estos tests nunca reclama un
// intento antes de confirmar, así que la fila queda con
// transfer_verification_lease_id NULL -- "null IS NOT DISTINCT FROM null" es
// true en Postgres (no son distintos), así que el chequeo de lease pasa
// igual sin necesidad de reclamar primero. Los tests que sí ejercitan el
// lease (fencing token) pasan explícitamente el id devuelto por claim.
function confirmArgs(orderId: number, paymentId = PAYMENT_ID, leaseId: string | null = null) {
  return [
    orderId,
    paymentId,
    "money_transfer",
    "account_money",
    900,
    "CUIL",
    "20301112220",
    "30111222",
    null,
    "2026-09-13T18:17:43.000-04:00",
    "2026-09-13T18:17:43.000-04:00",
    leaseId,
  ]
}

const CONFIRM_SQL =
  "select confirm_transfer_auto_verification($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)"

test("SQL: dos requests simultáneas para LA MISMA orden y el MISMO payment.id -- sólo una confirma, la otra ve ALREADY_RESOLVED", async () => {
  const db = await setup()
  try {
    await insertOrder(db, 1)
    const leaseId = await claimLease(db, 1)
    const results = await Promise.allSettled([
      db.query(CONFIRM_SQL, confirmArgs(1, PAYMENT_ID, leaseId)),
      db.query(CONFIRM_SQL, confirmArgs(1, PAYMENT_ID, leaseId)),
    ])

    const fulfilled = results.filter((r) => r.status === "fulfilled")
    const rejected = results.filter((r) => r.status === "rejected")
    assert.equal(fulfilled.length, 1, "sólo una de las dos debe confirmar")
    assert.equal(rejected.length, 1)
    assert.match(
      (rejected[0] as PromiseRejectedResult).reason.message,
      /ALREADY_RESOLVED/,
    )

    const order = (
      await db.query<{ payment_status: string; transfer_matched_payment_id: string }>(
        "select payment_status, transfer_matched_payment_id from ordenes where id=1",
      )
    ).rows[0]
    assert.equal(order.payment_status, "confirmado")
    assert.equal(order.transfer_matched_payment_id, PAYMENT_ID)

    // Nunca se auditó dos veces el mismo pago.
    const auditCount = (
      await db.query<{ count: number }>(
        "select count(*)::integer as count from order_audit_events where order_id=1 and action='transfer_auto_verified'",
      )
    ).rows[0].count
    assert.equal(auditCount, 1)
  } finally {
    await db.close()
  }
})

test("SQL: dos ÓRDENES DISTINTAS compitiendo por el MISMO payment.id -- sólo una lo acredita, nunca las dos", async () => {
  const db = await setup()
  try {
    await insertOrder(db, 1)
    await insertOrder(db, 2)
    const lease1 = await claimLease(db, 1)
    const lease2 = await claimLease(db, 2)

    const results = await Promise.allSettled([
      db.query(CONFIRM_SQL, confirmArgs(1, PAYMENT_ID, lease1)),
      db.query(CONFIRM_SQL, confirmArgs(2, PAYMENT_ID, lease2)),
    ])

    const fulfilled = results.filter((r) => r.status === "fulfilled")
    const rejected = results.filter((r) => r.status === "rejected")
    assert.equal(fulfilled.length, 1, "un mismo payment.id nunca puede acreditar dos pedidos")
    assert.equal(rejected.length, 1)
    assert.match(
      (rejected[0] as PromiseRejectedResult).reason.message,
      /TRANSFER_PAYMENT_ID_ALREADY_USED/,
    )

    const confirmedCount = (
      await db.query<{ count: number }>(
        "select count(*)::integer as count from ordenes where payment_status='confirmado' and transfer_matched_payment_id=$1",
        [PAYMENT_ID],
      )
    ).rows[0].count
    assert.equal(confirmedCount, 1)
  } finally {
    await db.close()
  }
})

test("SQL: el cron reintentando una orden ya confirmada entre lecturas nunca la vuelve a acreditar ni a auditar", async () => {
  const db = await setup()
  try {
    await insertOrder(db, 1)
    const leaseId = await claimLease(db, 1)
    await db.query(CONFIRM_SQL, confirmArgs(1, PAYMENT_ID, leaseId))

    await assert.rejects(
      db.query(CONFIRM_SQL, confirmArgs(1, PAYMENT_ID, leaseId)),
      /ALREADY_RESOLVED/,
    )

    const amount = (
      await db.query<{ payment_confirmed_amount: string }>(
        "select payment_confirmed_amount from ordenes where id=1",
      )
    ).rows[0].payment_confirmed_amount
    assert.equal(Number(amount), 900)
    const auditCount = (
      await db.query<{ count: number }>(
        "select count(*)::integer as count from order_audit_events where order_id=1",
      )
    ).rows[0].count
    assert.equal(auditCount, 1)
  } finally {
    await db.close()
  }
})

test("SQL: claim_transfer_verification_attempt respeta el tope de intentos", async () => {
  const db = await setup()
  try {
    await insertOrder(db, 1)
    for (let i = 0; i < 3; i += 1) {
      await db.query(
        "select claim_transfer_verification_attempt($1,$2,0,0)",
        [1, 3],
      )
    }
    await assert.rejects(
      db.query("select claim_transfer_verification_attempt($1,$2,0,0)", [1, 3]),
      /MAX_ATTEMPTS_EXCEEDED/,
    )
  } finally {
    await db.close()
  }
})

test("SQL: claim_transfer_verification_attempt aplica rate limit por intervalo mínimo", async () => {
  const db = await setup()
  try {
    await insertOrder(db, 1)
    // p_stale_checking_seconds=0: el lease de "checking" ya se considera vencido
    // de inmediato, así que el segundo intento no cae en ALREADY_CHECKING sino
    // en el chequeo de intervalo mínimo (p_min_interval_seconds=60) que sí
    // queremos aislar acá.
    await db.query("select claim_transfer_verification_attempt($1,20,60,0)", [1])
    await assert.rejects(
      db.query("select claim_transfer_verification_attempt($1,20,60,0)", [1]),
      /RATE_LIMITED/,
    )
  } finally {
    await db.close()
  }
})

test("SQL: claim_transfer_verification_attempt nunca reclama un pedido ya confirmado/rechazado", async () => {
  const db = await setup()
  try {
    await insertOrder(db, 1, { payment_status: "confirmado" })
    await assert.rejects(
      db.query("select claim_transfer_verification_attempt($1)", [1]),
      /ALREADY_RESOLVED/,
    )
  } finally {
    await db.close()
  }
})

test("SQL: ninguna de las dos RPC es ejecutable por anon", async () => {
  const db = await setup()
  try {
    await insertOrder(db, 1)
    await db.exec("set role anon")
    await assert.rejects(
      db.query("select claim_transfer_verification_attempt($1)", [1]),
      /permission denied/,
    )
    await assert.rejects(
      db.query(CONFIRM_SQL, confirmArgs(1)),
      /permission denied/,
    )
  } finally {
    await db.close()
  }
})

test("SQL: ninguna de las dos RPC es ejecutable por authenticated", async () => {
  const db = await setup()
  try {
    await insertOrder(db, 1)
    await db.exec("set role authenticated")
    await assert.rejects(
      db.query("select claim_transfer_verification_attempt($1)", [1]),
      /permission denied/,
    )
    await assert.rejects(
      db.query(CONFIRM_SQL, confirmArgs(1)),
      /permission denied/,
    )
  } finally {
    await db.close()
  }
})

test("SQL: service_role puede ejecutar ambas RPC de punta a punta", async () => {
  const db = await setup()
  try {
    await insertOrder(db, 1)
    const leaseId = await claimLease(db, 1)
    const confirmed = await db.query(CONFIRM_SQL, confirmArgs(1, PAYMENT_ID, leaseId))
    assert.equal(confirmed.rows.length, 1)
  } finally {
    await db.close()
  }
})

test("SQL: una orden cancelada nunca puede reclamarse ni confirmarse automáticamente", async () => {
  const db = await setup()
  try {
    await insertOrder(db, 1, { estado: "cancelado" })
    await assert.rejects(
      db.query("select claim_transfer_verification_attempt($1)", [1]),
      /ORDER_CANCELLED/,
    )
    await assert.rejects(db.query(CONFIRM_SQL, confirmArgs(1)), /ORDER_CANCELLED/)
  } finally {
    await db.close()
  }
})

test("SQL: un pedido que no es de transferencia nunca puede reclamarse ni confirmarse por este camino", async () => {
  const db = await setup()
  try {
    await insertOrder(db, 1, { payment_method_id: "mercadopago" })
    await assert.rejects(
      db.query("select claim_transfer_verification_attempt($1)", [1]),
      /NOT_TRANSFER_ORDER/,
    )
    await assert.rejects(db.query(CONFIRM_SQL, confirmArgs(1)), /NOT_TRANSFER_ORDER/)
  } finally {
    await db.close()
  }
})

test("SQL: confirm_transfer_auto_verification reutiliza exactamente el mismo esquema de campos que la confirmación manual (no duplica lógica financiera propia)", async () => {
  const db = await setup()
  try {
    await insertOrder(db, 1)
    const leaseId = await claimLease(db, 1)
    await db.query(CONFIRM_SQL, confirmArgs(1, PAYMENT_ID, leaseId))
    const order = (
      await db.query<Record<string, unknown>>("select * from ordenes where id=1")
    ).rows[0]

    assert.equal(order.payment_status, "confirmado")
    assert.equal(order.estado, "pagado")
    assert.equal(order.financial_status, "payment_confirmed")
    assert.equal(order.payment_confirmed_by, null)
    assert.ok(order.payment_confirmed_at)
    assert.equal(Number(order.payment_confirmed_amount), 900)
    assert.equal(order.order_change_status, "change_approved")
    assert.equal(Number(order.order_change_extra_amount), 0)
    assert.equal(order.transfer_verification_status, "auto_verified")
  } finally {
    await db.close()
  }
})

test("SQL: revalida el monto esperado vigente BAJO LOCK -- si el monto del pedido cambia antes de confirmar, rechaza (AMOUNT_MISMATCH), nunca confía en el monto leído antes del lock", async () => {
  const db = await setup()
  try {
    // Escenario pedido por Codex: la orden inicia en 900 (lo que el caller
    // leyó antes de consultar Mercado Pago), pero para cuando esta RPC toma
    // el lock, el monto vigente ya cambió a 1 (ejemplo: admin corrigió el
    // precio). La transferencia matcheada sigue siendo de 900 -- la RPC debe
    // rechazar, nunca confirmar contra un monto que dejó de ser el vigente.
    await insertOrder(db, 1, { total: 900, external_amount_due: 900 })
    const leaseId = await claimLease(db, 1)
    await db.query("update ordenes set total = 1, external_amount_due = 1 where id = 1")

    await assert.rejects(db.query(CONFIRM_SQL, confirmArgs(1, PAYMENT_ID, leaseId)), /AMOUNT_MISMATCH/)

    const order = (
      await db.query<{ payment_status: string; transfer_matched_payment_id: string | null }>(
        "select payment_status, transfer_matched_payment_id from ordenes where id=1",
      )
    ).rows[0]
    assert.equal(order.payment_status, "pendiente_comprobante")
    assert.equal(order.transfer_matched_payment_id, null)
  } finally {
    await db.close()
  }
})

test("SQL: revalida también contra el monto declarado por el cliente bajo lock (no sólo contra total/external_amount_due)", async () => {
  const db = await setup()
  try {
    await insertOrder(db, 1)
    const leaseId = await claimLease(db, 1)
    await db.query("update ordenes set transfer_amount_declared = 850 where id = 1")

    await assert.rejects(db.query(CONFIRM_SQL, confirmArgs(1, PAYMENT_ID, leaseId)), /AMOUNT_MISMATCH/)
  } finally {
    await db.close()
  }
})

test("SQL: si el guardián de inventario rechaza la confirmación por falta de stock, igual reclama transfer_matched_payment_id de forma atómica bajo el mismo lock (nunca queda sin reservar)", async () => {
  const db = await setup()
  try {
    await insertOrder(db, 1)
    const leaseId = await claimLease(db, 1)
    await db.query("select set_config('test.simulate_stock_conflict','1',false)")

    const result = await db.query(CONFIRM_SQL, confirmArgs(1, PAYMENT_ID, leaseId))
    assert.equal(result.rows.length, 1, "no debe lanzar excepción: devuelve la orden con el conflicto ya registrado")

    const order = (
      await db.query<{
        payment_status: string
        estado: string
        transfer_matched_payment_id: string
        transfer_verification_status: string
        transfer_verification_failure_reason: string
      }>(
        "select payment_status, estado, transfer_matched_payment_id, transfer_verification_status, transfer_verification_failure_reason from ordenes where id=1",
      )
    ).rows[0]

    assert.equal(order.payment_status, "auto_verified_stock_conflict")
    assert.equal(order.estado, "pendiente", "nunca marca pagado: el guardián de inventario lo rechazó")
    assert.equal(order.transfer_matched_payment_id, PAYMENT_ID)
    assert.equal(order.transfer_verification_status, "manual_review")
    assert.equal(order.transfer_verification_failure_reason, "stock_conflict")

    const auditCount = (
      await db.query<{ count: number }>(
        "select count(*)::integer as count from order_audit_events where order_id=1 and action='transfer_auto_verification_stock_conflict'",
      )
    ).rows[0].count
    assert.equal(auditCount, 1)
  } finally {
    await db.close()
  }
})

test("SQL: lease/fencing token -- un intento viejo (reemplazado por uno nuevo) nunca puede confirmar; el intento vigente sí puede", async () => {
  const db = await setup()
  try {
    await insertOrder(db, 1)

    // Intento A reclama el pedido.
    const leaseA = await claimLease(db, 1)

    // El intento A "se cuelga" (Mercado Pago tarda). Mientras tanto su lease
    // expira (p_stale_checking_seconds=0 simula esa expiración de inmediato)
    // y el intento B reclama el MISMO pedido, generando un lease nuevo.
    const claimB = await db.query<{ transfer_verification_lease_id: string }>(
      "select transfer_verification_lease_id from claim_transfer_verification_attempt($1,20,0,0)",
      [1],
    )
    const leaseB = claimB.rows[0].transfer_verification_lease_id
    assert.notEqual(leaseA, leaseB, "cada claim debe generar un lease distinto")

    // El intento A, ya viejo, termina de correr y trata de confirmar --
    // nunca puede lograrlo: su lease ya no es el vigente (LEASE_MISMATCH:
    // status sigue "checking" y ambos leases son no-nulos, pero no coinciden).
    await assert.rejects(
      db.query(CONFIRM_SQL, confirmArgs(1, PAYMENT_ID, leaseA)),
      /LEASE_MISMATCH/,
    )

    // El intento B, vigente, sí puede confirmar sin problema.
    const confirmed = await db.query(CONFIRM_SQL, confirmArgs(1, PAYMENT_ID, leaseB))
    assert.equal(confirmed.rows.length, 1)

    const order = (
      await db.query<{ payment_status: string; transfer_matched_payment_id: string }>(
        "select payment_status, transfer_matched_payment_id from ordenes where id=1",
      )
    ).rows[0]
    assert.equal(order.payment_status, "confirmado")
    assert.equal(order.transfer_matched_payment_id, PAYMENT_ID)
  } finally {
    await db.close()
  }
})

// Tercera auditoría: la validación de lease de la primera versión sólo
// comparaba "IS DISTINCT FROM", que en Postgres deja pasar NULL=NULL. Los
// siguientes 5 tests reproducen exactamente los escenarios pedidos por
// Codex, cada uno aislando UNA sola condición de las cinco exigidas.

test("SQL: p_lease_id NULL -- rechazo (LEASE_MISSING), aunque el pedido tenga un lease vigente real", async () => {
  const db = await setup()
  try {
    await insertOrder(db, 1)
    await claimLease(db, 1) // deja transfer_verification_status='checking' con un lease real no-nulo.

    await assert.rejects(
      db.query(CONFIRM_SQL, confirmArgs(1, PAYMENT_ID, null)),
      /LEASE_MISSING/,
    )

    const order = (
      await db.query<{ payment_status: string }>("select payment_status from ordenes where id=1")
    ).rows[0]
    assert.equal(order.payment_status, "pendiente_comprobante", "no debe haber confirmado nada")
  } finally {
    await db.close()
  }
})

test("SQL: nunca se ejecutó claim_transfer_verification_attempt -- rechazo (INVALID_VERIFICATION_STATE), incluso con un lease inventado no-nulo", async () => {
  const db = await setup()
  try {
    await insertOrder(db, 1) // nunca se llama a claim: transfer_verification_status queda en su default ('pending'), lease NULL.

    await assert.rejects(
      db.query(CONFIRM_SQL, confirmArgs(1, PAYMENT_ID, "00000000-0000-0000-0000-000000000000")),
      /INVALID_VERIFICATION_STATE/,
    )

    const order = (
      await db.query<{ payment_status: string }>("select payment_status from ordenes where id=1")
    ).rows[0]
    assert.equal(order.payment_status, "pendiente_comprobante")
  } finally {
    await db.close()
  }
})

test("SQL: lease de hace más de 60s (ventana fija hardcodeada en la función) -- rechazo (LEASE_EXPIRED), aunque coincida exactamente", async () => {
  const db = await setup()
  try {
    await insertOrder(db, 1)
    const leaseId = await claimLease(db, 1)
    // Simula que el claim ocurrió hace más de 60s sin que nada más haya
    // cambiado el lease. La vigencia ya no es un parámetro -- está fija en
    // el cuerpo de la función (interval '60 seconds').
    await db.query(
      "update ordenes set transfer_last_verification_at = now() - interval '61 seconds' where id = 1",
    )

    await assert.rejects(
      db.query(CONFIRM_SQL, confirmArgs(1, PAYMENT_ID, leaseId)),
      /LEASE_EXPIRED/,
    )

    const order = (
      await db.query<{ payment_status: string }>("select payment_status from ordenes where id=1")
    ).rows[0]
    assert.equal(order.payment_status, "pendiente_comprobante")
  } finally {
    await db.close()
  }
})

test("SQL: lease de 5 minutos (300s) -- rechazo (LEASE_EXPIRED), muy por encima de la ventana fija de 60s", async () => {
  const db = await setup()
  try {
    await insertOrder(db, 1)
    const leaseId = await claimLease(db, 1)
    await db.query(
      "update ordenes set transfer_last_verification_at = now() - interval '5 minutes' where id = 1",
    )

    await assert.rejects(
      db.query(CONFIRM_SQL, confirmArgs(1, PAYMENT_ID, leaseId)),
      /LEASE_EXPIRED/,
    )

    const order = (
      await db.query<{ payment_status: string }>("select payment_status from ordenes where id=1")
    ).rows[0]
    assert.equal(order.payment_status, "pendiente_comprobante")
  } finally {
    await db.close()
  }
})

// Cuarta auditoría: p_lease_ttl_seconds se ELIMINÓ de la firma (no se dejó
// como parámetro "aceptado pero validado") -- la prueba más fuerte posible
// de que ya no se puede bypassear es que Postgres rechace de plano cualquier
// intento de pasar un valor extra: no existe overload de la función con 13
// argumentos.
test("SQL: ya no es posible pasar ninguna vigencia manipulable -- un intento de llamar con un argumento extra (el viejo p_lease_ttl_seconds) falla porque la función no tiene ese parámetro", async () => {
  const db = await setup()
  try {
    await insertOrder(db, 1)
    const leaseId = await claimLease(db, 1)

    await assert.rejects(
      db.query(
        "select confirm_transfer_auto_verification($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",
        [...confirmArgs(1, PAYMENT_ID, leaseId), 3600],
      ),
      /function (public\.)?confirm_transfer_auto_verification\([^)]*\) does not exist/i,
    )
  } finally {
    await db.close()
  }
})

test("SQL: transfer_verification_status ya no es 'checking' (ej.: manual_review) -- rechazo (INVALID_VERIFICATION_STATE), aunque el lease siga coincidiendo", async () => {
  const db = await setup()
  try {
    await insertOrder(db, 1)
    const leaseId = await claimLease(db, 1)
    // Simula una resolución manual/otro camino que dejó el pedido en
    // manual_review sin limpiar el lease (o cualquier fila que ya no está
    // "checking" pero conserva un lease residual).
    await db.query(
      "update ordenes set transfer_verification_status = 'manual_review' where id = 1",
    )

    await assert.rejects(
      db.query(CONFIRM_SQL, confirmArgs(1, PAYMENT_ID, leaseId)),
      /INVALID_VERIFICATION_STATE/,
    )

    const order = (
      await db.query<{ payment_status: string }>("select payment_status from ordenes where id=1")
    ).rows[0]
    assert.equal(order.payment_status, "pendiente_comprobante")
  } finally {
    await db.close()
  }
})

test("SQL: lease vigente + checking + dentro de la ventana -- las cinco condiciones se cumplen y la confirmación continúa normalmente", async () => {
  const db = await setup()
  try {
    await insertOrder(db, 1)
    const leaseId = await claimLease(db, 1)

    const confirmed = await db.query(CONFIRM_SQL, confirmArgs(1, PAYMENT_ID, leaseId))
    assert.equal(confirmed.rows.length, 1)

    const order = (
      await db.query<{ payment_status: string }>("select payment_status from ordenes where id=1")
    ).rows[0]
    assert.equal(order.payment_status, "confirmado")
  } finally {
    await db.close()
  }
})

// Quinta auditoría: now() devuelve el timestamp de INICIO de la
// transacción, congelado durante toda su ejecución -- incluida cualquier
// espera real que ocurra dentro de esa misma transacción. Estos dos tests
// reproducen esa divergencia real usando pg_sleep() DENTRO de una
// transacción explícita (BEGIN/COMMIT sobre la misma conexión): el lease se
// deja "envejecer" antes de abrir la transacción, y luego se duerme 2s
// segundos reales DENTRO de la transacción antes de invocar confirm -- la
// duración del sleep avanza clock_timestamp() pero NUNCA now() de esa
// transacción. Es la reproducción más fiel posible sin necesitar dos
// conexiones reales (ver limitación documentada en el encabezado del
// archivo): confirm_transfer_auto_verification corre en una única
// transacción de todos modos, así que lo que importa reproducir es
// exactamente esa divergencia entre now() y el tiempo real transcurrido
// DENTRO de esa transacción -- no hace falta un segundo backend para eso.
test("SQL: lease con 59s de antigüedad al ABRIR la transacción, pero la transacción tarda 2s más ANTES de confirmar (now() seguiría viendo 59s, clock_timestamp() ve ~61s reales) -- debe rechazar LEASE_EXPIRED, no confirmar, no reclamar el payment.id ni tocar estados financieros", async () => {
  const db = await setup()
  try {
    await insertOrder(db, 1)
    const leaseId = await claimLease(db, 1)

    // Deja el lease con ~59s de antigüedad justo antes de abrir la
    // transacción que va a confirmar.
    await db.query(
      "update ordenes set transfer_last_verification_at = now() - interval '59 seconds' where id = 1",
    )

    await db.query("begin")
    // 2 segundos REALES de espera DENTRO de la transacción -- now() de esta
    // transacción ya quedó fijado al abrir "begin" (~59s de antigüedad
    // todavía), pero clock_timestamp() sí va a reflejar estos 2s cuando se
    // evalúe más abajo: antigüedad real en ese momento ~61s, por encima de
    // los 60s de TTL.
    await db.query("select pg_sleep(2)")

    await assert.rejects(
      db.query(CONFIRM_SQL, confirmArgs(1, PAYMENT_ID, leaseId)),
      /LEASE_EXPIRED/,
    )
    await db.query("rollback")

    // No debe confirmar.
    const order = (
      await db.query<{
        payment_status: string
        estado: string
        financial_status: string
        transfer_matched_payment_id: string | null
        transfer_verification_status: string
      }>(
        "select payment_status, estado, financial_status, transfer_matched_payment_id, transfer_verification_status from ordenes where id=1",
      )
    ).rows[0]
    assert.equal(order.payment_status, "pendiente_comprobante", "no debe confirmar")
    assert.equal(order.estado, "pendiente", "no debe tocar estados financieros")
    assert.equal(order.financial_status, null, "no debe tocar estados financieros")
    assert.equal(order.transfer_matched_payment_id, null, "no debe reclamar el payment.id")
    assert.equal(order.transfer_verification_status, "checking", "el status de verificación no debe cambiar")

    // No debe reclamar el payment.id en la tabla de claims.
    const claim = await db.query<{ count: number }>(
      "select count(*)::integer as count from transfer_verification_payment_claims where payment_id = $1",
      [PAYMENT_ID],
    )
    assert.equal(claim.rows[0].count, 0, "no debe reclamar el payment.id")
  } finally {
    await db.close()
  }
})

test("SQL: lease reciente sigue confirmando correctamente aunque la transacción tarde un poco antes de confirmar (clock_timestamp() real, dentro de la ventana)", async () => {
  const db = await setup()
  try {
    await insertOrder(db, 1)
    const leaseId = await claimLease(db, 1)

    await db.query("begin")
    // Una demora real breve (muy por debajo de los 60s de TTL) no debe
    // afectar una confirmación legítima.
    await db.query("select pg_sleep(0.2)")

    const confirmed = await db.query(CONFIRM_SQL, confirmArgs(1, PAYMENT_ID, leaseId))
    assert.equal(confirmed.rows.length, 1)
    await db.query("commit")

    const order = (
      await db.query<{ payment_status: string }>("select payment_status from ordenes where id=1")
    ).rows[0]
    assert.equal(order.payment_status, "confirmado")
  } finally {
    await db.close()
  }
})

test("SQL: un payment.id reclamado por conflicto de stock, aunque la orden luego use OTRO payment.id, nunca queda libre para otro pedido (claim histórico, no depende del valor actual de la columna)", async () => {
  const db = await setup()
  const PAYMENT_A = "177895301225"
  const PAYMENT_B = "999888777666"
  try {
    await insertOrder(db, 1)
    await insertOrder(db, 2)

    // 1) La orden 1 reclama el payment A, pero el stock ya no alcanza.
    await db.query("select set_config('test.simulate_stock_conflict','1',false)")
    const leaseA1 = await claimLease(db, 1)
    await db.query(CONFIRM_SQL, confirmArgs(1, PAYMENT_A, leaseA1))

    let order1 = (
      await db.query<{ payment_status: string; transfer_matched_payment_id: string }>(
        "select payment_status, transfer_matched_payment_id from ordenes where id=1",
      )
    ).rows[0]
    assert.equal(order1.payment_status, "auto_verified_stock_conflict")
    assert.equal(order1.transfer_matched_payment_id, PAYMENT_A)

    // 2) Un admin rechaza (mismo update que hace el endpoint de administración
    // real: NUNCA toca transfer_matched_payment_id).
    await db.query("update ordenes set payment_status = 'rechazado' where id = 1")

    // 3) El cliente sube un comprobante nuevo (vuelve a en_revision) y esta
    // vez la orden termina confirmándose con un payment.id DISTINTO (B), sin
    // conflicto de stock.
    await db.query("update ordenes set payment_status = 'en_revision' where id = 1")
    await db.query("select set_config('test.simulate_stock_conflict','0',false)")
    // p_min_interval_seconds=0: el primer intento (el que reservó A) ya dejó
    // transfer_last_verification_at fijado hace instantes -- sin esto caería
    // en RATE_LIMITED, que no es lo que este test quiere ejercitar.
    const claimA2 = await db.query<{ transfer_verification_lease_id: string }>(
      "select transfer_verification_lease_id from claim_transfer_verification_attempt($1,20,0,0)",
      [1],
    )
    const leaseA2 = claimA2.rows[0].transfer_verification_lease_id
    await db.query(CONFIRM_SQL, confirmArgs(1, PAYMENT_B, leaseA2))

    order1 = (
      await db.query<{ payment_status: string; transfer_matched_payment_id: string }>(
        "select payment_status, transfer_matched_payment_id from ordenes where id=1",
      )
    ).rows[0]
    assert.equal(order1.payment_status, "confirmado")
    assert.equal(
      order1.transfer_matched_payment_id,
      PAYMENT_B,
      "la columna SÍ se sobrescribió a B -- por eso la protección real no puede depender de leerla",
    )

    // 4) La orden 2 intenta usar el payment A, ya "liberado" según la columna
    // de la orden 1 (que ahora apunta a B) -- debe fallar SIEMPRE, porque el
    // claim histórico de A sigue atado a la orden 1 para siempre.
    const leaseB = await claimLease(db, 2)
    await assert.rejects(
      db.query(CONFIRM_SQL, confirmArgs(2, PAYMENT_A, leaseB)),
      /TRANSFER_PAYMENT_ID_ALREADY_USED/,
    )

    const claimRow = (
      await db.query<{ order_id: number }>(
        "select order_id from transfer_verification_payment_claims where payment_id = $1",
        [PAYMENT_A],
      )
    ).rows[0]
    assert.equal(claimRow.order_id, 1, "el claim histórico de A sigue perteneciendo a la orden 1 para siempre")

    const order2 = (
      await db.query<{ payment_status: string }>(
        "select payment_status from ordenes where id=2",
      )
    ).rows[0]
    assert.equal(order2.payment_status, "pendiente_comprobante", "la orden 2 nunca se acreditó con el payment.id de otro pedido")
  } finally {
    await db.close()
  }
})

test("SQL: tras reclamar por conflicto de stock, ese mismo payment.id nunca puede acreditar otro pedido", async () => {
  const db = await setup()
  try {
    await insertOrder(db, 1)
    await insertOrder(db, 2)
    const lease1 = await claimLease(db, 1)
    await db.query("select set_config('test.simulate_stock_conflict','1',false)")
    await db.query(CONFIRM_SQL, confirmArgs(1, PAYMENT_ID, lease1))

    // El segundo pedido no tiene conflicto de stock simulado -- igual debe
    // rechazarse porque el payment.id ya quedó reclamado por el pedido 1.
    const lease2 = await claimLease(db, 2)
    await db.query("select set_config('test.simulate_stock_conflict','0',false)")
    await assert.rejects(db.query(CONFIRM_SQL, confirmArgs(2, PAYMENT_ID, lease2)), /TRANSFER_PAYMENT_ID_ALREADY_USED/)
  } finally {
    await db.close()
  }
})

// Tercera auditoría: bug de upgrade. Antes de 20260914100000 ya pueden
// existir órdenes con transfer_matched_payment_id reservado por
// 20260914090000 -- la tabla nueva de claims se crea VACÍA, así que sin
// backfill ese payment.id quedaría "libre" según la nueva fuente de verdad.
// Este test aplica las migraciones EN EL ORDEN REAL de un upgrade (no todas
// de una), reservando un payment.id con el esquema viejo ANTES de aplicar
// 20260914100000, para probar el backfill de punta a punta.
test("SQL upgrade: el backfill de 20260914100000 migra un payment.id ya reservado por el esquema anterior -- nunca queda libre para otra orden", async () => {
  const db = new PGlite()
  const PAYMENT_A = "177895301225"
  const PAYMENT_B = "999888777666"
  try {
    await db.exec(schema)
    await db.exec(migration)
    await db.exec(amountLockMigration) // hasta acá: exactamente lo que ya estaba aplicado remotamente.
    await db.query("select set_config('request.jwt.claim.role','service_role',false)")

    await insertOrder(db, 1)
    await insertOrder(db, 2)

    // Firma VIEJA (11 parámetros, sin lease -- la que expone 20260914090000)
    // reserva payment A para la orden 1, como en producción hoy.
    const oldConfirmSql =
      "select confirm_transfer_auto_verification($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)"
    await db.query(oldConfirmSql, [
      1, PAYMENT_A, "money_transfer", "account_money", 900,
      "CUIL", "20301112220", "30111222", null,
      "2026-09-13T18:17:43.000-04:00", "2026-09-13T18:17:43.000-04:00",
    ])

    const beforeUpgrade = (
      await db.query<{ payment_status: string; transfer_matched_payment_id: string }>(
        "select payment_status, transfer_matched_payment_id from ordenes where id=1",
      )
    ).rows[0]
    assert.equal(beforeUpgrade.payment_status, "confirmado")
    assert.equal(beforeUpgrade.transfer_matched_payment_id, PAYMENT_A)

    // Ahora se aplica la migración bajo prueba -- el mismo paso que
    // correría `supabase db push` en un upgrade real.
    await db.exec(leaseAndClaimsMigration)

    // 4) La tabla de claims debe contener el backfill: A -> order 1.
    const claim = (
      await db.query<{ order_id: number }>(
        "select order_id from transfer_verification_payment_claims where payment_id = $1",
        [PAYMENT_A],
      )
    ).rows[0]
    assert.ok(claim, "el backfill debe haber insertado el claim histórico de A")
    assert.equal(claim.order_id, 1)

    // 5) La orden 1 después usa un payment.id DISTINTO (B) -- sólo posible
    // tras un nuevo ciclo completo de claim + confirm (firma nueva, con
    // lease). Para reabrir la orden 1 a un nuevo intento hace falta que su
    // payment_status vuelva a ser elegible (simula rechazo + nuevo comprobante,
    // igual que el flujo real de administración).
    await db.query("update ordenes set payment_status = 'rechazado' where id = 1")
    await db.query("update ordenes set payment_status = 'en_revision' where id = 1")
    // p_min_interval_seconds=0: la primera confirmación (firma vieja) ya dejó
    // transfer_last_verification_at fijado hace instantes -- sin esto caería
    // en RATE_LIMITED, que no es lo que este test quiere ejercitar.
    const claim1 = await db.query<{ transfer_verification_lease_id: string }>(
      "select transfer_verification_lease_id from claim_transfer_verification_attempt($1,20,0,0)",
      [1],
    )
    const lease1 = claim1.rows[0].transfer_verification_lease_id
    await db.query(CONFIRM_SQL, confirmArgs(1, PAYMENT_B, lease1))

    const afterSecondConfirm = (
      await db.query<{ payment_status: string; transfer_matched_payment_id: string }>(
        "select payment_status, transfer_matched_payment_id from ordenes where id=1",
      )
    ).rows[0]
    assert.equal(afterSecondConfirm.payment_status, "confirmado")
    assert.equal(afterSecondConfirm.transfer_matched_payment_id, PAYMENT_B)

    // 6) La orden 2 intenta usar A -- el backfill tiene que seguir
    // protegiéndolo aunque la columna de la orden 1 ya apunte a B.
    const lease2 = await claimLease(db, 2)
    await assert.rejects(
      db.query(CONFIRM_SQL, confirmArgs(2, PAYMENT_A, lease2)),
      /TRANSFER_PAYMENT_ID_ALREADY_USED/,
    )

    const order2 = (
      await db.query<{ payment_status: string }>("select payment_status from ordenes where id=2")
    ).rows[0]
    assert.equal(order2.payment_status, "pendiente_comprobante", "la orden 2 nunca debe acreditarse con el payment.id de otra orden")
  } finally {
    await db.close()
  }
})

test("SQL upgrade: el backfill aborta la migración COMPLETA (no elige una orden en silencio) si detecta el mismo payment.id en más de una orden", async () => {
  const db = new PGlite()
  try {
    await db.exec(schema)
    await db.exec(migration)
    await db.exec(amountLockMigration)
    await db.query("select set_config('request.jwt.claim.role','service_role',false)")

    await insertOrder(db, 1)
    await insertOrder(db, 2)
    // Estado inconsistente fabricado a propósito: nunca debería poder
    // ocurrir con el índice único parcial ya aplicado (ordenes_transfer_matched_payment_id_key,
    // 20260913120000) -- por eso hay que tirarlo abajo explícitamente para
    // simular el escenario ("¿y si el índice no estuviera, o el dato viene
    // de un restore inconsistente?") que el backfill tiene que detectar solo,
    // sin depender de esa protección.
    await db.query("drop index if exists ordenes_transfer_matched_payment_id_key")
    await db.query(
      "update ordenes set transfer_matched_payment_id = $1, payment_status = 'confirmado' where id in (1,2)",
      [PAYMENT_ID],
    )

    await assert.rejects(
      db.exec(leaseAndClaimsMigration),
      /TRANSFER_PAYMENT_ID_HISTORICAL_CONFLICT/,
    )
    // La sesión queda con la transacción abortada tras el error -- hay que
    // cerrarla explícitamente antes de poder seguir consultando con el mismo
    // handle (mismo criterio que un cliente real de Postgres).
    await db.query("rollback")

    // La migración completa debe haber abortado: ni la tabla de claims con
    // datos, ni la columna nueva quedan aplicadas a medias (transacción
    // única "begin; ... commit;").
    const tableExists = await db.query<{ exists: boolean }>(
      `select exists (
         select 1 from information_schema.tables
         where table_schema = 'public' and table_name = 'transfer_verification_payment_claims'
       ) as exists`,
    )
    assert.equal(tableExists.rows[0].exists, false, "la migración entera debe haberse revertido, no sólo el backfill")
  } finally {
    await db.close()
  }
})
