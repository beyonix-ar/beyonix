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

    fetch("/api/store/settings")
      .then((response) => response.json() as Promise<SiteSettingsResponse>)
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
