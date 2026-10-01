import {
  getInterestFreeInstallments,
  normalizeInstallmentsAmount,
} from "@/lib/mercadopago/interest-free-installments"
import { applyInterestFreePolicy } from "@/lib/mercadopago/interest-free-policy"
import { getSiteSettings } from "@/lib/site-settings"

/** Montos distintos por pedido: una grilla de catálogo entra en una sola llamada. */
const MAX_AMOUNTS_PER_REQUEST = 48

/**
 * Cuotas sin interés confirmadas por Mercado Pago para cada monto pedido.
 * `null` = no se pudo confirmar (el cliente no debe prometer "sin interés").
 * Sólo lectura: nunca expone credenciales ni datos de Mercado Pago más allá
 * de qué cuotas (2/3/6) están confirmadas.
 *
 * Cada monto es el TOTAL que se cobraría: sobre lo que confirma Mercado Pago
 * rige la política propia de BEYONIX (cuotas sin interés ON/OFF y mínimos por
 * rango, Admin → Financiación). En OFF no se confirma ninguna cuota ni se
 * consulta a Mercado Pago: la tienda no comunica "sin interés".
 */
export async function GET(request: Request) {
  const raw = new URL(request.url).searchParams.get("amounts") ?? ""
  const amounts = [
    ...new Set(
      raw
        .split(",")
        .map((value) => normalizeInstallmentsAmount(value))
        .filter((amount): amount is number => amount !== null),
    ),
  ]

  if (amounts.length === 0 || amounts.length > MAX_AMOUNTS_PER_REQUEST) {
    return Response.json({ error: "Montos inválidos." }, { status: 400 })
  }

  const { interestFreePolicy } = await getSiteSettings()
  const entries = await Promise.all(
    amounts.map(async (amount) => {
      if (!interestFreePolicy.enabled) return [String(amount), []] as const
      const result = await getInterestFreeInstallments(amount)
      return [
        String(amount),
        result.status === "confirmed"
          ? applyInterestFreePolicy(result.counts, amount, interestFreePolicy)
          : null,
      ] as const
    }),
  )

  return Response.json(
    { interestFree: Object.fromEntries(entries) },
    // Igual para todos los visitantes; caché corta para no repetir consultas.
    { headers: { "Cache-Control": "public, max-age=120" } },
  )
}
