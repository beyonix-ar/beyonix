import assert from "node:assert/strict"
import test from "node:test"

import {
  IncompleteProductLogisticsError,
  resolveProductLogistics,
} from "./product-logistics.ts"
import { ProductLogisticsValidationError } from "./logistics-validation.ts"

const completeProduct = {
  id: 10,
  nombre: "Producto completo",
  sku: "PROD-10",
  peso_empaquetado_kg: 1.25,
  alto_paquete_cm: 12,
  ancho_paquete_cm: 20,
  largo_paquete_cm: 30,
}

test("resuelve un producto con datos logísticos completos", () => {
  assert.deepEqual(resolveProductLogistics(completeProduct), {
    pesoKg: 1.25,
    altoCm: 12,
    anchoCm: 20,
    largoCm: 30,
  })
})

test("una variante sin medidas hereda todos los datos del producto", () => {
  const result = resolveProductLogistics(completeProduct, {
    id: 20,
    nombre: "Variante heredada",
  })

  assert.deepEqual(result, {
    pesoKg: 1.25,
    altoCm: 12,
    anchoCm: 20,
    largoCm: 30,
  })
})

test("una variante sobrescribe por campo y hereda el resto", () => {
  const result = resolveProductLogistics(completeProduct, {
    id: 21,
    nombre: "Variante grande",
    peso_empaquetado_kg: 2.5,
    largo_paquete_cm: 45,
  })

  assert.deepEqual(result, {
    pesoKg: 2.5,
    altoCm: 12,
    anchoCm: 20,
    largoCm: 45,
  })
})

test("identifica el producto o variante con datos incompletos", () => {
  assert.throws(
    () =>
      resolveProductLogistics(
        {
          id: 11,
          nombre: "Producto incompleto",
          peso_empaquetado_kg: 1,
        },
        { id: 22, nombre: "Variante sin medidas" },
      ),
    (error) =>
      error instanceof IncompleteProductLogisticsError &&
      error.productId === 11 &&
      error.variantId === 22 &&
      error.missingFields.length === 3 &&
      error.message.includes("Variante sin medidas") &&
      error.message.includes("Producto incompleto"),
  )
})

test("rechaza valores negativos, cero, NaN y límites excesivos", () => {
  for (const invalidValue of [-1, 0, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () =>
        resolveProductLogistics({
          ...completeProduct,
          peso_empaquetado_kg: invalidValue,
        }),
      ProductLogisticsValidationError,
    )
  }

  assert.throws(
    () =>
      resolveProductLogistics({
        ...completeProduct,
        largo_paquete_cm: 1_001,
      }),
    ProductLogisticsValidationError,
  )
})
