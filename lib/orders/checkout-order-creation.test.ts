import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { createCheckoutShippingQuoteToken } from "../cart/checkout-shipping.ts"
import {
  buildCheckoutOrderBase,
  buildCheckoutOrderItemsPayload,
  getCheckoutOrderCustomerValidationError,
  normalizeCheckoutOrderCustomer,
  normalizeCheckoutOrderItems,
  normalizeCheckoutOrderShipping,
  prepareCheckoutOrderCatalogRows,
  type CheckoutOrderProductRow,
  type CheckoutOrderVariantRow,
} from "./checkout-order-creation.ts"
import type { ConditionedCheckoutRow } from "./conditioned-checkout.ts"

const QUOTE_SECRET = "beyonix-checkout-order-creation-test-secret"
const conditionedId = "123e4567-e89b-12d3-a456-426614174000"

const validCustomer = {
  nombre: "  María Muñoz  ",
  email: " maria@example.com ",
  telefono: " +54 11 5555-1234 ",
  dni: "30.123.456",
  direccion: " Avenida Córdoba 1234 ",
  cpDestino: " 3230 ",
  localidad: " Paso de los Libres ",
  provincia: " Corrientes ",
}

test("normaliza carrito y cliente una sola vez sin perder Unicode", () => {
  const items = normalizeCheckoutOrderItems([
    { productId: 1, quantity: 2.9, color: "variant:7" },
    {
      productId: 2,
      quantity: 1,
      variantId: 9,
      conditionedStockId: conditionedId,
    },
    { productId: 3, quantity: 0 },
  ])
  const customer = normalizeCheckoutOrderCustomer(validCustomer)

  assert.deepEqual(items, [
    {
      productId: 1,
      quantity: 2,
      variantId: 7,
      conditionedStockId: null,
    },
    {
      productId: 2,
      quantity: 1,
      variantId: null,
      conditionedStockId: conditionedId,
    },
  ])
  assert.deepEqual(customer, {
    cliente_nombre: "María Muñoz",
    cliente_email: "maria@example.com",
    cliente_telefono: "+54 11 5555-1234",
    cliente_dni: "30123456",
    cliente_direccion: "Avenida Córdoba 1234",
    cp_destino: "3230",
    localidad: "Paso de los Libres",
    provincia: "Corrientes",
  })
  assert.equal(getCheckoutOrderCustomerValidationError(customer), "")
})

test("prepara productos, variantes y precios con las reglas existentes", () => {
  const items = normalizeCheckoutOrderItems([
    { productId: 1, quantity: 2 },
    {
      productId: 2,
      quantity: 1,
      conditionedStockId: conditionedId,
    },
  ])
  const products: CheckoutOrderProductRow[] = [
    { id: 1, nombre: "Producto simple", precio: 10_000, stock: 5, activo: true },
    { id: 2, nombre: "Producto outlet", precio: 10_000, stock: 0, activo: true },
  ]
  const variants: CheckoutOrderVariantRow[] = [
    {
      id: 11,
      producto_id: 1,
      nombre: "Única",
      stock: 5,
      activo: true,
      orden: 0,
    },
  ]
  const conditioned: ConditionedCheckoutRow = {
    id: conditionedId,
    product_id: 2,
    source_variant_id: null,
    name: "Detalle estético",
    sku: "OUT-2",
    color_hex: "#112233",
    images: ["/outlet.webp"],
    original_quantity: 1,
    sold_quantity: 0,
    available_quantity: 1,
    discount_percent: 20,
    reason: "Caja dañada",
    active: true,
  }
  const catalog = prepareCheckoutOrderCatalogRows(
    items,
    products,
    variants,
    new Map([[conditionedId, conditioned]]),
  )

  assert.equal(items[0].variantId, 11)
  assert.deepEqual(
    catalog.cartRows.map((row) => row.unitPrice),
    [10_000, 8_000],
  )

  const orderItems = buildCheckoutOrderItemsPayload(
    50,
    items,
    products,
    catalog.conditionedRows,
  )
  assert.equal(orderItems[0].variante_id, 11)
  assert.equal(orderItems[0].precio, 9_000)
  assert.equal(orderItems[1].conditioned_stock_id, conditionedId)
  assert.equal(orderItems[1].precio, 6_800)
})

test("los tres medios conservan la misma base y sus diferencias reales", () => {
  const customer = normalizeCheckoutOrderCustomer(validCustomer)
  const storeBenefit = {
    id: "benefit-1",
    code: "CLIENTE10",
    benefit_type: "discount" as const,
    percent: 10,
  }
  const common = {
    userId: "user-1",
    total: 10_000,
    reservationSessionId: " session-1 ",
    storeBenefit,
    storeBenefitDiscountAmount: 1_000,
    customer,
  }
  const mercadoPago = buildCheckoutOrderBase({
    ...common,
    paymentMethodId: "mercadopago",
    creditBalanceUsed: 2_500,
    externalAmountDue: 7_500,
  })
  const transferencia = buildCheckoutOrderBase({
    ...common,
    paymentMethodId: "transferencia",
    creditBalanceUsed: 2_500,
    externalAmountDue: 7_500,
    includePostalCode: false,
  })
  const customerCredit = buildCheckoutOrderBase({
    ...common,
    paymentMethodId: "customer_credit",
    creditBalanceUsed: 10_000,
    externalAmountDue: 0,
  })

  for (const order of [mercadoPago, transferencia, customerCredit]) {
    assert.equal(order.total, 10_000)
    assert.equal(order.original_total, 10_000)
    assert.equal(order.credit_balance_used, 0)
    assert.equal(order.estado, "pendiente")
    assert.equal(order.checkout_idempotency_key, "checkout:session-1")
    assert.equal(order.store_benefit_id, "benefit-1")
    assert.equal(order.cliente_nombre, "María Muñoz")
  }
  assert.equal(mercadoPago.payment_composition.parts[1].type, "mercadopago")
  assert.equal(
    transferencia.payment_composition.parts[1].type,
    "transferencia",
  )
  assert.equal(customerCredit.payment_composition.parts.length, 1)
  assert.equal(customerCredit.payment_composition.parts[0].type, "customer_credit")
  assert.equal("cp_destino" in transferencia, false)
  assert.equal("cp_destino" in mercadoPago && mercadoPago.cp_destino, "3230")
  assert.equal(
    "cp_destino" in customerCredit && customerCredit.cp_destino,
    "3230",
  )
})

test("el helper común mantiene la validación del envío firmado", () => {
  const previousSecret = process.env.CHECKOUT_SHIPPING_QUOTE_SECRET
  process.env.CHECKOUT_SHIPPING_QUOTE_SECRET = QUOTE_SECRET
  const items = normalizeCheckoutOrderItems([
    { productId: 1, quantity: 1, variantId: 11 },
  ])
  const binding = {
    cpDestino: "3230",
    localidad: "Paso de los Libres",
    provincia: "Corrientes",
    items,
  }
  const quoteToken = createCheckoutShippingQuoteToken(
    binding,
    { type: "domicilio", price: 12_345.67 },
  )
  try {
    const shipping = normalizeCheckoutOrderShipping({
      shipping: {
        provider: "andreani",
        type: "domicilio",
        quoteToken,
      },
      customer: validCustomer,
      items,
      productsTotal: 20_000,
      settings: {
        defaultShippingCost: 0,
        freeShippingMinAmount: 999_999,
        shippingBonusMax: 0,
        freeShippingMode: "off",
      },
    })

    assert.equal(shipping.costReal, 12_345.67)
    assert.equal(shipping.costCharged, 12_345.67)
  } finally {
    if (previousSecret === undefined) {
      delete process.env.CHECKOUT_SHIPPING_QUOTE_SECRET
    } else {
      process.env.CHECKOUT_SHIPPING_QUOTE_SECRET = previousSecret
    }
  }
})

test("los endpoints delegan los bloques equivalentes y conservan lo específico", () => {
  const routes = [
    {
      path: "../../app/api/mercadopago/create-preference/route.ts",
      specific: /preference\.create\(/,
    },
    {
      path: "../../app/api/transferencia/create-order/route.ts",
      specific: /calculateTransferPaymentTotalAfterCustomerCredit\(/,
    },
    {
      path: "../../app/api/customer-credit/create-order/route.ts",
      specific: /payment_confirmed_with_customer_credit/,
    },
  ]

  for (const route of routes) {
    const source = readFileSync(new URL(route.path, import.meta.url), "utf8")
    assert.match(source, /normalizeCheckoutOrderItems\(/)
    assert.match(source, /loadAndValidateCheckoutOrderCatalog\(/)
    assert.match(source, /normalizeCheckoutOrderShipping\(/)
    assert.match(source, /buildCheckoutOrderBase\(/)
    assert.match(source, /insertCheckoutOrderItemsAndValidateInventory\(/)
    assert.doesNotMatch(source, /function normalizeItems\(/)
    assert.doesNotMatch(source, /function insertOrderItems\(/)
    assert.match(source, route.specific)
  }
})
