import { NextResponse } from "next/server"

import {
  getAndreaniToken,
  normalizeAndreaniError,
} from "@/lib/andreani/client"

export const dynamic = "force-dynamic"
export const revalidate = 0
export const runtime = "nodejs"

const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
}

function getErrorHttpStatus(
  code: ReturnType<typeof normalizeAndreaniError>["code"],
) {
  if (code === "CONFIGURATION_ERROR") return 503
  if (code === "TIMEOUT" || code === "SERVICE_UNAVAILABLE") return 504
  return 502
}

export async function GET() {
  try {
    await getAndreaniToken({}, { forceRefresh: true })

    return NextResponse.json(
      { ok: true },
      { status: 200, headers: NO_STORE_HEADERS },
    )
  } catch (error) {
    const safeError = normalizeAndreaniError(error)
    const status = getErrorHttpStatus(safeError.code)

    console.error("[Andreani] Falló la prueba de login.", {
      environment: "QA",
      code: safeError.code,
      upstreamStatus: safeError.status,
    })

    return NextResponse.json(
      { ok: false },
      { status, headers: NO_STORE_HEADERS },
    )
  }
}
