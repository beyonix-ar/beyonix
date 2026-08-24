import assert from "node:assert/strict"
import test from "node:test"

import {
  calculateCustomerShippingCost,
  calculateShippingBonus,
  DEFAULT_SHIPPING_SETTINGS,
  roundDownToCommercialEnding,
  type ShippingBonusSettings,
} from "./store-config.ts"

const belowMinSettings: ShippingBonusSettings = {
  ...DEFAULT_SHIPPING_SETTINGS,
  freeShippingMinAmount: 100_000,
  shippingBonusMax: 20_000,
  freeShippingMode: "full",
  logisticsBaseSubsidy: 3_000,
}

test("roundDownToCommercialEnding termina en 900 redondeando siempre hacia abajo", () => {
  assert.equal(roundDownToCommercialEnding(9_000), 8_900)
  assert.equal(roundDownToCommercialEnding(12_000), 11_900)
  assert.equal(roundDownToCommercialEnding(15_000), 14_900)
  assert.equal(roundDownToCommercialEnding(22_000), 21_900)
  // Ya termina en 900: no cambia.
  assert.equal(roundDownToCommercialEnding(3_900), 3_900)
  // Nunca negativo.
  assert.equal(roundDownToCommercialEnding(0), 0)
  assert.equal(roundDownToCommercialEnding(-500), 0)
})

test("compra debajo del minimo: Andreani $12.000 -> cliente $8.900", () => {
  const subtotal = 19_900
  const shippingCostReal = 12_000

  const charged = calculateCustomerShippingCost(
    subtotal,
    shippingCostReal,
    belowMinSettings,
  )
  const bonus = calculateShippingBonus(subtotal, shippingCostReal, belowMinSettings)

  assert.equal(charged, 8_900)
  assert.equal(bonus, 3_100)
  assert.equal(bonus + charged, shippingCostReal)
})

test("compra debajo del minimo: Andreani $15.000 -> cliente $11.900", () => {
  const charged = calculateCustomerShippingCost(19_900, 15_000, belowMinSettings)
  assert.equal(charged, 11_900)
})

test("compra debajo del minimo: Andreani $25.000 -> cliente $21.900", () => {
  const charged = calculateCustomerShippingCost(19_900, 25_000, belowMinSettings)
  assert.equal(charged, 21_900)
})

test("nunca produce envio negativo cuando la cotizacion es muy baja", () => {
  for (const shippingCostReal of [500, 1_000, 2_999, 3_000]) {
    const charged = calculateCustomerShippingCost(
      19_900,
      shippingCostReal,
      belowMinSettings,
    )
    assert.ok(charged >= 0, `charged debe ser >= 0 para real=${shippingCostReal}`)
    assert.ok(
      charged <= shippingCostReal,
      `charged nunca debe superar el costo real (real=${shippingCostReal})`,
    )
  }
})

test("pedido que alcanza el minimo usa la politica principal, no el subsidio base", () => {
  const subtotal = 150_000 // supera freeShippingMinAmount (100_000)

  const charged12k = calculateCustomerShippingCost(
    subtotal,
    12_000,
    belowMinSettings,
  )
  const bonus12k = calculateShippingBonus(subtotal, 12_000, belowMinSettings)
  // Política principal: bonus = min(costo, shippingBonusMax) = min(12000, 20000) = 12000 -> GRATIS.
  assert.equal(charged12k, 0)
  assert.equal(bonus12k, 12_000)

  const charged57k = calculateCustomerShippingCost(
    subtotal,
    57_000,
    belowMinSettings,
  )
  const bonus57k = calculateShippingBonus(subtotal, 57_000, belowMinSettings)
  // bonus tope en 20000 -> cliente paga 57000-20000=37000, SIN aplicar además
  // el subsidio de $3.000 (no debe dar 37000-3000=34000 redondeado).
  assert.equal(bonus57k, 20_000)
  assert.equal(charged57k, 37_000)
})

test("no se acumulan ambas bonificaciones (compra en el limite exacto del minimo)", () => {
  const settings: ShippingBonusSettings = {
    ...belowMinSettings,
    freeShippingMinAmount: 100_000,
  }

  // Justo debajo: aplica subsidio base + terminación comercial.
  const belowCharged = calculateCustomerShippingCost(99_999, 12_000, settings)
  assert.equal(belowCharged, 8_900)

  // Justo en el mínimo: aplica la política principal (bonus hasta el tope),
  // exclusivamente -- el resultado no es (8900 con un descuento adicional).
  const atMinCharged = calculateCustomerShippingCost(100_000, 12_000, settings)
  assert.equal(atMinCharged, 0)
})

test("subsidio base en $0 (desactivado) no altera el costo real", () => {
  const settings: ShippingBonusSettings = {
    ...belowMinSettings,
    logisticsBaseSubsidy: 0,
  }

  const charged = calculateCustomerShippingCost(19_900, 12_345.67, settings)
  assert.equal(charged, 12_345.67)
})

test("un shippingCost invalido o cero nunca produce un cobro", () => {
  assert.equal(calculateCustomerShippingCost(19_900, 0, belowMinSettings), 0)
  assert.equal(calculateCustomerShippingCost(19_900, -100, belowMinSettings), 0)
  assert.equal(calculateCustomerShippingCost(19_900, NaN, belowMinSettings), 0)
})
