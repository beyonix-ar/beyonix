export type StoreBenefitType = "gift_card" | "discount"

export interface StoreBenefitRow {
  id: string
  user_id: string
  benefit_type: StoreBenefitType
  code: string
  percent: number
  status: "active" | "used" | "cancelled"
}

export function getStoreBenefitTypeFromRefundMethod(
  method: string,
): StoreBenefitType | null {
  const normalized = method.trim().toLowerCase()

  if (normalized === "gift card") return "gift_card"
  if (normalized === "descuento") return "discount"

  return null
}

export function getStoreBenefitLabel(type: StoreBenefitType) {
  return type === "gift_card" ? "Gift card" : "Descuento"
}

export function parseStoreBenefitPercent(value: unknown) {
  if (typeof value !== "string" && typeof value !== "number") return null

  const parsed = Number(String(value).replace(",", ".").trim())
  if (!Number.isFinite(parsed)) return null

  const percent = Math.trunc(parsed)
  return percent >= 1 && percent <= 100 ? percent : null
}

export function calculateStoreBenefitDiscount(
  productsTotal: number,
  percent?: number | null,
) {
  if (!percent || percent < 1) return 0

  return Math.min(
    Math.round(Math.max(productsTotal, 0) * (percent / 100)),
    Math.max(productsTotal, 0),
  )
}

export function buildStoreBenefitCode({
  orderId,
  type,
}: {
  orderId: number
  type: StoreBenefitType
}) {
  const prefix = type === "gift_card" ? "GIFT" : "DESC"
  const suffix = Math.random().toString(36).slice(2, 8).toUpperCase()

  return `BX-${prefix}-${1000 + orderId}-${suffix}`
}

export async function findActiveStoreBenefit(
  admin: any,
  userId: string,
  benefitId?: string | null,
): Promise<StoreBenefitRow | null> {
  if (!benefitId) return null

  const { data, error } = await admin
    .from("customer_store_benefits")
    .select("id, user_id, benefit_type, code, percent, status")
    .eq("id", benefitId)
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle()

  if (error) {
    throw new Error("No se pudo validar el beneficio seleccionado.")
  }

  return data ?? null
}

export async function markStoreBenefitAsUsed(
  admin: any,
  {
    benefitId,
    orderId,
  }: {
    benefitId: string
    orderId: number
  },
) {
  const { data, error } = await admin
    .from("customer_store_benefits")
    .update({
      status: "used",
      used_order_id: orderId,
      used_at: new Date().toISOString(),
    })
    .eq("id", benefitId)
    .eq("status", "active")
    .select("id")
    .maybeSingle()

  if (error || !data) {
    throw new Error("No se pudo marcar el beneficio como usado.")
  }
}
