/**
 * Pila de URLs internas de BEYONIX en la pestaña actual, para que los botones
 * "Volver" usen el historial real (router.back) sólo cuando la entrada
 * anterior es de la tienda, y si no, una ruta de respaldo lógica.
 *
 * No toca window.history: sólo observa cambios de URL. Cómo se clasifica
 * cada cambio:
 * - después de un `popstate` → "pop" (se asume Atrás, el caso habitual);
 * - si `history.length` creció → "push";
 * - si no → "replace" (router.replace no agrega entradas).
 * Un push justo después de un Atrás (que trunca el "adelante" sin hacer
 * crecer history.length) también cuenta como replace: la pila puede quedar
 * más corta que el historial real (los "Volver" usan su ruta de respaldo),
 * pero nunca más larga, que es lo que podría sacar al cliente del sitio.
 */
export type HistoryStackState = {
  stack: string[]
  /** history.length observado en el último cambio. */
  length: number
}

export const HISTORY_STACK_STORAGE_KEY = "beyonix:history-stack"
const MAX_ENTRIES = 50

export function createHistoryStack(url: string, historyLength: number): HistoryStackState {
  return { stack: [url], length: historyLength }
}

/**
 * Estado inicial al montar la app (carga o recarga de la pestaña): si lo
 * guardado termina en la URL actual es la misma sesión (recarga) y se
 * conserva; si no, la pila arranca en esta URL.
 */
export function restoreHistoryStack(saved: HistoryStackState | null, url: string, historyLength: number): HistoryStackState {
  if (saved && saved.stack.length > 0 && saved.stack[saved.stack.length - 1] === url) {
    return { ...saved, length: historyLength }
  }
  return createHistoryStack(url, historyLength)
}

export function recordNavigation(
  state: HistoryStackState,
  url: string,
  historyLength: number,
  cause: "pop" | "change",
): HistoryStackState {
  const top = state.stack[state.stack.length - 1]
  if (cause === "pop") {
    const stack = state.stack.length > 1 ? state.stack.slice(0, -1) : [url]
    // Si lo que queda arriba no coincide (fue un "Adelante" u otro salto), se
    // re-sincroniza la cima con la URL real.
    stack[stack.length - 1] = url
    return { stack, length: historyLength }
  }
  if (url === top) return { ...state, length: historyLength }
  const pushed = historyLength > state.length
  const stack = pushed ? [...state.stack, url].slice(-MAX_ENTRIES) : [...state.stack.slice(0, -1), url]
  return { stack, length: historyLength }
}

/** URL interna anterior (si existe y el navegador realmente puede volver). */
export function previousInternalUrl(state: HistoryStackState | null, historyLength: number) {
  if (!state || state.stack.length < 2 || historyLength < 2) return null
  return state.stack[state.stack.length - 2]
}

export function parseHistoryStack(raw: string | null): HistoryStackState | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Partial<HistoryStackState>
    if (!Array.isArray(value.stack) || !value.stack.every((entry) => typeof entry === "string")) return null
    return {
      stack: value.stack,
      length: typeof value.length === "number" ? value.length : 0,
    }
  } catch {
    return null
  }
}
