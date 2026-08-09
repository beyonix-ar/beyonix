import assert from "node:assert/strict"
import test from "node:test"

import {
  getProductActivationStatus,
  getVariantActivationError,
  sortProductActivationVariants,
  type ProductActivationInput,
} from "./product-activation.ts"

function completeProduct(
  overrides: Partial<ProductActivationInput> = {},
): ProductActivationInput {
  return {
    title: "Apoyabrazos ergonómico",
    sku: "AP-NEGRO",
    price: 75_000,
    categoryId: 3,
    categoryExists: true,
    description: "Soporte reforzado para escritorio.",
    specifications: [
      { activo: true, icono: "Shield", texto: "Construcción reforzada" },
    ],
    logistics: { weight: 1.2, depth: 20, width: 30, length: 40 },
    variants: [
      {
        id: 10,
        orden: 1,
        active: true,
        nombre: "Negro",
        sku: "AP-NEGRO",
        colorHex: "#000000",
        images: ["https://example.com/negro.webp"],
        assignedStock: 5,
      },
    ],
    ...overrides,
  }
}

test("bloquea la activación con mensajes específicos", () => {
  assert.equal(
    getProductActivationStatus(completeProduct({ description: " " })).firstError,
    "Completá la descripción.",
  )
  assert.equal(
    getProductActivationStatus(
      completeProduct({ logistics: { weight: null, depth: 20, width: 30, length: 40 } }),
    ).firstError,
    "Completá peso, profundidad, ancho y largo.",
  )
  assert.equal(
    getProductActivationStatus(completeProduct({ variants: [] })).firstError,
    "Creá al menos una variante.",
  )
})

test("valida imágenes y stock de la variante principal", () => {
  const withoutImages = completeProduct()
  withoutImages.variants[0]!.images = []
  assert.equal(
    getProductActivationStatus(withoutImages).firstError,
    "La variante principal necesita al menos una imagen.",
  )

  const withoutStock = completeProduct()
  withoutStock.variants[0]!.assignedStock = 0
  assert.equal(
    getProductActivationStatus(withoutStock).firstError,
    "La variante principal necesita stock asignado.",
  )
})

test("un producto completo queda listo para activar", () => {
  const status = getProductActivationStatus(completeProduct())
  assert.equal(status.ready, true)
  assert.equal(status.firstError, null)
  assert.ok(status.requirements.every((requirement) => requirement.complete))
})

test("la primera variante se define por orden e id como desempate", () => {
  const variants = [
    { ...completeProduct().variants[0]!, id: 12, orden: 2, nombre: "Negro" },
    { ...completeProduct().variants[0]!, id: 11, orden: 1, nombre: "Blanco" },
    { ...completeProduct().variants[0]!, id: 10, orden: 1, nombre: "Gris" },
  ]

  assert.deepEqual(
    sortProductActivationVariants(variants).map((variant) => variant.nombre),
    ["Gris", "Blanco", "Negro"],
  )
})

test("una variante activa debe estar completa", () => {
  const variant = completeProduct().variants[0]!
  assert.equal(getVariantActivationError({ ...variant, sku: null }), "La variante necesita un SKU.")
  assert.equal(getVariantActivationError({ ...variant, colorHex: "" }), "La variante necesita un color.")
  assert.equal(getVariantActivationError(variant), null)
})

test("un producto activo requiere al menos una variante marcada como activa", () => {
  const withoutActiveVariants = completeProduct({
    variants: [{ ...completeProduct().variants[0]!, active: false }],
  })

  assert.equal(
    getProductActivationStatus(withoutActiveVariants).firstError,
    "Activá al menos una variante.",
  )
})
