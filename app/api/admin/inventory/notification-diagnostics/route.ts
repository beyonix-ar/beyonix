import { requireInternalUser } from "@/lib/auth/admin-api"

export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  const auth = await requireInternalUser(request, ["admin", "super_admin"])
  if ("error" in auth) return auth.error

  const [integrity, diagnostics] = await Promise.all([
    auth.admin
      .from("inventory_stock_integrity")
      .select(
        "product_id, product_name, stored_normal_stock, calculated_normal_stock, stored_variant_stock, calculated_variant_stock, generic_balance, allocation_overflow, pending_review_stock, issues",
      )
      .order("product_id", { ascending: true })
      .limit(250),
    auth.admin
      .from("inventory_variant_diagnostics")
      .select(
        "product_id, variant_id, variant_name, actual_stock, expected_stock, difference, duplicated_allocation, possible_cause_movement_id",
      )
      .limit(500),
  ])

  if (integrity.error || diagnostics.error) {
    return Response.json(
      { error: "No se pudo consultar la integridad del inventario." },
      { status: 500 },
    )
  }

  return Response.json(
    {
      integrity: integrity.data ?? [],
      diagnostics: diagnostics.data ?? [],
    },
    { headers: { "Cache-Control": "private, no-store" } },
  )
}
