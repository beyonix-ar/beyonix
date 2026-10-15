import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

// Migración 20261015130000 contra PostgreSQL real (PGlite): revisión de la
// ficha comercial (lost updates), alta de variante desde Compras atómica,
// borrar-o-archivar variantes y fusión que no pierde la ficha del absorbido
// (reproducción del incidente LEGATUS del 15/10/2026). Las RPC preexistentes
// que la migración reutiliza se simulan con su contrato mínimo.

const readMigration = (file: string) => readFileSync(join(process.cwd(), "supabase/migrations", file), "utf8")
const migration = readMigration("20261015130000_variant_parent_integrity.sql")

/** Extrae la definición vigente de una función de un archivo de migración. */
function sqlFunction(file: string, name: string) {
  const source = readMigration(file)
  const start = source.indexOf(`create or replace function public.${name}(`)
  const end = source.indexOf("\n$$;", start)
  assert.ok(start >= 0 && end > start, `${name} en ${file}`)
  return source.slice(start, end + 4)
}
// Compras reales: la operación atómica nueva reutiliza estas funciones tal
// como están en producción (sólo la proyección de stock se simula).
const purchaseFunctions = [
  sqlFunction("20260821090000_purchase_requires_variant_when_product_has_variants.sql", "save_product_purchase_atomic"),
  sqlFunction("20260801104000_inventory_single_source_and_repair.sql", "save_product_purchase_idempotent"),
].join("\n\n")
const actor = "10000000-0000-4000-8000-000000000015"

const triggeredTables: Record<string, string[]> = {
  product_cost_entries: ["link_cost_entry_to_shared_catalog", "sync_cost_catalog_product_sku", "refresh_inventory_after_purchase"],
  business_expenses: ["refresh_inventory_after_expense"],
  external_sales: ["lock_inventory_external_sale", "refresh_inventory_after_external_sale", "zz_reject_negative_external_sale"],
  mercadolibre_sales: ["lock_inventory_mercadolibre_sale", "refresh_inventory_after_mercadolibre_sale", "zz_reject_negative_mercadolibre_sale"],
  inventory_return_movements: ["refresh_inventory_after_return_movement", "validate_inventory_return_condition", "guard_inventory_return_variant_link"],
  inventory_operation_log: ["prevent_inventory_operation_log_mutation"],
}

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
    create function public.noop_trigger() returns trigger language plpgsql as $$
      begin return coalesce(new, old); end $$;

    create table public.categorias (id bigint primary key);
    insert into public.categorias values (1), (2);
    create table public.productos (
      id bigint generated always as identity primary key,
      nombre text not null,
      sku text,
      slug text not null,
      descripcion text,
      video_url text,
      precio numeric not null default 0,
      precio_anterior numeric,
      descuento numeric,
      categoria_id bigint references public.categorias(id),
      destacado boolean not null default false,
      activo boolean not null default false,
      peso_empaquetado_kg numeric,
      alto_paquete_cm numeric,
      ancho_paquete_cm numeric,
      largo_paquete_cm numeric,
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
      codigo_barra text,
      stock integer not null default 0,
      imagen_principal text,
      created_from_costs boolean not null default false
    );
    create table public.producto_variantes (
      id bigint generated always as identity primary key,
      producto_id bigint not null references public.productos(id) on delete cascade,
      nombre text not null,
      sku text,
      color_hex text not null,
      codigo_barra text unique,
      stock integer not null default 0,
      activo boolean not null default false,
      orden integer not null default 1,
      imagenes jsonb not null default '[]'::jsonb
    );
    create table public.producto_especificaciones (
      id bigint generated always as identity primary key,
      producto_id bigint not null references public.productos(id) on delete cascade,
      icono text not null,
      texto text not null,
      orden integer not null default 1
    );
    create table public.imagenes_producto (
      id bigint generated always as identity primary key,
      producto_id bigint not null references public.productos(id) on delete cascade,
      url text not null,
      orden integer not null default 1
    );
    create table public.product_pricing (
      product_id bigint primary key references public.productos(id) on delete cascade,
      pricing_mode text not null
    );
    create table public.audit_logs (
      id bigint generated always as identity primary key,
      table_name text, action text, record_id text, actor_user_id uuid,
      before_data jsonb, after_data jsonb, created_at timestamptz default now()
    );
    -- Índices de identidad (se recalculan solos: no cuentan como historial).
    create table public.catalog_sku_registry (
      normalized_sku text primary key,
      variant_id bigint references public.producto_variantes(id) on delete cascade
    );
    create table public.catalog_barcode_registry (
      normalized_barcode text primary key,
      variant_id bigint references public.producto_variantes(id) on delete cascade
    );
    create table public.catalog_barcode_aliases (
      barcode text primary key,
      variant_id bigint references public.producto_variantes(id) on delete cascade
    );
    create table public.product_cost_entries (
      id uuid primary key default gen_random_uuid(),
      product_id bigint references public.productos(id),
      variant_id bigint,
      article_name text, sku text, purchase_date date,
      quantity integer, received_quantity integer, reception_status text,
      unit_cost numeric, freight_cost numeric, tax_cost numeric, commission_cost numeric, other_cost numeric,
      supplier text, document_type text, document_number text, payment_method text, notes text,
      created_by uuid, idempotency_key text unique
    );
    create table public.business_expenses (id bigint generated always as identity primary key, product_id bigint);
    create table public.external_sales (id bigint generated always as identity primary key, product_id bigint, variant_id bigint references public.producto_variantes(id) on delete restrict);
    create table public.mercadolibre_sales (id bigint generated always as identity primary key, product_id bigint);
    create table public.inventory_return_movements (id bigint generated always as identity primary key, product_id bigint, variant_id bigint references public.producto_variantes(id) on delete restrict);
    create table public.inventory_variant_allocations (product_id bigint, variant_id bigint references public.producto_variantes(id), quantity integer);
    create table public.stock_reservations (id bigint generated always as identity primary key, product_id bigint, variant_id bigint references public.producto_variantes(id) on delete cascade);
    create table public.orden_items (id bigint generated always as identity primary key, producto_id bigint, variante_id bigint, reserved_variant_id bigint);
    create table public.inventory_operation_log (
      id bigint generated always as identity primary key,
      product_id bigint,
      variant_id bigint references public.producto_variantes(id) on delete restrict,
      movement_type text, quantity integer, origin text, effective_at timestamptz,
      actor_user_id uuid, actor_process text, idempotency_key text unique,
      source_table text, source_id text, document_reference text, metadata jsonb
    );
    create table public.order_preparation_scans (id bigint generated always as identity primary key, physical_variant_id bigint references public.producto_variantes(id) on delete set null);

    create function public.refresh_inventory_stock(bigint) returns void language plpgsql as $$ begin return; end $$;
    create function public.normalized_catalog_sku(text) returns text language sql immutable as $$
      select upper(nullif(btrim($1), ''))
    $$;
    -- Índice de identidad SKU: como en producción, cada variante con SKU lo
    -- registra y un SKU repetido corta con violación de unicidad.
    create function public.register_variant_sku() returns trigger language plpgsql as $$
    begin
      if public.normalized_catalog_sku(new.sku) is not null then
        insert into public.catalog_sku_registry values (public.normalized_catalog_sku(new.sku), new.id);
      end if;
      return new;
    end $$;
    create trigger register_variant_sku after insert on public.producto_variantes
      for each row execute function public.register_variant_sku();
    -- Artículo nuevo de Compras: producto base inactivo, sin ficha.
    create function public.ensure_cost_catalog_product(p_name text, p_sku text) returns bigint language plpgsql as $$
    declare v_id bigint;
    begin
      insert into public.productos (nombre, slug, sku, created_from_costs)
      values (p_name, 'compra-' || md5(coalesce(p_sku, p_name)), p_sku, true)
      returning id into v_id;
      return v_id;
    end $$;
    -- Proyección de stock (en producción, refresh_inventory_after_purchase).
    -- Fallas inyectables por proveedor para probar el rollback total.
    create function public.test_purchase_faults() returns trigger language plpgsql as $$
    begin
      if new.supplier = 'FALLA' then
        raise exception 'Fallo simulado al registrar la compra.';
      end if;
      return new;
    end $$;
    create trigger test_purchase_faults before insert on public.product_cost_entries
      for each row execute function public.test_purchase_faults();
    create function public.test_project_purchase_stock() returns trigger language plpgsql as $$
    begin
      if new.variant_id is not null and coalesce(new.received_quantity, 0) > 0
         and coalesce(new.supplier, '') <> 'SIN_STOCK' then
        update public.producto_variantes set stock = stock + new.received_quantity where id = new.variant_id;
        update public.productos set stock = stock + new.received_quantity where id = new.product_id;
      end if;
      return new;
    end $$;
    create trigger test_project_purchase_stock after insert on public.product_cost_entries
      for each row execute function public.test_project_purchase_stock();
    create function public.assert_product_can_activate(bigint) returns void language plpgsql as $$ begin return; end $$;
    create function public.sync_product_primary_variant_image(bigint) returns void language plpgsql as $$ begin return; end $$;
    create function public.create_product_variant_with_allocation_v2(
      p_product_id bigint, p_name text, p_sku text, p_color_hex text,
      p_images jsonb, p_quantity integer, p_actor_id uuid,
      p_peso numeric, p_alto numeric, p_ancho numeric, p_largo numeric
    ) returns public.producto_variantes language plpgsql as $$
    declare v public.producto_variantes;
    begin
      insert into public.producto_variantes (producto_id, nombre, sku, color_hex, imagenes, orden)
      values (p_product_id, p_name, p_sku, p_color_hex, p_images,
        (select coalesce(max(orden), 0) + 1 from public.producto_variantes where producto_id = p_product_id))
      returning * into v;
      return v;
    end $$;
    create function public.generate_beyonix_variant_barcode(p_product_id bigint, p_variant_id bigint, p_actor_id uuid)
    returns public.producto_variantes language plpgsql as $$
    declare v public.producto_variantes;
    begin
      update public.producto_variantes set codigo_barra = 'BX-TEST-' || p_variant_id
      where id = p_variant_id and producto_id = p_product_id returning * into v;
      return v;
    end $$;
    create function public.set_product_variant_state_atomic(p_product_id bigint, p_variant_id bigint, p_active boolean, p_actor_id uuid)
    returns public.producto_variantes language plpgsql as $$
    declare v public.producto_variantes;
    begin
      update public.producto_variantes set activo = p_active
      where id = p_variant_id and producto_id = p_product_id returning * into v;
      return v;
    end $$;
    -- Guardado comercial: reemplaza la ficha con lo que manda el editor.
    create function public.update_product_commercial_configuration_with_pricing_atomic(
      p_product_id bigint, p_catalog jsonb, p_primary_sku text, p_variant_states jsonb,
      p_actor_id uuid, p_pricing_mode text, p_target_margin_percent numeric
    ) returns jsonb language plpgsql as $$
    declare v public.productos;
    begin
      update public.productos
      set descripcion = nullif(p_catalog ->> 'descripcion', ''),
          precio = (p_catalog ->> 'precio')::numeric
      where id = p_product_id returning * into v;
      return jsonb_build_object('product', to_jsonb(v), 'variants', '[]'::jsonb);
    end $$;
  `)
  for (const [table, triggers] of Object.entries(triggeredTables)) {
    for (const trigger of triggers) {
      await db.exec(`create trigger ${trigger} before insert or update on public.${table} for each row execute function public.noop_trigger();`)
    }
  }
  await db.exec(purchaseFunctions)
  await db.exec(migration)
  await db.query("select set_config('request.jwt.claim.role', 'service_role', false)")
  return db
}

const FULL_DESCRIPTION = "<h2>AURICULARES INALÁMBRICOS LEGATUS BLUETOOTH</h2><p>Disfrutá de tu música favorita sin cables.</p>"

async function completeProduct(db: PGlite, name = "AURICULAR INALAMBRICO LEGATUS") {
  const { rows } = await db.query<{ id: number }>(
    `insert into public.productos (nombre, slug, descripcion, precio, precio_anterior, descuento, categoria_id,
       destacado, activo, peso_empaquetado_kg, alto_paquete_cm, ancho_paquete_cm, largo_paquete_cm)
     values ($1, 'compra-f2df54f884fdf8e662b5f1f9', $2, 20900, 26000, 20, 1, true, true, 0.3, 9, 19, 22)
     returning id`,
    [name, FULL_DESCRIPTION],
  )
  const id = rows[0].id
  await db.query(
    `insert into public.producto_especificaciones (producto_id, icono, texto, orden) values
       ($1, 'Bluetooth', 'Conexión inalámbrica', 1), ($1, 'BatteryCharging', 'Batería recargable', 2)`,
    [id],
  )
  await db.query("insert into public.product_pricing values ($1, 'manual')", [id])
  await db.query("insert into public.imagenes_producto (producto_id, url) values ($1, 'https://img/legatus.png')", [id])
  const variant = await db.query<{ id: number }>(
    "insert into public.producto_variantes (producto_id, nombre, sku, color_hex, codigo_barra, stock, activo) values ($1, 'AZUL', 'ALEGA01', '#C2D8EB', '7796350519950', 4, true) returning id",
    [id],
  )
  return { productId: id, variantId: variant.rows[0].id }
}

async function productRow(db: PGlite, id: number) {
  return (await db.query<Record<string, unknown>>("select * from public.productos where id = $1", [id])).rows[0]
}

/** Ficha comercial del padre: todo lo que una operación de variante nunca puede tocar. */
async function parentSnapshot(db: PGlite, id: number) {
  const product = await productRow(db, id)
  const specs = (await db.query("select icono, texto, orden from public.producto_especificaciones where producto_id = $1 order by id", [id])).rows
  const pricing = (await db.query("select pricing_mode from public.product_pricing where product_id = $1", [id])).rows
  const images = (await db.query("select url from public.imagenes_producto where producto_id = $1", [id])).rows
  return { product, specs, pricing, images }
}

async function variants(db: PGlite, productId: number) {
  return (await db.query<{ id: number; nombre: string; activo: boolean; codigo_barra: string | null }>(
    "select id, nombre, activo, codigo_barra from public.producto_variantes where producto_id = $1 order by id",
    [productId],
  )).rows
}

test("alta de variante desde Compras: válida sólo agrega la variante; con código inválido no deja nada a medias", async () => {
  const db = await setup()
  try {
    const { productId } = await completeProduct(db)
    const before = await parentSnapshot(db, productId)

    // Válida: sólo cambia la colección de variantes.
    const created = await db.query<{ id: number; codigo_barra: string }>(
      "select id, codigo_barra from public.create_product_variant_for_purchase($1, 'ROSA', 'ALEGRO01', '#ECA2A2', '7790000000001', false, $2)",
      [productId, actor],
    )
    assert.equal(created.rows[0].codigo_barra, "7790000000001")
    assert.deepEqual(await parentSnapshot(db, productId), before, "la ficha del padre queda idéntica")
    assert.deepEqual((await variants(db, productId)).map((variant) => variant.nombre), ["AZUL", "ROSA"])

    // Error a mitad del alta (el código ya es de otra variante): rollback total.
    await assert.rejects(
      db.query(
        "select public.create_product_variant_for_purchase($1, 'NEGRO', 'ALEGNE01', '#000000', '7796350519950', false, $2)",
        [productId, actor],
      ),
      /duplicate|unique/i,
    )
    assert.deepEqual((await variants(db, productId)).map((variant) => variant.nombre), ["AZUL", "ROSA"], "no queda variante parcial")
    assert.deepEqual(await parentSnapshot(db, productId), before, "el padre sigue idéntico tras el error")

    // Código generado en la misma transacción.
    const generated = await db.query<{ codigo_barra: string }>(
      "select codigo_barra from public.create_product_variant_for_purchase($1, 'NEGRO', 'ALEGNE01', '#000000', null, true, $2)",
      [productId, actor],
    )
    assert.match(generated.rows[0].codigo_barra, /^BX-TEST-/)
    await assert.rejects(
      db.query("select public.create_product_variant_for_purchase($1, 'VERDE', null, '#00FF00', '123', true, $2)", [productId, actor]),
      /no ambos/,
    )
  } finally {
    await db.close()
  }
})

test("revisión de la ficha: las variantes no la mueven y un guardado con datos viejos se rechaza sin tocar nada", async () => {
  const db = await setup()
  try {
    const { productId, variantId } = await completeProduct(db)
    const initial = Number((await productRow(db, productId)).catalog_revision)

    // Editar una variante y el stock/imagen derivados no cambian la revisión del padre.
    await db.query("update public.producto_variantes set nombre = 'CELESTE', sku = 'ALEGA02' where id = $1", [variantId])
    await db.query("update public.productos set stock = 9, imagen_principal = 'https://img/otra.png' where id = $1", [productId])
    assert.equal(Number((await productRow(db, productId)).catalog_revision), initial)

    // Pestaña A guarda con la revisión correcta.
    const saved = await db.query<{ result: { product: { catalog_revision: number; precio: number } } }>(
      "select public.update_product_commercial_configuration_checked($1, $2::jsonb, null, '[]'::jsonb, $3, 'manual', null, $4) as result",
      [productId, JSON.stringify({ descripcion: FULL_DESCRIPTION, precio: 21900 }), actor, initial],
    )
    const afterSave = saved.rows[0].result.product
    assert.equal(Number(afterSave.precio), 21900)
    assert.equal(Number(afterSave.catalog_revision), initial + 1, "el guardado devuelve la revisión nueva")

    // Pestaña B (abierta antes) intenta guardar un formulario vacío y viejo.
    const before = await parentSnapshot(db, productId)
    await assert.rejects(
      db.query(
        "select public.update_product_commercial_configuration_checked($1, $2::jsonb, null, '[]'::jsonb, $3, 'manual', null, $4)",
        [productId, JSON.stringify({ descripcion: "", precio: 0 }), actor, initial],
      ),
      (error: Error & { code?: string }) => error.code === "40001" && /cambió desde que abriste el editor/.test(error.message),
    )
    assert.deepEqual(await parentSnapshot(db, productId), before, "la respuesta vieja no borra datos actuales")
  } finally {
    await db.close()
  }
})

test("borrar variante: con historial se archiva; sin actividad se elimina", async () => {
  const db = await setup()
  try {
    const { productId, variantId } = await completeProduct(db)
    const before = await parentSnapshot(db, productId)

    // Con historial (stock, código, compra, ventas, movimientos): nunca se destruye.
    await db.query("insert into public.product_cost_entries (product_id, variant_id) values ($1, $2)", [productId, variantId])
    await db.query("insert into public.orden_items (producto_id, variante_id) values ($1, $2)", [productId, variantId])
    await db.query("insert into public.inventory_operation_log (product_id, variant_id) values ($1, $2)", [productId, variantId])
    const archived = await db.query<{ result: { mode: string; reasons: string[] } }>(
      "select public.delete_or_archive_product_variant($1, $2, $3) as result",
      [productId, variantId, actor],
    )
    assert.equal(archived.rows[0].result.mode, "archived")
    for (const reason of ["tiene stock", "tiene código de barras vinculado", "tiene compras registradas", "tiene ventas web", "tiene movimientos de inventario"]) {
      assert.ok(archived.rows[0].result.reasons.includes(reason), reason)
    }
    const kept = await variants(db, productId)
    assert.equal(kept.length, 1, "la variante sigue existiendo")
    assert.equal(kept[0].activo, false, "quedó archivada (inactiva)")
    assert.equal((await db.query("select 1 from public.inventory_operation_log where variant_id = $1", [variantId])).rows.length, 1, "el historial no se desvincula")

    // Sólo una reserva (cascade) o un escaneo (set null) también cuentan como historial.
    const reserved = await db.query<{ id: number }>(
      "insert into public.producto_variantes (producto_id, nombre, sku, color_hex) values ($1, 'ROJO', 'ALEGRJ01', '#FF0000') returning id",
      [productId],
    )
    await db.query("insert into public.stock_reservations (product_id, variant_id) values ($1, $2)", [productId, reserved.rows[0].id])
    const reservedResult = await db.query<{ result: { mode: string; reasons: string[] } }>(
      "select public.delete_or_archive_product_variant($1, $2, $3) as result",
      [productId, reserved.rows[0].id, actor],
    )
    assert.equal(reservedResult.rows[0].result.mode, "archived")
    assert.deepEqual(reservedResult.rows[0].result.reasons, ["tiene reservas de stock"])

    // Sin ninguna actividad (sólo su SKU en el índice de identidad): se elimina.
    const orphan = await db.query<{ id: number }>(
      "insert into public.producto_variantes (producto_id, nombre, sku, color_hex) values ($1, 'COLOR #E18579', 'ALEGR01', '#E18579') returning id",
      [productId],
    )
    assert.equal((await db.query("select 1 from public.catalog_sku_registry where variant_id = $1", [orphan.rows[0].id])).rows.length, 1, "su SKU está en el índice de identidad")
    const deleted = await db.query<{ result: { mode: string } }>(
      "select public.delete_or_archive_product_variant($1, $2, $3) as result",
      [productId, orphan.rows[0].id, actor],
    )
    assert.equal(deleted.rows[0].result.mode, "deleted")
    assert.equal((await db.query("select 1 from public.producto_variantes where id = $1", [orphan.rows[0].id])).rows.length, 0)

    assert.deepEqual(await parentSnapshot(db, productId), before, "borrar o archivar variantes nunca toca el padre")
    await assert.rejects(
      db.query("select public.delete_or_archive_product_variant($1, $2, $3)", [productId, 999999, actor]),
      /ya no existe/,
    )
  } finally {
    await db.close()
  }
})

test("LEGATUS: fusionar el producto completo dentro del que creó Compras ya no vacía la ficha", async () => {
  const db = await setup()
  try {
    // Producto 6 completo (con variante AZUL) y producto 12 vacío creado por una compra (ROSA).
    const complete = await completeProduct(db)
    const empty = await db.query<{ id: number }>(
      "insert into public.productos (nombre, slug, sku, created_from_costs) values ('AURICULAR INALAMBRICO LEGATUS', 'compra-043fd2e68c9398a42462ca9f', 'ALEGRO01', true) returning id",
    )
    const keepId = empty.rows[0].id
    await db.query("insert into public.producto_variantes (producto_id, nombre, sku, color_hex, stock) values ($1, 'ROSA', 'ALEGRO01', '#ECA2A2', 2)", [keepId])
    await db.query("insert into public.product_cost_entries (product_id, variant_id) values ($1, $2)", [complete.productId, complete.variantId])

    await db.query("select public.merge_catalog_products($1, $2, $3)", [keepId, complete.productId, actor])

    const kept = await productRow(db, keepId)
    assert.equal(kept.descripcion, FULL_DESCRIPTION)
    assert.equal(Number(kept.precio), 20900)
    assert.equal(Number(kept.precio_anterior), 26000)
    assert.equal(Number(kept.descuento), 20)
    assert.equal(Number(kept.categoria_id), 1)
    assert.equal(kept.destacado, true)
    assert.deepEqual(
      [kept.peso_empaquetado_kg, kept.alto_paquete_cm, kept.ancho_paquete_cm, kept.largo_paquete_cm].map(Number),
      [0.3, 9, 19, 22],
    )
    assert.equal(kept.sku, null, "con variantes, el SKU vive en cada variante")
    const keptFicha = await parentSnapshot(db, keepId)
    assert.deepEqual(keptFicha.specs.map((spec) => (spec as { texto: string }).texto), ["Conexión inalámbrica", "Batería recargable"])
    assert.deepEqual(keptFicha.pricing, [{ pricing_mode: "manual" }])
    assert.deepEqual(keptFicha.images, [{ url: "https://img/legatus.png" }])
    assert.deepEqual((await variants(db, keepId)).map((variant) => variant.nombre), ["AZUL", "ROSA"])
    assert.equal((await db.query("select 1 from public.productos where id = $1", [complete.productId])).rows.length, 0)

    const audit = await db.query<{ before_data: Record<string, unknown> }>(
      "select before_data from public.audit_logs where after_data ->> 'reason' = 'merge_catalog_products'",
    )
    const snapshot = audit.rows[0].before_data
    assert.equal((snapshot.absorbedProduct as { descripcion: string }).descripcion, FULL_DESCRIPTION, "snapshot completo del absorbido")
    assert.equal((snapshot.absorbedSpecifications as unknown[]).length, 2)
  } finally {
    await db.close()
  }
})

test("fusión: lo que el producto conservado ya tiene cargado nunca se pisa", async () => {
  const db = await setup()
  try {
    const absorbed = await completeProduct(db, "PRODUCTO A")
    const keep = await db.query<{ id: number }>(
      `insert into public.productos (nombre, slug, descripcion, precio, categoria_id, peso_empaquetado_kg, alto_paquete_cm, ancho_paquete_cm, largo_paquete_cm)
       values ('PRODUCTO B', 'producto-b', '<p>Descripción propia</p>', 15000, 2, 1, 2, 3, 4) returning id`,
    )
    const keepId = keep.rows[0].id
    await db.query("insert into public.producto_especificaciones (producto_id, icono, texto) values ($1, 'Star', 'Propia')", [keepId])
    await db.query("select public.merge_catalog_products($1, $2, $3)", [keepId, absorbed.productId, actor])
    const kept = await productRow(db, keepId)
    assert.equal(kept.descripcion, "<p>Descripción propia</p>")
    assert.equal(Number(kept.precio), 15000)
    assert.equal(Number(kept.categoria_id), 2)
    assert.deepEqual(
      [kept.peso_empaquetado_kg, kept.alto_paquete_cm, kept.ancho_paquete_cm, kept.largo_paquete_cm].map(Number),
      [1, 2, 3, 4],
    )
    const specs = (await db.query<{ texto: string }>("select texto from public.producto_especificaciones where producto_id = $1", [keepId])).rows
    assert.deepEqual(specs.map((spec) => spec.texto), ["Propia"], "no mezcla especificaciones si el conservado ya tiene")
  } finally {
    await db.close()
  }
})

// --- Variante nueva + compra: una sola operación ------------------------------

const purchaseBody = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  purchase_date: "2026-10-15",
  quantity: 2,
  received_quantity: 2,
  reception_status: "recibida",
  unit_cost: 8852,
  freight_cost: 0,
  supplier: "OKEYROSARIO",
  ...overrides,
})
const variantBody = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  name: "ROSA", sku: "ALEGRO01", color_hex: "#ECA2A2", barcode: null, generate_barcode: false, ...overrides,
})

type AtomicResult = { replayed: boolean; productId: number; variantId: number; purchase: { id: string; variant_id: number; received_quantity: number } }

async function createWithPurchase(db: PGlite, productId: number | null, key: string, variant = variantBody(), purchase = purchaseBody(), productName: string | null = null) {
  const { rows } = await db.query<{ result: AtomicResult }>(
    "select public.create_variant_and_purchase($1, $2, $3::jsonb, $4::jsonb, $5, $6) as result",
    [productId, productName, variant, purchase, actor, key],
  )
  return rows[0].result
}

/** Todo lo que una alta fallida no puede dejar: variantes, SKU, códigos, compras, movimientos y stock. */
async function footprint(db: PGlite) {
  const count = async (sql: string) => Number((await db.query<{ total: string }>(sql)).rows[0].total)
  return {
    variants: await count("select count(*) as total from public.producto_variantes"),
    skus: await count("select count(*) as total from public.catalog_sku_registry"),
    barcodes: await count("select count(*) as total from public.producto_variantes where codigo_barra is not null"),
    purchases: await count("select count(*) as total from public.product_cost_entries"),
    movements: await count("select count(*) as total from public.inventory_operation_log"),
    products: await count("select count(*) as total from public.productos"),
    stock: await count("select coalesce(sum(stock), 0) as total from public.producto_variantes"),
  }
}

/** Ficha comercial del padre sin el stock (proyección que sí debe moverse con la compra). */
async function commercialFicha(db: PGlite, id: number) {
  const { product, ...rest } = await parentSnapshot(db, id)
  const ficha = Object.fromEntries(Object.entries(product).filter(([key]) => key !== "stock"))
  return { ficha, ...rest }
}

test("variante nueva + compra válida: crea variante, SKU, código, compra, costo, stock y movimiento; el padre no cambia", async () => {
  const db = await setup()
  try {
    const { productId } = await completeProduct(db)
    const before = await commercialFicha(db, productId)
    const result = await createWithPurchase(db, productId, "purchase:atomic-ok-0001", variantBody({ barcode: "7790000000001" }))
    assert.equal(result.replayed, false)
    assert.equal(result.productId, productId)

    const variant = (await db.query<{ nombre: string; sku: string; codigo_barra: string; stock: number }>(
      "select nombre, sku, codigo_barra, stock from public.producto_variantes where id = $1", [result.variantId],
    )).rows[0]
    assert.deepEqual(variant, { nombre: "ROSA", sku: "ALEGRO01", codigo_barra: "7790000000001", stock: 2 })
    const purchase = (await db.query<{ variant_id: number; unit_cost: string; received_quantity: number; idempotency_key: string; sku: string }>(
      "select variant_id, unit_cost, received_quantity, idempotency_key, sku from public.product_cost_entries",
    )).rows
    assert.equal(purchase.length, 1)
    assert.equal(Number(purchase[0].variant_id), result.variantId)
    assert.equal(Number(purchase[0].unit_cost), 8852, "costo registrado")
    assert.equal(purchase[0].idempotency_key, "purchase:atomic-ok-0001")
    const movement = (await db.query<{ variant_id: number; quantity: number; movement_type: string }>(
      "select variant_id, quantity, movement_type from public.inventory_operation_log",
    )).rows
    assert.deepEqual(movement.map((row) => [Number(row.variant_id), row.quantity, row.movement_type]), [[result.variantId, 2, "purchase"]])
    assert.equal((await db.query("select 1 from public.catalog_sku_registry where normalized_sku = 'ALEGRO01'")).rows.length, 1)
    const audit = (await db.query<{ after_data: { idempotencyKey: string; purchaseId: string } }>(
      "select after_data from public.audit_logs where after_data ->> 'reason' = 'create_variant_and_purchase'",
    )).rows
    assert.equal(audit.length, 1, "auditoría de la operación")
    assert.equal(audit[0].after_data.idempotencyKey, "purchase:atomic-ok-0001")
    assert.equal(audit[0].after_data.purchaseId, result.purchase.id)

    assert.deepEqual(await commercialFicha(db, productId), before, "ni precio, ni descripción, ni categoría, ni logística, ni revisión")
  } finally {
    await db.close()
  }
})

test("artículo nuevo de Compras: producto, variante y compra nacen juntos o no nace nada", async () => {
  const db = await setup()
  try {
    const result = await createWithPurchase(db, null, "purchase:new-article-01", variantBody({ sku: "AURNEW01", name: "NEGRO", color_hex: "#000000" }), purchaseBody(), "AURICULAR NUEVO")
    const product = await productRow(db, result.productId)
    assert.equal(product.nombre, "AURICULAR NUEVO")
    assert.equal(product.created_from_costs, true)
    assert.equal((await variants(db, result.productId)).length, 1)

    const before = await footprint(db)
    await assert.rejects(
      createWithPurchase(db, null, "purchase:new-article-02", variantBody({ sku: "AURNEW02", name: "BLANCO", color_hex: "#FFFFFF" }), purchaseBody({ supplier: "FALLA" }), "OTRO ARTICULO"),
      /Fallo simulado/,
    )
    assert.deepEqual(await footprint(db), before, "ni producto, ni variante, ni SKU, ni compra")
  } finally {
    await db.close()
  }
})

test("rollback total: falla la compra, falla el código, SKU duplicado o stock/costo inválido", async () => {
  const db = await setup()
  try {
    const { productId } = await completeProduct(db)
    const ficha = await commercialFicha(db, productId)
    const before = await footprint(db)
    const failures: Array<[string, () => Promise<unknown>, RegExp]> = [
      ["la compra falla después de crear la variante", () => createWithPurchase(db, productId, "purchase:fail-purchase", variantBody(), purchaseBody({ supplier: "FALLA" })), /Fallo simulado/],
      ["el código ya pertenece a otra variante", () => createWithPurchase(db, productId, "purchase:fail-barcode", variantBody({ barcode: "7796350519950" })), /duplicate|unique/i],
      ["escanear y generar a la vez", () => createWithPurchase(db, productId, "purchase:fail-both-codes", variantBody({ barcode: "123", generate_barcode: true })), /no ambos/],
      ["SKU duplicado", () => createWithPurchase(db, productId, "purchase:fail-sku", variantBody({ sku: "alega01" })), /ya pertenece/],
      ["sin SKU", () => createWithPurchase(db, productId, "purchase:fail-no-sku", variantBody({ sku: "" })), /necesita un SKU/],
      ["color inválido", () => createWithPurchase(db, productId, "purchase:fail-color", variantBody({ color_hex: "rosa" })), /color/],
      ["costo faltante", () => createWithPurchase(db, productId, "purchase:fail-cost", variantBody(), purchaseBody({ unit_cost: 0 })), /costo unitario/],
      ["cantidad inválida", () => createWithPurchase(db, productId, "purchase:fail-qty", variantBody(), purchaseBody({ quantity: 0 })), /mayor que cero/],
      ["compra anulada", () => createWithPurchase(db, productId, "purchase:fail-void", variantBody(), purchaseBody({ reception_status: "anulada" })), /anulada/],
      ["el stock no quedó proyectado", () => createWithPurchase(db, productId, "purchase:fail-stock", variantBody(), purchaseBody({ supplier: "SIN_STOCK" })), /no coincide con lo recibido/],
      ["producto inexistente", () => createWithPurchase(db, 999999, "purchase:fail-product"), /ya no existe/],
    ]
    for (const [label, run, message] of failures) {
      await assert.rejects(run(), message, label)
      assert.deepEqual(await footprint(db), before, `${label}: no queda nada`)
    }
    assert.deepEqual(await commercialFicha(db, productId), ficha, "el padre sigue idéntico")

    // Después de un rollback, la misma clave puede reintentarse y crea una sola vez.
    const retried = await createWithPurchase(db, productId, "purchase:fail-purchase")
    assert.equal(retried.replayed, false)
    assert.equal((await footprint(db)).variants, before.variants + 1)
  } finally {
    await db.close()
  }
})

test("idempotencia: doble click, timeout con reintento o respuesta perdida no duplican nada", async () => {
  const db = await setup()
  try {
    const { productId } = await completeProduct(db)
    const key = "purchase:double-click-01"
    const first = await createWithPurchase(db, productId, key)
    const afterFirst = await footprint(db)
    // Segundo click / reintento tras timeout / respuesta perdida: misma clave.
    const second = await createWithPurchase(db, productId, key)
    const third = await createWithPurchase(db, productId, key)
    assert.equal(second.replayed, true)
    assert.equal(third.replayed, true)
    assert.equal(second.variantId, first.variantId)
    assert.equal(second.purchase.id, first.purchase.id)
    assert.deepEqual(await footprint(db), afterFirst, "una variante, una compra, un movimiento, el stock una sola vez")
    assert.equal(Number((await db.query<{ stock: number }>("select stock from public.producto_variantes where id = $1", [first.variantId])).rows[0].stock), 2)

    // Una clave usada por una compra común no puede reutilizarse para crear una variante.
    await db.query(
      "select public.save_product_purchase_idempotent($1::jsonb, $2, $3)",
      [JSON.stringify({ product_id: productId, variant_id: first.variantId, purchase_date: "2026-10-15", quantity: 1, reception_status: "recibida", unit_cost: 9000 }), actor, "purchase:plain-0001"],
    )
    await assert.rejects(
      db.query("select public.create_variant_and_purchase($1, null, $2::jsonb, $3::jsonb, $4, $5)", [productId, variantBody({ sku: "OTRO01", name: "VERDE", color_hex: "#00AA00" }), purchaseBody(), actor, "purchase:plain-0001"]),
      /ya se usó para otra compra/,
    )
  } finally {
    await db.close()
  }
})

test("compra sobre una variante existente: registra la compra sin crear variantes", async () => {
  const db = await setup()
  try {
    const { productId, variantId } = await completeProduct(db)
    const before = await footprint(db)
    await db.query(
      "select public.save_product_purchase_idempotent($1::jsonb, $2, $3)",
      [JSON.stringify({ product_id: productId, variant_id: variantId, purchase_date: "2026-10-15", quantity: 3, reception_status: "recibida", unit_cost: 9000 }), actor, "purchase:existing-0001"],
    )
    const after = await footprint(db)
    assert.equal(after.variants, before.variants, "no hay variante nueva")
    assert.equal(after.purchases, before.purchases + 1)
    assert.equal(after.stock, before.stock + 3)
  } finally {
    await db.close()
  }
})

test("guardar la ficha no borra la promoción activa de un evento (antes la mandaba en null)", async () => {
  const db = await setup()
  try {
    const { productId } = await completeProduct(db)
    const eventId = "0b0b0b0b-0000-4000-8000-000000000001"
    // Evento masivo en curso: precio promocional y precio original bloqueados.
    await db.query(
      "update public.productos set precio = 16720, promo_event_id = $2, promo_original_precio = 20900, promo_original_precio_anterior = 26000, promo_original_descuento = 20 where id = $1",
      [productId, eventId],
    )
    const catalog = {
      nombre: "AURICULAR INALAMBRICO LEGATUS", slug: "auricular-legatus", descripcion: FULL_DESCRIPTION,
      precio: 16720, activo: false, categoria_id: 1, destacado: true,
      peso_empaquetado_kg: 0.3, alto_paquete_cm: 9, ancho_paquete_cm: 19, largo_paquete_cm: 22,
    }
    await db.query("select public.update_product_catalog_atomic($1, $2::jsonb, null, $3)", [productId, JSON.stringify(catalog), actor])
    let product = await productRow(db, productId)
    assert.equal(product.promo_event_id, eventId, "el evento sigue siendo dueño del precio")
    assert.equal(Number(product.promo_original_precio), 20900, "el precio original sobrevive para restaurarlo al terminar")
    assert.equal(Number(product.promo_original_precio_anterior), 26000)
    assert.equal(Number(product.promo_original_descuento), 20)

    // Sólo una escritura explícita (el propio evento) puede liberarla.
    await db.query(
      "select public.update_product_catalog_atomic($1, $2::jsonb, null, $3)",
      [productId, JSON.stringify({ ...catalog, promo_event_id: null, promo_original_precio: null }), actor],
    )
    product = await productRow(db, productId)
    assert.equal(product.promo_event_id, null)
    assert.equal(product.promo_original_precio, null)
  } finally {
    await db.close()
  }
})