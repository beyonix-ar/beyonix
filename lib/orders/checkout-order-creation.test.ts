import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { createCheckoutShippingQuoteToken } from "../cart/checkout-shipping.ts"
import { STOCK_CHANGED_MESSAGE } from "../cart/stock-status.ts"
import {
  buildCheckoutOrderBase,
  buildCheckoutOrderItemsPayload,
  getCheckoutOrderCustomerValidationError,
  getCheckoutOrderShippingFields,
  normalizeCheckoutOrderCustomer,
  normalizeCheckoutOrderItems,
  normalizeCheckoutOrderShipping,
  prepareCheckoutOrderCatalogRows,
  resolveCheckoutOrderShippingBranch,
  InsufficientStockError,
  type CheckoutOrderProductRow,
  type CheckoutOrderVariantRow,
} from "./checkout-order-creation.ts"
import { AndreaniError } from "../andreani/client.ts"
import type { VerifiedAndreaniBranch } from "../andreani/checkout-quote.ts"
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

test("si falla la inserción de ítems se elimina la orden incompleta", () => {
  const source = readFileSync(
    new URL("./checkout-order-creation.ts", import.meta.url),
    "utf8",
  )
  assert.match(
    source,
    /export async function insertCheckoutOrderItemsAndValidateInventory[\s\S]*?if \(error\) \{\s*await deleteIncompleteCheckoutOrder\(admin, orderId\)/,
  )
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
      color_hex: null,
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
  assert.equal(orderItems[0].precio, 10_000)
  assert.equal(orderItems[1].conditioned_stock_id, conditionedId)
  assert.equal(orderItems[1].precio, 8_000)
})

test("continúa cuando la cantidad pedida es menor al stock real", () => {
  const items = normalizeCheckoutOrderItems([{ productId: 1, quantity: 3 }])
  const products: CheckoutOrderProductRow[] = [
    { id: 1, nombre: "Producto A", precio: 10_000, stock: 10, activo: true },
  ]
  const variants: CheckoutOrderVariantRow[] = [
    {
      id: 21,
      producto_id: 1,
      nombre: "Única",
      color_hex: null,
      stock: 10,
      activo: true,
      orden: 0,
    },
  ]

  const catalog = prepareCheckoutOrderCatalogRows(
    items,
    products,
    variants,
    new Map(),
  )

  assert.equal(catalog.cartRows.length, 1)
  assert.equal(catalog.cartRows[0].quantity, 3)
})

test("acepta pedir exactamente la cantidad de stock disponible", () => {
  const items = normalizeCheckoutOrderItems([{ productId: 1, quantity: 6 }])
  const products: CheckoutOrderProductRow[] = [
    { id: 1, nombre: "Producto A", precio: 10_000, stock: 6, activo: true },
  ]
  const variants: CheckoutOrderVariantRow[] = [
    {
      id: 21,
      producto_id: 1,
      nombre: "Única",
      color_hex: null,
      stock: 6,
      activo: true,
      orden: 0,
    },
  ]

  const catalog = prepareCheckoutOrderCatalogRows(
    items,
    products,
    variants,
    new Map(),
  )

  assert.equal(catalog.cartRows[0].quantity, 6)
})

test("bloquea el exceso sobre stock sin revelar la cantidad real disponible", () => {
  const items = normalizeCheckoutOrderItems([{ productId: 1, quantity: 10 }])
  const products: CheckoutOrderProductRow[] = [
    { id: 1, nombre: "Auricular C-2237", precio: 10_000, stock: 6, activo: true },
  ]
  const variants: CheckoutOrderVariantRow[] = [
    {
      id: 21,
      producto_id: 1,
      nombre: "NEGRO",
      color_hex: "#000000",
      stock: 6,
      activo: true,
      orden: 0,
    },
  ]

  assert.throws(
    () =>
      prepareCheckoutOrderCatalogRows(items, products, variants, new Map()),
    (error) => {
      assert.ok(error instanceof InsufficientStockError)
      assert.equal(error.items.length, 1)
      assert.equal(error.items[0].productId, 1)
      assert.equal(error.items[0].variantId, 21)
      assert.equal(error.items[0].displayName, "Auricular C-2237")
      assert.equal(error.items[0].variantName, "NEGRO")
      // Ni el mensaje ni el detalle deben delatar cuánto stock hay ("6").
      assert.doesNotMatch(error.message, /\d/)
      assert.doesNotMatch(JSON.stringify(error.items), /\b6\b/)
      return true
    },
  )
})

test("junta todos los productos con stock insuficiente en una sola respuesta", () => {
  const items = normalizeCheckoutOrderItems([
    { productId: 1, quantity: 2 },
    { productId: 2, quantity: 10 },
    { productId: 3, quantity: 8 },
  ])
  const products: CheckoutOrderProductRow[] = [
    { id: 1, nombre: "Producto A (correcto)", precio: 10_000, stock: 10, activo: true },
    { id: 2, nombre: "Producto B (excedido)", precio: 10_000, stock: 6, activo: true },
    { id: 3, nombre: "Producto C (excedido)", precio: 10_000, stock: 3, activo: true },
  ]
  const variants: CheckoutOrderVariantRow[] = [
    { id: 31, producto_id: 1, nombre: "Única", color_hex: null, stock: 10, activo: true, orden: 0 },
    { id: 32, producto_id: 2, nombre: "Única", color_hex: null, stock: 6, activo: true, orden: 0 },
    { id: 33, producto_id: 3, nombre: "Única", color_hex: null, stock: 3, activo: true, orden: 0 },
  ]

  assert.throws(
    () =>
      prepareCheckoutOrderCatalogRows(items, products, variants, new Map()),
    (error) => {
      assert.ok(error instanceof InsufficientStockError)
      const flaggedProductIds = error.items
        .map((item) => item.productId)
        .sort((a, b) => a - b)
      assert.deepEqual(flaggedProductIds, [2, 3])
      return true
    },
  )
})

test("detecta un carrito desactualizado cuyo stock bajó después de agregarlo", () => {
  // El cliente agregó 5 unidades cuando había stock suficiente; la validación
  // vuelve a leer el stock actual (no confía en lo que había al agregarlo) y
  // ahora solo quedan 2.
  const items = normalizeCheckoutOrderItems([{ productId: 1, quantity: 5 }])
  const products: CheckoutOrderProductRow[] = [
    { id: 1, nombre: "Producto A", precio: 10_000, stock: 2, activo: true },
  ]
  const variants: CheckoutOrderVariantRow[] = [
    {
      id: 21,
      producto_id: 1,
      nombre: "Única",
      color_hex: null,
      stock: 2,
      activo: true,
      orden: 0,
    },
  ]

  assert.throws(
    () =>
      prepareCheckoutOrderCatalogRows(items, products, variants, new Map()),
    InsufficientStockError,
  )
})

test("un producto desactivado no se confunde con stock insuficiente", () => {
  // Está desactivado (ya no se vende, sea cual sea la cantidad pedida), no
  // es un caso de "bajá la cantidad y podés continuar" — debe cortar con el
  // mensaje genérico de disponibilidad, no como InsufficientStockError.
  const items = normalizeCheckoutOrderItems([{ productId: 1, quantity: 2 }])
  const products: CheckoutOrderProductRow[] = [
    {
      id: 1,
      nombre: "Producto discontinuado",
      precio: 10_000,
      stock: 10,
      activo: false,
    },
  ]
  const variants: CheckoutOrderVariantRow[] = [
    {
      id: 21,
      producto_id: 1,
      nombre: "Única",
      color_hex: null,
      stock: 10,
      activo: true,
      orden: 0,
    },
  ]

  assert.throws(
    () =>
      prepareCheckoutOrderCatalogRows(items, products, variants, new Map()),
    (error) => {
      assert.ok(!(error instanceof InsufficientStockError))
      assert.ok(error instanceof Error)
      assert.equal(error.message, STOCK_CHANGED_MESSAGE)
      return true
    },
  )
})

test("una variante desactivada no se confunde con stock insuficiente", () => {
  const items = normalizeCheckoutOrderItems([{ productId: 1, quantity: 2 }])
  const products: CheckoutOrderProductRow[] = [
    { id: 1, nombre: "Producto A", precio: 10_000, stock: 10, activo: true },
  ]
  const variants: CheckoutOrderVariantRow[] = [
    {
      id: 21,
      producto_id: 1,
      nombre: "Descontinuada",
      color_hex: null,
      stock: 10,
      activo: false,
      orden: 0,
    },
  ]
  items[0].variantId = 21

  assert.throws(
    () =>
      prepareCheckoutOrderCatalogRows(items, products, variants, new Map()),
    (error) => {
      assert.ok(!(error instanceof InsufficientStockError))
      assert.equal((error as Error).message, STOCK_CHANGED_MESSAGE)
      return true
    },
  )
})

test("los tres medios conservan la misma base y sus diferencias reales", () => {
  const customer = normalizeCheckoutOrderCustomer(validCustomer)
  const shipping = getCheckoutOrderShippingFields({
    provider: "andreani",
    type: "domicilio",
    costReal: 12_345.67,
    costCharged: 10_000,
    freeShippingApplied: false,
  })
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
  })
  const customerCredit = buildCheckoutOrderBase({
    ...common,
    paymentMethodId: "customer_credit",
    creditBalanceUsed: 10_000,
    externalAmountDue: 0,
  })

  for (const base of [mercadoPago, transferencia, customerCredit]) {
    const order = { ...base, ...shipping }
    assert.equal(order.total, 10_000)
    assert.equal(order.original_total, 10_000)
    assert.equal(order.credit_balance_used, 0)
    assert.equal(order.estado, "pendiente")
    assert.equal(order.checkout_idempotency_key, "checkout:session-1")
    assert.equal(order.store_benefit_id, "benefit-1")
    assert.equal(order.cliente_nombre, "María Muñoz")
    assert.equal(order.cliente_email, "maria@example.com")
    assert.equal(order.cliente_telefono, "+54 11 5555-1234")
    assert.equal(order.cliente_dni, "30123456")
    assert.equal(order.cliente_direccion, "Avenida Córdoba 1234")
    assert.equal(order.cp_destino, "3230")
    assert.equal(order.localidad, "Paso de los Libres")
    assert.equal(order.provincia, "Corrientes")
    assert.equal(order.shipping_provider, "andreani")
    assert.equal(order.shipping_type, "domicilio")
    assert.equal(order.shipping_cost_real, 12_345.67)
    assert.equal(order.shipping_cost_charged, 10_000)
  }
  assert.equal(mercadoPago.payment_composition.parts[1].type, "mercadopago")
  assert.equal(
    transferencia.payment_composition.parts[1].type,
    "transferencia",
  )
  assert.equal(customerCredit.payment_composition.parts.length, 1)
  assert.equal(customerCredit.payment_composition.parts[0].type, "customer_credit")
  assert.equal(
    "cp_destino" in transferencia && transferencia.cp_destino,
    "3230",
  )
  assert.equal("cp_destino" in mercadoPago && mercadoPago.cp_destino, "3230")
  assert.equal(
    "cp_destino" in customerCredit && customerCredit.cp_destino,
    "3230",
  )
})

test("buildCheckoutOrderBase persiste la modalidad de cuotas como snapshot histórico", () => {
  const customer = normalizeCheckoutOrderCustomer(validCustomer)
  const base = {
    userId: "user-1",
    total: 84_300,
    externalAmountDue: 84_300,
    creditBalanceUsed: 0,
    paymentMethodId: "mercadopago",
    storeBenefitDiscountAmount: 0,
    customer,
  }

  const financed = buildCheckoutOrderBase({
    ...base,
    installments: {
      count: 3,
      percent: 21,
      productsBaseAmount: 75_000,
      surchargeAmount: 9_300,
    },
  })

  assert.equal(financed.installments_count, 3)
  assert.equal(financed.installments_percent, 21)
  assert.equal(financed.installments_products_base_amount, 75_000)
  assert.equal(financed.installments_surcharge_amount, 9_300)

  const singlePayment = buildCheckoutOrderBase({ ...base, total: 75_000, externalAmountDue: 75_000 })

  assert.equal(singlePayment.installments_count, null)
  assert.equal(singlePayment.installments_percent, null)
  assert.equal(singlePayment.installments_products_base_amount, null)
  assert.equal(singlePayment.installments_surcharge_amount, null)
})

test("transferencia nunca recibe financiación: create-order no importa ni usa el módulo de cuotas", () => {
  const source = readFileSync(
    new URL("../../app/api/transferencia/create-order/route.ts", import.meta.url),
    "utf8",
  )

  assert.doesNotMatch(source, /products\/installments/)
  assert.doesNotMatch(source, /installmentsModality/)
})

test("create-preference recalcula la modalidad server-side y nunca confía en el navegador", () => {
  const source = readFileSync(
    new URL("../../app/api/mercadopago/create-preference/route.ts", import.meta.url),
    "utf8",
  )

  // La elegibilidad se recalcula contra el catálogo real (nunca contra lo
  // que mandó el navegador) y se rechaza si no coincide.
  assert.match(source, /getCartInstallmentEligibility\(catalog\.products\)/)
  assert.match(source, /status: 400/)
  // El % vigente sale de la configuración global fresca, nunca del payload.
  assert.match(source, /siteSettings\.installmentsFinancing/)
  assert.doesNotMatch(source, /payload\.installmentsFinancing/)
  assert.doesNotMatch(source, /payload\.percent/)
  assert.doesNotMatch(source, /payload\.total\b/)
  // La preferencia fuerza payment_methods.installments/default_installments
  // (nunca deja que Mercado Pago ofrezca sus propias cuotas sin control).
  assert.match(source, /payment_methods:\s*\{/)
  assert.match(source, /default_installments/)
  // Pago único (sin modalidad elegida) siempre manda installments = 1, no
  // "sin restricción": el precio base nunca se financia por accidente.
  assert.match(
    source,
    /order\.installments_count[\s\S]{0,20}\?[\s\S]{0,20}Number\(order\.installments_count\)[\s\S]{0,10}:\s*1/,
  )
  // La modalidad pedida por el navegador siempre pasa por el normalizador
  // (2|3|6 o null) antes de usarse -- nunca un número crudo del payload.
  assert.match(
    source,
    /normalizeRequestedInstallmentsModality\([\s\S]{0,30}payload\.installmentsModality/,
  )
})

test("una modalidad pedida pero no habilitada en ningún producto del carrito nunca llega a calcular un plan", () => {
  const source = readFileSync(
    new URL("../../app/api/mercadopago/create-preference/route.ts", import.meta.url),
    "utf8",
  )

  // El rechazo (400) ocurre ANTES de tocar site_settings/calculateInstallmentPlan:
  // nunca se calcula un monto financiado para una modalidad no habilitada.
  const eligibilityCheckIndex = source.indexOf(
    "getCartInstallmentEligibility(catalog.products)",
  )
  const firstPlanCalculationIndex = source.indexOf("calculateInstallmentPlan(")
  assert.ok(eligibilityCheckIndex >= 0 && firstPlanCalculationIndex >= 0)
  assert.ok(eligibilityCheckIndex < firstPlanCalculationIndex)
})

test("getCheckoutOrderShippingFields persiste la sucursal verificada; domicilio y sucursal sin sucursal quedan en null", () => {
  const domicilio = getCheckoutOrderShippingFields({
    provider: "andreani",
    type: "domicilio",
    costReal: 12_000,
    costCharged: 10_000,
    freeShippingApplied: false,
  })
  assert.equal(domicilio.andreani_sucursal_id, null)
  assert.equal(domicilio.andreani_sucursal_codigo, null)
  assert.equal(domicilio.andreani_sucursal_nombre, null)
  assert.equal(domicilio.andreani_sucursal_direccion, null)
  assert.equal(domicilio.andreani_sucursal_localidad, null)
  assert.equal(domicilio.andreani_sucursal_provincia, null)
  assert.equal(domicilio.andreani_sucursal_cp, null)

  const branch: VerifiedAndreaniBranch = {
    id: "10055",
    codigo: "SFN",
    nombre: "SANTA FE (CENTRO)",
    direccion: "25 de Mayo 3340",
    localidad: "Santa Fe",
    provincia: "Santa Fe",
    codigoPostal: "3000",
  }
  const sucursal = getCheckoutOrderShippingFields(
    {
      provider: "andreani",
      type: "sucursal",
      costReal: 11_000,
      costCharged: 9_000,
      freeShippingApplied: false,
    },
    branch,
  )
  assert.equal(sucursal.andreani_sucursal_id, "10055")
  assert.equal(sucursal.andreani_sucursal_codigo, "SFN")
  assert.equal(sucursal.andreani_sucursal_nombre, "SANTA FE (CENTRO)")
  assert.equal(sucursal.andreani_sucursal_direccion, "25 de Mayo 3340")
  assert.equal(sucursal.andreani_sucursal_localidad, "Santa Fe")
  assert.equal(sucursal.andreani_sucursal_provincia, "Santa Fe")
  assert.equal(sucursal.andreani_sucursal_cp, "3000")
})

test("resolveCheckoutOrderShippingBranch: domicilio nunca consulta sucursales ni exige nada", async () => {
  let called = false
  const branch = await resolveCheckoutOrderShippingBranch(
    { provider: "andreani", type: "domicilio", quoteToken: "token" },
    { cpDestino: "3230", localidad: "Paso de los Libres", provincia: "Corrientes" },
    { getBranches: async () => { called = true; return [] } },
  )
  assert.equal(branch, null)
  assert.equal(called, false)
})

test("resolveCheckoutOrderShippingBranch: sucursal sin sucursalId (nunca elegida) se rechaza con un error claro, sin fallback a domicilio", async () => {
  await assert.rejects(
    () =>
      resolveCheckoutOrderShippingBranch(
        { provider: "andreani", type: "sucursal", quoteToken: "token" },
        { cpDestino: "3230", localidad: "Paso de los Libres", provincia: "Corrientes" },
      ),
    (error: unknown) =>
      error instanceof AndreaniError &&
      error.code === "VALIDATION_ERROR" &&
      error.message.includes("sucursal"),
  )
})

test("resolveCheckoutOrderShippingBranch: un sucursalId manipulado que no está en la lista real de Andreani se rechaza", async () => {
  await assert.rejects(
    () =>
      resolveCheckoutOrderShippingBranch(
        { provider: "andreani", type: "sucursal", quoteToken: "token", sucursalId: "99999" },
        { cpDestino: "3000", localidad: "Santa Fe", provincia: "Santa Fe" },
        {
          env: {
            NODE_ENV: "test",
            ANDREANI_ENV: "QA",
            ANDREANI_QA_CLIENT: "CLIENTE-QA",
            ANDREANI_QA_ORIGIN_BRANCH: "RAC",
            ANDREANI_QA_BRANCH_CONTRACT: "CONTRATO-SUCURSAL-QA",
          },
          getBranches: async () => [
            {
              id: 10055,
              codigo: "SFN",
              numero: "55",
              descripcion: "SANTA FE (CENTRO)",
              canal: "B2C",
              direccion: {
                calle: "25 de Mayo",
                numero: "3340",
                provincia: "Santa Fe",
                localidad: "Santa Fe",
                region: "Litoral",
                pais: "Argentina",
                codigoPostal: "3000",
              },
            },
          ],
        },
      ),
    (error: unknown) =>
      error instanceof AndreaniError && error.code === "VALIDATION_ERROR",
  )
})

test("resolveCheckoutOrderShippingBranch: un sucursalId real se verifica y devuelve el snapshot canónico, listo para persistir", async () => {
  const branch = await resolveCheckoutOrderShippingBranch(
    { provider: "andreani", type: "sucursal", quoteToken: "token", sucursalId: 10055 },
    { cpDestino: "3000", localidad: "Santa Fe", provincia: "Santa Fe" },
    {
      env: {
        NODE_ENV: "test",
        ANDREANI_ENV: "QA",
        ANDREANI_QA_CLIENT: "CLIENTE-QA",
        ANDREANI_QA_ORIGIN_BRANCH: "RAC",
        ANDREANI_QA_BRANCH_CONTRACT: "CONTRATO-SUCURSAL-QA",
      },
      getBranches: async () => [
        {
          id: 10055,
          codigo: "SFN",
          numero: "55",
          descripcion: "SANTA FE (CENTRO)",
          canal: "B2C",
          direccion: {
            calle: "25 de Mayo",
            numero: "3340",
            provincia: "Santa Fe",
            localidad: "Santa Fe",
            region: "Litoral",
            pais: "Argentina",
            codigoPostal: "3000",
          },
        },
      ],
    },
  )

  assert.deepEqual(branch, {
    id: "10055",
    codigo: "SFN",
    nombre: "SANTA FE (CENTRO)",
    direccion: "25 de Mayo 3340",
    localidad: "Santa Fe",
    provincia: "Santa Fe",
    codigoPostal: "3000",
  })
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
        logisticsBaseSubsidy: 0,
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

    // La validación de catálogo/stock (que puede lanzar
    // InsufficientStockError) debe ejecutarse ANTES de insertar la orden:
    // si el stock no alcanza, no debe crearse ninguna orden, preferencia de
    // Mercado Pago, débito de saldo ni comprobante.
    const catalogIndex = source.indexOf(
      "loadAndValidateCheckoutOrderCatalog(",
    )
    const orderInsertIndex = source.search(/\.from\("ordenes"\)\s*\n\s*\.insert\(/)
    assert.ok(
      catalogIndex >= 0 && orderInsertIndex >= 0,
      `${route.path}: no se encontró la validación de catálogo o el insert de la orden`,
    )
    assert.ok(
      catalogIndex < orderInsertIndex,
      `${route.path}: la validación de stock debe ocurrir antes de crear la orden`,
    )

    // El error de stock insuficiente se responde con una estructura segura
    // (código + items afectados), no con el mensaje genérico crudo.
    assert.match(source, /InsufficientStockError/)
    assert.match(source, /INSUFFICIENT_STOCK/)

    // Los tres medios resuelven/verifican la sucursal server-side (nunca
    // confían en lo que mandó el navegador) y la pasan a
    // getCheckoutOrderShippingFields para persistirla junto al resto del
    // envío -- ver resolveCheckoutOrderShippingBranch.
    assert.match(source, /resolveCheckoutOrderShippingBranch\(/)
    assert.match(
      source,
      /getCheckoutOrderShippingFields\(\s*\n\s*normalizedShipping,\s*\n\s*shippingBranch,\s*\n\s*\)/,
    )
    const branchResolveIndex = source.indexOf(
      "resolveCheckoutOrderShippingBranch(",
    )
    const shippingFieldsIndex = source.indexOf(
      "getCheckoutOrderShippingFields(",
    )
    assert.ok(
      branchResolveIndex >= 0 &&
        shippingFieldsIndex >= 0 &&
        branchResolveIndex < shippingFieldsIndex,
      `${route.path}: la sucursal debe resolverse ANTES de persistir los campos de envío`,
    )
  }
})
