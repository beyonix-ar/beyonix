import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

import {
  countUnreadBeyonixMessages,
  formatUnreadBadgeCount,
  getLatestBeyonixMessage,
  selectCustomerDisplayedClaim,
  type ClaimUnreadSource,
} from "./customer-claim-unread.ts"

function readSource(path: string) {
  return readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n")
}

const migration = readSource("../../supabase/migrations/20260924140000_order_claim_customer_reads.sql")
const customer = "10000000-0000-4000-8000-000000000001"
const other = "10000000-0000-4000-8000-000000000002"

const at = (minute: number) => new Date(Date.UTC(2026, 8, 20, 12, minute)).toISOString()
const claim = (messages: Array<[string, number]>, lastReadMinute: number | null = null): ClaimUnreadSource => ({
  id: 1,
  status: "en_revision",
  failure_type: "falla",
  customer_last_read_at: lastReadMinute == null ? null : at(lastReadMinute),
  order_claim_messages: messages.map(([role, minute], index) => ({ id: index + 1, author_role: role, created_at: at(minute) })),
})

// ─────────────────────────────── conteo puro ───────────────────────────────

test("1-3. mensajes del cliente no suman; cada respuesta de BEYONIX suma 1", () => {
  assert.equal(countUnreadBeyonixMessages(claim([["cliente", 1]])), 0)
  assert.equal(countUnreadBeyonixMessages(claim([["cliente", 1], ["super_admin", 2]])), 1)
  assert.equal(countUnreadBeyonixMessages(claim([["cliente", 1], ["admin", 2], ["operador", 3]])), 2)
  assert.equal(countUnreadBeyonixMessages(null), 0)
})

test("6-7. después de leer el badge desaparece y una respuesta nueva vuelve a 1", () => {
  const read = claim([["cliente", 1], ["admin", 2], ["admin", 3]], 3)
  assert.equal(countUnreadBeyonixMessages(read), 0)
  assert.equal(formatUnreadBadgeCount(0), null)
  const afterNewReply = claim([["cliente", 1], ["admin", 2], ["admin", 3], ["admin", 5]], 3)
  assert.equal(countUnreadBeyonixMessages(afterNewReply), 1)
  assert.equal(getLatestBeyonixMessage(afterNewReply)?.id, 4)
})

test("badge: número exacto y 99+", () => {
  assert.equal(formatUnreadBadgeCount(1), "1")
  assert.equal(formatUnreadBadgeCount(3), "3")
  assert.equal(formatUnreadBadgeCount(99), "99")
  assert.equal(formatUnreadBadgeCount(100), "99+")
})

test("el badge cuenta el mismo reclamo que muestra la página del reclamo", () => {
  const help = { id: 1, status: "cerrado", failure_type: "consulta_pedido" }
  const active = { id: 2, status: "en_revision", failure_type: "falla" }
  const cancel = { id: 3, status: "en_revision", failure_type: "cancelar_compra" }
  assert.equal(selectCustomerDisplayedClaim([cancel, help, active], { canCreatePostDeliveryClaim: true })?.id, 2)
  assert.equal(selectCustomerDisplayedClaim([help], { canCreatePostDeliveryClaim: true }), undefined)
  assert.equal(selectCustomerDisplayedClaim([help], { canCreatePostDeliveryClaim: false })?.id, 1)
  const page = readSource("../../components/claims/customer-claim-experience.tsx")
  assert.match(page, /const claim = useMemo\(\s*\(\) => selectCustomerDisplayedClaim\(claims, \{ canCreatePostDeliveryClaim \}\),/)
  const orders = readSource("../../components/account/account-orders.tsx")
  assert.match(orders, /selectCustomerDisplayedClaim\(order\.order_claims \?\? \[\], \{\s*canCreatePostDeliveryClaim: isClaimOrderDelivered\(order\),/)
})

// ────────────────────────────── base real (PGlite) ──────────────────────────

// Tipos alineados con producción (verificados con `supabase db query --linked`,
// 2026-09-24): order_claims.id y order_claim_messages.id bigint,
// order_claims.user_id uuid, y customer_notifications.id **uuid** con
// gen_random_uuid() -- con un id bigint acá no se detectó que la migración
// declaraba la variable del trigger como bigint.
const SCHEMA = `
create role anon; create role authenticated; create role service_role bypassrls;
create schema auth;
create function auth.role() returns text language sql as $$ select nullif(current_setting('request.jwt.claim.role',true),'') $$;
create table order_claims(id bigint primary key, order_id bigint not null, user_id uuid, status text default 'en_revision',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), last_customer_message_at timestamptz);
create function touch_order_claim_updated_at() returns trigger language plpgsql as $$ begin new.updated_at=now(); return new; end $$;
create trigger touch_order_claim_updated_at_trigger before update on order_claims for each row execute function touch_order_claim_updated_at();
create table order_claim_messages(id bigint primary key, claim_id bigint references order_claims(id), author_role text, message text, created_at timestamptz default now());
create table customer_notifications(id uuid primary key default gen_random_uuid(), user_id uuid not null, type text not null,
  title text not null, body text not null, action_url text, order_id bigint, is_read boolean not null default false, source_key text,
  created_at timestamptz not null default now(), dismissed_at timestamptz, target_items jsonb not null default '[]'::jsonb,
  starts_at timestamptz, ends_at timestamptz);
create unique index customer_notifications_source_key_key on customer_notifications(source_key);
`

async function setupHistoric(migrationSql = migration) {
  const db = new PGlite()
  await db.exec(SCHEMA)
  // Reclamo 1 (pedido 8): respuesta vieja ya leída en la campana + una sin leer.
  // Reclamo 2 (pedido 9): respuestas anteriores a las notificaciones.
  // Reclamo 3 (pedido 10): el cliente respondió después de BEYONIX.
  await db.query(`insert into order_claims(id,order_id,user_id,created_at,last_customer_message_at) values
    (1,8,$1,$2,$3),(2,9,$1,$2,null),(3,10,$1,$2,$4)`, [customer, at(0), at(1), at(9)])
  await db.query(`insert into order_claim_messages(id,claim_id,author_role,created_at) values
    (11,1,'cliente',$1),(12,1,'super_admin',$2),(13,1,'super_admin',$3),
    (21,2,'admin',$2),(22,2,'admin',$3),
    (31,3,'admin',$2),(32,3,'cliente',$4)`, [at(1), at(2), at(3), at(9)])
  await db.query(`insert into customer_notifications(user_id,type,title,body,order_id,is_read,source_key,created_at) values
    ($1,'claim_response','Mensaje de BEYONIX','Tenés una nueva respuesta sobre tu pedido.',8,true,'claim-message:12',$2),
    ($1,'claim_response','Mensaje de BEYONIX','Tenés una nueva respuesta sobre tu pedido.',8,false,'claim-message:13',$3)`, [customer, at(2), at(3)])
  await db.exec(migrationSql)
  await db.query("select set_config('request.jwt.claim.role','service_role',false)")
  return db
}

async function unreadFor(db: PGlite, claimId: number) {
  const read = await db.query<{ last_read_at: string }>("select last_read_at::text from order_claim_customer_reads where claim_id=$1", [claimId])
  const messages = await db.query<{ id: number; author_role: string; created_at: string }>(
    "select id::int, author_role, created_at::text from order_claim_messages where claim_id=$1", [claimId])
  return countUnreadBeyonixMessages({
    customer_last_read_at: read.rows[0]?.last_read_at ?? null,
    order_claim_messages: messages.rows,
  })
}

test("11. históricos: sin unread masivos -- sólo cuenta lo que la campana ya muestra sin leer", async () => {
  const db = await setupHistoric()
  try {
    assert.equal(await unreadFor(db, 1), 1, "sólo la respuesta cuya notificación sigue sin leer")
    assert.equal(await unreadFor(db, 2), 0, "respuestas previas a las notificaciones: leídas")
    assert.equal(await unreadFor(db, 3), 0, "el cliente respondió después: ya lo vio")
  } finally { await db.close() }
})

test("8. campana: la respuesta crea 'BEYONIX respondió tu reclamo' con link al reclamo, sin spam", async () => {
  const db = await setupHistoric()
  try {
    await db.exec("update customer_notifications set is_read=true")
    await db.query("insert into order_claim_messages(id,claim_id,author_role) values(40,2,'cliente')")
    assert.equal((await db.query("select * from customer_notifications where order_id=9")).rows.length, 0, "mensaje del cliente: sin notificación")

    await db.query("insert into order_claim_messages(id,claim_id,author_role) values(41,2,'admin')")
    const first = await db.query<{ title: string; body: string; action_url: string; is_read: boolean }>(
      "select title, body, action_url, is_read from customer_notifications where order_id=9")
    assert.deepEqual(first.rows, [{
      title: "BEYONIX respondió tu reclamo",
      body: "Tenés un nuevo mensaje sobre el pedido #BX-1009.",
      action_url: "/cuenta/compras/9/ayuda",
      is_read: false,
    }])

    // Segunda respuesta antes de leer: se actualiza la misma notificación.
    await db.query("insert into order_claim_messages(id,claim_id,author_role) values(42,2,'super_admin')")
    assert.equal((await db.query("select * from customer_notifications where order_id=9")).rows.length, 1)
    // ...pero el badge refleja las 2 respuestas nuevas.
    assert.equal(await unreadFor(db, 2), 2)
  } finally { await db.close() }
})

const EXISTING_NOTIFICATION_ID = "5f0c2e1a-7b3d-4c8e-9a6f-1d2e3f4a5b6c"

async function secondReplyOverUuidNotification(db: PGlite) {
  // 1) Notificación claim_response pendiente con id UUID (como en producción).
  await db.exec("update customer_notifications set is_read=true")
  await db.query(
    `insert into customer_notifications(id,user_id,type,title,body,action_url,order_id,source_key)
     values ($1,$2,'claim_response','BEYONIX respondió tu reclamo','Tenés un nuevo mensaje sobre el pedido #BX-1010.',
       '/cuenta/compras/10/ayuda',10,'claim-message:33')`,
    [EXISTING_NOTIFICATION_ID, customer],
  )
  // 2) Otra respuesta de BEYONIX al mismo reclamo: el trigger debe leer ese
  //    id UUID en su variable para actualizar la notificación existente.
  await db.query("insert into order_claim_messages(id,claim_id,author_role) values(34,3,'super_admin')")
}

test("regresión: segunda respuesta sobre una notificación UUID pendiente consolida sin fallar", async () => {
  const db = await setupHistoric()
  try {
    await secondReplyOverUuidNotification(db)
    const pending = await db.query<{ id: string; title: string; body: string }>(
      "select id::text, title, body from customer_notifications where order_id=10 and is_read=false")
    // 3-5) Consolidó sobre la MISMA notificación: una sola pendiente, mismo id.
    assert.deepEqual(pending.rows, [{
      id: EXISTING_NOTIFICATION_ID,
      title: "BEYONIX respondió tu reclamo",
      body: "Tenés un nuevo mensaje sobre el pedido #BX-1010.",
    }])
    assert.equal((await db.query("select * from order_claim_messages where id=34")).rows.length, 1, "la respuesta del admin se guardó")
  } finally { await db.close() }

  // Con la migración anterior (variable del trigger declarada bigint) este
  // mismo caso rompe: el cast del UUID aborta el trigger y, con él, el INSERT
  // de la respuesta del admin.
  const previousMigration = migration.replace(
    "  v_existing public.customer_notifications.id%type;",
    "  v_existing bigint;",
  )
  assert.notEqual(previousMigration, migration, "se reconstruyó la versión anterior")
  const previous = await setupHistoric(previousMigration)
  try {
    await assert.rejects(secondReplyOverUuidNotification(previous), /invalid input syntax for type bigint/)
    assert.equal((await previous.query("select * from order_claim_messages where id=34")).rows.length, 0, "la respuesta se perdía")
  } finally { await previous.close() }
})

test("5 y 7. abrir el reclamo marca leído (reclamo + campana); una respuesta posterior vuelve a 1", async () => {
  const db = await setupHistoric()
  try {
    const before = (await db.query<{ updated_at: string }>("select updated_at::text from order_claims where id=1")).rows[0]
    const seen = (await db.query<{ created_at: string }>("select created_at::text from order_claim_messages where id=13")).rows[0]
    await db.query("select mark_order_claim_customer_read(1,$1,$2)", [customer, seen.created_at])
    assert.equal(await unreadFor(db, 1), 0)
    assert.equal((await db.query("select * from customer_notifications where order_id=8 and is_read=false")).rows.length, 0)
    // No toca order_claims.updated_at (no rompe expectedUpdatedAt ni el polling admin).
    assert.deepEqual((await db.query("select updated_at::text from order_claims where id=1")).rows[0], before)
    // Nunca retrocede.
    await db.query("select mark_order_claim_customer_read(1,$1,$2)", [customer, at(0)])
    assert.equal(await unreadFor(db, 1), 0)

    await db.query("insert into order_claim_messages(id,claim_id,author_role) values(14,1,'admin')")
    assert.equal(await unreadFor(db, 1), 1)
    assert.equal((await db.query("select * from customer_notifications where order_id=8 and is_read=false")).rows.length, 1)
  } finally { await db.close() }
})

test("10. otro usuario no puede marcar un reclamo ajeno; nadie fuera de service_role ejecuta", async () => {
  const db = await setupHistoric()
  try {
    await assert.rejects(db.query("select mark_order_claim_customer_read(1,$1,now())", [other]), /CLAIM_FORBIDDEN/)
    await assert.rejects(db.query("select mark_order_claim_customer_read(999,$1,now())", [customer]), /CLAIM_FORBIDDEN/)
    await db.query("select set_config('request.jwt.claim.role','authenticated',false)")
    await assert.rejects(db.query("select mark_order_claim_customer_read(1,$1,now())", [customer]), /permisos/)
    assert.equal(await unreadFor(db, 1), 1)
  } finally { await db.close() }
  assert.match(migration, /revoke all on public\.order_claim_customer_reads from public, anon, authenticated;/)
  assert.match(migration, /alter table public\.order_claim_customer_reads enable row level security;/)
})

// ───────────────────────────── endpoints y UI ───────────────────────────────

test("10. endpoint de lectura: titularidad server-side y fecha tomada de la base", () => {
  const route = readSource("../../app/api/orders/[id]/claims/read/route.ts")
  assert.match(route, /await authorizeCustomerClaimOrder\(\(await params\)\.id\)/)
  assert.match(route, /\.eq\("id", claimId\)\s*\.eq\("order_id", auth\.order\.id\)\s*\.eq\("user_id", auth\.user\.id\)/)
  assert.match(route, /\.eq\("id", messageId\)\s*\.eq\("claim_id", claimId\)/)
  assert.match(route, /p_read_at: message\.created_at,/)
  assert.doesNotMatch(route, /payload\.(readAt|lastReadAt|timestamp)/)
  const access = readSource("./customer-claim-access.ts")
  assert.match(access, /isCustomerOrderOwner\(order, user\)/)
  assert.match(access, /\.eq\("user_id", userId\)/)
})

test("4-5. Mis compras nunca marca leído; sólo la página del reclamo, con lo que tiene en pantalla", () => {
  const orders = readSource("../../components/account/account-orders.tsx")
  assert.doesNotMatch(orders, /claims\/read/)
  const page = readSource("../../components/claims/customer-claim-experience.tsx")
  const effect = page.slice(page.indexOf("const markedReadRef"), page.indexOf("}, [claim?.id, hasUnreadBeyonixMessages"))
  assert.match(effect, /fetch\(`\/api\/orders\/\$\{order\.id\}\/claims\/read`/)
  assert.match(effect, /body: JSON\.stringify\(\{ claimId: claim\.id, messageId \}\)/)
  assert.match(effect, /if \(!claim\?\.id \|\| !messageId \|\| !hasUnreadBeyonixMessages\) return/)
})

test("9. click en la notificación abre el reclamo del pedido correcto", () => {
  assert.match(migration, /'\/cuenta\/compras\/' \|\| v_claim\.order_id \|\| '\/ayuda'/)
  const bell = readSource("../../components/customer-notifications-bell.tsx")
  assert.match(bell, /notification\.type === "claim_response" \|\|[\s\S]*?return `\/cuenta\/compras\/\$\{notification\.order_id\}\$\{opensClaim \? "\/ayuda" : ""\}`/)
})

test("realtime: badge y campana se actualizan con el realtime existente", () => {
  const orders = readSource("../../components/account/account-orders.tsx")
  assert.match(orders, /table: "customer_notifications",\s*filter: `user_id=eq\.\$\{user\.id\}`,\s*\},\s*refreshOrders,/)
  const bell = readSource("../../components/customer-notifications-bell.tsx")
  assert.match(bell, /table: "customer_notifications",\s*filter: `user_id=eq\.\$\{userId\}`/)
  const api = readSource("../../app/api/orders/route.ts")
  assert.match(api, /order_claims\(id, status, failure_type, created_at, order_claim_messages\(id, author_role, created_at\)\)/)
  assert.match(api, /customer_last_read_at: readByClaimId\.get\(claim\.id\) \?\? null/)
})

function contrast(foreground: string, background: string) {
  const luminance = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((index) => {
      const value = parseInt(hex.slice(index, index + 2), 16) / 255
      return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a)
  return (light + 0.05) / (dark + 0.05)
}

test("12. badge legible en light y dark, pegado al botón sin deformarlo", () => {
  const css = readSource("../../app/globals.css")
  const start = css.indexOf(".customer-claim-unread-badge {")
  const rule = css.slice(start, css.indexOf("}", start))
  const bg = rule.match(/background: (#[0-9a-f]{6});/)?.[1] ?? ""
  const color = rule.match(/color: (#[0-9a-f]{6});/)?.[1] ?? ""
  assert.ok(contrast(color, bg) >= 4.5)
  assert.match(rule, /position: absolute;/)
  assert.match(rule, /pointer-events: none;/)
  assert.match(rule, /box-shadow: 0 0 0 2px var\(--account-surface, #0d1117\);/)
  // Mismo color en ambos temas: no hay override de tema que lo cambie.
  assert.doesNotMatch(css, /data-account-theme="light"\][^{]*customer-claim-unread-badge/)
  const orders = readSource("../../components/account/account-orders.tsx")
  assert.match(orders, /<span className="customer-claim-button-wrap">/)
  assert.match(orders, /className="customer-claim-unread-badge"/)
})
