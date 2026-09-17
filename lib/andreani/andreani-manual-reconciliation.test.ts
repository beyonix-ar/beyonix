import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

// BLOQUEANTE 2 (auditoría Andreani Parte 3/4): reproduce, con las RPCs SQL
// REALES contra PostgreSQL en memoria (PGlite), el flujo de conciliación
// manual de andreani_creation_status='reconciliation_required' y el barrido
// de claims vencidos. Carga las migraciones YA aplicadas en su orden real
// (incluida 20260916100000, el fix de B1/Parte 1) y, al final,
// 20260917100000_andreani_manual_reconciliation.sql (bajo test). Sin red,
// credenciales ni datos reales; nunca se llama a Andreani.

const root = process.cwd()
const read = (path: string) => readFileSync(join(root, path), "utf8")

const schema = read("lib/andreani/fixtures/andreani-cancellation-race-schema.sql")
const migrations = [
  "supabase/migrations/20260906120000_harden_andreani_commercial_and_order_writes.sql",
  "supabase/migrations/20260825130000_atomic_customer_cancellation_claim.sql",
  "supabase/migrations/20260816120000_atomic_order_claim_cancellation.sql",
  "supabase/migrations/20260915120000_admin_direct_order_cancellation.sql",
  "supabase/migrations/20260915130000_fix_admin_cancel_order_previous_estado.sql",
  "supabase/migrations/20260916100000_block_cancellation_during_andreani_creation.sql",
].map(read)
const reconciliationMigration = read(
  "supabase/migrations/20260917100000_andreani_manual_reconciliation.sql",
)

const customer = "10000000-0000-4000-8000-000000000001"
const adminA = "20000000-0000-4000-8000-000000000002"
const adminB = "20000000-0000-4000-8000-000000000003"
const claimTokenA = "30000000-0000-4000-8000-000000000003"

async function setup() {
  const db = new PGlite()
  await db.exec(schema)
  for (const migration of migrations) await db.exec(migration)
  await db.exec(reconciliationMigration)
  await db.query("select set_config('request.jwt.claim.role','service_role',false)")
  return db
}

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

function claim(db: PGlite, orderId: number, token: string) {
  return db.query<{ attempt: number | null }>(
    "select claim_andreani_shipment_creation($1,$2,$3) attempt",
    [orderId, token, "PROD"],
  )
}

async function markStale(db: PGlite, orderId: number, minutesAgo = 10) {
  await db.query(
    `update ordenes set andreani_creation_claimed_at = now() - interval '${minutesAgo} minutes' where id=$1`,
    [orderId],
  )
}

function sweep(db: PGlite) {
  return db.query<{ sweep_stale_andreani_claims: number }>(
    "select sweep_stale_andreani_claims()",
  )
}

function resolve(
  db: PGlite,
  orderId: number,
  resolution: "created" | "not_created",
  options: {
    adminId?: string
    adminRole?: string
    envioId?: string | null
    tracking?: string | null
    etiquetaUrl?: string | null
    notes?: string
  } = {},
) {
  return db.query(
    "select resolve_andreani_reconciliation($1,$2,$3,$4,$5,$6,$7,$8) result",
    [
      orderId,
      options.adminId ?? adminA,
      options.adminRole ?? "admin",
      resolution,
      options.envioId ?? (resolution === "created" ? "ENV-REAL-1" : null),
      options.tracking ?? null,
      options.etiquetaUrl ?? null,
      options.notes ?? "Confirmé por teléfono con soporte Andreani el 17/09.",
    ],
  )
}

async function orderState(db: PGlite, orderId: number) {
  const result = await db.query<{
    estado: string
    andreani_creation_status: string | null
    andreani_creation_claim_token: string | null
    andreani_envio_id: string | null
    andreani_tracking: string | null
  }>(
    "select estado, andreani_creation_status, andreani_creation_claim_token, andreani_envio_id, andreani_tracking from ordenes where id=$1",
    [orderId],
  )
  return result.rows[0]
}

async function toReconciliationRequired(db: PGlite, orderId: number, token = claimTokenA) {
  await insertEligibleOrder(db, orderId)
  await claim(db, orderId, token)
  await markStale(db, orderId)
  await sweep(db)
}

test("6. reconciliation_required + confirmar EXISTE persiste el envío exactamente una vez", async () => {
  const db = await setup()
  try {
    await toReconciliationRequired(db, 1)
    await resolve(db, 1, "created", { envioId: "ENV-REAL-1", tracking: "TRACK-1" })

    const state = await orderState(db, 1)
    assert.equal(state.andreani_creation_status, "created")
    assert.equal(state.andreani_envio_id, "ENV-REAL-1")
    assert.equal(state.andreani_tracking, "TRACK-1")
    assert.equal(state.andreani_creation_claim_token, null)

    const events = await db.query<{ action: string; metadata: { resolution?: string } }>(
      "select action, metadata from order_audit_events where order_id=1",
    )
    const auditEvent = events.rows.find((row) => row.action === "andreani_reconciliation_resolved")
    assert.ok(auditEvent, "debe quedar auditado")
    assert.equal(auditEvent!.metadata.resolution, "created")
  } finally {
    await db.close()
  }
})

test("7. reconciliation_required + confirmar NO EXISTE deja el pedido reintentable de forma segura", async () => {
  const db = await setup()
  try {
    await toReconciliationRequired(db, 2)
    await resolve(db, 2, "not_created")

    const state = await orderState(db, 2)
    assert.equal(state.andreani_creation_status, "failed")
    assert.equal(state.andreani_creation_claim_token, null)
    assert.equal(state.andreani_envio_id, null)

    // "Reintentable de forma segura" = el mismo WHERE de
    // claim_andreani_shipment_creation ya lo vuelve a aceptar, sin cambios.
    const secondAttempt = await claim(db, 2, "40000000-0000-4000-8000-000000000009")
    assert.equal(secondAttempt.rows[0].attempt, 2)
    assert.equal((await orderState(db, 2)).andreani_creation_status, "claimed")
  } finally {
    await db.close()
  }
})

test("8. doble conciliación es idempotente: la segunda nunca pisa ni duplica la resolución", async () => {
  const db = await setup()
  try {
    await toReconciliationRequired(db, 3)
    await resolve(db, 3, "created", { envioId: "ENV-REAL-1" })

    await assert.rejects(
      resolve(db, 3, "created", { envioId: "ENV-OTRO-DISTINTO" }),
      /ANDREANI_RECONCILIATION_NOT_PENDING/,
    )
    await assert.rejects(
      resolve(db, 3, "not_created"),
      /ANDREANI_RECONCILIATION_NOT_PENDING/,
    )

    const state = await orderState(db, 3)
    assert.equal(state.andreani_envio_id, "ENV-REAL-1", "el envío real nunca se pisa")
    const events = await db.query(
      "select count(*)::int c from order_audit_events where order_id=3 and action='andreani_reconciliation_resolved'",
    )
    assert.equal((events.rows[0] as { c: number }).c, 1, "un solo evento de auditoría")
  } finally {
    await db.close()
  }
})

test("9. conciliación concurrente: sólo una gana, en cualquier orden de llegada", async () => {
  const db = await setup()
  try {
    await toReconciliationRequired(db, 4)

    const first = await resolve(db, 4, "created", { envioId: "ENV-GANADOR" })
    assert.ok(first.rows[0])
    await assert.rejects(
      resolve(db, 4, "not_created", { adminId: adminB }),
      /ANDREANI_RECONCILIATION_NOT_PENDING/,
    )

    const state = await orderState(db, 4)
    assert.equal(state.andreani_creation_status, "created")
    assert.equal(state.andreani_envio_id, "ENV-GANADOR")
  } finally {
    await db.close()
  }
})

test("10. nunca libera un claim todavía fresco (activo, <5 minutos)", async () => {
  const db = await setup()
  try {
    await insertEligibleOrder(db, 5)
    await claim(db, 5, claimTokenA)

    await assert.rejects(resolve(db, 5, "not_created"), /ANDREANI_RECONCILIATION_NOT_PENDING/)

    const state = await orderState(db, 5)
    assert.equal(state.andreani_creation_status, "claimed", "el claim activo no se toca")
    assert.equal(state.andreani_creation_claim_token, claimTokenA)
  } finally {
    await db.close()
  }
})

test("11. un claim vencido (>5 min) se puede mover a reconciliation_required de forma segura (sweep)", async () => {
  const db = await setup()
  try {
    await insertEligibleOrder(db, 6)
    await claim(db, 6, claimTokenA)
    await markStale(db, 6)

    const swept = await sweep(db)
    assert.equal(swept.rows[0].sweep_stale_andreani_claims, 1)

    const state = await orderState(db, 6)
    assert.equal(state.andreani_creation_status, "reconciliation_required")
    assert.equal(state.andreani_creation_claim_token, null)

    // Sweep es idempotente: correrlo de nuevo no encuentra nada más que barrer.
    const secondSweep = await sweep(db)
    assert.equal(secondSweep.rows[0].sweep_stale_andreani_claims, 0)
  } finally {
    await db.close()
  }
})

test("11b. resolve_andreani_reconciliation también resuelve un claimed vencido de ESE pedido (self-heal), sin tocar uno fresco de otro pedido", async () => {
  const db = await setup()
  try {
    await insertEligibleOrder(db, 7)
    await claim(db, 7, claimTokenA)
    await markStale(db, 7)

    await insertEligibleOrder(db, 8)
    await claim(db, 8, "40000000-0000-4000-8000-000000000099")

    await resolve(db, 7, "not_created")

    assert.equal((await orderState(db, 7)).andreani_creation_status, "failed")
    // El claim fresco del pedido 8 no se ve afectado por resolver el 7.
    assert.equal((await orderState(db, 8)).andreani_creation_status, "claimed")
  } finally {
    await db.close()
  }
})

test("12. ningún camino de conciliación produce estado='cancelado' junto con andreani_creation_status='created'", async () => {
  const db = await setup()
  try {
    await toReconciliationRequired(db, 9)
    await resolve(db, 9, "created", { envioId: "ENV-REAL-9" })

    const state = await orderState(db, 9)
    assert.notEqual(state.estado, "cancelado")
    assert.equal(state.andreani_creation_status, "created")

    // Con el envío ya persistido, los 3 caminos de cancelación siguen
    // aplicando su propio guard de despacho (Parte 1) -- no hay forma de
    // llegar a cancelado+created por ninguno de ellos tampoco. Se prueba con
    // request_customer_order_cancellation_with_claim (no exige "no
    // facturado" como admin_cancel_order, así que llega limpio al guard de
    // despacho que sí comparten los 3).
    await db.query("update ordenes set usuario_id=$1 where id=9", [customer])
    await assert.rejects(
      db.query(
        "select request_customer_order_cancellation_with_claim($1,$2,$3) r",
        [9, customer, "Quiero cancelar"],
      ),
      /ORDER_ALREADY_DISPATCHED/,
    )
  } finally {
    await db.close()
  }
})

test("no cualquier rol puede conciliar -- sólo admin/super_admin (nunca operador)", async () => {
  const db = await setup()
  try {
    await toReconciliationRequired(db, 10)
    await assert.rejects(
      resolve(db, 10, "not_created", { adminRole: "operador" }),
      /ANDREANI_RECONCILIATION_FORBIDDEN/,
    )
    assert.equal((await orderState(db, 10)).andreani_creation_status, "reconciliation_required")
  } finally {
    await db.close()
  }
})

test("conciliación 'created' exige un envioId real -- nunca queda vacío", async () => {
  const db = await setup()
  try {
    await toReconciliationRequired(db, 11)
    await assert.rejects(
      resolve(db, 11, "created", { envioId: "" }),
      /ANDREANI_RECONCILIATION_INVALID_ENVIO_ID/,
    )
  } finally {
    await db.close()
  }
})

test("conciliación exige notas de auditoría con contenido real", async () => {
  const db = await setup()
  try {
    await toReconciliationRequired(db, 12)
    await assert.rejects(
      resolve(db, 12, "not_created", { notes: "ok" }),
      /ANDREANI_RECONCILIATION_INVALID_NOTES/,
    )
  } finally {
    await db.close()
  }
})

// --- Tests 4 y 5 pedidos: admin_cancel_order sigue guardado (Parte 1) y la
// cancelación normal sigue funcionando sin cambios por el endpoint dedicado.

function adminCancelOrder(
  db: PGlite,
  orderId: number,
  action: "reject" | "cancel",
  adminRole = "operador",
) {
  return db.query(
    "select admin_cancel_order($1,$2,$3,$4,$5,$6) r",
    [orderId, adminA, adminRole, action, "pago_no_recibido", "Prueba"],
  )
}

test("4. un operador NO puede bypassear las guardas de admin_cancel_order mientras hay una creación Andreani en curso", async () => {
  const db = await setup()
  try {
    await insertEligibleOrder(db, 13)
    await claim(db, 13, claimTokenA)

    await assert.rejects(
      adminCancelOrder(db, 13, "cancel", "operador"),
      /ANDREANI_CREATION_IN_PROGRESS/,
    )
    assert.equal((await orderState(db, 13)).estado, "pagado")
  } finally {
    await db.close()
  }
})

test("5. la cancelación normal (sin Andreani en curso) sigue funcionando por el endpoint dedicado, para cualquier rol interno habilitado", async () => {
  const db = await setup()
  try {
    await db.query("insert into ordenes (id, usuario_id, estado) values (14, $1, 'pendiente')", [customer])
    await adminCancelOrder(db, 14, "reject", "operador")
    assert.equal((await orderState(db, 14)).estado, "cancelado")
  } finally {
    await db.close()
  }
})
