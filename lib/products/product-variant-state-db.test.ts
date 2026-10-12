import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

const migration = readFileSync(
  join(process.cwd(), "supabase/migrations/20261012120000_independent_product_variant_state.sql"),
  "utf8",
)
const actor = "10000000-0000-4000-8000-000000000003"

async function setup() {
  const db = new PGlite()
  await db.exec(`
    create schema auth;
    create role anon;
    create function auth.role() returns text language sql stable as $$
      select current_setting('request.jwt.claim.role', true)
    $$;
    create table public.productos (
      id bigint generated always as identity primary key,
      activo boolean not null default true
    );
    create table public.producto_variantes (
      id bigint generated always as identity primary key,
      producto_id bigint not null references public.productos(id),
      activo boolean not null default false,
      orden integer not null default 1
    );
    alter table public.productos enable row level security;
    alter table public.producto_variantes enable row level security;
    create policy productos_public_select on public.productos
      for select to anon using (activo);
    create policy producto_variantes_public_select on public.producto_variantes
      for select using (activo);
    grant usage on schema public to anon;
    grant select on public.productos, public.producto_variantes to anon;

    create function public.assert_product_variant_can_activate(bigint, bigint, boolean)
      returns void language plpgsql as $$ begin return; end $$;
    create function public.assert_product_can_activate(bigint)
      returns void language plpgsql as $$ begin return; end $$;
    create function public.product_listing_error(bigint, boolean)
      returns text language sql as $$ select null::text $$;
    create function public.product_variant_listing_error(bigint, bigint, boolean, boolean)
      returns text language sql as $$ select null::text $$;
    create function public.sync_product_primary_variant_image(bigint)
      returns void language plpgsql as $$ begin return; end $$;
    create function public.update_product_catalog_atomic(bigint, jsonb, text, uuid)
      returns public.productos language plpgsql as $$
    declare result public.productos;
    begin
      update public.productos set activo = ($2 ->> 'activo')::boolean
      where id = $1 returning * into result;
      return result;
    end $$;
    create function public.sync_product_variant_commercial_state()
      returns trigger language plpgsql as $$
    begin
      if not new.activo then
        update public.producto_variantes set activo = false where producto_id = new.id;
      end if;
      return null;
    end $$;
    create trigger sync_product_variant_commercial_state
      after insert or update of activo on public.productos
      for each row execute function public.sync_product_variant_commercial_state();
  `)
  const existing = await db.query<{ id: number }>(
    "insert into public.productos default values returning id",
  )
  const existingProductId = existing.rows[0].id
  await db.exec(migration)
  await db.exec(`
    create constraint trigger validate_product_commercial_state
      after insert or update on public.productos
      deferrable initially deferred
      for each row execute function public.validate_product_commercial_state();
    create constraint trigger validate_variant_commercial_state
      after insert or update on public.producto_variantes
      deferrable initially deferred
      for each row execute function public.validate_variant_commercial_state();
  `)
  await db.query("select set_config('request.jwt.claim.role', 'service_role', false)")
  return { db, existingProductId }
}

async function product(db: PGlite, active?: boolean) {
  const sql = active === undefined
    ? "insert into public.productos default values returning id, activo"
    : "insert into public.productos (activo) values ($1) returning id, activo"
  const rows = active === undefined
    ? (await db.query<{ id: number; activo: boolean }>(sql)).rows
    : (await db.query<{ id: number; activo: boolean }>(sql, [active])).rows
  return rows[0]
}

async function variant(db: PGlite, productId: number, active: boolean) {
  const { rows } = await db.query<{ id: number; activo: boolean }>(
    "insert into public.producto_variantes (producto_id, activo) values ($1, $2) returning id, activo",
    [productId, active],
  )
  return rows[0]
}

test("producto y variante tienen estados independientes en las RPC y en lectura pública", async (t) => {
  const { db, existingProductId } = await setup()
  try {
    const inactive = await product(db, false)
    const active = await product(db, true)
    const inactiveVariant = await variant(db, inactive.id, false)
    const activeVariant = await variant(db, active.id, false)

    async function toggle(productId: number, variantId: number, next: boolean) {
      const { rows } = await db.query<{ activo: boolean }>(
        "select activo from public.set_product_variant_state_atomic($1, $2, $3, $4)",
        [productId, variantId, next, actor],
      )
      assert.equal(rows[0].activo, next)
      const saved = await db.query<{ activo: boolean }>(
        "select activo from public.productos where id = $1",
        [productId],
      )
      assert.equal(saved.rows[0].activo, productId === active.id)
    }

    await t.test("caso 1: producto inactivo, variante inactiva → activar", async () => {
      await toggle(inactive.id, inactiveVariant.id, true)
    })
    await t.test("caso 2: producto inactivo, variante activa → desactivar", async () => {
      await toggle(inactive.id, inactiveVariant.id, false)
    })
    await t.test("caso 3: producto activo, variante inactiva → activar", async () => {
      await toggle(active.id, activeVariant.id, true)
    })
    await t.test("caso 4: producto activo, variante activa → desactivar", async () => {
      await toggle(active.id, activeVariant.id, false)
    })
    await t.test("caso 5: producto nuevo inactivo por defecto", async () => {
      assert.equal((await product(db)).activo, false)
    })
    await t.test("caso 6: producto activo existente conserva su estado y sus variantes", async () => {
      assert.equal((await db.query<{ activo: boolean }>(
        "select activo from public.productos where id = $1", [existingProductId],
      )).rows[0].activo, true)
      await toggle(active.id, activeVariant.id, true)
      await db.query("update public.productos set activo = false where id = $1", [active.id])
      assert.equal((await db.query<{ activo: boolean }>(
        "select activo from public.producto_variantes where id = $1", [activeVariant.id],
      )).rows[0].activo, true)
      await db.query("update public.productos set activo = true where id = $1", [active.id])
      assert.equal((await db.query<{ activo: boolean }>(
        "select activo from public.productos where id = $1", [active.id],
      )).rows[0].activo, true)
    })
    await t.test("caso 7: producto inactivo con variante activa no es público", async () => {
      await toggle(inactive.id, inactiveVariant.id, true)
      await db.exec("set role anon")
      try {
        assert.equal((await db.query("select id from public.productos where id = $1", [inactive.id])).rows.length, 0)
        assert.equal((await db.query("select id from public.producto_variantes where id = $1", [inactiveVariant.id])).rows.length, 0)
      } finally {
        await db.exec("reset role")
      }
    })
    await t.test("caso 8: producto activo con variante inactiva no la expone", async () => {
      await toggle(active.id, activeVariant.id, false)
      await db.exec("set role anon")
      try {
        assert.equal((await db.query("select id from public.productos where id = $1", [active.id])).rows.length, 1)
        assert.equal((await db.query("select id from public.producto_variantes where id = $1", [activeVariant.id])).rows.length, 0)
      } finally {
        await db.exec("reset role")
      }
    })
    await t.test("guardado conjunto conserva estados independientes", async () => {
      const states = JSON.stringify([{ id: inactiveVariant.id, active: true }])
      await db.query(
        "select public.update_product_commercial_configuration_atomic($1, $2::jsonb, $3, $4::jsonb, $5)",
        [inactive.id, JSON.stringify({ activo: false }), null, states, actor],
      )
      assert.equal((await db.query<{ activo: boolean }>(
        "select activo from public.producto_variantes where id = $1", [inactiveVariant.id],
      )).rows[0].activo, true)

      await db.query(
        "select public.update_product_commercial_configuration_atomic($1, $2::jsonb, $3, $4::jsonb, $5)",
        [active.id, JSON.stringify({ activo: true }), null,
          JSON.stringify([{ id: activeVariant.id, active: false }]), actor],
      )
      assert.equal((await db.query<{ activo: boolean }>(
        "select activo from public.productos where id = $1", [active.id],
      )).rows[0].activo, true)
    })
    await t.test("reordenar no activa automáticamente variantes", async () => {
      const second = await variant(db, active.id, false)
      await db.query(
        "select id from public.reorder_product_variants_atomic($1, $2::jsonb, $3)",
        [active.id, JSON.stringify([second.id, activeVariant.id]), actor],
      )
      assert.deepEqual((await db.query<{ activo: boolean }>(
        "select activo from public.producto_variantes where producto_id = $1 order by orden", [active.id],
      )).rows.map((row) => row.activo), [false, false])
    })
  } finally {
    await db.close()
  }
})
