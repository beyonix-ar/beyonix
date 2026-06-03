import { NextResponse } from "next/server"

import { getAndreaniDisabledResponse, isAndreaniReady } from "@/lib/andreani/client"

export async function POST() {
  if (!isAndreaniReady()) {
    return NextResponse.json(getAndreaniDisabledResponse())
  }

  return NextResponse.json({
    ok: false,
    message: "Cotización Andreani pendiente de implementar",
  })
}
