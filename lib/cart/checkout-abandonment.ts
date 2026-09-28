import { CHECKOUT_STEP_RESERVATION_KEY } from "./checkout-step-reservation.ts"
import type { StockReservationResult } from "./stock-reservations"

/**
 * Reservas del Paso 3 abandonadas (el cliente salió de /checkout) que todavía
 * hay que liberar en la base. Persistidas en sessionStorage para reintentar
 * en la próxima navegación si la liberación falla por un error transitorio;
 * el vencimiento de 20 minutos sigue siendo el último respaldo.
 */
export const CHECKOUT_PENDING_RELEASE_KEY = "beyonix-checkout-pending-release"
const MAX_PENDING_RELEASES = 5

type SessionStore = Pick<Storage, "getItem" | "setItem" | "removeItem">

/** /checkout y sus subrutas (retorno de Mercado Pago) cuentan como checkout. */
export function isCheckoutPath(pathname: string | null | undefined) {
  return pathname === "/checkout" || Boolean(pathname?.startsWith("/checkout/"))
}

export function pendingCheckoutReleases(storage: SessionStore): string[] {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(CHECKOUT_PENDING_RELEASE_KEY) ?? "[]")
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string" && id.length > 0) : []
  } catch {
    return []
  }
}

function savePendingReleases(storage: SessionStore, sessionIds: string[]) {
  if (sessionIds.length) {
    storage.setItem(CHECKOUT_PENDING_RELEASE_KEY, JSON.stringify(sessionIds.slice(-MAX_PENDING_RELEASES)))
  } else {
    storage.removeItem(CHECKOUT_PENDING_RELEASE_KEY)
  }
}

/**
 * Fuera de /checkout: la reserva del Paso 3 deja de pertenecer a este
 * checkout (sincrónico, antes de cualquier await) y queda pendiente de
 * liberar. Devuelve la sesión abandonada, o null si no había reserva.
 */
export function abandonCheckoutReservation(storage: SessionStore): string | null {
  const sessionId = storage.getItem(CHECKOUT_STEP_RESERVATION_KEY)
  if (!sessionId) return null
  storage.removeItem(CHECKOUT_STEP_RESERVATION_KEY)
  const pending = pendingCheckoutReleases(storage)
  if (!pending.includes(sessionId)) pending.push(sessionId)
  savePendingReleases(storage, pending)
  return sessionId
}

/**
 * Sólo un error transitorio deja la liberación pendiente. Todo lo demás es
 * definitivo: liberada, ya vencida, ligada a un pedido (pago iniciado: esa
 * reserva NO se libera desde acá) o sesión inexistente/ajena.
 */
function isSettled(result: StockReservationResult) {
  return result.success || result.code !== "INTERNAL_ERROR"
}

/**
 * Libera en la base las reservas abandonadas: `[]` borra los ítems de esa
 * sesión sin reiniciar su reloj (reserve_cart_stock). Idempotente.
 */
export async function releaseAbandonedCheckoutReservations(
  storage: SessionStore,
  release: (sessionId: string) => Promise<StockReservationResult>,
): Promise<{ released: string[] }> {
  const released: string[] = []
  for (const sessionId of pendingCheckoutReleases(storage)) {
    let result: StockReservationResult
    try {
      result = await release(sessionId)
    } catch {
      continue
    }
    if (!isSettled(result)) continue
    savePendingReleases(storage, pendingCheckoutReleases(storage).filter((id) => id !== sessionId))
    if (result.success) released.push(sessionId)
  }
  return { released }
}
