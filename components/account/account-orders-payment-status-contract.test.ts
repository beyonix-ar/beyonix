import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

// BX-1001 (auditoría): historial de compras y detalle de pedido mostraban
// "TOTAL PAGADO $72.914" para una orden Mercado Pago 'pendiente' que nunca
// se pagó (payment_status='preference_created'), y el historial además
// mostraba "Preparando envío" para esa misma orden sin pago aprobado. Este
// contrato verifica que ambas superficies usen LA MISMA fuente de verdad
// (getOrderPaymentTotalDisplay / isOrderPaymentConfirmed), nunca `estado`
// solo, y nunca una reimplementación propia.

function readSource(path: string) {
  return readFileSync(new URL(path, import.meta.url), "utf8")
}

test("historial (account-orders.tsx) usa el helper compartido para 'Total pagado', no una constante fija", () => {
  const source = readSource("./account-orders.tsx")

  assert.match(source, /getOrderPaymentTotalDisplay,?\s*\n/)
  assert.match(source, /from "@\/lib\/account\/account-utils"/)
  assert.match(source, /const paymentTotalDisplay = getOrderPaymentTotalDisplay\(order\)/)
  assert.match(source, /\{paymentTotalDisplay\.label\}/)
  // La caja ya no tiene el color de éxito hardcodeado: depende del helper.
  assert.doesNotMatch(
    source,
    />Total pagado</,
  )
})

test("detalle de compra (cuenta-client.tsx) usa el MISMO helper en el encabezado y en 'Resumen de pago'", () => {
  const source = readSource("../../app/cuenta/cuenta-client.tsx")

  assert.match(source, /getOrderPaymentTotalDisplay/)
  assert.match(source, /const paymentTotalDisplay = getOrderPaymentTotalDisplay\(order\)/)

  const usages = source.match(/\{paymentTotalDisplay\.label\}/g) ?? []
  assert.equal(usages.length, 2, "el encabezado y el resumen de pago deben usar paymentTotalDisplay.label")
  assert.doesNotMatch(source, />Total pagado</)
})

test("historial: 'Preparando envío' nunca aparece si el pago no está confirmado (isOrderPaymentConfirmed)", () => {
  const source = readSource("./account-orders.tsx")

  assert.match(source, /import \{ isOrderPaymentConfirmed \} from "@\/lib\/orders\/order-payment-status"/)
  assert.match(source, /const paymentConfirmed = isOrderPaymentConfirmed\(order\)/)
  // El fallback final a "Preparando envío" queda detrás de un chequeo previo
  // de !paymentConfirmed (que usa getPaymentProgressLabel en su lugar).
  assert.match(source, /!paymentConfirmed\s*\n\s*\? getPaymentProgressLabel\(order\)/)
  assert.match(source, /!paymentConfirmed\s*\n\s*\? "Te avisaremos cuando se haya aprobado\."/)
})

test("detalle de compra: el paso 'Preparando envío' del timeline ya dependía de isPaid -- no se tocó esa lógica", () => {
  const utils = readSource("../../lib/account/account-utils.ts")

  assert.match(
    utils,
    /label: "Preparando envío",\s*\n\s*detail: isPaid/,
  )
})

test("el fix no reintrodujo un cálculo de 'pagado' basado sólo en `estado`", () => {
  const utils = readSource("../../lib/account/account-utils.ts")

  assert.match(
    utils,
    /export function getOrderPaymentTotalDisplay\(/,
  )
  assert.match(utils, /isOrderPaymentConfirmed\(order\)/)
})
