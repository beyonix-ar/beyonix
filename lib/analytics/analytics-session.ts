import { getBrowserAnalyticsStore, type AnalyticsStore } from "./analytics-storage.ts"
import { ANALYTICS_SESSION_IDLE_MS } from "./events.ts"

/**
 * Sesión anónima de Analítica.
 *
 * - Identidad: un UUID v4 aleatorio. Es deliberadamente independiente de
 *   `cartSessionId` (credencial de las reservas de stock, por pestaña). No
 *   crea usuarios ni perfiles y no guarda datos personales.
 * - Actividad: `touchAnalyticsSession()` la renueva. El `session_id` se
 *   mantiene mientras haya actividad con menos de 30 minutos entre una y la
 *   siguiente; tras 30 minutos reales sin actividad, la próxima actividad
 *   abre otra sesión.
 * - Qué cuenta como actividad: hoy, abrir un producto (`product_view`). Los
 *   próximos eventos (page_view, add_to_cart, search...) llaman a la misma
 *   función. No hay timers: la sesión sólo se evalúa cuando hay actividad.
 */

export const ANALYTICS_SESSION_STORAGE_KEY = "beyonix-analytics-session"

export interface AnalyticsSession {
  id: string
  lastActivityAt: number
}

function formatUuidV4(bytes: Uint8Array) {
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** UUID v4 criptográfico, o `null` sin Web Crypto (en ese caso no se mide: nunca un id predecible). */
export function createAnalyticsSessionId(): string | null {
  const cryptoRef = globalThis.crypto as Partial<Crypto> | undefined
  if (typeof cryptoRef?.randomUUID === "function") return cryptoRef.randomUUID()
  if (typeof cryptoRef?.getRandomValues === "function") {
    return formatUuidV4(cryptoRef.getRandomValues(new Uint8Array(16)))
  }
  return null
}

function isAnalyticsSession(value: unknown): value is AnalyticsSession {
  if (!value || typeof value !== "object") return false
  const session = value as Partial<AnalyticsSession>
  return typeof session.id === "string" && typeof session.lastActivityAt === "number"
}

/** Sesión vigente sin registrar actividad (`null` si no hay o venció). */
export function readAnalyticsSession(
  now: number = Date.now(),
  store: AnalyticsStore = getBrowserAnalyticsStore(),
): AnalyticsSession | null {
  const session = store.read(ANALYTICS_SESSION_STORAGE_KEY, isAnalyticsSession)
  return session && now - session.lastActivityAt < ANALYTICS_SESSION_IDLE_MS ? session : null
}

/**
 * Registra actividad real del visitante: renueva la ventana de 30 minutos de
 * la sesión vigente o, si venció, abre una nueva. `null` sólo sin Web Crypto.
 */
export function touchAnalyticsSession(
  now: number = Date.now(),
  store: AnalyticsStore = getBrowserAnalyticsStore(),
): AnalyticsSession | null {
  const id = readAnalyticsSession(now, store)?.id ?? createAnalyticsSessionId()
  if (!id) return null
  const session = { id, lastActivityAt: now }
  store.write(ANALYTICS_SESSION_STORAGE_KEY, session)
  return session
}
