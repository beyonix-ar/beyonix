import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

// Permisos administrativos: admin y super_admin leen/gestionan lo mismo;
// operador, cliente y anon no ganan nada. Corre las migraciones reales sobre
// las políticas heredadas (sólo-'admin') que existían en producción.

const users = {
  admin: "50000000-0000-4000-8000-000000000001",
  super_admin: "50000000-0000-4000-8000-000000000002",
  operador: "50000000-0000-4000-8000-000000000003",
  cliente: "50000000-0000-4000-8000-000000000004",
} as const
type Actor = keyof typeof users | "anon"

const isAdmin = (rol: string) => `exists (select 1 from profiles where profiles.id = auth.uid() and profiles.rol = '${rol}')`
const isAnyAdmin = "exists (select 1 from profiles where profiles.id = auth.uid() and profiles.rol in ('admin', 'super_admin'))"

async function setup() {
  const db = new PGlite()
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    grant usage on schema auth to anon, authenticated, service_role;
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema public to anon, authenticated, service_role;

    create table profiles (id uuid primary key, rol text not null);
    create table ordenes (id bigint primary key, usuario_id uuid, created_at timestamptz default now(),
      estado text, payment_method_id text, payment_status text, financial_status text, payment_proof_url text,
      payment_proof_uploaded_at timestamptz, shipping_cost_charged numeric, shipping_provider_quote_amount numeric,
      shipping_markup_percent numeric, shipping_markup_amount numeric, shipping_parcel_quote_amount numeric,
      andreani_billed_amount numeric);
    create table orden_items (id bigint primary key, orden_id bigint references ordenes(id), precio numeric,
      costo_unitario_historico numeric);
    create table order_refund_proofs (id bigint primary key, order_id bigint references ordenes(id));
    create table categorias (id bigint primary key, nombre text);
    create table productos (id bigint primary key, activo boolean);
    create table producto_variantes (id bigint primary key, producto_id bigint, activo boolean);
    create table imagenes_producto (id bigint primary key, producto_id bigint);
    create table resenas (id bigint primary key, usuario_id uuid, texto text);
    create table audit_logs (id bigint primary key);
    create table order_audit_events (id bigint primary key);

    create function undo_audit_log(bigint) returns void language sql as $$ select $$;
    create function admin_get_client_carts() returns int language sql as $$ select 1 $$;
    create function admin_get_client_presence() returns int language sql as $$ select 1 $$;
    create function admin_get_blocked_client_identifiers() returns int language sql as $$ select 1 $$;
    create function notify_customers_about_offer(text, text, text) returns int language sql as $$ select 1 $$;
    create function create_producto_completo(jsonb, jsonb, jsonb, jsonb) returns int language sql as $$ select 1 $$;

    do $$ declare t text; begin
      foreach t in array array['ordenes','orden_items','order_refund_proofs','categorias','productos',
        'producto_variantes','imagenes_producto','resenas','audit_logs','order_audit_events'] loop
        execute format('alter table %I enable row level security', t);
        execute format('grant select, insert, update, delete on %I to anon, authenticated', t);
      end loop;
    end $$;
    grant select on profiles to anon, authenticated;

    -- Políticas tal como estaban en producción antes de 20261009130000/140000.
    create policy ordenes_select_own on ordenes for select using (auth.uid() = usuario_id);
    create policy "Admins can read ordenes" on ordenes for select to authenticated using (${isAnyAdmin});
    create policy "Admins can update ordenes" on ordenes for update to authenticated using (${isAnyAdmin}) with check (${isAnyAdmin});
    create policy ordenes_admin_update on ordenes for update using (${isAdmin("admin")});
    create policy ordenes_admin_delete on ordenes for delete using (${isAdmin("admin")});
    create policy "Users can read own order items" on orden_items for select to authenticated
      using (exists (select 1 from ordenes o where o.id = orden_items.orden_id and o.usuario_id = auth.uid()));
    create policy orden_items_admin_select on orden_items for select to authenticated using (${isAdmin("admin")});
    create policy productos_admin_all on productos using (${isAdmin("admin")});
    create policy productos_public on productos for select using (activo);
    create policy imagenes_admin_all on imagenes_producto using ((select rol from profiles where id = auth.uid()) = 'admin');
    create policy producto_variantes_public_select on producto_variantes for select using (activo);
    create policy producto_variantes_admin_select on producto_variantes for select to authenticated using (${isAdmin("admin")});
    create policy producto_variantes_admin_insert on producto_variantes for insert to authenticated with check (${isAdmin("admin")});
    create policy producto_variantes_admin_update on producto_variantes for update to authenticated
      using (${isAdmin("admin")}) with check (${isAdmin("admin")});
    create policy producto_variantes_admin_delete on producto_variantes for delete to authenticated using (${isAdmin("admin")});
    create policy resenas_select_all on resenas for select using (true);
    create policy resenas_admin_update on resenas for update using (${isAdmin("admin")});
    create policy resenas_admin_delete on resenas for delete using (${isAdmin("admin")});
    create policy audit_logs_super_admin_select on audit_logs for select to authenticated using (${isAdmin("super_admin")});
    create policy "Admins can read order audit events" on order_audit_events for select to authenticated using (${isAnyAdmin});

    insert into profiles values ('${users.admin}', 'admin'), ('${users.super_admin}', 'super_admin'),
      ('${users.operador}', 'operador'), ('${users.cliente}', 'cliente');
    insert into ordenes (id, usuario_id, shipping_cost_charged, shipping_provider_quote_amount, shipping_markup_percent,
      shipping_markup_amount, shipping_parcel_quote_amount, andreani_billed_amount)
      values (1, '${users.cliente}', 8400, 7000, 20, 1400, 7300, 7250);
    insert into orden_items values (10, 1, 9600, 4000);
    insert into productos values (1, true), (2, false);
    insert into producto_variantes values (11, 1, true), (12, 1, false);
    insert into imagenes_producto values (21, 1);
    insert into resenas values (31, '${users.cliente}', 'Muy bueno'), (32, '${users.cliente}', 'Excelente');
    insert into audit_logs values (1);
    insert into order_audit_events values (1);
    insert into categorias values (1, 'Audio');
  `)
  for (const migration of ["20261009130000_customer_order_privacy.sql", "20261009140000_fix_admin_superadmin_policies.sql"]) {
    await db.exec(readFileSync(join(process.cwd(), "supabase/migrations", migration), "utf8"))
  }
  return db
}

async function as<T>(db: PGlite, actor: Actor, sql: string) {
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [actor === "anon" ? "" : users[actor]])
  await db.exec(`set role ${actor === "anon" ? "anon" : "authenticated"}`)
  try {
    return (await db.query<T>(sql)).rows
  } finally {
    await db.exec("reset role")
  }
}

const rowCount = async (db: PGlite, actor: Actor, sql: string) => {
  try {
    return (await as(db, actor, sql)).length
  } catch (error) {
    if (error instanceof Error && /permission denied/.test(error.message)) return "denegado"
    throw error
  }
}

test("orden_items y ordenes: admin y super_admin leen; operador, cliente y anon no", async () => {
  const db = await setup()
  try {
    const expected = { admin: 1, super_admin: 1, operador: 0, cliente: 0, anon: "denegado" } as const
    for (const [actor, count] of Object.entries(expected) as [Actor, number | string][]) {
      assert.equal(await rowCount(db, actor, "select * from orden_items"), count, `orden_items ${actor}`)
      assert.equal(await rowCount(db, actor, "select * from ordenes"), count, `ordenes ${actor}`)
    }
  } finally { await db.close() }
})

test("admin y super_admin ven el desglose logístico interno; el cliente nunca recibe la fila", async () => {
  const db = await setup()
  try {
    const internal = "select shipping_provider_quote_amount, shipping_markup_percent, shipping_markup_amount, " +
      "shipping_parcel_quote_amount, andreani_billed_amount from ordenes where id = 1"
    for (const actor of ["admin", "super_admin"] as const) {
      const [row] = await as<Record<string, string>>(db, actor, internal)
      assert.equal(Number(row.shipping_markup_amount), 1400, actor)
      assert.equal(Number(row.andreani_billed_amount), 7250, actor)
    }
    assert.deepEqual(await as(db, "cliente", internal), [])
    assert.deepEqual(await as(db, "cliente", "select costo_unitario_historico from orden_items"), [])
    assert.equal(await rowCount(db, "anon", internal), "denegado")
  } finally { await db.close() }
})

test("pedidos, variantes, productos y reseñas: super_admin gestiona igual que admin", async () => {
  const db = await setup()
  try {
    for (const actor of ["admin", "super_admin"] as const) {
      assert.equal(await rowCount(db, actor, "select * from producto_variantes where activo = false"), 1, `${actor} variante inactiva`)
      assert.equal(await rowCount(db, actor, "select * from productos where activo = false"), 1, `${actor} producto inactivo`)
      assert.equal(await rowCount(db, actor, "update producto_variantes set activo = activo returning id"), 2, actor)
      assert.equal(await rowCount(db, actor, "update imagenes_producto set producto_id = 1 returning id"), 1, actor)
      assert.equal(await rowCount(db, actor, "update resenas set texto = texto returning id"), 2, actor)
      assert.equal(await rowCount(db, actor, "update ordenes set estado = estado returning id"), 1, actor)
    }
    assert.equal(await rowCount(db, "super_admin", "delete from resenas where id = 32 returning id"), 1)
    assert.equal(await rowCount(db, "super_admin", "insert into producto_variantes values (13, 1, false) returning id"), 1)

    for (const actor of ["operador", "cliente"] as const) {
      assert.equal(await rowCount(db, actor, "select * from producto_variantes where activo = false"), 0, actor)
      assert.equal(await rowCount(db, actor, "update producto_variantes set activo = activo returning id"), 0, actor)
      assert.equal(await rowCount(db, actor, "update resenas set texto = 'x' returning id"), 0, actor)
      assert.equal(await rowCount(db, actor, "delete from resenas returning id"), 0, actor)
      assert.equal(await rowCount(db, actor, "delete from ordenes returning id"), 0, actor)
      assert.equal(await rowCount(db, actor, "update imagenes_producto set producto_id = 1 returning id"), 0, actor)
      await assert.rejects(as(db, actor, "insert into producto_variantes values (99, 1, true)"), /row-level security/)
    }
  } finally { await db.close() }
})

test("RPC administrativas: anon sin EXECUTE; auditoría sin SELECT para anon", async () => {
  const db = await setup()
  try {
    for (const call of [
      "select admin_get_client_carts()", "select admin_get_client_presence()",
      "select admin_get_blocked_client_identifiers()", "select notify_customers_about_offer('a', 'b', 'c')",
      "select undo_audit_log(1)", "select create_producto_completo('{}', '[]', '[]', '[]')",
    ]) {
      await assert.rejects(as(db, "anon", call), /permission denied/, call)
      assert.equal((await as(db, "admin", call)).length, 1, `${call}: authenticated conserva EXECUTE (valida el rol adentro)`)
    }
    assert.equal(await rowCount(db, "anon", "select * from audit_logs"), "denegado")
    assert.equal(await rowCount(db, "anon", "select * from order_audit_events"), "denegado")
    // Auditoría completa: sólo super_admin (excepción documentada).
    assert.equal(await rowCount(db, "super_admin", "select * from audit_logs"), 1)
    assert.equal(await rowCount(db, "admin", "select * from audit_logs"), 0)
    assert.equal(await rowCount(db, "super_admin", "select * from order_audit_events"), 1)
    assert.equal(await rowCount(db, "admin", "select * from order_audit_events"), 1)
    assert.equal(await rowCount(db, "cliente", "select * from order_audit_events"), 0)
  } finally { await db.close() }
})
