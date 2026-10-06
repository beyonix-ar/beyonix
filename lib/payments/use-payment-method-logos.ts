"use client"

import { useEffect, useState } from "react"

import type { PublicPaymentMethodLogo } from "./payment-method-logos.ts"

const SUCCESS_TTL_MS = 5 * 60 * 1000
const FAILURE_TTL_MS = 30 * 1000

let cached: { expiresAt: number; logos: PublicPaymentMethodLogo[] } | null = null
let pending: Promise<PublicPaymentMethodLogo[]> | null = null

function isPublicLogo(value: unknown): value is PublicPaymentMethodLogo {
  if (!value || typeof value !== "object") return false
  const logo = value as Record<string, unknown>
  return (
    typeof logo.key === "string" &&
    (logo.source === "mercadopago" || logo.source === "manual") &&
    typeof logo.name === "string" &&
    typeof logo.imageUrl === "string" &&
    /^https:\/\//.test(logo.imageUrl) &&
    Array.isArray(logo.paymentTypes)
  )
}

function loadLogos(): Promise<PublicPaymentMethodLogo[]> {
  if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.logos)
  pending ??= fetch("/api/payment-methods", { signal: AbortSignal.timeout(8_000) })
    .then(async (response) => {
      if (!response.ok) throw new Error("PAYMENT_METHODS_UNAVAILABLE")
      const data = (await response.json()) as { logos?: unknown }
      const logos = Array.isArray(data.logos) ? data.logos.filter(isPublicLogo) : []
      cached = { expiresAt: Date.now() + SUCCESS_TTL_MS, logos }
      return logos
    })
    .catch(() => {
      // Sin datos confiables no se muestra ningún logo (nunca se inventan).
      cached = { expiresAt: Date.now() + FAILURE_TTL_MS, logos: [] }
      return []
    })
    .finally(() => {
      pending = null
    })
  return pending
}

/**
 * Logos visibles (ya filtrados por el servidor: imagen cargada, habilitados y
 * disponibles en Mercado Pago). Una sola consulta compartida por todos los
 * componentes de la página; `null` mientras carga.
 */
export function usePaymentMethodLogos(): PublicPaymentMethodLogo[] | null {
  const [logos, setLogos] = useState<PublicPaymentMethodLogo[] | null>(() =>
    cached && cached.expiresAt > Date.now() ? cached.logos : null,
  )

  useEffect(() => {
    let active = true
    void loadLogos().then((next) => {
      if (active) setLogos(next)
    })
    return () => {
      active = false
    }
  }, [])

  return logos
}
