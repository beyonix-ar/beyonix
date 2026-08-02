import { NextResponse } from "next/server"

import { getAndreaniDisabledResponse } from "@/lib/andreani/client"
import { requireInternalUser } from "@/lib/auth/admin-api"

export async function POST(request: Request) {
  const authorization = await requireInternalUser(request, ["admin", "super_admin"])
  if ("error" in authorization) return authorization.error

  return NextResponse.json(getAndreaniDisabledResponse(), { status: 503 })
}
