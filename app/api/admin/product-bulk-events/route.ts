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

type ProductSnapshot = {
  id?: unknown
  precio?: unknown
  precio_anterior?: unknown
  descuento?: unknown
  cuotas_sin_interes?: unknown
  cuotas_maximas?: unknown
  promo_event_id?: unknown
  promo_original_precio?: unknown
  promo_original_precio_anterior?: unknown
  promo_original_descuento?: unknown
  promo_original_cuotas_sin_interes?: unknown
  promo_original_cuotas_maximas?: unknown
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

function formatDate(value: string | null) {
  if (!value) return "sin fecha"

  const [year, month, day] = value.split("-")
  if (!year || !month || !day) return value

  return `${day}/${month}/${year}`
}

function getTodayArgentinaDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Argentina/Buenos_Aires",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date())
  const year = parts.find((part) => part.type === "year")?.value
  const month = parts.find((part) => part.type === "month")?.value
  const day = parts.find((part) => part.type === "day")?.value

  return year && month && day ? `${year}-${month}-${day}` : new Date().toISOString().slice(0, 10)
}

function roundPrice(value: number) {
  return Math.max(1, Math.round(value))
}

function toNullableNumber(value: unknown) {
  if (value === null || value === undefined || value === "") return null

  const number = Number(value)

  return Number.isFinite(number) ? number : null
}

function toNullableBoolean(value: unknown) {
  return typeof value === "boolean" ? value : null
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
    .select("id, nombre, slug, precio, precio_anterior, descuento, cuotas_sin_interes, cuotas_maximas, categoria_id, promo_event_id, promo_original_precio, promo_original_precio_anterior, promo_original_descuento, promo_original_cuotas_sin_interes, promo_original_cuotas_maximas")

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
  const lockedByAnotherEvent = (products as Array<{ nombre?: string; promo_event_id?: string | null }>)
    .find((product) => product.promo_event_id && product.promo_event_id !== event.id)

  if (lockedByAnotherEvent) {
    return {
      error: `El producto "${lockedByAnotherEvent.nombre ?? "seleccionado"}" ya está tomado por otro evento activo.`,
      status: 409,
    }
  }

  for (const product of products as Array<{
    id: number
    nombre?: string
    precio: number | null
    precio_anterior: number | null
    descuento: number | null
    cuotas_sin_interes: boolean | null
    cuotas_maximas: number | null
    promo_event_id?: string | null
    promo_original_precio?: number | null
    promo_original_precio_anterior?: number | null
    promo_original_descuento?: number | null
    promo_original_cuotas_sin_interes?: boolean | null
    promo_original_cuotas_maximas?: number | null
  }>) {
    const currentPrice = Number(product.precio ?? 0)
    const update: Record<string, unknown> = {
      promo_event_id: event.id,
      promo_original_precio: product.promo_event_id
        ? product.promo_original_precio ?? currentPrice
        : currentPrice,
      promo_original_precio_anterior: product.promo_event_id
        ? product.promo_original_precio_anterior ?? null
        : product.precio_anterior ?? null,
      promo_original_descuento: product.promo_event_id
        ? product.promo_original_descuento ?? null
        : product.descuento ?? null,
      promo_original_cuotas_sin_interes: product.promo_event_id
        ? product.promo_original_cuotas_sin_interes ?? false
        : product.cuotas_sin_interes ?? false,
      promo_original_cuotas_maximas: product.promo_event_id
        ? product.promo_original_cuotas_maximas ?? null
        : product.cuotas_maximas ?? null,
    }

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

async function getEventProducts(
  admin: AdminDatabaseClient,
  event: {
    scope: string
    target_items: Array<{ type: "category" | "product"; label: string; url: string }>
  },
) {
  let query = admin
    .from("productos")
    .select("id, nombre, slug, precio, precio_anterior, descuento, cuotas_sin_interes, cuotas_maximas, categoria_id, promo_event_id, promo_original_precio, promo_original_precio_anterior, promo_original_descuento, promo_original_cuotas_sin_interes, promo_original_cuotas_maximas")

  if (event.scope === "product") {
    const slugs = event.target_items
      .map((item) => getSlugFromUrl(item.url, "/productos/"))
      .filter(Boolean)

    if (!slugs.length) return { products: [] }

    query = query.in("slug", slugs)
  } else if (event.scope === "category") {
    const categorySlugs = event.target_items
      .map((item) => getSlugFromUrl(item.url, "/categorias/"))
      .filter(Boolean)

    if (!categorySlugs.length) return { products: [] }

    const { data: categories, error: categoriesError } = await admin
      .from("categorias")
      .select("id, slug")
      .in("slug", categorySlugs)

    if (categoriesError) return { error: categoriesError.message, status: 500 }

    const categoryIds = ((categories ?? []) as Array<{ id: number }>).map(
      (category) => category.id,
    )

    if (!categoryIds.length) return { products: [] }

    query = query.in("categoria_id", categoryIds)
  }

  const { data: products, error } = await query

  if (error) return { error: error.message, status: 500 }

  return { products: products ?? [] }
}

async function restoreProductSnapshots(admin: AdminDatabaseClient, snapshot: ProductSnapshot[]) {
  let restoredCount = 0

  for (const product of snapshot) {
    const id = Number(product.id)
    if (!Number.isFinite(id)) continue
    const hasEventLock = Boolean(product.promo_event_id)

    const { error } = await admin
      .from("productos")
      .update({
        precio: hasEventLock
          ? toNullableNumber(product.promo_original_precio) ?? product.precio ?? null
          : product.precio ?? null,
        precio_anterior: hasEventLock
          ? toNullableNumber(product.promo_original_precio_anterior)
          : product.precio_anterior ?? null,
        descuento: hasEventLock
          ? toNullableNumber(product.promo_original_descuento)
          : product.descuento ?? null,
        cuotas_sin_interes: hasEventLock
          ? toNullableBoolean(product.promo_original_cuotas_sin_interes) ?? false
          : product.cuotas_sin_interes ?? false,
        cuotas_maximas: hasEventLock
          ? toNullableNumber(product.promo_original_cuotas_maximas)
          : product.cuotas_maximas ?? null,
        promo_event_id: null,
        promo_original_precio: null,
        promo_original_precio_anterior: null,
        promo_original_descuento: null,
        promo_original_cuotas_sin_interes: null,
        promo_original_cuotas_maximas: null,
      })
      .eq("id", id)

    if (error) return { error: error.message, status: 500 }

    restoredCount += 1
  }

  return { restoredCount }
}

async function restoreActiveEventFallback(
  admin: AdminDatabaseClient,
  event: {
    scope: string
    target_items: Array<{ type: "category" | "product"; label: string; url: string }>
    action_kind: string
  },
) {
  const result = await getEventProducts(admin, event)
  if ("error" in result) return result

  const snapshot = result.products as ProductSnapshot[]
  let restoredCount = 0

  for (const product of snapshot) {
    const id = Number(product.id)
    if (!Number.isFinite(id)) continue

    const update: Record<string, unknown> = {}

    if (event.action_kind === "discount_percent" || event.action_kind === "price_decrease_percent") {
      update.precio = product.precio_anterior ?? product.precio ?? null
      update.precio_anterior = null
      update.descuento = null
    } else if (event.action_kind === "installments") {
      update.cuotas_sin_interes = false
      update.cuotas_maximas = null
    } else {
      continue
    }

    const { error } = await admin.from("productos").update(update).eq("id", id)

    if (error) return { error: error.message, status: 500 }

    restoredCount += 1
  }

  return { restoredCount }
}

async function restoreLastActivation(
  admin: AdminDatabaseClient,
  eventId: string,
  event: {
    scope: string
    target_items: Array<{ type: "category" | "product"; label: string; url: string }>
    action_kind: string
  },
) {
  const { data: lockedProducts, error: lockedProductsError } = await admin
    .from("productos")
    .select("id, precio, precio_anterior, descuento, cuotas_sin_interes, cuotas_maximas, promo_event_id, promo_original_precio, promo_original_precio_anterior, promo_original_descuento, promo_original_cuotas_sin_interes, promo_original_cuotas_maximas")
    .eq("promo_event_id", eventId)

  if (lockedProductsError) return { error: lockedProductsError.message, status: 500 }

  if (lockedProducts?.length) {
    return restoreProductSnapshots(admin, lockedProducts as ProductSnapshot[])
  }

  const { data: logs, error: logsError } = await admin
    .from("audit_logs")
    .select("id, before_data, after_data")
    .eq("table_name", "product_bulk_events")
    .eq("action", "UPDATE")
    .eq("record_id", eventId)
    .order("created_at", { ascending: false })
    .limit(20)

  if (logsError) return { error: logsError.message, status: 500 }

  const activationLog = (logs ?? []).find(
    (log: { after_data?: { event_type?: unknown } }) => log.after_data?.event_type === "activate",
  )
  const snapshot = activationLog?.before_data

  if (Array.isArray(snapshot) && snapshot.length) {
    return restoreProductSnapshots(admin, snapshot as ProductSnapshot[])
  }

  return restoreActiveEventFallback(admin, event)
}

async function cleanupLegacyOrphanOffers(admin: AdminDatabaseClient) {
  const { count: eventsCount, error: eventsError } = await admin
    .from("product_bulk_events")
    .select("id", { count: "exact", head: true })

  if (eventsError) return { error: eventsError.message, status: 500 }

  if ((eventsCount ?? 0) > 0) {
    return {
      error: "Todavía hay eventos guardados. Eliminá o editá el evento correspondiente para restaurar sus productos.",
      status: 409,
    }
  }

  const { data: products, error: productsError } = await admin
    .from("productos")
    .select("id, precio, precio_anterior, descuento")
    .not("descuento", "is", null)
    .not("precio_anterior", "is", null)

  if (productsError) return { error: productsError.message, status: 500 }

  let cleanedCount = 0

  for (const product of products as Array<{
    id: number
    precio: number | null
    precio_anterior: number | null
    descuento: number | null
  }>) {
    if (!product.descuento || !product.precio_anterior) continue

    const { error } = await admin
      .from("productos")
      .update({
        precio: product.precio_anterior,
        precio_anterior: null,
        descuento: null,
        promo_event_id: null,
        promo_original_precio: null,
        promo_original_precio_anterior: null,
        promo_original_descuento: null,
        promo_original_cuotas_sin_interes: null,
        promo_original_cuotas_maximas: null,
      })
      .eq("id", product.id)

    if (error) return { error: error.message, status: 500 }

    cleanedCount += 1
  }

  return { cleanedCount }
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

  if (action === "cleanup_orphan_offers") {
    const cleaned = await cleanupLegacyOrphanOffers(auth.admin)

    if ("error" in cleaned) {
      return Response.json({ error: cleaned.error }, { status: cleaned.status })
    }

    await auth.admin.from("audit_logs").insert({
      table_name: "productos",
      action: "UPDATE",
      record_id: `event-cleanup:${Date.now()}`,
      actor_user_id: auth.user.id,
      actor_email: auth.user.email ?? auth.profile.email,
      before_data: null,
      after_data: {
        event_type: "cleanup_orphan_offers",
        cleaned_count: cleaned.cleanedCount,
      },
    })

    return Response.json({ ok: true, cleanedCount: cleaned.cleanedCount })
  }

  if (!payload.id) return Response.json({ error: "Falta el evento." }, { status: 400 })

  if (action === "activate") {
    const { data: event, error: eventError } = await auth.admin
      .from("product_bulk_events")
      .select("id, internal_name, starts_on, duration_days, status, scope, target_items, action_kind, value, installments")
      .eq("id", payload.id)
      .single()

    if (eventError || !event) {
      return Response.json({ error: eventError?.message ?? "No encontramos el evento." }, { status: 404 })
    }

    const today = getTodayArgentinaDate()

    if (event.starts_on && event.starts_on > today) {
      return Response.json(
        {
          error: `Este evento empieza el ${formatDate(event.starts_on)}. No se puede activar antes de esa fecha.`,
        },
        { status: 400 },
      )
    }

    if (event.status === "active") {
      return Response.json({ error: "Este evento ya está activo." }, { status: 400 })
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
      action: "UPDATE",
      record_id: payload.id,
      actor_user_id: auth.user.id,
      actor_email: auth.user.email ?? auth.profile.email,
      before_data: applied.beforeData,
      after_data: {
        event_type: "activate",
        event_name: event.internal_name,
        action_kind: event.action_kind,
        affected_count: applied.affectedCount,
      },
    })

    return Response.json({ event: updatedEvent, affectedCount: applied.affectedCount })
  }

  if (action === "pause") {
    const { data: event, error: eventError } = await auth.admin
      .from("product_bulk_events")
      .select("id, internal_name, starts_on, duration_days, status, scope, target_items, action_kind, value, installments")
      .eq("id", payload.id)
      .single()

    if (eventError || !event) {
      return Response.json({ error: eventError?.message ?? "No encontramos el evento." }, { status: 404 })
    }

    if (event.status !== "active") {
      return Response.json({ error: "Este evento no está activo." }, { status: 400 })
    }

    const restored = await restoreLastActivation(auth.admin, payload.id, {
      scope: event.scope,
      target_items: normalizeTargetItems(event.target_items),
      action_kind: event.action_kind,
    })

    if ("error" in restored) {
      return Response.json({ error: restored.error }, { status: restored.status })
    }

    const restoredCount = "restoredCount" in restored ? restored.restoredCount : 0

    const { data: updatedEvent, error: updateError } = await auth.admin
      .from("product_bulk_events")
      .update({
        status: "draft",
        activated_at: null,
        updated_by: auth.user.id,
        updated_at: new Date().toISOString(),
      })
      .eq("id", payload.id)
      .select("id, internal_name, starts_on, duration_days, scope, target_items, action_kind, value, installments, status, activated_at, created_by, updated_by, created_at, updated_at")
      .single()

    if (updateError) return Response.json({ error: updateError.message }, { status: 500 })

    await auth.admin.from("audit_logs").insert({
      table_name: "product_bulk_events",
      action: "UPDATE",
      record_id: payload.id,
      actor_user_id: auth.user.id,
      actor_email: auth.user.email ?? auth.profile.email,
      before_data: { event_name: event.internal_name, status: "active" },
      after_data: {
        event_type: "pause",
        event_name: event.internal_name,
        status: "draft",
        restored_count: restoredCount,
      },
    })

    return Response.json({ event: updatedEvent, restoredCount })
  }

  const validationError = validatePayload(payload)
  if (validationError) return Response.json({ error: validationError }, { status: 400 })

  const { data: currentEvent, error: currentEventError } = await auth.admin
    .from("product_bulk_events")
    .select("id, internal_name, status, scope, target_items, action_kind")
    .eq("id", payload.id)
    .single()

  if (currentEventError || !currentEvent) {
    return Response.json(
      { error: currentEventError?.message ?? "No encontramos el evento." },
      { status: 404 },
    )
  }

  const restored =
    currentEvent.status === "active"
      ? await restoreLastActivation(auth.admin, payload.id, {
          scope: currentEvent.scope,
          target_items: normalizeTargetItems(currentEvent.target_items),
          action_kind: currentEvent.action_kind,
        })
      : { restoredCount: 0 }

  if ("error" in restored) {
    return Response.json({ error: restored.error }, { status: restored.status })
  }

  const restoredCount = "restoredCount" in restored ? restored.restoredCount : 0

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
      status: "draft",
      activated_at: null,
      updated_by: auth.user.id,
      updated_at: new Date().toISOString(),
    })
    .eq("id", payload.id)
    .select("id, internal_name, starts_on, duration_days, scope, target_items, action_kind, value, installments, status, activated_at, created_by, updated_by, created_at, updated_at")
    .single()

  if (error) return Response.json({ error: error.message }, { status: 500 })

  if (restoredCount > 0) {
    await auth.admin.from("audit_logs").insert({
      table_name: "product_bulk_events",
      action: "UPDATE",
      record_id: payload.id,
      actor_user_id: auth.user.id,
      actor_email: auth.user.email ?? auth.profile.email,
      before_data: { event_name: currentEvent.internal_name, status: "active" },
      after_data: {
        event_type: "deactivate",
        event_name: payload.internalName,
        status: "draft",
        restored_count: restoredCount,
      },
    })
  }

  return Response.json({ event: data, restoredCount })
}

export async function DELETE(request: Request) {
  const auth = await requireInternalUser(request, [...MANAGE_ROLES])
  if ("error" in auth) return auth.error

  const { searchParams } = new URL(request.url)
  const id = normalizeText(searchParams.get("id"))

  if (!id) return Response.json({ error: "Falta el evento." }, { status: 400 })

  const { data: event, error: eventError } = await auth.admin
    .from("product_bulk_events")
    .select("id, internal_name, status, scope, target_items, action_kind")
    .eq("id", id)
    .single()

  if (eventError || !event) {
    return Response.json({ error: eventError?.message ?? "No encontramos el evento." }, { status: 404 })
  }

  const restored = await restoreLastActivation(auth.admin, id, {
    scope: event.scope,
    target_items: normalizeTargetItems(event.target_items),
    action_kind: event.action_kind,
  })

  if ("error" in restored) {
    return Response.json({ error: restored.error }, { status: restored.status })
  }

  const restoredCount = "restoredCount" in restored ? restored.restoredCount : 0

  const { error } = await auth.admin.from("product_bulk_events").delete().eq("id", id)

  if (error) return Response.json({ error: error.message }, { status: 500 })

  await auth.admin.from("audit_logs").insert({
    table_name: "product_bulk_events",
    action: "DELETE",
    record_id: id,
    actor_user_id: auth.user.id,
    actor_email: auth.user.email ?? auth.profile.email,
    before_data: event,
    after_data: {
      event_type: "delete_event",
      restored_count: restoredCount,
    },
  })

  return Response.json({ ok: true, restoredCount })
}
