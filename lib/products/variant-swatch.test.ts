import assert from "node:assert/strict"
import test from "node:test"

import { variantSwatchStyle } from "./variant-swatch.ts"

test("swatch de un color: fondo sólido (legacy sin cambios)", () => {
  assert.deepEqual(variantSwatchStyle("#000000"), { backgroundColor: "#000000" })
  assert.deepEqual(variantSwatchStyle("#000000", null), { backgroundColor: "#000000" })
  assert.deepEqual(variantSwatchStyle(null, "#EC4899"), {})
})

test("swatch bicolor: mitad y mitad con corte nítido", () => {
  const style = variantSwatchStyle("#2563EB", "#EC4899")
  assert.equal(style.backgroundColor, "#2563EB")
  assert.equal(style.backgroundImage, "linear-gradient(90deg, #2563EB 0 50%, #EC4899 50% 100%)")
})
