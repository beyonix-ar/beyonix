import { NextResponse } from "next/server"

import { getAndreaniHealth } from "@/lib/andreani/client"
import { getAndreaniShipmentCreationConfigStatus } from "@/lib/andreani/order-shipment"
import { requireInternalUser } from "@/lib/auth/admin-api"

export async function GET(request: Request) {
  const authorization = await requireInternalUser(request)
  if ("error" in authorization) return authorization.error

  const health = getAndreaniHealth()
  const shipmentCreation = getAndreaniShipmentCreationConfigStatus()
  const ready = health.configured && shipmentCreation.configured

  return NextResponse.json(
    {
      ...health,
      ready,
      shipmentCreationEnabled: shipmentCreation.configured,
      shipmentEnvironment: shipmentCreation.environment,
      shipmentCreation,
    },
    { status: ready ? 200 : 503 },
  )
}
