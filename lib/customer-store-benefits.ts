export type StoreBenefitType = "discount"

export interface StoreBenefitRow {
  id: string
  user_id: string
  benefit_type: StoreBenefitType
  code: string
  percent: number
  status: "active" | "used" | "cancelled"
}

export function getStoreBenefitLabel() {
  return "Descuento"
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

/**
 * Reclama atómicamente el cupón (CAS `status='active' -> 'used'`) ANTES de
 * calcular el total y crear la orden -- reemplaza lo que antes era un
 * `SELECT` de sólo lectura (`findActiveStoreBenefit`). Con el `SELECT`,
 * dos requests concurrentes con el mismo `benefitId` (doble click, dos
 * pestañas) veían ambas `status='active'` y ambas creaban una orden con el
 * descuento aplicado -- sólo la primera lograba marcarlo usado al final
 * (`markStoreBenefitAsUsed`, ya tarde: la orden de la segunda ya existía
 * con el descuento adentro, y ese error no la revertía). Reclamarlo temprano
 * hace que la SEGUNDA request nunca vea el cupón como disponible, así que
 * nunca llega a crear una orden con el descuento indebido.
 *
 * `used_order_id` queda NULL hasta `linkStoreBenefitToOrder` (recién hay
 * una orden real después de crearla) -- ese NULL es la señal de "reclamado
 * pero todavía no vinculado a una orden", que `releaseStoreBenefitClaim`
 * usa para poder liberarlo si la creación de la orden falla después.
 *
 * `null` cuando no había un cupón activo para reclamar (id inválido, ya
 * usado, no es del usuario, o -- exactamente el caso que esto arregla --
 * alguien más lo reclamó un instante antes): mismo comportamiento que el
 * `null` anterior, la compra sigue sin el descuento, nunca es un error.
 */
export async function claimActiveStoreBenefit(
  admin: any,
  userId: string,
  benefitId?: string | null,
): Promise<StoreBenefitRow | null> {
  if (!benefitId) return null

  const { data, error } = await admin
    .from("customer_store_benefits")
    .update({ status: "used", used_at: new Date().toISOString() })
    .eq("id", benefitId)
    .eq("user_id", userId)
    .eq("benefit_type", "discount")
    .eq("status", "active")
    .select("id, user_id, benefit_type, code, percent, status")
    .maybeSingle()

  if (error) {
    throw new Error("No se pudo validar el beneficio seleccionado.")
  }

  return data ?? null
}

/**
 * Vincula el cupón ya reclamado (`claimActiveStoreBenefit`) a la orden real
 * recién creada. Sólo actualiza `used_order_id` -- `status` ya es 'used'
 * desde el claim, esto no repite esa transición.
 */
export async function linkStoreBenefitToOrder(
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
    .update({ used_order_id: orderId })
    .eq("id", benefitId)
    .eq("status", "used")
    .is("used_order_id", null)
    .select("id")
    .maybeSingle()

  if (error || !data) {
    throw new Error("No se pudo marcar el beneficio como usado.")
  }
}

/**
 * Libera un cupón reclamado (`claimActiveStoreBenefit`) cuando la creación
 * de la orden falla ANTES de llegar a `linkStoreBenefitToOrder` -- si no se
 * liberara, el cupón quedaría 'used' para siempre sin ninguna orden real
 * detrás. El guard `used_order_id is null` evita liberar por error un
 * cupón que ya se vinculó a una orden real (no debería poder pasar, pero
 * evita despertar un cupón ya usado si el orden de llamadas cambiara).
 * Best-effort a propósito: se llama desde catches de limpieza, nunca debe
 * tapar el error original si ella misma falla.
 */
export async function releaseStoreBenefitClaim(
  admin: any,
  benefitId: string,
) {
  await admin
    .from("customer_store_benefits")
    .update({ status: "active", used_at: null })
    .eq("id", benefitId)
    .eq("status", "used")
    .is("used_order_id", null)
}
