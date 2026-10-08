import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

import {
  CUSTOMER_FORBIDDEN_KEYS,
  CUSTOMER_ORDER_FIELDS,
  CUSTOMER_ORDER_ITEM_FIELDS,
  findForbiddenCustomerKeys,
  toCustomerOrderDto,
} from "./customer-order-dto.ts"

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8")
const forbidden: readonly string[] = CUSTOMER_FORBIDDEN_KEYS

test("el allowlist del cliente no contiene ninguna clave interna", () => {
  assert.deepEqual(CUSTOMER_ORDER_FIELDS.filter((field) => forbidden.includes(field)), [])
  assert.deepEqual(CUSTOMER_ORDER_ITEM_FIELDS.filter((field) => forbidden.includes(field)), [])
  assert.ok(CUSTOMER_ORDER_FIELDS.includes("shipping_cost_charged"), "el precio final del envío sí se informa")
})

test("toCustomerOrderDto descarta tarifa, recargo, recotización, facturación, bultos y costos", () => {
  const internal = Object.fromEntries(forbidden.map((key) => [key, 123]))
  const row = {
    id: 24, total: 18000, shipping_cost_charged: 8400, estado: "pagado",
    ...internal,
    orden_items: [{ id: 1, cantidad: 1, precio: 9600, ...internal }],
  }
  const dto = toCustomerOrderDto(row, { order_audit_events: [] })

  assert.deepEqual(findForbiddenCustomerKeys(dto), [])
  assert.equal(dto.shipping_cost_charged, 8400)
  assert.equal(dto.total, 18000)
  assert.deepEqual(dto.orden_items, [{ id: 1, cantidad: 1, precio: 9600 }])
  assert.deepEqual(findForbiddenCustomerKeys({ a: [{ b: { shipping_markup_amount: 1 } }] }), ["shipping_markup_amount"])
})

test("las rutas de pedidos del cliente seleccionan columnas explícitas y pasan por el DTO", () => {
  for (const path of ["app/api/orders/route.ts", "app/api/orders/[id]/route.ts"]) {
    const source = read(path)
    const select = source.match(/const (?:ORDER_LIST_SELECT|CUSTOMER_ORDER_DETAIL_SELECT) =\s*"([^"]+)"/)?.[1]
    assert.ok(select, `${path}: select explícito`)
    const columns = select.split(/[\s,()]+/).filter(Boolean)
    assert.deepEqual(columns.filter((column) => forbidden.includes(column)), [], path)
    assert.doesNotMatch(select, /\*/, `${path}: sin select *`)
    assert.match(source, /toCustomerOrderDto\(/, path)
  }
})

test("el navegador del cliente no lee ni escucha ordenes directamente", () => {
  for (const path of [
    "components/account/account-orders.tsx",
    "components/customer-notifications-bell.tsx",
    "lib/supabase/queries/customer-notifications.ts",
  ]) {
    const source = read(path)
    assert.doesNotMatch(source, /table:\s*"ordenes"/, path)
    assert.doesNotMatch(source, /from\("ordenes"\)/, path)
  }
  assert.match(read("components/account/account-orders.tsx"), /table:\s*"customer_order_signals"/)
  assert.match(read("components/customer-notifications-bell.tsx"), /table:\s*"customer_order_signals"/)
  assert.match(read("lib/supabase/queries/customer-notifications.ts"), /rpc\(\s*"customer_order_payment_progress"/)
})

const customer = "40000000-0000-4000-8000-000000000001"
const otherCustomer = "40000000-0000-4000-8000-000000000002"
const admin = "40000000-0000-4000-8000-000000000003"

async function setup() {
  const db = new PGlite()
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    grant usage on schema auth to anon, authenticated, service_role;
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create table profiles (id uuid primary key, rol text not null);
    create table ordenes (
      id bigint primary key, usuario_id uuid, created_at timestamptz default now(), estado text default 'pendiente',
      payment_method_id text, payment_status text, financial_status text, payment_proof_url text,
      payment_proof_uploaded_at timestamptz, shipping_cost_charged numeric, shipping_provider_quote_amount numeric,
      shipping_markup_amount numeric);
    create table orden_items (id bigint primary key, orden_id bigint references ordenes(id), precio numeric,
      costo_unitario_historico numeric);
    create table order_refund_proofs (id bigint primary key, order_id bigint references ordenes(id));
    create table categorias (id bigint primary key, nombre text);
    create function undo_audit_log(bigint) returns void language sql as $$ select $$;
    alter table ordenes enable row level security;
    alter table orden_items enable row level security;
    alter table order_refund_proofs enable row level security;
    alter table categorias enable row level security;
    grant usage on schema public to anon, authenticated, service_role;
    grant select on profiles to authenticated;
    grant select, insert, update, delete on ordenes, orden_items, order_refund_proofs, categorias to anon, authenticated;
    create policy ordenes_select_own on ordenes for select using (auth.uid() = usuario_id);
    create policy ordenes_insert_own on ordenes for insert with check (auth.uid() = usuario_id);
    create policy "Admins can read ordenes" on ordenes for select to authenticated
      using (exists (select 1 from profiles where profiles.id = auth.uid() and profiles.rol in ('admin', 'super_admin')));
    create policy "Users can read own order items" on orden_items for select to authenticated
      using (exists (select 1 from ordenes o where o.id = orden_items.orden_id and o.usuario_id = auth.uid()));
    create policy "Customers can read own refund proofs" on order_refund_proofs for select to authenticated
      using (exists (select 1 from ordenes where ordenes.id = order_refund_proofs.order_id and ordenes.usuario_id = auth.uid()));
    create policy categorias_select_all on categorias for select using (true);
    create policy "Admins can insert categorias" on categorias for insert to authenticated with check (true);
    create policy "Admins can update categorias" on categorias for update to authenticated using (true);
    create policy "Admins can delete categorias" on categorias for delete to authenticated using (true);
    insert into profiles values ('${customer}', 'cliente'), ('${otherCustomer}', 'cliente'), ('${admin}', 'super_admin');
    insert into ordenes (id, usuario_id, payment_method_id, payment_status, shipping_cost_charged,
      shipping_provider_quote_amount, shipping_markup_amount) values
      (1, '${customer}', 'transferencia', 'pending', 8400, 7000, 1400),
      (2, '${otherCustomer}', 'transferencia', 'pending', 5000, 4000, 1000);
    insert into orden_items values (10, 1, 9600, 4000), (20, 2, 5000, 2000);
    insert into order_refund_proofs values (100, 1);
    insert into categorias values (1, 'Auriculares');
  `)
  await db.exec(read("supabase/migrations/20261009130000_customer_order_privacy.sql"))
  return db
}

async function as<T>(db: PGlite, role: "authenticated" | "anon", userId: string | null, sql: string, params: unknown[] = []) {
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [userId ?? ""])
  await db.exec(`set role ${role}`)
  try {
    return (await db.query<T>(sql, params)).rows
  } finally {
    await db.exec("reset role")
  }
}

test("migración: el cliente no lee filas de pedidos, ítems ni comprobantes de reintegro", async () => {
  const db = await setup()
  try {
    assert.equal((await as(db, "authenticated", customer, "select * from ordenes")).length, 0)
    assert.equal((await as(db, "authenticated", customer, "select * from orden_items")).length, 0)
    assert.equal((await as(db, "authenticated", customer, "select * from order_refund_proofs")).length, 0)
    await assert.rejects(as(db, "anon", null, "select * from ordenes"), /permission denied/)
    await assert.rejects(as(db, "anon", null, "select * from order_refund_proofs"), /permission denied/)
    await assert.rejects(
      as(db, "authenticated", customer, `insert into ordenes (id, usuario_id) values (3, '${customer}')`),
      /row-level security/,
    )
    assert.equal((await as(db, "authenticated", admin, "select id from ordenes order by id")).length, 2, "admin conserva lectura")
  } finally { await db.close() }
})

test("migración: el aviso Realtime sólo dice qué pedido propio cambió", async () => {
  const db = await setup()
  try {
    const own = await as<Record<string, unknown>>(db, "authenticated", customer, "select * from customer_order_signals")
    assert.deepEqual(own.map((row) => Object.keys(row).sort()), [["changed_at", "order_id", "user_id"]])
    assert.equal(own[0].order_id, 1)
    assert.equal(findForbiddenCustomerKeys(own).length, 0)

    await db.exec("update customer_order_signals set changed_at = '2020-01-01' where order_id = 1")
    await db.exec("update ordenes set shipping_markup_amount = 1500 where id = 1")
    const [signal] = (await db.query<{ changed_at: Date }>("select changed_at from customer_order_signals where order_id = 1")).rows
    assert.ok(signal.changed_at.getFullYear() > 2020, "cualquier cambio del pedido renueva el aviso")

    await db.exec("update ordenes set usuario_id = null where id = 2")
    assert.equal((await db.query("select 1 from customer_order_signals where order_id = 2")).rows.length, 0)
    await assert.rejects(
      as(db, "authenticated", customer, `insert into customer_order_signals values (2, '${customer}', now())`),
      /permission denied/,
    )
  } finally { await db.close() }
})

test("migración: la campana recibe sólo el estado de pago de pedidos propios", async () => {
  const db = await setup()
  try {
    const rows = await as<Record<string, unknown>>(db, "authenticated", customer,
      "select * from customer_order_payment_progress(array[1, 2]::bigint[])")
    assert.deepEqual(rows.map((row) => row.id), [1])
    assert.deepEqual(Object.keys(rows[0]).sort(), [
      "estado", "financial_status", "id", "payment_method_id", "payment_proof_uploaded_at", "payment_proof_url", "payment_status",
    ])
    await assert.rejects(as(db, "anon", null, "select * from customer_order_payment_progress(array[1]::bigint[])"), /permission denied/)
  } finally { await db.close() }
})

test("migración: sólo admins escriben categorías", async () => {
  const db = await setup()
  try {
    await assert.rejects(
      as(db, "authenticated", customer, "insert into categorias values (2, 'Falsa')"),
      /row-level security/,
    )
    assert.equal((await as(db, "authenticated", customer, "update categorias set nombre = 'X' returning id")).length, 0)
    assert.equal((await as(db, "authenticated", customer, "delete from categorias returning id")).length, 0)
    assert.equal((await as(db, "authenticated", admin, "update categorias set nombre = 'Audio' returning id")).length, 1)
  } finally { await db.close() }
})
