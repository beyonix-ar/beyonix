import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

const migration = readFileSync(
  join(process.cwd(), "supabase/migrations/20260921100000_external_sale_reversal.sql"),
  "utf8",
).replace(/\r\n/g, "\n")
const functionSql = migration.match(
  /create or replace function public\.reverse_external_sale[\s\S]*?\n\$\$;/,
)?.[0]

const actorId = "10000000-0000-4000-8000-000000000001"
const saleId = "20000000-0000-4000-8000-000000000001"

async function setup() {
  assert.ok(functionSql, "la migración debe definir reverse_external_sale")
  const db = new PGlite()
  await db.exec(`
    create schema auth;
    create function auth.role() returns text language sql stable as $$ select 'service_role'::text $$;
    create table auth.users (id uuid primary key);
    create table public.external_sales (
      id uuid primary key,
      product_id integer,
      gross_amount numeric(12,2) not null,
      quantity integer not null,
      status text not null default 'completed',
      reversed_at timestamptz,
      reversed_by uuid references auth.users(id),
      reversal_reason text,
      reversal_amount numeric(12,2),
      reversal_idempotency_key text
    );
  `)
  await db.exec(functionSql)
  await db.query("insert into auth.users(id) values ($1)", [actorId])
  await db.query(
    "insert into external_sales(id, product_id, gross_amount, quantity) values ($1, 9, 42000, 2)",
    [saleId],
  )
  return db
}

test("L-M. la reversión externa es auditada, reintegra stock una vez y el retry es idempotente", async () => {
  const db = await setup()
  try {
    const before = await db.query<{ stock_delta: number }>(
      "select coalesce(sum(case when status = 'completed' then -quantity else 0 end), 0)::int stock_delta from external_sales",
    )
    assert.equal(before.rows[0].stock_delta, -2)

    const reverse = () => db.query<{
      status: string
      reversal_reason: string
      reversal_amount: string
      reversed_by: string
      reversed_at: string
    }>(
      "select (reverse_external_sale($1, $2, $3, $4)).*",
      [saleId, "Devolución total confirmada", actorId, "ext-reversal-test-001"],
    )
    const first = await reverse()
    const firstTimestamp = first.rows[0].reversed_at
    assert.equal(first.rows[0].status, "reversed")
    assert.equal(first.rows[0].reversal_reason, "Devolución total confirmada")
    assert.equal(Number(first.rows[0].reversal_amount), 42_000)
    assert.equal(first.rows[0].reversed_by, actorId)

    const retry = await reverse()
    assert.equal(
      new Date(retry.rows[0].reversed_at).getTime(),
      new Date(firstTimestamp).getTime(),
    )
    const afterRetry = await db.query<{ stock_delta: number }>(
      "select coalesce(sum(case when status = 'completed' then -quantity else 0 end), 0)::int stock_delta from external_sales",
    )
    assert.equal(afterRetry.rows[0].stock_delta, 0)

    await assert.rejects(
      db.query(
        "select reverse_external_sale($1, $2, $3, $4)",
        [saleId, "Intento duplicado distinto", actorId, "ext-reversal-test-002"],
      ),
      /EXTERNAL_SALE_ALREADY_REVERSED/,
    )
  } finally {
    await db.close()
  }
})

test("la reversión externa exige motivo y actor", async () => {
  const db = await setup()
  try {
    await assert.rejects(
      db.query("select reverse_external_sale($1, $2, $3, $4)", [saleId, "corto", actorId, "key-valid-001"]),
      /motivo de la reversión/,
    )
    await assert.rejects(
      db.query("select reverse_external_sale($1, $2, $3, $4)", [saleId, "Motivo suficientemente largo", null, "key-valid-002"]),
      /ACTOR_REQUIRED/,
    )
  } finally {
    await db.close()
  }
})
