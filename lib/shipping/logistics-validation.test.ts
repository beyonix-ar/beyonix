import assert from "node:assert/strict"
import test from "node:test"

import {
  parseOptionalProductLogistics,
  parseRequiredProductLogistics,
  ProductLogisticsValidationError,
} from "./logistics-validation.ts"

const completeValues = {
  peso_empaquetado_kg: "1,25",
  alto_paquete_cm: "12",
  ancho_paquete_cm: "20",
  largo_paquete_cm: "30",
}

test("la ficha del producto exige los cuatro datos logísticos", () => {
  assert.deepEqual(parseRequiredProductLogistics(completeValues), {
    peso_empaquetado_kg: 1.25,
    alto_paquete_cm: 12,
    ancho_paquete_cm: 20,
    largo_paquete_cm: 30,
  })
})

test("un campo vacío bloquea el guardado del producto con su propio campo identificado", () => {
  for (const field of [
    "peso_empaquetado_kg",
    "alto_paquete_cm",
    "ancho_paquete_cm",
    "largo_paquete_cm",
  ] as const) {
    assert.throws(
      () =>
        parseRequiredProductLogistics({ ...completeValues, [field]: "" }),
      (error) =>
        error instanceof ProductLogisticsValidationError &&
        error.field === field &&
        error.message.includes("obligatorio"),
    )
  }
})

test("cero, negativos, NaN y valores no numéricos quedan rechazados igual que en el resto del sistema", () => {
  for (const invalidValue of ["0", "-1", "no es un número", "NaN"]) {
    assert.throws(
      () =>
        parseRequiredProductLogistics({
          ...completeValues,
          peso_empaquetado_kg: invalidValue,
        }),
      ProductLogisticsValidationError,
    )
  }
})

test("la sobrescritura opcional por variante sigue sin exigir estos datos", () => {
  assert.deepEqual(parseOptionalProductLogistics({}), {
    peso_empaquetado_kg: null,
    alto_paquete_cm: null,
    ancho_paquete_cm: null,
    largo_paquete_cm: null,
  })
})
