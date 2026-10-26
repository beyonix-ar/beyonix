import { ANALYTICS_SESSION_IDLE_MS, PRODUCT_VIEW_DEDUP_WINDOW_MS } from "./events.ts"

/**
 * Sesión anónima de Analítica: un UUID aleatorio en localStorage que rota
 * tras 30 minutos sin actividad. Es deliberadamente independiente de
 * `cartSessionId`: aquél es la credencial de propiedad de las reservas de
 * stock (copiarlo a una tabla que lee Admin ampliaría su exposición) y vive
 * en sessionStorage, así que cada pestaña nueva sería otra "sesión" e
 * inflaría las vistas. No crea usuarios ni perfiles y no guarda datos
 * personales.
 */

export const ANALYTICS_SESSION_STORAGE_KEY = "beyonix-analytics-session"

interface StoredAnalyticsSession {
  id: string
  lastActivityAt: number
  /** productId -> última vista enviada (ms). */
  views: Record<string, number>
}

type SessionStorageLike = Pick<Storage, "getItem" | "setItem">

/** Si el storage no está disponible (modo privado, bloqueado), la sesión dura lo que la página. */
let memorySession: StoredAnalyticsSession | null = null

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

function isStoredSession(value: unknown): value is StoredAnalyticsSession {
  if (!value || typeof value !== "object") return false
  const session = value as Partial<StoredAnalyticsSession>
  return (
    typeof session.id === "string" &&
    typeof session.lastActivityAt === "number" &&
    Boolean(session.views) &&
    typeof session.views === "object"
  )
}

function readSession(storage: SessionStorageLike | null): StoredAnalyticsSession | null {
  if (!storage) return memorySession
  try {
    const parsed: unknown = JSON.parse(storage.getItem(ANALYTICS_SESSION_STORAGE_KEY) ?? "null")
    return isStoredSession(parsed) ? parsed : null
  } catch {
    return null
  }
}

function writeSession(storage: SessionStorageLike | null, session: StoredAnalyticsSession) {
  memorySession = session
  if (!storage) return
  try {
    storage.setItem(ANALYTICS_SESSION_STORAGE_KEY, JSON.stringify(session))
  } catch {
    // Storage lleno o bloqueado: la sesión sigue en memoria.
  }
}

function getBrowserStorage(): SessionStorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage
  } catch {
    return null
  }
}

/**
 * Decide si esta apertura de producto debe enviarse y con qué sesión. Aplica
 * en el navegador la misma ventana que el servidor (que es quien decide), para
 * no mandar requests por cada refresh. `null` = no enviar.
 */
export function claimProductView(
  productId: number,
  now: number = Date.now(),
  storage: SessionStorageLike | null = getBrowserStorage(),
): { sessionId: string } | null {
  const stored = readSession(storage)
  const active = stored && now - stored.lastActivityAt < ANALYTICS_SESSION_IDLE_MS ? stored : null
  const sessionId = active?.id ?? createAnalyticsSessionId()
  if (!sessionId) return null

  const views: Record<string, number> = {}
  for (const [key, sentAt] of Object.entries(active?.views ?? {})) {
    if (now - sentAt < PRODUCT_VIEW_DEDUP_WINDOW_MS) views[key] = sentAt
  }

  const key = String(productId)
  const alreadySent = key in views
  if (!alreadySent) views[key] = now

  writeSession(storage, { id: sessionId, lastActivityAt: now, views })
  return alreadySent ? null : { sessionId }
}
