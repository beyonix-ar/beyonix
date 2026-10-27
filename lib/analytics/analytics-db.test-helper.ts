import { readFileSync } from "node:fs"
import { PGlite } from "@electric-sql/pglite"

/**
 * PostgreSQL embebido con las migraciones REALES de Analítica, sobre un
 * esquema mínimo de la tienda (productos, variantes, imágenes y órdenes con
 * las columnas que usan Analítica y el trigger de compras).
 */

export const ANALYTICS_MIGRATIONS = [
  "20261026100000_analytics_events_product_views.sql",
  "20261026120000_analytics_history_merge_snapshots.sql",
  "20261026140000_analytics_peak_hour.sql",
  "20261026160000_analytics_peak_weekday.sql",
  "20261026180000_analytics_views_by_weekday.sql",
  "20261027100000_analytics_views_by_hour.sql",
  "20261027120000_analytics_session_stats.sql",
  "20261027140000_analytics_period_comparison.sql",
  "20261027160000_analytics_commerce_events.sql",
  "20261027170000_analytics_purchases.sql",
  "20261027180000_analytics_commerce_reports.sql",
  "20261027190000_analytics_purchases_trigger_only.sql",
  "20261027200000_analytics_permissions_hardening.sql",
].map((file) => readFileSync(`supabase/migrations/${file}`, "utf8"))

export const SESSION_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
export const SESSION_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
export const USER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"

export const STORE_SCHEMA = `create role anon; create role authenticated; create role service_role bypassrls;
  -- Como Supabase: todo objeto nuevo de public nace con permisos completos
  -- para estos roles; cada migración tiene que revocar lo que no corresponde.
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
  create schema auth;
  create table auth.users (id uuid primary key);
  create table public.productos (id bigint primary key, nombre text not null, slug text not null, activo boolean default true, imagen_principal text);
  create table public.producto_variantes (id bigint primary key, producto_id bigint not null);
  create table public.imagenes_producto (id bigint primary key, producto_id bigint, url text not null, orden integer default 0);
  create table public.ordenes (
    id bigint primary key, usuario_id uuid, total numeric not null, original_total numeric, estado text,
    payment_status text, financial_status text not null default 'pending_payment', paid_at timestamptz,
    payment_confirmed_at timestamptz, payment_confirmed_amount numeric
  );
  create table public.orden_items (id bigint primary key, orden_id bigint references public.ordenes(id) on delete cascade, producto_id bigint, cantidad integer not null default 1, precio numeric not null default 0, variante_id bigint);`

export async function createAnalyticsDb() {
  const db = new PGlite()
  await db.exec(`${STORE_SCHEMA}
    insert into auth.users values ('${USER}');
    insert into public.productos values
      (1, 'Auricular Malibu', 'auricular-malibu', true, 'https://cdn.test/malibu.webp'),
      (2, 'Soporte Notebook HUB', 'soporte-hub', true, ''),
      (3, 'Pava 12V', 'pava-12v', true, null),
      (4, 'Producto pausado', 'pausado', false, null);
    insert into public.producto_variantes values (21, 1), (22, 1), (31, 3);
    insert into public.imagenes_producto values (10, 2, 'https://cdn.test/hub-2.webp', 2), (11, 2, 'https://cdn.test/hub-1.webp', 1);`)
  for (const migration of ANALYTICS_MIGRATIONS) await db.exec(migration)
  return db
}
