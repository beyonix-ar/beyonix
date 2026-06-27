import type {
  OrderClaimResolution,
  OrderClaimStatus,
  OrderClaimType,
} from "@/lib/supabase/types"

export const ORDER_CLAIM_BUCKET = "order-claim-evidence"
export const ORDER_CLAIM_IMAGE_MAX_BYTES = 8 * 1024 * 1024
export const ORDER_CLAIM_VIDEO_MAX_BYTES = 40 * 1024 * 1024
export const ORDER_CLAIM_FILE_MAX_BYTES = 10 * 1024 * 1024
export const TRANSPORT_CLAIM_WINDOW_HOURS = 48
export const WARRANTY_CLAIM_WINDOW_DAYS = 30

export const ORDER_CLAIM_STATUSES: OrderClaimStatus[] = [
  "recibido",
  "en_revision",
  "falta_informacion",
  "aprobado",
  "reintegro_pendiente",
  "cambio_pendiente",
  "cupon_pendiente",
  "reemplazo_enviado",
  "rechazado",
  "cerrado",
]

export const ORDER_CLAIM_RESOLUTIONS: OrderClaimResolution[] = [
  "cambio_producto",
  "reintegro_total",
  "reintegro_parcial",
  "cupon_descuento",
  "rechazado",
  "otro",
]

export const CUSTOMER_SELECTABLE_ORDER_CLAIM_RESOLUTIONS: OrderClaimResolution[] =
  []

export const ACTIVE_ORDER_CLAIM_STATUSES: OrderClaimStatus[] = [
  "recibido",
  "en_revision",
  "falta_informacion",
  "aprobado",
  "reintegro_pendiente",
  "cambio_pendiente",
  "cupon_pendiente",
  "reemplazo_enviado",
]

export function getOrderClaimStatusLabel(status?: string | null) {
  const labels: Record<string, string> = {
    recibido: "En revisión",
    en_revision: "En revisión",
    falta_informacion: "Esperando respuesta del cliente",
    aprobado: "Solución en proceso",
    reintegro_pendiente: "Reintegro pendiente",
    cambio_pendiente: "Solución en proceso",
    cupon_pendiente: "Cupón pendiente",
    reemplazo_enviado: "Solución en proceso",
    rechazado: "Rechazado",
    cerrado: "Resuelto",
  }

  return status ? labels[status] ?? status : "Sin estado"
}

export function getOrderClaimTypeLabel(type?: string | null) {
  const labels: Record<string, string> = {
    transporte_48hs: "Problema con la entrega",
    garantia_beyonix: "Garantía BEYONIX",
  }

  return type ? labels[type] ?? type : "Reclamo"
}

export function getOrderClaimResolutionLabel(resolution?: string | null) {
  const labels: Record<string, string> = {
    cambio_producto: "Solución operativa",
    reintegro_total: "Reintegro total",
    reintegro_parcial: "Reintegro parcial",
    cupon_descuento: "Cupón de descuento",
    rechazado: "Rechazado",
    otro: "Otra solución",
  }

  return resolution ? labels[resolution] ?? resolution : "Sin resolución"
}

export function getClaimDeadline(deliveredAt: string, type: OrderClaimType) {
  const deadline = new Date(deliveredAt)

  if (type === "transporte_48hs") {
    deadline.setHours(deadline.getHours() + TRANSPORT_CLAIM_WINDOW_HOURS)
  } else {
    deadline.setDate(deadline.getDate() + WARRANTY_CLAIM_WINDOW_DAYS)
  }

  return deadline
}

export function isClaimWindowOpen(deliveredAt: string, type: OrderClaimType) {
  return Date.now() <= getClaimDeadline(deliveredAt, type).getTime()
}

export function sanitizeClaimFileName(fileName: string) {
  const cleaned = fileName
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 120)

  return cleaned || "evidencia"
}

export function getClaimFileValidationError(file: File | null | undefined) {
  if (!file) return ""

  const isImage = file.type.startsWith("image/")
  const isVideo = file.type.startsWith("video/")
  const isDocument = [
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "text/plain",
  ].includes(file.type)

  if (!isImage && !isVideo && !isDocument) {
    return "Subí una imagen, un video, un PDF o un documento válido."
  }

  if (isImage && file.size > ORDER_CLAIM_IMAGE_MAX_BYTES) {
    return "Cada imagen puede pesar hasta 8 MB."
  }

  if (isVideo && file.size > ORDER_CLAIM_VIDEO_MAX_BYTES) {
    return "El video puede pesar hasta 40 MB."
  }

  if (isDocument && file.size > ORDER_CLAIM_FILE_MAX_BYTES) {
    return "Cada archivo puede pesar hasta 10 MB."
  }

  return ""
}
