import { orderCode } from "../admin/dispatch.ts"
import { fitLocalDeliveryLabel, LOCAL_DELIVERY_LABEL_TOO_LONG } from "./local-delivery-label-layout.ts"

/**
 * Etiqueta logística propia de Envío BEYONIX: una por bulto físico
 * (order_package_parcels), con sólo lo necesario para entregar. Nunca lleva
 * importes, forma de pago, saldo, CUIT ni productos.
 */
export interface LocalDeliveryLabel {
  kind: "local_delivery"
  /** BX-PKG del bulto (Code 128): identificador estable, también al reimprimir. */
  code: string
  orderCode: string
  index: number
  count: number
  recipient: string
  address: string
  /** Referencias que el cliente cargó en el checkout, si las hay. */
  reference: string | null
  locality: string
  province: string | null
  postalCode: string
  phone: string | null
  /** Fecha en que se definieron los bultos (no cambia al reimprimir). */
  date: string
}

export interface LocalDeliveryLabelOrder {
  id: number
  cliente_nombre: string | null
  cliente_direccion: string | null
  localidad: string | null
  provincia: string | null
  cp_destino: string | null
  cliente_telefono: string | null
}

export interface LocalDeliveryLabelParcel {
  barcode: string
  parcel_index: number
  parcel_count: number
}

export class LocalDeliveryLabelError extends Error {}

const clean = (value: string | null | undefined) => value?.trim().replace(/\s+/g, " ") || null

// El checkout guarda "Calle 1234. Referencias: …" en cliente_direccion, siempre
// con este separador exacto. Criterio conservador: sólo se separa si aparece UNA
// vez y deja texto a ambos lados. Si es ambiguo (más de una vez, p. ej. porque la
// dirección o la referencia también lo contienen) todo queda como dirección
// completa: nunca se descarta ni se reasigna contenido.
const REFERENCE_SEPARATOR = ". Referencias: "

export function splitDeliveryAddress(value: string | null | undefined) {
  const text = clean(value) ?? ""
  const at = text.indexOf(REFERENCE_SEPARATOR)
  if (at < 0 || text.indexOf(REFERENCE_SEPARATOR, at + 1) >= 0) return { address: text, reference: null }
  const address = text.slice(0, at).trim()
  const reference = clean(text.slice(at + REFERENCE_SEPARATOR.length))
  if (!address || !reference) return { address: text, reference: null }
  return { address, reference }
}

export function formatLocalDeliveryLabelDate(value: string) {
  return new Intl.DateTimeFormat("es-AR", { timeZone: "America/Argentina/Buenos_Aires", day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(value))
}

/**
 * Una etiqueta por bulto del intento vigente, en orden 1..N. Falla si faltan
 * datos de entrega (una etiqueta sin dirección o CP no sirve al cadete) o si
 * no entran legibles en 101,6 × 50,8 mm: nunca se genera una etiqueta cortada.
 */
export function buildLocalDeliveryLabels(
  order: LocalDeliveryLabelOrder,
  parcels: readonly LocalDeliveryLabelParcel[],
  definedAt: string,
): LocalDeliveryLabel[] {
  const { address, reference } = splitDeliveryAddress(order.cliente_direccion)
  const recipient = clean(order.cliente_nombre)
  const locality = clean(order.localidad)
  const postalCode = clean(order.cp_destino)
  if (!recipient || !address || !locality || !postalCode) {
    throw new LocalDeliveryLabelError("Faltan datos de entrega del pedido (destinatario, dirección, localidad o CP).")
  }
  if (!parcels.length) throw new LocalDeliveryLabelError("Definí los bultos antes de imprimir las etiquetas.")
  const count = parcels[0].parcel_count
  const sorted = [...parcels].sort((left, right) => left.parcel_index - right.parcel_index)
  if (sorted.length !== count || sorted.some((parcel, position) => parcel.parcel_count !== count || parcel.parcel_index !== position + 1)) {
    throw new LocalDeliveryLabelError("Los bultos del pedido no están completos. Actualizá el pedido.")
  }
  const phone = clean(order.cliente_telefono)
  const province = clean(order.provincia)
  if (!fitLocalDeliveryLabel({ recipient, address, reference, locality, province, postalCode, phone })) {
    throw new LocalDeliveryLabelError(LOCAL_DELIVERY_LABEL_TOO_LONG)
  }
  const date = formatLocalDeliveryLabelDate(definedAt)
  return sorted.map((parcel) => ({
    kind: "local_delivery",
    code: parcel.barcode,
    orderCode: orderCode(order.id),
    index: parcel.parcel_index,
    count,
    recipient,
    address,
    reference,
    locality,
    province,
    postalCode,
    phone,
    date,
  }))
}
