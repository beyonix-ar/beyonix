import "server-only"

import { renderBeyonixEmail } from "../email/beyonix-email-layout.ts"
import { sendOrderStatusEmail } from "../email/send-order-status-email.ts"
import { isLocalDeliveryOrder } from "../shipping/local-delivery.ts"
import { resolveConfiguredSiteUrl } from "../site-url.ts"

export function getOrderCode(orderId: number) {
  return `BX-${1000 + orderId}`
}

interface OrderForStatusEmail {
  id: number
  estado?: string | null
  cliente_email?: string | null
  cliente_nombre?: string | null
  tracking_number?: string | null
  tracking_url?: string | null
  shipping_provider?: string | null
  envio_proveedor?: string | null
}

/** Hitos de envío con email propio (uno por hito: nunca dos "enviado" seguidos). */
const SHIPPING_MILESTONE_EMAILS: Record<string, { subject: string; title: string; body: string; icon: number }> = {
  enviado: { subject: "Pedido despachado", title: "Pedido despachado", body: "ya fue despachado", icon: 0x1F4E6 },
  en_camino: { subject: "Pedido en camino", title: "Tu pedido está en camino", body: "está en camino", icon: 0x1F69A },
  en_sucursal: {
    subject: "Pedido en sucursal",
    title: "Tu pedido llegó a la sucursal",
    body: "ya está disponible para retirar en la sucursal",
    icon: 0x1F3EC,
  },
}

/**
 * Único punto que arma y envía el email de cambio de estado visible al
 * cliente (enviado, en_camino, en_sucursal, entregado, cancelado).
 * Compartido entre el cambio manual (admin) y la sincronización automática
 * de tracking Andreani -- ambos caminos deben mandar exactamente el mismo
 * email, una sola vez por transición real. Devuelve `true` sólo si el email
 * se envió (false si la transición no tiene email o el envío falló).
 */
export async function sendOrderStateEmail(order: OrderForStatusEmail): Promise<boolean> {
  const orderCode = getOrderCode(order.id)
  const base = {
    greetingName: order.cliente_nombre,
    orderCode,
    action: getOrderDetailAction(order.id),
  }

  // Envío BEYONIX: lo entrega BEYONIX, sin guía ni seguimiento externo.
  const localDelivery = isLocalDeliveryOrder(order)
  const milestone = SHIPPING_MILESTONE_EMAILS[order.estado ?? ""]
  if (milestone) {
    const trackingNumber = !localDelivery ? order.tracking_number?.trim() : ""
    return sendOrderStatusEmail({
      to: order.cliente_email,
      subject: `${milestone.subject} ${orderCode}`,
      html: renderBeyonixEmail({
        ...base,
        title: milestone.title,
        preheader: `Tu pedido ${orderCode} ${milestone.body}.`,
        icon: milestone.icon,
        paragraphs: [`Tu pedido ${orderCode} ${milestone.body}.`],
        details: trackingNumber ? [{ label: "Seguimiento", value: trackingNumber }] : [],
        secondaryLink: !localDelivery && order.tracking_url ? { label: "Ver seguimiento", url: order.tracking_url } : null,
      }),
    })
  }

  if (order.estado === "entregado") {
    const delivered = localDelivery ? `Tu pedido ${orderCode} fue entregado.` : `Tu pedido ${orderCode} figura como entregado.`
    return sendOrderStatusEmail({
      to: order.cliente_email,
      subject: `Pedido entregado ${orderCode}`,
      html: renderBeyonixEmail({
        ...base,
        title: "Pedido entregado",
        preheader: delivered,
        icon: 0x2705,
        paragraphs: [delivered, "¡Gracias por comprar en BEYONIX!"],
        note: "Si necesitás ayuda con la compra, podés iniciar un reclamo desde tu cuenta.",
      }),
    })
  }

  if (order.estado === "cancelado") {
    return sendOrderStatusEmail({
      to: order.cliente_email,
      subject: `Compra cancelada ${orderCode}`,
      html: renderBeyonixEmail({
        ...base,
        title: "Compra cancelada",
        preheader: `Tu pedido ${orderCode} fue cancelado.`,
        icon: 0x1F4CB,
        paragraphs: [`Tu pedido ${orderCode} fue cancelado.`],
        note: "Te avisaremos cualquier novedad adicional desde tu cuenta y por email.",
      }),
    })
  }

  return false
}

/** "Ver mi pedido" → detalle de la compra en la cuenta. Sin URL pública configurada, el email sale sin botón. */
function getOrderDetailAction(orderId: number) {
  const siteUrl = resolveConfiguredSiteUrl()
  return siteUrl ? { label: "Ver mi pedido", url: `${siteUrl}/cuenta/compras/${orderId}` } : null
}
