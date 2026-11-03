import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  DEFAULT_LOCAL_DELIVERY_SETTINGS,
  getLocalDeliveryCustomerCost,
  isLocalDeliveryOrder,
  isLocalDeliveryPostalCodeEligible,
  LocalDeliverySettingsError,
  normalizeLocalDeliveryPostalCode,
  normalizeStoredLocalDeliverySettings,
  parseLocalDeliverySettingsPatch,
  quoteLocalDelivery,
  toPublicLocalDeliverySettings,
  type LocalDeliverySettings,
} from "./local-delivery.ts"
import { calculateCustomerShippingCost, type ShippingBonusSettings } from "../store-config.ts"

const SETTINGS: LocalDeliverySettings = {
  enabled: true,
  customerPrice: 2_500,
  internalDeliveryCost: 2_500,
  freeThreshold: 50_000,
  postalCodes: ["2000"],
}
const PUBLIC = toPublicLocalDeliverySettings(SETTINGS)

// ── 35. Configuración ────────────────────────────────────────────────────────

test("configuración inicial: activada, CP 2000, $2.500 al cliente, $2.500 interno, gratis desde $50.000", () => {
  assert.deepEqual(DEFAULT_LOCAL_DELIVERY_SETTINGS, SETTINGS)
})

// ── Fail-safe: ausente ≠ inválida ────────────────────────────────────────────

const quiet = <T,>(run: () => T) => {
  const warn = console.warn
  const logged: unknown[][] = []
  console.warn = (...args: unknown[]) => { logged.push(args) }
  try { return { value: run(), logged } } finally { console.warn = warn }
}
const assertDisabled = (value: unknown, label: string) => {
  const { value: settings, logged } = quiet(() => normalizeStoredLocalDeliverySettings(value, true))
  assert.equal(settings.enabled, false, label)
  assert.deepEqual(settings.postalCodes, [], label)
  assert.equal(quoteLocalDelivery(toPublicLocalDeliverySettings(settings), "2000", 10_000), null, label)
  // Log interno sin el valor guardado.
  assert.deepEqual(logged, [["LOCAL_DELIVERY_SETTINGS_INVALID", { action: "disabled" }]], label)
}

test("A. setting ausente (nunca guardado) → configuración inicial válida", () => {
  assert.deepEqual(normalizeStoredLocalDeliverySettings(undefined, false), SETTINGS)
})

test("B. setting presente y válido → exactamente lo guardado", () => {
  const stored = { enabled: true, customerPrice: 3_100, internalDeliveryCost: 2_700, freeThreshold: 70_000, postalCodes: ["2000", "2132"] }
  assert.deepEqual(normalizeStoredLocalDeliverySettings(stored, true), stored)
  assert.deepEqual(normalizeStoredLocalDeliverySettings({ ...stored, enabled: false }, true).enabled, false)
})

test("C. setting presente sin enabled → desactivado (fail closed), nunca se completa con valores activos", () => {
  assertDisabled({ customerPrice: 2_500, internalDeliveryCost: 2_500, freeThreshold: 50_000, postalCodes: ["2000"] }, "sin enabled")
  assertDisabled({ ...SETTINGS, enabled: "true" }, "enabled no boolean")
})

test("D. postalCodes corruptos → desactivado", () => {
  assertDisabled({ ...SETTINGS, postalCodes: ["2000", "basura"] }, "CP inválido")
  assertDisabled({ ...SETTINGS, postalCodes: "2000" }, "no es lista")
  assertDisabled({ ...SETTINGS, postalCodes: ["2000", "2000"] }, "duplicado")
  assertDisabled({ ...SETTINGS, postalCodes: [] }, "vacío con enabled=true")
})

test("E. freeThreshold u otros importes inválidos → desactivado", () => {
  assertDisabled({ ...SETTINGS, freeThreshold: 0 }, "umbral 0")
  assertDisabled({ ...SETTINGS, freeThreshold: "50000" }, "umbral texto")
  assertDisabled({ ...SETTINGS, customerPrice: -1 }, "precio negativo")
  assertDisabled({ ...SETTINGS, internalDeliveryCost: null }, "costo interno faltante")
})

test("F. JSON corrupto o estructura incompleta → desactivado", () => {
  for (const value of ["{enabled: true", null, 42, [], {}, { enabled: true }]) assertDisabled(value, JSON.stringify(value))
})

test("G. una configuración local inválida no afecta a Andreani", () => {
  const { value: settings } = quiet(() => normalizeStoredLocalDeliverySettings("corrupto", true))
  assert.equal(settings.enabled, false)
  const andreani: ShippingBonusSettings = { defaultShippingCost: 0, freeShippingMinAmount: 75_000, shippingBonusMax: 20_000, freeShippingMode: "full", logisticsBaseSubsidy: 3_000 }
  assert.equal(calculateCustomerShippingCost(80_000, 9_000, andreani), 0)
  assert.equal(calculateCustomerShippingCost(40_000, 9_000, andreani), 5_900)
})

test("lectores: fila ausente = inicial, fila presente se valida; lectura fallida pública = desactivada", () => {
  const reader = readFileSync("lib/shipping/local-delivery-settings.ts", "utf8")
  assert.match(reader, /normalizeStoredLocalDeliverySettings\(data\?\.value, data !== null\)/)
  const site = readFileSync("lib/site-settings.ts", "utf8")
  assert.match(site, /settingsByKey\.get\(LOCAL_DELIVERY_SETTINGS_KEY\),\s+settingsByKey\.has\(LOCAL_DELIVERY_SETTINGS_KEY\)/)
  assert.match(site, /localDelivery: toPublicLocalDeliverySettings\(INVALID_LOCAL_DELIVERY_SETTINGS\)/)
})

test("la configuración pública nunca expone el costo interno", () => {
  assert.deepEqual(Object.keys(PUBLIC).sort(), ["customerPrice", "enabled", "freeThreshold", "postalCodes"])
  assert.equal("internalDeliveryCost" in PUBLIC, false)
})

test("enabled=true ofrece la modalidad para un CP habilitado; enabled=false no la ofrece", () => {
  assert.equal(isLocalDeliveryPostalCodeEligible(PUBLIC, "2000"), true)
  assert.equal(isLocalDeliveryPostalCodeEligible({ ...PUBLIC, enabled: false }, "2000"), false)
  assert.equal(quoteLocalDelivery({ ...PUBLIC, enabled: false }, "2000", 10_000), null)
})

test("CP: se normaliza antes de comparar (trim, CPA, mayúsculas) y no depende de la ciudad", () => {
  for (const value of ["2000", " 2000 ", "S2000", "s2000abc", "S2000ABC"]) {
    assert.equal(normalizeLocalDeliveryPostalCode(value), "2000", value)
    assert.equal(isLocalDeliveryPostalCodeEligible(PUBLIC, value), true, value)
  }
  for (const value of ["", "200", "20000", "ROSARIO", null, undefined, "2000-1"]) {
    assert.equal(normalizeLocalDeliveryPostalCode(value), null, String(value))
  }
  assert.equal(isLocalDeliveryPostalCodeEligible(PUBLIC, "2152"), false)
})

test("agregar y quitar códigos postales desde Admin (Funes, Roldán) cambia la elegibilidad sin tocar código", () => {
  const withFunes = parseLocalDeliverySettingsPatch({ ...SETTINGS, postalCodes: ["2000", "2132", "2134"] })
  assert.deepEqual(withFunes.postalCodes, ["2000", "2132", "2134"])
  assert.equal(isLocalDeliveryPostalCodeEligible(withFunes, "2132"), true)
  assert.equal(isLocalDeliveryPostalCodeEligible(withFunes, "2134"), true)

  const withoutFunes = parseLocalDeliverySettingsPatch({ ...withFunes, postalCodes: ["2000", "2134"] })
  assert.equal(isLocalDeliveryPostalCodeEligible(withoutFunes, "2132"), false)
  assert.equal(isLocalDeliveryPostalCodeEligible(withoutFunes, "2000"), true)
})

test("costo al cliente, costo interno y umbral se guardan tal como los edita Admin", () => {
  const next = parseLocalDeliverySettingsPatch({
    enabled: true,
    customerPrice: 3_000,
    internalDeliveryCost: 2_800,
    freeThreshold: 60_000,
    postalCodes: ["2000"],
  })
  assert.deepEqual(next, { enabled: true, customerPrice: 3_000, internalDeliveryCost: 2_800, freeThreshold: 60_000, postalCodes: ["2000"] })
  assert.equal(getLocalDeliveryCustomerCost(next, 59_999), 3_000)
  assert.equal(getLocalDeliveryCustomerCost(next, 60_000), 0)
})

test("validaciones de Admin: importes >= 0, umbral > 0, CP válido, sin duplicados, al menos un CP si está activada", () => {
  const invalid: Array<[Record<string, unknown>, RegExp]> = [
    [{ ...SETTINGS, customerPrice: -1 }, /precio al cliente/],
    [{ ...SETTINGS, internalDeliveryCost: -1 }, /costo interno/],
    [{ ...SETTINGS, freeThreshold: 0 }, /envío gratis/],
    [{ ...SETTINGS, postalCodes: [""] }, /4 números/],
    [{ ...SETTINGS, postalCodes: ["2000", " 2000"] }, /repetido/],
    [{ ...SETTINGS, postalCodes: [] }, /al menos un código postal/],
    [{ ...SETTINGS, enabled: "sí" }, /activado/],
    [{ ...SETTINGS, extra: 1 }, /no es válida/],
    [{ enabled: true }, /no es válida/],
  ]
  for (const [value, message] of invalid) {
    assert.throws(() => parseLocalDeliverySettingsPatch(value), (error: unknown) =>
      error instanceof LocalDeliverySettingsError && message.test(error.message), JSON.stringify(value))
  }
  // Precio $0 permitido (siempre gratis) y desactivada sin CP también.
  assert.equal(parseLocalDeliverySettingsPatch({ ...SETTINGS, customerPrice: 0 }).customerPrice, 0)
  assert.deepEqual(parseLocalDeliverySettingsPatch({ ...SETTINGS, enabled: false, postalCodes: [] }).postalCodes, [])
  // Se guarda normalizado y ordenado.
  assert.deepEqual(parseLocalDeliverySettingsPatch({ ...SETTINGS, postalCodes: ["S2132", "2000"] }).postalCodes, ["2000", "2132"])
})

// ── 36. Precio en checkout ───────────────────────────────────────────────────

test("A. CP 2000 y subtotal $45.000 → Envío BEYONIX $2.500", () => {
  assert.deepEqual(quoteLocalDelivery(PUBLIC, "2000", 45_000), { costCharged: 2_500, freeShipping: false })
})

test("B. CP 2000 y subtotal exactamente $50.000 → GRATIS", () => {
  assert.deepEqual(quoteLocalDelivery(PUBLIC, "2000", 50_000), { costCharged: 0, freeShipping: true })
})

test("C. CP 2000 y subtotal mayor a $50.000 → GRATIS", () => {
  assert.deepEqual(quoteLocalDelivery(PUBLIC, "2000", 55_000), { costCharged: 0, freeShipping: true })
})

test("D. CP no habilitado → no se ofrece", () => {
  assert.equal(quoteLocalDelivery(PUBLIC, "1425", 45_000), null)
})

test("E. modalidad desactivada → no se ofrece", () => {
  assert.equal(quoteLocalDelivery({ ...PUBLIC, enabled: false }, "2000", 45_000), null)
})

// ── 37. Base del umbral y beneficios ─────────────────────────────────────────

test("la base es el subtotal de productos: un descuento de producto que baja de $52.000 a $45.000 cobra el envío", () => {
  // calculateCartTotals().productsTotal ya trae los descuentos de producto.
  assert.equal(getLocalDeliveryCustomerCost(PUBLIC, 52_000), 0)
  assert.equal(getLocalDeliveryCustomerCost(PUBLIC, 45_000), 2_500)
})

test("transferencia y saldo a favor no cambian la elegibilidad: el cálculo sólo recibe el subtotal de productos", () => {
  // Productos $52.000: aunque la transferencia (10%) o el saldo bajen lo que
  // se termina pagando, el envío sigue siendo gratis.
  const productsTotal = 52_000
  const paidAfterTransfer = productsTotal * 0.9
  assert.ok(paidAfterTransfer < SETTINGS.freeThreshold)
  assert.equal(getLocalDeliveryCustomerCost(PUBLIC, productsTotal), 0)
  // Con $40.000 de productos el envío cuesta $2.500 aunque haya $20.000 de
  // saldo: el saldo es una forma de pago, no un descuento del envío.
  assert.deepEqual(quoteLocalDelivery(PUBLIC, "2000", 40_000), { costCharged: 2_500, freeShipping: false })
  assert.equal(quoteLocalDelivery.length, 3, "no existe un parámetro de saldo ni de medio de pago")
})

test("independiente de Andreani: su bonificación no afecta a Envío BEYONIX y viceversa", () => {
  const andreani: ShippingBonusSettings = {
    defaultShippingCost: 0,
    freeShippingMinAmount: 75_000,
    shippingBonusMax: 20_000,
    freeShippingMode: "full",
    logisticsBaseSubsidy: 3_000,
  }
  // $55.000: Envío BEYONIX gratis; Andreani sigue cobrando (no llega a $75.000).
  assert.equal(getLocalDeliveryCustomerCost(PUBLIC, 55_000), 0)
  assert.ok(calculateCustomerShippingCost(55_000, 9_000, andreani) > 0)
  // Cambiar la bonificación de Andreani no mueve el umbral local.
  assert.equal(getLocalDeliveryCustomerCost(PUBLIC, 45_000), 2_500)
  assert.equal(calculateCustomerShippingCost(45_000, 9_000, { ...andreani, freeShippingMinAmount: 1_000 }), 0)
  assert.equal(getLocalDeliveryCustomerCost(PUBLIC, 45_000), 2_500)
})

test("isLocalDeliveryOrder reconoce sólo el proveedor beyonix", () => {
  assert.equal(isLocalDeliveryOrder({ shipping_provider: "beyonix" }), true)
  assert.equal(isLocalDeliveryOrder({ shipping_provider: null, envio_proveedor: "BEYONIX" }), true)
  assert.equal(isLocalDeliveryOrder({ shipping_provider: "andreani" }), false)
  assert.equal(isLocalDeliveryOrder({}), false)
})
