import type { SupabaseAuditLog } from "@/lib/supabase/types"
import { formatARS } from "@/lib/customer-credit"

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
  amount: "Importe",
  category_id: "Categoría",
  categoria_id: "Categoría",
  color_hex: "Color",
  description: "Descripción",
  created_from: "Origen",
  descripcion: "Descripción",
  destacado: "Destacado",
  descuento: "Descuento",
  estado: "Estado",
  image_url: "Imagen",
  last_sign_in_at: "Último inicio",
  imagen_principal: "Imagen principal",
  imagenes: "Imágenes",
  name: "Nombre",
  nombre: "Nombre",
  movement_type: "Operación",
  orden: "Orden",
  price: "Precio",
  precio: "Precio",
  precio_anterior: "Precio anterior",
  producto_id: "Producto",
  rol: "Permisos",
  slug: "Slug",
  status: "Estado",
  source_kind: "Tipo de movimiento",
  stock: "Stock",
  stock_adjustment_reason: "Motivo del ajuste",
  stock_adjustment_delta: "Diferencia aplicada",
  total: "Total",
  target_email: "Email de la cuenta",
  target_name: "Cuenta afectada",
  target_user_id: "ID de la cuenta",
  resulting_balance: "Saldo resultante",
  tracking_number: "Número de seguimiento",
  tracking_url: "Link de seguimiento",
  url: "Imagen",
}

const ignoredFields = new Set([
  "actor_user_id",
  "after_data",
  "before_data",
  "created_at",
  "id",
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

export function getChangedFields(log: SupabaseAuditLog) {
  if (log.action !== "UPDATE" || !log.before_data || !log.after_data) return []

  return Object.keys(log.after_data)
    .filter((key) => !ignoredFields.has(key))
    .filter((key) => JSON.stringify(log.before_data?.[key]) !== JSON.stringify(log.after_data?.[key]))
}

export function getPreviewFields(log: SupabaseAuditLog) {
  const data = log.action === "DELETE" ? log.before_data : log.after_data
  if (!data) return []

  return Object.keys(data)
    .filter((key) => !ignoredFields.has(key))
    .filter((key) => !isEmptyValue(data[key]))
    .slice(0, 8)
}

// Resumen humano: título en negrita ("Tipo · Resumen") + como máximo una
// línea de detalle. Todo el resto (IDs, UUID, nombres de columna, valores
// crudos) queda disponible en "Ver detalle" vía AuditDetails, nunca acá.
export function formatAuditDescription(log: SupabaseAuditLog): AuditDescription {
  if (isUndoAuditEvent(log)) {
    const line = getUndoSummaryLine(log)
    return { title: "Cambio deshecho", lines: line ? [line] : [] }
  }

  if (
    log.table_name === "customer_credit_movements" &&
    log.after_data?.source_kind === "balance_adjustment"
  ) {
    return formatCreditMovementSummary(log)
  }

  if (orderTables.has(log.table_name)) return formatOrderSummary(log)
  if (log.table_name === "productos") return formatProductSummary(log)
  if (log.table_name === "producto_variantes") return formatVariantSummary(log)
  if (log.table_name === "imagenes_producto") return formatImageSummary(log)
  if (log.table_name === "profiles") return formatProfileSummary(log)
  if (log.table_name === "categorias") return formatCategorySummary(log)

  return formatGenericSummary(log)
}

function formatProductSummary(log: SupabaseAuditLog): AuditDescription {
  const name = getRecordName(log)

  if (log.action === "INSERT") {
    return {
      title: `Producto creado · ${name}`,
      lines: log.actor_email ? [`Creado por ${log.actor_email}`] : [],
    }
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

function formatVariantSummary(log: SupabaseAuditLog): AuditDescription {
  const label =
    String((log.action === "DELETE" ? log.before_data?.nombre : log.after_data?.nombre) ?? "").trim() ||
    "variante"

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
    const before = formatTechnicalValue(log.before_data?.stock)
    const after = formatTechnicalValue(log.after_data?.stock)

    return {
      title: `${reason ? "Ajuste de stock" : "Stock actualizado"} · ${label}`,
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

function formatImageSummary(log: SupabaseAuditLog): AuditDescription {
  const productId = log.after_data?.producto_id ?? log.before_data?.producto_id
  // No se resuelve el nombre del producto acá para evitar una consulta
  // adicional sólo por este tipo de evento; el ID sigue siendo mucho más
  // legible que un UUID y el detalle completo queda en "Ver detalle".
  const label = productId ? `Producto #${productId}` : "producto"

  if (log.action === "INSERT") return { title: `Imagen agregada · ${label}`, lines: [] }
  if (log.action === "DELETE") return { title: `Imagen eliminada · ${label}`, lines: [] }

  return { title: `Imagen actualizada · ${label}`, lines: [] }
}

function formatProfileSummary(log: SupabaseAuditLog): AuditDescription {
  const name = getRecordName(log)

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
  const name = getRecordName(log)

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

function formatGenericSummary(log: SupabaseAuditLog): AuditDescription {
  const name = getRecordName(log)
  const actionLabel = log.action === "INSERT" ? "creado" : log.action === "DELETE" ? "eliminado" : "modificado"
  const fields = log.action === "UPDATE" ? getChangedFields(log) : []

  return {
    title: `Registro ${actionLabel} · ${name}`,
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

export function formatAuditGroupDescription(group: AuditLogGroup): AuditDescription {
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
    const label = String(log.after_data?.nombre ?? log.before_data?.nombre ?? "").trim() || "variante"
    const before = formatTechnicalValue(log.before_data?.stock)
    const after = formatTechnicalValue(log.after_data?.stock)
    const reason =
      typeof log.after_data?.stock_adjustment_reason === "string"
        ? log.after_data.stock_adjustment_reason
        : null

    return {
      title: `Ajuste de stock · ${label}`,
      lines: [reason ? `Stock ${before} → ${after} · Motivo: ${reason}` : `Stock ${before} → ${after}`],
    }
  }

  if (group.kind !== "variant_principal_change") {
    return formatAuditDescription(group.primaryLog)
  }

  const productName = getGroupedProductName(group.logs)
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
  // refresh_inventory_stock a partir de inventory_movements); un "deshacer"
  // genérico que reescriba antes/después directamente sobre esa columna no
  // es una operación soportada. Mejor no ofrecer un botón que no funciona.
  if (group.kind === "stock_adjustment") return false

  return group.logs.every(canUndoAuditLog)
}

export function getAuditGroupUndoLogs(group: AuditLogGroup) {
  if (group.kind === "product_delete") return [group.primaryLog]

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

function getUndoSummaryLine(log: SupabaseAuditLog): string | null {
  const originalAction =
    typeof log.after_data?.original_action === "string"
      ? log.after_data.original_action
      : null
  const originalBeforeData = toRecord(log.after_data?.original_before_data)
  const originalAfterData = toRecord(log.after_data?.original_after_data)
  const originalTableName =
    typeof log.after_data?.original_table_name === "string"
      ? log.after_data.original_table_name
      : "admin_events"
  const originalRecordId =
    typeof log.after_data?.original_record_id === "string"
      ? log.after_data.original_record_id
      : null

  if (originalAction !== "UPDATE" || !originalBeforeData || !originalAfterData) return null

  const restoredLog: SupabaseAuditLog = {
    ...log,
    action: "UPDATE",
    table_name: originalTableName,
    record_id: originalRecordId,
    before_data: originalAfterData,
    after_data: originalBeforeData,
  }

  const fields = getChangedFields(restoredLog)
  if (fields.length === 0) return null
  if (fields.length === 1) {
    return `${getHumanFieldName(fields[0])}: ${formatHumanValue(originalBeforeData[fields[0]])}`
  }

  return `Restaurado: ${formatHumanList(fields.map(getHumanFieldName))}`
}

function toRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null

  return value as Record<string, unknown>
}

function getRecordName(log: SupabaseAuditLog) {
  const data = log.action === "DELETE" ? log.before_data : log.after_data
  if (!data) return log.record_id ? `ID ${log.record_id}` : "registro"

  const candidate =
    data.nombre ??
    data.name ??
    data.email ??
    data.slug ??
    data.titulo ??
    data.title ??
    log.record_id

  return candidate ? formatTechnicalValue(candidate) : "registro"
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

function getGroupedProductName(logs: SupabaseAuditLog[]) {
  const productLog = logs.find((log) => log.table_name === "productos")
  const productName =
    productLog?.after_data?.nombre ??
    productLog?.before_data?.nombre ??
    productLog?.after_data?.name ??
    productLog?.before_data?.name

  if (productName) return formatTechnicalValue(productName)

  const productId =
    logs
      .map((log) => getVariantPrincipalProductId(log))
      .find(Boolean) ?? "registro"

  return `ID ${productId}`
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
