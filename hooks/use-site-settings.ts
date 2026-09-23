"use client"

import { useEffect, useState } from "react"

import {
  DEFAULT_CUSTOMER_CREDIT_PAYMENT_SETTINGS,
  DEFAULT_INSTALLMENTS_FINANCING_SETTINGS,
  DEFAULT_PRICING_SETTINGS,
  DEFAULT_STOCK_SETTINGS,
  type CustomerCreditPaymentSettings,
  type InstallmentsFinancingSettings,
  type PricingSettings,
  type StockSettings,
} from "@/lib/site-settings"
import { DEFAULT_SHIPPING_SETTINGS, type ShippingBonusSettings } from "@/lib/store-config"

interface SiteSettingsResponse {
  settings?: {
    shipping?: ShippingBonusSettings
    customerCreditPayments?: CustomerCreditPaymentSettings
    stock?: StockSettings
    installmentsFinancing?: InstallmentsFinancingSettings
    pricing?: PricingSettings
  }
}

// Varios componentes de una misma pantalla (ej. checkout + resumen del
// carrito) usan este hook a la vez. Sin este cache compartido, cada
// montaje dispara su propio fetch a /api/store/settings duplicando la
// misma llamada en la misma carga de página.
const SETTINGS_CACHE_TTL_MS = 15_000
let sharedSettingsRequest: Promise<SiteSettingsResponse> | null = null
let sharedSettingsGeneration = 0
let sharedSettingsCache: {
  data: SiteSettingsResponse
  at: number
} | null = null

let lastSettingsData: SiteSettingsResponse | null = null

type SiteSettingsListener = (data: SiteSettingsResponse) => void
const siteSettingsListeners = new Set<SiteSettingsListener>()

export function invalidateSiteSettingsClientCache() {
  sharedSettingsGeneration += 1
  sharedSettingsCache = null
  sharedSettingsRequest = null
}

/**
 * Relee la configuración ignorando la caché de 15 s y la propaga a TODOS los
 * `useSiteSettings` montados (checkout, resumen del carrito, etc.). Usado por
 * el refresco comercial de carrito/checkout; es sólo UX -- los cobros
 * siempre releen la configuración server-side.
 */
export async function refreshSiteSettings() {
  const previous = lastSettingsData
  invalidateSiteSettingsClientCache()
  const data = await fetchSiteSettings()
  const changed = JSON.stringify(previous ?? null) !== JSON.stringify(data)
  // Sin cambios no se notifica: nada se re-renderiza.
  if (changed) {
    for (const listener of siteSettingsListeners) listener(data)
  }
  return { data, changed }
}

function fetchSiteSettings() {
  if (
    sharedSettingsCache &&
    Date.now() - sharedSettingsCache.at < SETTINGS_CACHE_TTL_MS
  ) {
    return Promise.resolve(sharedSettingsCache.data)
  }

  if (sharedSettingsRequest) {
    return sharedSettingsRequest
  }

  const requestGeneration = sharedSettingsGeneration
  const request = fetch("/api/store/settings", { cache: "no-store" })
    .then((response) => {
      if (!response.ok) {
        throw new Error("No se pudo cargar la configuración del sitio.")
      }
      return response.json() as Promise<SiteSettingsResponse>
    })
    .then((data) => {
      if (requestGeneration === sharedSettingsGeneration) {
        sharedSettingsCache = { data, at: Date.now() }
      }
      lastSettingsData = data
      return data
    })
    .finally(() => {
      if (sharedSettingsRequest === request) {
        sharedSettingsRequest = null
      }
    })

  sharedSettingsRequest = request
  return request
}

export function useSiteSettings() {
  const [shipping, setShipping] = useState<ShippingBonusSettings>(
    DEFAULT_SHIPPING_SETTINGS,
  )
  const [loading, setLoading] = useState(true)
  const [customerCreditPayments, setCustomerCreditPayments] =
    useState<CustomerCreditPaymentSettings>(
      DEFAULT_CUSTOMER_CREDIT_PAYMENT_SETTINGS,
    )
  const [stock, setStock] = useState<StockSettings>(DEFAULT_STOCK_SETTINGS)
  const [installmentsFinancing, setInstallmentsFinancing] =
    useState<InstallmentsFinancingSettings>(
      DEFAULT_INSTALLMENTS_FINANCING_SETTINGS,
    )
  const [pricing, setPricing] = useState<PricingSettings>(DEFAULT_PRICING_SETTINGS)

  useEffect(() => {
    let active = true

    const applySettings = (data: SiteSettingsResponse) => {
      if (!active) return
      if (data.settings?.shipping) {
        setShipping(data.settings.shipping)
      }
      if (data.settings?.customerCreditPayments) {
        setCustomerCreditPayments(data.settings.customerCreditPayments)
      }
      if (data.settings?.stock) {
        setStock(data.settings.stock)
      }
      if (data.settings?.installmentsFinancing) {
        setInstallmentsFinancing(data.settings.installmentsFinancing)
      }
      if (data.settings?.pricing) {
        setPricing(data.settings.pricing)
      }
    }

    siteSettingsListeners.add(applySettings)

    fetchSiteSettings()
      .then(applySettings)
      .catch(() => {
        if (!active) return
        setShipping(DEFAULT_SHIPPING_SETTINGS)
        setCustomerCreditPayments(DEFAULT_CUSTOMER_CREDIT_PAYMENT_SETTINGS)
        setStock(DEFAULT_STOCK_SETTINGS)
        setInstallmentsFinancing(DEFAULT_INSTALLMENTS_FINANCING_SETTINGS)
        setPricing(DEFAULT_PRICING_SETTINGS)
      })
      .finally(() => {
        if (active) setLoading(false)
      })

    return () => {
      active = false
      siteSettingsListeners.delete(applySettings)
    }
  }, [])

  return {
    loading,
    shipping,
    customerCreditPayments,
    stock,
    installmentsFinancing,
    pricing,
  }
}
