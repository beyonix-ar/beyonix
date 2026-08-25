import { createAndreaniAdminTestHandlers } from "@/lib/andreani/admin-test-handler"
import {
  getAndreaniIntegrationStatus,
  testAndreaniQaConnection,
} from "@/lib/andreani/client"
import { getAndreaniShipmentCreationConfigStatus } from "@/lib/andreani/order-shipment"
import { requireInternalUser } from "@/lib/auth/admin-api"

export const dynamic = "force-dynamic"

const handlers = createAndreaniAdminTestHandlers({
  authorize: async (request) => {
    const result = await requireInternalUser(request, ["admin", "super_admin"])
    return "error" in result ? result : { authorized: true }
  },
  getStatus: () => ({
    ...getAndreaniIntegrationStatus(),
    shipmentCreation: getAndreaniShipmentCreationConfigStatus(),
  }),
  testConnection: testAndreaniQaConnection,
})

export const GET = handlers.GET
export const POST = handlers.POST
