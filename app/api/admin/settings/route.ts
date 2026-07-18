import { requireInternalUser } from "@/lib/auth/admin-api"
import {
  getSiteSettings,
  normalizeShippingSettings,
} from "@/lib/site-settings"

const MANAGE_ROLES = ["admin", "super_admin"] as const

export async function GET(request: Request) {
  const auth = await requireInternalUser(request, [...MANAGE_ROLES])
  if ("error" in auth) return auth.error

  const settings = await getSiteSettings()

  return Response.json({ settings })
}

export async function PATCH(request: Request) {
  const auth = await requireInternalUser(request, [...MANAGE_ROLES])
  if ("error" in auth) return auth.error

  const body = (await request.json()) as {
    shipping?: unknown
  }
  const before = await getSiteSettings()
  const shipping = normalizeShippingSettings(body.shipping)
  const updatedAt = new Date().toISOString()

  const { data, error } = await auth.admin
    .from("site_settings")
    .upsert(
      {
        key: "shipping",
        value: shipping,
        description: "Configuracion de costos y bonificacion de envio.",
        updated_by: auth.user.id,
        updated_at: updatedAt,
      },
      { onConflict: "key" },
    )
    .select("key, value, updated_at")
    .single()

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  await auth.admin.from("audit_logs").insert({
    table_name: "site_settings",
    action: "UPDATE",
    record_id: "shipping",
    actor_user_id: auth.user.id,
    actor_email: auth.user.email ?? auth.profile.email,
    before_data: before,
    after_data: { shipping, updated_at: data.updated_at },
  })

  return Response.json({
    settings: {
      shipping,
    },
  })
}
