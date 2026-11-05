import { requireOperator } from "@/app/api/admin/clientes/_auth"
import { orderCode } from "@/lib/admin/dispatch"
import { sendLocalDeliveryOutcomeEmail } from "@/lib/orders/local-delivery-outcome-emails"
import { getLocalDeliverySettings } from "@/lib/shipping/local-delivery-settings"

// Recibir devolución local (picking inverso): el operador escanea cada BX-PKG
// que trae el cadete. Recién con TODOS los bultos del intento que salió el
// pedido queda "Devuelto a BEYONIX" y empieza la reserva (días de la
// configuración vigente, congelados en la reserva). Retorno logístico de
// Envío BEYONIX: nada de Andreani ni de devoluciones comerciales.

const ERRORS: Record<string, { status: number; message: string }> = {
  DISPATCH_LABEL_CODE_INVALID: { status: 400, message: "Escaneá el código BX-PKG del bulto." },
  DISPATCH_LOCAL_PARCEL_CODE_REQUIRED: { status: 409, message: "Ese código no es un bulto BX-PKG. Escaneá la etiqueta de envío." },
  DISPATCH_PARCEL_UNKNOWN: { status: 404, message: "No encontramos ese bulto BX-PKG." },
  DISPATCH_LOCAL_DELIVERY_ONLY: { status: 409, message: "Ese bulto no es de un pedido con Envío BEYONIX." },
  DISPATCH_PARCEL_STALE: { status: 409, message: "Ese bulto es de un armado anterior del pedido." },
  LOCAL_DELIVERY_RESERVATION_DAYS_INVALID: { status: 409, message: "Revisá los días de reserva por devolución en Configuración → Envío BEYONIX." },
}

export async function POST(request: Request) {
  const auth = await requireOperator(request)
  if ("error" in auth) return auth.error

  const body = await request.json().catch(() => null) as { code?: unknown } | null
  const code = typeof body?.code === "string" ? body.code.trim() : ""
  if (!code || code.length > 128) return Response.json({ error: ERRORS.DISPATCH_LABEL_CODE_INVALID.message }, { status: 400 })

  let reservationDays: number
  try {
    reservationDays = (await getLocalDeliverySettings(auth.admin)).returnReservationDays
  } catch {
    return Response.json({ error: "No se pudo leer la configuración de Envío BEYONIX." }, { status: 503 })
  }

  const { data, error } = await auth.admin.rpc("receive_local_delivery_return_parcel", {
    p_code: code, p_actor_id: auth.user.id, p_reservation_days: reservationDays,
  })
  if (error) {
    const message = error.message ?? ""
    if (message.includes("LOCAL_DELIVERY_RETURN_NOT_EXPECTED")) {
      const orderId = Number(error.details)
      const label = Number.isSafeInteger(orderId) && orderId > 0 ? `${orderCode(orderId)} no` : "Ese pedido no"
      return Response.json({ error: `${label} está regresando a BEYONIX: no se puede recibir como devolución local.` }, { status: 409 })
    }
    const known = Object.entries(ERRORS).find(([key]) => message.includes(key))?.[1]
    return Response.json({ error: known?.message ?? "No se pudo registrar el bulto." }, { status: known?.status ?? 500 })
  }
  const result = data as {
    orderId: number; code: string; parcelIndex: number; parcelCount: number; received: number
    complete: boolean; completedNow: boolean; duplicate: boolean; reservationExpiresAt: string | null
  }
  if (result.completedNow) {
    // Aviso al cliente (best effort): la recepción ya quedó registrada.
    await sendLocalDeliveryOutcomeEmail(auth.admin, result.orderId, "returned", result.reservationExpiresAt)
  }
  return Response.json({ ok: true, ...result }, { headers: { "Cache-Control": "no-store" } })
}
