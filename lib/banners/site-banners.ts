import { argentinaLocalToUtcIso, toArgentinaLocalParts } from "../commercial-events/argentina-time.ts"

/**
 * Banners del sitio (site_banner_items): Productos (carrusel existente) y
 * campañas del HOME. Reglas compartidas por Admin, API y tests: estado
 * calculado (sin columna de estado), prioridad, validación de imágenes y
 * enlaces, y vigencia [inicio, fin) en hora de Argentina.
 */

export const BANNER_PLACEMENTS = ["products", "home"] as const
export type BannerPlacement = (typeof BANNER_PLACEMENTS)[number]

export const BANNER_STORAGE_BUCKET = "site-banners"
export const BANNER_MAX_FILE_BYTES = 5 * 1024 * 1024
/**
 * Formatos por ubicación. Home: JPG, PNG, WebP y AVIF (optimizables por
 * next/image). Productos conserva además GIF (su carrusel usa <img>, que lo
 * muestra igual que antes). SVG nunca: en un bucket público puede ejecutar
 * scripts y ningún banner lo usó.
 */
export const HOME_BANNER_MIME_TYPES = ["image/jpeg", "image/png", "image/webp", "image/avif"] as const
export const BANNER_ALLOWED_MIME_TYPES = [...HOME_BANNER_MIME_TYPES, "image/gif"] as const
export type BannerImageMime = (typeof BANNER_ALLOWED_MIME_TYPES)[number]
export const BANNER_MIME_EXTENSIONS: Record<BannerImageMime, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/gif": "gif",
}

export const BANNER_FORMATS_LABEL: Record<"home" | "products", string> = {
  home: "JPG, PNG, WebP o AVIF",
  products: "JPG, PNG, WebP, AVIF o GIF",
}

/** ¿El tipo real del archivo se admite en esta ubicación? */
export function isBannerMimeAllowed(mime: BannerImageMime | null, placement: "home" | "products") {
  if (!mime) return false
  return placement === "home" ? (HOME_BANNER_MIME_TYPES as readonly string[]).includes(mime) : true
}

/** Medidas recomendadas del HOME (no obligatorias): panorámica en escritorio, 3:2 en celular. */
export const HOME_BANNER_DESKTOP = { width: 1920, height: 480 } as const
export const HOME_BANNER_MOBILE = { width: 960, height: 640 } as const
export const HOME_BANNER_HELP =
  `Escritorio: ${HOME_BANNER_DESKTOP.width} × ${HOME_BANNER_DESKTOP.height} px (4:1). ` +
  `Celular (opcional): ${HOME_BANNER_MOBILE.width} × ${HOME_BANNER_MOBILE.height} px (3:2). JPG, PNG, WebP o AVIF de hasta 5 MB.`

export const CAMPAIGN_NAME_MAX = 120
export const DEFAULT_ALT_TEXT: Record<BannerPlacement, string> = {
  products: "Banner de productos BEYONIX",
  home: "Campaña BEYONIX",
}

/** Destinos externos admitidos (siempre https). Las rutas internas ("/…") se admiten siempre. */
export const BANNER_EXTERNAL_HOSTS = ["beyonix.com.ar", "www.beyonix.com.ar", "instagram.com", "www.instagram.com"] as const

/** Prioridad (sort_order): entero entre estos límites; menor número = se muestra primero. */
export const BANNER_SORT_ORDER_MIN = -999
export const BANNER_SORT_ORDER_MAX = 999

export type SortOrderResult = { ok: true; value: number } | { ok: false; error: string }

/**
 * Prioridad del formulario o de la API: entero sin decimales dentro del rango.
 * Vacío, texto, decimales, exponentes o fuera de rango se rechazan (nunca se
 * convierten en 0 en silencio).
 */
export function parseBannerSortOrder(input: unknown): SortOrderResult {
  const error = `La prioridad tiene que ser un número entero entre ${BANNER_SORT_ORDER_MIN} y ${BANNER_SORT_ORDER_MAX}.`
  const text = typeof input === "number" ? String(input) : typeof input === "string" ? input.trim() : ""
  if (!/^-?\d{1,4}$/.test(text)) return { ok: false, error }
  const value = Number(text)
  return Number.isSafeInteger(value) && value >= BANNER_SORT_ORDER_MIN && value <= BANNER_SORT_ORDER_MAX
    ? { ok: true, value: value === 0 ? 0 : value }
    : { ok: false, error }
}

export const isBannerPlacement = (value: unknown): value is BannerPlacement =>
  typeof value === "string" && (BANNER_PLACEMENTS as readonly string[]).includes(value)

// ── Estado y prioridad ───────────────────────────────────────────────────────

export type BannerStatus = "disabled" | "scheduled" | "active" | "ended"

export const BANNER_STATUS_LABELS: Record<BannerStatus, string> = {
  disabled: "Desactivada",
  scheduled: "Programada",
  active: "Activa",
  ended: "Finalizada",
}

export interface BannerSchedule {
  active: boolean
  starts_at?: string | null
  ends_at?: string | null
}

/** Vigencia semiabierta [starts_at, ends_at): inicio inclusivo, fin exclusivo. Sin fechas = permanente. */
export function getBannerStatus(banner: BannerSchedule, nowMs: number): BannerStatus {
  if (!banner.active) return "disabled"
  const startsAt = banner.starts_at ? Date.parse(banner.starts_at) : null
  const endsAt = banner.ends_at ? Date.parse(banner.ends_at) : null
  if (endsAt !== null && Number.isFinite(endsAt) && nowMs >= endsAt) return "ended"
  if (startsAt !== null && Number.isFinite(startsAt) && nowMs < startsAt) return "scheduled"
  return "active"
}

export interface BannerOrderKey {
  id: string
  sort_order: number
  created_at?: string | null
}

/** Prioridad estable: menor sort_order, después el más antiguo y, por último, el id. */
export function compareBannerPriority(left: BannerOrderKey, right: BannerOrderKey) {
  return left.sort_order - right.sort_order
    || (Date.parse(left.created_at ?? "") || 0) - (Date.parse(right.created_at ?? "") || 0)
    || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
}

/** La campaña que el HOME muestra ahora (la primera vigente por prioridad) o null. */
export function pickVisibleBanner<T extends BannerOrderKey & BannerSchedule>(banners: readonly T[], nowMs: number): T | null {
  return [...banners].filter((banner) => getBannerStatus(banner, nowMs) === "active").sort(compareBannerPriority)[0] ?? null
}

// ── Fechas (hora de Argentina) ───────────────────────────────────────────────

const MINUTE_MS = 60_000

/** Inicio inclusivo: "26/12 09:00" → instante UTC de ese minuto. */
export function bannerStartToUtc(date: string, time: string) {
  return argentinaLocalToUtcIso(date, time)
}

/**
 * Fin inclusivo para el Admin ("visible hasta el 26/12 a las 23:59") → fin
 * exclusivo almacenado (27/12 00:00 en Argentina, en UTC).
 */
export function bannerInclusiveEndToUtc(date: string, time: string) {
  const instant = argentinaLocalToUtcIso(date, time)
  return instant ? new Date(Date.parse(instant) + MINUTE_MS).toISOString() : null
}

/** Partes locales para el formulario: inicio tal cual, fin como último minuto visible. */
export function bannerStartParts(startsAt: string | null | undefined) {
  return startsAt ? toArgentinaLocalParts(startsAt) : { date: "", time: "" }
}

export function bannerInclusiveEndParts(endsAt: string | null | undefined) {
  return endsAt ? toArgentinaLocalParts(new Date(Date.parse(endsAt) - MINUTE_MS)) : { date: "", time: "" }
}

// ── Enlaces ──────────────────────────────────────────────────────────────────

export type DestinationResult = { ok: true; value: string | null } | { ok: false; error: string }

const CONTROL_CHARS = /[\u0000-\u001f\u007f\s]/

/**
 * Enlace al hacer clic: vacío (sin enlace), ruta interna ("/productos?x=1")
 * o https a un dominio admitido. Rechaza javascript:, data:, http:, "//host",
 * barras invertidas, espacios y URLs mal formadas.
 */
export function validateBannerDestination(input: unknown): DestinationResult {
  const value = typeof input === "string" ? input.trim() : ""
  if (!value) return { ok: true, value: null }
  if (value.length > 2048 || CONTROL_CHARS.test(value) || value.includes("\\")) {
    return { ok: false, error: "El enlace de destino no es válido." }
  }
  if (value.startsWith("/")) {
    if (value.startsWith("//")) return { ok: false, error: "El enlace de destino no es válido." }
    try {
      const parsed = new URL(value, "https://destino.invalid")
      if (parsed.origin !== "https://destino.invalid") return { ok: false, error: "El enlace de destino no es válido." }
      return { ok: true, value: `${parsed.pathname}${parsed.search}${parsed.hash}` }
    } catch {
      return { ok: false, error: "El enlace de destino no es válido." }
    }
  }
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return { ok: false, error: "El enlace de destino no es válido. Usá una ruta interna (/productos) o una dirección https." }
  }
  if (parsed.protocol !== "https:") return { ok: false, error: "El enlace externo tiene que empezar con https://." }
  if (parsed.username || parsed.password || parsed.port) return { ok: false, error: "El enlace de destino no es válido." }
  if (!(BANNER_EXTERNAL_HOSTS as readonly string[]).includes(parsed.hostname.toLowerCase())) {
    return { ok: false, error: `Dominio externo no admitido. Admitidos: ${BANNER_EXTERNAL_HOSTS.join(", ")}.` }
  }
  return { ok: true, value: parsed.toString() }
}

/** Destino interno (navegación dentro del sitio) o externo (pestaña nueva). */
export const isInternalDestination = (value: string) => value.startsWith("/") && !value.startsWith("//")

// ── Imágenes ─────────────────────────────────────────────────────────────────

/** Prefijo público del bucket de banners del proyecto (el único origen admitido para el HOME). */
export function bannerPublicPrefix(supabaseUrl: string | undefined) {
  const base = (supabaseUrl ?? "").trim().replace(/\/+$/, "")
  return base ? `${base}/storage/v1/object/public/${BANNER_STORAGE_BUCKET}/` : ""
}

/** Ruta dentro del bucket si la URL es un archivo público del bucket de banners; si no, null. */
export function bannerStoragePath(url: string, supabaseUrl: string | undefined) {
  const prefix = bannerPublicPrefix(supabaseUrl)
  if (!prefix || !url.startsWith(prefix)) return null
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.search || parsed.hash || parsed.username || parsed.password) return null
  let path: string
  try {
    path = decodeURIComponent(url.slice(prefix.length))
  } catch {
    return null
  }
  if (!path || path.includes("..") || path.includes("\\") || path.startsWith("/") || CONTROL_CHARS.test(path)) return null
  return path
}

export type ImageUrlResult = { ok: true; value: string; storagePath: string | null } | { ok: false; error: string }

/**
 * HOME: sólo archivos del bucket propio (origen controlado y compatible con
 * next/image). Productos conserva URLs externas como antes, pero sólo http(s).
 */
export function validateBannerImageUrl(input: unknown, placement: BannerPlacement, supabaseUrl: string | undefined): ImageUrlResult {
  const value = typeof input === "string" ? input.trim() : ""
  if (!value) return { ok: false, error: "Cargá una imagen." }
  if (value.length > 2048 || CONTROL_CHARS.test(value)) return { ok: false, error: "La URL de la imagen no es válida." }
  const storagePath = bannerStoragePath(value, supabaseUrl)
  if (placement === "home") {
    return storagePath
      ? { ok: true, value, storagePath }
      : { ok: false, error: "Las imágenes del Home se suben desde este panel (bucket de banners de BEYONIX)." }
  }
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return { ok: false, error: "La URL de la imagen tiene que empezar con https://." }
  } catch {
    return { ok: false, error: "La URL de la imagen no es válida." }
  }
  return { ok: true, value, storagePath }
}

/** Tipo real por firma del archivo (no por extensión ni Content-Type declarado). */
export function detectBannerImageMime(bytes: Uint8Array): BannerImageMime | null {
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end))
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg"
  if (bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, index) => bytes[index] === byte)) return "image/png"
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp"
  if (bytes.length >= 6 && (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a")) return "image/gif"
  if (bytes.length >= 12 && ascii(4, 8) === "ftyp") {
    const boxSize = Math.min(bytes.length, ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0 || 32)
    for (let offset = 8; offset + 4 <= boxSize; offset += 4) {
      const brand = ascii(offset, offset + 4)
      if (brand === "avif" || brand === "avis") return "image/avif"
    }
  }
  return null
}
