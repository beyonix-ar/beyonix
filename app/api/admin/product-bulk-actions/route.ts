import { requireInternalUser } from "@/lib/auth/admin-api"
import {
  computeBulkPriceUpdate,
  validateBulkPriceAction,
  type BulkPriceActionKind,
} from "@/lib/pricing/bulk-price-engine"
import {
  normalizeBulkTargetItems,
  resolveBulkTargetProducts,
  type BulkPriceScope,
} from "@/lib/pricing/bulk-price-targets"

const MANAGE_ROLES = ["admin", "super_admin"] as const

function normalizeText(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

/**
 * Editor masivo: cambio MANUAL inmediato de precios. El cálculo es el núcleo
 * compartido (`lib/pricing/bulk-price-engine.ts`), el mismo que ejecutan los
 * eventos programados de precios. Sin acción de cuotas: la financiación es
 * global (Admin → Financiación).
 */
export async function POST(request: Request) {
  const auth = await requireInternalUser(request, [...MANAGE_ROLES])
  if ("error" in auth) return auth.error

  const body = (await request.json()) as {
    scope?: unknown
    target_items?: unknown
    action_kind?: unknown
    value?: unknown
  }
  const scope = normalizeText(body.scope)
  const actionKind = normalizeText(body.action_kind)
  const value = Number(body.value ?? 0)

  const validationError = validateBulkPriceAction(actionKind, value)
  if (validationError) return Response.json({ error: validationError }, { status: 400 })

  const resolved = await resolveBulkTargetProducts(
    auth.admin,
    scope as BulkPriceScope,
    normalizeBulkTargetItems(body.target_items),
  )
  if ("error" in resolved) return Response.json({ error: resolved.error }, { status: resolved.status })

  const products = resolved.products
  if (!products.length) {
    return Response.json({ error: "No hay productos para aplicar la acción." }, { status: 404 })
  }

  const updates = products.map((product) => ({ product, after: computeBulkPriceUpdate(product, actionKind as BulkPriceActionKind, value) }))
  if (updates.some(({ after }) => !Number.isFinite(after.precio) || after.precio < 1 || after.precio > 99_999_999.99)) {
    return Response.json({ error: "El cambio daría un precio inválido para al menos un producto." }, { status: 400 })
  }

  for (const { product, after } of updates) {
    const { error } = await auth.admin
      .from("productos")
      .update(after)
      .eq("id", product.id)

    if (error) {
      return Response.json({ error: "No se pudo actualizar el precio de un producto." }, { status: 500 })
    }
  }

  await auth.admin.from("audit_logs").insert({
    table_name: "productos",
    action: "UPDATE",
    record_id: `bulk:${Date.now()}`,
    actor_user_id: auth.user.id,
    actor_email: auth.user.email ?? auth.profile.email,
    before_data: products,
    after_data: {
      action_kind: actionKind,
      value,
      scope,
      affected_count: products.length,
    },
  })

  return Response.json({ ok: true, affectedCount: products.length })
}
