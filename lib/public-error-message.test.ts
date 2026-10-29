import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  PUBLIC_ERROR_MESSAGES,
  getPublicErrorMessage,
  isPublicSafeMessage,
  toPublicMessage,
} from "./public-error-message.ts"
import { CheckoutCatalogError } from "./andreani/checkout-quote-client.ts"
import { ANDREANI_DESTINATION_UNAVAILABLE_MESSAGE } from "./andreani/types.ts"
import { STOCK_CHANGED_MESSAGE } from "./cart/stock-status.ts"

const fallback = PUBLIC_ERROR_MESSAGES.shippingQuote

test("conserva los mensajes públicos curados de stock, precio y envío", () => {
  for (const message of [
    ANDREANI_DESTINATION_UNAVAILABLE_MESSAGE,
    STOCK_CHANGED_MESSAGE,
    "El producto ya no tiene stock suficiente.",
    "El precio cambió. Revisá el pedido antes de continuar.",
    "Ingresá un código postal válido.",
    "La cotización tardó demasiado. Intentá nuevamente.",
    "El envío no está disponible temporalmente.",
    "La sucursal seleccionada ya no está disponible.",
    "El carrito necesita 3 bultos y supera el máximo de 2 por envío Andreani. Escribinos para coordinar el envío.",
    "Tu compra quedó en $1.500 después del ajuste.",
    "Pedido BX-1042: esperá unos segundos y volvé a intentarlo.",
  ]) {
    assert.equal(isPublicSafeMessage(message), true, message)
    assert.equal(getPublicErrorMessage(new CheckoutCatalogError(message, "invalid_request"), fallback), message)
    assert.equal(toPublicMessage(message, fallback), message)
  }
})

test("bloquea los errores técnicos reportados y equivalentes", () => {
  for (const message of [
    "shipping_provider_quote_amount missing",
    "some_internal_field",
    "Error code PGRST116",
    "PGRST301",
    "Connection refused at 127.0.0.1",
    "connect ECONNREFUSED 10.0.0.12:5432",
    "ETIMEDOUT",
    "No se pudo conectar a localhost",
    "Supabase error",
    "Andreani API 500",
    "payload invalid",
    "status 409",
    "Error 502",
    "Unexpected token < in JSON at position 0",
    "El campo origen.codigoPostal no es válido.",
    "invalid payload { cpDestino: undefined }",
    "Failed to fetch",
    "TypeError: Cannot read properties of null\n    at quote (checkout.tsx:10:5)",
    "duplicate key value violates unique constraint",
    "Mercado Pago no está configurado.",
    "Falta la variable de environment",
    "[object Object]",
  ]) {
    assert.equal(isPublicSafeMessage(message), false, message)
    assert.equal(getPublicErrorMessage(new Error(message), fallback), fallback, message)
    assert.equal(toPublicMessage(message, fallback), fallback, message)
  }
})

test("bloquea nombres técnicos de excepciones (Prisma y similares)", () => {
  for (const message of [
    "PrismaClientKnownRequestError",
    "PrismaClientUnknownRequestError",
    "PrismaClientValidationError",
    "SomethingError",
    "SomethingException",
    "TypeError: x is not iterable",
    "Falló la consulta: QueryFailedError",
  ]) {
    assert.equal(isPublicSafeMessage(message), false, message)
    assert.equal(getPublicErrorMessage(new Error(message), fallback), fallback, message)
  }
})

test("bloquea errores de red y de sockets", () => {
  for (const message of [
    "Error: connection reset by peer",
    "connection reset",
    "ECONNRESET",
    "socket hang up",
    "Client network socket disconnected before secure TLS connection was established",
    "write EPIPE",
    "broken pipe",
    "getaddrinfo ENOTFOUND api.andreani.com",
    "EAI_AGAIN",
  ]) {
    assert.equal(isPublicSafeMessage(message), false, message)
    assert.equal(getPublicErrorMessage(new Error(message), fallback), fallback, message)
  }
})

test("\"error\" en una frase humana no se confunde con un nombre de excepción", () => {
  for (const message of [
    "Error al cargar la dirección. Intentá nuevamente.",
    "Ocurrió un error al procesar tu pedido. Intentá nuevamente.",
    "Hubo un error con el pago. Revisá los datos e intentá de nuevo.",
  ]) {
    assert.equal(isPublicSafeMessage(message), true, message)
  }
})

test("vacíos, null/undefined, no-string, demasiado largos y errores de runtime usan el fallback", () => {
  for (const value of ["", "   ", undefined, null, 409, {}, "x".repeat(300)]) {
    assert.equal(toPublicMessage(value, fallback), fallback, String(value))
  }
  assert.equal(toPublicMessage(String({}), fallback), fallback)
  assert.equal(getPublicErrorMessage(new TypeError("Cannot read properties of null (reading 'type')"), fallback), fallback)
  const abort = new Error("La operación terminó")
  abort.name = "AbortError"
  assert.equal(getPublicErrorMessage(abort, fallback), fallback)
  assert.equal(getPublicErrorMessage("boom", fallback), fallback)
  assert.equal(getPublicErrorMessage(undefined, fallback), fallback)
})

test("los límites de palabra son Unicode: \"env\" no matchea dentro de \"envío\"", () => {
  assert.equal(isPublicSafeMessage("El envío se calcula en el checkout."), true)
  assert.equal(isPublicSafeMessage("Configurá tu dirección de envío."), true)
})

test("fallback por contexto: cotización y operación genérica; nunca stock como fallback universal", () => {
  assert.equal(PUBLIC_ERROR_MESSAGES.shippingQuote, "No pudimos calcular el envío. Intentá nuevamente.")
  assert.equal(PUBLIC_ERROR_MESSAGES.generic, "No pudimos completar la operación. Intentá nuevamente.")
  // Un error desconocido del servidor cae al genérico; el de stock sólo se ve
  // cuando el servidor lo informa (es un mensaje público válido).
  assert.equal(toPublicMessage(undefined, PUBLIC_ERROR_MESSAGES.generic), PUBLIC_ERROR_MESSAGES.generic)
  assert.equal(toPublicMessage("PGRST116", PUBLIC_ERROR_MESSAGES.generic), PUBLIC_ERROR_MESSAGES.generic)
  assert.equal(toPublicMessage(STOCK_CHANGED_MESSAGE, PUBLIC_ERROR_MESSAGES.generic), STOCK_CHANGED_MESSAGE)
})

test("checkout y cotización pasan por la capa pública con el fallback del contexto", () => {
  const checkout = readFileSync(new URL("../app/checkout/page.tsx", import.meta.url), "utf8")
  const success = readFileSync(new URL("../app/checkout/success/page.tsx", import.meta.url), "utf8")
  const territorial = readFileSync(new URL("../hooks/use-territorial-selector.ts", import.meta.url), "utf8")

  for (const source of [checkout, success, territorial]) {
    assert.doesNotMatch(source, /set\w+\(\s*error instanceof Error\s*\?\s*error\.message/)
  }
  assert.match(checkout, /getPublicErrorMessage\(error, PUBLIC_ERROR_MESSAGES\.shippingQuote\)/)
  assert.doesNotMatch(checkout, /setCheckoutError\(\s*data\.error \|\|/)
  assert.doesNotMatch(checkout, /toPublicMessage\(data\.error, STOCK_CHANGED_MESSAGE\)/)
  assert.equal(checkout.match(/toPublicMessage\(data\.error, PUBLIC_ERROR_MESSAGES\.generic\)/g)?.length, 3)
  assert.match(checkout, /catch \{\s*setCheckoutError\(PUBLIC_ERROR_MESSAGES\.generic\)/)
  // El detalle técnico sigue disponible para el log interno de desarrollo.
  assert.match(checkout, /\[Andreani checkout\] cotización no disponible/)
})
