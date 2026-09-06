import type {
  OrderClaimResolution,
  OrderClaimStatus,
  OrderClaimType,
} from "@/lib/supabase/types"

export const ORDER_CLAIM_BUCKET = "order-claim-evidence"
export const ORDER_CLAIM_IMAGE_MAX_BYTES = 8 * 1024 * 1024
export const ORDER_CLAIM_VIDEO_MAX_BYTES = 40 * 1024 * 1024
export const ORDER_CLAIM_FILE_MAX_BYTES = 10 * 1024 * 1024
export const ORDER_CLAIM_MAX_FILES = 6
export const TRANSPORT_CLAIM_WINDOW_HOURS = 48
export const WARRANTY_CLAIM_WINDOW_MONTHS = 6

// Fuente única de motivos válidos para "Iniciar reclamo" (post-entrega).
// app/api/orders/[id]/claims/route.ts valida contra esta lista -- si se
// agrega un motivo acá, también debe ofrecerse en
// components/claims/customer-claim-experience.tsx (POST_DELIVERY_PROBLEMS)
// para que frontend/backend no diverjan.
export const POST_DELIVERY_CLAIM_REASONS = [
  "danado",
  "incorrecto",
  "falla",
  "faltante",
  "cantidad_menor",
  "otro",
] as const

export type PostDeliveryClaimReason = (typeof POST_DELIVERY_CLAIM_REASONS)[number]

export const CLAIM_REASON_TYPES: Record<PostDeliveryClaimReason, OrderClaimType> = {
  danado: "transporte_48hs",
  incorrecto: "transporte_48hs",
  faltante: "transporte_48hs",
  cantidad_menor: "transporte_48hs",
  falla: "garantia_beyonix",
  otro: "garantia_beyonix",
}
export const CLAIM_TEXT_MAX_LENGTH = 2000
export const CLAIM_FILE_EXTENSIONS: Record<string, readonly string[]> = {
  "image/jpeg": ["jpg", "jpeg"],
  "image/png": ["png"],
  "image/gif": ["gif"],
  "image/webp": ["webp"],
  "application/pdf": ["pdf"],
  "video/mp4": ["mp4"],
  "video/quicktime": ["mov"],
  "video/webm": ["webm"],
}
export const CLAIM_FILE_ACCEPT = Object.values(CLAIM_FILE_EXTENSIONS).flat().map((ext) => `.${ext}`).join(",")

export function isClaimOrderDelivered(order: { estado?: string | null; delivered_at?: string | null }) {
  return order.estado?.toLowerCase() !== "cancelado" &&
    (order.estado?.toLowerCase() === "entregado" || Boolean(order.delivered_at))
}

export function getClaimEligibilityError(
  order: { estado?: string | null; delivered_at?: string | null },
  reason: PostDeliveryClaimReason,
) {
  if (!isClaimOrderDelivered(order)) return "El pedido todavía no figura como entregado."
  if (!order.delivered_at || !Number.isFinite(Date.parse(order.delivered_at))) {
    return "Falta confirmar la fecha de entrega. Contactanos para registrar la fecha correcta."
  }
  if (!isClaimWindowOpen(order.delivered_at, CLAIM_REASON_TYPES[reason])) {
    return "El plazo para este tipo de reclamo ya finalizó."
  }
  return null
}

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
  "envio_unidad_faltante",
  "reintegro_total",
  "reintegro_parcial",
  "saldo_a_favor",
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

// Estados terminales: un reclamo acá no vuelve a ningún otro estado por
// ningún path (genérico ni acciones específicas).
export const TERMINAL_ORDER_CLAIM_STATUSES: OrderClaimStatus[] = [
  "cerrado",
  "rechazado",
]

/**
 * Grafo real de transiciones de order_claims.status, reconstruido leyendo
 * cada acción que hoy escribe `status` (no inventado): approveSolution,
 * markAcceptedSolutionDone, rejectClaim, "Finalizar reclamo"/"Cerrar
 * conversación", mark_refund_done, mark_credit_note_issued,
 * approve_cancellation/reject_cancellation (components/claims/
 * admin-claim-manager.tsx y app/api/admin/order-claims/[claimId]/route.ts).
 *
 * - recibido/en_revision/falta_informacion: la "primera revisión" --
 *   approveSolution manda directo a "aprobado", salvo resolución
 *   reintegro_total que salta a "reintegro_pendiente"; rejectClaim y
 *   "Finalizar reclamo" están disponibles desde cualquiera de los tres.
 * - aprobado: markAcceptedSolutionDone manda a "cupon_pendiente" (resolución
 *   cupon_descuento) o "cambio_pendiente" (cualquier otra resolución
 *   aceptada -- cambio_producto, envio_unidad_faltante, reintegro_parcial,
 *   saldo_a_favor, otro); también puede rechazarse o cerrarse directo.
 * - reintegro_pendiente/cupon_pendiente/cambio_pendiente/reemplazo_enviado:
 *   sólo terminan (cerrado/rechazado). reemplazo_enviado ya no es
 *   alcanzable por una acción nueva (su flujo específico está deshabilitado,
 *   410), pero un reclamo histórico que ya esté ahí debe poder cerrarse o
 *   rechazarse igual.
 * - cerrado/rechazado: no admiten ninguna transición (sólo no-op al mismo
 *   estado, ver getOrderClaimTransitionError).
 */
export const ORDER_CLAIM_TRANSITIONS: Record<OrderClaimStatus, OrderClaimStatus[]> = {
  recibido: ["en_revision", "falta_informacion", "aprobado", "reintegro_pendiente", "rechazado", "cerrado"],
  en_revision: ["falta_informacion", "aprobado", "reintegro_pendiente", "rechazado", "cerrado"],
  falta_informacion: ["en_revision", "aprobado", "reintegro_pendiente", "rechazado", "cerrado"],
  aprobado: ["cambio_pendiente", "cupon_pendiente", "rechazado", "cerrado"],
  reintegro_pendiente: ["cerrado", "rechazado"],
  cambio_pendiente: ["cerrado", "rechazado"],
  cupon_pendiente: ["cerrado", "rechazado"],
  reemplazo_enviado: ["cerrado", "rechazado"],
  rechazado: [],
  cerrado: [],
}

/**
 * Guarda de transición para CUALQUIER escritura de estado de un reclamo
 * (path genérico y cada acción específica). ORDER_CLAIM_STATUSES sólo
 * valida que el valor exista en la lista, no que la transición sea válida
 * -- sin esto, cualquier operador podía saltar de un estado a cualquier
 * otro sin relación con el flujo real. Devuelve un mensaje de error si la
 * transición no está permitida, o null si es válida. Reenviar el mismo
 * estado (no-op) siempre es válido, incluso desde un estado terminal --
 * eso es lo que permite reintentar una acción de forma idempotente.
 */
export function getOrderClaimTransitionError(
  currentStatus: OrderClaimStatus | string,
  nextStatus: OrderClaimStatus | string,
): string | null {
  if (nextStatus === currentStatus) return null

  const allowedNextStatuses = ORDER_CLAIM_TRANSITIONS[currentStatus as OrderClaimStatus]

  if (!allowedNextStatuses) {
    return "Estado actual del reclamo desconocido."
  }

  if (TERMINAL_ORDER_CLAIM_STATUSES.includes(currentStatus as OrderClaimStatus)) {
    return "Este reclamo ya está finalizado y no admite más cambios de estado."
  }

  if (!allowedNextStatuses.includes(nextStatus as OrderClaimStatus)) {
    return `No es posible pasar de "${getOrderClaimStatusLabel(currentStatus)}" a "${getOrderClaimStatusLabel(nextStatus)}".`
  }

  return null
}

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
    cambio_producto: "Cambio de producto",
    envio_unidad_faltante: "Envío de unidad faltante",
    reintegro_total: "Reintegro total",
    reintegro_parcial: "Reintegro parcial",
    saldo_a_favor: "Saldo a favor",
    cupon_descuento: "Nota de crédito",
    rechazado: "Rechazado",
    otro: "Otra solución",
  }

  return resolution ? labels[resolution] ?? resolution : "Sin resolución"
}

export function getClaimDeadline(deliveredAt: string, type: OrderClaimType) {
  const deadline = new Date(deliveredAt)

  if (type === "transporte_48hs") {
    deadline.setTime(deadline.getTime() + TRANSPORT_CLAIM_WINDOW_HOURS * 60 * 60 * 1000)
  } else {
    const originalDay = deadline.getUTCDate()
    deadline.setUTCMonth(deadline.getUTCMonth() + WARRANTY_CLAIM_WINDOW_MONTHS)

    if (deadline.getUTCDate() !== originalDay) {
      deadline.setUTCDate(0)
    }
  }

  return deadline
}

export function isClaimWindowOpen(deliveredAt: string, type: OrderClaimType) {
  return Date.now() >= Date.parse(deliveredAt) && Date.now() <= getClaimDeadline(deliveredAt, type).getTime()
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

// Firmas binarias ("magic bytes") de los formatos más comunes aceptados
// como evidencia. Sólo se usa server-side (app/api/orders/[id]/claims/
// route.ts), después de leer los primeros bytes reales del archivo -- el
// MIME type declarado en el FormData (file.type) lo elige el navegador y es
// 100% falsificable con un POST manual, así que no alcanza como única
// verificación. Los formatos no registrados se rechazan; videos requieren
// encabezados de contenedor. Esto no reemplaza un análisis antimalware.
const CLAIM_FILE_SIGNATURES: Record<string, number[]> = {
  "image/jpeg": [0xff, 0xd8, 0xff],
  "image/png": [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  "image/gif": [0x47, 0x49, 0x46, 0x38],
  "application/pdf": [0x25, 0x50, 0x44, 0x46],
}

/**
 * true si los primeros bytes NO coinciden con la firma esperada para el
 * MIME declarado -- indicio de MIME spoofing (ej. un .html renombrado a
 * .png). Los formatos sin firma registrada fallan cerrados.
 */
export function isClaimFileSignatureMismatch(bytes: Uint8Array, mimeType: string): boolean {
  if (mimeType === "video/mp4" || mimeType === "video/quicktime") {
    const marker = new TextDecoder().decode(bytes.slice(4, 8))
    const brand = new TextDecoder().decode(bytes.slice(8, 12))
    return bytes.length < 24 || marker !== "ftyp" ||
      !(mimeType === "video/quicktime" ? ["qt  "] : ["isom", "iso2", "mp41", "mp42", "avc1", "M4V "]).includes(brand)
  }
  if (mimeType === "video/webm") {
    return bytes.length < 16 || ![0x1a, 0x45, 0xdf, 0xa3].every((value, index) => bytes[index] === value) ||
      !new TextDecoder().decode(bytes.slice(0, 4096)).includes("webm")
  }
  if (mimeType === "image/webp") {
    if (bytes.length < 12) return true
    const riff = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3])
    const webp = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11])
    return riff !== "RIFF" || webp !== "WEBP"
  }

  const signature = CLAIM_FILE_SIGNATURES[mimeType]
  if (!signature) return true

  if (bytes.length < signature.length) return true

  return !signature.every((byte, index) => bytes[index] === byte)
}

export function getClaimFileValidationError(file: File | null | undefined) {
  if (!file) return ""

  if (file.size === 0) {
    return "Uno de los archivos está vacío."
  }

  const extension = file.name.split(".").pop()?.toLowerCase() ?? ""
  if (!CLAIM_FILE_EXTENSIONS[file.type]?.includes(extension) || file.name.length > 180 || /[\u0000-\u001f\u007f/\\]/.test(file.name)) {
    return "Subí una imagen, un video, un PDF válido (JPG, PNG, GIF, WebP, MP4, MOV o WebM)."
  }
  const isImage = file.type.startsWith("image/")
  const isVideo = file.type.startsWith("video/")
  const isDocument = file.type === "application/pdf"

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
