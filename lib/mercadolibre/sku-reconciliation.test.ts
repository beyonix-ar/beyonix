import assert from "node:assert/strict"
import test from "node:test"

import { getCanonicalCatalogSku } from "./sku-aliases.ts"
import { buildUniqueCatalogTargetsBySku } from "./sku-reconciliation.ts"

test("vincula un SKU exacto sin importar espacios o mayúsculas", () => {
  const targets = buildUniqueCatalogTargetsBySku([
    {
      id: 63,
      sku: " AP01 ",
      producto_variantes: [],
    },
  ])

  assert.deepEqual(targets.get("AP01"), {
    productId: 63,
    variantId: null,
  })
})

test("no vincula automáticamente un SKU ambiguo", () => {
  const targets = buildUniqueCatalogTargetsBySku([
    { id: 1, sku: "DUP01", producto_variantes: [] },
    { id: 2, sku: "dup01", producto_variantes: [] },
  ])

  assert.equal(targets.has("DUP01"), false)
})

test("los productos con variantes se vinculan por el SKU de la variante", () => {
  const targets = buildUniqueCatalogTargetsBySku([
    {
      id: 8,
      sku: "PRODUCTO-GENERAL",
      producto_variantes: [{ id: 21, sku: "VARIANTE-01" }],
    },
  ])

  assert.equal(targets.has("PRODUCTO-GENERAL"), false)
  assert.deepEqual(targets.get("VARIANTE-01"), {
    productId: 8,
    variantId: 21,
  })
})

test("un SKU viejo de mate no se trata como equivalente al SKU nuevo", () => {
  assert.equal(getCanonicalCatalogSku("MATEINOXROSA001"), "MATEINOXROSA001")
  assert.notEqual(getCanonicalCatalogSku("MATEINOXROSA001"), "MTR01")
})
