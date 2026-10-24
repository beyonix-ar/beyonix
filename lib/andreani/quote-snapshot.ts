import "server-only"

import { createAdminClient } from "../supabase/admin.ts"
import { toCents } from "../shipping/shipping-pricing.ts"
import type { AndreaniTariffRequest, AndreaniTariffResponse } from "./types.ts"

export interface AndreaniQuoteSnapshotInput {
  source: "checkout" | "measured"
  orderId?: number
  environment: "QA" | "PROD"
  request: AndreaniTariffRequest
  response: AndreaniTariffResponse
}

/** Persist only fields defined by the tariff contract; never serialize a fetch response or credentials. */
export function buildAndreaniQuoteSnapshot(input: AndreaniQuoteSnapshotInput) {
  const { request, response } = input
  const money = (value: string) => toCents(Number(value)) / 100
  const tarifaSinIva = {
    distribucion: money(response.tarifaSinIva.distribucion),
    seguroDistribucion: money(response.tarifaSinIva.seguroDistribucion),
    total: money(response.tarifaSinIva.total),
  }
  const tarifaConIva = {
    distribucion: money(response.tarifaConIva.distribucion),
    seguroDistribucion: money(response.tarifaConIva.seguroDistribucion),
    total: money(response.tarifaConIva.total),
  }
  if (tarifaSinIva.total <= 0 || tarifaConIva.total <= 0) throw new Error("ANDREANI_QUOTE_INVALID_AMOUNT")

  return {
    source: input.source,
    order_id: input.orderId ?? null,
    environment: input.environment,
    contract: request.contrato,
    client_code: request.cliente,
    origin_branch: request.sucursalOrigen ?? null,
    destination_postal_code: request.cpDestino,
    packages: request.bultos.map((packageData) => ({
      valorDeclarado: packageData.valorDeclarado ?? null,
      volumen: packageData.volumen,
      kilos: packageData.kilos ?? null,
      altoCm: packageData.altoCm ?? null,
      anchoCm: packageData.anchoCm ?? null,
      largoCm: packageData.largoCm ?? null,
    })),
    amount_without_vat: tarifaSinIva.total,
    amount_with_vat: tarifaConIva.total,
    distribution_without_vat: tarifaSinIva.distribucion,
    distribution_with_vat: tarifaConIva.distribucion,
    insurance_without_vat: tarifaSinIva.seguroDistribucion,
    insurance_with_vat: tarifaConIva.seguroDistribucion,
    response: { pesoAforado: response.pesoAforado, tarifaSinIva, tarifaConIva },
  }
}

export async function recordAndreaniQuoteSnapshot(
  input: AndreaniQuoteSnapshotInput,
  admin = createAdminClient(),
) {
  const { error } = await admin
    .from("andreani_quote_snapshots")
    .insert(buildAndreaniQuoteSnapshot(input))
  if (error) throw new Error("ANDREANI_QUOTE_SNAPSHOT_FAILED")
}
