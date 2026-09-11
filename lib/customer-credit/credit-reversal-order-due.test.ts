import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

import { processApprovedMercadoPagoOrderPayment } from "../mercadopago/order-payment.ts"

// P1 saldo + Mercado Pago: un pedido con saldo interno aplicado + diferencia
// por Mercado Pago. Si MP rechaza/cancela, reverse_customer_credit_for_order
// reintegra el saldo a la billetera -- pero (antes de esta corrección) dejaba
// ordenes.credit_balance_used/external_amount_due con los valores previos.
// Un segundo intento de pago sobre la MISMA preferencia (payment_id distinto,
// mismo external_reference -- reintentar con otra tarjeta en Checkout Pro sin
// pasar de nuevo por create-preference) aprobado por ese monto viejo
// confirmaba la orden completa sin volver a cobrar el saldo ya devuelto.
//
// Este test ejecuta las funciones SQL reales (no una reimplementación): las
// extrae de supabase/migrations/20260911130000_harden_customer_credit_rpc_authorization.sql
// (vigente) y de 20260911150000_reverse_customer_credit_resets_order_due.sql
// (la corrección) y las corre contra PostgreSQL en memoria (PGlite). No hay
// red, credenciales ni RPC financieras contra Supabase real.

const root = process.cwd()
const read = (path: string) => readFileSync(join(root, path), "utf8")
const fixture = read("lib/customer-credit/fixtures/credit-reversal-order-due.sql")
const baselineMigration = read(
  "supabase/migrations/20260911130000_harden_customer_credit_rpc_authorization.sql",
)
const fixMigration = read(
  "supabase/migrations/20260911150000_reverse_customer_credit_resets_order_due.sql",
)

function extractFunctions(source: string) {
  const matches = [...source.matchAll(
    /CREATE OR REPLACE FUNCTION public\.(\w+)\([\s\S]*?AS \$function\$[\s\S]*?\$function\$;/g,
  )]
  return new Map(matches.map(([definition, name]) => [name, definition]))
}

const baselineFunctions = extractFunctions(baselineMigration)
const fixFunctions = extractFunctions(fixMigration)

const user = "20000000-0000-4000-8000-000000000001"
const order = 1

async function setup(db: PGlite, { fixed }: { fixed: boolean }) {
  await db.exec(fixture)
  await db.exec(baselineFunctions.get("get_customer_credit_balance")!)
  await db.exec(baselineFunctions.get("apply_customer_credit_to_order")!)
  await db.exec(
    (fixed ? fixFunctions : baselineFunctions).get(
      "reverse_customer_credit_for_order",
    )!,
  )

  await db.query("insert into auth.users (id) values ($1)", [user])
  // Saldo inicial en billetera: $30.000, para poder aplicarlo al pedido.
  await db.query(
    `insert into public.customer_credit_movements
      (user_id, movement_type, amount, description, source_type, resulting_balance)
     values ($1, 'credit', 30000, 'Carga inicial de saldo', 'admin_adjustment', 30000)`,
    [user],
  )
  // Pedido de $100.000: $30.000 se pagarían con saldo, $70.000 con Mercado
  // Pago. payment_composition se siembra ya con el desglose "compuesto"
  // (getPaymentComposition, lib/customer-credit.ts) que produce
  // checkout-order-creation.ts para un pedido con saldo + MP -- es el estado
  // real justo antes de que Mercado Pago rechace el intento.
  await db.query(
    `insert into public.ordenes
      (id, usuario_id, total, original_total, external_amount_due, payment_composition)
     values ($1, $2, 100000, 100000, 100000, $3)`,
    [
      order,
      user,
      JSON.stringify({
        credit_balance_used: 30000,
        external_amount_due: 70000,
        parts: [
          { type: "customer_credit", label: "Saldo a favor BEYONIX", amount: 30000 },
          { type: "mercadopago", label: "Mercado Pago", amount: 70000 },
        ],
      }),
    ],
  )

  await db.query("select set_config('request.jwt.claims', $1, false)", [
    JSON.stringify({ role: "service_role" }),
  ])
  await db.exec("set role service_role")
}

interface PaymentComposition {
  credit_balance_used?: number
  external_amount_due?: number
  parts?: Array<{ type: string; label: string; amount: number }>
  credit_movement_id?: string | null
  credit_reversal_movement_id?: string | null
}

async function getOrder(db: PGlite) {
  const { rows } = await db.query<{
    credit_balance_used: string
    external_amount_due: string
    credit_balance_movement_id: string | null
    payment_composition: PaymentComposition
  }>(
    "select credit_balance_used, external_amount_due, credit_balance_movement_id, payment_composition from public.ordenes where id = $1",
    [order],
  )
  return rows[0]
}

async function getBalance(db: PGlite) {
  const { rows } = await db.query<{ balance: string }>(
    "select public.get_customer_credit_balance($1) balance",
    [user],
  )
  return Number(rows[0].balance)
}

test("ANTES del fix: MP rechazado reintegra saldo pero deja el pedido confirmable por el monto viejo (P1 reproducido)", async () => {
  const db = new PGlite()
  try {
    await setup(db, { fixed: false })

    await db.query(
      "select * from public.apply_customer_credit_to_order($1, $2, 30000)",
      [user, order],
    )
    const afterApply = await getOrder(db)
    assert.equal(afterApply.credit_balance_used, "30000.00")
    assert.equal(afterApply.external_amount_due, "70000.00")
    assert.ok(afterApply.credit_balance_movement_id)

    // Mercado Pago rechaza el intento: el webhook reintegra el saldo.
    await db.query(
      "select * from public.reverse_customer_credit_for_order($1, $2)",
      [order, "Reintegro de saldo por pago rechazado"],
    )

    assert.equal(await getBalance(db), 30000, "el saldo vuelve a la billetera")

    const afterReversal = await getOrder(db)
    assert.equal(
      afterReversal.credit_balance_used,
      "30000.00",
      "BUG: la orden sigue mostrando el saldo como aplicado aunque ya se devolvió",
    )
    assert.equal(
      afterReversal.external_amount_due,
      "70000.00",
      "BUG: el pendiente sigue siendo la diferencia vieja, no el total completo",
    )
    assert.deepEqual(
      afterReversal.payment_composition.parts,
      [
        { type: "customer_credit", label: "Saldo a favor BEYONIX", amount: 30000 },
        { type: "mercadopago", label: "Mercado Pago", amount: 70000 },
      ],
      "BUG: payment_composition sigue mostrando el saldo ya devuelto como parte del pago",
    )

    // Un segundo intento de pago (payment_id distinto, misma preferencia)
    // aprobado por los $70.000 originales confirma la orden entera.
    let confirmedAmount: number | null = null
    const result = await processApprovedMercadoPagoOrderPayment(
      {
        estado: "pendiente",
        financial_status: "pending_payment",
        total: 100000,
        external_amount_due: Number(afterReversal.external_amount_due),
      },
      { status: "approved", currency_id: "ARS", transaction_amount: 70000 },
      async (amount) => {
        confirmedAmount = amount
        return true
      },
    )

    assert.equal(
      result.kind,
      "confirmed",
      "P1 confirmado: la orden se da por pagada en su totalidad con sólo $70.000",
    )
    assert.equal(confirmedAmount, 70000)
    // El cliente terminó con el pedido completo Y los $30.000 de vuelta en su saldo.
    assert.equal(await getBalance(db), 30000)
  } finally {
    await db.close()
  }
})

test("DESPUÉS del fix: el reintegro resetea el pendiente de la orden al total completo", async () => {
  const db = new PGlite()
  try {
    await setup(db, { fixed: true })

    await db.query(
      "select * from public.apply_customer_credit_to_order($1, $2, 30000)",
      [user, order],
    )
    await db.query(
      "select * from public.reverse_customer_credit_for_order($1, $2)",
      [order, "Reintegro de saldo por pago rechazado"],
    )

    assert.equal(await getBalance(db), 30000, "el saldo vuelve a la billetera")

    const afterReversal = await getOrder(db)
    assert.equal(Number(afterReversal.credit_balance_used), 0)
    assert.equal(Number(afterReversal.external_amount_due), 100000)
    assert.equal(afterReversal.credit_balance_movement_id, null)
    // payment_composition coherente: nada de saldo, todo el total pendiente,
    // y ningún desglose viejo (el saldo ya no forma parte de este pago).
    assert.equal(afterReversal.payment_composition.credit_balance_used, 0)
    assert.equal(afterReversal.payment_composition.external_amount_due, 100000)
    assert.deepEqual(afterReversal.payment_composition.parts, [])
    assert.equal(afterReversal.payment_composition.credit_movement_id, null)
    assert.ok(afterReversal.payment_composition.credit_reversal_movement_id)

    // El mismo pago viejo de $70.000 ya NO alcanza para confirmar la orden.
    let confirmations = 0
    const mismatch = await processApprovedMercadoPagoOrderPayment(
      {
        estado: "pendiente",
        financial_status: "pending_payment",
        total: 100000,
        external_amount_due: Number(afterReversal.external_amount_due),
      },
      { status: "approved", currency_id: "ARS", transaction_amount: 70000 },
      async () => {
        confirmations += 1
        return true
      },
    )
    assert.equal(mismatch.kind, "amount_mismatch")
    assert.equal(confirmations, 0)

    // Sólo un pago aprobado por el TOTAL completo confirma la orden.
    const confirmed = await processApprovedMercadoPagoOrderPayment(
      {
        estado: "pendiente",
        financial_status: "pending_payment",
        total: 100000,
        external_amount_due: Number(afterReversal.external_amount_due),
      },
      { status: "approved", currency_id: "ARS", transaction_amount: 100000 },
      async () => {
        confirmations += 1
        return true
      },
    )
    assert.equal(confirmed.kind, "confirmed")
    assert.equal(confirmations, 1)
  } finally {
    await db.close()
  }
})

test("DESPUÉS del fix: idempotente ante reintegros repetidos y no toca órdenes sin saldo aplicado", async () => {
  const db = new PGlite()
  try {
    await setup(db, { fixed: true })

    // Sin saldo aplicado: reintegrar es un no-op explícito (restored_amount=0).
    const noop = await db.query<{ movement_id: string | null; restored_amount: string }>(
      "select * from public.reverse_customer_credit_for_order($1, $2)",
      [order, "Sin saldo aplicado"],
    )
    assert.equal(noop.rows[0].movement_id, null)
    assert.equal(Number(noop.rows[0].restored_amount), 0)
    const untouched = await getOrder(db)
    assert.equal(Number(untouched.credit_balance_used), 0)
    assert.equal(Number(untouched.external_amount_due), 100000)
    assert.equal(untouched.credit_balance_movement_id, null)

    await db.query(
      "select * from public.apply_customer_credit_to_order($1, $2, 30000)",
      [user, order],
    )

    const first = await db.query<{ movement_id: string; restored_amount: string }>(
      "select * from public.reverse_customer_credit_for_order($1, $2)",
      [order, "Reintegro de saldo por pago rechazado"],
    )
    // La segunda llamada ya no encuentra credit_balance_used > 0 (el fix lo
    // resetea en la primera): cae en el mismo no-op explícito de arriba, sin
    // volver a acreditar. Es el mismo camino que ya usan los callers (todos
    // verifican credit_balance_used > 0 antes de invocar la RPC).
    const second = await db.query<{ movement_id: string | null; restored_amount: string }>(
      "select * from public.reverse_customer_credit_for_order($1, $2)",
      [order, "Reintegro de saldo por pago rechazado"],
    )

    assert.ok(first.rows[0].movement_id)
    assert.equal(second.rows[0].movement_id, null)
    assert.equal(Number(second.rows[0].restored_amount), 0)
    assert.equal(await getBalance(db), 30000, "reintegrar dos veces no duplica el saldo")
    assert.equal(
      (
        await db.query<{ n: number }>(
          "select count(*)::int n from public.customer_credit_movements where movement_type = 'reversal'",
        )
      ).rows[0].n,
      1,
    )
    // El no-op repetido no vuelve a tocar payment_composition (sigue coherente).
    const afterBoth = await getOrder(db)
    assert.equal(afterBoth.payment_composition.credit_balance_used, 0)
    assert.equal(afterBoth.payment_composition.external_amount_due, 100000)
    assert.deepEqual(afterBoth.payment_composition.parts, [])
  } finally {
    await db.close()
  }
})
