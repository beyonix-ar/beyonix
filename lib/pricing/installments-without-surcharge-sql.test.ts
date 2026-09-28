import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

// Migración "Mismo precio en contado y cuotas" ejecutada de verdad (PGlite)
// sobre las columnas que usan las dos RPC de la ficha de Productos:
// default OFF para lo existente, alta y edición persisten el flag, y una
// edición que no manda la clave nunca lo apaga.

const MIGRATION = readFileSync(
  new URL("../../supabase/migrations/20260929100000_product_installments_without_surcharge.sql", import.meta.url),
  "utf8",
)

async function setup() {
  const db = new PGlite()
  await db.exec(`
    create schema auth;
    create function auth.role() returns text language sql stable
      as $$ select coalesce(current_setting('request.jwt.claim.role', true), 'anon') $$;
    create role anon; create role authenticated; create role service_role;
    create table categorias (id bigint primary key);
    create table productos (
      id bigserial primary key, nombre text, sku text, slug text, descripcion text, video_url text,
      precio numeric, precio_anterior numeric, descuento numeric,
      cuotas_2_habilitadas boolean not null default false,
      cuotas_3_habilitadas boolean not null default false,
      cuotas_6_habilitadas boolean not null default false,
      promo_event_id uuid, promo_original_precio numeric, promo_original_precio_anterior numeric,
      promo_original_descuento numeric, promo_original_cuotas_2_habilitadas boolean,
      promo_original_cuotas_3_habilitadas boolean, promo_original_cuotas_6_habilitadas boolean,
      categoria_id bigint, destacado boolean, activo boolean,
      peso_empaquetado_kg numeric, alto_paquete_cm numeric, ancho_paquete_cm numeric, largo_paquete_cm numeric
    );
    create table producto_variantes (
      id bigserial primary key, producto_id bigint references productos(id), orden integer not null default 0,
      sku text, peso_empaquetado_kg numeric, alto_paquete_cm numeric, ancho_paquete_cm numeric, largo_paquete_cm numeric
    );
    create function assert_product_can_activate(bigint) returns void language sql as $$ select $$;
    -- Alta base (cuerpo real en 20260827200001): acá sólo inserta la fila.
    create function create_producto_completo(p_producto jsonb, p_imagenes jsonb, p_variantes jsonb, p_especificaciones jsonb)
    returns productos language plpgsql as $$
    declare v productos%rowtype;
    begin
      insert into productos(nombre, slug, precio, cuotas_2_habilitadas, cuotas_3_habilitadas, cuotas_6_habilitadas, activo)
      values (p_producto->>'nombre', p_producto->>'slug', (p_producto->>'precio')::numeric,
        coalesce((p_producto->>'cuotas_2_habilitadas')::boolean, false),
        coalesce((p_producto->>'cuotas_3_habilitadas')::boolean, false),
        coalesce((p_producto->>'cuotas_6_habilitadas')::boolean, false), false)
      returning * into v;
      return v;
    end $$;
    insert into categorias values (1);
    insert into productos(nombre, slug, precio, cuotas_6_habilitadas, activo) values ('Auricular Ñandú', 'auricular', 50000, true, false);
  `)
  await db.exec(MIGRATION)
  await db.query("select set_config('request.jwt.claim.role','service_role',false)")
  return db
}

const flag = async (db: PGlite, id: number) =>
  (await db.query<{ v: boolean }>("select cuotas_sin_recargo v from productos where id=$1", [id])).rows[0].v

const ACTOR = "30000000-0000-4000-8000-000000000001"
const LOGISTICS = { peso_empaquetado_kg: 1, alto_paquete_cm: 10, ancho_paquete_cm: 10, largo_paquete_cm: 10 }
const catalog = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ nombre: "Auricular Ñandú", slug: "auricular", precio: 50000, activo: false, cuotas_6_habilitadas: true, ...LOGISTICS, ...extra })

test("columna nueva: NOT NULL default false; los productos existentes quedan OFF", async () => {
  const db = await setup()
  assert.equal(await flag(db, 1), false)
  const column = await db.query<{ is_nullable: string; column_default: string }>(
    "select is_nullable, column_default from information_schema.columns where table_name='productos' and column_name='cuotas_sin_recargo'",
  )
  assert.deepEqual(column.rows[0], { is_nullable: "NO", column_default: "false" })
})

test("edición (update_product_catalog_atomic): activa, conserva si no viene la clave, desactiva", async () => {
  const db = await setup()
  const update = (payload: string) =>
    db.query("select update_product_catalog_atomic(1, $1::jsonb, null, $2)", [payload, ACTOR])

  await update(catalog({ cuotas_sin_recargo: true }))
  assert.equal(await flag(db, 1), true)
  await update(catalog())
  assert.equal(await flag(db, 1), true, "un payload sin la clave (otra vía de guardado) nunca apaga el flag")
  await update(catalog({ cuotas_sin_recargo: false }))
  assert.equal(await flag(db, 1), false)
  // El resto del guardado sigue igual (cuotas, nombre con tildes).
  const row = (await db.query<{ nombre: string; cuotas_6_habilitadas: boolean }>("select nombre, cuotas_6_habilitadas from productos where id=1")).rows[0]
  assert.deepEqual(row, { nombre: "Auricular Ñandú", cuotas_6_habilitadas: true })
})

test("edición sigue exigiendo service_role", async () => {
  const db = await setup()
  await db.query("select set_config('request.jwt.claim.role','authenticated',false)")
  await assert.rejects(
    db.query("select update_product_catalog_atomic(1, $1::jsonb, null, $2)", [catalog({ cuotas_sin_recargo: true }), ACTOR]),
    /No tenés permisos/,
  )
  assert.equal(await flag(db, 1), false)
})

test("alta (create_producto_completo_v2): persiste el flag; por defecto OFF", async () => {
  const db = await setup()
  const create = async (extra: Record<string, unknown>) =>
    (await db.query<{ id: number }>(
      "select (create_producto_completo_v2($1::jsonb)).id as id",
      [JSON.stringify({ nombre: "Cámara Ñ", slug: `camara-${Object.keys(extra).length}`, precio: 90000, cuotas_3_habilitadas: true, ...LOGISTICS, ...extra })],
    )).rows[0].id

  assert.equal(await flag(db, await create({ cuotas_sin_recargo: true })), true)
  assert.equal(await flag(db, await create({})), false)
})
