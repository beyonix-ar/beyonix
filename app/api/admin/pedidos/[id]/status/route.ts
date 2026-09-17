import { NextResponse } from "next/server"

import { requireOperator } from "@/app/api/admin/clientes/_auth"
import { appendOrderAuditEvent } from "@/lib/orders/order-audit"
import { sendOrderStateEmail } from "@/lib/orders/order-status-notifications"
import { isOrderPaymentConfirmed } from "@/lib/orders/order-payment-status"
import { canChangeOrderStatus } from "@/lib/orders/order-status-authorization"
import { activatePendingItemWarranties } from "@/lib/orders/warranty-activation"

// BLOQUEANTE 1 (auditoría Andreani Parte 3/4): "cancelado" NO es un estado
// operativo más -- deliberadamente NO está en esta lista. Este endpoint
// genérico no conoce (ni debe reimplementar) las guardas financieras/Andreani
// de la cancelación real (andreani_creation_status='claimed'/
// 'reconciliation_required', factura ya autorizada, envío ya despachado,
// etc.) -- esas guardas viven en una única fuente atómica:
// public.admin_cancel_order (RPC), expuesta acá por
// app/api/admin/pedidos/[id]/cancel/route.ts. Antes, un PATCH acá con
// estado="cancelado" evadía las 3 RPCs seguras (Parte 1) por completo. Se
// prefiere bloquear el bypass en vez de duplicar esa lógica en un segundo
// lugar -- ver el check explícito más abajo, antes de esta lista, para un
// mensaje claro en vez de "estado inválido" genérico.
const ALLOWED_ORDER_STATUSES = [
  "pendiente",
  "pagado",
  "enviado",
  "en_camino",
  "visita_fallida",
  "en_sucursal",
  "retiro_pendiente",
  "retiro_vencido",
  "en_devolucion",
  "devuelto_beyonix",
  "entregado",
]

const DISPATCHED_ORDER_STATUSES = [
  "enviado",
  "en_camino",
  "visita_fallida",
  "en_sucursal",
  "retiro_pendiente",
  "retiro_vencido",
  "en_devolucion",
  "devuelto_beyonix",
  "entregado",
]

/**
 * Subconjunto de DISPATCHED_ORDER_STATUSES que representa un evento FÍSICO
 * de la red Andreani (visita, sucursal, retiro, devolución) -- no tiene
 * sentido marcarlos si el pedido nunca tuvo un envío Andreani real. "enviado"
 * queda deliberadamente afuera: es la etiqueta genérica de despacho que
 * también usa un transportista manual ("Otro" en el selector de modalidad
 * logística admin), no exclusiva de Andreani.
 */
const ANDREANI_PHYSICAL_STATUSES = [
  "visita_fallida",
  "en_sucursal",
  "retiro_pendiente",
  "retiro_vencido",
  "en_devolucion",
  "devuelto_beyonix",
]

function normalizeExternalUrl(value: unknown) {
  if (typeof value !== "string") return null

  const trimmed = value.trim()
  if (!trimmed) return null

  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireOperator(request)

  if ("error" in auth) return auth.error

  const { id } = await params
  const orderId = Number(id)
  const body = (await request.json()) as {
    estado?: unknown
    tracking_number?: unknown
    tracking_url?: unknown
    envio_proveedor?: unknown
  }
  const estado = String(body.estado ?? "")

  if (!Number.isFinite(orderId) || orderId <= 0) {
    return NextResponse.json({ error: "Pedido inválido." }, { status: 400 })
  }

  if (estado === "cancelado") {
    return NextResponse.json(
      {
        error:
          "Este endpoint no cancela pedidos. Usá \"Cancelar pedido\" o \"Rechazar pedido\" desde el detalle del pedido.",
      },
      { status: 409 },
    )
  }

  if (!ALLOWED_ORDER_STATUSES.includes(estado)) {
    return NextResponse.json(
      { error: "Estado del pedido inválido." },
      { status: 400 },
    )
  }

  if (!canChangeOrderStatus(auth.profile.rol, estado)) {
    return NextResponse.json(
      {
        error:
          "Solo un superadministrador puede cambiar este estado manualmente.",
      },
      { status: 403 },
    )
  }

  const trackingNumber =
    typeof body.tracking_number === "string"
      ? body.tracking_number.trim() || null
      : null
  const shippingProvider =
    typeof body.envio_proveedor === "string"
      ? body.envio_proveedor.trim() || null
      : null

  if (
    body.envio_proveedor !== undefined &&
    typeof body.envio_proveedor !== "string"
  ) {
    return NextResponse.json(
      { error: "El transportista informado no es válido." },
      { status: 400 },
    )
  }

  if (shippingProvider && shippingProvider.length > 100) {
    return NextResponse.json(
      { error: "El nombre del transportista es demasiado largo." },
      { status: 400 },
    )
  }

  const { data: currentOrder, error: currentOrderError } = await auth.admin
    .from("ordenes")
    .select("id, estado, delivered_at, payment_status, paid_at, financial_status, order_change_status, andreani_envio_id, andreani_estado, andreani_creation_environment, andreani_tracking_event_at, shipping_provider, envio_proveedor")
    .eq("id", orderId)
    .maybeSingle()

  if (currentOrderError || !currentOrder) {
    return NextResponse.json(
      { error: "No encontramos el pedido." },
      { status: 404 },
    )
  }

  if (
    (estado === "pagado" || DISPATCHED_ORDER_STATUSES.includes(estado)) &&
    !isOrderPaymentConfirmed(currentOrder)
  ) {
    return NextResponse.json(
      { error: "El pedido no tiene evidencia financiera de pago confirmado." },
      { status: 409 },
    )
  }

  if (DISPATCHED_ORDER_STATUSES.includes(estado)) {
    if (
      ["cancelled", "cancellation_requested", "refund_pending", "refunded"].includes(
        String(currentOrder.financial_status ?? ""),
      )
    ) {
      return NextResponse.json(
        { error: "No se puede despachar un pedido cancelado o con reintegro pendiente." },
        { status: 409 },
      )
    }

    if (currentOrder.order_change_status === "change_requested") {
      return NextResponse.json(
        { error: "No se puede despachar un pedido con cambio pendiente de aprobación." },
        { status: 409 },
      )
    }

    if (currentOrder.order_change_status === "extra_payment_pending") {
      return NextResponse.json(
        { error: "No se puede despachar un pedido con diferencia de cambio pendiente de pago." },
        { status: 409 },
      )
    }
  }

  // Estados que sólo tienen sentido si existe un envío Andreani real: un
  // pedido cuyo transportista es Andreani no puede pasar a "visita fallida"
  // o "en sucursal" si nunca se generó el envío (andreani_envio_id vacío).
  // "enviado" queda afuera a propósito (ver ANDREANI_PHYSICAL_STATUSES):
  // también lo usa un transportista manual ("Otro"), sin andreani_envio_id.
  if (ANDREANI_PHYSICAL_STATUSES.includes(estado)) {
    const provider = (
      currentOrder.shipping_provider ?? currentOrder.envio_proveedor ?? ""
    )
      .toString()
      .toLowerCase()
    const hasAndreaniShipment = Boolean(
      (currentOrder.andreani_envio_id ?? "").toString().trim(),
    )

    if (provider === "andreani" && !hasAndreaniShipment) {
      return NextResponse.json(
        {
          error:
            "Este pedido usa Andreani pero todavía no tiene un envío generado. Generá el envío antes de marcar este estado.",
        },
        { status: 409 },
      )
    }
  }

  // "cancelado" ya fue rechazado más arriba -- estado nunca llega acá con
  // ese valor. financial_status no lo toca esta ruta (sólo lo tocan las
  // RPCs guardadas de cancelación).
  const statusUpdate = {
    estado,
    ...(estado === "entregado" && !currentOrder.delivered_at
      ? { delivered_at: new Date().toISOString() }
      : {}),
    ...(body.tracking_number !== undefined
      ? { tracking_number: trackingNumber }
      : {}),
    ...(body.tracking_url !== undefined
      ? { tracking_url: normalizeExternalUrl(body.tracking_url) }
      : {}),
    ...(body.envio_proveedor !== undefined
      ? { envio_proveedor: shippingProvider }
      : {}),
  }
  const { data, error } = await auth.admin
    .from("ordenes")
    .update(statusUpdate)
    .eq("id", orderId)
    .select()
    .single()

  if (error || !data) {
    return NextResponse.json(
      { error: error?.message || "No se pudo actualizar el estado del pedido." },
      { status: 500 },
    )
  }

  if (currentOrder.estado !== estado) {
    if (estado === "entregado" && data.delivered_at) {
      await activatePendingItemWarranties(auth.admin, {
        orderId,
        deliveredAt: data.delivered_at,
        actorType: "admin",
        actorId: auth.user.id,
      })
    }

    await appendOrderAuditEvent(auth.admin, {
      orderId,
      actorType: "admin",
      actorId: auth.user.id,
      action: "order_status_changed",
      previousStatus: currentOrder.financial_status ?? currentOrder.estado,
      newStatus: estado,
      metadata: {
        previousEstado: currentOrder.estado,
        newEstado: estado,
        // Override manual sobre un pedido con envío Andreani activo: se
        // registra el último estado logístico real conocido para que quede
        // trazable si el cambio manual contradice a Andreani (ver política
        // en lib/andreani/tracking-status-mapping.ts) -- nunca se bloquea el
        // cambio (es la vía de emergencia de super_admin), sólo se audita.
        ...(currentOrder.andreani_envio_id
          ? {
              andreaniSnapshot: {
                envioId: currentOrder.andreani_envio_id,
                environment: currentOrder.andreani_creation_environment,
                estado: currentOrder.andreani_estado,
                trackingEventAt: currentOrder.andreani_tracking_event_at,
              },
            }
          : {}),
      },
    })

    await sendOrderStateEmail(data)
  }

  return NextResponse.json({ order: data })
}
