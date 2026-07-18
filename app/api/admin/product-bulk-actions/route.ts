import { requireInternalUser } from "@/lib/auth/admin-api"

const MANAGE_ROLES = ["admin", "super_admin"] as const
const ACTION_KINDS = new Set([
  "discount_percent",
  "price_increase_percent",
  "price_decrease_percent",
  "installments",
  "clear_offer",
])

function normalizeText(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

function normalizeNumber(value: unknown) {
  const number = Number(value)

  return Number.isFinite(number) ? number : 0
}

function roundBulkPrice(value: number) {
  const price = Math.max(1, value)

  if (price < 500) return Math.round(price)

  const thousand = Math.floor(price / 1000) * 1000
  const candidates = [
    thousand - 100,
    thousand,
    thousand + 500,
    thousand + 900,
    thousand + 1000,
  ].filter((candidate) => candidate >= 500)

  return candidates.reduce((closest, candidate) => {
    const candidateDistance = Math.abs(candidate - price)
    const closestDistance = Math.abs(closest - price)

    return candidateDistance <= closestDistance ? candidate : closest
  })
}

function getSlugFromUrl(url: string, prefix: string) {
  return url.startsWith(prefix) ? url.slice(prefix.length) : ""
}

export async function POST(request: Request) {
  const auth = await requireInternalUser(request, [...MANAGE_ROLES])
  if ("error" in auth) return auth.error

  const body = (await request.json()) as {
    scope?: unknown
    target_items?: Array<{ type?: unknown; url?: unknown }>
    action_kind?: unknown
    value?: unknown
    installments?: unknown
  }
  const scope = normalizeText(body.scope)
  const actionKind = normalizeText(body.action_kind)
  const value = normalizeNumber(body.value)
  const installments = normalizeNumber(body.installments)
  const targetItems = Array.isArray(body.target_items) ? body.target_items : []

  if (!ACTION_KINDS.has(actionKind)) {
    return Response.json({ error: "Elegí una acción masiva válida." }, { status: 400 })
  }

  if (
    ["discount_percent", "price_increase_percent", "price_decrease_percent"].includes(actionKind) &&
    (value <= 0 || value >= 100)
  ) {
    return Response.json({ error: "El porcentaje debe estar entre 1 y 99." }, { status: 400 })
  }

  if (actionKind === "installments" && ![3, 6].includes(installments)) {
    return Response.json({ error: "Elegí 3 o 6 cuotas sin interés." }, { status: 400 })
  }

  let query = auth.admin
    .from("productos")
    .select("id, nombre, slug, precio, precio_anterior, descuento, cuotas_sin_interes, cuotas_maximas, categoria_id")

  if (scope === "product") {
    const slugs = targetItems
      .map((item) => getSlugFromUrl(normalizeText(item.url), "/productos/"))
      .filter(Boolean)

    if (!slugs.length) {
      return Response.json({ error: "Agregá al menos un producto." }, { status: 400 })
    }

    query = query.in("slug", slugs)
  } else if (scope === "category") {
    const categorySlugs = targetItems
      .map((item) => getSlugFromUrl(normalizeText(item.url), "/categorias/"))
      .filter(Boolean)

    if (!categorySlugs.length) {
      return Response.json({ error: "Agregá al menos una categoría." }, { status: 400 })
    }

    const { data: categories, error: categoriesError } = await auth.admin
      .from("categorias")
      .select("id, slug")
      .in("slug", categorySlugs)

    if (categoriesError) {
      return Response.json({ error: categoriesError.message }, { status: 500 })
    }

    const categoryIds = (categories ?? []).map((category) => category.id)

    if (!categoryIds.length) {
      return Response.json({ error: "No encontramos esas categorías." }, { status: 404 })
    }

    query = query.in("categoria_id", categoryIds)
  } else if (scope !== "store") {
    return Response.json({ error: "Elegí el alcance de productos." }, { status: 400 })
  }

  const { data: products, error: productsError } = await query

  if (productsError) {
    return Response.json({ error: productsError.message }, { status: 500 })
  }

  if (!products?.length) {
    return Response.json({ error: "No hay productos para aplicar la acción." }, { status: 404 })
  }

  const beforeData = products

  for (const product of products) {
    const currentPrice = Number(product.precio ?? 0)
    const payload: Record<string, unknown> = {}

    if (actionKind === "discount_percent") {
      payload.precio_anterior = currentPrice
      payload.precio = roundBulkPrice(currentPrice * (1 - value / 100))
      payload.descuento = Math.round(value)
    } else if (actionKind === "price_decrease_percent") {
      payload.precio_anterior = currentPrice
      payload.precio = roundBulkPrice(currentPrice * (1 - value / 100))
      payload.descuento = Math.round(value)
    } else if (actionKind === "price_increase_percent") {
      payload.precio = roundBulkPrice(currentPrice * (1 + value / 100))
      payload.precio_anterior = null
      payload.descuento = null
    } else if (actionKind === "installments") {
      payload.cuotas_sin_interes = true
      payload.cuotas_maximas = installments
    } else if (actionKind === "clear_offer") {
      payload.precio_anterior = null
      payload.descuento = null
      payload.cuotas_sin_interes = false
      payload.cuotas_maximas = null
    }

    const { error } = await auth.admin
      .from("productos")
      .update(payload)
      .eq("id", product.id)

    if (error) {
      return Response.json({ error: error.message }, { status: 500 })
    }
  }

  await auth.admin.from("audit_logs").insert({
    table_name: "productos",
    action: "UPDATE",
    record_id: `bulk:${Date.now()}`,
    actor_user_id: auth.user.id,
    actor_email: auth.user.email ?? auth.profile.email,
    before_data: beforeData,
    after_data: {
      action_kind: actionKind,
      value,
      installments,
      scope,
      affected_count: products.length,
    },
  })

  return Response.json({ ok: true, affectedCount: products.length })
}
