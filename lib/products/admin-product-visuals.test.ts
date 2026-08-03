import assert from "node:assert/strict"
import test from "node:test"

import { firstUsableImage } from "./admin-product-visuals.ts"

test("la variante usa su imagen antes que la imagen heredada del producto", () => {
  assert.equal(
    firstUsableImage(["https://cdn.test/variante.webp"], "https://cdn.test/producto.webp"),
    "https://cdn.test/variante.webp",
  )
})

test("la variante hereda la imagen del producto cuando no tiene una propia", () => {
  assert.equal(
    firstUsableImage([], "https://cdn.test/producto.webp"),
    "https://cdn.test/producto.webp",
  )
})

test("sin imágenes disponibles devuelve null para mostrar Sin imagen", () => {
  assert.equal(firstUsableImage([], null, "  "), null)
})
