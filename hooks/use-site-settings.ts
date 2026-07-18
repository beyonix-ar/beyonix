"use client"

import { useEffect, useState } from "react"

import {
  DEFAULT_SHIPPING_SETTINGS,
  type ShippingBonusSettings,
} from "@/lib/store-config"

interface SiteSettingsResponse {
  settings?: {
    shipping?: ShippingBonusSettings
  }
}

export function useSiteSettings() {
  const [shipping, setShipping] = useState<ShippingBonusSettings>(
    DEFAULT_SHIPPING_SETTINGS,
  )
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true

    fetch("/api/store/settings")
      .then((response) => response.json() as Promise<SiteSettingsResponse>)
      .then((data) => {
        if (!active) return
        if (data.settings?.shipping) {
          setShipping(data.settings.shipping)
        }
      })
      .catch(() => {
        if (!active) return
        setShipping(DEFAULT_SHIPPING_SETTINGS)
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
  }
}
