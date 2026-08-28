import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"

import { isCustomerOrderOwner } from "./customer-order-ownership.ts"

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), "utf8")
}

test("Cliente A no puede usar su identidad para leer un pedido de Cliente B", () => {
  const clientA = { id: "user-a", email: "a@beyonix.test" }

  assert.equal(
    isCustomerOrderOwner(
      { usuario_id: "user-b", cliente_email: "a@beyonix.test" },
      clientA,
    ),
    false,
  )
  assert.equal(
    isCustomerOrderOwner(
      { usuario_id: null, cliente_email: "A@BEYONIX.TEST" },
      clientA,
    ),
    true,
  )
  assert.equal(
    isCustomerOrderOwner(
      { usuario_id: null, cliente_email: "b@beyonix.test" },
      clientA,
    ),
    false,
  )
})

test("el endpoint de listado exige sesión y filtra por usuario, nunca trae la tabla entera", () => {
  const route = source("app/api/orders/route.ts")

  assert.match(route, /supabase\.auth\.getUser\(\)/)
  assert.match(route, /if \(!user\)/)
  assert.match(route, /status: 401/)
  assert.match(route, /\.eq\("usuario_id", user\.id\)/)
  // El fallback legado por email sólo aplica a pedidos sin usuario_id
  // (nunca pisa pedidos que ya pertenecen a otra cuenta).
  assert.match(route, /\.is\("usuario_id", null\)/)
  assert.match(route, /\.ilike\("cliente_email", escapeIlikeValue\(normalizedEmail\)\)/)
})

test("el select del listado es explícito (sin '*') y no expone campos internos de Andreani/MP", () => {
  const route = source("app/api/orders/route.ts")
  const selectMatch = route.match(/const ORDER_LIST_SELECT =\s*\n?\s*"([^"]+)"/)
  assert.ok(selectMatch, "no se encontró ORDER_LIST_SELECT")
  const select = selectMatch![1]

  assert.doesNotMatch(select, /(^|[\s,(])\*/)
  for (const forbidden of [
    "andreani_envio_id",
    "andreani_contrato",
    "andreani_creation_claim_token",
    "mercadopago_preference_claim_token",
    "mercadopago_checkout_fingerprint",
    "refund_internal_note",
    "admin_visible_at",
    "checkout_idempotency_key",
  ]) {
    assert.doesNotMatch(select, new RegExp(forbidden))
  }
})

test("el listado pliega el vencimiento de transferencias en la misma request (sin round trip extra)", () => {
  const route = source("app/api/orders/route.ts")

  assert.match(route, /expireOverdueTransferOrders\(admin, \{ userId: user\.id \}\)/)
})

test("la ruta legacy de vencimiento de transferencias fue eliminada (quedó plegada en /api/orders)", () => {
  assert.throws(() => source("app/api/orders/transfer-expirations/route.ts"))
})

test("Mis compras pide el listado liviano por API en vez de leer la tabla ordenes completa desde el navegador", () => {
  const list = source("components/account/account-orders.tsx")

  assert.match(list, /fetch\("\/api\/orders", \{ cache: "no-store" \}\)/)
  assert.doesNotMatch(list, /supabase\s*\.from\("ordenes"\)/)
  // Regresión: ya no debe pedir productos(*) / producto_variantes(*) completos
  // por cada ítem de cada pedido del historial.
  assert.doesNotMatch(list, /productos\(\*\)/)
  assert.doesNotMatch(list, /producto_variantes\(\*\)/)
})

test("Mis compras no dispara un fetch de reclamos por pedido (elimina el N+1 de order_claims)", () => {
  const list = source("components/account/account-orders.tsx")

  assert.doesNotMatch(list, /\/api\/orders\/\$\{orderId\}\/claims/)
  assert.doesNotMatch(list, /getOrderClaims/)
})

test("la suscripción realtime de Mis compras está acotada al usuario autenticado", () => {
  const list = source("components/account/account-orders.tsx")

  assert.match(list, /filter: `usuario_id=eq\.\$\{user\.id\}`/)
})

test("el detalle nunca consulta ordenes desde el navegador y usa un endpoint autenticado", () => {
  const client = source("app/cuenta/cuenta-client.tsx")
  const route = source("app/api/orders/[id]/route.ts")

  assert.doesNotMatch(client, /supabase\s*\.from\("ordenes"\)/)
  assert.match(client, /fetch\(`\/api\/orders\/\$\{orderId\}`/)
  assert.match(route, /supabase\.auth\.getUser\(\)/)
  assert.match(route, /\.eq\("id", orderId\)/)
  assert.match(route, /\.eq\("usuario_id", user\.id\)/)
})

test("el fallback legado del detalle sólo alcanza órdenes sin usuario_id", () => {
  const route = source("app/api/orders/[id]/route.ts")

  assert.match(route, /\.is\("usuario_id", null\)/)
  assert.match(route, /\.ilike\("cliente_email", escapeIlikeValue\(normalizedEmail\)\)/)
})

test("el detalle devuelve un select explícito sin identificadores internos de creación Andreani", () => {
  const route = source("app/api/orders/[id]/route.ts")
  const selectMatch = route.match(
    /const CUSTOMER_ORDER_DETAIL_SELECT =\s*\n?\s*"([^"]+)"/,
  )
  assert.ok(selectMatch, "no se encontró CUSTOMER_ORDER_DETAIL_SELECT")
  const select = selectMatch![1]

  assert.doesNotMatch(select, /(^|[\s,(])\*/)
  assert.doesNotMatch(select, /andreani_envio_id/)
  assert.doesNotMatch(select, /andreani_creation_/)
  assert.doesNotMatch(select, /checkout_idempotency_key/)
})

test("el select del detalle nunca pide campos que sólo existen calculados en JS (nunca columnas reales)", () => {
  // Regresión: CUSTOMER_ORDER_DETAIL_SELECT llegó a incluir
  // "cliente_nombre_completo", un campo que /api/admin/pedidos arma en
  // memoria (perfil + fallback) y que jamás existió como columna de
  // "ordenes". Pedirlo en un .select() de PostgREST rompe la query entera
  // con 42703 y el detalle de compra devuelve 500 para TODA orden, no sólo
  // para casos límite.
  const route = source("app/api/orders/[id]/route.ts")
  const selectMatch = route.match(
    /const CUSTOMER_ORDER_DETAIL_SELECT =\s*\n?\s*"([^"]+)"/,
  )
  assert.ok(selectMatch, "no se encontró CUSTOMER_ORDER_DETAIL_SELECT")
  const select = selectMatch![1]

  for (const computedOnlyField of [
    "cliente_nombre_completo",
    "cliente_username",
  ]) {
    assert.doesNotMatch(
      select,
      new RegExp(`(^|[\\s,(])${computedOnlyField}([\\s,)]|$)`),
    )
  }
})

test("el bloque muerto de tabs (factura/reclamo/ítems) dentro de la card fue eliminado", () => {
  const list = source("components/account/account-orders.tsx")

  assert.doesNotMatch(list, /\{false && \(/)
})

test("la card de Mis compras muestra el tracking real del pedido con botón de copiar, sin hardcodear el número", () => {
  const list = source("components/account/account-orders.tsx")

  assert.match(list, /resolveOrderTrackingLink\(order\)/)
  assert.match(list, /<TrackingCopyButton/)
  assert.match(list, /orderTracking\.trackingNumber/)
  assert.doesNotMatch(list, /360003079278920/)
})

test("la card conserva el fallback cuando el pedido todavía no tiene tracking", () => {
  const list = source("components/account/account-orders.tsx")

  assert.match(list, /Te avisaremos cuando el pedido esté en camino/)
})

test("la card de Envío muestra sólo el número de tracking, sin prefijo 'Andreani' ni andreani_estado", () => {
  const list = source("components/account/account-orders.tsx")

  assert.doesNotMatch(list, /isAndreani \? "Andreani"/)
  assert.doesNotMatch(list, /order\.andreani_estado/)
  assert.doesNotMatch(list, /"Andreani" : "Seguimiento"/)
})

test("la card tiene divisor simétrico entre Pago|Envío y Envío|Productos (misma clase exacta en ambas columnas)", () => {
  const list = source("components/account/account-orders.tsx")
  const dividerClass = "sm:border-t-0 sm:border-l sm:border-white/12"
  const matches = list.match(new RegExp(dividerClass.replace(/[/]/g, "\\/"), "g"))

  assert.ok(matches, "no se encontró el patrón de divisor esperado")
  assert.equal(
    matches!.length,
    2,
    "el divisor debe aparecer exactamente en las columnas Envío y Productos",
  )
})

test("el número de tracking en la card nunca se trunca ni se corta visualmente", () => {
  const list = source("components/account/account-orders.tsx")
  const trackingLineMatch = list.match(
    /\{orderTracking\.trackingNumber\}\s*<\/span>/,
  )
  assert.ok(trackingLineMatch, "no se encontró la línea del número de tracking en la card")

  const linesBefore = list.slice(0, trackingLineMatch!.index).split("\n")
  // El <span> que envuelve el número no debe llevar truncate/line-clamp/ellipsis.
  const spanLine = linesBefore[linesBefore.length - 1] + trackingLineMatch![0]
  assert.doesNotMatch(spanLine, /truncate/)
  assert.doesNotMatch(spanLine, /line-clamp/)
  assert.doesNotMatch(spanLine, /text-ellipsis/)
})
