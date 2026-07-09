import { requireInternalUser } from "@/lib/auth/admin-api"

const MANAGE_ROLES = ["admin", "super_admin"] as const
const ALLOWED_PLACEMENTS = new Set(["products"])
const LEGACY_BANNER_KEY = "products_hero"

function normalizeText(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

function normalizePlacement(value: unknown) {
  const placement = normalizeText(value)

  if (placement === LEGACY_BANNER_KEY) return "products"

  return ALLOWED_PLACEMENTS.has(placement) ? placement : ""
}

function normalizeOrder(value: unknown) {
  const nextOrder =
    typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10)

  return Number.isFinite(nextOrder) ? nextOrder : 0
}

async function getLegacyBanner(auth: Awaited<ReturnType<typeof requireInternalUser>>) {
  if ("error" in auth) return null

  const { data } = await auth.admin
    .from("site_banners")
    .select("key, image_url, alt_text, active, updated_at")
    .eq("key", LEGACY_BANNER_KEY)
    .maybeSingle()

  if (!data?.image_url) return null

  return {
    id: data.key,
    placement: "products",
    image_url: data.image_url,
    alt_text: data.alt_text,
    active: data.active,
    sort_order: 0,
    updated_at: data.updated_at,
    legacy: true,
  }
}

export async function GET(request: Request) {
  const auth = await requireInternalUser(request, [...MANAGE_ROLES])
  if ("error" in auth) return auth.error

  const { searchParams } = new URL(request.url)
  const placement = normalizePlacement(
    searchParams.get("placement") ?? searchParams.get("key")
  )

  if (!placement) {
    return Response.json({ error: "Ubicación de banner inválida." }, { status: 400 })
  }

  const { data, error } = await auth.admin
    .from("site_banner_items")
    .select("id, placement, image_url, alt_text, active, sort_order, updated_at")
    .eq("placement", placement)
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true })

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  const legacyBanner = data?.length ? null : await getLegacyBanner(auth)
  const banners = legacyBanner ? [legacyBanner] : data ?? []

  return Response.json({ banners })
}

export async function POST(request: Request) {
  const auth = await requireInternalUser(request, [...MANAGE_ROLES])
  if ("error" in auth) return auth.error

  const body = (await request.json()) as {
    placement?: unknown
    image_url?: unknown
    alt_text?: unknown
    active?: unknown
    sort_order?: unknown
  }
  const placement = normalizePlacement(body.placement)
  const imageUrl = normalizeText(body.image_url)

  if (!placement || !imageUrl) {
    return Response.json(
      { error: "Completá la ubicación y la imagen del banner." },
      { status: 400 }
    )
  }

  const payload = {
    placement,
    image_url: imageUrl,
    alt_text: normalizeText(body.alt_text) || "Banner de productos BEYONIX",
    active: typeof body.active === "boolean" ? body.active : true,
    sort_order: normalizeOrder(body.sort_order),
    created_by: auth.user.id,
    updated_by: auth.user.id,
    updated_at: new Date().toISOString(),
  }
  const { data, error } = await auth.admin
    .from("site_banner_items")
    .insert(payload)
    .select("id, placement, image_url, alt_text, active, sort_order, updated_at")
    .single()

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  await auth.admin.from("audit_logs").insert({
    table_name: "site_banner_items",
    action: "INSERT",
    record_id: data.id,
    actor_user_id: auth.user.id,
    actor_email: auth.user.email ?? auth.profile.email,
    before_data: null,
    after_data: data,
  })

  return Response.json({ banner: data })
}

export async function PATCH(request: Request) {
  const auth = await requireInternalUser(request, [...MANAGE_ROLES])
  if ("error" in auth) return auth.error

  const body = (await request.json()) as {
    id?: unknown
    placement?: unknown
    image_url?: unknown
    alt_text?: unknown
    active?: unknown
    sort_order?: unknown
  }
  const id = normalizeText(body.id)
  const placement = normalizePlacement(body.placement)
  const imageUrl = normalizeText(body.image_url)

  if (!id || !placement || !imageUrl) {
    return Response.json(
      { error: "Faltan datos para actualizar el banner." },
      { status: 400 }
    )
  }

  const before = await auth.admin
    .from("site_banner_items")
    .select("id, placement, image_url, alt_text, active, sort_order, updated_at")
    .eq("id", id)
    .maybeSingle()

  if (before.error || !before.data) {
    return Response.json({ error: "Banner no encontrado." }, { status: 404 })
  }

  const { data, error } = await auth.admin
    .from("site_banner_items")
    .update({
      placement,
      image_url: imageUrl,
      alt_text: normalizeText(body.alt_text) || "Banner de productos BEYONIX",
      active: typeof body.active === "boolean" ? body.active : true,
      sort_order: normalizeOrder(body.sort_order),
      updated_by: auth.user.id,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .select("id, placement, image_url, alt_text, active, sort_order, updated_at")
    .single()

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  await auth.admin.from("audit_logs").insert({
    table_name: "site_banner_items",
    action: "UPDATE",
    record_id: id,
    actor_user_id: auth.user.id,
    actor_email: auth.user.email ?? auth.profile.email,
    before_data: before.data,
    after_data: data,
  })

  return Response.json({ banner: data })
}

export async function DELETE(request: Request) {
  const auth = await requireInternalUser(request, [...MANAGE_ROLES])
  if ("error" in auth) return auth.error

  const { searchParams } = new URL(request.url)
  const id = normalizeText(searchParams.get("id"))

  if (!id) {
    return Response.json({ error: "Falta el banner a eliminar." }, { status: 400 })
  }

  const before = await auth.admin
    .from("site_banner_items")
    .select("id, placement, image_url, alt_text, active, sort_order, updated_at")
    .eq("id", id)
    .maybeSingle()

  if (before.error || !before.data) {
    return Response.json({ error: "Banner no encontrado." }, { status: 404 })
  }

  const { error } = await auth.admin
    .from("site_banner_items")
    .delete()
    .eq("id", id)

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  await auth.admin.from("audit_logs").insert({
    table_name: "site_banner_items",
    action: "DELETE",
    record_id: id,
    actor_user_id: auth.user.id,
    actor_email: auth.user.email ?? auth.profile.email,
    before_data: before.data,
    after_data: null,
  })

  return Response.json({ ok: true })
}
