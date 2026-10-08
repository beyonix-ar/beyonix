import {
  HISTORY_STACK_STORAGE_KEY,
  parseHistoryStack,
  type HistoryStackState,
} from "./history-stack.ts"

/** Lectura/escritura de la pila en sessionStorage (sin dependencias de React ni Next). */
export function readHistoryStack(): HistoryStackState | null {
  try {
    return parseHistoryStack(window.sessionStorage.getItem(HISTORY_STACK_STORAGE_KEY))
  } catch {
    return null
  }
}

export function writeHistoryStack(state: HistoryStackState) {
  try {
    window.sessionStorage.setItem(HISTORY_STACK_STORAGE_KEY, JSON.stringify(state))
  } catch {
    // Sin sessionStorage (modo privado estricto): los "Volver" usan su ruta
    // de respaldo, nunca rompen la navegación.
  }
}
