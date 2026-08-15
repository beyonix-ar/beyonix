import { NextResponse } from "next/server"

import {
  getCheckoutPostalCodes,
  getCheckoutProvinceLocalities,
} from "@/lib/andreani/checkout-destinations"
import { normalizeAndreaniError } from "@/lib/andreani/client"

export const dynamic = "force-dynamic"
export const revalidate = 0

const TERRITORIAL_CACHE_HEADERS = {
  "Cache-Control": "public, max-age=86400, s-maxage=86400",
}

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams
    const province = params.get("provincia") ?? ""
    const locality = params.get("localidad")?.trim()

    if (locality) {
      const result = await getCheckoutPostalCodes(province, locality)
      return NextResponse.json(
        { ok: true, locality: result.locality, postalCodes: result.postalCodes },
        { headers: TERRITORIAL_CACHE_HEADERS },
      )
    }

    const localities = await getCheckoutProvinceLocalities(province)
    return NextResponse.json(
      { ok: true, localities },
      { headers: TERRITORIAL_CACHE_HEADERS },
    )
  } catch (error) {
    const safeError = normalizeAndreaniError(error)
    const status = safeError.code === "VALIDATION_ERROR" ? 400 : 502

    return NextResponse.json(
      {
        ok: false,
        message:
          safeError.code === "VALIDATION_ERROR"
            ? safeError.message
            : "No pudimos cargar los destinos. Intentá nuevamente.",
      },
      { status, headers: { "Cache-Control": "no-store" } },
    )
  }
}
