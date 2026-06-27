import { NextResponse } from "next/server"

import { getAndreaniHealth } from "@/lib/andreani/client"

export async function GET() {
  return NextResponse.json(getAndreaniHealth())
}
