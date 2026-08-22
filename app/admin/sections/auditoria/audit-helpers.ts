import type { SupabaseAuditLog } from "@/lib/supabase/types"
import { formatARS } from "@/lib/customer-credit"
import { formatPublicOrderId } from "@/lib/account/account-formatters"
import {
  emptyAuditEntityMaps,
  resolveCategoryName,
  resolveProductName,
  resolveUserName,
  resolveVariantName,
  type AuditEntityMaps,
} from "./audit-entity-resolver"

export type AuditSeverity = "normal" | "importante" | "critico"
export type AuditActionFilter = "all" | SupabaseAuditLog["action"] | "UNDONE"

export interface AuditDescription {
  title: string
  lines: string[]
}

export interface AuditLogGroup {
  id: string
  logs: SupabaseAuditLog[]
  primaryLog: SupabaseAuditLog
  kind: "product_delete" | "variant_principal_change" | "stock_adjustment" | "single"
}

const humanFieldNames: Record<string, string> = {
  activo: "Estado",
  affected_count: "Productos afectados",
  amount: "Importe",
  article_name: "Artículo",
  category: "Categoría del gasto",
  cleaned_count: "Productos corregidos",
  category_id: "Categoría",
  categoria_id: "Categoría",
  color_hex: "Color",
  commission_cost: "Comisión",
  description: "Descripción",
  created_from: "Origen",
  created_by: "Creado por",
  descripcion: "Descripción",
  destacado: "Destacado",
  descuento: "Descuento",
  document_number: "Comprobante",
  document_type: "Tipo de comprobante",
  estado: "Estado",
  event_name: "Evento",
  event_type: "Tipo de evento",
  expense_date: "Fecha del gasto",
  freight_cost: "Costo de flete",
  image_url: "Imagen",
  last_sign_in_at: "Último inicio",
  imagen_principal: "Imagen principal",
  imagenes: "Imágenes",
  name: "Nombre",
  nombre: "Nombre",
  notes: "Notas",
  movement_type: "Operación",
  orden: "Orden",
  orden_id: "Pedido",
  order_id: "Pedido",
  pedido_id: "Pedido",
  other_cost: "Otros costos",
  payment_method: "Medio de pago",
  price: "Precio",
  precio: "Precio",
  precio_anterior: "Precio anterior",
  producto_id: "Producto",
  product_id: "Producto",
  purchase_date: "Fecha de compra",
  quantity: "Cantidad",
  received_quantity: "Cantidad recibida",
  reception_status: "Estado de recepción",
  recurrence: "Recurrencia",
  restored_count: "Productos restaurados",
  rol: "Permisos",
  sku: "SKU",
  slug: "Slug",
  status: "Estado",
  source_kind: "Tipo de movimiento",
  stock: "Stock",
  stock_adjustment_reason: "Motivo del ajuste",
  stock_adjustment_delta: "Diferencia aplicada",
  supplier: "Proveedor",
  tax_cost: "Impuestos",
  tax_deductible: "Deducible de impuestos",
  total: "Total",
  total_cost: "Costo total",
  target_email: "Email de la cuenta",
  target_name: "Cuenta afectada",
  target_user_id: "Cuenta",
  resulting_balance: "Saldo resultante",
  tracking_number: "Número de seguimiento",
  tracking_url: "Link de seguimiento",
  unit_cost: "Costo unitario",
  updated_by: "Actualizado por",
  url: "Imagen",
  variant_id: "Variante",
  variante_id: "Variante",
}

// Tablas sin un formateador dedicado: etiqueta humana para el título
// genérico ("{Tabla} modificado · {nombre}") en vez del nombre técnico
// de la tabla de base de datos.
const humanTableNames: Record<string, string> = {
  banners: "Banner",
  business_expenses: "Gasto",
  categorias: "Categoría",
  configuracion_visual: "Configuración visual",
  customer_notification_campaigns: "Campaña de notificaciones",
  hero_banners: "Banner",
  inventory_variant_allocations: "Asignación de inventario",
  mercadolibre_sales: "Venta de MercadoLibre",
  metodos_envio: "Método de envío",
  metodos_pago: "Método de pago",
  payment_methods: "Método de pago",
  product_bulk_events: "Evento comercial",
  product_cost_entries: "Compra de stock",
  shipping_methods: "Método de envío",
  site_banner_items: "Banner",
  site_settings: "Configuración",
  store_settings: "Configuración",
}

const ignoredFields = new Set([
  "actor_user_id",
  "after_data",
  "before_data",
  "checkout_idempotency_key",
  "created_at",
  "id",
  "idempotency_key",
  "record_id",
  "table_name",
  "updated_at",
  "user_id",
])

const operationalTables = new Set([
  "cart_items",
  "carritos",
  "checkout_sessions",
  "client_carts",
  "client_presence",
  "mercadopago_events",
  "orden_items",
  "order_items",
  "payments",
  "stock_reservations",
])

const orderTables = new Set(["ordenes", "orders"])

const manualOrderFields = new Set([
  "andreani_estado",
  "andreani_tracking",
  "estado",
  "internal_notes",
  "nota_interna",
  "notas_internas",
  "shipping_status",
  "tracking_number",
  "tracking_url",
])

const automaticOrderFields = new Set([
  "paid_at",
  "payment_id",
  "payment_method_id",
  "payment_status",
  "payment_type_id",
  "preference_id",
])

const nonAuditableEventTypes = new Set([
  "open_detail",
  "page_view",
  "product_view",
  "view",
  "view_order",
  "view_product",
])

const reversibleTables = new Set([
  "banners",
  "categorias",
  "configuracion_visual",
  "hero_banners",
  "imagenes_producto",
  "metodos_envio",
  "metodos_pago",
  "payment_methods",
  "producto_especificaciones",
  "producto_variantes",
  "productos",
  "shipping_methods",
  "site_settings",
  "store_settings",
])

const criticalFields = new Set(["rol", "role", "admin", "is_admin", "permisos"])
const importantFields = new Set([
  "activo",
  "descuento",
  "estado",
  "precio",
  "precio_anterior",
  "price",
  "status",
  "stock",
])

export function isUndoAuditEvent(log: SupabaseAuditLog) {
  return log.table_name === "admin_events" && log.after_data?.event_type === "undo_audit_log"
}

export function formatAuditDate(value: string) {
  return new Intl.DateTimeFormat("es-AR", {
    dateStyle: "short",
  }).format(new Date(value))
}

export function formatAuditTime(value: string) {
  return new Intl.DateTimeFormat("es-AR", {
    timeStyle: "medium",
  }).format(new Date(value))
}

interface ReferenceFieldConfig {
  resolve: (maps: AuditEntityMaps, value: unknown) => string | null
  noun: string
  // Los pedidos se identifican con su número público (cálculo puro sobre el
  // id, ver formatPublicOrderId): no hay "no disponible" posible porque no
  // dependen de una consulta que pueda no encontrar la fila.
  alwaysResolvable?: boolean
}

const referenceFieldConfigs: Record<string, ReferenceFieldConfig> = {
  categoria_id: { resolve: resolveCategoryName, noun: "categoría" },
  category_id: { resolve: resolveCategoryName, noun: "categoría" },
  producto_id: { resolve: resolveProductName, noun: "producto" },
  product_id: { resolve: resolveProductName, noun: "producto" },
  variant_id: { resolve: resolveVariantName, noun: "variante" },
  variante_id: { resolve: resolveVariantName, noun: "variante" },
  created_by: { resolve: resolveUserName, noun: "usuario" },
  updated_by: { resolve: resolveUserName, noun: "usuario" },
  target_user_id: { resolve: resolveUserName, noun: "usuario" },
  orden_id: { resolve: resolveOrderLabel, noun: "pedido", alwaysResolvable: true },
  order_id: { resolve: resolveOrderLabel, noun: "pedido", alwaysResolvable: true },
  pedido_id: { resolve: resolveOrderLabel, noun: "pedido", alwaysResolvable: true },
}

function resolveOrderLabel(_maps: AuditEntityMaps, value: unknown) {
  const id = Number(value)
  return Number.isFinite(id) ? formatPublicOrderId(id) : null
}

function capitalize(text: string) {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

// Para "Ver detalle": si el campo es una relación conocida (producto_id,
// variant_id, categoria_id, usuario, pedido), muestra el nombre resuelto en
// vez del ID numérico crudo. Si el ID ya no existe (registro eliminado),
// nunca vuelve a mostrar el número: dice explícitamente que no está
// disponible. El ID sigue accesible en "Información técnica".
export function resolveFieldDisplayValue(
  field: string,
  value: unknown,
  maps: AuditEntityMaps,
  context: "before" | "after" = "after",
) {
  const config = referenceFieldConfigs[field]
  if (config) {
    if (value === null || value === undefined || value === "") return formatTechnicalValue(value)

    const resolved = config.resolve(maps, value)
    if (resolved) return resolved
    if (config.alwaysResolvable) return formatTechnicalValue(value)
    // Todavía no llegó la primera tanda de consultas: mejor un genérico
    // transitorio que una afirmación incorrecta de "no disponible".
    if (!maps.ready) return capitalize(config.noun)

    return context === "before" ? `${capitalize(config.noun)} anterior no disponible` : `${capitalize(config.noun)} no disponible`
  }

  const formatted = formatDetailFieldValue(field, value)
  return formatted ?? formatTechnicalValue(value)
}

const moneyFields = new Set([
  "amount",
  "commission_cost",
  "freight_cost",
  "other_cost",
  "precio",
  "precio_anterior",
  "price",
  "resulting_balance",
  "tax_cost",
  "total",
  "total_cost",
  "unit_cost",
])

const quantityFields = new Set(["quantity", "received_quantity"])
const dateOnlyFields = new Set(["purchase_date", "expense_date"])

// Formatos legibles para valores comunes de "Ver detalle" (montos con
// separador de miles, cantidades con unidad, fechas locales). Sólo aplica
// cuando el campo no es una relación (esas ya se resuelven arriba) ni un
// valor vacío (esos siguen su formateo genérico habitual, "-").
function formatDetailFieldValue(field: string, value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null

  if (moneyFields.has(field)) {
    const amount = Number(value)
    return Number.isFinite(amount) ? formatARS(amount) : null
  }

  if (quantityFields.has(field)) {
    const amount = Number(value)
    if (!Number.isFinite(amount)) return null
    return `${amount} unidad${amount === 1 ? "" : "es"}`
  }

  if (dateOnlyFields.has(field) && typeof value === "string") {
    const date = new Date(`${value}T00:00:00`)
    return Number.isNaN(date.getTime()) ? null : formatAuditDate(date.toISOString())
  }

  return null
}

export function formatTechnicalValue(value: unknown) {
  if (value === null || value === undefined || value === "") return "-"
  if (typeof value === "boolean") return value ? "Sí" : "No"
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? "" : "s"}`
  if (typeof value === "object") return JSON.stringify(value)

  return String(value)
}

export function getHumanFieldName(field: string) {
  const label = humanFieldNames[field]
  if (label) return label

  const clean = field.replaceAll("_", " ").trim()
  return clean.charAt(0).toUpperCase() + clean.slice(1).toLowerCase()
}

// Orden explícito de campos para "Ver detalle" en tablas donde el orden
// físico de columnas no coincide con la prioridad de lectura humana (datos
// principales primero, administrativos al final). Las tablas sin entrada
// acá mantienen el orden original (comportamiento previo, sin cambios).
const fieldOrderByTable: Record<string, string[]> = {
  product_cost_entries: [
    "product_id",
    "variant_id",
    "article_name",
    "sku",
    "quantity",
    "received_quantity",
    "reception_status",
    "unit_cost",
    "total_cost",
    "supplier",
    "tax_cost",
    "commission_cost",
    "freight_cost",
    "other_cost",
    "document_type",
    "document_number",
    "payment_method",
    "notes",
    "created_by",
    "purchase_date",
  ],
}

// getPreviewFields recorta a este máximo para no saturar la vista con
// tablas de auditoría genéricas; algunas tablas (como compras, con ~20
// columnas relevantes) necesitan mostrar todo el snapshot.
const previewFieldLimits: Record<string, number> = {
  product_cost_entries: 30,
}

function sortFieldsForTable(tableName: string, fields: string[]) {
  const order = fieldOrderByTable[tableName]
  if (!order) return fields

  const ranked = order.filter((field) => fields.includes(field))
  const rest = fields.filter((field) => !order.includes(field))
  return [...ranked, ...rest]
}

export function getChangedFields(log: SupabaseAuditLog) {
  if (log.action !== "UPDATE" || !log.before_data || !log.after_data) return []

  const fields = Object.keys(log.after_data)
    .filter((key) => !ignoredFields.has(key))
    .filter((key) => JSON.stringify(log.before_data?.[key]) !== JSON.stringify(log.after_data?.[key]))

  return sortFieldsForTable(log.table_name, fields)
}

export function getPreviewFields(log: SupabaseAuditLog) {
  const data = log.action === "DELETE" ? log.before_data : log.after_data
  if (!data) return []

  const limit = previewFieldLimits[log.table_name] ?? 8
  const fields = Object.keys(data)
    .filter((key) => !ignoredFields.has(key))
    .filter((key) => !isEmptyValue(data[key]))

  return sortFieldsForTable(log.table_name, fields).slice(0, limit)
}

// Resumen humano: título en negrita ("Tipo · Resumen") + como máximo una
// línea de detalle. Todo el resto (IDs, UUID, nombres de columna, valores
// crudos) queda disponible en "Ver detalle" vía AuditDetails, nunca acá.
export function formatAuditDescription(
  log: SupabaseAuditLog,
  maps: AuditEntityMaps = emptyAuditEntityMaps,
): AuditDescription {
  if (isUndoAuditEvent(log)) {
    return getUndoDescription(log, maps)
  }

  if (
    log.table_name === "customer_credit_movements" &&
    log.after_data?.source_kind === "balance_adjustment"
  ) {
    return formatCreditMovementSummary(log)
  }

  const bulkEventType = getBulkEventType(log)
  if (bulkEventType) return formatBulkEventSummary(log, bulkEventType)

  if (orderTables.has(log.table_name)) return formatOrderSummary(log)
  if (log.table_name === "productos") return formatProductSummary(log)
  if (log.table_name === "producto_variantes") return formatVariantSummary(log, maps)
  if (log.table_name === "imagenes_producto") return formatImageSummary(log, maps)
  if (log.table_name === "profiles") return formatProfileSummary(log)
  if (log.table_name === "categorias") return formatCategorySummary(log)
  if (log.table_name === "product_cost_entries") return formatCostEntrySummary(log, maps)
  if (log.table_name === "business_expenses") return formatExpenseSummary(log)

  return formatGenericSummary(log, maps)
}

// Algunos flujos insertan una fila de auditoría "sintética" (no corresponde
// a un INSERT/UPDATE/DELETE real de esa tabla, sino a una acción compuesta:
// pausar/activar un evento comercial, limpiar ofertas huérfanas, etc.) que
// se identifica por after_data.event_type en vez del par action/table_name.
function getBulkEventType(log: SupabaseAuditLog) {
  const eventType = log.after_data?.event_type
  return typeof eventType === "string" && eventType ? eventType : null
}

function formatProductSummary(log: SupabaseAuditLog): AuditDescription {
  const name = getRecordName(log) ?? "producto"

  if (log.action === "INSERT") {
    const lines: string[] = []
    const variantCount = Number(log.after_data?.variantes_cargadas ?? 0)
    const imageCount = Number(log.after_data?.imagenes_cargadas ?? 0)
    const parts: string[] = []
    if (variantCount > 0) parts.push(`${variantCount} variante${variantCount === 1 ? "" : "s"}`)
    if (imageCount > 0) parts.push(`${imageCount} imagen${imageCount === 1 ? "" : "es"}`)

    if (parts.length > 0) lines.push(formatHumanList(parts))
    else if (log.actor_email) lines.push(`Creado por ${log.actor_email}`)

    return { title: `Producto creado · ${name}`, lines }
  }
  if (log.action === "DELETE") {
    return { title: `Producto eliminado · ${name}`, lines: [] }
  }

  const fields = getChangedFields(log)
  if (fields.length === 0) return { title: `Producto modificado · ${name}`, lines: [] }

  if (fields.length === 1 && fields[0] === "precio") {
    return {
      title: `Precio modificado · ${name}`,
      lines: [
        `${formatARS(Number(log.before_data?.precio ?? 0))} → ${formatARS(Number(log.after_data?.precio ?? 0))}`,
      ],
    }
  }
  if (fields.length === 1 && fields[0] === "stock") {
    return {
      title: `Stock actualizado · ${name}`,
      lines: [`Stock ${formatTechnicalValue(log.before_data?.stock)} → ${formatTechnicalValue(log.after_data?.stock)}`],
    }
  }
  if (fields.length === 1 && fields[0] === "activo") {
    return {
      title: `${log.after_data?.activo ? "Producto activado" : "Producto desactivado"} · ${name}`,
      lines: [],
    }
  }
  if (fields.length === 1 && fields[0] === "destacado") {
    return {
      title: `${log.after_data?.destacado ? "Producto destacado" : "Producto ya no destacado"} · ${name}`,
      lines: [],
    }
  }

  return {
    title: `Producto modificado · ${name}`,
    lines: [formatHumanList(fields.map(getHumanFieldName))],
  }
}

function formatVariantSummary(log: SupabaseAuditLog, maps: AuditEntityMaps): AuditDescription {
  const label = getVariantContextLabel(log, maps)

  if (log.action === "INSERT") {
    return {
      title: `Variante creada · ${label}`,
      lines: log.actor_email ? [`Creado por ${log.actor_email}`] : [],
    }
  }
  if (log.action === "DELETE") {
    return { title: `Variante eliminada · ${label}`, lines: [] }
  }

  const fields = getChangedFields(log)
  if (fields.length === 0) return { title: `Variante modificada · ${label}`, lines: [] }

  if (fields.length === 1 && fields[0] === "stock") {
    const reason =
      typeof log.after_data?.stock_adjustment_reason === "string"
        ? log.after_data.stock_adjustment_reason
        : null
    const isRevert = reason?.startsWith("Revertido:") ?? false
    const before = formatTechnicalValue(log.before_data?.stock)
    const after = formatTechnicalValue(log.after_data?.stock)

    return {
      title: `${isRevert ? "Ajuste de stock revertido" : reason ? "Ajuste de stock" : "Stock actualizado"} · ${label}`,
      lines: [reason ? `Stock ${before} → ${after} · Motivo: ${reason}` : `Stock ${before} → ${after}`],
    }
  }
  if (fields.length === 1 && fields[0] === "activo") {
    return {
      title: `${log.after_data?.activo ? "Variante activada" : "Variante desactivada"} · ${label}`,
      lines: [],
    }
  }
  if (fields.length === 1 && fields[0] === "sku") {
    return {
      title: `SKU actualizado · ${label}`,
      lines: [`${formatHumanValue(log.before_data?.sku)} → ${formatHumanValue(log.after_data?.sku)}`],
    }
  }
  if (fields.every((field) => field === "orden")) {
    return { title: `Orden de variantes actualizado · ${label}`, lines: [] }
  }

  return {
    title: `Variante modificada · ${label}`,
    lines: [formatHumanList(fields.map(getHumanFieldName))],
  }
}

function formatImageSummary(log: SupabaseAuditLog, maps: AuditEntityMaps): AuditDescription {
  const productId = log.after_data?.producto_id ?? log.before_data?.producto_id
  const label = resolveProductName(maps, productId) ?? "producto"

  if (log.action === "INSERT") return { title: `Imagen agregada · ${label}`, lines: [] }
  if (log.action === "DELETE") return { title: `Imagen eliminada · ${label}`, lines: [] }

  return { title: `Imagen actualizada · ${label}`, lines: [] }
}

// "{Producto} / {Variante}" cuando se puede resolver el producto dueño de
// la variante; si no hay dato suficiente, sólo el nombre de la variante.
function getVariantContextLabel(log: SupabaseAuditLog, maps: AuditEntityMaps) {
  const variantName =
    String((log.action === "DELETE" ? log.before_data?.nombre : log.after_data?.nombre) ?? "").trim() ||
    "variante"

  const productId = log.after_data?.producto_id ?? log.before_data?.producto_id
  const productName = resolveProductName(maps, productId)

  return productName ? `${productName} / ${variantName}` : variantName
}

// Identifica la compra aunque el producto ya no exista (eliminado después)
// o nunca haya estado catalogado (artículo "custom"): primero intenta el
// nombre vigente del producto/variante, después usa lo que la propia
// compra guardó como snapshot (artículo o SKU), y sólo como último recurso
// admite que no hay forma de identificarla — nunca un ID crudo.
function getCostEntryLabel(data: Record<string, unknown> | null | undefined, maps: AuditEntityMaps) {
  const productName = resolveProductName(maps, data?.producto_id ?? data?.product_id)
  if (productName) {
    const variantName = resolveVariantName(maps, data?.variant_id)
    return variantName ? `${productName} / ${variantName}` : productName
  }

  const articleName = typeof data?.article_name === "string" ? data.article_name.trim() : ""
  if (articleName) return articleName

  const sku = typeof data?.sku === "string" ? data.sku.trim() : ""
  if (sku) return sku

  return maps.ready ? "Producto no disponible" : "producto"
}

function formatCostEntrySummary(log: SupabaseAuditLog, maps: AuditEntityMaps): AuditDescription {
  const data = log.action === "DELETE" ? log.before_data : log.after_data
  const label = getCostEntryLabel(data, maps)

  if (log.action === "DELETE") return { title: `Compra eliminada · ${label}`, lines: [] }

  const quantity = Number(data?.quantity ?? 0)
  const totalCost = Number(data?.total_cost ?? 0)
  const lines: string[] = []
  if (quantity > 0) lines.push(`${quantity} unidad${quantity === 1 ? "" : "es"} · ${formatARS(totalCost)}`)

  return {
    title: `${log.action === "INSERT" ? "Compra registrada" : "Compra modificada"} · ${label}`,
    lines,
  }
}

function formatExpenseSummary(log: SupabaseAuditLog): AuditDescription {
  const data = log.action === "DELETE" ? log.before_data : log.after_data
  const category = formatHumanValue(data?.category)
  const description = typeof data?.description === "string" ? data.description.trim() : ""

  if (log.action === "DELETE") return { title: `Gasto eliminado · ${category}`, lines: [] }

  const amount = Number(data?.amount ?? 0)
  const lines = [description ? `${formatARS(amount)} · ${description}` : formatARS(amount)]

  return {
    title: `${log.action === "INSERT" ? "Gasto registrado" : "Gasto modificado"} · ${category}`,
    lines,
  }
}

const bulkEventLabels: Record<string, string> = {
  activate: "activado",
  cleanup_orphan_offers: "Limpieza de ofertas vencidas",
  delete_event: "eliminado",
  deactivate: "desactivado",
  pause: "pausado",
}

function formatBulkEventSummary(log: SupabaseAuditLog, eventType: string): AuditDescription {
  const data = log.after_data ?? {}

  if (eventType === "cleanup_orphan_offers") {
    const cleaned = Number(data.cleaned_count ?? 0)
    return {
      title: "Limpieza de ofertas vencidas",
      lines: [`${cleaned} producto${cleaned === 1 ? "" : "s"} corregido${cleaned === 1 ? "" : "s"}`],
    }
  }

  const eventName = typeof data.event_name === "string" && data.event_name ? data.event_name : "evento comercial"
  const actionLabel = bulkEventLabels[eventType] ?? "modificado"
  const count = Number(data.affected_count ?? data.restored_count ?? 0)

  return {
    title: `Evento comercial ${actionLabel} · ${eventName}`,
    lines: count > 0 ? [`${count} producto${count === 1 ? "" : "s"} afectado${count === 1 ? "" : "s"}`] : [],
  }
}

function formatProfileSummary(log: SupabaseAuditLog): AuditDescription {
  const name = getRecordName(log) ?? "usuario"

  if (log.action === "INSERT") return { title: `Usuario creado · ${name}`, lines: [] }
  if (log.action === "DELETE") return { title: `Usuario eliminado · ${name}`, lines: [] }

  const fields = getChangedFields(log)
  if (fields.length === 1 && fields[0] === "rol") {
    return {
      title: `Permisos actualizados · ${name}`,
      lines: [`${formatHumanValue(log.before_data?.rol)} → ${formatHumanValue(log.after_data?.rol)}`],
    }
  }

  return {
    title: `Usuario modificado · ${name}`,
    lines: fields.length ? [formatHumanList(fields.map(getHumanFieldName))] : [],
  }
}

function formatCategorySummary(log: SupabaseAuditLog): AuditDescription {
  const name = getRecordName(log) ?? "categoría"

  if (log.action === "INSERT") return { title: `Categoría creada · ${name}`, lines: [] }
  if (log.action === "DELETE") return { title: `Categoría eliminada · ${name}`, lines: [] }

  const fields = getChangedFields(log)
  return {
    title: `Categoría modificada · ${name}`,
    lines: fields.length ? [formatHumanList(fields.map(getHumanFieldName))] : [],
  }
}

function formatOrderSummary(log: SupabaseAuditLog): AuditDescription {
  const id = log.record_id ?? "?"

  if (log.action === "INSERT") {
    const total = log.after_data?.total
    return {
      title: `Pedido #${id} creado`,
      lines: typeof total === "number" ? [formatARS(total)] : [],
    }
  }
  if (log.action === "DELETE") {
    return { title: `Pedido #${id} eliminado`, lines: [] }
  }

  const fields = getChangedFields(log)
  if (fields.length === 1 && fields[0] === "estado") {
    return {
      title: `Pedido #${id} · Estado actualizado`,
      lines: [`${formatHumanValue(log.before_data?.estado)} → ${formatHumanValue(log.after_data?.estado)}`],
    }
  }

  return {
    title: `Pedido #${id} modificado`,
    lines: fields.length ? [formatHumanList(fields.map(getHumanFieldName))] : [],
  }
}

function formatCreditMovementSummary(log: SupabaseAuditLog): AuditDescription {
  const data = log.after_data ?? {}
  const isCredit = data.movement_type === "credit"
  const targetName = typeof data.target_name === "string" ? data.target_name : "cuenta sin nombre"
  const amount = formatARS(Number(data.amount ?? 0))

  return {
    title: `${isCredit ? "Saldo acreditado" : "Saldo debitado"} · ${targetName}`,
    lines: [amount],
  }
}

function formatGenericSummary(log: SupabaseAuditLog, maps: AuditEntityMaps): AuditDescription {
  const tableLabel = humanTableNames[log.table_name] ?? "Registro"
  const name = getRecordName(log, maps)
  const actionLabel = log.action === "INSERT" ? "creado" : log.action === "DELETE" ? "eliminado" : "modificado"
  const fields = log.action === "UPDATE" ? getChangedFields(log) : []

  return {
    title: name ? `${tableLabel} ${actionLabel} · ${name}` : `${tableLabel} ${actionLabel}`,
    lines: fields.length ? [formatHumanList(fields.map(getHumanFieldName))] : [],
  }
}

export function groupAuditLogs(logs: SupabaseAuditLog[]): AuditLogGroup[] {
  const groups: AuditLogGroup[] = []
  const usedIds = new Set<number>()
  const orderedLogs = [...logs].sort(
    (a, b) =>
      new Date(b.created_at).getTime() -
      new Date(a.created_at).getTime()
  )

  orderedLogs.forEach((log) => {
    if (usedIds.has(log.id)) return
    if (!isDeletedProductLog(log)) return

    const productId = String(log.record_id ?? log.before_data?.id ?? "")
    if (!productId) return

    const createdAt = new Date(log.created_at).getTime()
    const groupedLogs = orderedLogs.filter((candidate) => {
      if (usedIds.has(candidate.id)) return false
      if (candidate.actor_email !== log.actor_email) return false

      const candidateCreatedAt = new Date(candidate.created_at).getTime()
      if (Math.abs(createdAt - candidateCreatedAt) > 30000) return false

      return getDeletedProductGroupId(candidate) === productId
    })

    groupedLogs.forEach((item) => usedIds.add(item.id))

    groups.push({
      id: `product-delete-${productId}-${createdAt}`,
      logs: sortProductDeleteLogs(groupedLogs),
      primaryLog: log,
      kind: "product_delete",
    })
  })

  // refresh_inventory_stock recalcula el stock de todas las variantes del
  // producto ante cualquier movimiento de inventario (incluido un ajuste
  // manual), lo que además dispara una actualización "eco" del stock
  // agregado en productos. Es la misma acción humana vista dos veces: se
  // pliega el eco dentro del evento de la variante para no duplicarlo.
  orderedLogs.forEach((log) => {
    if (usedIds.has(log.id)) return
    if (log.table_name !== "producto_variantes" || log.action !== "UPDATE") return
    if (!getChangedFields(log).includes("stock")) return

    const productId = log.after_data?.producto_id ?? log.before_data?.producto_id
    if (!productId) return

    const createdAt = new Date(log.created_at).getTime()
    const echo = orderedLogs.find((candidate) => {
      if (usedIds.has(candidate.id) || candidate.id === log.id) return false
      if (candidate.table_name !== "productos" || candidate.action !== "UPDATE") return false
      if (String(candidate.record_id) !== String(productId)) return false
      if (candidate.actor_email !== log.actor_email) return false

      const fields = getChangedFields(candidate)
      if (fields.length !== 1 || fields[0] !== "stock") return false

      return Math.abs(new Date(candidate.created_at).getTime() - createdAt) <= 5000
    })

    usedIds.add(log.id)
    if (echo) usedIds.add(echo.id)

    groups.push({
      id: `stock-adjustment-${log.id}`,
      logs: echo ? [log, echo] : [log],
      primaryLog: log,
      kind: "stock_adjustment",
    })
  })

  orderedLogs.forEach((log) => {
    if (usedIds.has(log.id)) return

    const productId = getVariantPrincipalProductId(log)

    if (!productId) {
      usedIds.add(log.id)
      groups.push({
        id: `log-${log.id}`,
        logs: [log],
        primaryLog: log,
        kind: "single",
      })
      return
    }

    const createdAt = new Date(log.created_at).getTime()
    const groupedLogs = orderedLogs.filter((candidate) => {
      if (usedIds.has(candidate.id)) return false
      if (candidate.actor_email !== log.actor_email) return false
      if (getVariantPrincipalProductId(candidate) !== productId) return false

      const candidateCreatedAt = new Date(candidate.created_at).getTime()
      return Math.abs(createdAt - candidateCreatedAt) <= 5000
    })

    groupedLogs.forEach((item) => usedIds.add(item.id))

    if (groupedLogs.length <= 1) {
      groups.push({
        id: `log-${log.id}`,
        logs: [log],
        primaryLog: log,
        kind: "single",
      })
      return
    }

    groups.push({
      id: `variant-principal-${productId}-${createdAt}`,
      logs: groupedLogs.sort(
        (a, b) =>
          new Date(b.created_at).getTime() -
          new Date(a.created_at).getTime()
      ),
      primaryLog: groupedLogs[0],
      kind: "variant_principal_change",
    })
  })

  return groups
}

export function formatAuditGroupDescription(
  group: AuditLogGroup,
  maps: AuditEntityMaps = emptyAuditEntityMaps,
): AuditDescription {
  if (group.kind === "product_delete") {
    const productName = getDeletedProductName(group)
    const summary = getDeletedProductSummary(group.logs)

    return {
      title: `Producto eliminado · ${productName}`,
      lines: summary.length ? [`${formatHumanList(summary)} eliminados`] : [],
    }
  }

  if (group.kind === "stock_adjustment") {
    const log = group.logs.find((item) => item.table_name === "producto_variantes") ?? group.primaryLog
    const label = getVariantContextLabel(log, maps)
    const before = formatTechnicalValue(log.before_data?.stock)
    const after = formatTechnicalValue(log.after_data?.stock)
    const reason =
      typeof log.after_data?.stock_adjustment_reason === "string"
        ? log.after_data.stock_adjustment_reason
        : null
    const isRevert = reason?.startsWith("Revertido:") ?? false

    return {
      title: `${isRevert ? "Ajuste de stock revertido" : "Ajuste de stock"} · ${label}`,
      lines: [reason ? `Stock ${before} → ${after} · Motivo: ${reason}` : `Stock ${before} → ${after}`],
    }
  }

  if (group.kind !== "variant_principal_change") {
    return formatAuditDescription(group.primaryLog, maps)
  }

  const productName = getGroupedProductName(group.logs, maps)
  const { beforeName, afterName } = getVariantPrincipalNames(group.logs)

  return {
    title: `Variante principal actualizada · ${productName}`,
    lines: beforeName && afterName ? [`${beforeName} → ${afterName}`] : [],
  }
}

export function getAuditGroupSeverity(group: AuditLogGroup): AuditSeverity {
  if (group.kind === "product_delete") return "critico"
  if (group.kind === "variant_principal_change") return "normal"
  if (group.kind === "stock_adjustment") return "importante"

  return getAuditSeverity(group.primaryLog)
}

export function getAuditGroupDisplayAction(group: AuditLogGroup) {
  return getAuditDisplayAction(group.primaryLog)
}

export function canUndoAuditGroup(group: AuditLogGroup) {
  if (group.kind === "product_delete") return canUndoAuditLog(group.primaryLog)
  // El stock de producto_variantes es una columna derivada (recalculada por
  // refresh_inventory_stock), así que deshacer un ajuste manual NUNCA
  // reescribe esa columna directamente: el servidor aplica el delta inverso
  // con la misma función idempotente que usa un ajuste manual normal. Ver
  // undo_audit_log en supabase para el detalle de la estrategia.
  if (group.kind === "stock_adjustment") {
    const log = group.logs.find((item) => item.table_name === "producto_variantes") ?? group.primaryLog
    return !log.undone_at && !isUndoAuditEvent(log)
  }

  return group.logs.every(canUndoAuditLog)
}

export function getAuditGroupUndoLogs(group: AuditLogGroup) {
  if (group.kind === "product_delete") return [group.primaryLog]

  // El "eco" de recálculo agregado sobre productos.stock no se deshace de
  // forma independiente: el servidor lo marca junto con el ajuste de la
  // variante al procesar ese único log (ver undo_audit_log).
  if (group.kind === "stock_adjustment") {
    const log = group.logs.find((item) => item.table_name === "producto_variantes") ?? group.primaryLog
    return [log]
  }

  return group.logs
}

export function getAuditSeverity(log: SupabaseAuditLog): AuditSeverity {
  if (log.table_name === "customer_credit_movements") return "importante"

  const fields = getChangedFields(log)

  if (
    isUndoAuditEvent(log) ||
    log.undone_at ||
    log.action === "DELETE" ||
    fields.some((field) => criticalFields.has(field))
  ) {
    return "critico"
  }

  if (
    fields.some((field) => importantFields.has(field)) ||
    (orderTables.has(log.table_name) && fields.includes("estado"))
  ) {
    return "importante"
  }

  return "normal"
}

export function getAuditSection(log: SupabaseAuditLog) {
  if (orderTables.has(log.table_name)) return "Pedidos"

  if (log.table_name === "productos" || log.table_name.startsWith("producto_") || log.table_name === "imagenes_producto") {
    return "Productos"
  }

  if (log.table_name === "categorias") return "Categorías"
  if (log.table_name === "profiles") return "Usuarios y permisos"
  if (log.table_name === "customer_credit_movements") return "Saldos"
  if (
    log.table_name.includes("banner") ||
    log.table_name.includes("config") ||
    log.table_name.includes("envio") ||
    log.table_name.includes("pago") ||
    log.table_name.includes("payment_") ||
    log.table_name.includes("settings") ||
    log.table_name.includes("shipping_method")
  ) {
    return "Configuración visual"
  }

  return "Administración"
}

export function isGeneralAdminAuditLog(log: SupabaseAuditLog) {
  if (isUndoAuditEvent(log)) return true
  if (operationalTables.has(log.table_name)) return false
  if (!log.actor_email) return false
  if (log.action === "UPDATE" && getChangedFields(log).length === 0) return false

  if (log.table_name === "admin_events") {
    const eventType =
      typeof log.after_data?.event_type === "string"
        ? log.after_data.event_type
        : ""

    return eventType !== "" && !nonAuditableEventTypes.has(eventType)
  }

  if (orderTables.has(log.table_name)) {
    return isManualOrderAuditLog(log)
  }

  if (log.table_name === "profiles") {
    return (
      log.action === "INSERT" ||
      log.action === "DELETE" ||
      getChangedFields(log).some((field) => criticalFields.has(field))
    )
  }

  return true
}

export function canUndoAuditLog(log: SupabaseAuditLog) {
  if (isUndoAuditEvent(log)) return false
  if (log.undone_at) return false
  if (!reversibleTables.has(log.table_name)) return false
  if (log.table_name === "profiles") return false

  const fields = getChangedFields(log)
  if (fields.some((field) => field.includes("payment") || field.includes("tracking") || field.includes("mercadopago"))) {
    return false
  }

  return log.action === "UPDATE" || log.action === "INSERT" || log.action === "DELETE"
}

const paymentAdjacentTables = new Set([
  "business_expenses",
  "customer_credit_movements",
  "inventory_variant_allocations",
  "mercadolibre_sales",
  "product_cost_entries",
])

// Explicación en lenguaje humano de por qué NO hay botón "Deshacer" en un
// evento. null significa "sí es reversible" (o ya fue deshecho / es en sí
// mismo el marcador de una reversión, casos que no necesitan explicación).
export function getNonReversibleReason(log: SupabaseAuditLog): string | null {
  if (isUndoAuditEvent(log) || log.undone_at) return null
  if (canUndoAuditLog(log)) return null

  if (log.table_name === "profiles") {
    return "Los cambios de permisos y cuentas no se revierten automáticamente por motivos de seguridad."
  }
  if (orderTables.has(log.table_name)) {
    return "Los pedidos no se revierten automáticamente: pueden tener pagos, facturación o envío asociados."
  }
  if (paymentAdjacentTables.has(log.table_name)) {
    return "Esta acción afecta el stock calculado o movimientos financieros y no tiene una reversión automática segura."
  }

  const fields = getChangedFields(log)
  if (fields.some((field) => field.includes("payment") || field.includes("tracking") || field.includes("mercadopago"))) {
    return "Este cambio incluye datos de pago o envío y no se revierte automáticamente."
  }

  if (!reversibleTables.has(log.table_name)) {
    return "Esta acción no tiene una reversión segura implementada todavía."
  }

  return "Esta acción no se puede deshacer."
}

export function getAuditGroupNonReversibleReason(group: AuditLogGroup): string | null {
  if (canUndoAuditGroup(group)) return null
  if (group.kind === "product_delete") return getNonReversibleReason(group.primaryLog)
  if (group.kind === "stock_adjustment") {
    return "Este ajuste ya fue revertido o forma parte de un movimiento que ya no está disponible."
  }

  const blockedLog = group.logs.find((log) => !canUndoAuditLog(log)) ?? group.primaryLog
  return getNonReversibleReason(blockedLog)
}

export function getAuditActionLabel(action: SupabaseAuditLog["action"]) {
  if (action === "INSERT") return "Creación"
  if (action === "DELETE") return "Eliminación"

  return "Modificación"
}

export function getAuditDisplayAction(log: SupabaseAuditLog) {
  if (isUndoAuditEvent(log)) return "Deshacer"

  return getAuditActionLabel(log.action)
}

export function getSeverityLabel(severity: AuditSeverity) {
  if (severity === "critico") return "Crítico"
  if (severity === "importante") return "Importante"

  return "Normal"
}

// Reconstruye el cambio que efectivamente aplicó el "deshacer": una fila de
// audit_logs "de mentira" con antes/después invertidos respecto del evento
// original, para poder reutilizar getRecordName/getChangedFields/
// resolveFieldDisplayValue tal como se usan en cualquier otro evento.
function buildUndoRestoredLog(log: SupabaseAuditLog): SupabaseAuditLog | null {
  const originalAction =
    typeof log.after_data?.original_action === "string" ? log.after_data.original_action : null
  const originalBeforeData = toRecord(log.after_data?.original_before_data)
  const originalAfterData = toRecord(log.after_data?.original_after_data)
  const originalTableName =
    typeof log.after_data?.original_table_name === "string"
      ? log.after_data.original_table_name
      : "admin_events"
  const originalRecordId =
    typeof log.after_data?.original_record_id === "string" ? log.after_data.original_record_id : null

  if (originalAction !== "UPDATE" || !originalBeforeData || !originalAfterData) return null

  return {
    ...log,
    action: "UPDATE",
    table_name: originalTableName,
    record_id: originalRecordId,
    before_data: originalAfterData,
    after_data: originalBeforeData,
  }
}

function getUndoDescription(log: SupabaseAuditLog, maps: AuditEntityMaps): AuditDescription {
  const restoredLog = buildUndoRestoredLog(log)
  if (!restoredLog) return { title: "Cambio deshecho", lines: [] }

  const entityName = getRecordName(restoredLog, maps)
  const title = entityName ? `Cambio deshecho · ${entityName}` : "Cambio deshecho"

  const fields = getChangedFields(restoredLog)
  if (fields.length === 0) return { title, lines: [] }

  if (fields.length === 1) {
    const field = fields[0]
    const from = resolveFieldDisplayValue(field, restoredLog.before_data?.[field], maps, "after")
    const to = resolveFieldDisplayValue(field, restoredLog.after_data?.[field], maps, "before")
    return { title, lines: [`${getHumanFieldName(field)}: ${from} → ${to}`] }
  }

  return { title, lines: [`Restaurado: ${formatHumanList(fields.map(getHumanFieldName))}`] }
}

function toRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null

  return value as Record<string, unknown>
}

// Nunca devuelve un ID o UUID crudo: si no hay un campo de nombre propio ni
// una relación resoluble, devuelve null y quien llama omite el "· nombre"
// del título (mejor "Banner creado" que "Banner creado · f3a1...").
function getRecordName(log: SupabaseAuditLog, maps: AuditEntityMaps = emptyAuditEntityMaps): string | null {
  const data = log.action === "DELETE" ? log.before_data : log.after_data
  if (!data) return null

  const candidate =
    data.nombre ??
    data.name ??
    data.event_name ??
    data.internal_name ??
    data.email ??
    data.target_name ??
    data.slug ??
    data.titulo ??
    data.title ??
    data.concepto ??
    data.category ??
    data.alt_text ??
    data.placement

  if (candidate) return formatTechnicalValue(candidate)

  const relational =
    resolveProductName(maps, data.producto_id ?? data.product_id) ??
    resolveVariantName(maps, data.variant_id) ??
    resolveCategoryName(maps, data.categoria_id ?? data.category_id)

  return relational
}

function isDeletedProductLog(log: SupabaseAuditLog) {
  return log.action === "DELETE" && log.table_name === "productos"
}

function getDeletedProductGroupId(log: SupabaseAuditLog) {
  if (isDeletedProductLog(log)) {
    return log.record_id ? String(log.record_id) : String(log.before_data?.id ?? "")
  }

  if (
    log.action === "DELETE" &&
    (
      log.table_name === "imagenes_producto" ||
      log.table_name === "producto_variantes" ||
      log.table_name === "producto_especificaciones"
    )
  ) {
    const productId = log.before_data?.producto_id
    return productId ? String(productId) : null
  }

  return null
}

function sortProductDeleteLogs(logs: SupabaseAuditLog[]) {
  return [...logs].sort((a, b) => {
    if (a.table_name === "productos") return -1
    if (b.table_name === "productos") return 1

    return a.table_name.localeCompare(b.table_name)
  })
}

function getDeletedProductName(group: AuditLogGroup) {
  const productLog =
    group.logs.find((log) => log.table_name === "productos") ?? group.primaryLog

  return formatTechnicalValue(
    productLog.before_data?.nombre ??
      productLog.before_data?.name ??
      productLog.record_id ??
      "producto"
  )
}

function getDeletedProductSummary(logs: SupabaseAuditLog[]) {
  const variants = logs.filter((log) => log.table_name === "producto_variantes").length
  const images = logs.filter((log) => log.table_name === "imagenes_producto").length
  const specifications = logs.filter((log) => log.table_name === "producto_especificaciones").length
  const summary: string[] = []

  if (variants > 0) summary.push(`${variants} variante${variants === 1 ? "" : "s"}`)
  if (images > 0) summary.push(`${images} imagen${images === 1 ? "" : "es"}`)
  if (specifications > 0) {
    summary.push(`${specifications} especificación${specifications === 1 ? "" : "es"}`)
  }

  return summary
}

function formatHumanList(items: string[]) {
  if (items.length <= 1) return items[0] ?? ""
  if (items.length === 2) return `${items[0]} y ${items[1]}`

  return `${items.slice(0, -1).join(", ")} y ${items[items.length - 1]}`
}

function getVariantPrincipalProductId(log: SupabaseAuditLog) {
  if (log.action !== "UPDATE") return null

  const fields = getChangedFields(log)

  if (
    log.table_name === "productos" &&
    fields.length === 1 &&
    fields.includes("imagen_principal")
  ) {
    return log.record_id ? String(log.record_id) : null
  }

  if (
    log.table_name === "producto_variantes" &&
    fields.includes("orden")
  ) {
    const productId =
      log.after_data?.producto_id ??
      log.before_data?.producto_id

    return productId ? String(productId) : null
  }

  return null
}

function getGroupedProductName(logs: SupabaseAuditLog[], maps: AuditEntityMaps) {
  const productLog = logs.find((log) => log.table_name === "productos")
  const productName =
    productLog?.after_data?.nombre ??
    productLog?.before_data?.nombre ??
    productLog?.after_data?.name ??
    productLog?.before_data?.name

  if (productName) return formatTechnicalValue(productName)

  const productId = logs.map((log) => getVariantPrincipalProductId(log)).find(Boolean)

  return resolveProductName(maps, productId) ?? "producto"
}

function getVariantPrincipalNames(logs: SupabaseAuditLog[]) {
  const variantLogs = logs.filter(
    (log) =>
      log.table_name === "producto_variantes" &&
      log.action === "UPDATE"
  )

  const beforeName =
    variantLogs
      .map((log) =>
        Number(log.before_data?.orden) === 1
          ? log.before_data?.nombre
          : null
      )
      .find(Boolean) ?? null

  const afterName =
    variantLogs
      .map((log) =>
        Number(log.after_data?.orden) === 1
          ? log.after_data?.nombre
          : null
      )
      .find(Boolean) ?? null

  return {
    beforeName: beforeName
      ? formatHumanValue(beforeName)
      : null,
    afterName: afterName
      ? formatHumanValue(afterName)
      : null,
  }
}

function formatHumanValue(value: unknown) {
  if (isEmptyValue(value)) return "vacío"
  if (typeof value === "boolean") return value ? "Sí" : "No"
  if (typeof value === "number") return String(value)
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? "" : "s"}`
  if (typeof value === "object") return "datos cargados"

  const text = String(value).trim()
  if (!text) return "vacío"
  if (/^https?:\/\//i.test(text)) return "link cargado"

  return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase().replaceAll("_", " ")
}

function isEmptyValue(value: unknown) {
  return (
    value === null ||
    value === undefined ||
    value === "" ||
    (Array.isArray(value) && value.length === 0)
  )
}

function isManualOrderAuditLog(log: SupabaseAuditLog) {
  if (!log.actor_email) return false
  if (log.action === "INSERT") return false

  const fields = getChangedFields(log)
  if (fields.length === 0) return false
  if (fields.some((field) => automaticOrderFields.has(field))) return false

  return fields.some((field) => manualOrderFields.has(field))
}
