import "server-only"

import { sendOrderStatusEmail } from "@/lib/email/send-order-status-email"
import type { LocalDeliveryAdminClient } from "@/lib/orders/local-delivery-deps"
import { getOrderCode } from "@/lib/orders/order-status-notifications"
import { formatLocalDeliveryDay } from "@/lib/shipping/local-delivery-outcome"

export type LocalDeliveryOutcomeEmailKind = "first_attempt_failed" | "returning" | "returned"

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character)

const NEW_SHIPMENT = "Para coordinar un nuevo envío, deberás abonar nuevamente el costo de entrega correspondiente."

/**
 * Aviso por email del resultado de la entrega local. Mismo canal que el resto
 * de los avisos de estado. Best effort: sólo lo llama quien GANÓ la transición
 * (la base informa `changed`/`completedNow` una única vez), así que no se
 * duplica; si falla, el cliente igual lo ve en Mis compras (fuente principal)
 * y queda registrado en el historial del pedido.
 */
export async function sendLocalDeliveryOutcomeEmail(
  admin: LocalDeliveryAdminClient,
  orderId: number,
  kind: LocalDeliveryOutcomeEmailKind,
  reservationExpiresAt: string | null = null,
) {
  try {
    const { data } = await admin.from("ordenes").select("cliente_email,cliente_nombre").eq("id", orderId).maybeSingle()
    const order = data as { cliente_email: string | null; cliente_nombre: string | null } | null
    if (!order?.cliente_email) return false
    const code = getOrderCode(orderId)
    const greeting = `<p>Hola ${escapeHtml(order.cliente_nombre ?? "")}:</p>`
    const content = kind === "first_attempt_failed"
      ? {
          subject: `No pudimos entregar tu pedido ${code}`,
          html: `<h1>Intento de entrega fallido</h1>${greeting}
            <p>El cadete visitó tu domicilio, pero no pudo concretar la entrega de tu pedido ${code} porque no había nadie presente.</p>
            <p>Realizaremos un segundo intento de entrega.</p>
            <p>Si en el segundo intento tampoco podemos completar la entrega, el pedido regresará a BEYONIX y, para coordinar un nuevo envío, deberás abonar nuevamente el costo de entrega correspondiente.</p>`,
        }
      : kind === "returning"
        ? {
            subject: `Tu pedido ${code} regresará a BEYONIX`,
            html: `<h1>Regresando a BEYONIX</h1>${greeting}
              <p>Realizamos un segundo intento de entrega y nuevamente no pudimos encontrar a nadie en el domicilio.</p>
              <p>El pedido ${code} regresará a BEYONIX.</p><p>${NEW_SHIPMENT}</p>`,
          }
        : {
            subject: `Tu pedido ${code} regresó a BEYONIX`,
            html: `<h1>Tu pedido regresó a BEYONIX</h1>${greeting}
              ${reservationExpiresAt
                ? `<p>Mantendremos tus productos reservados hasta el ${formatLocalDeliveryDay(reservationExpiresAt)}.</p>
                   <p>Para solicitar un nuevo envío, contactanos desde Mis compras antes de esa fecha. El nuevo envío tendrá costo.</p>`
                : "<p>Contactanos desde Mis compras para coordinar los próximos pasos.</p>"}`,
          }
    return await sendOrderStatusEmail({ to: order.cliente_email, ...content })
  } catch {
    console.error("LOCAL_DELIVERY_OUTCOME_EMAIL_FAILED", { orderId, kind })
    return false
  }
}
