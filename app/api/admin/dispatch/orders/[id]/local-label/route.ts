import { requireOperator } from "@/app/api/admin/clientes/_auth"
import { validId } from "@/lib/admin/dispatch"
import { buildLocalDeliveryLabels, LocalDeliveryLabelError, type LocalDeliveryLabelOrder } from "@/lib/shipping/local-delivery-label"
import { isLocalDeliveryOrder } from "@/lib/shipping/local-delivery"
import { createLocalDeliveryAccessToken, localDeliveryCourierUrl } from "@/lib/shipping/local-delivery-outcome"
import { resolveTrustedSiteUrl } from "@/lib/site-url"

type Context = { params: Promise<{ id: string }> }

const ORDER_COLUMNS = "id,estado,cancelled_at,financial_status,shipping_provider,envio_proveedor,cliente_nombre,cliente_direccion,localidad,provincia,cp_destino,cliente_telefono"
const CANCELLED_FINANCIAL = ["cancellation_requested", "refund_pending", "refunded", "cancelled"]
const CANCELLED_MESSAGE = "Pedido cancelado — no se generan etiquetas de entrega."
const NOT_LOCAL_MESSAGE = "Este pedido no usa Envío BEYONIX: imprimí su etiqueta Andreani."

type OrderRow = LocalDeliveryLabelOrder & {
  estado: string | null
  cancelled_at: string | null
  financial_status: string | null
  shipping_provider: string | null
  envio_proveedor: string | null
}

/**
 * Etiqueta propia Envío BEYONIX: datos de entrega de cada bulto físico del
 * intento vigente (uno por BX-PKG). Sólo Despachos (operador/Admin), nunca
 * público. Regenerar (reimprimir) devuelve exactamente los mismos códigos: no
 * crea bultos ni cambia el pedido; sólo deja la generación en el historial.
 */
export async function POST(request: Request, context: Context) {
  const id = validId((await context.params).id)
  if (!id) return Response.json({ error: "Pedido inválido." }, { status: 400 })
  const auth = await requireOperator(request)
  if ("error" in auth) return auth.error

  const { data, error } = await auth.admin.from("ordenes").select(ORDER_COLUMNS).eq("id", id).maybeSingle()
  if (error) return Response.json({ error: "No se pudo cargar el pedido." }, { status: 500 })
  const order = data as OrderRow | null
  if (!order) return Response.json({ error: "Pedido no encontrado." }, { status: 404 })
  if (!isLocalDeliveryOrder(order)) return Response.json({ error: NOT_LOCAL_MESSAGE }, { status: 409 })
  if (order.estado === "cancelado" || order.cancelled_at || CANCELLED_FINANCIAL.includes(order.financial_status ?? "")) {
    return Response.json({ error: CANCELLED_MESSAGE }, { status: 409 })
  }

  const pkgResult = await auth.admin.from("order_packages").select("id,status,attempt_number,parcel_count,parcels_defined_at").eq("order_id", id).maybeSingle()
  if (pkgResult.error) return Response.json({ error: "No se pudo cargar la preparación." }, { status: 500 })
  const pkg = pkgResult.data as { id: number; status: string; attempt_number: number; parcel_count: number | null; parcels_defined_at: string | null } | null
  if (!pkg || pkg.status !== "prepared" || !pkg.parcel_count || !pkg.parcels_defined_at) {
    return Response.json({ error: "Completá el pickeo y definí los bultos antes de imprimir." }, { status: 409 })
  }
  const parcelsResult = await auth.admin.from("order_package_parcels").select("barcode,parcel_index,parcel_count")
    .eq("package_id", pkg.id).eq("attempt_number", pkg.attempt_number).eq("parcel_count", pkg.parcel_count).order("parcel_index")
  if (parcelsResult.error) return Response.json({ error: "No se pudieron cargar los bultos." }, { status: 500 })

  // QR de gestión de entrega: URL pública confiable (nunca el Origin de la
  // request en producción) + token aleatorio del pedido. Reimprimir devuelve
  // el mismo token (la base lo crea una sola vez, bajo lock del pedido).
  const siteUrl = resolveTrustedSiteUrl(request)
  if (!siteUrl) return Response.json({ error: "Falta configurar la URL pública del sitio para el QR de entrega." }, { status: 500 })
  const ensured = await auth.admin.rpc("ensure_local_delivery_shipment", {
    p_order_id: id, p_actor_id: auth.user.id, p_token: createLocalDeliveryAccessToken(),
  })
  if (ensured.error || typeof ensured.data !== "string") {
    const message = ensured.error?.message ?? ""
    if (message.includes("LOCAL_DELIVERY_LABEL_ORDER_CANCELLED")) return Response.json({ error: CANCELLED_MESSAGE }, { status: 409 })
    if (message.includes("DISPATCH_LOCAL_DELIVERY_ONLY")) return Response.json({ error: NOT_LOCAL_MESSAGE }, { status: 409 })
    return Response.json({ error: "No se pudo generar el QR de entrega. Reintentá." }, { status: 500 })
  }

  let labels: ReturnType<typeof buildLocalDeliveryLabels>
  try {
    labels = buildLocalDeliveryLabels(order, parcelsResult.data ?? [], pkg.parcels_defined_at, localDeliveryCourierUrl(siteUrl, ensured.data))
  } catch (cause) {
    if (cause instanceof LocalDeliveryLabelError) return Response.json({ error: cause.message }, { status: 409 })
    throw cause
  }

  // Registro atómico de la GENERACIÓN (no de la impresión física, que el
  // servidor no puede saber): bajo el lock del pedido y su preparación, la base
  // confirma que el intento y sus BX-PKG siguen vigentes y decide primera
  // generación vs regeneración. Si hubo un rearmado entre la lectura y este
  // punto, estas etiquetas no se devuelven. Sin registro no se imprime.
  const recorded = await auth.admin.rpc("record_local_delivery_labels_generated", {
    p_order_id: id, p_actor_id: auth.user.id, p_package_id: pkg.id, p_attempt: pkg.attempt_number,
    p_barcodes: labels.map((label) => label.code),
  })
  if (recorded.error) {
    const message = recorded.error.message ?? ""
    if (message.includes("DISPATCH_PARCEL_STALE")) {
      return Response.json({ error: "La preparación del pedido cambió (rearmado o bultos nuevos). Actualizá el pedido y volvé a generar las etiquetas." }, { status: 409 })
    }
    if (message.includes("LOCAL_DELIVERY_LABEL_ORDER_CANCELLED")) return Response.json({ error: CANCELLED_MESSAGE }, { status: 409 })
    if (message.includes("DISPATCH_LOCAL_DELIVERY_ONLY")) return Response.json({ error: NOT_LOCAL_MESSAGE }, { status: 409 })
    return Response.json({ error: "No se pudo registrar la generación de las etiquetas. Reintentá." }, { status: 500 })
  }

  return Response.json({ labels }, { headers: { "Cache-Control": "private, no-store" } })
}
