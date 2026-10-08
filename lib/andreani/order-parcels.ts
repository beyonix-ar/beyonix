import "server-only"

import type { createAdminClient } from "../supabase/admin.ts"
import { splitAmountByWeights } from "../shipping/shipping-pricing.ts"
import { AndreaniError } from "./client.ts"
import type { AndreaniShipmentPackages } from "./checkout-quote.ts"

type AdminClient = ReturnType<typeof createAdminClient>

/** Bulto físico definido al FINALIZAR ARMADO, con sus medidas reales. */
export interface MeasuredParcel {
  index: number
  weightKg: number
  lengthCm: number
  widthCm: number
  heightCm: number
  volumeCm3: number
}

interface ParcelRow {
  parcel_index: number
  actual_weight_kg: number | string | null
  actual_length_cm: number | string | null
  actual_width_cm: number | string | null
  actual_height_cm: number | string | null
}

/**
 * Bultos vigentes (intento de armado actual) con medidas. `null` si todavía
 * no se definieron o si alguno es anterior a la carga de medidas (legacy):
 * en ese caso se sigue usando la estimación.
 */
export async function loadCurrentMeasuredParcels(
  admin: AdminClient,
  orderId: number,
): Promise<{ requestKey: string; parcels: MeasuredParcel[] } | null> {
  const { data: pkg, error: packageError } = await admin
    .from("order_packages")
    .select("id, attempt_number, parcel_count, parcels_request_key")
    .eq("order_id", orderId)
    .maybeSingle()
  if (packageError) {
    throw new AndreaniError("REQUEST_FAILED", "No se pudieron leer los bultos del pedido.")
  }
  if (!pkg?.parcel_count || !pkg.parcels_request_key) return null

  const { data, error } = await admin
    .from("order_package_parcels")
    .select("parcel_index, actual_weight_kg, actual_length_cm, actual_width_cm, actual_height_cm")
    .eq("package_id", pkg.id)
    .eq("attempt_number", pkg.attempt_number)
    .eq("parcel_count", pkg.parcel_count)
    .order("parcel_index")
  if (error) {
    throw new AndreaniError("REQUEST_FAILED", "No se pudieron leer los bultos del pedido.")
  }
  const rows = (data ?? []) as ParcelRow[]
  if (rows.length !== pkg.parcel_count || rows.some((row) => row.actual_weight_kg == null)) return null

  return {
    requestKey: String(pkg.parcels_request_key),
    parcels: rows.map((row) => {
      const lengthCm = Number(row.actual_length_cm)
      const widthCm = Number(row.actual_width_cm)
      const heightCm = Number(row.actual_height_cm)
      return {
        index: row.parcel_index,
        weightKg: Number(row.actual_weight_kg),
        lengthCm,
        widthCm,
        heightCm,
        volumeCm3: Math.round(lengthCm * widthCm * heightCm * 10) / 10,
      }
    }),
  }
}

/**
 * Bultos que se declaran al CREAR el envío: cada bulto físico del armado con
 * sus medidas y peso reales (la API acepta un array de bultos y emite una
 * etiqueta por cada uno). Nunca se consolidan: Andreani cotiza cada bulto
 * por separado y un "bulto equivalente" tendría otra tarifa.
 */
export function shipmentPackagesFromParcels(parcels: MeasuredParcel[], valorDeclarado: number): AndreaniShipmentPackages {
  if (!parcels.length) throw new AndreaniError("VALIDATION_ERROR", "El pedido no tiene bultos definidos.")
  const declaredValues = splitAmountByWeights(valorDeclarado, parcels.map((parcel) => parcel.weightKg))
  return {
    valorDeclarado,
    parcels: parcels.map((parcel, index) => ({
      pesoKg: parcel.weightKg,
      volumenCm3: parcel.volumeCm3,
      valorDeclarado: declaredValues[index],
      largoCm: parcel.lengthCm,
      anchoCm: parcel.widthCm,
      altoCm: parcel.heightCm,
    })),
  }
}
