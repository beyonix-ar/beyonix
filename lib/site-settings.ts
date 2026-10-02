import { createAdminClient } from "./supabase/admin.ts"
import { MIN_MERCADOPAGO_CUSTOMER_CREDIT_TOPUP } from "./customer-credit.ts"
import {
  DEFAULT_SHIPPING_SETTINGS,
  type FreeShippingMode,
  type ShippingBonusSettings,
} from "./store-config.ts"
import { SITE_SETTINGS } from "../config/site-settings.ts"
import type { InstallmentsFinancingConfig } from "./products/installments.ts"
import {
  DEFAULT_INTEREST_FREE_POLICY,
  normalizeInterestFreePolicy,
  normalizeMercadoPagoInterestFreeStatus,
  type InterestFreePolicy,
  type MercadoPagoInterestFreeStatus,
} from "./mercadopago/interest-free-policy.ts"
import {
  buildPublicInterestFreeOffer,
  type PublicInterestFreeOffer,
} from "./pricing/interest-free-communication.ts"
import {
  DEFAULT_FINANCED_PRICE_POLICY,
  FINANCED_PRICE_POLICY_KEY,
  normalizeFinancedPricePolicy,
  type FinancedPricePolicy,
} from "./pricing/financed-price-policy.ts"
import {
  COMMERCIAL_EVENT_COLUMNS,
  getControllingFinancingEvent,
  type CommercialEventRow,
} from "./commercial-events/scheduled-events.ts"
import {
  deriveMercadoPagoObservedCosts,
  MERCADOPAGO_COST_MODALITIES,
  MERCADOPAGO_OBSERVATION_SAMPLE_SIZE,
  normalizeMercadoPagoCostsMode,
  resolveInstallmentsFinancing,
  type MercadoPagoCostsMode,
  type MercadoPagoObservationSourceRow,
  type MercadoPagoObservedCosts,
  type ResolvedInstallmentsFinancing,
} from "./mercadopago/observed-costs.ts"

export interface SiteSettings {
  shipping: ShippingBonusSettings
  customerCreditPayments: CustomerCreditPaymentSettings
  stock: StockSettings
  installmentsFinancing: InstallmentsFinancingSettings
  /** Cuotas sin interés ON/OFF (lo que se ofrece lo decide Mercado Pago). */
  interestFreePolicy: InterestFreePolicy
  /**
   * Comunicación pública vigente ("Hasta N cuotas sin interés a partir de
   * $X"), derivada de la última sincronización EXITOSA con Mercado Pago.
   * `null` = no se comunica ninguna promoción.
   */
  interestFreeOffer: PublicInterestFreeOffer | null
  /**
   * Política global de precio financiado vigente (manual o puesta por un
   * evento): cubrir costos de Mercado Pago o mismo precio que contado.
   */
  financedPricePolicy: FinancedPricePolicy
  andreaniCommercial: AndreaniCommercialSettings
  pricing: PricingSettings
}

/** Evento de financiación que controla (o va a controlar) la política, para Admin. */
export interface FinancingPolicyEventSummary {
  id: string
  name: string
  status: CommercialEventRow["status"]
  startsAt: string | null
  endsAt: string | null
  /** Política a la que vuelve al terminar (`null` si todavía no empezó). */
  previousPolicy: FinancedPricePolicy | null
}

/**
 * Configuración central de precios reutilizada por
 * `lib/pricing/financed-pricing.ts` en producto/carrito/checkout. Reemplaza
 * el 10% que antes vivía hardcodeado como `TRANSFER_DISCOUNT` en
 * `lib/store-config.ts` y agrega la incidencia de impuestos nacionales para
 * la leyenda legal "PRECIO SIN IMPUESTOS NACIONALES".
 */
export interface PricingSettings {
  transferDiscountPercent: number
  nationalTaxesIncidencePercent: number
}

/**
 * Activo/inactivo COMERCIAL de Andreani: sólo gobierna si se ofrece cotizar y
 * crear envíos NUEVOS. Deliberadamente separado de `ShippingBonusSettings`
 * (que es política de precio/bonificación, no "¿existe Andreani?") y nunca
 * debe tocarse desde tracking/etiquetas/cron -- un pedido ya creado sigue
 * pudiendo consultarse y trackearse aunque esto esté en `false`, porque esas
 * rutas leen credenciales y `andreani_creation_environment` del pedido, no
 * este flag.
 */
export interface AndreaniCommercialSettings {
  enabled: boolean
}

/**
 * Costos EFECTIVOS de Mercado Pago que usan precios, checkout y simulaciones
 * (`SiteSettings.installmentsFinancing`). Según el modo guardado salen de los
 * valores manuales o de los costos observados en pagos reales.
 */
export type InstallmentsFinancingSettings = InstallmentsFinancingConfig

/**
 * Lo que se guarda en `site_settings.installments_financing`: valores
 * manuales + modo + política de cuotas sin interés (Admin → Financiación).
 */
export interface StoredInstallmentsFinancingSettings extends InstallmentsFinancingConfig {
  mode: MercadoPagoCostsMode
  interestFreePolicy: InterestFreePolicy
}

/** Vista sólo para Admin: nunca viaja en `SiteSettings` (que es pública). */
export interface MercadoPagoCostsOverview extends ResolvedInstallmentsFinancing {
  mode: MercadoPagoCostsMode
  manual: InstallmentsFinancingConfig
  observed: MercadoPagoObservedCosts | null
  interestFreePolicy: InterestFreePolicy
  /** Sincronización con Mercado Pago: última referencia exitosa (estimada) y último intento. */
  interestFreeStatus: MercadoPagoInterestFreeStatus
  /** Lo que la tienda comunica hoy con esa referencia y la política (`null`: nada). */
  interestFreeOffer: PublicInterestFreeOffer | null
  /** Política de precio financiado vigente. */
  financedPricePolicy: FinancedPricePolicy
  /** Evento que la controla ahora (no se cambia a mano mientras dure). */
  financingPolicyEvent: FinancingPolicyEventSummary | null
  /** Próximo evento de financiación programado. */
  upcomingFinancingPolicyEvent: FinancingPolicyEventSummary | null
}

/** Clave de `site_settings` con la última referencia observada de Mercado Pago. */
export const MERCADOPAGO_INTEREST_FREE_REFERENCE_KEY = "mercadopago_interest_free_reference"

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

export const DEFAULT_PRICING_SETTINGS: PricingSettings = {
  // Mismo 10% que antes vivía hardcodeado en TRANSFER_DISCOUNT (store-config.ts).
  transferDiscountPercent: 10,
  // Default razonable (alícuota general de IVA); el admin debe confirmarlo con su contador.
  nationalTaxesIncidencePercent: 21,
}

export const DEFAULT_STOCK_SETTINGS: StockSettings = {
  criticalStockThreshold: SITE_SETTINGS.stock.criticalStockThreshold,
  lowStockThreshold: SITE_SETTINGS.stock.lowStockThreshold,
  availableStockThreshold: SITE_SETTINGS.stock.lowStockThreshold + 1,
}

export const DEFAULT_ANDREANI_COMMERCIAL_SETTINGS: AndreaniCommercialSettings = {
  enabled: false,
}

/** Lectura sin caché: una falla o un valor ausente nunca habilita operaciones nuevas. */
export async function getAndreaniCommercialSettings(): Promise<AndreaniCommercialSettings> {
  try {
    const { data, error } = await createAdminClient()
      .from("site_settings")
      .select("value")
      .eq("key", "andreani_commercial")
      .maybeSingle()
    return normalizeAndreaniCommercialSettings(error ? null : data?.value)
  } catch {
    return { enabled: false }
  }
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

export function normalizeStoredInstallmentsFinancingSettings(
  value: unknown,
): StoredInstallmentsFinancingSettings {
  const source =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {}

  return {
    ...normalizeInstallmentsFinancingSettings(source),
    mode: normalizeMercadoPagoCostsMode(source.mode),
    interestFreePolicy: normalizeInterestFreePolicy(source.interestFreePolicy),
  }
}

export function normalizePricingSettings(value: unknown): PricingSettings {
  const source =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {}

  return {
    transferDiscountPercent: normalizeCostPercentage(
      source.transferDiscountPercent,
      DEFAULT_PRICING_SETTINGS.transferDiscountPercent,
    ),
    nationalTaxesIncidencePercent: normalizeCostPercentage(
      source.nationalTaxesIncidencePercent,
      DEFAULT_PRICING_SETTINGS.nationalTaxesIncidencePercent,
    ),
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

export function normalizeAndreaniCommercialSettings(
  value: unknown,
): AndreaniCommercialSettings {
  const source =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {}

  return {
    enabled:
      typeof source.enabled === "boolean"
        ? source.enabled
        : DEFAULT_ANDREANI_COMMERCIAL_SETTINGS.enabled,
  }
}

export function getFallbackSiteSettings(): SiteSettings {
  return {
    shipping: DEFAULT_SHIPPING_SETTINGS,
    customerCreditPayments: DEFAULT_CUSTOMER_CREDIT_PAYMENT_SETTINGS,
    stock: DEFAULT_STOCK_SETTINGS,
    installmentsFinancing: DEFAULT_INSTALLMENTS_FINANCING_SETTINGS,
    interestFreePolicy: DEFAULT_INTEREST_FREE_POLICY,
    interestFreeOffer: null,
    financedPricePolicy: DEFAULT_FINANCED_PRICE_POLICY,
    andreaniCommercial: DEFAULT_ANDREANI_COMMERCIAL_SETTINGS,
    pricing: DEFAULT_PRICING_SETTINGS,
  }
}

const SITE_SETTING_KEYS = {
  shipping: "shipping",
  customerCreditPayments: "customer_credit_payments",
  stock: "stock",
  installmentsFinancing: "installments_financing",
  andreaniCommercial: "andreani_commercial",
  pricing: "pricing",
  financedPricePolicy: FINANCED_PRICE_POLICY_KEY,
} as const

/** Cambio manual de la política (nunca lleva `eventId`: eso sólo lo pone un evento). */
function normalizeFinancedPricePolicyPatch(value: unknown) {
  return { policy: normalizeFinancedPricePolicy(value) }
}

/** Escribe sólo los grupos enviados; otros PATCH concurrentes no pierden sus cambios. */
export function normalizeSiteSettingsPatch(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("La configuración no es válida.")
  }
  const input = body as Record<string, unknown>
  if (!Object.keys(input).length || Object.keys(input).some((key) => !Object.hasOwn(SITE_SETTING_KEYS, key))) {
    throw new Error("La configuración contiene campos no válidos.")
  }
  const normalizers = {
    shipping: normalizeShippingSettings,
    customerCreditPayments: normalizeCustomerCreditPaymentSettings,
    stock: normalizeStockSettings,
    installmentsFinancing: normalizeStoredInstallmentsFinancingSettings,
    andreaniCommercial: normalizeAndreaniCommercialSettings,
    pricing: normalizePricingSettings,
    financedPricePolicy: normalizeFinancedPricePolicyPatch,
  }
  return (Object.keys(SITE_SETTING_KEYS) as Array<keyof typeof SITE_SETTING_KEYS>)
    .filter((key) => Object.hasOwn(input, key))
    .map((key) => {
      const value = input[key]
      if (!value || typeof value !== "object" || Array.isArray(value) ||
          (key === "andreaniCommercial" && (typeof (value as Record<string, unknown>).enabled !== "boolean" ||
            Object.keys(value).some((field) => field !== "enabled")))) {
        throw new Error("La configuración no es válida.")
      }
      return { key: SITE_SETTING_KEYS[key], value: normalizers[key](value), field: key }
    })
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

export class SiteSettingsUnavailableError extends Error {
  constructor() {
    super(
      "No se pudo leer la configuración comercial. Operación cancelada por seguridad.",
    )
    this.name = "SiteSettingsUnavailableError"
  }
}

/**
 * `strict=true` (usado exclusivamente por `getSiteSettings({ fresh: true })`,
 * la lectura que ya reservan las operaciones financieras -- checkout, cotización
 * de envío, creación de orden) NUNCA cae a `getFallbackSiteSettings()`: una
 * falla de lectura ahí significa que no hay forma segura de saber la
 * configuración comercial vigente (bonificación de envío, recargos de cuotas,
 * etc.), así que se corta la operación en vez de cobrar con defaults que
 * pueden no coincidir con lo que el cliente vio. Las lecturas cacheadas
 * (páginas públicas, paneles de solo lectura) conservan el fallback silencioso:
 * degradar a un default razonable ahí es preferible a romper el sitio entero
 * por un hiccup transitorio de lectura.
 */
async function loadSiteSettings(strict: boolean): Promise<SiteSettings> {
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
        "andreani_commercial",
        "pricing",
        MERCADOPAGO_INTEREST_FREE_REFERENCE_KEY,
        FINANCED_PRICE_POLICY_KEY,
      ])

    if (error) {
      if (strict) throw new SiteSettingsUnavailableError()
      return getFallbackSiteSettings()
    }

    const settingsByKey = new Map(
      (data ?? []).map((setting) => [setting.key, setting.value]),
    )
    const storedFinancing = normalizeStoredInstallmentsFinancingSettings(
      settingsByKey.get("installments_financing"),
    )
    const observedCosts =
      storedFinancing.mode === "automatic"
        ? await loadMercadoPagoObservedCosts(admin)
        : null
    const settings: SiteSettings = {
      shipping: normalizeShippingSettings(settingsByKey.get("shipping")),
      customerCreditPayments: normalizeCustomerCreditPaymentSettings(
        settingsByKey.get("customer_credit_payments"),
      ),
      stock: normalizeStockSettings(settingsByKey.get("stock")),
      installmentsFinancing: resolveInstallmentsFinancing(
        storedFinancing,
        storedFinancing.mode,
        observedCosts,
      ).effective,
      interestFreePolicy: storedFinancing.interestFreePolicy,
      interestFreeOffer: buildPublicInterestFreeOffer(
        normalizeMercadoPagoInterestFreeStatus(settingsByKey.get(MERCADOPAGO_INTEREST_FREE_REFERENCE_KEY)),
        storedFinancing.interestFreePolicy,
      ),
      financedPricePolicy: normalizeFinancedPricePolicy(settingsByKey.get(FINANCED_PRICE_POLICY_KEY)),
      andreaniCommercial: normalizeAndreaniCommercialSettings(
        settingsByKey.get("andreani_commercial"),
      ),
      pricing: normalizePricingSettings(settingsByKey.get("pricing")),
    }

    if (requestGeneration === siteSettingsCacheGeneration) {
      siteSettingsCache = {
        expiresAt: Date.now() + SITE_SETTINGS_CACHE_MS,
        value: settings,
      }
    }
    return settings
  } catch (error) {
    if (strict) {
      throw error instanceof SiteSettingsUnavailableError
        ? error
        : new SiteSettingsUnavailableError()
    }
    return getFallbackSiteSettings()
  }
}

/**
 * Últimos pagos aprobados de Mercado Pago con costo real persistido, POR
 * MODALIDAD (crédito 1/2/3/6, débito, dinero en cuenta): cada una conserva
 * su último costo aprendido aunque se venda poco, sin que las ventas de otra
 * modalidad lo desplacen. `mercadopago_payment_snapshot` sólo se escribe al
 * confirmar un pago aprobado (webhook). Una falla de lectura devuelve null:
 * en automático se usan los valores manuales (el checkout detecta cualquier
 * diferencia con lo que vio el cliente por su huella económica y nunca cobra
 * un total distinto sin avisar).
 */
async function loadMercadoPagoObservedCosts(
  admin: ReturnType<typeof createAdminClient>,
): Promise<MercadoPagoObservedCosts | null> {
  try {
    const results = await Promise.all(
      MERCADOPAGO_COST_MODALITIES.map(({ paymentTypeId, installments }) =>
        admin
          .from("ordenes")
          .select("id, paid_at, mercadopago_payment_snapshot")
          .not("paid_at", "is", null)
          .eq("mercadopago_payment_snapshot->>payment_type_id", paymentTypeId)
          .eq("mercadopago_payment_snapshot->>installments", String(installments))
          .order("paid_at", { ascending: false })
          .limit(MERCADOPAGO_OBSERVATION_SAMPLE_SIZE),
      ),
    )
    if (results.some(({ error }) => error)) return null
    const rows: MercadoPagoObservationSourceRow[] = results.flatMap(({ data }) => data ?? [])
    return deriveMercadoPagoObservedCosts(rows)
  } catch {
    return null
  }
}

async function loadMercadoPagoInterestFreeStatus(
  admin: ReturnType<typeof createAdminClient>,
): Promise<MercadoPagoInterestFreeStatus> {
  const { data, error } = await admin
    .from("site_settings")
    .select("value")
    .eq("key", MERCADOPAGO_INTEREST_FREE_REFERENCE_KEY)
    .maybeSingle()
  return normalizeMercadoPagoInterestFreeStatus(error ? null : data?.value)
}

/** Estado de sincronización guardado (para conservar la última referencia ante un fallo). */
export function getMercadoPagoInterestFreeStatus() {
  return loadMercadoPagoInterestFreeStatus(createAdminClient())
}

function toFinancingEventSummary(event: CommercialEventRow): FinancingPolicyEventSummary {
  return {
    id: event.id,
    name: event.internal_name,
    status: event.status,
    startsAt: event.starts_at,
    endsAt: event.ends_at,
    previousPolicy: event.previous_financing_policy,
  }
}

/**
 * Eventos de financiación en curso o por venir. El que la controla (activo o
 * trabado al restaurar) bloquea el cambio manual de la política.
 */
export async function loadFinancingPolicyEvents(admin: ReturnType<typeof createAdminClient>) {
  const { data, error } = await admin
    .from("product_bulk_events")
    .select(COMMERCIAL_EVENT_COLUMNS)
    .eq("event_type", "financing_policy")
    .in("status", ["scheduled", "active", "error"])
    .order("starts_at", { ascending: true })
  if (error) return { error: true as const }
  const events = (data ?? []) as unknown as CommercialEventRow[]
  const controlling = getControllingFinancingEvent(events)
  const upcoming = events.find((event) => event.status === "scheduled") ?? null
  return {
    error: false as const,
    controlling: controlling ? toFinancingEventSummary(controlling) : null,
    upcoming: upcoming ? toFinancingEventSummary(upcoming) : null,
  }
}

/** Estado completo de costos de Mercado Pago para Admin (lectura fresca). */
export async function getMercadoPagoCostsOverview(): Promise<MercadoPagoCostsOverview> {
  const admin = createAdminClient()
  const [{ data, error }, observed, interestFreeStatus, policyResult, financingEvents] = await Promise.all([
    admin
      .from("site_settings")
      .select("value")
      .eq("key", "installments_financing")
      .maybeSingle(),
    loadMercadoPagoObservedCosts(admin),
    loadMercadoPagoInterestFreeStatus(admin),
    admin.from("site_settings").select("value").eq("key", FINANCED_PRICE_POLICY_KEY).maybeSingle(),
    loadFinancingPolicyEvents(admin),
  ])
  if (error || policyResult.error) throw new SiteSettingsUnavailableError()
  const stored = normalizeStoredInstallmentsFinancingSettings(data?.value)
  const { mode, interestFreePolicy, ...manual } = stored
  return {
    mode,
    manual,
    observed,
    interestFreePolicy,
    interestFreeStatus,
    interestFreeOffer: buildPublicInterestFreeOffer(interestFreeStatus, interestFreePolicy),
    financedPricePolicy: normalizeFinancedPricePolicy(policyResult.data?.value),
    financingPolicyEvent: financingEvents.error ? null : financingEvents.controlling,
    upcomingFinancingPolicyEvent: financingEvents.error ? null : financingEvents.upcoming,
    ...resolveInstallmentsFinancing(manual, mode, observed),
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

  const request = loadSiteSettings(Boolean(options.fresh))
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
