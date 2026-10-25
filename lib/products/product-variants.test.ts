import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  CONDITIONED_VARIANT_PREFIX,
  getDefaultVariantValue,
  getDraftPreviewProduct,
  getProductImagesByVariant,
  getProductVariantOptions,
  getVariantIdFromValue,
  getVariantOptionByValue,
  RANDOM_VARIANT_VALUE,
} from "./product-variants.ts"
import type { SupabaseProducto } from "../supabase/types.ts"

test("aleatorio simple vende el stock único sin ofrecer el color técnico", () => {
  const base = product()
  const options = getProductVariantOptions(product({
    sku: "ENCENUSB001", modo_color: "aleatorio_simple", venta_aleatoria: false,
    producto_variantes: [{ ...base.producto_variantes![0], nombre: "ALEATORIO", color_hex: "#8B5A2B", stock: 12 }],
    conditioned_stock: [],
  }))
  assert.equal(options.length, 1)
  assert.deepEqual({ id: options[0].id, name: options[0].name, stock: options[0].stock, colorHex: options[0].colorHex, isRandom: options[0].isRandom },
    { id: 10, name: "Aleatorio según disponibilidad", stock: 12, colorHex: null, isRandom: true })
})

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

test("un producto activo con todas sus variantes inactivas no ofrece una opción genérica", () => {
  const source = product({ conditioned_stock: [] })
  source.producto_variantes!.forEach((variant) => {
    variant.activo = false
  })
  assert.deepEqual(getProductVariantOptions(source), [])
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

test("la imagen principal no se duplica si ya pertenece a imagenes_producto", () => {
  const source = product({
    producto_variantes: [],
    imagen_principal: "https://example.com/imagen-1.webp",
    imagenes_producto: [
      {
        id: 3,
        producto_id: 1,
        url: "https://example.com/imagen-3.webp",
        orden: 3,
        created_at: "2026-03-01T00:00:00.000Z",
      },
      {
        id: 1,
        producto_id: 1,
        url: "https://example.com/imagen-1.webp",
        orden: 1,
        created_at: "2026-03-01T00:00:00.000Z",
      },
      {
        id: 2,
        producto_id: 1,
        url: "https://example.com/imagen-2.webp",
        orden: 2,
        created_at: "2026-03-01T00:00:00.000Z",
      },
    ],
  })

  assert.deepEqual(getProductImagesByVariant(source), [
    "https://example.com/imagen-1.webp",
    "https://example.com/imagen-2.webp",
    "https://example.com/imagen-3.webp",
  ])
})

test("una variante usa solamente producto_variantes.imagenes", () => {
  const source = product({
    imagen_principal: "https://example.com/principal.webp",
    imagenes_producto: [
      {
        id: 1,
        producto_id: 1,
        url: "https://example.com/producto.webp",
        orden: 1,
        created_at: "2026-03-01T00:00:00.000Z",
      },
    ],
  })

  assert.deepEqual(getProductImagesByVariant(source, "variant:10"), [
    "https://example.com/negro.webp",
  ])
})

test("normaliza duplicados históricos dentro de una misma fuente", () => {
  const source = product({
    producto_variantes: [],
    imagen_principal: null,
    imagenes_producto: [
      {
        id: 1,
        producto_id: 1,
        url: "https://example.com/repetida.webp",
        orden: 1,
        created_at: "2026-03-01T00:00:00.000Z",
      },
      {
        id: 2,
        producto_id: 1,
        url: "https://example.com/repetida.webp",
        orden: 2,
        created_at: "2026-03-01T00:00:00.000Z",
      },
    ],
  })

  assert.deepEqual(getProductImagesByVariant(source), [
    "https://example.com/repetida.webp",
  ])
})

test("la vista previa de variantes inactivas agrega sus arrays sin usar imagenes_producto", () => {
  const source = product({
    imagen_principal: "https://example.com/variante-1.webp",
    imagenes_producto: [
      {
        id: 1,
        producto_id: 1,
        url: "https://example.com/imagen-historica.webp",
        orden: 1,
        created_at: "2026-03-01T00:00:00.000Z",
      },
    ],
    producto_variantes: [
      {
        ...product().producto_variantes![0],
        activo: false,
        imagenes: ["https://example.com/variante-1.webp"],
      },
      {
        ...product().producto_variantes![1],
        activo: false,
        imagenes: ["https://example.com/variante-2.webp"],
      },
    ],
  })

  assert.deepEqual(getProductImagesByVariant(source), [
    "https://example.com/variante-1.webp",
    "https://example.com/variante-2.webp",
  ])
})

// Caso real MALIBU (producto 9): tres colores físicos, cada uno con sus fotos.
const MALIBU_IMAGES = {
  negro: ["https://example.com/malibu-negro-1.png", "https://example.com/malibu-negro-2.png"],
  rosa: ["https://example.com/malibu-rosa-1.png", "https://example.com/malibu-rosa-2.png"],
  verde: ["https://example.com/malibu-verde-1.png", "https://example.com/malibu-verde-2.png"],
}

function malibu(overrides: Partial<SupabaseProducto> = {}, active = true): SupabaseProducto {
  const base = product().producto_variantes![0]
  return product({
    id: 9,
    nombre: "AURICULAR INALAMBRICO MALIBU",
    modo_color: "especifico",
    imagen_principal: MALIBU_IMAGES.negro[0],
    imagenes_producto: [],
    conditioned_stock: [],
    producto_variantes: [
      { ...base, id: 9, producto_id: 9, nombre: "NEGRO", sku: "AUMN01", color_hex: "#000000", stock: 6, imagenes: MALIBU_IMAGES.negro, activo: active, orden: 1 },
      { ...base, id: 15, producto_id: 9, nombre: "ROSA", sku: "AUMR01", color_hex: "#ECA2A2", stock: 3, imagenes: MALIBU_IMAGES.rosa, activo: active, orden: 1 },
      { ...base, id: 16, producto_id: 9, nombre: "VERDE", sku: "AUMV01", color_hex: "#7FB77E", stock: 3, imagenes: MALIBU_IMAGES.verde, activo: active, orden: 1 },
    ],
    ...overrides,
  })
}

test("color específico con NEGRO/ROSA/VERDE ofrece las tres variantes con su SKU y stock", () => {
  const options = getProductVariantOptions(malibu())
  assert.deepEqual(
    options.map(({ id, name, sku, stock, isRandom }) => ({ id, name, sku, stock, isRandom })),
    [
      { id: 9, name: "NEGRO", sku: "AUMN01", stock: 6, isRandom: false },
      { id: 15, name: "ROSA", sku: "AUMR01", stock: 3, isRandom: false },
      { id: 16, name: "VERDE", sku: "AUMV01", stock: 3, isRandom: false },
    ],
  )
})

test("cada color muestra sólo sus imágenes, nunca las de otra variante", () => {
  const source = malibu()
  assert.deepEqual(getProductImagesByVariant(source, "variant:9"), MALIBU_IMAGES.negro)
  assert.deepEqual(getProductImagesByVariant(source, "variant:15"), MALIBU_IMAGES.rosa)
  assert.deepEqual(getProductImagesByVariant(source, "variant:16"), MALIBU_IMAGES.verde)
  for (const option of getProductVariantOptions(source)) {
    const foreign = Object.values(MALIBU_IMAGES).flat().filter((url) => !option.images.includes(url))
    assert.equal(foreign.length, 4, `${option.name} mezcla imágenes de otro color`)
  }
})

test("una variante sin fotos cae a la imagen del producto padre, no a la galería de otros colores", () => {
  const source = malibu({
    imagen_principal: "https://example.com/malibu-general.png",
  })
  source.producto_variantes![1].imagenes = []
  assert.deepEqual(getProductImagesByVariant(source, "variant:15"), ["https://example.com/malibu-general.png"])
})

test("el carrito recibe la variante exacta elegida", () => {
  const source = malibu()
  for (const id of [9, 15, 16]) {
    const option = getVariantOptionByValue(source, `variant:${id}`)
    assert.equal(option.id, id)
    assert.equal(getVariantIdFromValue(option.value), id)
  }
  assert.equal(getDefaultVariantValue(source), "variant:9")
})

test("una variante con descuento sin fotos usa las de su variante de origen", () => {
  const source = malibu({
    conditioned_stock: [{ ...product().conditioned_stock![0], product_id: 9, variant_id: 15, conditioned_name: "ROSA · Con descuento", conditioned_sku: "AUMR01-DESC", conditioned_color_hex: "#ECA2A2" }],
  })
  const conditioned = getProductVariantOptions(source).find((option) => option.isConditioned)
  assert.deepEqual(conditioned?.images, MALIBU_IMAGES.rosa)
})

test("aleatorio con variantes físicas mantiene una sola opción y la galería de todos los colores", () => {
  const options = getProductVariantOptions(malibu({ modo_color: "aleatorio_variantes" }))
  assert.equal(options.length, 1)
  assert.equal(options[0].value, RANDOM_VARIANT_VALUE)
  assert.equal(options[0].stock, 12)
  assert.deepEqual(options[0].images, [...MALIBU_IMAGES.negro, ...MALIBU_IMAGES.rosa, ...MALIBU_IMAGES.verde])
})

test("la tienda no ofrece variantes inactivas; la vista previa de Admin las muestra separadas", () => {
  const inactive = malibu({}, false)
  assert.deepEqual(getProductVariantOptions(inactive), [])
  const preview = getDraftPreviewProduct(inactive)
  assert.notEqual(preview, inactive)
  assert.deepEqual(getProductVariantOptions(preview).map((option) => option.name), ["NEGRO", "ROSA", "VERDE"])
  assert.deepEqual(getProductImagesByVariant(preview, "variant:16"), MALIBU_IMAGES.verde)
  // No modifica el producto original.
  assert.equal(inactive.producto_variantes!.every((variant) => variant.activo === false), true)
})

test("la vista previa respeta el estado real cuando ya hay alguna variante activa", () => {
  const partial = malibu()
  partial.producto_variantes![1].activo = false
  assert.equal(getDraftPreviewProduct(partial), partial)
  assert.deepEqual(getProductVariantOptions(partial).map((option) => option.name), ["NEGRO", "VERDE"])
  const simple = product({ producto_variantes: [] })
  assert.equal(getDraftPreviewProduct(simple), simple)
})

test("el editor persiste imágenes de variante sin registrarlas como galería simple", () => {
  const editorSource = readFileSync(
    new URL(
      "../../app/admin/sections/productos/product-variants-editor.tsx",
      import.meta.url,
    ),
    "utf8",
  )
  const uploadSource = readFileSync(
    new URL("../supabase/queries/producto-imagenes.ts", import.meta.url),
    "utf8",
  )
  const variantUpload = uploadSource.match(
    /export async function uploadProductoVariantImages[\s\S]*?\n}\n/,
  )?.[0]

  assert.ok(variantUpload)
  assert.doesNotMatch(variantUpload, /\.from\("imagenes_producto"\)/)
  assert.match(editorSource, /uploadProductoVariantImages/)
  assert.doesNotMatch(editorSource, /uploadProductoImages|updateProductoImageOrder/)
})
