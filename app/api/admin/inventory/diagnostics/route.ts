import { requireInternalUser } from "@/lib/auth/admin-api"

export const dynamic = "force-dynamic"

function positiveInteger(value: unknown) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

export async function GET(request: Request) {
  const auth = await requireInternalUser(request, ["admin", "super_admin"])
  if ("error" in auth) return auth.error

  const url = new URL(request.url)
  const productId = positiveInteger(url.searchParams.get("productId"))
  if (!productId) {
    return Response.json({ error: "Producto inválido." }, { status: 400 })
  }

  const [integrity, variants, movements, repairs] = await Promise.all([
    auth.admin
      .from("inventory_stock_integrity")
      .select("*")
      .eq("product_id", productId)
      .maybeSingle(),
    auth.admin
      .from("inventory_variant_diagnostics")
      .select("*")
      .eq("product_id", productId)
      .order("variant_id"),
    auth.admin
      .from("inventory_movements")
      .select(
        "movement_id, product_id, variant_id, movement_type, quantity_delta, origin, effective_at, recorded_at, responsible_process, idempotency_key, document_reference",
      )
      .eq("product_id", productId)
      .order("effective_at", { ascending: false }),
    auth.admin
      .from("inventory_operation_log")
      .select(
        "id, product_id, variant_id, movement_type, quantity, origin, effective_at, actor_process, idempotency_key, source_table, source_id, document_reference, metadata, created_at",
      )
      .eq("product_id", productId)
      .order("created_at", { ascending: false }),
  ])

  const error = integrity.error || variants.error || movements.error || repairs.error
  if (error) {
    const missingMigration =
      /inventory_variant_diagnostics|inventory_operation_log|schema cache|does not exist/i.test(
        error.message,
      )
    return Response.json(
      {
        error: missingMigration
          ? "Falta aplicar la migración de diagnóstico de inventario."
          : "No se pudo generar el diagnóstico de inventario.",
      },
      { status: missingMigration ? 503 : 500 },
    )
  }

  return Response.json(
    {
      integrity: integrity.data,
      variants: variants.data ?? [],
      movements: movements.data ?? [],
      repairs: repairs.data ?? [],
      generatedAt: new Date().toISOString(),
    },
    { headers: { "Cache-Control": "no-store" } },
  )
}

export async function POST(request: Request) {
  const auth = await requireInternalUser(request, ["admin", "super_admin"])
  if ("error" in auth) return auth.error

  const body = (await request.json().catch(() => null)) as
    | Record<string, unknown>
    | null
  const productId = positiveInteger(body?.productId)
  const variantId = positiveInteger(body?.variantId)
  const idempotencyKey = request.headers.get("Idempotency-Key")?.trim() ?? ""

  if (
    !productId ||
    !variantId ||
    body?.confirmed !== true ||
    body?.confirmationText !== "RECONCILIAR" ||
    !/^[A-Za-z0-9._:-]{8,240}$/.test(idempotencyKey)
  ) {
    return Response.json(
      { error: "La reparación requiere una confirmación explícita válida." },
      { status: 400 },
    )
  }

  const { data, error } = await auth.admin.rpc(
    "repair_inventory_allocation_overflow",
    {
      p_product_id: productId,
      p_variant_id: variantId,
      p_confirm: true,
      p_actor_id: auth.user.id,
      p_idempotency_key: idempotencyKey,
      p_document_reference: `inventory-diagnostic:${productId}:${variantId}`,
    },
  )

  if (error) {
    const missingMigration =
      /repair_inventory_allocation_overflow|PGRST202|schema cache/i.test(
        error.message,
      )
    const noProvenCause = /movimiento duplicado demostrable/i.test(error.message)
    return Response.json(
      {
        error: missingMigration
          ? "Falta aplicar la migración de reparación de inventario."
          : noProvenCause
            ? "La reparación fue rechazada porque no existe un movimiento duplicado demostrable."
            : "No se pudo reconciliar el inventario de forma segura.",
      },
      { status: missingMigration ? 503 : 409 },
    )
  }

  return Response.json({ repaired: true, diagnostic: data }, {
    headers: { "Cache-Control": "no-store" },
  })
}
