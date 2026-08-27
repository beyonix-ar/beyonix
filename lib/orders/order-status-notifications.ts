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

/**
 * Único punto que arma y envía el email de cambio de estado visible al
 * cliente (enviado/en_camino, entregado, cancelado). Compartido entre el
 * cambio manual (admin) y la sincronización automática de tracking Andreani
 * -- ambos caminos deben mandar exactamente el mismo email, una sola vez por
 * transición real.
 */
export async function sendOrderStateEmail(order: OrderForStatusEmail) {
  const orderCode = getOrderCode(order.id)

  if (order.estado === "enviado" || order.estado === "en_camino") {
    await sendOrderStatusEmail({
      to: order.cliente_email,
      subject: `Pedido enviado ${orderCode}`,
      html: `
        <h1>Pedido enviado</h1>
        <p>Hola ${order.cliente_nombre ?? ""}, tu pedido ${orderCode} ya fue enviado.</p>
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
