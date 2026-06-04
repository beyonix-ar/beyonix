import type { SupabaseAuditLog } from "@/lib/supabase/types"

export type AuditSeverity = "normal" | "importante" | "critico"
export type AuditActionFilter = "all" | SupabaseAuditLog["action"] | "UNDONE"

export interface AuditDescription {
  title: string
  lines: string[]
}

const humanFieldNames: Record<string, string> = {
  activo: "Estado",
  category_id: "Categoría",
  categoria_id: "Categoría",
  color_hex: "Color",
  description: "Descripción",
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
  orden: "Orden",
  price: "Precio",
  precio: "Precio",
  precio_anterior: "Precio anterior",
  producto_id: "Producto",
  rol: "Permisos",
  slug: "Slug",
  status: "Estado",
  stock: "Stock",
  total: "Total",
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
  "ordenes",
  "order_items",
  "orders",
  "payments",
  "stock_reservations",
])

const reversibleTables = new Set([
  "banners",
  "categorias",
  "configuracion_visual",
  "hero_banners",
  "imagenes_producto",
  "producto_especificaciones",
  "producto_variantes",
  "productos",
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

export function formatAuditTitle(log: SupabaseAuditLog) {
  const actor = log.actor_email?.split("@")[0] || "Sistema"

  if (isUndoAuditEvent(log)) {
    const originalActor =
      typeof log.after_data?.original_actor_email === "string"
        ? log.after_data.original_actor_email.split("@")[0]
        : "otro administrador"

    return `${actor} deshizo un cambio realizado por ${originalActor}.`
  }

  const entity = getEntityLabel(log)

  if (log.action === "INSERT") return `${actor} creó ${entity}.`
  if (log.action === "DELETE") return `${actor} eliminó ${entity}.`

  return `${actor} modificó ${entity}.`
}

export function formatAuditDescription(log: SupabaseAuditLog): AuditDescription {
  if (isUndoAuditEvent(log)) {
    return {
      title: formatAuditTitle(log),
      lines: getUndoEventLines(log),
    }
  }

  if (log.action !== "UPDATE") {
    return {
      title: formatAuditTitle(log),
      lines: [],
    }
  }

  const changedFields = getChangedFields(log)

  return {
    title:
      changedFields.length > 0
        ? formatAuditTitle(log)
        : `${log.actor_email?.split("@")[0] || "Sistema"} revisó ${getEntityLabel(log)}, pero no hubo cambios visibles.`,
    lines: changedFields.map((field) => getChangeSentence(log, field)),
  }
}

export function getAuditSeverity(log: SupabaseAuditLog): AuditSeverity {
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
    (log.table_name === "ordenes" && fields.includes("estado"))
  ) {
    return "importante"
  }

  return "normal"
}

export function getAuditSection(log: SupabaseAuditLog) {
  if (log.table_name === "productos" || log.table_name.startsWith("producto_") || log.table_name === "imagenes_producto") {
    return "Productos"
  }

  if (log.table_name === "categorias") return "Categorías"
  if (log.table_name === "profiles") return "Usuarios y permisos"
  if (log.table_name.includes("banner") || log.table_name.includes("settings") || log.table_name.includes("config")) {
    return "Configuración visual"
  }

  return "Administración"
}

export function isGeneralAdminAuditLog(log: SupabaseAuditLog) {
  if (operationalTables.has(log.table_name)) return false
  if (!log.actor_email) return false

  if (log.table_name === "profiles") {
    return getChangedFields(log).some((field) => criticalFields.has(field))
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

export function getUndoDescription(log: SupabaseAuditLog) {
  const description = formatAuditDescription(log)

  if (log.action === "UPDATE") {
    return description.lines.length > 0 ? description.lines.join(" ") : description.title
  }

  if (log.action === "INSERT") return `eliminar ${getEntityLabel(log)}`

  return `recuperar ${getEntityLabel(log)}`
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

function getEntityLabel(log: SupabaseAuditLog) {
  if (isUndoAuditEvent(log)) return "una acción administrativa"

  const id = log.record_id ?? getRecordName(log)

  if (log.table_name === "ordenes") return `el pedido #${id}`
  if (log.table_name === "productos") return `el producto "${getRecordName(log)}"`
  if (log.table_name === "producto_variantes") return "una variante del producto"
  if (log.table_name === "categorias") return `la categoría "${getRecordName(log)}"`
  if (log.table_name === "profiles") return `el usuario "${getRecordName(log)}"`

  return `el registro "${getRecordName(log)}"`
}

function getUndoEventLines(log: SupabaseAuditLog) {
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

  if (originalAction !== "UPDATE" || !originalBeforeData || !originalAfterData) {
    return ["Se restauró el estado anterior del registro afectado."]
  }

  const restoredLog: SupabaseAuditLog = {
    ...log,
    action: "UPDATE",
    table_name: originalTableName,
    record_id: originalRecordId,
    before_data: originalAfterData,
    after_data: originalBeforeData,
  }

  return getChangedFields(restoredLog).map((field) => {
    const label = getHumanFieldName(field).toLowerCase()
    const restoredValue = formatHumanValue(originalBeforeData[field])

    return `Se restauró el ${label} anterior: "${restoredValue}".`
  })
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

function getChangeSentence(log: SupabaseAuditLog, field: string) {
  const label = getHumanFieldName(field)
  const article = getFieldArticle(label)
  const beforeValue = log.before_data?.[field]
  const afterValue = log.after_data?.[field]
  const beforeIsEmpty = isEmptyValue(beforeValue)
  const afterIsEmpty = isEmptyValue(afterValue)
  const lowerLabel = label.toLowerCase()

  if (!beforeIsEmpty && afterIsEmpty) return `Se eliminó ${article} ${lowerLabel}.`
  if (beforeIsEmpty && !afterIsEmpty) return `Se agregó ${article} ${lowerLabel}.`

  return `Cambió ${article} ${lowerLabel} de "${formatHumanValue(beforeValue)}" a "${formatHumanValue(afterValue)}".`
}

function formatHumanValue(value: unknown) {
  if (isEmptyValue(value)) return "vacío"
  if (typeof value === "boolean") return value ? "Sí" : "No"
  if (typeof value === "number") return String(value)
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? "" : "s"}`
  if (typeof value === "object") return "datos cargados"

  const text = String(value).trim()
  if (!text) return "vacío"
  if (/^https?:\/\//i.test(text)) return text.length > 48 ? `${text.slice(0, 45)}...` : text

  return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase().replaceAll("_", " ")
}

function getFieldArticle(label: string) {
  const normalized = label.trim().toLowerCase()

  if (
    normalized.startsWith("categoría") ||
    normalized.startsWith("descripción") ||
    normalized.startsWith("imagen")
  ) {
    return "la"
  }

  return "el"
}

function isEmptyValue(value: unknown) {
  return (
    value === null ||
    value === undefined ||
    value === "" ||
    (Array.isArray(value) && value.length === 0)
  )
}
