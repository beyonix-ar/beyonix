import { NextResponse } from "next/server"

import {
  getCheckoutPostalCodes,
  getCheckoutProvinceLocalities,
} from "@/lib/andreani/checkout-destinations"
import { normalizeAndreaniError } from "@/lib/andreani/client"

export const dynamic = "force-dynamic"
export const revalidate = 0

// IMPORTANTE: nunca usar un Cache-Control público/compartido acá. La CDN de
// Netlify no varía su caché de borde por query string en esta ruta (lo
// comprobamos en vivo: pedir provincias distintas -- Jujuy, Chubut, Córdoba --
// devolvía siempre la misma respuesta cacheada de otra consulta), así que
// cualquier `public`/`s-maxage` termina sirviéndole a un usuario los datos
// territoriales de otro. El cacheo real y correctamente segmentado por
// provincia+localidad ya existe server-side en `checkout-destinations.ts`
// (Map en memoria, TTL 24h, deduplicado por clave) -- estos headers solo
// deben impedir que una capa intermedia comparta la respuesta entre queries.
const TERRITORIAL_CACHE_HEADERS = {
  "Cache-Control": "private, no-store",
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
