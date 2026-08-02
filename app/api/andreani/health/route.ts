import { NextResponse } from "next/server"

import { getAndreaniDisabledResponse } from "@/lib/andreani/client"

export async function GET() {
  return NextResponse.json(getAndreaniDisabledResponse(), { status: 503 })
}
