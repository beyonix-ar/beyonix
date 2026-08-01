import assert from "node:assert/strict"
import test from "node:test"

import {
  CONDITIONED_VARIANT_PREFIX,
  getProductVariantOptions,
} from "./product-variants.ts"
import type { SupabaseProducto } from "../supabase/types.ts"

function product(
  overrides: Partial<SupabaseProducto> = {},
): SupabaseProducto {
  return {
    id: 1,
    nombre: "Apoyabrazos ergonómico",
    slug: "apoyabrazos-ergonomico",
    descripcion: null,
    precio: 50_000,
    precio_anterior: null,
    descuento: null,
    cuotas_sin_interes: false,
    cuotas_maximas: null,
    stock: 5,
    categoria_id: null,
    activo: true,
    destacado: false,
    imagen_principal: "/apoyabrazos.webp",
    video_url: null,
    sku: null,
    created_at: "2026-03-01T00:00:00.000Z",
    producto_variantes: [
      {
        id: 10,
        producto_id: 1,
        nombre: "Negro",
        sku: "AP01-N",
        color_hex: "#000000",
        stock: 3,
        imagenes: ["https://example.com/negro.webp"],
        activo: true,
        orden: 1,
        created_at: "2026-03-01T00:00:00.000Z",
      },
      {
        id: 11,
        producto_id: 1,
        nombre: "Azul",
        sku: "AP01-A",
        color_hex: "#0000FF",
        stock: 2,
        imagenes: [],
        activo: true,
        orden: 2,
        created_at: "2026-03-01T00:00:00.000Z",
      },
    ],
    conditioned_stock: [
      {
        id: "52ae23f0-cabd-4c17-9a41-9ca6df3851ad",
        product_id: 1,
        variant_id: 10,
        original_quantity: 1,
        sold_quantity: 0,
        quantity: 1,
        discount_percent: 20,
        reason: "Marca superficial",
        non_sellable_quantity: 0,
        non_sellable_reason: null,
        active: true,
        approved_at: "2026-07-01T00:00:00.000Z",
        conditioned_name: "Negro · Con descuento",
        conditioned_sku: "AP01-N-DESC",
        conditioned_color_hex: "#000000",
        conditioned_images: [],
      },
    ],
    ...overrides,
  }
}

test("las variantes normales y la variante con descuento son simultáneas", () => {
  const options = getProductVariantOptions(product())
  assert.deepEqual(
    options.map((option) => option.name),
    ["Negro", "Azul", "Negro · Con descuento"],
  )
  assert.equal(options.filter((option) => option.isConditioned).length, 1)
  assert.ok(options[2].value.startsWith(CONDITIONED_VARIANT_PREFIX))
})

test("una variante con descuento conserva la relación con la variante original", () => {
  const options = getProductVariantOptions(product())
  const normal = options.find((option) => option.sku === "AP01-N")
  const conditioned = options.find((option) => option.sku === "AP01-N-DESC")
  assert.equal(normal?.id, 10)
  assert.equal(conditioned?.conditionedStockId, "52ae23f0-cabd-4c17-9a41-9ca6df3851ad")
  assert.equal(conditioned?.stock, 1)
  assert.equal(normal?.stock, 3)
})

test("las variantes inactivas no aparecen disponibles para vender", () => {
  const source = product()
  source.producto_variantes![0].activo = false
  const options = getProductVariantOptions(source)
  assert.equal(options.some((option) => option.value === "variant:10"), false)
  assert.equal(options.some((option) => option.isConditioned), true)
})

test("un producto sin variantes conserva su opción normal y su descuento", () => {
  const source = product({
    sku: "BASE-1",
    producto_variantes: [],
    conditioned_stock: [
      {
        ...product().conditioned_stock![0],
        variant_id: null,
        conditioned_sku: "BASE-1-DESC",
      },
    ],
  })
  const options = getProductVariantOptions(source)
  assert.equal(options[0].sku, "BASE-1")
  assert.equal(options[0].stock, 5)
  assert.equal(options[1].isConditioned, true)
})
