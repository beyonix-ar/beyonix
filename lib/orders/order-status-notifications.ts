import "server-only"

import { sendOrderStatusEmail } from "../email/send-order-status-email.ts"

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
}

/** Hitos de envío con email propio (uno por hito: nunca dos "enviado" seguidos). */
const SHIPPING_MILESTONE_EMAILS: Record<string, { subject: string; title: string; body: string }> = {
  enviado: { subject: "Pedido despachado", title: "Pedido despachado", body: "ya fue despachado" },
  en_camino: { subject: "Pedido en camino", title: "Tu pedido está en camino", body: "está en camino" },
  en_sucursal: {
    subject: "Pedido en sucursal",
    title: "Tu pedido llegó a la sucursal",
    body: "ya está disponible para retirar en la sucursal",
  },
}

/**
 * Único punto que arma y envía el email de cambio de estado visible al
 * cliente (enviado, en_camino, en_sucursal, entregado, cancelado).
 * Compartido entre el cambio manual (admin) y la sincronización automática
 * de tracking Andreani -- ambos caminos deben mandar exactamente el mismo
 * email, una sola vez por transición real.
 */
export async function sendOrderStateEmail(order: OrderForStatusEmail) {
  const orderCode = getOrderCode(order.id)

  const milestone = SHIPPING_MILESTONE_EMAILS[order.estado ?? ""]
  if (milestone) {
    await sendOrderStatusEmail({
      to: order.cliente_email,
      subject: `${milestone.subject} ${orderCode}`,
      html: `
        <h1>${milestone.title}</h1>
        <p>Hola ${order.cliente_nombre ?? ""}, tu pedido ${orderCode} ${milestone.body}.</p>
        ${order.tracking_number ? `<p>Seguimiento: ${order.tracking_number}</p>` : ""}
        ${order.tracking_url ? `<p><a href="${order.tracking_url}">Ver seguimiento</a></p>` : ""}
      `,
    })
    return
  }

  if (order.estado === "entregado") {
    await sendOrderStatusEmail({
      to: order.cliente_email,
      subject: `Pedido entregado ${orderCode}`,
      html: `
        <h1>Pedido entregado</h1>
        <p>Hola ${order.cliente_nombre ?? ""}, tu pedido ${orderCode} figura como entregado.</p>
        <p>Si necesitás ayuda con la compra, podés iniciar un reclamo desde tu cuenta.</p>
      `,
    })
    return
  }

  if (order.estado === "cancelado") {
    await sendOrderStatusEmail({
      to: order.cliente_email,
      subject: `Compra cancelada ${orderCode}`,
      html: `
        <h1>Compra cancelada</h1>
        <p>Hola ${order.cliente_nombre ?? ""}, tu pedido ${orderCode} fue cancelado.</p>
        <p>Te avisaremos cualquier novedad adicional desde tu cuenta y por email.</p>
      `,
    })
  }
}
