import { MERCADOPAGO_CASH_EXCLUDED_PAYMENT_TYPES } from "../pricing/checkout-pricing.ts"

/**
 * Logos de medios de pago administrables (Admin → Financiación → "MEDIOS DE
 * PAGO DISPONIBLES"). Módulo puro: reglas de sincronización con Mercado Pago,
 * visibilidad para el cliente y validación de imágenes. El acceso a Mercado
 * Pago, Supabase y Storage vive en payment-method-logos-server.ts.
 *
 * Fuente de verdad de disponibilidad: Mercado Pago (`GET /v1/payment_methods`).
 * Mercado Pago repite el mismo `id` con distintos `payment_type_id` (p. ej.
 * `visa` como crédito y como prepaga), así que un logo se asocia al
 * `payment_method_id` y se guardan todos sus tipos.
 */

export const PAYMENT_METHOD_LOGOS_BUCKET = "payment-method-logos"
export const PAYMENT_METHOD_LOGO_MAX_BYTES = 1024 * 1024
export const PAYMENT_METHOD_NAME_MAX_LENGTH = 80

export type PaymentMethodLogoSource = "mercadopago" | "manual"
export type PaymentMethodProviderStatus = "active" | "inactive" | "missing"

/** Fila de public.payment_method_logos. */
export interface PaymentMethodLogoRow {
  id: string
  source: PaymentMethodLogoSource
  provider_method_id: string | null
  provider_name: string | null
  provider_payment_types: string[]
  provider_status: PaymentMethodProviderStatus | null
  display_name: string
  image_path: string | null
  enabled: boolean
  needs_review: boolean
  first_seen_at: string | null
  last_seen_at: string | null
  last_synced_at: string | null
  updated_at: string
}

export const PAYMENT_METHOD_LOGO_SELECT =
  "id, source, provider_method_id, provider_name, provider_payment_types, provider_status, display_name, image_path, enabled, needs_review, first_seen_at, last_seen_at, last_synced_at, updated_at"

/** Un payment_method_id de Mercado Pago, con todos sus tipos. */
export interface MercadoPagoPaymentMethodSummary {
  id: string
  name: string
  paymentTypes: string[]
  active: boolean
}

// Orden para elegir el nombre visible y agrupar: "Visa" (crédito) antes que
// "Visa Prepaid" (prepaga).
const PAYMENT_TYPE_PRIORITY = [
  "credit_card",
  "debit_card",
  "prepaid_card",
  "account_money",
  "digital_currency",
  "digital_wallet",
  "bank_transfer",
  "ticket",
  "atm",
] as const

function paymentTypeRank(type: string) {
  const index = (PAYMENT_TYPE_PRIORITY as readonly string[]).indexOf(type)
  return index === -1 ? PAYMENT_TYPE_PRIORITY.length : index
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

const PROVIDER_ID_PATTERN = /^[a-z0-9_-]{1,64}$/

/**
 * Respuesta de `GET /v1/payment_methods` agrupada por id. `null` si no tiene
 * el formato esperado: sin datos confiables no se toca el último estado
 * conocido. Entradas individuales inválidas se ignoran.
 */
export function parseMercadoPagoPaymentMethods(response: unknown): MercadoPagoPaymentMethodSummary[] | null {
  if (!Array.isArray(response)) return null
  const byId = new Map<string, { entries: Array<{ name: string; type: string; active: boolean }> }>()

  for (const value of response) {
    const entry = asRecord(value)
    const id = typeof entry?.id === "string" ? entry.id.trim().toLowerCase() : ""
    const name = typeof entry?.name === "string" ? entry.name.trim() : ""
    const type = typeof entry?.payment_type_id === "string" ? entry.payment_type_id.trim() : ""
    const status = typeof entry?.status === "string" ? entry.status.trim() : ""
    if (!PROVIDER_ID_PATTERN.test(id) || !name || !type || !status) continue
    const current = byId.get(id) ?? { entries: [] }
    current.entries.push({ name: name.slice(0, 120), type, active: status === "active" })
    byId.set(id, current)
  }

  if (response.length > 0 && byId.size === 0) return null

  return [...byId.entries()]
    .map(([id, { entries }]) => {
      const sorted = [...entries].sort((left, right) => paymentTypeRank(left.type) - paymentTypeRank(right.type))
      const activeEntries = sorted.filter((entry) => entry.active)
      return {
        id,
        name: (activeEntries[0] ?? sorted[0]).name,
        paymentTypes: [...new Set(sorted.map((entry) => entry.type))],
        active: activeEntries.length > 0,
      }
    })
    .sort((left, right) => left.name.localeCompare(right.name, "es"))
}

export interface PaymentMethodSyncInsert {
  source: "mercadopago"
  provider_method_id: string
  provider_name: string
  provider_payment_types: string[]
  provider_status: PaymentMethodProviderStatus
  display_name: string
  enabled: true
  needs_review: boolean
  first_seen_at: string
  last_seen_at: string
  last_synced_at: string
  updated_at: string
}

export interface PaymentMethodSyncUpdate {
  id: string
  changes: {
    provider_name?: string
    provider_payment_types?: string[]
    provider_status: PaymentMethodProviderStatus
    last_seen_at?: string
    last_synced_at: string
    updated_at: string
  }
}

export interface PaymentMethodSyncPlan {
  inserts: PaymentMethodSyncInsert[]
  updates: PaymentMethodSyncUpdate[]
  summary: { added: number; deactivated: number; reactivated: number; missing: number }
}

/**
 * Diferencia entre lo que informa Mercado Pago y lo guardado. Nunca borra
 * filas, imágenes ni la habilitación manual: sólo actualiza el estado del
 * proveedor. Un id que deja de figurar queda 'missing' (oculto); si vuelve,
 * se reactiva solo. Un id nuevo nace habilitado y sin imagen (no se muestra
 * hasta cargarla); fuera de la primera importación se marca "Nuevo medio
 * disponible".
 */
export function planPaymentMethodSync(
  existing: ReadonlyArray<Pick<PaymentMethodLogoRow, "id" | "source" | "provider_method_id" | "provider_status" | "provider_name" | "provider_payment_types">>,
  methods: ReadonlyArray<MercadoPagoPaymentMethodSummary>,
  nowIso: string,
): PaymentMethodSyncPlan {
  const mercadoPagoRows = existing.filter((row) => row.source === "mercadopago" && row.provider_method_id)
  const rowsById = new Map(mercadoPagoRows.map((row) => [row.provider_method_id as string, row]))
  const initialImport = mercadoPagoRows.length === 0
  const seen = new Set<string>()
  const plan: PaymentMethodSyncPlan = { inserts: [], updates: [], summary: { added: 0, deactivated: 0, reactivated: 0, missing: 0 } }

  for (const method of methods) {
    seen.add(method.id)
    const status: PaymentMethodProviderStatus = method.active ? "active" : "inactive"
    const row = rowsById.get(method.id)
    if (!row) {
      plan.inserts.push({
        source: "mercadopago",
        provider_method_id: method.id,
        provider_name: method.name,
        provider_payment_types: method.paymentTypes,
        provider_status: status,
        display_name: method.name.slice(0, PAYMENT_METHOD_NAME_MAX_LENGTH),
        enabled: true,
        needs_review: !initialImport,
        first_seen_at: nowIso,
        last_seen_at: nowIso,
        last_synced_at: nowIso,
        updated_at: nowIso,
      })
      plan.summary.added += 1
      continue
    }
    if (row.provider_status !== "active" && status === "active") plan.summary.reactivated += 1
    if (row.provider_status === "active" && status !== "active") plan.summary.deactivated += 1
    plan.updates.push({
      id: row.id,
      changes: {
        provider_name: method.name,
        provider_payment_types: method.paymentTypes,
        provider_status: status,
        last_seen_at: nowIso,
        last_synced_at: nowIso,
        updated_at: nowIso,
      },
    })
  }

  for (const row of mercadoPagoRows) {
    if (seen.has(row.provider_method_id as string)) continue
    if (row.provider_status !== "missing") plan.summary.missing += 1
    plan.updates.push({
      id: row.id,
      changes: { provider_status: "missing", last_synced_at: nowIso, updated_at: nowIso },
    })
  }

  return plan
}

type VisibilityRow = Pick<PaymentMethodLogoRow, "source" | "provider_status" | "image_path" | "enabled" | "provider_payment_types">

/** Tipos que el checkout de BEYONIX nunca ofrece (efectivo diferido). */
const CHECKOUT_EXCLUDED_TYPES = new Set(MERCADOPAGO_CASH_EXCLUDED_PAYMENT_TYPES.map((type) => type.id as string))

export function getCheckoutPaymentTypes(types: readonly string[]) {
  return types.filter((type) => !CHECKOUT_EXCLUDED_TYPES.has(type))
}

export type PaymentMethodVisibility =
  | { visible: true }
  | { visible: false; reason: "no_image" | "disabled" | "provider_inactive" | "provider_missing" | "not_offered" }

/**
 * Regla única de activación. Mercado Pago: imagen cargada + habilitado +
 * Mercado Pago lo informa activo + al menos un tipo que el checkout ofrece
 * (Rapipago/Pago Fácil están excluidos). Manual: imagen + habilitado
 * explícitamente.
 */
export function getPaymentMethodVisibility(row: VisibilityRow): PaymentMethodVisibility {
  if (row.source === "mercadopago") {
    if (row.provider_status === "missing") return { visible: false, reason: "provider_missing" }
    if (row.provider_status !== "active") return { visible: false, reason: "provider_inactive" }
    if (getCheckoutPaymentTypes(row.provider_payment_types).length === 0) return { visible: false, reason: "not_offered" }
  }
  if (!row.image_path) return { visible: false, reason: "no_image" }
  if (!row.enabled) return { visible: false, reason: "disabled" }
  return { visible: true }
}

export interface PaymentMethodsSyncState {
  lastAttemptAt: string | null
  lastSuccessAt: string | null
  lastError: string | null
}

/** Vista de Admin: la fila más su URL pública y por qué se muestra o no. */
export interface AdminPaymentMethodLogo extends PaymentMethodLogoRow {
  imageUrl: string | null
  visibility: PaymentMethodVisibility
}

export interface AdminPaymentMethodsOverview {
  sync: PaymentMethodsSyncState
  methods: AdminPaymentMethodLogo[]
}

export function toAdminPaymentMethodLogo(row: PaymentMethodLogoRow, imageUrl: string | null): AdminPaymentMethodLogo {
  return { ...row, imageUrl, visibility: getPaymentMethodVisibility(row) }
}

/** Lo único que recibe la tienda: sin estados internos ni rutas de Storage. */
export interface PublicPaymentMethodLogo {
  key: string
  source: PaymentMethodLogoSource
  providerMethodId: string | null
  name: string
  paymentTypes: string[]
  imageUrl: string
}

export function toPublicPaymentMethodLogos(
  rows: ReadonlyArray<PaymentMethodLogoRow>,
  publicUrl: (path: string) => string,
): PublicPaymentMethodLogo[] {
  return rows
    .filter((row) => getPaymentMethodVisibility(row).visible)
    .map((row) => ({
      key: row.id,
      source: row.source,
      providerMethodId: row.provider_method_id,
      name: row.display_name,
      paymentTypes: row.source === "mercadopago" ? getCheckoutPaymentTypes(row.provider_payment_types) : [],
      imageUrl: publicUrl(row.image_path as string),
    }))
    .sort(comparePublicLogos)
}

function primaryRank(logo: Pick<PublicPaymentMethodLogo, "source" | "paymentTypes">) {
  if (logo.source === "manual") return PAYMENT_TYPE_PRIORITY.length + 1
  return Math.min(...logo.paymentTypes.map(paymentTypeRank), PAYMENT_TYPE_PRIORITY.length)
}

function comparePublicLogos(left: PublicPaymentMethodLogo, right: PublicPaymentMethodLogo) {
  return primaryRank(left) - primaryRank(right) || left.name.localeCompare(right.name, "es")
}

export type CheckoutLogoGroupId = "credit" | "debit" | "prepaid" | "mercadopago" | "other"

export interface CheckoutLogoGroup {
  id: CheckoutLogoGroupId
  label: string
  logos: PublicPaymentMethodLogo[]
}

const GROUP_BY_TYPE: Record<string, { id: CheckoutLogoGroupId; label: string }> = {
  credit_card: { id: "credit", label: "Tarjetas de crédito (1 pago)" },
  debit_card: { id: "debit", label: "Tarjetas de débito" },
  prepaid_card: { id: "prepaid", label: "Tarjetas prepagas" },
  account_money: { id: "mercadopago", label: "Mercado Pago" },
}
const OTHER_GROUP = { id: "other" as const, label: "Otros medios de Mercado Pago" }

/**
 * "Mercado Pago en 1 pago": logos de Mercado Pago agrupados por su tipo
 * principal. Los medios manuales nunca se presentan como medios de Mercado
 * Pago.
 */
export function getCheckoutCashLogoGroups(logos: ReadonlyArray<PublicPaymentMethodLogo>): CheckoutLogoGroup[] {
  const groups = new Map<CheckoutLogoGroupId, CheckoutLogoGroup>()
  for (const logo of logos) {
    if (logo.source !== "mercadopago" || logo.paymentTypes.length === 0) continue
    const primary = [...logo.paymentTypes].sort((left, right) => paymentTypeRank(left) - paymentTypeRank(right))[0]
    const group = GROUP_BY_TYPE[primary] ?? OTHER_GROUP
    const current = groups.get(group.id) ?? { ...group, logos: [] }
    current.logos.push(logo)
    groups.set(group.id, current)
  }
  const order: CheckoutLogoGroupId[] = ["credit", "debit", "prepaid", "mercadopago", "other"]
  return order.flatMap((id) => (groups.has(id) ? [groups.get(id) as CheckoutLogoGroup] : []))
}

/** Logo de una marca de crédito (cuotas sin interés: visa, master). */
export function findCreditLogo(logos: ReadonlyArray<PublicPaymentMethodLogo>, providerMethodId: string) {
  return logos.find(
    (logo) => logo.source === "mercadopago" && logo.providerMethodId === providerMethodId && logo.paymentTypes.includes("credit_card"),
  ) ?? null
}

export type PaymentLogoFormat = "png" | "svg" | "webp" | "jpg"

export const PAYMENT_LOGO_MIME_FORMATS: Record<string, PaymentLogoFormat> = {
  "image/png": "png",
  "image/svg+xml": "svg",
  "image/webp": "webp",
  "image/jpeg": "jpg",
}

export const PAYMENT_LOGO_ACCEPT = ".png,.svg,.webp,.jpg,.jpeg,image/png,image/svg+xml,image/webp,image/jpeg"

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff]

function startsWith(bytes: Uint8Array, signature: readonly number[]) {
  return bytes.length >= signature.length && signature.every((byte, index) => bytes[index] === byte)
}

// Un SVG sólo se acepta como dibujo estático: sin scripts, eventos, contenido
// embebido ni referencias externas (un SVG abierto directamente desde Storage
// podría ejecutar código). Las referencias internas (#id) se permiten.
const SVG_FORBIDDEN_PATTERNS: RegExp[] = [
  /<script\b/i,
  /<!doctype\b/i,
  /<!entity\b/i,
  /<foreignobject\b/i,
  /<(iframe|embed|object|audio|video|canvas|meta|link|base)\b/i,
  /\son[a-z]+\s*=/i,
  /javascript\s*:/i,
  /@import\b/i,
  /url\(\s*['"]?\s*(?!#)/i,
]
const SVG_HREF_PATTERN = /\b(?:xlink:)?href\s*=\s*(["'])(.*?)\1/gi

export function getSvgSafetyError(text: string): string | null {
  const content = text.replace(/^﻿/, "").trim()
  if (!/^(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(content) || !/<\/svg>\s*$/i.test(content)) {
    return "El archivo SVG no es válido."
  }
  if (SVG_FORBIDDEN_PATTERNS.some((pattern) => pattern.test(content))) {
    return "El SVG contiene scripts, eventos o contenido externo. Exportalo como dibujo simple o usá PNG."
  }
  for (const match of content.matchAll(SVG_HREF_PATTERN)) {
    if (!match[2].trim().startsWith("#")) {
      return "El SVG contiene referencias externas. Exportalo como dibujo simple o usá PNG."
    }
  }
  return null
}

/**
 * Validación server-side de un logo: el MIME declarado por el navegador no
 * alcanza, se verifican los bytes reales (firma o contenido SVG seguro).
 */
export function validatePaymentLogoUpload(
  bytes: Uint8Array,
  mimeType: string,
): { ok: true; format: PaymentLogoFormat; contentType: string } | { ok: false; error: string } {
  const format = PAYMENT_LOGO_MIME_FORMATS[mimeType]
  if (!format) return { ok: false, error: "Formato no admitido. Subí PNG, SVG, WebP o JPG." }
  if (bytes.length === 0) return { ok: false, error: "El archivo está vacío." }
  if (bytes.length > PAYMENT_METHOD_LOGO_MAX_BYTES) return { ok: false, error: "La imagen puede pesar hasta 1 MB." }

  if (format === "svg") {
    let text: string
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    } catch {
      return { ok: false, error: "El archivo SVG no es válido." }
    }
    const error = getSvgSafetyError(text)
    return error ? { ok: false, error } : { ok: true, format, contentType: mimeType }
  }

  const signatureOk =
    format === "png"
      ? startsWith(bytes, PNG_SIGNATURE)
      : format === "jpg"
        ? startsWith(bytes, JPEG_SIGNATURE)
        : bytes.length >= 12 &&
          String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
          String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
  return signatureOk
    ? { ok: true, format, contentType: mimeType }
    : { ok: false, error: "El contenido del archivo no coincide con su formato." }
}

export function buildPaymentLogoPath(rowId: string, format: PaymentLogoFormat, nowMs: number) {
  return `${rowId}/${nowMs}.${format}`
}

export function normalizePaymentMethodName(value: unknown): string | null {
  if (typeof value !== "string") return null
  const name = value.normalize("NFC").replace(/\s+/g, " ").trim()
  if (!name || name.length > PAYMENT_METHOD_NAME_MAX_LENGTH || /[\u0000-\u001f\u007f<>]/.test(name)) return null
  return name
}

const PAYMENT_TYPE_LABELS: Record<string, string> = {
  credit_card: "Crédito",
  debit_card: "Débito",
  prepaid_card: "Prepaga",
  account_money: "Dinero en cuenta",
  ticket: "Efectivo",
  atm: "Cajero",
  bank_transfer: "Transferencia",
  digital_currency: "Moneda digital",
  digital_wallet: "Billetera",
}

export function getPaymentTypeLabel(type: string) {
  return PAYMENT_TYPE_LABELS[type] ?? type
}
