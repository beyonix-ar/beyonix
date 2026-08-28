import { createAdminClient } from "@/lib/supabase/admin"
import { MIN_MERCADOPAGO_CUSTOMER_CREDIT_TOPUP } from "@/lib/customer-credit"
import {
  DEFAULT_SHIPPING_SETTINGS,
  type FreeShippingMode,
  type ShippingBonusSettings,
} from "@/lib/store-config"
import { SITE_SETTINGS } from "@/config/site-settings"
import type { InstallmentsFinancingConfig } from "@/lib/products/installments"

export interface SiteSettings {
  shipping: ShippingBonusSettings
  customerCreditPayments: CustomerCreditPaymentSettings
  stock: StockSettings
  installmentsFinancing: InstallmentsFinancingSettings
}

export type InstallmentsFinancingSettings = InstallmentsFinancingConfig

export interface StockSettings {
  criticalStockThreshold: number
  lowStockThreshold: number
  availableStockThreshold: number
}

export interface CustomerCreditPaymentSettings {
  mercadoPagoSurchargePercent: number
  mercadoPagoMinimumAmount: number
}

export const DEFAULT_CUSTOMER_CREDIT_PAYMENT_SETTINGS: CustomerCreditPaymentSettings = {
  mercadoPagoSurchargePercent: 8,
  mercadoPagoMinimumAmount: MIN_MERCADOPAGO_CUSTOMER_CREDIT_TOPUP,
}

export const DEFAULT_INSTALLMENTS_FINANCING_SETTINGS: InstallmentsFinancingSettings = {
  baseProcessingPercent: 6.42,
  ivaPercent: 21,
  surchargePercentByCount: { 2: 7.79, 3: 10.49, 6: 18.69 },
}

export const DEFAULT_STOCK_SETTINGS: StockSettings = {
  criticalStockThreshold: SITE_SETTINGS.stock.criticalStockThreshold,
  lowStockThreshold: SITE_SETTINGS.stock.lowStockThreshold,
  availableStockThreshold: SITE_SETTINGS.stock.lowStockThreshold + 1,
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
    logisticsBaseSubsidy: numberFromValue(
      source.logisticsBaseSubsidy,
      DEFAULT_SHIPPING_SETTINGS.logisticsBaseSubsidy,
    ),
  }
}

export function normalizeCustomerCreditPaymentSettings(
  value: unknown,
): CustomerCreditPaymentSettings {
  const source =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {}
  const parsed = Number(
    String(source.mercadoPagoSurchargePercent ?? "").replace(",", "."),
  )
  const mercadoPagoSurchargePercent = Number.isFinite(parsed)
    ? Math.min(100, Math.max(0, Math.round(parsed * 100) / 100))
    : DEFAULT_CUSTOMER_CREDIT_PAYMENT_SETTINGS.mercadoPagoSurchargePercent
  const mercadoPagoMinimumAmount = numberFromValue(
    source.mercadoPagoMinimumAmount,
    DEFAULT_CUSTOMER_CREDIT_PAYMENT_SETTINGS.mercadoPagoMinimumAmount,
  )

  return { mercadoPagoSurchargePercent, mercadoPagoMinimumAmount }
}

function normalizeCostPercentage(value: unknown, fallback: number) {
  const parsed = Number(String(value ?? "").replace(",", "."))
  return Number.isFinite(parsed)
    ? Math.min(100, Math.max(0, Math.round(parsed * 100) / 100))
    : fallback
}

export function normalizeInstallmentsFinancingSettings(
  value: unknown,
): InstallmentsFinancingSettings {
  const source =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {}
  const surchargeSource =
    source.surchargePercentByCount && typeof source.surchargePercentByCount === "object"
      ? (source.surchargePercentByCount as Record<string, unknown>)
      : {}

  return {
    baseProcessingPercent: normalizeCostPercentage(
      source.baseProcessingPercent,
      DEFAULT_INSTALLMENTS_FINANCING_SETTINGS.baseProcessingPercent,
    ),
    ivaPercent: normalizeCostPercentage(
      source.ivaPercent,
      DEFAULT_INSTALLMENTS_FINANCING_SETTINGS.ivaPercent,
    ),
    surchargePercentByCount: {
      2: normalizeCostPercentage(
        surchargeSource["2"],
        DEFAULT_INSTALLMENTS_FINANCING_SETTINGS.surchargePercentByCount[2],
      ),
      3: normalizeCostPercentage(
        surchargeSource["3"],
        DEFAULT_INSTALLMENTS_FINANCING_SETTINGS.surchargePercentByCount[3],
      ),
      6: normalizeCostPercentage(
        surchargeSource["6"],
        DEFAULT_INSTALLMENTS_FINANCING_SETTINGS.surchargePercentByCount[6],
      ),
    },
  }
}

export function normalizeStockSettings(value: unknown): StockSettings {
  const source =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {}
  const criticalStockThreshold = Math.min(
    97,
    numberFromValue(
      source.criticalStockThreshold,
      DEFAULT_STOCK_SETTINGS.criticalStockThreshold,
    ),
  )
  const lowStockThreshold = Math.min(
    98,
    Math.max(
      criticalStockThreshold + 1,
      numberFromValue(
        source.lowStockThreshold,
        DEFAULT_STOCK_SETTINGS.lowStockThreshold,
      ),
    ),
  )

  return {
    criticalStockThreshold,
    lowStockThreshold,
    availableStockThreshold: lowStockThreshold + 1,
  }
}

export function getFallbackSiteSettings(): SiteSettings {
  return {
    shipping: DEFAULT_SHIPPING_SETTINGS,
    customerCreditPayments: DEFAULT_CUSTOMER_CREDIT_PAYMENT_SETTINGS,
    stock: DEFAULT_STOCK_SETTINGS,
    installmentsFinancing: DEFAULT_INSTALLMENTS_FINANCING_SETTINGS,
  }
}

// site_settings cambia con muy poca frecuencia (lo edita un admin a mano) y
// se lee en casi todas las páginas: cachear unos segundos evita golpear la
// base en cada request. Las operaciones financieras piden `fresh: true` y el
// resto se invalida explícitamente al guardar desde /api/admin/settings.
const SITE_SETTINGS_CACHE_MS = 30_000
let siteSettingsCache: { expiresAt: number; value: SiteSettings } | null = null
let siteSettingsCacheGeneration = 0
let siteSettingsRequest: Promise<SiteSettings> | null = null

export function invalidateSiteSettingsCache() {
  siteSettingsCacheGeneration += 1
  siteSettingsCache = null
  siteSettingsRequest = null
}

async function loadSiteSettings(): Promise<SiteSettings> {
  const requestGeneration = siteSettingsCacheGeneration

  try {
    const admin = createAdminClient()
    const { data, error } = await admin
      .from("site_settings")
      .select("key, value")
      .in("key", [
        "shipping",
        "customer_credit_payments",
        "stock",
        "installments_financing",
      ])

    if (error) return getFallbackSiteSettings()

    const settingsByKey = new Map(
      (data ?? []).map((setting) => [setting.key, setting.value]),
    )
    const settings: SiteSettings = {
      shipping: normalizeShippingSettings(settingsByKey.get("shipping")),
      customerCreditPayments: normalizeCustomerCreditPaymentSettings(
        settingsByKey.get("customer_credit_payments"),
      ),
      stock: normalizeStockSettings(settingsByKey.get("stock")),
      installmentsFinancing: normalizeInstallmentsFinancingSettings(
        settingsByKey.get("installments_financing"),
      ),
    }

    if (requestGeneration === siteSettingsCacheGeneration) {
      siteSettingsCache = {
        expiresAt: Date.now() + SITE_SETTINGS_CACHE_MS,
        value: settings,
      }
    }
    return settings
  } catch {
    return getFallbackSiteSettings()
  }
}

export function getSiteSettings(
  options: { fresh?: boolean } = {},
): Promise<SiteSettings> {
  if (
    !options.fresh &&
    siteSettingsCache &&
    siteSettingsCache.expiresAt > Date.now()
  ) {
    return Promise.resolve(siteSettingsCache.value)
  }

  if (!options.fresh && siteSettingsRequest) return siteSettingsRequest

  const request = loadSiteSettings()
  if (!options.fresh) {
    siteSettingsRequest = request
    void request.finally(() => {
      if (siteSettingsRequest === request) {
        siteSettingsRequest = null
      }
    })
  }

  return request
}
