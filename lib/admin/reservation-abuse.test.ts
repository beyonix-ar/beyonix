import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { getReservationAbuseStatus } from "./reservation-abuse.ts"
import { getValidTrustedClientIp } from "../auth/trusted-client-ip.ts"
import { RESERVATION_BLOCKED_MESSAGE } from "../cart/stock-status.ts"

const read = (path: string) =>
  readFileSync(new URL(`../../${path}`, import.meta.url), "utf8").replace(/\r\n/g, "\n")

const NOW = Date.parse("2026-10-29T12:00:00Z")
const state = (overrides: Partial<Parameters<typeof getReservationAbuseStatus>[0]> = {}) => ({
  strike_count: 0,
  auto_blocked_until: null,
  manual_block: null,
  manual_blocked_until: null,
  manual_reason: null,
  ...overrides,
})

test("estado efectivo: permanente > manual vigente > automático vigente > puede reservar", () => {
  const future = "2026-11-05T12:00:00Z"
  assert.equal(getReservationAbuseStatus(state({ manual_block: "permanent", auto_blocked_until: future, strike_count: 2 }), NOW).status, "permanent")
  assert.equal(getReservationAbuseStatus(state({ manual_block: "temporary", manual_blocked_until: future, auto_blocked_until: future }), NOW).status, "manual")
  assert.deepEqual(getReservationAbuseStatus(state({ strike_count: 2, auto_blocked_until: future }), NOW), {
    status: "auto", strikes: 2, blockedUntil: future, reason: "2 faltas por reservas abandonadas",
  })
  assert.equal(getReservationAbuseStatus(state({ strike_count: 1 }), NOW).status, "active")
})

test("bloqueo automático vencido: puede reservar y las faltas se muestran en 0 (nuevo ciclo)", () => {
  const past = "2026-10-28T12:00:00Z"
  assert.deepEqual(getReservationAbuseStatus(state({ strike_count: 2, auto_blocked_until: past }), NOW), {
    status: "active", strikes: 0, blockedUntil: null, reason: null,
  })
  // El manual vencido tampoco bloquea; el permanente nunca vence.
  assert.equal(getReservationAbuseStatus(state({ manual_block: "temporary", manual_blocked_until: past }), NOW).status, "active")
  assert.equal(getReservationAbuseStatus(state({ manual_block: "permanent", auto_blocked_until: past }), NOW).status, "permanent")
})

test("IP: sólo X-Real-IP del proxy y sólo si es una IP válida; nunca X-Forwarded-For del cliente", () => {
  assert.equal(getValidTrustedClientIp(new Headers({ "x-forwarded-for": "203.0.113.1" })), null)
  assert.equal(getValidTrustedClientIp(new Headers({ "x-real-ip": "no-es-ip" })), null)
  assert.equal(getValidTrustedClientIp(new Headers({ "x-real-ip": " 198.51.100.4 " })), "198.51.100.4")
  assert.equal(getValidTrustedClientIp(new Headers({ "x-real-ip": "2001:db8::1" })), "2001:db8::1")
})

test("reserva (camino de la app): usuario del JWT validado + IP del proxy, por service_role, y bloqueo con código público", () => {
  const reservations = read("lib/cart/stock-reservations.ts")
  const reserve = reservations.slice(reservations.indexOf("export async function reserveCartStock"))
  const rpc = reserve.indexOf('rpc("reserve_cart_stock"')
  // Identidad: sólo del JWT validado por el servidor (getUser), nunca del body.
  assert.match(reserve, /const \{ data: auth \} = await \(await createClient\(\)\)\.auth\.getUser\(\)\n\s+const userId = auth\.user\?\.id \?\? null\n\s+if \(items\.length > 0 && !userId\) return \{ success: false, code: "AUTH_REQUIRED" \}/)
  assert.ok(reserve.indexOf("AUTH_REQUIRED") < rpc, "sin usuario válido no se llama a la RPC")
  assert.match(reserve, /const clientIp = items\.length > 0 \? getValidTrustedClientIp\(await headers\(\)\) : null/)
  assert.match(reserve, /createAdminClient\(\)\.rpc\("reserve_cart_stock", \{\n\s+p_session_id: normalizedSessionId,\n\s+p_items: items,\n\s+p_user_id: userId,\n\s+p_client_ip: clientIp,\n\s+\}\)/)
  assert.doesNotMatch(reserve, /register_checkout_reservation_client_ip|supabase\.rpc\("reserve_cart_stock"/)
  assert.match(reserve, /if \(response\?\.blocked === true\) return \{ success: false, code: "RESERVATION_BLOCKED" \}/)
  assert.doesNotMatch(reserve, /x-forwarded-for|cf-connecting-ip/)
})

test("grants: reserve_cart_stock sólo service_role; la firma pública anterior desaparece", () => {
  const migration = read("supabase/migrations/20261029130000_reservation_abuse_protection.sql")
  assert.match(migration, /\ndrop function public\.reserve_cart_stock\(text, jsonb\);\n/)
  assert.ok(migration.indexOf("drop function public.reserve_cart_stock(text, jsonb)") < migration.indexOf("create function public.reserve_cart_stock("))
  assert.doesNotMatch(migration, /create or replace function public\.reserve_cart_stock/)
  assert.doesNotMatch(migration, /grant[^;]*reserve_cart_stock[^;]*(anon|authenticated)/)
  assert.match(migration, /revoke all on function public\.reserve_cart_stock\(text, jsonb, uuid, inet\) from public, anon, authenticated;\ngrant execute on function public\.reserve_cart_stock\(text, jsonb, uuid, inet\) to service_role;/)
  assert.match(migration, /if auth\.role\(\) is distinct from 'service_role' then raise exception 'INVALID_SESSION'; end if;/)
  // El registro de IP ya no es un paso aparte que se pueda omitir.
  assert.doesNotMatch(migration, /register_checkout_reservation_client_ip/)
})

test("cliente bloqueado: mensaje público y neutro, sin motivo, contador, IP ni datos técnicos", () => {
  assert.equal(
    RESERVATION_BLOCKED_MESSAGE,
    "Temporalmente no podemos procesar nuevas reservas desde tu cuenta. Intentá nuevamente más adelante.",
  )
  assert.doesNotMatch(RESERVATION_BLOCKED_MESSAGE, /abuso|falta|IP|bloque|\d/i)
  const checkout = read("app/checkout/page.tsx")
  assert.match(checkout, /if \(result\.code === "RESERVATION_BLOCKED"\) \{\n\s+setCheckoutError\(RESERVATION_BLOCKED_MESSAGE\)\n\s+return\n\s+\}/)
})

test("Admin: lectura y acciones sólo para admin/super_admin; la IP se valida y el actor es la sesión", () => {
  const route = read("app/api/admin/clientes/reservas/route.ts")
  assert.equal(route.match(/const auth = await requireAdmin\(request\)\n\s+if \("error" in auth\) return auth\.error/g)?.length, 2)
  assert.match(route, /if \(!isIP\(ip\)\) return Response\.json/)
  assert.equal(route.match(/p_admin_id: auth\.user\.id/g)?.length, 2)
  assert.match(route, /auth\.admin\.rpc\("evaluate_reservation_abuse"\)/)
  assert.match(read("app/admin/sections/clientes/admin-clientes.tsx"), /<ReservationAbusePanel \/>/)
})

test("reserve_cart_stock antiabuso = la versión anterior + gate + foto, sin tocar las reglas de stock", () => {
  const previous = read("supabase/migrations/20261029120000_remove_fixed_checkout_quantity_cap.sql")
    .match(/create or replace function public\.reserve_cart_stock\(p_session_id text, p_items jsonb\)[\s\S]*?\n\$\$;/)?.[0] ?? ""
  const current = read("supabase/migrations/20261029130000_reservation_abuse_protection.sql")
    .match(/create function public\.reserve_cart_stock\([\s\S]*?\n\$\$;/)?.[0] ?? ""
  assert.ok(previous && current)

  const gateStart = current.indexOf("\n  -- Antiabuso:")
  const gateEnd = current.indexOf("  end if;\n", current.indexOf("v_block := public.reservation_abuse_gate")) + "  end if;\n  end if;\n".length
  const candidate = "  if jsonb_array_length(p_items) > 0 then\n    perform public.reservation_abuse_record_candidate(p_session_id, p_user_id);\n  end if;\n\n"
  const serviceRoleGuard = "  -- Defensa adicional al GRANT: sólo el servidor (service_role) informa\n  -- usuario e IP.\n  if auth.role() is distinct from 'service_role' then raise exception 'INVALID_SESSION'; end if;\n"
  const stripped = (current.slice(0, gateStart) + current.slice(gateEnd))
    .replace("create function public.reserve_cart_stock(\n  p_session_id text, p_items jsonb, p_user_id uuid, p_client_ip inet\n)", "create or replace function public.reserve_cart_stock(p_session_id text, p_items jsonb)")
    .replace("  v_block text;\n", "")
    .replace(serviceRoleGuard, "")
    .replace(candidate, "")
  // Único cambio de contrato restante: el usuario viene del servidor, no de auth.uid().
  assert.doesNotMatch(stripped, /auth\.uid\(\)/)
  assert.equal(stripped, previous.replaceAll("auth.uid()", "p_user_id"))

  // Gate: después de los locks por producto y antes de tocar cualquier fila de stock.
  const gate = current.indexOf("public.reservation_abuse_gate(")
  assert.ok(current.indexOf("perform pg_advisory_xact_lock(93000") < gate)
  assert.ok(gate < current.indexOf("delete from public.stock_reservations where session_id = p_session_id"))
  assert.ok(gate < current.indexOf("insert into public.checkout_reservation_sessions"))
})
