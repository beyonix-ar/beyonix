import { NextResponse } from "next/server"

import {
  normalizeAndreaniError,
  resolveAndreaniReferenceEnvironment,
} from "@/lib/andreani/client"
import { quoteAndreaniCheckout } from "@/lib/andreani/checkout-quote"
import { createCheckoutShippingQuoteToken } from "@/lib/cart/checkout-shipping"

export const dynamic = "force-dynamic"
export const revalidate = 0

const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
}

export async function POST(request: Request) {
  try {
    const payload = await request.json()
    const quotedOptions = await quoteAndreaniCheckout(payload)
    const options = quotedOptions.map((option) => ({
      ...option,
      quoteToken: createCheckoutShippingQuoteToken(payload, option),
    }))
    const environment = resolveAndreaniReferenceEnvironment()

    return NextResponse.json(
      { ok: true, environment, options },
      { headers: NO_STORE_HEADERS },
    )
  } catch (error) {
    const safeError = normalizeAndreaniError(error)
    const status =
      safeError.code === "VALIDATION_ERROR"
        ? 400
        : safeError.code === "CONFIGURATION_ERROR" ||
            safeError.code === "PRODUCTION_BLOCKED"
          ? 503
          : safeError.code === "TIMEOUT" || safeError.code === "SERVICE_UNAVAILABLE"
            ? 504
            : 502
    const message =
      safeError.code === "VALIDATION_ERROR"
        ? safeError.message
        : safeError.code === "TIMEOUT"
          ? "La cotización tardó demasiado. Intentá nuevamente."
          : safeError.code === "CONFIGURATION_ERROR" ||
              safeError.code === "PRODUCTION_BLOCKED"
            ? "El envío no está disponible temporalmente."
            : "No pudimos calcular el envío. Intentá nuevamente."

    return NextResponse.json(
      {
        ok: false,
        code: safeError.code,
        message,
      },
      { status, headers: NO_STORE_HEADERS },
    )
  }
}
