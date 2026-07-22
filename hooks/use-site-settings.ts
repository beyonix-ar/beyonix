"use client"

import { useEffect, useState } from "react"

import {
  DEFAULT_CUSTOMER_CREDIT_PAYMENT_SETTINGS,
  type CustomerCreditPaymentSettings,
} from "@/lib/site-settings"
import { DEFAULT_SHIPPING_SETTINGS, type ShippingBonusSettings } from "@/lib/store-config"

interface SiteSettingsResponse {
  settings?: {
    shipping?: ShippingBonusSettings
    customerCreditPayments?: CustomerCreditPaymentSettings
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
      })
      .catch(() => {
        if (!active) return
        setShipping(DEFAULT_SHIPPING_SETTINGS)
        setCustomerCreditPayments(DEFAULT_CUSTOMER_CREDIT_PAYMENT_SETTINGS)
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
  }
}
