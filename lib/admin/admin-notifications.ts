import {
  clearSupabaseBrowserSession,
  getSafeSupabaseSession,
  isInvalidRefreshTokenError,
  isMissingAuthSessionError,
  supabase,
} from "@/lib/supabase/client"
import {
  isAdminCancellationSensitiveNotification,
  isAdminClaimSensitiveNotification,
  isAdminSensitiveNotification,
} from "@/lib/admin/admin-sensitive-visuals"
import { ADMIN_ROUTES } from "@/lib/admin/admin-routes"
import { getPedidos } from "@/lib/supabase/queries/pedidos"
import type { SupabasePedido } from "@/lib/supabase/types"
import {
  getMercadoLibrePendingReturnUnits,
  isMercadoLibreReturn,
} from "@/lib/mercadolibre/returns"
import {
  getAdminNewOrderEventAt,
  getAdminNewOrderEventKey,
  isAdminOrderVisible,
} from "@/lib/orders/admin-order-visibility"

export const ADMIN_NOTIFICATIONS_CHANGED_EVENT =
  "beyonix:admin-notifications-changed"

export type AdminNotificationType =
  | "order"
  | "message"
  | "payment"
  | "invoice"
  | "shipping"
  | "cancellation"
  | "claim"
  | "mercadolibre_return"
  | "inventory"

export type AdminNotificationTone = AdminNotificationType

export interface AdminNotification {
  id: string
  type: AdminNotificationType
  eventKey: string
  eventAt: string
  title: string
  body: string
  actionLabel?: string
  actionUrl: string
  orderId?: number
  isRead: boolean
  priority?: "attention"
}

export type AdminNotificationGroups = Record<AdminNotificationType, number>

export interface AdminNotificationSummary {
  count: number
  tone: AdminNotificationTone
  groups: AdminNotificationGroups
  notifications: AdminNotification[]
}

type AdminNotificationRead = {
  type: string
  event_key: string
  event_at: string
}

type CreditAdminProfile = {
  id: string
  email?: string | null
  username?: string | null
  nombre?: string | null
  dni?: string | null
  telefono?: string | null
}

type CustomerCreditTopupNotificationRow = {
  id: string
  user_id: string
  amount?: number | string | null
  customer_name?: string | null
  customer_dni?: string | null
  proof_file_name?: string | null
  status: string
  created_at: string
}

const EMPTY_GROUPS: AdminNotificationGroups = {
  order: 0,
  message: 0,
  payment: 0,
  invoice: 0,
  shipping: 0,
  cancellation: 0,
  claim: 0,
  mercadolibre_return: 0,
  inventory: 0,
}

const EMPTY_SUMMARY: AdminNotificationSummary = {
  count: 0,
  tone: "order",
  groups: EMPTY_GROUPS,
  notifications: [],
}

const LOCAL_READ_PREFIX = "beyonix-admin-notification-read"

function getTime(value?: string | null) {
  if (!value) return 0
  const time = new Date(value).getTime()
  return Number.isFinite(time) ? time : 0
}

function sortByEventDate(
  a: { eventAt: string },
  b: { eventAt: string },
) {
  return getTime(b.eventAt) - getTime(a.eventAt)
}

function createGroups(): AdminNotificationGroups {
  return { ...EMPTY_GROUPS }
}

function getLocalReadKey(
  adminId: string,
  type: AdminNotificationType,
  eventKey: string,
) {
  return `${LOCAL_READ_PREFIX}:${adminId}:${type}:${eventKey}`
}

function readLocalEventAt(
  adminId: string,
  type: AdminNotificationType,
  eventKey: string,
) {
  if (typeof window === "undefined") return null
  return window.localStorage.getItem(getLocalReadKey(adminId, type, eventKey))
}

function writeLocalEventAt(
  adminId: string,
  type: AdminNotificationType,
  eventKey: string,
  eventAt: string,
) {
  if (typeof window === "undefined") return
  window.localStorage.setItem(getLocalReadKey(adminId, type, eventKey), eventAt)
}

export function getSupabaseErrorDetails(error: unknown) {
  const candidate =
    typeof error === "object" && error !== null
      ? (error as {
          message?: unknown
          details?: unknown
          hint?: unknown
          code?: unknown
        })
      : null

  return {
    message:
      typeof candidate?.message === "string"
        ? candidate.message
        : error instanceof Error
          ? error.message
          : String(error),
    details: candidate?.details,
    hint: candidate?.hint,
    code: candidate?.code,
    error,
  }
}

async function getCurrentAdminId() {
  const session = await getSafeSupabaseSession()
  if (!session) return null

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser()

  if (error) {
    if (
      isMissingAuthSessionError(error) ||
      isInvalidRefreshTokenError(error)
    ) {
      clearSupabaseBrowserSession()
      return null
    }

    console.error(
      "ADMIN_NOTIFICATIONS_AUTH_ERROR",
      getSupabaseErrorDetails(error),
    )
    return null
  }

  return user?.id ?? null
}

async function getOrderLastSeenAt(adminId: string) {
  const { data, error } = await supabase
    .from("admin_order_views")
    .select("last_seen_at")
    .eq("admin_id", adminId)
    .maybeSingle()

  if (error) return null

  return typeof data?.last_seen_at === "string" ? data.last_seen_at : null
}

function isOrderVisible(order: SupabasePedido) {
  return isAdminOrderVisible(order)
}

function isOrderPaidForInvoice(order: {
  estado?: string | null
  payment_status?: string | null
  paid_at?: string | null
  payment_confirmed_amount?: number | string | null
  total?: number | null
}) {
  if (Number(order.total ?? 0) <= 0) return false
  if (["rechazado", "rejected"].includes(order.payment_status ?? "")) {
    return false
  }

  return (
    Boolean(order.paid_at) ||
    Number(order.payment_confirmed_amount ?? 0) > 0 ||
    order.payment_status === "confirmado" ||
    order.payment_status === "approved" ||
    order.payment_status === "confirmed" ||
    [
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
    ].includes(
      order.estado ?? "",
    )
  )
}

function isPaymentReceived(order: {
  payment_status?: string | null
  paid_at?: string | null
}) {
  return Boolean(order.paid_at) ||
    ["confirmado", "approved", "confirmed"].includes(
      order.payment_status ?? "",
    )
}

function hasPaymentProofPendingReview(order: {
  payment_status?: string | null
  payment_proof_url?: string | null
}) {
  return Boolean(order.payment_proof_url) &&
    ["en_revision", "pendiente_comprobante", "pending"].includes(
      order.payment_status ?? "",
    )
}

function isRefundPaymentAttentionOrder(order: {
  estado?: string | null
  financial_status?: string | null
  payment_status?: string | null
  paid_at?: string | null
  payment_confirmed_amount?: number | string | null
}) {
  if (order.financial_status === "refunded") return false
  if (order.financial_status === "refund_pending") return true

  if (order.financial_status === "cancellation_requested") {
    return isPaymentReceived(order) || Number(order.payment_confirmed_amount ?? 0) > 0
  }

  return (
    order.estado === "cancelado" &&
    (isPaymentReceived(order) || Number(order.payment_confirmed_amount ?? 0) > 0)
  )
}

function isAdminCancelledOrder(order: {
  estado?: string | null
  financial_status?: string | null
}) {
  return (
    order.estado === "cancelado" ||
    ["cancelled", "cancellation_requested", "refund_pending", "refunded"].includes(
      order.financial_status ?? "",
    )
  )
}

function hasCancellationAdminAttention(order: {
  estado?: string | null
  financial_status?: string | null
  payment_status?: string | null
  payment_proof_url?: string | null
  paid_at?: string | null
  payment_confirmed_amount?: number | string | null
}) {
  if (order.financial_status === "refunded") return false
  if (order.financial_status === "refund_pending") return true
  if (order.financial_status === "cancellation_requested") return true

  return (
    order.estado === "cancelado" &&
    (
      isPaymentReceived(order) ||
      Number(order.payment_confirmed_amount ?? 0) > 0 ||
      hasPaymentProofPendingReview(order)
    )
  )
}

function isOrderReadyForShipping(order: {
  estado?: string | null
  financial_status?: string | null
  invoice_status?: string | null
  invoice_cae?: string | null
}) {
  if (isRefundPaymentAttentionOrder(order)) return false
  if (order.invoice_status !== "authorized" || !order.invoice_cae) return false
  if (
    ["cancelled", "cancellation_requested", "refund_pending", "refunded"].includes(
      order.financial_status ?? "",
    )
  ) {
    return false
  }

  return ![
    "preparado",
    "enviado",
    "en_camino",
    "entregado",
    "cancelado",
    "rechazado",
  ].includes(order.estado ?? "")
}

function claimNeedsAdminAttention(claim: {
  admin_needs_action?: boolean | null
  first_reviewed_at?: string | null
  last_customer_message_at?: string | null
  last_admin_response_at?: string | null
  status?: string | null
}) {
  if (claim.admin_needs_action) return true
  if (["cerrado", "rechazado"].includes(claim.status ?? "")) return false
  if (!claim.first_reviewed_at) return true
  return getTime(claim.last_customer_message_at) > getTime(claim.last_admin_response_at)
}

function formatOrderId(orderId: number) {
  return `#BX-${1000 + orderId}`
}

function formatProfileDetails(profile?: CreditAdminProfile | null) {
  if (!profile) return "Cliente sin perfil"

  return [
    profile.nombre || "Sin nombre",
    profile.email ? `Email: ${profile.email}` : "Sin email",
    profile.username ? `Usuario: ${profile.username}` : null,
    profile.dni ? `DNI: ${profile.dni}` : null,
    profile.telefono ? `Tel: ${profile.telefono}` : null,
  ]
    .filter(Boolean)
    .join(" · ")
}

async function loadCreditProfiles(userIds: string[]) {
  const uniqueUserIds = [...new Set(userIds.filter(Boolean))]
  const profiles = new Map<string, CreditAdminProfile>()

  if (uniqueUserIds.length === 0) return profiles

  const { data, error } = await supabase
    .from("profiles")
    .select("id, email, username, nombre, dni, telefono")
    .in("id", uniqueUserIds)

  if (error) {
    console.warn(
      "ADMIN_CREDIT_PROFILES_LOAD_ERROR",
      getSupabaseErrorDetails(error),
    )
    return profiles
  }

  for (const profile of (data ?? []) as CreditAdminProfile[]) {
    profiles.set(profile.id, profile)
  }

  return profiles
}

async function getCreditAdminNotifications() {
  const notifications: AdminNotification[] = []
  const { data: topups, error: topupsError } = await supabase
    .from("customer_credit_topups")
    .select("id, user_id, amount, customer_name, customer_dni, proof_file_name, status, created_at")
    .eq("status", "en_revision")
    .order("created_at", { ascending: false })
    .limit(60)

  if (topupsError) {
    console.warn(
      "ADMIN_CREDIT_TOPUPS_LOAD_ERROR",
      getSupabaseErrorDetails(topupsError),
    )
  }

  const topupRows = (topups ?? []) as CustomerCreditTopupNotificationRow[]
  const profiles = await loadCreditProfiles(
    topupRows.map((topup) => topup.user_id),
  )

  for (const topup of topupRows) {
    const profile = profiles.get(topup.user_id)
    notifications.push({
      id: `balance-topup:${topup.id}`,
      type: "payment",
      eventKey: `balance-topup:${topup.id}`,
      eventAt: String(topup.created_at),
      title: "Nuevo comprobante para cargar saldo",
      body: `${formatProfileDetails(profile)} · Revisá la transferencia e ingresá el monto recibido${topup.proof_file_name ? ` · Archivo: ${topup.proof_file_name}` : ""}`,
      actionLabel: "Revisar en Clientes",
      actionUrl: ADMIN_ROUTES.clientes,
      isRead: false,
    })
  }

  return notifications
}

type MercadoLibreReturnNotificationRow = {
  id: string
  operation_id?: string | null
  product_id?: number | null
  product_name: string
  quantity: number | string
  imported_at: string
  raw_data?: Record<string, unknown> | null
}

type MercadoLibreReturnReviewNotificationRow = {
  mercadolibre_sale_id: string
  received_quantity: number | string
  sellable_quantity: number | string
  discounted_quantity: number | string
  non_sellable_quantity: number | string
}

async function getMercadoLibreReturnNotifications() {
  const sales: MercadoLibreReturnNotificationRow[] = []

  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("mercadolibre_sales")
      .select(
        "id, operation_id, product_id, product_name, quantity, imported_at, raw_data",
      )
      .order("imported_at", { ascending: false })
      .range(from, from + 999)

    if (error) {
      console.warn(
        "ADMIN_MERCADOLIBRE_RETURNS_LOAD_ERROR",
        getSupabaseErrorDetails(error),
      )
      return []
    }

    sales.push(
      ...((data ?? []) as unknown as MercadoLibreReturnNotificationRow[]),
    )
    if (!data || data.length < 1000) break
  }

  const returnedSales = sales.filter(isMercadoLibreReturn)
  if (returnedSales.length === 0) return []

  const reviews: MercadoLibreReturnReviewNotificationRow[] = []
  const saleIds = returnedSales.map((sale) => sale.id)

  for (let index = 0; index < saleIds.length; index += 400) {
    const { data, error } = await supabase
      .from("inventory_return_movements")
      .select(
        "mercadolibre_sale_id, received_quantity, sellable_quantity, discounted_quantity, non_sellable_quantity",
      )
      .in("mercadolibre_sale_id", saleIds.slice(index, index + 400))

    if (error) {
      console.warn(
        "ADMIN_MERCADOLIBRE_RETURN_REVIEWS_LOAD_ERROR",
        getSupabaseErrorDetails(error),
      )
      return []
    }

    reviews.push(
      ...((data ?? []) as unknown as MercadoLibreReturnReviewNotificationRow[]),
    )
  }

  const reviewBySale = new Map(
    reviews.map((review) => [String(review.mercadolibre_sale_id), review]),
  )

  return returnedSales.flatMap<AdminNotification>((sale) => {
    const review = reviewBySale.get(sale.id)
    const pendingQuantity = getMercadoLibrePendingReturnUnits({
      quantity: sale.quantity,
      return_review: review,
    })

    if (pendingQuantity === 0 && sale.product_id) return []

    const operation = sale.operation_id
      ? `#${sale.operation_id}`
      : sale.id.slice(0, 8)
    const unitsLabel =
      pendingQuantity === 1 ? "1 unidad" : `${pendingQuantity} unidades`
    const body = !sale.product_id
      ? `Venta ML ${operation} · ${sale.product_name}. Vinculá el producto y revisá el ajuste de inventario.`
      : review
        ? `Venta ML ${operation} · ${sale.product_name}. Quedan ${unitsLabel} sin clasificar para completar el ajuste.`
        : `Venta ML ${operation} · ${sale.product_name} · ${unitsLabel}. Revisá cuántas vuelven al stock y corregí la diferencia.`

    return [
      {
        id: `mercadolibre-return:${sale.id}`,
        type: "mercadolibre_return",
        eventKey: `mercadolibre-return:${sale.id}`,
        eventAt: sale.imported_at,
        title: "Devolución de Mercado Libre pendiente",
        body,
        actionLabel: "Revisar en Ventas ML",
        actionUrl: `${ADMIN_ROUTES.dashboard}?tab=ml&mlSale=${encodeURIComponent(sale.id)}`,
        isRead: false,
        priority: "attention",
      },
    ]
  })
}

type InventoryIntegrityNotificationRow = {
  product_id: number | string
  product_name: string
  stored_normal_stock: number | string
  calculated_normal_stock: number | string
  stored_variant_stock: number | string
  calculated_variant_stock: number | string
  generic_balance: number | string
  allocation_overflow: number | string
  pending_review_stock: number | string
  issues?: string[] | null
}

type InventoryVariantDiagnosticNotificationRow = {
  product_id: number | string
  variant_id: number | string
  variant_name: string
  actual_stock: number | string
  expected_stock: number | string
  difference: number | string
  duplicated_allocation: number | string
  possible_cause_movement_id?: string | null
}

async function getInventoryIntegrityNotifications() {
  const session = await getSafeSupabaseSession()
  if (!session?.access_token) return []

  const response = await fetch("/api/admin/inventory/notification-diagnostics", {
    headers: { Authorization: `Bearer ${session.access_token}` },
    cache: "no-store",
  })

  if (!response.ok) {
    console.warn(
      "ADMIN_INVENTORY_INTEGRITY_LOAD_ERROR",
      { status: response.status },
    )
    return []
  }

  const result = (await response.json()) as {
    integrity?: InventoryIntegrityNotificationRow[]
    diagnostics?: InventoryVariantDiagnosticNotificationRow[]
  }
  const data = result.integrity ?? []

  const diagnosticByProduct = new Map<number, InventoryVariantDiagnosticNotificationRow>()
  for (const diagnostic of result.diagnostics ?? []) {
    if (
      Number(diagnostic.difference) !== 0 ||
      Number(diagnostic.duplicated_allocation) > 0
    ) {
      diagnosticByProduct.set(Number(diagnostic.product_id), diagnostic)
    }
  }

  const eventAt = new Date().toISOString()
  return (
    (data ?? []) as unknown as InventoryIntegrityNotificationRow[]
  ).flatMap<AdminNotification>((row) => {
    const issues = Array.isArray(row.issues) ? row.issues : []
    const hasNegativeStock =
      Number(row.stored_normal_stock) < 0 ||
      Number(row.stored_variant_stock) < 0 ||
      Number(row.generic_balance) < 0
    const overflow = Math.max(0, Number(row.allocation_overflow ?? 0))
    const pendingReview = Math.max(0, Number(row.pending_review_stock ?? 0))
    const diagnostic = diagnosticByProduct.get(Number(row.product_id))
    if (
      issues.length === 0 &&
      !hasNegativeStock &&
      overflow === 0 &&
      pendingReview === 0 &&
      !diagnostic
    ) {
      return []
    }

    const details = [
      diagnostic
        ? `variante ${diagnostic.variant_name}: diferencia ${Number(diagnostic.difference) >= 0 ? "+" : ""}${Number(diagnostic.difference)}`
        : null,
      diagnostic
        ? `esperado ${diagnostic.expected_stock}, actual ${diagnostic.actual_stock}`
        : null,
      hasNegativeStock ? "stock negativo" : null,
      overflow > 0 ? `${overflow} unidades distribuidas de más` : null,
      pendingReview > 0 ? `${pendingReview} unidades sin clasificar` : null,
      issues.includes("PRODUCT_STOCK_MISMATCH")
        ? "el producto no coincide con el libro"
        : null,
      issues.includes("VARIANT_STOCK_MISMATCH")
        ? "las variantes no coinciden con el libro"
        : null,
      issues.includes("PRODUCT_AND_VARIANT_SKU")
        ? "SKU duplicado entre producto y variante"
        : null,
      diagnostic?.possible_cause_movement_id
        ? `posible movimiento ${diagnostic.possible_cause_movement_id}`
        : null,
    ].filter(Boolean)

    return [{
      id: `inventory-integrity:${row.product_id}`,
      type: "inventory",
      eventKey: `inventory-integrity:${row.product_id}`,
      eventAt,
      title: "Inventario requiere conciliación",
      body: `${row.product_name}: ${details.join(" · ")}.`,
      actionLabel: "Abrir diagnóstico",
      actionUrl: `/admin/inventario?productId=${encodeURIComponent(String(row.product_id))}`,
      isRead: false,
      priority: "attention",
    }]
  })
}

async function loadReads(
  adminId: string,
  notifications: AdminNotification[],
) {
  const reads = new Map<string, string>()
  if (notifications.length === 0) return reads

  const eventKeys = notifications.map((notification) => notification.eventKey)

  const { data, error } = await supabase
    .from("admin_notification_reads")
    .select("type, event_key, event_at")
    .eq("admin_id", adminId)
    .in("event_key", eventKeys)

  if (!error) {
    for (const row of (data ?? []) as AdminNotificationRead[]) {
      reads.set(`${row.type}:${row.event_key}`, row.event_at)
    }
    return reads
  }

  console.warn(
    "ADMIN_NOTIFICATION_READS_LOAD_ERROR",
    getSupabaseErrorDetails(error),
  )

  for (const notification of notifications) {
    const localEventAt = readLocalEventAt(
      adminId,
      notification.type,
      notification.eventKey,
    )
    if (localEventAt) {
      reads.set(`${notification.type}:${notification.eventKey}`, localEventAt)
    }
  }

  return reads
}

function applyReads(
  notifications: AdminNotification[],
  reads: Map<string, string>,
) {
  return notifications
    .map((notification) => {
      if (isPendingAdminTask(notification)) {
        return {
          ...notification,
          isRead: false,
        }
      }

      const readEventAt = reads.get(
        `${notification.type}:${notification.eventKey}`,
      )

      return {
        ...notification,
        isRead: getTime(readEventAt) >= getTime(notification.eventAt),
      }
    })
    .filter((notification) => !notification.isRead)
    .sort(sortByEventDate)
}

function dedupeNotifications(notifications: AdminNotification[]) {
  const seen = new Set<string>()
  return notifications.filter((notification) => {
    const key =
      notification.type === "claim" && notification.orderId
        ? `${notification.type}:${notification.eventKey}:${notification.orderId}`
        : `${notification.type}:${notification.eventKey}`

    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function isPendingAdminTask(notification: AdminNotification) {
  return (
    notification.type === "payment" ||
    notification.type === "shipping" ||
    notification.type === "invoice" ||
    notification.type === "cancellation" ||
    notification.type === "claim" ||
    notification.type === "mercadolibre_return" ||
    notification.type === "inventory"
  )
}

function getOperationalPriority(notification: AdminNotification) {
  if (notification.type === "claim") return 5
  if (notification.type === "mercadolibre_return") return 5
  if (notification.type === "inventory") return 5
  if (notification.type === "payment") return 4
  if (notification.type === "shipping") return 3
  if (notification.type === "message") return 2
  if (notification.type === "invoice") return 1
  if (notification.type === "cancellation") return 1
  return 0
}

function keepLatestNotificationByOrder(notifications: AdminNotification[]) {
  const byOrder = new Map<number, AdminNotification>()
  const withoutOrder: AdminNotification[] = []

  for (const notification of notifications) {
    if (!notification.orderId) {
      withoutOrder.push(notification)
      continue
    }

    const current = byOrder.get(notification.orderId)
    const notificationTime = getTime(notification.eventAt)
    const currentTime = getTime(current?.eventAt)
    if (
      !current ||
      notificationTime > currentTime ||
      (notificationTime === currentTime &&
        getOperationalPriority(notification) > getOperationalPriority(current))
    ) {
      byOrder.set(notification.orderId, notification)
    }
  }

  return [...withoutOrder, ...byOrder.values()].sort(sortByEventDate)
}

function getCancellationNotificationContent(
  order: {
    id: number
    payment_status?: string | null
    payment_proof_url?: string | null
    paid_at?: string | null
    payment_confirmed_amount?: number | string | null
    financial_status?: string | null
  },
) {
  const orderCode = formatOrderId(order.id)

  if (order.financial_status === "refund_pending") {
    return {
      title: "Pedido cancelado con pago confirmado - reintegro pendiente",
      body: `${orderCode} requiere reintegro pendiente. Revisá el comprobante de pago y cargá el comprobante de reintegro.`,
      priority: "attention" as const,
    }
  }

  if (order.financial_status === "cancellation_requested") {
    if (isPaymentReceived(order) || Number(order.payment_confirmed_amount ?? 0) > 0) {
      return {
        title: "Pedido cancelado con pago confirmado - reintegro pendiente",
        body: `${orderCode} requiere reintegro pendiente. Revisá el comprobante de pago y cargá el comprobante de reintegro.`,
        priority: "attention" as const,
      }
    }

    return {
      title: "Pedido cancelado con comprobante pendiente",
      body: `${orderCode} fue cancelado con comprobante enviado. Revisá si corresponde confirmar el pago y reintegrar.`,
      priority: "attention" as const,
    }
  }

  if (isPaymentReceived(order)) {
    return {
      title: "Compra cancelada con pago recibido",
      body: `El pedido ${orderCode} fue cancelado por el cliente y tiene un pago recibido. Revisá la gestión del reintegro o crédito.`,
      priority: "attention" as const,
    }
  }

  if (hasPaymentProofPendingReview(order)) {
    return {
      title: "Compra cancelada con comprobante cargado",
      body: `El pedido ${orderCode} fue cancelado por el cliente y tenía un comprobante pendiente de revisión.`,
      priority: "attention" as const,
    }
  }

  return {
    title: "Compra cancelada",
    body: `El pedido ${orderCode} fue cancelado por el cliente.`,
  }
}

function getTone(
  groups: AdminNotificationGroups,
  notifications: AdminNotification[],
): AdminNotificationTone {
  if (groups.claim > 0 || notifications.some(isAdminClaimSensitiveNotification)) {
    return "claim"
  }
  const nonMercadoLibreNotifications = notifications.filter(
    (notification) => notification.type !== "mercadolibre_return",
  )
  if (
    groups.cancellation > 0 ||
    nonMercadoLibreNotifications.some(
      (notification) =>
        notification.priority === "attention" ||
        isAdminCancellationSensitiveNotification(notification) ||
        isAdminSensitiveNotification(notification),
    )
  ) {
    return "cancellation"
  }
  if (groups.mercadolibre_return > 0) return "mercadolibre_return"
  if (groups.payment > 0) return "payment"
  if (groups.shipping > 0) return "shipping"
  if (groups.message > 0) return "message"
  if (groups.invoice > 0) return "invoice"
  return "order"
}

function buildSummary(notifications: AdminNotification[]): AdminNotificationSummary {
  const groups = createGroups()

  for (const notification of notifications) {
    groups[notification.type] += 1
  }

  return {
    count: notifications.length,
    tone: getTone(groups, notifications),
    groups,
    notifications,
  }
}

export async function getAdminNotifications(): Promise<AdminNotificationSummary> {
  try {
    const adminId = await getCurrentAdminId()
    if (!adminId) return EMPTY_SUMMARY

    const [
      pedidos,
      orderLastSeenAt,
      creditNotifications,
      mercadoLibreReturnNotifications,
      inventoryIntegrityNotifications,
    ] = await Promise.all([
      getPedidos({ notificationView: true }),
      getOrderLastSeenAt(adminId),
      getCreditAdminNotifications(),
      getMercadoLibreReturnNotifications(),
      getInventoryIntegrityNotifications(),
    ])

    const orders = pedidos.pedidos.filter(isOrderVisible)
    const orderIds = new Set(orders.map((order) => Number(order.id)))
    const rawClaims = orders.flatMap((order) =>
      (order.order_claims ?? []).map((claim) => ({
        ...claim,
        order_id: claim.order_id ?? order.id,
      })),
    )
    const claims = [...new Map(rawClaims.map((claim) => [claim.id, claim])).values()]
    const claimsById = new Map(
      claims.map((claim) => [Number(claim.id), claim]),
    )
    const customerMessages = claims
      .flatMap((claim) =>
        (claim.order_claim_messages ?? []).map((message) => ({
          ...message,
          claim_id: message.claim_id ?? claim.id,
        })),
      )
      .filter((message) => message.author_role === "cliente")
      .sort((a, b) => getTime(b.created_at) - getTime(a.created_at))
      .slice(0, 200)
    const notifications: AdminNotification[] = []

    notifications.push(...creditNotifications)
    notifications.push(...mercadoLibreReturnNotifications)
    notifications.push(...inventoryIntegrityNotifications)

    for (const order of orders) {
      const orderId = Number(order.id)
      const newOrderEventAt = getAdminNewOrderEventAt(order)

      if (
        newOrderEventAt &&
        (!orderLastSeenAt ||
          getTime(newOrderEventAt) > getTime(orderLastSeenAt))
      ) {
        const eventKey = getAdminNewOrderEventKey(orderId)
        notifications.push({
          id: eventKey,
          type: "order",
          eventKey,
          eventAt: newOrderEventAt,
          title: "Pedido nuevo",
          body: `Ingresó el pedido ${formatOrderId(orderId)}.`,
          actionUrl: `${ADMIN_ROUTES.pedidos}/${orderId}`,
          orderId,
          isRead: false,
        })
      }

      if (
        order.payment_proof_url &&
        order.payment_status === "en_revision" &&
        order.payment_proof_uploaded_at &&
        !isAdminCancelledOrder(order) &&
        !isRefundPaymentAttentionOrder(order)
      ) {
        notifications.push({
          id: `payment:${orderId}`,
          type: "payment",
          eventKey: `payment:${orderId}`,
          eventAt: String(order.payment_proof_uploaded_at),
          title: "Nuevo comprobante recibido",
          body: `Pedido ${formatOrderId(orderId)}`,
          actionLabel: "Ver comprobante",
          actionUrl: `${ADMIN_ROUTES.pedidos}/${orderId}?tab=pago`,
          orderId,
          isRead: false,
        })
      }

      if (
        isOrderPaidForInvoice(order) &&
        !order.invoice_cae &&
        (
          order.invoice_status == null ||
          order.invoice_status === "pending" ||
          order.invoice_status === "error"
        )
      ) {
        notifications.push({
          id: `invoice:${orderId}`,
          type: "invoice",
          eventKey: `invoice:${orderId}`,
          eventAt: String(order.paid_at || order.created_at),
          title: "Factura por emitir",
          body: `El pedido ${formatOrderId(orderId)} está listo para facturar.`,
          actionUrl: `${ADMIN_ROUTES.pedidos}/${orderId}?tab=facturacion`,
          orderId,
          isRead: false,
        })
      }

      if (!isRefundPaymentAttentionOrder(order) && isOrderReadyForShipping(order)) {
        notifications.push({
          id: `shipping:${orderId}`,
          type: "shipping",
          eventKey: `shipping:${orderId}`,
          eventAt: String(
            order.invoice_created_at || order.paid_at || order.created_at,
          ),
          title: "Envío pendiente",
          body: `El pedido ${formatOrderId(orderId)} ya está facturado y listo para preparar/enviar.`,
          actionLabel: "Ver envío",
          actionUrl: `${ADMIN_ROUTES.pedidos}/${orderId}?tab=envio`,
          orderId,
          isRead: false,
        })
      }

      if (hasCancellationAdminAttention(order)) {
        const cancelledAt =
          (order as {
            cancelled_at?: string | null
            cancellation_requested_at?: string | null
            refund_pending_at?: string | null
          }).refund_pending_at ||
          (order as {
            cancelled_at?: string | null
            cancellation_requested_at?: string | null
            refund_pending_at?: string | null
          }).cancellation_requested_at ||
          (order as { cancelled_at?: string | null }).cancelled_at

        if (!cancelledAt) continue
        const cancellationContent = getCancellationNotificationContent({
          id: orderId,
          payment_status: order.payment_status,
          payment_proof_url: order.payment_proof_url,
          paid_at: order.paid_at,
          payment_confirmed_amount: order.payment_confirmed_amount,
          financial_status: order.financial_status,
        })
        const refundAttention = isRefundPaymentAttentionOrder(order)
        const notificationType: AdminNotificationType = "cancellation"
        const eventKey =
          refundAttention
            ? `cancellation-refund:${orderId}`
            : `order-cancelled:${orderId}`

        notifications.push({
          id: eventKey,
          type: notificationType,
          eventKey,
          eventAt: String(cancelledAt),
          title: cancellationContent.title,
          body: cancellationContent.body,
          actionLabel: "Ver cancelación",
          actionUrl: `${ADMIN_ROUTES.pedidos}/${orderId}?tab=cancelacion`,
          orderId,
          isRead: false,
          priority: cancellationContent.priority,
        })
      }
    }

    for (const claim of claims) {
      if (!claimNeedsAdminAttention(claim)) continue

      const orderId = Number(claim.order_id)
      const helpMessage = claim.failure_type === "consulta_pedido"
      notifications.push({
        id: `claim:${claim.id}`,
        type: "claim",
        eventKey: `claim:${claim.id}`,
        eventAt: String(
          claim.last_customer_message_at || claim.created_at,
        ),
        title: helpMessage ? "Mensaje de ayuda por responder" : "Reclamo por responder",
        body: helpMessage
          ? `El mensaje de ayuda del pedido ${formatOrderId(orderId)} requiere atención.`
          : `El reclamo del pedido ${formatOrderId(orderId)} requiere atención.`,
        actionUrl: `${ADMIN_ROUTES.pedidos}/${orderId}?tab=reclamos`,
        orderId,
        isRead: false,
      })
    }

    for (const message of customerMessages) {
      const claim = claimsById.get(Number(message.claim_id))
      if (!claim?.first_reviewed_at) continue
      if (!claimNeedsAdminAttention(claim)) continue
      if (!orderIds.has(Number(claim.order_id))) continue

      const orderId = Number(claim.order_id)
      const body =
        typeof message.message === "string" && message.message.trim()
          ? message.message.trim()
          : `Nuevo mensaje en el pedido ${formatOrderId(orderId)}.`

      notifications.push({
        id: `message:${message.id}`,
        type: "message",
        eventKey: `message:${message.id}`,
        eventAt: String(message.created_at),
        title: "Mensaje nuevo",
        body: body.length > 110 ? `${body.slice(0, 107)}...` : body,
        actionUrl: `${ADMIN_ROUTES.pedidos}/${orderId}?tab=reclamos`,
        orderId,
        isRead: false,
      })
    }

    const dedupedNotifications = dedupeNotifications(notifications)
    const latestNotifications = keepLatestNotificationByOrder(dedupedNotifications)
    const reads = await loadReads(adminId, latestNotifications)
    const unreadNotifications = applyReads(latestNotifications, reads)
    return buildSummary(
      unreadNotifications.filter(
        (notification) =>
          isPendingAdminTask(notification) || notification.type === "order",
      ),
    )
  } catch (error) {
    console.error(
      "ADMIN_NOTIFICATIONS_UNEXPECTED_ERROR",
      getSupabaseErrorDetails(error),
    )
    return EMPTY_SUMMARY
  }
}

async function markNotificationsRead(
  notifications: AdminNotification[],
) {
  if (notifications.length === 0) return

  const adminId = await getCurrentAdminId()
  if (!adminId) return

  const now = new Date().toISOString()
  const rows = notifications.map((notification) => {
    writeLocalEventAt(
      adminId,
      notification.type,
      notification.eventKey,
      notification.eventAt,
    )

    return {
      admin_id: adminId,
      type: notification.type,
      event_key: notification.eventKey,
      event_at: notification.eventAt,
      read_at: now,
      updated_at: now,
    }
  })

  const { error } = await supabase
    .from("admin_notification_reads")
    .upsert(rows, { onConflict: "admin_id,type,event_key" })

  if (error) {
    console.warn(
      "ADMIN_NOTIFICATION_READS_UPSERT_ERROR",
      getSupabaseErrorDetails(error),
    )
  }

  notifyAdminNotificationsChanged()
}

export async function markAdminNotificationRead(
  notification: AdminNotification,
) {
  await markNotificationsRead([notification])
}

export async function markAdminOrderNewNotificationRead(orderId: number) {
  const summary = await getAdminNotifications()
  const notification = summary.notifications.find(
    (item) => item.type === "order" && item.orderId === orderId,
  )

  if (!notification) return

  await markNotificationsRead([notification])
}

export async function markAdminShippingNotificationRead(orderId: number) {
  const summary = await getAdminNotifications()
  const notification = summary.notifications.find(
    (item) => item.type === "shipping" && item.orderId === orderId,
  )

  if (!notification) return

  await markNotificationsRead([notification])
}

export async function markAdminClaimNotificationsRead(orderId: number) {
  const summary = await getAdminNotifications()
  const notifications = summary.notifications.filter(
    (item) => item.type === "claim" && item.orderId === orderId,
  )

  if (notifications.length === 0) return

  await markNotificationsRead(notifications)
}

export function notifyAdminNotificationsChanged() {
  if (typeof window === "undefined") return
  window.dispatchEvent(new Event(ADMIN_NOTIFICATIONS_CHANGED_EVENT))
}
