import "server-only"

import type { createAdminClient } from "../supabase/admin.ts"
import { compareParcelQuote, toCents } from "../shipping/shipping-pricing.ts"
import {
  AndreaniClient,
  AndreaniError,
  type AndreaniClientOptions,
} from "./client.ts"
import {
  declaredValueOf,
  readAndreaniTariffAmount,
  resolveAndreaniCheckoutConfig,
  toAndreaniTariffPackages,
} from "./checkout-quote.ts"
import { loadCurrentMeasuredParcels, shipmentPackagesFromParcels } from "./order-parcels.ts"
import { loadOrderShipmentItems } from "./order-shipment.ts"
import type { AndreaniTariffRequest, AndreaniTariffResponse } from "./types.ts"

type AdminClient = ReturnType<typeof createAdminClient>

interface ParcelQuoteOrderRow {
  id: number
  cp_destino: string | null
  shipping_type: string | null
  shipping_provider: string | null
  envio_proveedor: string | null
  shipping_provider_quote_amount: number | string | null
}

export interface ParcelQuoteDependencies {
  env?: NodeJS.ProcessEnv
  clientOptions?: AndreaniClientOptions
  quoteTariff?: (input: AndreaniTariffRequest) => Promise<AndreaniTariffResponse>
}

export type ParcelQuoteResult =
  | { status: "skipped" }
  | { status: "failed"; error: string }
  | {
      status: "quoted"
      amount: number
      checkoutAmount: number | null
      differenceAmount: number | null
      differencePercent: number | null
      alert: boolean
    }

/**
 * Recotiza la tarifa de Andreani con los bultos REALES del armado (una
 * consulta por bulto: `/v1/tarifas` cotiza `bultos[0]`). Nunca cobra nada al
 * cliente: el resultado sólo se guarda para comparar con lo cotizado en el
 * checkout y calibrar el estimador.
 */
export async function quoteOrderParcels(
  admin: AdminClient,
  orderId: number,
  dependencies: ParcelQuoteDependencies = {},
): Promise<ParcelQuoteResult> {
  const { data: orderData, error: orderError } = await admin
    .from("ordenes")
    .select("id, cp_destino, shipping_type, shipping_provider, envio_proveedor, shipping_provider_quote_amount")
    .eq("id", orderId)
    .maybeSingle()
  if (orderError || !orderData) return { status: "failed", error: "ORDER_NOT_FOUND" }
  const order = orderData as unknown as ParcelQuoteOrderRow
  if ((order.shipping_provider ?? order.envio_proveedor) !== "andreani") return { status: "skipped" }

  const measured = await loadCurrentMeasuredParcels(admin, orderId)
  if (!measured) return { status: "skipped" }

  const record = async (status: "quoted" | "failed", amount: number | null, error: string | null) => {
    const { error: recordError } = await admin.rpc("record_order_parcel_quote", {
      p_order_id: orderId,
      p_request_key: measured.requestKey,
      p_status: status,
      p_amount: amount,
      p_parcels: measured.parcels,
      p_error: error,
    })
    if (recordError) console.error("ORDER_PARCEL_QUOTE_RECORD_FAILED", { orderId, code: recordError.code })
  }

  try {
    const env = dependencies.env ?? process.env
    const config = resolveAndreaniCheckoutConfig(env)
    const contrato = order.shipping_type === "sucursal" ? config.sucursalContrato : config.domicilioContrato
    if (!contrato || !order.cp_destino) {
      await record("failed", null, "CONFIGURATION_ERROR")
      return { status: "failed", error: "CONFIGURATION_ERROR" }
    }
    const items = await loadOrderShipmentItems(admin, orderId)
    const packages = shipmentPackagesFromParcels(measured.parcels, declaredValueOf(items))
    const client = new AndreaniClient({
      ...dependencies.clientOptions,
      env: { ...env, ANDREANI_ENV: config.environment },
      productionAccess: config.environment === "PROD" ? "tariffs-only" : dependencies.clientOptions?.productionAccess,
    })
    const quote = dependencies.quoteTariff ?? ((input: AndreaniTariffRequest) => client.cotizarEnvio(input))
    // Una sola consulta con todos los bultos reales (Andreani devuelve la
    // suma de la tarifa de cada bulto), igual que en checkout.
    const amountCents = toCents(readAndreaniTariffAmount(await quote({
      cpDestino: order.cp_destino,
      contrato,
      cliente: config.cliente,
      sucursalOrigen: config.sucursalOrigen,
      bultos: toAndreaniTariffPackages(packages.parcels),
    })))
    await record("quoted", amountCents / 100, null)

    const checkoutAmount = order.shipping_provider_quote_amount == null ? null : Number(order.shipping_provider_quote_amount)
    if (checkoutAmount === null) {
      return { status: "quoted", amount: amountCents / 100, checkoutAmount, differenceAmount: null, differencePercent: null, alert: false }
    }
    const comparison = compareParcelQuote(toCents(checkoutAmount), amountCents)
    return {
      status: "quoted",
      amount: amountCents / 100,
      checkoutAmount,
      differenceAmount: comparison.differenceCents / 100,
      differencePercent: comparison.differencePercent,
      alert: comparison.alert,
    }
  } catch (error) {
    const code = error instanceof AndreaniError ? error.code : "UNEXPECTED_ERROR"
    await record("failed", null, code)
    return { status: "failed", error: code }
  }
}
