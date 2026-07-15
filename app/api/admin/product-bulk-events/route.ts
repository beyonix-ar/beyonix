import { requireInternalUser } from "@/lib/auth/admin-api"

const MANAGE_ROLES = ["admin", "super_admin"] as const
const ACTION_KINDS = new Set([
  "discount_percent",
  "price_increase_percent",
  "price_decrease_percent",
  "installments",
  "clear_offer",
])
const SCOPES = new Set(["store", "category", "product"])

type TargetItem = {
  type?: unknown
  label?: unknown
  url?: unknown
}

type AdminDatabaseClient = {
  from: (table: string) => any
}

function normalizeText(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

function normalizeNumber(value: unknown) {
  const number = Number(value)

  return Number.isFinite(number) ? number : 0
}

function normalizeNullableNumber(value: unknown) {
  if (value === null || value === undefined || value === "") return null

  const number = Number(value)

  return Number.isFinite(number) ? number : null
}

function normalizeTargetItems(value: unknown) {
  if (!Array.isArray(value)) return []

  return value
    .map((item: TargetItem) => {
      const type = normalizeText(item.type)
      const label = normalizeText(item.label)
      const url = normalizeText(item.url)

      if ((type !== "category" && type !== "product") || !label || !url.startsWith("/")) {
        return null
      }

      return { type, label, url }
    })
    .filter((item): item is { type: "category" | "product"; label: string; url: string } =>
      Boolean(item),
    )
}

function normalizeDate(value: unknown) {
  const text = normalizeText(value)
  if (!text) return null

  const date = new Date(`${text}T00:00:00`)

  return Number.isNaN(date.getTime()) ? null : text
}

function roundPrice(value: number) {
  return Math.max(1, Math.round(value))
}

function getSlugFromUrl(url: string, prefix: string) {
  return url.startsWith(prefix) ? url.slice(prefix.length) : ""
}

function validatePayload(payload: {
  internalName: string
  scope: string
  targetItems: Array<{ type: "category" | "product"; label: string; url: string }>
  actionKind: string
  value: number | null
  installments: number | null
  durationDays: number | null
}) {
  if (!payload.internalName) return "Escribí un nombre interno para el evento."
  if (!SCOPES.has(payload.scope)) return "Elegí el alcance del evento."
  if (!ACTION_KINDS.has(payload.actionKind)) return "Elegí una promoción válida."

  if (payload.scope !== "store" && !payload.targetItems.length) {
    return payload.scope === "product"
      ? "Marcá al menos un producto para el evento."
      : "Agregá al menos una categoría para el evento."
  }

  if (
    ["discount_percent", "price_increase_percent", "price_decrease_percent"].includes(
      payload.actionKind,
    ) &&
    (!payload.value || payload.value <= 0 || payload.value >= 100)
  ) {
    return "El porcentaje debe estar entre 1 y 99."
  }

  if (payload.actionKind === "installments" && ![3, 6].includes(payload.installments ?? 0)) {
    return "Elegí 3 o 6 cuotas sin interés."
  }

  if (payload.durationDays !== null && (payload.durationDays < 1 || payload.durationDays > 365)) {
    return "La duración debe estar entre 1 y 365 días."
  }

  return ""
}

function readPayload(body: Record<string, unknown>) {
  return {
    id: normalizeText(body.id),
    internalName: normalizeText(body.internal_name),
    startsOn: normalizeDate(body.starts_on),
    durationDays: normalizeNullableNumber(body.duration_days),
    scope: normalizeText(body.scope) || "product",
    targetItems: normalizeTargetItems(body.target_items),
    actionKind: normalizeText(body.action_kind),
    value: normalizeNullableNumber(body.value),
    installments: normalizeNullableNumber(body.installments),
  }
}

async function applyEventAction(
  admin: AdminDatabaseClient,
  event: {
    id: string
    internal_name: string
    scope: string
    target_items: Array<{ type: "category" | "product"; label: string; url: string }>
    action_kind: string
    value: number | null
    installments: number | null
  },
) {
  let query = admin
    .from("productos")
    .select("id, nombre, slug, precio, precio_anterior, descuento, cuotas_sin_interes, cuotas_maximas, categoria_id")

  if (event.scope === "product") {
    const slugs = event.target_items
      .map((item) => getSlugFromUrl(item.url, "/productos/"))
      .filter(Boolean)

    if (!slugs.length) return { error: "El evento no tiene productos seleccionados.", status: 400 }

    query = query.in("slug", slugs)
  } else if (event.scope === "category") {
    const categorySlugs = event.target_items
      .map((item) => getSlugFromUrl(item.url, "/categorias/"))
      .filter(Boolean)

    if (!categorySlugs.length) return { error: "El evento no tiene categorías seleccionadas.", status: 400 }

    const { data: categories, error: categoriesError } = await admin
      .from("categorias")
      .select("id, slug")
      .in("slug", categorySlugs)

    if (categoriesError) return { error: categoriesError.message, status: 500 }

    const categoryIds = ((categories ?? []) as Array<{ id: number }>).map(
      (category) => category.id,
    )

    if (!categoryIds.length) return { error: "No encontramos esas categorías.", status: 404 }

    query = query.in("categoria_id", categoryIds)
  }

  const { data: products, error: productsError } = await query

  if (productsError) return { error: productsError.message, status: 500 }
  if (!products?.length) return { error: "No hay productos para activar el evento.", status: 404 }

  const value = Number(event.value ?? 0)
  const installments = Number(event.installments ?? 0)

  for (const product of products as Array<{
    id: number
    precio: number | null
  }>) {
    const currentPrice = Number(product.precio ?? 0)
    const update: Record<string, unknown> = {}

    if (event.action_kind === "discount_percent" || event.action_kind === "price_decrease_percent") {
      update.precio_anterior = currentPrice
      update.precio = roundPrice(currentPrice * (1 - value / 100))
      update.descuento = Math.round(value)
    } else if (event.action_kind === "price_increase_percent") {
      update.precio = roundPrice(currentPrice * (1 + value / 100))
      update.precio_anterior = null
      update.descuento = null
    } else if (event.action_kind === "installments") {
      update.cuotas_sin_interes = true
      update.cuotas_maximas = installments
    } else if (event.action_kind === "clear_offer") {
      update.precio_anterior = null
      update.descuento = null
      update.cuotas_sin_interes = false
      update.cuotas_maximas = null
    }

    const { error } = await admin.from("productos").update(update).eq("id", product.id)

    if (error) return { error: error.message, status: 500 }
  }

  return { affectedCount: products.length, beforeData: products }
}

export async function GET(request: Request) {
  const auth = await requireInternalUser(request, [...MANAGE_ROLES])
  if ("error" in auth) return auth.error

  const { data, error } = await auth.admin
    .from("product_bulk_events")
    .select("id, internal_name, starts_on, duration_days, scope, target_items, action_kind, value, installments, status, activated_at, created_by, updated_by, created_at, updated_at")
    .order("created_at", { ascending: false })

  if (error) return Response.json({ error: error.message }, { status: 500 })

  return Response.json({ events: data ?? [] })
}

export async function POST(request: Request) {
  const auth = await requireInternalUser(request, [...MANAGE_ROLES])
  if ("error" in auth) return auth.error

  const body = (await request.json()) as Record<string, unknown>
  const payload = readPayload(body)
  const validationError = validatePayload(payload)

  if (validationError) return Response.json({ error: validationError }, { status: 400 })

  const { data, error } = await auth.admin
    .from("product_bulk_events")
    .insert({
      internal_name: payload.internalName,
      starts_on: payload.startsOn,
      duration_days: payload.durationDays,
      scope: payload.scope,
      target_items: payload.targetItems,
      action_kind: payload.actionKind,
      value: payload.value,
      installments: payload.installments,
      status: "draft",
      created_by: auth.user.id,
      updated_by: auth.user.id,
    })
    .select("id, internal_name, starts_on, duration_days, scope, target_items, action_kind, value, installments, status, activated_at, created_by, updated_by, created_at, updated_at")
    .single()

  if (error) return Response.json({ error: error.message }, { status: 500 })

  return Response.json({ event: data })
}

export async function PATCH(request: Request) {
  const auth = await requireInternalUser(request, [...MANAGE_ROLES])
  if ("error" in auth) return auth.error

  const body = (await request.json()) as Record<string, unknown>
  const action = normalizeText(body.action)
  const payload = readPayload(body)

  if (!payload.id) return Response.json({ error: "Falta el evento." }, { status: 400 })

  if (action === "activate") {
    const { data: event, error: eventError } = await auth.admin
      .from("product_bulk_events")
      .select("id, internal_name, scope, target_items, action_kind, value, installments")
      .eq("id", payload.id)
      .single()

    if (eventError || !event) {
      return Response.json({ error: eventError?.message ?? "No encontramos el evento." }, { status: 404 })
    }

    const applied = await applyEventAction(auth.admin, {
      ...event,
      target_items: normalizeTargetItems(event.target_items),
    })

    if ("error" in applied) {
      return Response.json({ error: applied.error }, { status: applied.status })
    }

    const { data: updatedEvent, error: updateError } = await auth.admin
      .from("product_bulk_events")
      .update({
        status: "active",
        activated_at: new Date().toISOString(),
        updated_by: auth.user.id,
        updated_at: new Date().toISOString(),
      })
      .eq("id", payload.id)
      .select("id, internal_name, starts_on, duration_days, scope, target_items, action_kind, value, installments, status, activated_at, created_by, updated_by, created_at, updated_at")
      .single()

    if (updateError) return Response.json({ error: updateError.message }, { status: 500 })

    await auth.admin.from("audit_logs").insert({
      table_name: "product_bulk_events",
      action: "ACTIVATE",
      record_id: payload.id,
      actor_user_id: auth.user.id,
      actor_email: auth.user.email ?? auth.profile.email,
      before_data: applied.beforeData,
      after_data: {
        event_name: event.internal_name,
        action_kind: event.action_kind,
        affected_count: applied.affectedCount,
      },
    })

    return Response.json({ event: updatedEvent, affectedCount: applied.affectedCount })
  }

  const validationError = validatePayload(payload)
  if (validationError) return Response.json({ error: validationError }, { status: 400 })

  const { data, error } = await auth.admin
    .from("product_bulk_events")
    .update({
      internal_name: payload.internalName,
      starts_on: payload.startsOn,
      duration_days: payload.durationDays,
      scope: payload.scope,
      target_items: payload.targetItems,
      action_kind: payload.actionKind,
      value: payload.value,
      installments: payload.installments,
      updated_by: auth.user.id,
      updated_at: new Date().toISOString(),
    })
    .eq("id", payload.id)
    .select("id, internal_name, starts_on, duration_days, scope, target_items, action_kind, value, installments, status, activated_at, created_by, updated_by, created_at, updated_at")
    .single()

  if (error) return Response.json({ error: error.message }, { status: 500 })

  return Response.json({ event: data })
}

export async function DELETE(request: Request) {
  const auth = await requireInternalUser(request, [...MANAGE_ROLES])
  if ("error" in auth) return auth.error

  const { searchParams } = new URL(request.url)
  const id = normalizeText(searchParams.get("id"))

  if (!id) return Response.json({ error: "Falta el evento." }, { status: 400 })

  const { error } = await auth.admin.from("product_bulk_events").delete().eq("id", id)

  if (error) return Response.json({ error: error.message }, { status: 500 })

  return Response.json({ ok: true })
}
