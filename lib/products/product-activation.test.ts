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
        barcode: "7790001000017",
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
  assert.equal(
    getVariantActivationError({ ...variant, barcode: " " }),
    "La variante necesita un código de barra (de fabricante o BEYONIX).",
  )
  assert.equal(getVariantActivationError({ ...variant, barcode: "BX-AUR-000001" }), null)
  assert.equal(getVariantActivationError(variant), null)
})

test("publicar exige al menos una variante activa y vendible (I/J)", () => {
  const withoutActiveVariants = completeProduct({
    variants: [{ ...completeProduct().variants[0]!, active: false }],
  })
  const blocked = getProductActivationStatus(withoutActiveVariants)
  assert.equal(blocked.ready, false)
  assert.equal(blocked.firstError, "Activá al menos una variante vendible antes de publicar el producto.")
  assert.equal(blocked.requirements.find((requirement) => requirement.key === "activeVariants")?.complete, false)

  // Una variante activa pero sin stock no es vendible: tampoco publica.
  const unsellable = completeProduct({
    variants: [
      { ...completeProduct().variants[0]!, active: false },
      { ...completeProduct().variants[0]!, id: 11, orden: 2, active: true, assignedStock: 0 },
    ],
  })
  assert.equal(getProductActivationStatus(unsellable).ready, false)

  const sellable = completeProduct({
    variants: [
      { ...completeProduct().variants[0]!, active: false },
      { ...completeProduct().variants[0]!, id: 11, orden: 2, active: true },
    ],
  })
  assert.equal(getProductActivationStatus(sellable).ready, true)
})

test("un producto ya publicado con stock 0 se sigue pudiendo guardar (K)", () => {
  const published = completeProduct({
    publishing: false,
    variants: [{ ...completeProduct().variants[0]!, assignedStock: 0, barcode: null, persistedActive: true }],
  })
  const status = getProductActivationStatus(published)
  assert.equal(status.ready, true, status.firstError ?? "")
  assert.equal(status.requirements.some((requirement) => requirement.key === "activeVariants"), false)

  // Una variante que pasa a activa en ese guardado sí exige stock y código.
  const activatingVariant = completeProduct({
    publishing: false,
    variants: [
      { ...completeProduct().variants[0]!, persistedActive: true, assignedStock: 0 },
      { ...completeProduct().variants[0]!, id: 11, orden: 2, active: true, persistedActive: false, assignedStock: 0 },
    ],
  })
  assert.equal(getProductActivationStatus(activatingVariant).firstError, "La variante necesita stock asignado.")
})

test("una descripción HTML visualmente vacía no publica (L)", () => {
  for (const description of ["<p><br></p>", "<div></div>", "<p>&nbsp;</p>", "   ", "<p> </p><p><br></p>"]) {
    const status = getProductActivationStatus(completeProduct({ description }))
    assert.equal(status.firstError, "Completá la descripción.", JSON.stringify(description))
  }
  assert.equal(getProductActivationStatus(completeProduct({ description: "<p>Sonido envolvente</p>" })).ready, true)
})

test("un borrador incompleto no publica y el checklist dice qué falta (G)", () => {
  const draft = getProductActivationStatus(completeProduct({
    price: 0,
    categoryId: null,
    categoryExists: false,
    description: "",
    logistics: { weight: null, depth: null, width: null, length: null },
  }))
  assert.equal(draft.ready, false)
  assert.deepEqual(
    draft.requirements.filter((requirement) => !requirement.complete).map((requirement) => requirement.label),
    ["Precio", "Categoría", "Descripción", "Peso y medidas"],
  )
  assert.deepEqual(
    getProductActivationStatus(completeProduct()).requirements.map((requirement) => requirement.label),
    ["Nombre", "SKU", "Precio", "Categoría", "Descripción", "Especificaciones", "Peso y medidas", "Imágenes", "Variante principal", "Variantes activas"],
  )
})
