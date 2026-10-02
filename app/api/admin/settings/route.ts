import { requireInternalUser } from "@/lib/auth/admin-api"
import { normalizeFinancedPricePolicy } from "@/lib/pricing/financed-price-policy"
import {
  getMercadoPagoCostsOverview,
  getSiteSettings,
  invalidateSiteSettingsCache,
  loadFinancingPolicyEvents,
  normalizeSiteSettingsPatch,
} from "@/lib/site-settings"

const MANAGE_ROLES = ["admin", "super_admin"] as const

async function loadAdminSettings() {
  const [settings, mercadoPagoCosts] = await Promise.all([
    getSiteSettings({ fresh: true }),
    getMercadoPagoCostsOverview(),
  ])
  return { settings, mercadoPagoCosts }
}

export async function GET(request: Request) {
  const auth = await requireInternalUser(request, [...MANAGE_ROLES])
  if ("error" in auth) return auth.error

  return Response.json(await loadAdminSettings())
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

  // Política de precio financiado: mientras un evento de financiación la
  // controla, no se cambia a mano (nunca se pisa en silencio la
  // programación). Para salir antes: Admin → Eventos → "Finalizar ahora".
  const policyChange = changes.find(({ field }) => field === "financedPricePolicy")
  if (policyChange) {
    const events = await loadFinancingPolicyEvents(auth.admin)
    if (events.error) {
      return Response.json({ error: "No se pudo verificar si hay un evento de financiación activo." }, { status: 503 })
    }
    const requested = normalizeFinancedPricePolicy(policyChange.value)
    if (events.controlling && requested !== before.financedPricePolicy) {
      return Response.json(
        {
          code: "FINANCING_POLICY_CONTROLLED_BY_EVENT",
          error: `La política está controlada por el evento "${events.controlling.name}". Finalizalo desde Eventos para cambiarla a mano.`,
        },
        { status: 409 },
      )
    }
  }

  const updatedAt = new Date().toISOString()
  if (policyChange) {
    const { error: policyError } = await auth.admin.rpc("set_financed_price_policy", {
      p_policy: normalizeFinancedPricePolicy(policyChange.value),
      p_actor: auth.user.id,
      p_now: updatedAt,
    })
    if (policyError) {
      const controlled = policyError.message.includes("FINANCING_POLICY_CONTROLLED_BY_EVENT")
      return Response.json({
        code: controlled ? "FINANCING_POLICY_CONTROLLED_BY_EVENT" : undefined,
        error: controlled ? "La política está controlada por un evento. Finalizalo desde Eventos antes de cambiarla." : "No se pudo guardar la política de financiación.",
      }, { status: controlled ? 409 : 500 })
    }
  }
  const otherChanges = changes.filter(({ field }) => field !== "financedPricePolicy")
  const { error } = otherChanges.length ? await auth.admin.from("site_settings").upsert(
    otherChanges.map(({ key, value }) => ({
      key, value, updated_by: auth.user.id, updated_at: updatedAt,
    })),
    { onConflict: "key" },
  ) : { error: null }

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

  return Response.json(await loadAdminSettings())
}
