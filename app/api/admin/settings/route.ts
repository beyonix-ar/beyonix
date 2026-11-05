import { requireInternalUser } from "@/lib/auth/admin-api"
import { normalizeFinancedPricePolicy } from "@/lib/pricing/financed-price-policy"
import {
  getMercadoPagoCostsOverview,
  getSiteSettings,
  invalidateSiteSettingsCache,
  loadFinancingPolicyEvents,
  normalizeSiteSettingsPatch,
} from "@/lib/site-settings"
import {
  getShippingQuoteSettings,
  parseShippingQuoteSettingsPatch,
  SHIPPING_QUOTE_SETTINGS_KEY,
  type ShippingQuoteSettings,
} from "@/lib/shipping/shipping-quote-settings"
import {
  LOCAL_DELIVERY_SETTINGS_KEY,
  LocalDeliverySettingsError,
  parseLocalDeliverySettingsPatch,
  type LocalDeliverySettings,
} from "@/lib/shipping/local-delivery"
import { getLocalDeliverySettings } from "@/lib/shipping/local-delivery-settings"

const MANAGE_ROLES = ["admin", "super_admin"] as const

// El recargo logístico ("Cotización de envíos") se lee y guarda aparte de
// SiteSettings: esa configuración se publica en /api/store/settings y el
// porcentaje es un dato interno. Lo mismo Envío BEYONIX: el costo interno de
// cada entrega nunca forma parte de la configuración pública.
async function loadAdminSettings() {
  const [settings, mercadoPagoCosts, shippingQuote, localDelivery] = await Promise.all([
    getSiteSettings({ fresh: true }),
    getMercadoPagoCostsOverview(),
    getShippingQuoteSettings(),
    getLocalDeliverySettings(),
  ])
  return { settings, mercadoPagoCosts, shippingQuote, localDelivery }
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
  let shippingQuoteChange: ShippingQuoteSettings | null = null
  let localDeliveryChange: LocalDeliverySettings | null = null
  let localDeliveryKeepsReservationDays = false
  try {
    const body: unknown = await request.json()
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid")
    const { shippingQuote, localDelivery, ...rest } = body as Record<string, unknown>
    if (shippingQuote !== undefined) shippingQuoteChange = parseShippingQuoteSettingsPatch(shippingQuote)
    if (localDelivery !== undefined) {
      localDeliveryChange = parseLocalDeliverySettingsPatch(localDelivery)
      // Un cliente de Admin anterior no envía los días de reserva: se conserva lo guardado.
      localDeliveryKeepsReservationDays = !Object.hasOwn(localDelivery as object, "returnReservationDays")
    }
    changes = Object.keys(rest).length || (!shippingQuoteChange && !localDeliveryChange) ? normalizeSiteSettingsPatch(rest) : []
  } catch (error) {
    const message = error instanceof Error &&
      (error.name === "ShippingMarkupError" || error instanceof LocalDeliverySettingsError)
      ? error.message
      : "La configuración no es válida."
    return Response.json({ error: message }, { status: 400 })
  }
  const [before, shippingQuoteBefore, localDeliveryBefore] = await Promise.all([
    getSiteSettings({ fresh: true }),
    getShippingQuoteSettings(),
    localDeliveryChange ? getLocalDeliverySettings() : Promise.resolve(null),
  ])
  if (localDeliveryChange && localDeliveryBefore && localDeliveryKeepsReservationDays) {
    localDeliveryChange = { ...localDeliveryChange, returnReservationDays: localDeliveryBefore.returnReservationDays }
  }

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
  const otherChanges: Array<{ key: string; value: unknown }> = changes.filter(({ field }) => field !== "financedPricePolicy")
  if (shippingQuoteChange) otherChanges.push({ key: SHIPPING_QUOTE_SETTINGS_KEY, value: shippingQuoteChange })
  if (localDeliveryChange) otherChanges.push({ key: LOCAL_DELIVERY_SETTINGS_KEY, value: localDeliveryChange })
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
    record_id: [
      ...changes.map(({ key }) => key),
      ...(shippingQuoteChange ? [SHIPPING_QUOTE_SETTINGS_KEY] : []),
      ...(localDeliveryChange ? [LOCAL_DELIVERY_SETTINGS_KEY] : []),
    ].join(","),
    actor_user_id: auth.user.id,
    actor_email: auth.user.email ?? auth.profile.email,
    before_data: {
      ...Object.fromEntries(changes.map(({ field }) => [field, before[field]])),
      ...(shippingQuoteChange ? { shippingQuote: shippingQuoteBefore } : {}),
      ...(localDeliveryChange ? { localDelivery: localDeliveryBefore } : {}),
    },
    after_data: {
      ...Object.fromEntries(changes.map(({ field, value }) => [field, value])),
      ...(shippingQuoteChange ? { shippingQuote: shippingQuoteChange } : {}),
      ...(localDeliveryChange ? { localDelivery: localDeliveryChange } : {}),
    },
  })
  if (auditError) {
    console.error("SITE_SETTINGS_AUDIT_FAILED", { code: auditError.code })
  }

  return Response.json(await loadAdminSettings())
}
