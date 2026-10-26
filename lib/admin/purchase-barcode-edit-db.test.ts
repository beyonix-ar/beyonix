import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

// Migración 20261025110000 contra PostgreSQL real (PGlite) con los triggers
// vigentes de códigos: registro único, alias de grupo y asignación BEYONIX.
// Editar la compra cambia el código operativo de la variante, lo audita con el
// usuario y nunca toca la compra ni el stock.

const readMigration = (file: string) => readFileSync(join(process.cwd(), "supabase/migrations", file), "utf8")
function sqlFunction(file: string, name: string) {
  const source = readMigration(file)
  const start = source.indexOf(`create or replace function public.${name}(`)
  const end = source.indexOf("$$;", source.indexOf("$$", start) + 2)
  assert.ok(start >= 0 && end > start, `${name} en ${file}`)
  return source.slice(start, end + 3)
}

const barcodeFunctions = [
  sqlFunction("20260820120000_cost_catalog_barcode.sql", "normalized_catalog_barcode"),
  sqlFunction("20260820120000_cost_catalog_barcode.sql", "sync_variant_catalog_barcode_registry"),
  sqlFunction("20261008120000_catalog_random_dual_color_barcode_aliases.sql", "guard_catalog_barcode_registry_alias"),
  sqlFunction("20261007100000_barcodes_parcels_dispatch.sql", "beyonix_barcode_prefix"),
  sqlFunction("20261019100000_catalog_barcodes_required.sql", "next_beyonix_catalog_barcode"),
  sqlFunction("20261019100000_catalog_barcodes_required.sql", "ensure_catalog_barcode"),
].join("\n\n")
const migration = readMigration("20261025110000_purchase_variant_barcode_edit.sql")

const ACTOR = "10000000-0000-4000-8000-000000000031"
const PURCHASE_ROSA = "cd8f46b4-d954-4226-af0d-8a094399e5fb"
const PURCHASE_NEGRO = "de7eb2f4-e135-40e2-9ff4-66f795268d1c"

async function setup() {
  const db = new PGlite()
  await db.exec(`
    create schema auth;
    create role anon;
    create role authenticated;
    create role service_role;
    create function auth.role() returns text language sql stable as $$
      select current_setting('request.jwt.claim.role', true)
    $$;
    create sequence public.beyonix_variant_barcode_seq start 9000;

    create table public.profiles (id uuid primary key, email text);
    insert into public.profiles values ('${ACTOR}', 'compras@beyonix.test');
    create table public.productos (id bigint primary key, nombre text not null, codigo_barra text, stock integer not null default 0);
    create table public.producto_variantes (
      id bigint primary key,
      producto_id bigint not null references public.productos(id),
      nombre text not null,
      codigo_barra text,
      stock integer not null default 0
    );
    create table public.product_cost_entries (
      id uuid primary key, product_id bigint, variant_id bigint,
      quantity integer not null, unit_cost numeric not null, total_cost numeric not null
    );
    create table public.audit_logs (
      id bigint generated always as identity primary key,
      table_name text, action text, record_id text, actor_user_id uuid, actor_email text,
      before_data jsonb, after_data jsonb, created_at timestamptz not null default now()
    );
    create table public.catalog_barcode_registry (
      normalized_barcode text primary key,
      product_id bigint unique references public.productos(id) on delete cascade,
      variant_id bigint unique references public.producto_variantes(id) on delete cascade,
      check ((product_id is not null)::integer + (variant_id is not null)::integer = 1)
    );
    create table public.catalog_barcode_aliases (
      normalized_barcode text primary key,
      product_id bigint not null references public.productos(id),
      variant_id bigint references public.producto_variantes(id)
    );
  `)
  await db.exec(barcodeFunctions)
  await db.exec(`
    create trigger guard_catalog_barcode_registry_alias before insert or update on public.catalog_barcode_registry
      for each row execute function public.guard_catalog_barcode_registry_alias();
    create trigger ensure_variant_catalog_barcode before insert or update of codigo_barra on public.producto_variantes
      for each row execute function public.ensure_catalog_barcode();
    create trigger sync_variant_catalog_barcode_registry after insert or delete or update of codigo_barra on public.producto_variantes
      for each row execute function public.sync_variant_catalog_barcode_registry();
  `)
  await db.exec(migration)
  await db.exec(`
    insert into public.productos (id, nombre) values (9, 'AURICULAR INALAMBRICO MALIBU'), (13, 'AURICULAR INALAMBRICO CZ');
    insert into public.producto_variantes (id, producto_id, nombre, codigo_barra, stock) values
      (9, 9, 'NEGRO', '7790001000017', 6),
      (15, 9, 'ROSA', 'BX-AUR-000009', 3),
      (16, 9, 'VERDE', 'BX-AUR-000011', 3);
    insert into public.product_cost_entries values
      ('${PURCHASE_NEGRO}', 9, 9, 6, 12790, 76740),
      ('${PURCHASE_ROSA}', 9, 15, 3, 12790, 38370);
    insert into public.catalog_barcode_aliases (normalized_barcode, product_id) values ('7790000099999', 13);
  `)
  await db.query("select set_config('request.jwt.claim.role', 'service_role', false)")
  return db
}

const edit = (db: PGlite, barcode: string | null, purchase = PURCHASE_ROSA, variant = 15) =>
  db.query<{ codigo_barra: string }>(
    "select codigo_barra from public.update_variant_barcode_from_purchase(9, $1, $2::uuid, $3, $4::uuid)",
    [variant, purchase, barcode, ACTOR],
  )

const snapshot = async (db: PGlite) => ({
  purchases: (await db.query("select id, quantity, unit_cost, total_cost from public.product_cost_entries order by id")).rows,
  stock: (await db.query("select id, stock from public.producto_variantes order by id")).rows,
})

test("cambiar el código: la variante queda con el nuevo, se audita con usuario y no toca compra ni stock (B/E/F/G)", async () => {
  const db = await setup()
  const before = await snapshot(db)
  const { rows } = await edit(db, "  7791234500017 ")
  assert.equal(rows[0].codigo_barra, "7791234500017")

  const variant = await db.query<{ codigo_barra: string }>("select codigo_barra from public.producto_variantes where id = 15")
  assert.equal(variant.rows[0].codigo_barra, "7791234500017")
  const registry = await db.query<{ variant_id: number }>("select variant_id from public.catalog_barcode_registry where normalized_barcode = '7791234500017'")
  assert.equal(Number(registry.rows[0].variant_id), 15)
  assert.equal((await db.query("select 1 from public.catalog_barcode_registry where normalized_barcode = 'BX-AUR-000009'")).rows.length, 0, "el código anterior queda libre")

  const audit = await db.query<{ record_id: string; actor_user_id: string; actor_email: string; before_data: Record<string, unknown>; after_data: Record<string, unknown>; created_at: Date }>(
    "select record_id, actor_user_id, actor_email, before_data, after_data, created_at from public.audit_logs",
  )
  assert.equal(audit.rows.length, 1)
  assert.deepEqual(
    { ...audit.rows[0], created_at: audit.rows[0].created_at instanceof Date },
    {
      record_id: "15",
      actor_user_id: ACTOR,
      actor_email: "compras@beyonix.test",
      before_data: { codigo_barra: "BX-AUR-000009" },
      after_data: { codigo_barra: "7791234500017", reason: "purchase_barcode_edit", productId: 9, purchaseId: PURCHASE_ROSA },
      created_at: true,
    },
  )
  assert.deepEqual(await snapshot(db), before, "compras (cantidad/costo) y stock intactos")
})

test("un código de otra variante o de un grupo se rechaza y no cambia nada (C)", async () => {
  const db = await setup()
  await assert.rejects(edit(db, "7790001000017"), /El código de barra 7790001000017 ya está asignado a otro artículo/)
  await assert.rejects(edit(db, "7790000099999"), /ya está asignado a otro artículo/)
  const variant = await db.query<{ codigo_barra: string }>("select codigo_barra from public.producto_variantes where id = 15")
  assert.equal(variant.rows[0].codigo_barra, "BX-AUR-000009")
  assert.equal((await db.query("select 1 from public.audit_logs")).rows.length, 0)
})

test("mismo código: idempotente, sin cambio ni auditoría (D)", async () => {
  const db = await setup()
  const { rows } = await edit(db, "BX-AUR-000009")
  assert.equal(rows[0].codigo_barra, "BX-AUR-000009")
  assert.equal((await db.query("select 1 from public.audit_logs")).rows.length, 0)
})

test("vacío: se asigna un código BEYONIX nuevo (política ensure_catalog_barcode) y se audita", async () => {
  const db = await setup()
  const { rows } = await edit(db, "   ")
  assert.match(rows[0].codigo_barra, /^BX-AUR-\d{6,}$/)
  assert.notEqual(rows[0].codigo_barra, "BX-AUR-000009")
  const audit = await db.query<{ after_data: { codigo_barra: string } }>("select after_data from public.audit_logs")
  assert.equal(audit.rows[0].after_data.codigo_barra, rows[0].codigo_barra)
})

test("la compra tiene que ser de esa variante; formato inválido rechazado", async () => {
  const db = await setup()
  await assert.rejects(edit(db, "7791234500017", PURCHASE_NEGRO, 15), /La compra no corresponde a esa variante/)
  await assert.rejects(edit(db, "código con ñ"), /ASCII imprimible/)
  await db.query("select set_config('request.jwt.claim.role', 'authenticated', false)")
  await assert.rejects(edit(db, "7791234500017"), /No tenés permisos/)
})
