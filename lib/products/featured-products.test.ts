import assert from "node:assert/strict"
import test from "node:test"

import {
  FEATURED_POSITION_MAX,
  FeaturedUpdateInputError,
  compareFeaturedProducts,
  getFeaturedState,
  isMissingFeaturedPositionError,
  mapFeaturedRpcError,
  orderFeaturedProducts,
  parseFeaturedUpdateInput,
  queryFeaturedProducts,
} from "./featured-products.ts"

const product = (id: number, featured_position: number | null, created_at: string) => ({ id, featured_position, created_at })

test("orden de Home: posición 1/2/3, sin posición al final, después más nuevos e id", () => {
  const products = [
    product(10, null, "2026-10-26T00:00:00Z"),
    product(3, 3, "2026-10-01T00:00:00Z"),
    product(1, 1, "2026-09-01T00:00:00Z"),
    product(11, null, "2026-10-27T00:00:00Z"),
    product(2, 2, "2026-11-01T00:00:00Z"),
    product(12, null, "2026-10-26T00:00:00Z"),
  ]
  assert.deepEqual(
    [...products].sort(compareFeaturedProducts).map((item) => item.id),
    [1, 2, 3, 11, 12, 10],
    "posicionados por número; sin posición: más nuevo primero y desempate por id desc",
  )
})

test("orderFeaturedProducts: misma secuencia de ORDER BY en la consulta (y sin columna antes de la migración)", () => {
  const calls: Array<[string, unknown]> = []
  const query = {
    order(column: string, options?: unknown) {
      calls.push([column, options])
      return query
    },
  }
  orderFeaturedProducts(query)
  assert.deepEqual(calls, [
    ["featured_position", { ascending: true, nullsFirst: false }],
    ["created_at", { ascending: false }],
    ["id", { ascending: false }],
  ])
  calls.length = 0
  orderFeaturedProducts(query, false)
  assert.deepEqual(calls.map(([column]) => column), ["created_at", "id"], "nunca por nombre")
})

test("queryFeaturedProducts: si la migración no se aplicó, Home sigue con el orden anterior", async () => {
  const attempts: boolean[] = []
  const result = await queryFeaturedProducts<{ id: number }>(async (withPosition) => {
    attempts.push(withPosition)
    return withPosition
      ? { data: null, error: { code: "42703", message: "column productos.featured_position does not exist" } }
      : { data: [{ id: 1 }], error: null }
  })
  assert.deepEqual(attempts, [true, false])
  assert.deepEqual(result.data, [{ id: 1 }])

  const other = await queryFeaturedProducts<{ id: number }>(async () => ({ data: null, error: { code: "57014", message: "timeout" } }))
  assert.equal(other.error?.code, "57014", "otros errores no se ocultan")
  assert.equal(isMissingFeaturedPositionError({ code: "42703", message: "column productos.nombre does not exist" }), false)
})

test("getFeaturedState: sin destacar nunca expone posición", () => {
  assert.deepEqual(getFeaturedState({ destacado: true, featured_position: 2 }), { destacado: true, featuredPosition: 2 })
  assert.deepEqual(getFeaturedState({ destacado: true }), { destacado: true, featuredPosition: null })
  assert.deepEqual(getFeaturedState({ destacado: false, featured_position: 4 }), { destacado: false, featuredPosition: null })
})

test("parseFeaturedUpdateInput: valida posición entera 1..máx, quitar destacado limpia y revisión opcional", () => {
  assert.deepEqual(parseFeaturedUpdateInput({ destacado: true, featuredPosition: 1 }), { destacado: true, featuredPosition: 1, expectedRevision: null })
  assert.deepEqual(parseFeaturedUpdateInput({ destacado: true }), { destacado: true, featuredPosition: null, expectedRevision: null })
  assert.deepEqual(parseFeaturedUpdateInput({ destacado: false, expectedRevision: 7 }), { destacado: false, featuredPosition: null, expectedRevision: 7 })
  for (const invalid of [
    null, [], {}, { destacado: "si" },
    { destacado: true, featuredPosition: 0 },
    { destacado: true, featuredPosition: -1 },
    { destacado: true, featuredPosition: 1.5 },
    { destacado: true, featuredPosition: "2" },
    { destacado: true, featuredPosition: FEATURED_POSITION_MAX + 1 },
    { destacado: false, featuredPosition: 2 },
    { destacado: true, featuredPosition: 1, expectedRevision: -1 },
  ]) {
    assert.throws(() => parseFeaturedUpdateInput(invalid), FeaturedUpdateInputError, JSON.stringify(invalid))
  }
})

test("mapFeaturedRpcError: posición ocupada y conflicto son 409 con el mensaje de la base; lo técnico no se filtra", () => {
  const taken = mapFeaturedRpcError({ code: "23505", message: 'La posición 1 ya está ocupada por "TRÍPODE ÑANDÚ".' })
  assert.equal(taken.status, 409)
  assert.match(taken.error, /TRÍPODE ÑANDÚ/)
  assert.equal(mapFeaturedRpcError({ code: "40001", message: "El producto cambió" }).status, 409)
  assert.equal(mapFeaturedRpcError({ code: "P0002", message: "x" }).status, 404)
  assert.equal(mapFeaturedRpcError({ code: "PGRST202", message: "Could not find the function public.set_product_featured_position" }).status, 503)
  const unknown = mapFeaturedRpcError({ code: "XX000", message: "internal: relation secret" })
  assert.equal(unknown.status, 500)
  assert.doesNotMatch(unknown.error, /secret/)
})
