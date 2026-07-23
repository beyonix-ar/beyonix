import { requireInternalUser } from "@/lib/auth/admin-api"
import {
  getSiteSettings,
  normalizeCustomerCreditPaymentSettings,
  normalizeShippingSettings,
  normalizeStockSettings,
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
    customerCreditPayments?: unknown
    stock?: unknown
  }
  const before = await getSiteSettings()
  const shipping = normalizeShippingSettings(body.shipping)
  const customerCreditPayments = normalizeCustomerCreditPaymentSettings(
    body.customerCreditPayments,
  )
  const stock = normalizeStockSettings(body.stock)
  const updatedAt = new Date().toISOString()

  const { error } = await auth.admin
    .from("site_settings")
    .upsert(
      [
        {
          key: "shipping",
          value: shipping,
          description: "Configuración de costos y bonificación de envío.",
          updated_by: auth.user.id,
          updated_at: updatedAt,
        },
        {
          key: "stock",
          value: stock,
          description: "Umbrales de color para el estado del stock.",
          updated_by: auth.user.id,
          updated_at: updatedAt,
        },
        {
          key: "customer_credit_payments",
          value: customerCreditPayments,
          description: "Configuración de medios de pago para cargas de saldo.",
          updated_by: auth.user.id,
          updated_at: updatedAt,
        },
      ],
      { onConflict: "key" },
    )
    .select("key, value, updated_at")

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
    after_data: { shipping, customerCreditPayments, stock, updated_at: updatedAt },
  })

  return Response.json({
    settings: {
      shipping,
      customerCreditPayments,
      stock,
    },
  })
}
