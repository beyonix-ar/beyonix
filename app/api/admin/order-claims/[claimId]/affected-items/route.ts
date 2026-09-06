import { requireAdmin } from "@/app/api/admin/clientes/_auth"
import { claimErrorResponse, getClaimResult } from "@/lib/orders/claim-server"

export async function PATCH(request: Request, { params }: { params: Promise<{ claimId: string }> }) {
  try {
    const auth = await requireAdmin(request)
    if ("error" in auth) return auth.error
    const claimId = Number((await params).claimId)
    const body: unknown = await request.json()
    if (!Number.isSafeInteger(claimId) || claimId <= 0 || !body || typeof body !== "object") return claimErrorResponse(new Error("CLAIM_INVALID"))
    const input = body as { items?: unknown; expectedUpdatedAt?: unknown }
    if (!Array.isArray(input.items) || !input.items.length || input.items.some((item) => !item || typeof item !== "object")) return claimErrorResponse(new Error("CLAIM_INVALID_ITEMS"))
    const items = input.items.map((item: { orderItemId?: unknown; quantity?: unknown }) => ({ order_item_id: Number(item.orderItemId), quantity: Number(item.quantity) }))
    if (items.some((item) => !Number.isSafeInteger(item.order_item_id) || item.order_item_id <= 0 || !Number.isSafeInteger(item.quantity) || item.quantity <= 0)) return claimErrorResponse(new Error("CLAIM_INVALID_ITEMS"))
    const expected = typeof input.expectedUpdatedAt === "string" ? input.expectedUpdatedAt : ""
    if (!Number.isFinite(Date.parse(expected))) return claimErrorResponse(new Error("CLAIM_CONFLICT"))
    const { error } = await auth.admin.rpc("mutate_admin_order_claim", {
      p_claim_id: claimId, p_actor_id: auth.user.id, p_expected_updated_at: expected,
      p_patch: { action: "affected_items", items },
    })
    if (error) return claimErrorResponse(error)
    return getClaimResult(auth.admin, claimId)
  } catch (error) { return claimErrorResponse(error instanceof SyntaxError ? new Error("CLAIM_INVALID") : error) }
}
