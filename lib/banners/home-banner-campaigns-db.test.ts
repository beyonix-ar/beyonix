import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { PGlite } from "@electric-sql/pglite"

// 20261123130000 contra el esquema real de site_banner_items (baseline de
// producción): vigencia en la base, RLS sin campañas futuras ni columnas
// internas, respaldo heredado sólo sin filas propias, restricciones y bucket.

const MIGRATION = readFileSync("supabase/migrations/20261123130000_home_banner_campaigns.sql", "utf8")

const BASE_SCHEMA = `
  create role anon; create role authenticated; create role service_role;
  create schema auth; create table auth.users (id uuid primary key);
  create function public.current_user_role() returns text language sql stable as $$ select nullif(current_setting('test.role', true), '') $$;
  grant execute on function public.current_user_role() to anon, authenticated;
  create table public.site_banner_items (
    id uuid primary key default gen_random_uuid(),
    placement text not null default 'products',
    image_url text not null,
    alt_text text not null default '',
    active boolean not null default true,
    sort_order integer not null default 0,
    created_by uuid references auth.users(id) on delete set null,
    updated_by uuid references auth.users(id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint site_banner_items_placement_check check (placement = 'products')
  );
  create index site_banner_items_placement_active_order_idx on public.site_banner_items (placement, active, sort_order, created_at);
  alter table public.site_banner_items enable row level security;
  create policy "Anyone can read active banner items" on public.site_banner_items for select to anon, authenticated using (active = true);
  create policy "Admins can manage banner items" on public.site_banner_items to authenticated
    using (public.current_user_role() in ('admin', 'super_admin')) with check (public.current_user_role() in ('admin', 'super_admin'));
  grant all on public.site_banner_items to service_role;
  grant select on public.site_banner_items to anon;
  grant select, insert, update, delete on public.site_banner_items to authenticated;
  grant usage on schema public to anon, authenticated;
`

const PRODUCTS_URL = "https://proyecto.supabase.co/storage/v1/object/public/site-banners/products/1.jpg"
const HOME_URL = "https://proyecto.supabase.co/storage/v1/object/public/site-banners/home/1.webp"

async function setup({ storage = false } = {}) {
  const db = new PGlite()
  await db.exec(BASE_SCHEMA)
  if (storage) {
    await db.exec(`create schema storage;
      create table storage.buckets (id text primary key, public boolean, file_size_limit bigint, allowed_mime_types text[]);
      insert into storage.buckets(id, public) values ('site-banners', true), ('otro', true);`)
  }
  // Dos banners de Productos existentes (como en producción): sin fechas.
  await db.exec(`insert into public.site_banner_items(id, placement, image_url, alt_text, active, sort_order, created_at) values
    ('00000000-0000-4000-8000-000000000001', 'products', '${PRODUCTS_URL}', 'Banner A', true, 1, now() - interval '30 days'),
    ('00000000-0000-4000-8000-000000000002', 'products', '${PRODUCTS_URL}', 'Banner B', true, 0, now() - interval '20 days');`)
  await db.exec(MIGRATION)
  return db
}

type PublicResult = { banners: Array<{ id: string; placement: string; alt_text: string }>; hasItems: boolean; nextChangeAt: string | null; serverNow: string }
const publicBanners = async (db: PGlite, placement: string) =>
  (await db.query<{ result: PublicResult | null }>("select public.get_public_site_banners($1) result", [placement])).rows[0].result

async function insertHome(db: PGlite, id: string, values: { active?: boolean; sort?: number; starts?: string | null; ends?: string | null; created?: string; name?: string }) {
  await db.query(`insert into public.site_banner_items(id, placement, campaign_name, image_url, alt_text, active, sort_order, starts_at, ends_at, created_at)
    values ($1, 'home', $2, $3, $2, $4, $5, now() + $6::interval, now() + $7::interval, now() + $8::interval)`,
  [id, values.name ?? id, HOME_URL, values.active ?? true, values.sort ?? 0, values.starts ?? null, values.ends ?? null, values.created ?? "-1 day"])
}

const uuid = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`

test("Productos sigue igual: mismos banners, mismo orden, sin fechas; la ubicación tiene filas propias", async () => {
  const db = await setup()
  const result = await publicBanners(db, "products")
  assert.deepEqual(result?.banners.map((banner) => banner.alt_text), ["Banner B", "Banner A"])
  assert.equal(result?.hasItems, true)
  assert.equal(result?.nextChangeAt, null)
  // Desactivados todos: la ubicación sigue teniendo filas (el respaldo heredado no reaparece).
  await db.exec("update public.site_banner_items set active = false where placement = 'products'")
  const off = await publicBanners(db, "products")
  assert.deepEqual([off?.banners.length, off?.hasItems], [0, true])
  assert.equal(await publicBanners(db, "otra"), null, "ubicación desconocida")
})

test("Home: sólo la campaña vigente de mayor prioridad; futuras, vencidas y desactivadas nunca salen; próximo cambio", async () => {
  const db = await setup()
  const empty = await publicBanners(db, "home")
  assert.deepEqual([empty?.banners.length, empty?.hasItems, empty?.nextChangeAt], [0, false, null], "sin campañas")

  await insertHome(db, uuid(1), { name: "Permanente", sort: 10 })
  await insertHome(db, uuid(2), { name: "Navidad", sort: 0, starts: "-1 hour", ends: "+2 hours" })
  await insertHome(db, uuid(3), { name: "Año nuevo", sort: -1, starts: "+3 hours", ends: "+1 day" })
  await insertHome(db, uuid(4), { name: "Vencida", sort: -5, starts: "-3 days", ends: "-1 day" })
  await insertHome(db, uuid(5), { name: "Apagada", sort: -9, active: false })
  // Mismo orden y misma fecha de alta que Navidad: desempata el id (uuid(2) < uuid(6)).
  await db.query(`insert into public.site_banner_items(id, placement, campaign_name, image_url, active, sort_order, starts_at, ends_at, created_at)
    select $1, 'home', 'Empate', image_url, true, sort_order, starts_at, ends_at, created_at from public.site_banner_items where id = $2`, [uuid(6), uuid(2)])

  const result = await publicBanners(db, "home")
  assert.deepEqual(result?.banners.map((banner) => banner.id), [uuid(2)], "una sola campaña, la de mayor prioridad")
  assert.equal(result?.hasItems, true)
  const ends = (await db.query<{ value: string }>("select (ends_at)::text value from public.site_banner_items where id = $1", [uuid(2)])).rows[0].value
  assert.equal(Date.parse(result?.nextChangeAt ?? ""), Date.parse(ends), "el próximo cambio es el fin de la vigente")
  assert.ok(!JSON.stringify(result).includes("Año nuevo"), "nada de la campaña futura, salvo la hora del cambio")
  assert.ok(!JSON.stringify(result).includes("campaign_name"), "sin nombre interno")

  // Vencida la de Navidad, queda la permanente como alternativa.
  await db.query("update public.site_banner_items set ends_at = now() - interval '1 second' where id in ($1, $2)", [uuid(2), uuid(6)])
  assert.deepEqual((await publicBanners(db, "home"))?.banners.map((banner) => banner.id), [uuid(1)])
  // Empezó la de Año nuevo (mayor prioridad que la permanente).
  await db.query("update public.site_banner_items set starts_at = now() where id = $1", [uuid(3)])
  assert.deepEqual((await publicBanners(db, "home"))?.banners.map((banner) => banner.id), [uuid(3)], "el inicio es inclusivo")
  // Fin exclusivo: ends_at = now() ya no se ve.
  await db.query("update public.site_banner_items set ends_at = now() where id = $1", [uuid(3)])
  assert.deepEqual((await publicBanners(db, "home"))?.banners.map((banner) => banner.id), [uuid(1)], "el fin es exclusivo")
})

test("RLS: el público ve sólo filas vigentes y nunca columnas internas; Admin sigue administrando", async () => {
  const db = await setup()
  await insertHome(db, uuid(1), { name: "Vigente", starts: "-1 hour", ends: "+1 hour" })
  await insertHome(db, uuid(2), { name: "Futura secreta", starts: "+1 day" })
  await insertHome(db, uuid(3), { name: "Apagada", active: false })
  for (const role of ["anon", "authenticated"]) {
    await db.exec(`set role ${role}`)
    const rows = (await db.query<{ id: string }>("select id from public.site_banner_items where placement = 'home'")).rows
    assert.deepEqual(rows.map((row) => row.id), [uuid(1)], `${role}: sin futuras ni desactivadas`)
    await assert.rejects(db.query("select campaign_name from public.site_banner_items"), /permission denied/, `${role}: sin nombre interno`)
    await assert.rejects(db.query("select * from public.site_banner_items"), /permission denied/)
    const viaRpc = (await db.query<{ result: PublicResult }>("select public.get_public_site_banners('home') result")).rows[0].result
    assert.deepEqual(viaRpc.banners.map((banner) => banner.id), [uuid(1)], `${role}: la función pública también`)
    await db.exec("reset role")
  }
  // Un usuario común no escribe; Admin sí (la política de administración no cambió).
  await db.exec("set role authenticated")
  await assert.rejects(db.query(`insert into public.site_banner_items(placement, image_url) values ('home', '${HOME_URL}')`), /row-level security/)
  await db.exec("set test.role = 'admin'")
  await db.query(`insert into public.site_banner_items(placement, campaign_name, image_url) values ('home', 'Admin', '${HOME_URL}')`)
  await db.exec("reset test.role; reset role")
  assert.equal((await db.query("select 1 from public.site_banner_items where campaign_name = 'Admin'")).rows.length, 1)
})

test("restricciones: ubicación, fin posterior al inicio, destino y nombre; sin borrar nada; idempotente", async () => {
  const db = await setup()
  const bad = [
    `insert into public.site_banner_items(placement, image_url) values ('checkout', '${HOME_URL}')`,
    `insert into public.site_banner_items(placement, image_url, starts_at, ends_at) values ('home', '${HOME_URL}', now(), now())`,
    `insert into public.site_banner_items(placement, image_url, starts_at, ends_at) values ('home', '${HOME_URL}', now(), now() - interval '1 minute')`,
    `insert into public.site_banner_items(placement, image_url, destination_url) values ('home', '${HOME_URL}', 'javascript:alert(1)')`,
    `insert into public.site_banner_items(placement, image_url, destination_url) values ('home', '${HOME_URL}', '//evil.example')`,
    `insert into public.site_banner_items(placement, image_url, destination_url) values ('home', '${HOME_URL}', 'http://beyonix.com.ar')`,
    `insert into public.site_banner_items(placement, image_url, mobile_image_url) values ('home', '${HOME_URL}', 'data:image/png;base64,AAAA')`,
    `insert into public.site_banner_items(placement, image_url, campaign_name) values ('home', '${HOME_URL}', repeat('x', 121))`,
    `insert into public.site_banner_items(placement, image_url, sort_order) values ('home', '${HOME_URL}', 1000)`,
    `insert into public.site_banner_items(placement, image_url, sort_order) values ('home', '${HOME_URL}', -1000)`,
  ]
  for (const sql of bad) await assert.rejects(db.query(sql), /violates check constraint/, sql)
  await db.query(`insert into public.site_banner_items(placement, image_url, destination_url, starts_at, ends_at) values ('home', '${HOME_URL}', '/productos?x=1', now(), now() + interval '1 minute')`)

  const before = (await db.query("select id, placement, image_url, alt_text, active, sort_order from public.site_banner_items order by id")).rows
  await db.exec(MIGRATION)
  assert.deepEqual((await db.query("select id, placement, image_url, alt_text, active, sort_order from public.site_banner_items order by id")).rows, before, "aplicarla otra vez no cambia nada")
})

test("bucket site-banners: JPG, PNG, WebP, AVIF y GIF (Productos) de hasta 5 MB, nunca SVG; otros buckets intactos", async () => {
  const db = await setup({ storage: true })
  const rows = (await db.query<{ id: string; file_size_limit: number | null; allowed_mime_types: string[] | null }>("select id, file_size_limit::int file_size_limit, allowed_mime_types from storage.buckets order by id")).rows
  assert.deepEqual(rows, [
    { id: "otro", file_size_limit: null, allowed_mime_types: null },
    { id: "site-banners", file_size_limit: 5242880, allowed_mime_types: ["image/jpeg", "image/png", "image/webp", "image/avif", "image/gif"] },
  ])
})
