import assert from "node:assert/strict"
import test from "node:test"
import type { SupabaseProducto } from "../supabase/types.ts"
import { filterCatalogProducts, getAvailableCatalogColors, getCustomerFilterColors, MULTICOLOR_FILTER, RANDOM_COLOR_FILTER, type CatalogFilterValues } from "./catalog-filters.ts"

function product(id: number, slug: string, price: number, mode: "especifico" | "aleatorio_variantes", colors: Array<[string, string, string | null]>, overrides: Partial<SupabaseProducto> = {}): SupabaseProducto {
  return {
    id, slug: `producto-${id}`, nombre: `Producto ${id}`, precio: price, precio_anterior: null,
    destacado: false, modo_color: mode, categorias: { id, slug, nombre: slug } as SupabaseProducto["categorias"],
    producto_variantes: colors.map(([name, first, second], index) => ({ id: id * 10 + index, producto_id: id, nombre: name, color_hex: first, color_hex_secundario: second, activo: true, orden: index, stock: 2, imagenes: [], created_at: "2026-01-01T00:00:00Z" })),
    ...overrides,
  } as SupabaseProducto
}

const black = product(1, "tecnologia", 100, "especifico", [["NEGRO", "#000000", null]])
const bicolor = product(2, "hogar", 200, "especifico", [["AZUL / ROSA", "#2563EB", "#EC4899"]], { precio_anterior: 250 })
const random = product(3, "accesorios", 300, "aleatorio_variantes", [["ROJO", "#EF4444", null], ["NEGRO", "#000000", null]])
const randomBicolor = product(4, "hogar", 400, "aleatorio_variantes", [["AZUL / ROSA", "#2563EB", "#EC4899"]])
const uncolored = product(5, "hogar", 500, "especifico", [])
const catalog = [black, bicolor, random, randomBicolor, uncolored]
const defaults: CatalogFilterValues = { search: "", sortBy: "relevance", selectedCategories: [], selectedColors: [], onlyOffers: false, onlyBestSellers: false, minPrice: 0, maxPrice: 1000 }
const ids = (values: Partial<CatalogFilterValues>) => filterCatalogProducts(catalog, { ...defaults, ...values }).map((item) => item.id)

test("color simple y bicolor usan colores elegibles; Multicolor requiere dos hex válidos distintos", () => {
  assert.deepEqual(getCustomerFilterColors(black), ["negro"])
  assert.ok(["azul", "rosa", MULTICOLOR_FILTER].every((color) => getCustomerFilterColors(bicolor).includes(color)))
  assert.deepEqual(ids({ selectedColors: ["azul"] }), [2])
  assert.deepEqual(ids({ selectedColors: ["rosa"] }), [2])
  assert.deepEqual(ids({ selectedColors: [MULTICOLOR_FILTER] }), [2])
  assert.deepEqual(getCustomerFilterColors(uncolored), [])
  const sameColor = product(6, "hogar", 200, "especifico", [["AZUL", "#2563EB", "#2563EB"]])
  assert.equal(getCustomerFilterColors(sameColor).includes(MULTICOLOR_FILTER), false)
  const inactive = product(7, "hogar", 200, "especifico", [["AZUL / ROSA", "#2563EB", "#EC4899"]])
  inactive.producto_variantes![0].activo = false
  assert.equal(getCustomerFilterColors(inactive).includes(MULTICOLOR_FILTER), false)
})

test("venta aleatoria responde sólo a Aleatorio, nunca a sus colores físicos", () => {
  assert.deepEqual(getCustomerFilterColors(random), [RANDOM_COLOR_FILTER])
  assert.deepEqual(getCustomerFilterColors(randomBicolor), [RANDOM_COLOR_FILTER])
  assert.deepEqual(ids({ selectedColors: [RANDOM_COLOR_FILTER] }), [3, 4])
  assert.deepEqual(ids({ selectedColors: ["rojo"] }), [])
  assert.deepEqual(ids({ selectedColors: ["negro"] }), [1])
})

test("opciones disponibles salen del catálogo, no del filtro activo", () => {
  assert.deepEqual(getAvailableCatalogColors([black, bicolor, random]), ["negro", "azul", "rosa", MULTICOLOR_FILTER, RANDOM_COLOR_FILTER])
  assert.deepEqual(getAvailableCatalogColors([black]), ["negro"])
})

test("categorías son OR; grupos de filtros se combinan con AND y colores múltiples con OR", () => {
  assert.deepEqual(ids({ selectedCategories: ["hogar", "accesorios"] }), [2, 3, 4, 5])
  assert.deepEqual(ids({ selectedCategories: ["hogar"], selectedColors: ["azul"] }), [2])
  assert.deepEqual(ids({ selectedCategories: ["hogar"], selectedColors: [MULTICOLOR_FILTER] }), [2])
  assert.deepEqual(ids({ selectedCategories: ["accesorios"], selectedColors: [RANDOM_COLOR_FILTER] }), [3])
  assert.deepEqual(ids({ selectedColors: ["negro", "azul"] }), [1, 2])
  assert.deepEqual(ids({ minPrice: 250, selectedColors: [RANDOM_COLOR_FILTER] }), [3, 4])
  assert.deepEqual(ids({ onlyOffers: true, selectedColors: [MULTICOLOR_FILTER] }), [2])
  assert.deepEqual(ids({ selectedCategories: [], selectedColors: [] }), [1, 2, 3, 4, 5])
})
