import { createAdminClient } from "../supabase/admin.ts"
import { markupPercentToBasisPoints, ShippingMarkupError } from "./shipping-pricing.ts"

/**
 * Configuración "Cotización de envíos" (Admin → Configuración). Vive en su
 * propia clave de `site_settings` y NUNCA dentro de `SiteSettings`, que se
 * publica en /api/store/settings: el recargo logístico es dato interno.
 */
export const SHIPPING_QUOTE_SETTINGS_KEY = "shipping_quote"

export interface ShippingQuoteSettings {
  /** Recargo sobre la tarifa de Andreani, 0 a 50, hasta 2 decimales. */
  logisticsMarkupPercent: number
}

export const DEFAULT_SHIPPING_QUOTE_SETTINGS: ShippingQuoteSettings = {
  logisticsMarkupPercent: 0,
}

/** Valor guardado (tolerante): un dato inválido o ausente equivale a 0%. */
export function normalizeStoredShippingQuoteSettings(value: unknown): ShippingQuoteSettings {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
  try {
    return { logisticsMarkupPercent: markupPercentToBasisPoints(source.logisticsMarkupPercent) / 100 }
  } catch {
    return DEFAULT_SHIPPING_QUOTE_SETTINGS
  }
}

/** Valor enviado por Admin (estricto): cualquier dato inválido se rechaza. */
export function parseShippingQuoteSettingsPatch(value: unknown): ShippingQuoteSettings {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some((key) => key !== "logisticsMarkupPercent")) {
    throw new ShippingMarkupError("La configuración de cotización de envíos no es válida.")
  }
  const percent = (value as Record<string, unknown>).logisticsMarkupPercent
  if (typeof percent !== "number") {
    throw new ShippingMarkupError("El recargo logístico debe ser un número.")
  }
  return { logisticsMarkupPercent: markupPercentToBasisPoints(percent) / 100 }
}

export class ShippingQuoteSettingsUnavailableError extends Error {
  constructor() {
    super("No se pudo leer la configuración de cotización de envíos.")
    this.name = "ShippingQuoteSettingsUnavailableError"
  }
}

/**
 * Lectura sin caché. Para cotizar es estricta: si la base falla no se firma
 * un precio con un porcentaje supuesto. Una clave ausente (nunca configurada)
 * sí es 0%: equivale exactamente al comportamiento previo al recargo.
 */
export async function getShippingQuoteSettings(
  admin: ReturnType<typeof createAdminClient> = createAdminClient(),
): Promise<ShippingQuoteSettings> {
  const { data, error } = await admin
    .from("site_settings")
    .select("value")
    .eq("key", SHIPPING_QUOTE_SETTINGS_KEY)
    .maybeSingle()
  if (error) throw new ShippingQuoteSettingsUnavailableError()
  return normalizeStoredShippingQuoteSettings(data?.value)
}
