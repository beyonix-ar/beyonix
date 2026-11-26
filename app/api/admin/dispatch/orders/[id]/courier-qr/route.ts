import { requireOperator } from "@/app/api/admin/clientes/_auth"
import { DISPATCH_TEST_ORDER_CONSULT_ERROR, orderCode, validId } from "@/lib/admin/dispatch"
import { isLocalDeliveryOrder } from "@/lib/shipping/local-delivery"
import { getCourierScreen, isLocalDeliveryAccessToken, isLocalDeliveryOutcomeStatus, localDeliveryCourierUrl } from "@/lib/shipping/local-delivery-outcome"
import { resolveTrustedSiteUrl } from "@/lib/site-url"

type Context = { params: Promise<{ id: string }> }

const ORDER_COLUMNS = "id,estado,cancelled_at,financial_status,shipping_provider,envio_proveedor,test_order_at"
const CANCELLED_FINANCIAL = ["cancellation_requested", "refund_pending", "refunded", "cancelled"]
const NO_STORE = { "Cache-Control": "private, no-store" }

/**
 * QR del cadete de un pedido Envío BEYONIX, para mostrarlo en Despachos (el
 * mismo que va impreso en las etiquetas). Sólo LEE el token vigente: nunca lo
 * crea ni lo rota (eso lo hace únicamente la generación de etiquetas). El QR
 * es una credencial del pedido, así que cada consulta queda en el historial.
 */
export async function POST(request: Request, context: Context) {
  const id = validId((await context.params).id)
  if (!id) return Response.json({ error: "Pedido inválido." }, { status: 400 })
  const auth = await requireOperator(request)
  if ("error" in auth) return auth.error

  const [orderResult, shipmentResult] = await Promise.all([
    auth.admin.from("ordenes").select(ORDER_COLUMNS).eq("id", id).maybeSingle(),
    auth.admin.from("local_delivery_shipments").select("id,access_token,token_revoked_at,outcome_status,failed_attempts")
      .eq("order_id", id).order("shipment_number", { ascending: false }).limit(1).maybeSingle(),
  ])
  if (orderResult.error || shipmentResult.error) return Response.json({ error: "No se pudo cargar el QR del pedido." }, { status: 500, headers: NO_STORE })
  const order = orderResult.data as { id: number; estado: string | null; cancelled_at: string | null; financial_status: string | null; shipping_provider: string | null; envio_proveedor: string | null; test_order_at: string | null } | null
  if (!order) return Response.json({ error: "Pedido no encontrado." }, { status: 404, headers: NO_STORE })
  // Compra de prueba: consulta histórica sólo para Super Admin (el cadete no puede operar un pedido entregado).
  if (order.test_order_at && auth.profile.rol !== "super_admin") return Response.json({ error: DISPATCH_TEST_ORDER_CONSULT_ERROR }, { status: 409, headers: NO_STORE })
  if (!isLocalDeliveryOrder(order)) return Response.json({ error: "Este pedido no usa Envío BEYONIX: no tiene QR de cadete." }, { status: 409, headers: NO_STORE })
  const cancelled = order.estado === "cancelado" || Boolean(order.cancelled_at) || CANCELLED_FINANCIAL.includes(order.financial_status ?? "")
  if (cancelled) return Response.json({ error: "Pedido cancelado: su QR de entrega ya no se usa." }, { status: 409, headers: NO_STORE })

  const shipment = shipmentResult.data as { id: number; access_token: string; token_revoked_at: string | null; outcome_status: string; failed_attempts: number } | null
  if (!shipment || !isLocalDeliveryOutcomeStatus(shipment.outcome_status)) {
    return Response.json({ error: "El QR se emite al imprimir las etiquetas BEYONIX. Imprimilas desde Preparar pedido → Etiquetas." }, { status: 409, headers: NO_STORE })
  }
  // Revocado: no se muestra como utilizable. Reimprimir las etiquetas emite uno nuevo (regla existente).
  if (shipment.token_revoked_at || !isLocalDeliveryAccessToken(shipment.access_token)) {
    return Response.json({ error: "El QR de este pedido fue revocado. Reimprimí las etiquetas BEYONIX para emitir uno nuevo." }, { status: 409, headers: NO_STORE })
  }
  const siteUrl = resolveTrustedSiteUrl(request)
  if (!siteUrl) return Response.json({ error: "Falta configurar la URL pública del sitio para el QR de entrega." }, { status: 500, headers: NO_STORE })

  const audit = await auth.admin.from("order_audit_events").insert({
    order_id: id, actor_type: "admin", actor_id: auth.user.id, action: "local_delivery_courier_qr_viewed",
    metadata: { shipmentId: shipment.id, estado: order.estado, shippingProvider: "beyonix" },
  })
  if (audit.error) return Response.json({ error: "No se pudo registrar la consulta del QR. Reintentá." }, { status: 500, headers: NO_STORE })

  const screen = getCourierScreen({ estado: order.estado, cancelled, outcomeStatus: shipment.outcome_status, failedAttempts: shipment.failed_attempts })
  return Response.json({
    orderCode: orderCode(id),
    url: localDeliveryCourierUrl(siteUrl, shipment.access_token),
    // El cadete sólo puede registrar el resultado con el pedido En camino.
    courierCanAct: screen.kind === "actions",
    screen: screen.kind,
  }, { headers: NO_STORE })
}
