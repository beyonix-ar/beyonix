import {
  getInterestFreeInstallments,
  normalizeInstallmentsAmount,
} from "@/lib/mercadopago/interest-free-installments"
import { getSiteSettings } from "@/lib/site-settings"

/** Montos distintos por pedido (el checkout consulta unos pocos totales). */
const MAX_AMOUNTS_PER_REQUEST = 48

/**
 * Cuotas sin interés confirmadas por Mercado Pago para cada monto pedido, y
 * con qué marcas de referencia (Visa/Mastercard) aplica cada una.
 * `null` = no se pudo confirmar (el cliente no debe prometer "sin interés").
 * Sólo lectura: nunca expone credenciales ni datos de Mercado Pago más allá
 * de qué cuotas (2/3/6) están confirmadas y para qué marcas.
 *
 * Cada monto es el TOTAL que se cobraría. BEYONIX ofrece exactamente lo que
 * confirma Mercado Pago (máximo 6), sin mínimos propios. Con cuotas sin
 * interés desactivadas (Admin → Financiación) no se confirma ninguna cuota ni
 * se consulta a Mercado Pago.
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
      if (!interestFreePolicy.enabled) return { key: String(amount), counts: [], brands: {} }
      const result = await getInterestFreeInstallments(amount)
      return result.status === "confirmed"
        ? { key: String(amount), counts: result.counts, brands: result.brandsByCount ?? {} }
        : { key: String(amount), counts: null, brands: {} }
    }),
  )

  return Response.json(
    {
      interestFree: Object.fromEntries(entries.map(({ key, counts }) => [key, counts])),
      brands: Object.fromEntries(entries.map(({ key, brands }) => [key, brands])),
    },
    // Igual para todos los visitantes; caché corta (el checkout tiene que
    // ser prácticamente en tiempo real y la preferencia revalida fresco).
    { headers: { "Cache-Control": "public, max-age=30" } },
  )
}
