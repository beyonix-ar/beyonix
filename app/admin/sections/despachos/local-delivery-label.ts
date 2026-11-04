import { printLabels } from "@/lib/barcodes/print-labels"
import type { LocalDeliveryLabel } from "@/lib/shipping/local-delivery-label"

import { dispatchRequest } from "./dispatch-request"

/**
 * Imprime la etiqueta Envío BEYONIX de cada bulto del pedido (101,6 × 50,8 mm)
 * con el mismo motor de impresión de Despachos. Imprimir no confirma nada:
 * cada bulto se confirma escaneando su BX-PKG.
 */
export async function printLocalDeliveryLabels(orderId: number) {
  const { labels } = await dispatchRequest<{ labels: LocalDeliveryLabel[] }>(`/orders/${orderId}/local-label`, {})
  await printLabels(labels, "single")
  return labels.length
}
