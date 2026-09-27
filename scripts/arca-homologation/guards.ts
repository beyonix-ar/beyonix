/**
 * Guardas del arnés de homologación ARCA (scripts/arca-homologation/run.ts).
 * Puras y testeables: deciden si una operación real contra ARCA homologación
 * puede ejecutarse sobre un pedido. Todo lo que no sea inequívocamente de
 * prueba se rechaza (fail-closed): la base es la misma de producción.
 */

import { getConfiguredArcaEnvironment } from "../../lib/arca/environment.ts"

/** Convención obligatoria: el nombre del producto y el email del usuario lo dicen. */
const TEST_MARKER = /\b(prueba|test)\b|\+(prueba|test|arca)/i

export interface ArcaRuntimeFacts {
  arcaEnv: string | undefined
  autoInvoicingEnabled: string | undefined
  certificateIssuerCn: string
}

export interface TestUserFacts {
  id: string
  email: string | null
  rol: string | null
}

export interface TestProductFacts {
  id: number
  nombre: string
}

export interface OrderFacts {
  id: number
  usuario_id: string | null
  total: number
  invoice_status: string | null
  invoice_arca_environment: string | null
  items: Array<{ producto_id: number }>
}

export class HomologationGuardError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "HomologationGuardError"
  }
}

function fail(message: string): never {
  throw new HomologationGuardError(message)
}

/** Sólo homologación, con certificado de la CA de testing y automática apagada. */
export function assertHomologationRuntime(facts: ArcaRuntimeFacts) {
  if (getConfiguredArcaEnvironment(facts.arcaEnv) !== "homologation") {
    fail(`ARCA_ENV efectivo no es homologation (ARCA_ENV=${JSON.stringify(facts.arcaEnv ?? null)}).`)
  }
  if (facts.arcaEnv !== undefined && facts.arcaEnv.trim() !== "" && facts.arcaEnv.trim().toLowerCase() !== "homologation") {
    fail(`ARCA_ENV tiene un valor inesperado: ${JSON.stringify(facts.arcaEnv)}.`)
  }
  if (facts.autoInvoicingEnabled?.trim().toLowerCase() === "true") {
    fail("ARCA_AUTO_INVOICING_ENABLED está activo: las pruebas manuales se hacen con la automática apagada.")
  }
  if (facts.certificateIssuerCn !== "Computadores Test") {
    fail(`El certificado no es de homologación (emisor: ${JSON.stringify(facts.certificateIssuerCn)}).`)
  }
}

export function assertTestUser(user: TestUserFacts | null, expectedId: string) {
  if (!user || user.id !== expectedId) fail("El usuario de prueba indicado no existe.")
  if (user.rol !== "cliente") fail("El usuario de prueba debe tener rol cliente.")
  if (!TEST_MARKER.test(user.email ?? "")) {
    fail("El email del usuario de prueba debe identificarlo como prueba (p. ej. contener \"prueba\", \"test\" o \"+arca\").")
  }
}

export function assertTestProduct(product: TestProductFacts | null, expectedId: number) {
  if (!product || product.id !== expectedId) fail("El producto de prueba indicado no existe.")
  if (!TEST_MARKER.test(product.nombre)) {
    fail("El nombre del producto de prueba debe identificarlo como prueba (contener \"PRUEBA\" o \"TEST\").")
  }
}

/** Pedido nuevo, del usuario de prueba y sólo con el producto de prueba. */
export function assertTestOrder(order: OrderFacts | null, testUserId: string, testProductId: number) {
  if (!order) fail("El pedido no existe.")
  if (order.usuario_id !== testUserId) fail(`El pedido ${order.id} no pertenece al usuario de prueba.`)
  if (order.items.length === 0 || order.items.some((item) => item.producto_id !== testProductId)) {
    fail(`El pedido ${order.id} incluye productos que no son el producto de prueba.`)
  }
  if (!(order.total > 0)) fail(`El pedido ${order.id} no tiene un total válido.`)
}

/**
 * Todos los pedidos del usuario de prueba contienen sólo el producto de
 * prueba: el usuario nunca se usó para compras reales.
 */
export function assertTestUserIsolated(orders: OrderFacts[], testUserId: string, testProductId: number) {
  for (const order of orders) assertTestOrder(order, testUserId, testProductId)
}

export function assertInvoiceableForTest(order: OrderFacts, invoiceable: boolean) {
  if (order.invoice_status === "authorized") fail(`El pedido ${order.id} ya está facturado.`)
  if (order.invoice_status === "processing") fail(`El pedido ${order.id} está facturándose en este momento.`)
  if (!invoiceable && order.invoice_status !== "error") {
    fail(`El pedido ${order.id} no es facturable todavía (pago no confirmado por BEYONIX o con cambios pendientes).`)
  }
}

export function assertCreditNoteTarget(order: OrderFacts, amount: number, remaining: number) {
  if (order.invoice_status !== "authorized") fail(`El pedido ${order.id} no tiene Factura C autorizada.`)
  if (order.invoice_arca_environment !== "homologation") {
    fail(`La Factura C del pedido ${order.id} no es de homologación.`)
  }
  if (!(amount > 0) || Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-6) {
    fail("El importe de la NC debe ser positivo y con hasta 2 decimales.")
  }
  if (amount > remaining + 0.005) fail(`El importe supera lo que queda por acreditar de la factura (${remaining}).`)
}
