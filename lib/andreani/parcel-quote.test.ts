import assert from "node:assert/strict"
import test from "node:test"

import { quoteOrderParcels } from "./parcel-quote.ts"
import { shipmentPackagesFromParcels } from "./order-parcels.ts"
import type { AndreaniTariffRequest } from "./types.ts"

type Row = Record<string, unknown>

/** Supabase mínimo: select/eq/in/order/maybeSingle + rpc capturado. */
function fakeAdmin(tables: Record<string, Row[]>) {
  const rpcCalls: Array<{ name: string; args: Row }> = []
  const select = (table: string) => {
    const filters: Array<[string, unknown, "eq" | "in"]> = []
    const rows = () => (tables[table] ?? []).filter((row) =>
      filters.every(([col, val, type]) => type === "eq" ? row[col] === val : (val as unknown[]).includes(row[col])))
    const builder = {
      eq: (col: string, val: unknown) => { filters.push([col, val, "eq"]); return builder },
      in: (col: string, val: unknown[]) => { filters.push([col, val, "in"]); return builder },
      order: () => builder,
      maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      then: (resolve: (value: { data: Row[]; error: null }) => unknown) => Promise.resolve({ data: rows(), error: null }).then(resolve),
    }
    return builder
  }
  return {
    rpcCalls,
    from: (table: string) => ({ select: () => select(table) }),
    rpc: async (name: string, args: Row) => {
      rpcCalls.push({ name, args })
      return { data: true, error: null }
    },
  }
}

const env = {
  NODE_ENV: "test",
  ANDREANI_ENV: "QA",
  ANDREANI_QA_API_URL: "https://apisqa.andreani.com",
  ANDREANI_QA_USERNAME: "usuario",
  ANDREANI_QA_PASSWORD: "clave",
  ANDREANI_QA_CLIENT: "CLIENTE-QA",
  ANDREANI_QA_HOME_CONTRACT: "CONTRATO-QA",
  ANDREANI_QA_ORIGIN_BRANCH: "RAC",
} as NodeJS.ProcessEnv

function orderTables(parcels: Row[], order: Row = {}) {
  return {
    ordenes: [{ id: 42, cp_destino: "3230", shipping_type: "domicilio", shipping_provider: "andreani", envio_proveedor: null, shipping_provider_quote_amount: 10_000, ...order }],
    order_packages: [{ id: 7, order_id: 42, attempt_number: 1, parcel_count: parcels.length, parcels_request_key: "40000000-0000-4000-8000-000000000009" }],
    order_package_parcels: parcels.map((parcel, index) => ({ package_id: 7, attempt_number: 1, parcel_count: parcels.length, parcel_index: index + 1, ...parcel })),
    orden_items: [{ id: 1, orden_id: 42, producto_id: 1, variante_id: null, conditioned_stock_id: null, cantidad: 2, precio: 15_000 }],
    productos: [{ id: 1, nombre: "Auriculares", sku: "AUR", peso_empaquetado_kg: 0.45, alto_paquete_cm: 8, ancho_paquete_cm: 15, largo_paquete_cm: 20 }],
    producto_variantes: [],
  }
}

const tariff = (total: string) => ({
  pesoAforado: "1",
  tarifaSinIva: { seguroDistribucion: "0", distribucion: total, total },
  tarifaConIva: { seguroDistribucion: "0", distribucion: total, total },
})

test("recotización con bultos reales: UNA consulta con todos los bultos y diferencia vs checkout (sin cobrar)", async () => {
  const admin = fakeAdmin(orderTables([
    { actual_weight_kg: 1.2, actual_length_cm: 30, actual_width_cm: 20, actual_height_cm: 10 },
    { actual_weight_kg: 0.8, actual_length_cm: 25, actual_width_cm: 20, actual_height_cm: 8 },
  ]))
  const requests: AndreaniTariffRequest[] = []
  const result = await quoteOrderParcels(admin as never, 42, {
    env,
    quoteTariff: async (input) => {
      requests.push(input)
      return tariff("10380")
    },
  })
  assert.equal(requests.length, 1)
  assert.deepEqual(requests[0].bultos.map((bulto) => bulto.kilos), [1.2, 0.8])
  assert.deepEqual(requests[0].bultos.map((bulto) => [bulto.largoCm, bulto.anchoCm, bulto.altoCm]), [[30, 20, 10], [25, 20, 8]])
  assert.deepEqual(requests[0].bultos.map((bulto) => bulto.valorDeclarado), [18_000, 12_000])
  assert.deepEqual(result, { status: "quoted", amount: 10_380, checkoutAmount: 10_000, differenceAmount: 380, differencePercent: 3.8, alert: false })
  const [recorded] = admin.rpcCalls
  assert.equal(recorded.name, "record_order_parcel_quote")
  assert.equal(recorded.args.p_status, "quoted")
  assert.equal(recorded.args.p_amount, 10_380)
  assert.equal(recorded.args.p_request_key, "40000000-0000-4000-8000-000000000009")
})

test("diferencia considerable: alerta para revisar antes de generar el envío", async () => {
  const admin = fakeAdmin(orderTables([{ actual_weight_kg: 3, actual_length_cm: 50, actual_width_cm: 40, actual_height_cm: 30 }], { shipping_provider_quote_amount: 10_200 }))
  const result = await quoteOrderParcels(admin as never, 42, { env, quoteTariff: async () => tariff("12036") })
  assert.equal(result.status, "quoted")
  assert.ok(result.status === "quoted" && result.alert && result.differencePercent === 18)
})

test("sin bultos medidos o pedido no Andreani: no recotiza ni graba nada", async () => {
  let calls = 0
  const quoteTariff = async () => { calls += 1; return tariff("1000") }
  const legacy = fakeAdmin(orderTables([{ actual_weight_kg: null, actual_length_cm: null, actual_width_cm: null, actual_height_cm: null }]))
  assert.deepEqual(await quoteOrderParcels(legacy as never, 42, { env, quoteTariff }), { status: "skipped" })
  const other = fakeAdmin(orderTables([{ actual_weight_kg: 1, actual_length_cm: 10, actual_width_cm: 10, actual_height_cm: 10 }], { shipping_provider: "retiro" }))
  assert.deepEqual(await quoteOrderParcels(other as never, 42, { env, quoteTariff }), { status: "skipped" })
  assert.equal(calls, 0)
  assert.equal(legacy.rpcCalls.length + other.rpcCalls.length, 0)
})

test("si Andreani falla, se registra como fallida sin inventar importes", async () => {
  const admin = fakeAdmin(orderTables([{ actual_weight_kg: 1, actual_length_cm: 10, actual_width_cm: 10, actual_height_cm: 10 }]))
  const result = await quoteOrderParcels(admin as never, 42, { env, quoteTariff: async () => tariff("0") })
  assert.equal(result.status, "failed")
  assert.equal(admin.rpcCalls[0].args.p_status, "failed")
  assert.equal(admin.rpcCalls[0].args.p_amount, null)
})

test("bultos reales para Andreani: uno por bulto físico, sin consolidar; valor declarado por peso al centavo", () => {
  const parcels = [
    { index: 1, weightKg: 1, lengthCm: 10, widthCm: 10, heightCm: 10, volumeCm3: 1_000 },
    { index: 2, weightKg: 2, lengthCm: 38, widthCm: 27, heightCm: 20, volumeCm3: 20_520 },
  ]
  const packages = shipmentPackagesFromParcels(parcels, 10_000.01)
  assert.equal(packages.parcels.length, 2)
  assert.deepEqual(packages.parcels.map((parcel) => parcel.valorDeclarado), [3_333.33, 6_666.68])
  assert.deepEqual(
    packages.parcels.map((parcel) => [parcel.pesoKg, parcel.largoCm, parcel.anchoCm, parcel.altoCm, parcel.volumenCm3]),
    [[1, 10, 10, 10, 1_000], [2, 38, 27, 20, 20_520]],
  )
})
