import { NextResponse } from "next/server"

import {
  normalizeAndreaniError,
} from "@/lib/andreani/client"
import { quoteAndreaniCheckout } from "@/lib/andreani/checkout-quote"

export const dynamic = "force-dynamic"
export const revalidate = 0

const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
}

export async function POST(request: Request) {
  try {
    const payload = await request.json()
    const options = await quoteAndreaniCheckout(payload)

    return NextResponse.json(
      { ok: true, environment: "QA", options },
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

    return NextResponse.json(
      {
        ok: false,
        code: safeError.code,
        message: safeError.message,
      },
      { status, headers: NO_STORE_HEADERS },
    )
  }
}
