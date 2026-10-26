/**
 * Almacenamiento del estado de Analítica en el navegador (sesión y envíos).
 *
 * Usa localStorage mientras funcione. La PRIMERA vez que falla una lectura o
 * una escritura (modo privado, cuota llena, storage bloqueado), queda marcado
 * como no disponible durante toda la ejecución y desde ahí todo vive en una
 * única copia en memoria: nunca se vuelve a leer un storage que no pudo
 * guardar, así no aparecen sesiones nuevas en cada lectura.
 */

export type AnalyticsStorageLike = Pick<Storage, "getItem" | "setItem">

export interface AnalyticsStore {
  read<T>(key: string, isValid: (value: unknown) => value is T): T | null
  write(key: string, value: unknown): void
  /** `false` una vez que localStorage falló en esta ejecución. */
  readonly persistent: boolean
}

export function createAnalyticsStore(getStorage: () => AnalyticsStorageLike | null): AnalyticsStore {
  const memory = new Map<string, unknown>()
  let available = true

  const storage = () => {
    if (!available) return null
    try {
      const resolved = getStorage()
      if (!resolved) available = false
      return resolved
    } catch {
      available = false
      return null
    }
  }

  return {
    get persistent() {
      return available
    },
    read<T>(key: string, isValid: (value: unknown) => value is T): T | null {
      const target = storage()
      if (target) {
        try {
          const parsed: unknown = JSON.parse(target.getItem(key) ?? "null")
          const value = isValid(parsed) ? parsed : null
          memory.set(key, value)
          return value
        } catch (error) {
          // JSON dañado no es un storage roto: se descarta el valor y se sigue.
          if (error instanceof SyntaxError) {
            memory.set(key, null)
            return null
          }
          available = false
        }
      }
      const value = memory.get(key)
      return isValid(value) ? value : null
    },
    write(key: string, value: unknown) {
      memory.set(key, value)
      const target = storage()
      if (!target) return
      try {
        target.setItem(key, JSON.stringify(value))
      } catch {
        available = false
      }
    },
  }
}

let browserStore: AnalyticsStore | null = null

/** Store único de la pestaña (vive lo que vive el runtime de la página). */
export function getBrowserAnalyticsStore(): AnalyticsStore {
  browserStore ??= createAnalyticsStore(() =>
    typeof window === "undefined" ? null : window.localStorage,
  )
  return browserStore
}
