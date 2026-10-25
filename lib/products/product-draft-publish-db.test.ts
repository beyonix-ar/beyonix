import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

// Migración 20261025100000 contra PostgreSQL real (PGlite): guardar un
// borrador incompleto, publicar estricto (variante activa vendible y
// descripción con texto visible) y un producto publicado que se queda sin
// stock se sigue pudiendo editar. Las funciones vigentes que la migración
// reutiliza se cargan tal cual desde sus migraciones.

const readMigration = (file: string) => readFileSync(join(process.cwd(), "supabase/migrations", file), "utf8")

function sqlFunction(file: string, name: string) {
  const source = readMigration(file)
  const start = source.indexOf(`create or replace function public.${name}(`)
  const end = source.indexOf("\n$$;", start)
  assert.ok(start >= 0 && end > start, `${name} en ${file}`)
  return source.slice(start, end + 4)
}

const currentFunctions = [
  sqlFunction("20261007100000_barcodes_parcels_dispatch.sql", "product_variant_listing_error"),
  sqlFunction("20261001140000_stock_required_only_on_activation.sql", "product_variant_activation_error"),
  sqlFunction("20261001140000_stock_required_only_on_activation.sql", "product_activation_error"),
  sqlFunction("20260808210000_product_activation_requirements.sql", "assert_product_can_activate"),
  sqlFunction("20260808210000_product_activation_requirements.sql", "assert_product_variant_can_activate"),
  sqlFunction("20261012120000_independent_product_variant_state.sql", "validate_variant_commercial_state"),
].join("\n\n")
const migration = readMigration("20261025100000_product_draft_save_publish_rules.sql")
const actor = "10000000-0000-4000-8000-000000000025"

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
    create function public.normalized_catalog_barcode(p_value text) returns text language sql immutable as $$
      select nullif(btrim(coalesce(p_value, '')), '')
    $$;

    create table public.categorias (id bigint primary key);
    insert into public.categorias values (1);
    create table public.productos (
      id bigint generated always as identity primary key,
      nombre text not null,
      sku text,
      slug text not null,
      descripcion text,
      video_url text,
      precio numeric not null default 0 check (precio >= 0),
      precio_anterior numeric,
      descuento numeric,
      categoria_id bigint references public.categorias(id),
      destacado boolean not null default false,
      activo boolean not null default false,
      peso_empaquetado_kg numeric check (peso_empaquetado_kg is null or peso_empaquetado_kg > 0),
      alto_paquete_cm numeric check (alto_paquete_cm is null or alto_paquete_cm > 0),
      ancho_paquete_cm numeric check (ancho_paquete_cm is null or ancho_paquete_cm > 0),
      largo_paquete_cm numeric check (largo_paquete_cm is null or largo_paquete_cm > 0),
      promo_event_id uuid,
      promo_original_precio numeric,
      promo_original_precio_anterior numeric,
      promo_original_descuento numeric,
      promo_original_cuotas_2_habilitadas boolean,
      promo_original_cuotas_3_habilitadas boolean,
      promo_original_cuotas_6_habilitadas boolean,
      cuotas_2_habilitadas boolean not null default false,
      cuotas_3_habilitadas boolean not null default false,
      cuotas_6_habilitadas boolean not null default false,
      cuotas_sin_recargo boolean not null default false,
      stock integer not null default 0
    );
    create table public.producto_variantes (
      id bigint generated always as identity primary key,
      producto_id bigint not null references public.productos(id) on delete cascade,
      nombre text not null,
      sku text,
      color_hex text not null,
      codigo_barra text,
      stock integer not null default 0,
      activo boolean not null default false,
      orden integer not null default 1,
      imagenes jsonb not null default '[]'::jsonb,
      peso_empaquetado_kg numeric,
      alto_paquete_cm numeric,
      ancho_paquete_cm numeric,
      largo_paquete_cm numeric
    );
    create table public.producto_especificaciones (
      id bigint generated always as identity primary key,
      producto_id bigint not null references public.productos(id) on delete cascade,
      icono text not null,
      texto text not null,
      activo boolean not null default true
    );

    -- Contrato mínimo del alta base (create_producto_completo): producto y
    -- variantes tal como llegan, sin la auditoría ni los permisos de sesión.
    create function public.create_producto_completo(
      p_producto jsonb, p_imagenes jsonb, p_variantes jsonb, p_especificaciones jsonb
    ) returns public.productos language plpgsql as $$
    declare v_product public.productos%rowtype;
    begin
      insert into public.productos (nombre, slug, descripcion, precio, categoria_id, activo)
      values (
        p_producto ->> 'nombre', p_producto ->> 'slug', p_producto ->> 'descripcion',
        coalesce((p_producto ->> 'precio')::numeric, 0),
        nullif(p_producto ->> 'categoria_id', '')::bigint,
        coalesce((p_producto ->> 'activo')::boolean, false)
      ) returning * into v_product;
      insert into public.producto_variantes (producto_id, nombre, color_hex, imagenes, activo, orden)
      select v_product.id, value ->> 'nombre', value ->> 'color_hex',
        coalesce(value -> 'imagenes', '[]'::jsonb), coalesce((value ->> 'activo')::boolean, false),
        coalesce((value ->> 'orden')::integer, 1)
      from jsonb_array_elements(coalesce(p_variantes, '[]'::jsonb));
      return v_product;
    end $$;
  `)
  await db.exec(currentFunctions)
  await db.exec(migration)
  await db.exec(`
    create constraint trigger validate_product_commercial_state
    after insert or update on public.productos
    deferrable initially deferred
    for each row execute function public.validate_product_commercial_state();
    create constraint trigger validate_variant_commercial_state
    after insert or update or delete on public.producto_variantes
    deferrable initially deferred
    for each row execute function public.validate_variant_commercial_state();
  `)
  await db.query("select set_config('request.jwt.claim.role', 'service_role', false)")
  return db
}

/** MALIBU listo para publicar salvo lo que se sobrescriba; variantes inactivas. */
async function insertProduct(db: PGlite, product: Record<string, unknown> = {}) {
  const values = {
    nombre: "AURICULAR INALAMBRICO MALIBU",
    slug: `malibu-${Math.random().toString(36).slice(2)}`,
    descripcion: "<p>Sonido envolvente</p>",
    precio: 20_000,
    categoria_id: 1,
    peso_empaquetado_kg: 0.3,
    alto_paquete_cm: 8,
    ancho_paquete_cm: 18,
    largo_paquete_cm: 20,
    ...product,
  }
  const { rows } = await db.query<{ id: number }>(
    `insert into public.productos (nombre, slug, descripcion, precio, categoria_id, peso_empaquetado_kg, alto_paquete_cm, ancho_paquete_cm, largo_paquete_cm)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
    [values.nombre, values.slug, values.descripcion, values.precio, values.categoria_id, values.peso_empaquetado_kg, values.alto_paquete_cm, values.ancho_paquete_cm, values.largo_paquete_cm],
  )
  const productId = rows[0].id
  await db.query("insert into public.producto_especificaciones (producto_id, icono, texto) values ($1, 'Headphones', 'Almohadillas que rodean las orejas')", [productId])
  const variants: number[] = []
  for (const [index, [nombre, sku, color, barcode, stock]] of ([
    ["NEGRO", "AUMN01", "#000000", "BX-AUR-000007", 6],
    ["ROSA", "AUMR01", "#ECA2A2", "BX-AUR-000009", 3],
  ] as const).entries()) {
    const variant = await db.query<{ id: number }>(
      `insert into public.producto_variantes (producto_id, nombre, sku, color_hex, codigo_barra, stock, orden, imagenes)
       values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb) returning id`,
      [productId, nombre, sku, color, barcode, stock, index + 1, JSON.stringify([`https://example.com/${sku}.png`])],
    )
    variants.push(variant.rows[0].id)
  }
  return { productId, variants }
}

const catalog = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  nombre: "AURICULAR INALAMBRICO MALIBU",
  slug: "auricular-inalambrico-malibu",
  descripcion: "<p>Sonido envolvente</p>",
  precio: 20000,
  activo: false,
  categoria_id: 1,
  peso_empaquetado_kg: 0.3,
  alto_paquete_cm: 8,
  ancho_paquete_cm: 18,
  largo_paquete_cm: 20,
  ...overrides,
})

const saveCatalog = (db: PGlite, productId: number, catalogJson: string, states: Array<{ id: number; active: boolean }>) =>
  db.query(
    "select public.update_product_commercial_configuration_atomic($1, $2::jsonb, 'AUMN01', $3::jsonb, $4)",
    [productId, catalogJson, JSON.stringify(states), actor],
  )

test("un borrador inactivo se guarda sin logística, categoría, descripción y con precio 0 (A-D)", async () => {
  const db = await setup()
  const { productId, variants } = await insertProduct(db)
  await saveCatalog(db, productId, catalog({
    descripcion: "", precio: 0, categoria_id: null,
    peso_empaquetado_kg: null, alto_paquete_cm: null, ancho_paquete_cm: null, largo_paquete_cm: null,
  }), variants.map((id) => ({ id, active: false })))
  const { rows } = await db.query<Record<string, unknown>>("select activo, precio, categoria_id, descripcion, peso_empaquetado_kg from public.productos where id = $1", [productId])
  assert.deepEqual(rows[0], { activo: false, precio: "0", categoria_id: null, descripcion: null, peso_empaquetado_kg: null })
})

test("alta de producto nuevo: borrador sin peso y medidas sí; activo sin peso y medidas no", async () => {
  const db = await setup()
  const draft = await db.query<{ id: number; peso_empaquetado_kg: string | null }>(
    "select id, peso_empaquetado_kg from public.create_producto_completo_v2($1::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb)",
    [JSON.stringify({ nombre: "BORRADOR", slug: "borrador", precio: 0, activo: false })],
  )
  assert.equal(draft.rows[0].peso_empaquetado_kg, null)
  await assert.rejects(
    db.query("select public.create_producto_completo_v2($1::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb)", [JSON.stringify({ nombre: "ACTIVO", slug: "activo", precio: 100, activo: true })]),
    /peso y las dimensiones del producto/,
  )
  // Lo cargado se valida igual (CHECK de la tabla).
  await assert.rejects(
    db.query("select public.create_producto_completo_v2($1::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb)", [JSON.stringify({ nombre: "MAL", slug: "mal", precio: 0, activo: false, peso_empaquetado_kg: -1 })]),
    /check constraint/,
  )
})

test("publicar sin variantes activas se bloquea; con una variante vendible se publica (I/J/H)", async () => {
  const db = await setup()
  const { productId, variants } = await insertProduct(db)
  await assert.rejects(
    db.query("select public.set_product_commercial_state_atomic($1, true, $2)", [productId, actor]),
    /Activá al menos una variante vendible antes de publicar el producto/,
  )
  // Una llamada directa al guardado comercial tampoco lo publica (U).
  await assert.rejects(
    saveCatalog(db, productId, catalog({ activo: true }), variants.map((id) => ({ id, active: false }))),
    /Activá al menos una variante vendible antes de publicar el producto/,
  )

  // Variante activa (el producto todavía es borrador) y después se publica.
  await saveCatalog(db, productId, catalog(), [{ id: variants[0], active: true }, { id: variants[1], active: false }])
  await db.query("select public.set_product_commercial_state_atomic($1, true, $2)", [productId, actor])
  const { rows } = await db.query<{ activo: boolean }>("select activo from public.productos where id = $1", [productId])
  assert.equal(rows[0].activo, true)
})

test("publicar y activar la variante en el mismo guardado funciona (H)", async () => {
  const db = await setup()
  const { productId, variants } = await insertProduct(db)
  await saveCatalog(db, productId, catalog({ activo: true }), [{ id: variants[0], active: true }, { id: variants[1], active: false }])
  const { rows } = await db.query<{ activo: boolean }>("select activo from public.productos where id = $1", [productId])
  assert.equal(rows[0].activo, true)
})

test("una descripción HTML visualmente vacía no publica (L)", async () => {
  const db = await setup()
  for (const descripcion of ["<p><br></p>", "<div></div>", "<p>&nbsp;</p>", "   ", `<p>${String.fromCharCode(160)}</p>`]) {
    const { productId, variants } = await insertProduct(db, { descripcion })
    await saveCatalog(db, productId, catalog({ descripcion }), [{ id: variants[0], active: true }, { id: variants[1], active: false }])
    await assert.rejects(
      db.query("select public.set_product_commercial_state_atomic($1, true, $2)", [productId, actor]),
      /Completá la descripción/,
      JSON.stringify(descripcion),
    )
  }
  const visible = await db.query<{ visible: boolean }>("select public.rich_description_has_visible_text('<ul><li>Bluetooth &amp; USB-C</li></ul>') as visible")
  assert.equal(visible.rows[0].visible, true)
})

test("un producto publicado que se queda sin stock se sigue editando y no se despublica (K/V)", async () => {
  const db = await setup()
  const { productId, variants } = await insertProduct(db)
  await saveCatalog(db, productId, catalog({ activo: true }), [{ id: variants[0], active: true }, { id: variants[1], active: false }])

  // Una venta agota la variante: el producto sigue activo ("Sin stock").
  await db.query("update public.producto_variantes set stock = 0 where id = $1", [variants[0]])
  await db.query("update public.productos set stock = 0 where id = $1", [productId])

  // Editar la ficha del publicado sin stock: antes fallaba con "necesita stock asignado".
  await saveCatalog(db, productId, catalog({ activo: true, precio: 21_500 }), [{ id: variants[0], active: true }, { id: variants[1], active: false }])
  await db.query("select public.update_product_catalog_atomic($1, $2::jsonb, 'AUMN01', $3)", [productId, catalog({ activo: true, precio: 22_000 }), actor])
  const { rows } = await db.query<{ activo: boolean; precio: string }>("select activo, precio from public.productos where id = $1", [productId])
  assert.deepEqual(rows[0], { activo: true, precio: "22000" })

  // Activar OTRA variante sin stock en ese producto sí exige stock.
  await db.query("update public.producto_variantes set stock = 0 where id = $1", [variants[1]])
  await assert.rejects(
    saveCatalog(db, productId, catalog({ activo: true }), [{ id: variants[0], active: true }, { id: variants[1], active: true }]),
    /necesita stock asignado/,
  )

  // El publicado sigue sin poder perder sus requisitos permanentes.
  await assert.rejects(
    saveCatalog(db, productId, catalog({ activo: true, descripcion: "<p><br></p>" }), [{ id: variants[0], active: true }, { id: variants[1], active: false }]),
    /Completá la descripción/,
  )
})
