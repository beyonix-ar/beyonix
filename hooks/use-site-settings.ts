"use client"

import { useEffect, useState } from "react"

import {
  DEFAULT_CUSTOMER_CREDIT_PAYMENT_SETTINGS,
  DEFAULT_STOCK_SETTINGS,
  type CustomerCreditPaymentSettings,
  type StockSettings,
} from "@/lib/site-settings"
import { DEFAULT_SHIPPING_SETTINGS, type ShippingBonusSettings } from "@/lib/store-config"

interface SiteSettingsResponse {
  settings?: {
    shipping?: ShippingBonusSettings
    customerCreditPayments?: CustomerCreditPaymentSettings
    stock?: StockSettings
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

export function invalidateSiteSettingsClientCache() {
  sharedSettingsGeneration += 1
  sharedSettingsCache = null
  sharedSettingsRequest = null
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

  useEffect(() => {
    let active = true

    fetchSiteSettings()
      .then((data) => {
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
      })
      .catch(() => {
        if (!active) return
        setShipping(DEFAULT_SHIPPING_SETTINGS)
        setCustomerCreditPayments(DEFAULT_CUSTOMER_CREDIT_PAYMENT_SETTINGS)
        setStock(DEFAULT_STOCK_SETTINGS)
      })
      .finally(() => {
        if (active) setLoading(false)
      })

    return () => {
      active = false
    }
  }, [])

  return {
    loading,
    shipping,
    customerCreditPayments,
    stock,
  }
}
