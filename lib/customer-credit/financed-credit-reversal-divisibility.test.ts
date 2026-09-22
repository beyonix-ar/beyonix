import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

import { calculateCustomerCreditApplication, roundMoney } from "../customer-credit.ts"
import type { InstallmentCount, InstallmentsFinancingConfig } from "../products/installments.ts"
import {
  getCartFinancedTotal,
  getInstallmentAmount,
  roundUpCheckoutTotalForInstallments,
} from "../pricing/financed-pricing.ts"

// Orden financiada + saldo a favor -> reversión del saldo (MP rechaza/cancela).
// reverse_customer_credit_for_order restaura external_amount_due =
// original_total (sin lógica de cuotas en SQL). El monto restaurado sólo
// sigue dividiendo exacto por todas las cuotas ofrecidas si original_total
// ya es múltiplo del divisor: eso lo garantiza roundUpCheckoutTotalForInstallments
// (total redondeado hacia arriba, saldo hacia abajo, ambos múltiplos).
//
// Ejecuta las funciones SQL reales vigentes (mismas migraciones que
// credit-reversal-order-due.test.ts) contra PostgreSQL en memoria (PGlite).

const root = process.cwd()
const read = (path: string) => readFileSync(join(root, path), "utf8")
const fixture = read("lib/customer-credit/fixtures/credit-reversal-order-due.sql")

function extractFunctions(source: string) {
  const matches = [...source.matchAll(
    /CREATE OR REPLACE FUNCTION public\.(\w+)\([\s\S]*?AS \$function\$[\s\S]*?\$function\$;/g,
  )]
  return new Map(matches.map(([definition, name]) => [name, definition]))
}

const baselineFunctions = extractFunctions(
  read("supabase/migrations/20260911130000_harden_customer_credit_rpc_authorization.sql"),
)
const reversalFunctions = extractFunctions(
  read("supabase/migrations/20260911150000_reverse_customer_credit_resets_order_due.sql"),
)

const REAL_CONFIG: InstallmentsFinancingConfig = {
  baseProcessingPercent: 6.42,
  ivaPercent: 21,
  surchargePercentByCount: { 2: 7.79, 3: 10.49, 6: 18.69 },
}
const OFFERED_COUNTS: InstallmentCount[] = [2, 3, 6]
const user = "20000000-0000-4000-8000-000000000001"

const cents = (amount: number) => Math.round(amount * 100)

/** Mismo cálculo que create-preference con cuotas elegidas y saldo a favor. */
function financedCheckoutWithCredit(shipping: number, creditBalance: number) {
  const financedProducts = getCartFinancedTotal(
    [
      { cashPrice: 51_673, maxEligibleCount: 6, quantity: 1 },
      { cashPrice: 12_345, maxEligibleCount: 6, quantity: 2 },
    ],
    REAL_CONFIG,
  )
  const financedTotal = roundMoney(financedProducts + shipping)
  const credit = calculateCustomerCreditApplication({
    availableBalance: creditBalance,
    eligibleTotal: financedTotal,
    requestedAmount: creditBalance,
  })
  return roundUpCheckoutTotalForInstallments({
    total: financedTotal,
    customerCreditApplied: credit.appliedAmount,
    offeredCounts: OFFERED_COUNTS,
  })
}

function assertExactForAllOfferedCounts(amount: number) {
  for (const count of OFFERED_COUNTS) {
    const installment = getInstallmentAmount(amount, count)!
    assert.ok(
      Math.abs(installment * 100 - cents(installment)) < 1e-6,
      `${count} cuotas sobre ${amount}: ${installment} no es exacto al centavo`,
    )
    assert.equal(cents(installment) * count, cents(amount), `${count} cuotas no cierran ${amount}`)
  }
}

async function setupDb(db: PGlite, creditBalance: number) {
  await db.exec(fixture)
  await db.exec("alter table public.ordenes add column pricing_snapshot jsonb")
  await db.exec(baselineFunctions.get("get_customer_credit_balance")!)
  await db.exec(baselineFunctions.get("apply_customer_credit_to_order")!)
  await db.exec(reversalFunctions.get("reverse_customer_credit_for_order")!)
  await db.query("insert into auth.users (id) values ($1)", [user])
  await db.query(
    `insert into public.customer_credit_movements
      (user_id, movement_type, amount, description, source_type, resulting_balance)
     values ($1, 'credit', $2, 'Carga inicial de saldo', 'admin_adjustment', $2)`,
    [user, creditBalance],
  )
  await db.query("select set_config('request.jwt.claims', $1, false)", [
    JSON.stringify({ role: "service_role" }),
  ])
  await db.exec("set role service_role")
}

async function getOrder(db: PGlite, orderId: number) {
  const { rows } = await db.query<{
    total: string
    original_total: string
    credit_balance_used: string
    external_amount_due: string
    pricing_snapshot: unknown
  }>(
    "select total, original_total, credit_balance_used, external_amount_due, pricing_snapshot from public.ordenes where id = $1",
    [orderId],
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

test("orden financiada + saldo a favor -> reversión: el external_amount_due restaurado divide exacto por 2, 3 y 6", async () => {
  // Envío y saldo con centavos que NO son múltiplo de 6: el peor caso.
  const creditBalance = 12_345.67
  const checkout = financedCheckoutWithCredit(8_437.37, creditBalance)
  const pricingSnapshot = {
    financedPriceTotal: checkout.total - checkout.roundingAdjustment,
    installmentsRoundingAdjustment: checkout.roundingAdjustment,
  }

  assert.ok(checkout.roundingAdjustment > 0)
  assert.ok(checkout.customerCreditApplied > 0 && checkout.customerCreditApplied < creditBalance)
  assertExactForAllOfferedCounts(checkout.externalAmountDue)

  const db = new PGlite()
  try {
    await setupDb(db, creditBalance)
    // Igual que buildCheckoutOrderBase: total = original_total = total canónico.
    await db.query(
      `insert into public.ordenes
        (id, usuario_id, total, original_total, external_amount_due, pricing_snapshot)
       values (1, $1, $2, $2, $2, $3)`,
      [user, checkout.total, JSON.stringify(pricingSnapshot)],
    )

    await db.query("select * from public.apply_customer_credit_to_order($1, 1, $2)", [
      user,
      checkout.customerCreditApplied,
    ])
    const applied = await getOrder(db, 1)
    // La RPC recalcula original_total - saldo: coincide al centavo con lo que cobra MP.
    assert.equal(cents(Number(applied.external_amount_due)), cents(checkout.externalAmountDue))
    assert.equal(
      roundMoney(await getBalance(db)),
      roundMoney(creditBalance - checkout.customerCreditApplied),
    )

    await db.query("select * from public.reverse_customer_credit_for_order(1, $1)", [
      "Reintegro de saldo por pago rechazado",
    ])
    const reversed = await getOrder(db, 1)

    assert.equal(await getBalance(db), creditBalance, "saldo revertido completo")
    assert.equal(Number(reversed.credit_balance_used), 0)
    assert.equal(cents(Number(reversed.original_total)), cents(checkout.total), "original_total intacto")
    assert.equal(cents(Number(reversed.total)), cents(checkout.total))
    assert.deepEqual(reversed.pricing_snapshot, pricingSnapshot, "pricing_snapshot intacto")
    assert.equal(cents(Number(reversed.external_amount_due)), cents(checkout.total))
    assertExactForAllOfferedCounts(Number(reversed.external_amount_due))

    // Idempotente: una segunda reversión no acredita ni cambia el pendiente.
    await db.query("select * from public.reverse_customer_credit_for_order(1, $1)", [
      "Reintegro de saldo por pago rechazado",
    ])
    assert.equal(await getBalance(db), creditBalance)
    assert.deepEqual(await getOrder(db, 1), reversed)
  } finally {
    await db.close()
  }
})

test("barrido: cualquier saldo parcial revertido deja un pendiente divisible por todas las cuotas ofrecidas", async () => {
  const db = new PGlite()
  try {
    await setupDb(db, 1_000_000)

    for (let step = 1; step <= 40; step++) {
      const creditBalance = roundMoney((step * 913.07) % 60_000) + 0.01
      const checkout = financedCheckoutWithCredit(roundMoney((step * 377.13) % 25_000), creditBalance)
      if (checkout.externalAmountDue <= 0 || checkout.customerCreditApplied <= 0) continue

      await db.query(
        `insert into public.ordenes (id, usuario_id, total, original_total, external_amount_due)
         values ($1, $2, $3, $3, $3)`,
        [step, user, checkout.total],
      )
      await db.query("select * from public.apply_customer_credit_to_order($1, $2, $3)", [
        user,
        step,
        checkout.customerCreditApplied,
      ])
      assertExactForAllOfferedCounts(Number((await getOrder(db, step)).external_amount_due))

      await db.query("select * from public.reverse_customer_credit_for_order($1, $2)", [
        step,
        "Reintegro de saldo por pago rechazado",
      ])
      const reversed = await getOrder(db, step)
      assert.equal(cents(Number(reversed.external_amount_due)), cents(checkout.total))
      assertExactForAllOfferedCounts(Number(reversed.external_amount_due))
    }

    assert.equal(await getBalance(db), 1_000_000, "cada reversión devolvió exactamente lo aplicado")
  } finally {
    await db.close()
  }
})
