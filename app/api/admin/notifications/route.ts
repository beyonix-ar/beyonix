import { requireInternalUser } from "@/lib/auth/admin-api"
import type {
  SupabaseCustomerNotificationCampaign,
  SupabaseCustomerNotificationCampaignType,
} from "@/lib/supabase/types"

const MANAGE_ROLES = ["admin", "super_admin"] as const

const CAMPAIGN_TYPES = new Set<SupabaseCustomerNotificationCampaignType>([
  "promocion",
  "descuento",
  "evento",
  "oferta",
  "cuotas",
  "producto_destacado",
  "mensaje",
])

const TARGET_SCOPES = new Set(["store", "category", "product", "general"])

function normalizeText(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

function normalizeNullableUrl(value: unknown) {
  const url = normalizeText(value)

  if (!url) return null
  if (url.startsWith("/") || url.startsWith("https://") || url.startsWith("http://")) {
    return url
  }

  return ""
}

function normalizeType(value: unknown) {
  const type = normalizeText(value) as SupabaseCustomerNotificationCampaignType

  return CAMPAIGN_TYPES.has(type) ? type : null
}

function normalizeTargetScope(value: unknown) {
  const scope = normalizeText(value)

  return TARGET_SCOPES.has(scope) ? scope : "store"
}

function normalizeTargetItems(value: unknown) {
  if (!Array.isArray(value)) return []

  return value
    .map((item) => {
      if (typeof item !== "object" || item === null) return null

      const candidate = item as {
        type?: unknown
        label?: unknown
        url?: unknown
      }
      const type = normalizeText(candidate.type)
      const label = normalizeText(candidate.label)
      const url = normalizeText(candidate.url)

      if (!["category", "product"].includes(type) || !label || !url.startsWith("/")) {
        return null
      }

      return { type, label, url }
    })
    .filter(Boolean)
    .slice(0, 24)
}

function normalizeDate(value: unknown) {
  const text = normalizeText(value)
  if (!text) return null

  const date = new Date(text)

  return Number.isNaN(date.getTime()) ? "" : date.toISOString()
}

async function publishCampaign(
  auth: Exclude<Awaited<ReturnType<typeof requireInternalUser>>, { error: Response }>,
  campaign: Pick<
    SupabaseCustomerNotificationCampaign,
    "id" | "type" | "title" | "body" | "action_url" | "target_items" | "starts_at" | "ends_at"
  >,
) {
  const { data: clients, error: clientsError } = await auth.admin
    .from("profiles")
    .select("id")
    .eq("rol", "cliente")

  if (clientsError) throw clientsError

  const rows = (clients ?? []).map((client) => ({
    user_id: client.id,
    type: campaign.type,
    title: campaign.title,
    body: campaign.body,
    action_url: campaign.action_url,
    target_items: campaign.target_items ?? [],
    starts_at: campaign.starts_at ?? null,
    ends_at: campaign.ends_at ?? null,
    source_key: `campaign:${campaign.id}:user:${client.id}`,
    is_read: false,
    dismissed_at: null,
  }))

  if (rows.length === 0) return 0

  const { error } = await auth.admin
    .from("customer_notifications")
    .upsert(rows, { onConflict: "source_key" })

  if (error) throw error

  return rows.length
}

async function syncPublishedNotifications(
  auth: Exclude<Awaited<ReturnType<typeof requireInternalUser>>, { error: Response }>,
  campaign: Pick<
    SupabaseCustomerNotificationCampaign,
    "id" | "type" | "title" | "body" | "action_url" | "target_items" | "starts_at" | "ends_at"
  >,
) {
  const { error } = await auth.admin
    .from("customer_notifications")
    .update({
      type: campaign.type,
      title: campaign.title,
      body: campaign.body,
      action_url: campaign.action_url,
      target_items: campaign.target_items ?? [],
      starts_at: campaign.starts_at ?? null,
      ends_at: campaign.ends_at ?? null,
    })
    .like("source_key", `campaign:${campaign.id}:%`)

  if (error) throw error
}

async function writeAudit(
  auth: Exclude<Awaited<ReturnType<typeof requireInternalUser>>, { error: Response }>,
  action: "INSERT" | "UPDATE" | "DELETE",
  recordId: string,
  beforeData: unknown,
  afterData: unknown,
) {
  await auth.admin.from("audit_logs").insert({
    table_name: "customer_notification_campaigns",
    action,
    record_id: recordId,
    actor_user_id: auth.user.id,
    actor_email: auth.user.email ?? auth.profile.email,
    before_data: beforeData,
    after_data: afterData,
  })
}

export async function GET(request: Request) {
  const auth = await requireInternalUser(request, [...MANAGE_ROLES])
  if ("error" in auth) return auth.error

  const { data, error } = await auth.admin
    .from("customer_notification_campaigns")
    .select("id, type, title, body, action_url, target_scope, target_items, starts_at, ends_at, status, created_by, updated_by, published_at, created_at, updated_at")
    .order("updated_at", { ascending: false })
    .limit(80)

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  return Response.json({ campaigns: data ?? [] })
}

export async function POST(request: Request) {
  const auth = await requireInternalUser(request, [...MANAGE_ROLES])
  if ("error" in auth) return auth.error

  const body = (await request.json()) as {
    type?: unknown
    title?: unknown
    body?: unknown
    action_url?: unknown
    target_scope?: unknown
    target_items?: unknown
    starts_at?: unknown
    ends_at?: unknown
    publish?: unknown
  }
  const type = normalizeType(body.type)
  const title = normalizeText(body.title)
  const message = normalizeText(body.body)
  const actionUrl = normalizeNullableUrl(body.action_url)
  const targetScope = normalizeTargetScope(body.target_scope)
  const targetItems = normalizeTargetItems(body.target_items)
  const startsAt = normalizeDate(body.starts_at)
  const endsAt = normalizeDate(body.ends_at)
  const shouldPublish = body.publish === true

  if (!type || title.length < 3 || message.length < 8 || actionUrl === "" || startsAt === "" || endsAt === "") {
    return Response.json(
      { error: "Completá tipo, título, mensaje y un enlace válido." },
      { status: 400 },
    )
  }

  if (startsAt && endsAt && new Date(startsAt).getTime() >= new Date(endsAt).getTime()) {
    return Response.json(
      { error: "La fecha Hasta tiene que ser posterior a Desde." },
      { status: 400 },
    )
  }

  const payload = {
    type,
    title,
    body: message,
    action_url: actionUrl,
    target_scope: targetScope,
    target_items: targetItems,
    starts_at: startsAt,
    ends_at: endsAt,
    status: shouldPublish ? "published" : "draft",
    created_by: auth.user.id,
    updated_by: auth.user.id,
    published_at: shouldPublish ? new Date().toISOString() : null,
  }

  const { data, error } = await auth.admin
    .from("customer_notification_campaigns")
    .insert(payload)
    .select("id, type, title, body, action_url, target_scope, target_items, starts_at, ends_at, status, created_by, updated_by, published_at, created_at, updated_at")
    .single()

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  let publishedCount = 0

  if (shouldPublish) {
    try {
      publishedCount = await publishCampaign(auth, data)
    } catch (publishError) {
      return Response.json(
        {
          error:
            publishError instanceof Error
              ? publishError.message
              : "No se pudo publicar la notificación.",
        },
        { status: 500 },
      )
    }
  }

  await writeAudit(auth, "INSERT", data.id, null, data)

  return Response.json({ campaign: data, publishedCount })
}

export async function PATCH(request: Request) {
  const auth = await requireInternalUser(request, [...MANAGE_ROLES])
  if ("error" in auth) return auth.error

  const body = (await request.json()) as {
    id?: unknown
    type?: unknown
    title?: unknown
    body?: unknown
    action_url?: unknown
    target_scope?: unknown
    target_items?: unknown
    starts_at?: unknown
    ends_at?: unknown
    publish?: unknown
  }
  const id = normalizeText(body.id)
  const type = normalizeType(body.type)
  const title = normalizeText(body.title)
  const message = normalizeText(body.body)
  const actionUrl = normalizeNullableUrl(body.action_url)
  const targetScope = normalizeTargetScope(body.target_scope)
  const targetItems = normalizeTargetItems(body.target_items)
  const startsAt = normalizeDate(body.starts_at)
  const endsAt = normalizeDate(body.ends_at)
  const shouldPublish = body.publish === true

  if (!id || !type || title.length < 3 || message.length < 8 || actionUrl === "" || startsAt === "" || endsAt === "") {
    return Response.json(
      { error: "Faltan datos para actualizar la notificación." },
      { status: 400 },
    )
  }

  if (startsAt && endsAt && new Date(startsAt).getTime() >= new Date(endsAt).getTime()) {
    return Response.json(
      { error: "La fecha Hasta tiene que ser posterior a Desde." },
      { status: 400 },
    )
  }

  const before = await auth.admin
    .from("customer_notification_campaigns")
    .select("id, type, title, body, action_url, target_scope, target_items, starts_at, ends_at, status, created_by, updated_by, published_at, created_at, updated_at")
    .eq("id", id)
    .maybeSingle()

  if (before.error || !before.data) {
    return Response.json({ error: "Notificación no encontrada." }, { status: 404 })
  }

  const nextStatus = shouldPublish ? "published" : before.data.status
  const { data, error } = await auth.admin
    .from("customer_notification_campaigns")
    .update({
      type,
      title,
      body: message,
      action_url: actionUrl,
      target_scope: targetScope,
      target_items: targetItems,
      starts_at: startsAt,
      ends_at: endsAt,
      status: nextStatus,
      updated_by: auth.user.id,
      published_at:
        shouldPublish && !before.data.published_at
          ? new Date().toISOString()
          : before.data.published_at,
    })
    .eq("id", id)
    .select("id, type, title, body, action_url, target_scope, target_items, starts_at, ends_at, status, created_by, updated_by, published_at, created_at, updated_at")
    .single()

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  let publishedCount = 0

  try {
    if (shouldPublish) {
      publishedCount = await publishCampaign(auth, data)
    } else if (data.status === "published") {
      await syncPublishedNotifications(auth, data)
    }
  } catch (publishError) {
    return Response.json(
      {
        error:
          publishError instanceof Error
            ? publishError.message
            : "No se pudo sincronizar la notificación.",
      },
      { status: 500 },
    )
  }

  await writeAudit(auth, "UPDATE", id, before.data, data)

  return Response.json({ campaign: data, publishedCount })
}

export async function DELETE(request: Request) {
  const auth = await requireInternalUser(request, [...MANAGE_ROLES])
  if ("error" in auth) return auth.error

  const { searchParams } = new URL(request.url)
  const id = normalizeText(searchParams.get("id"))

  if (!id) {
    return Response.json({ error: "Falta la notificación a eliminar." }, { status: 400 })
  }

  const before = await auth.admin
    .from("customer_notification_campaigns")
    .select("id, type, title, body, action_url, target_scope, target_items, starts_at, ends_at, status, created_by, updated_by, published_at, created_at, updated_at")
    .eq("id", id)
    .maybeSingle()

  if (before.error || !before.data) {
    return Response.json({ error: "Notificación no encontrada." }, { status: 404 })
  }

  const deleteNotifications = await auth.admin
    .from("customer_notifications")
    .delete()
    .like("source_key", `campaign:${id}:%`)

  if (deleteNotifications.error) {
    return Response.json(
      { error: deleteNotifications.error.message },
      { status: 500 },
    )
  }

  const { error } = await auth.admin
    .from("customer_notification_campaigns")
    .delete()
    .eq("id", id)

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  await writeAudit(auth, "DELETE", id, before.data, null)

  return Response.json({ ok: true })
}
