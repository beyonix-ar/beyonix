import { requireInternalUser } from "@/lib/auth/admin-api"
import {
  getSiteSettings,
  invalidateSiteSettingsCache,
  normalizeSiteSettingsPatch,
} from "@/lib/site-settings"

const MANAGE_ROLES = ["admin", "super_admin"] as const

export async function GET(request: Request) {
  const auth = await requireInternalUser(request, [...MANAGE_ROLES])
  if ("error" in auth) return auth.error

  const settings = await getSiteSettings({ fresh: true })

  return Response.json({ settings })
}

export async function PATCH(request: Request) {
  const auth = await requireInternalUser(request, [...MANAGE_ROLES])
  if ("error" in auth) return auth.error

  let changes: ReturnType<typeof normalizeSiteSettingsPatch>
  try {
    changes = normalizeSiteSettingsPatch(await request.json())
  } catch {
    return Response.json({ error: "La configuración no es válida." }, { status: 400 })
  }
  const before = await getSiteSettings({ fresh: true })
  const updatedAt = new Date().toISOString()
  const { error } = await auth.admin.from("site_settings").upsert(
    changes.map(({ key, value }) => ({
      key, value, updated_by: auth.user.id, updated_at: updatedAt,
    })),
    { onConflict: "key" },
  )

  if (error) {
    return Response.json({ error: "No se pudo guardar la configuración." }, { status: 500 })
  }

  invalidateSiteSettingsCache()

  const { error: auditError } = await auth.admin.from("audit_logs").insert({
    table_name: "site_settings",
    action: "UPDATE",
    record_id: changes.map(({ key }) => key).join(","),
    actor_user_id: auth.user.id,
    actor_email: auth.user.email ?? auth.profile.email,
    before_data: Object.fromEntries(changes.map(({ field }) => [field, before[field]])),
    after_data: Object.fromEntries(changes.map(({ field, value }) => [field, value])),
  })
  if (auditError) {
    console.error("SITE_SETTINGS_AUDIT_FAILED", { code: auditError.code })
  }

  return Response.json({ settings: await getSiteSettings({ fresh: true }) })
}
