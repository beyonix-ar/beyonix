import assert from "node:assert/strict"
import test from "node:test"

import { buildAndreaniQuoteSnapshot } from "./quote-snapshot.ts"

test("snapshot histórico conserva desglose y bultos sin credenciales", () => {
  const rawInput = {
    source: "checkout" as const,
    environment: "PROD" as const,
    request: {
      cpDestino: "3300", contrato: "400042104", cliente: "0012011683", sucursalOrigen: "RAC",
      bultos: [{ valorDeclarado: 999, volumen: 833, kilos: 0.1, altoCm: 3.5, anchoCm: 7, largoCm: 34 }],
    },
    response: {
      pesoAforado: "292.00",
      tarifaSinIva: { seguroDistribucion: "19.98", distribucion: "14578.53", total: "14598.51" },
      tarifaConIva: { seguroDistribucion: "24.18", distribucion: "17640.02", total: "17664.20" },
      token: "secret-token",
    },
    password: "secret-password",
  }
  const snapshot = buildAndreaniQuoteSnapshot(rawInput)
  assert.equal(snapshot.amount_without_vat, 14_598.51)
  assert.equal(snapshot.amount_with_vat, 17_664.2)
  assert.equal(snapshot.distribution_with_vat, 17_640.02)
  assert.equal(snapshot.insurance_with_vat, 24.18)
  assert.equal(snapshot.environment, "PROD")
  assert.equal(snapshot.contract, "400042104")
  assert.equal(snapshot.packages[0].volumen, 833)
  assert.deepEqual(Object.keys(snapshot.response).sort(), ["pesoAforado", "tarifaConIva", "tarifaSinIva"])
  assert.doesNotMatch(JSON.stringify(snapshot), /secret-token|secret-password/)
})
