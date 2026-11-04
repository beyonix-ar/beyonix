import { requireOperator } from "@/app/api/admin/clientes/_auth"
import { validId } from "@/lib/admin/dispatch"
import { buildLocalDeliveryLabels, LocalDeliveryLabelError, type LocalDeliveryLabelOrder } from "@/lib/shipping/local-delivery-label"
import { isLocalDeliveryOrder } from "@/lib/shipping/local-delivery"

type Context = { params: Promise<{ id: string }> }

const ORDER_COLUMNS = "id,estado,cancelled_at,financial_status,shipping_provider,envio_proveedor,cliente_nombre,cliente_direccion,localidad,provincia,cp_destino,cliente_telefono"
const CANCELLED_FINANCIAL = ["cancellation_requested", "refund_pending", "refunded", "cancelled"]

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
 * público. Reimprimir devuelve exactamente los mismos códigos: no crea bultos
 * ni cambia el pedido; sólo deja la impresión en el historial.
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
  if (!isLocalDeliveryOrder(order)) return Response.json({ error: "Este pedido no usa Envío BEYONIX: imprimí su etiqueta Andreani." }, { status: 409 })
  if (order.estado === "cancelado" || order.cancelled_at || CANCELLED_FINANCIAL.includes(order.financial_status ?? "")) {
    return Response.json({ error: "Pedido cancelado — no se imprimen etiquetas de entrega." }, { status: 409 })
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

  let labels: ReturnType<typeof buildLocalDeliveryLabels>
  try {
    labels = buildLocalDeliveryLabels(order, parcelsResult.data ?? [], pkg.parcels_defined_at)
  } catch (cause) {
    if (cause instanceof LocalDeliveryLabelError) return Response.json({ error: cause.message }, { status: 409 })
    throw cause
  }

  // Trazabilidad con la auditoría existente: primera impresión o reimpresión
  // (mismos BX-PKG). Sin registro no se imprime.
  const previous = await auth.admin.from("order_audit_events").select("id", { count: "exact", head: true })
    .eq("order_id", id).eq("action", "local_delivery_labels_printed")
    .eq("metadata->>packageId", String(pkg.id)).eq("metadata->>attempt", String(pkg.attempt_number))
  if (previous.error) return Response.json({ error: "No se pudo registrar la impresión. Reintentá." }, { status: 500 })
  const audit = await auth.admin.from("order_audit_events").insert({
    order_id: id, actor_type: "admin", actor_id: auth.user.id, action: "local_delivery_labels_printed",
    metadata: { packageId: pkg.id, attempt: pkg.attempt_number, parcelCount: pkg.parcel_count, barcodes: labels.map((label) => label.code), reprint: (previous.count ?? 0) > 0 },
  })
  if (audit.error) return Response.json({ error: "No se pudo registrar la impresión. Reintentá." }, { status: 500 })

  return Response.json({ labels }, { headers: { "Cache-Control": "private, no-store" } })
}
