import { createAdminClient } from "@/lib/supabase/admin"
import {
  DEFAULT_SHIPPING_SETTINGS,
  type FreeShippingMode,
  type ShippingBonusSettings,
} from "@/lib/store-config"

export interface SiteSettings {
  shipping: ShippingBonusSettings
}

function numberFromValue(value: unknown, fallback: number) {
  const numericValue =
    typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10)

  return Number.isFinite(numericValue) && numericValue >= 0
    ? Math.round(numericValue)
    : fallback
}

function modeFromValue(value: unknown, fallback: FreeShippingMode): FreeShippingMode {
  return value === "full" || value === "off" ? value : fallback
}

export function normalizeShippingSettings(value: unknown): ShippingBonusSettings {
  const source =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {}

  return {
    defaultShippingCost: numberFromValue(
      source.defaultShippingCost,
      DEFAULT_SHIPPING_SETTINGS.defaultShippingCost,
    ),
    freeShippingMinAmount: numberFromValue(
      source.freeShippingMinAmount,
      DEFAULT_SHIPPING_SETTINGS.freeShippingMinAmount,
    ),
    shippingBonusMax: numberFromValue(
      source.shippingBonusMax,
      DEFAULT_SHIPPING_SETTINGS.shippingBonusMax,
    ),
    freeShippingMode: modeFromValue(
      source.freeShippingMode,
      DEFAULT_SHIPPING_SETTINGS.freeShippingMode,
    ),
  }
}

export function getFallbackSiteSettings(): SiteSettings {
  return {
    shipping: DEFAULT_SHIPPING_SETTINGS,
  }
}

export async function getSiteSettings(): Promise<SiteSettings> {
  try {
    const admin = createAdminClient()
    const { data, error } = await admin
      .from("site_settings")
      .select("key, value")
      .eq("key", "shipping")
      .maybeSingle()

    if (error || !data) {
      return getFallbackSiteSettings()
    }

    return {
      shipping: normalizeShippingSettings(data.value),
    }
  } catch {
    return getFallbackSiteSettings()
  }
}
