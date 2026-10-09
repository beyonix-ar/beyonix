import { LABEL_QUEUE_STORAGE_KEY, parseStoredQueue, type LabelQueueItem } from "./queue.ts"
import { DEFAULT_LABEL_SETTINGS, normalizeLabelSettings, type LabelSettings } from "./settings.ts"

// Estado del navegador para Etiquetas (useSyncExternalStore): la cola en curso
// y la última configuración usada. Si el almacenamiento no está disponible
// (modo privado, bloqueado) sigue funcionando en memoria durante la sesión.
export interface LocalStore<T> {
  get: () => T
  getServer: () => T
  set: (value: T) => void
  update: (change: (current: T) => T) => void
  subscribe: (listener: () => void) => () => void
}

export function createLocalStore<T>(key: string, parse: (value: unknown) => T, fallback: T): LocalStore<T> {
  let cache: { raw: string | null; value: T } = { raw: null, value: fallback }
  const listeners = new Set<() => void>()
  const emit = () => listeners.forEach((listener) => listener())

  const get = () => {
    let raw: string | null
    try {
      raw = window.localStorage.getItem(key)
    } catch {
      return cache.value
    }
    if (raw === cache.raw) return cache.value
    let value = fallback
    try {
      value = raw == null ? fallback : parse(JSON.parse(raw))
    } catch {
      value = fallback
    }
    cache = { raw, value }
    return value
  }

  const set = (value: T) => {
    const raw = JSON.stringify(value)
    cache = { raw, value }
    try {
      window.localStorage.setItem(key, raw)
    } catch {
      // Sin almacenamiento: queda en memoria.
    }
    emit()
  }

  const onStorage = (event: StorageEvent) => {
    if (event.key === key || event.key === null) emit()
  }

  return {
    get,
    getServer: () => fallback,
    set,
    update: (change) => set(change(get())),
    subscribe(listener) {
      listeners.add(listener)
      if (listeners.size === 1) window.addEventListener("storage", onStorage)
      return () => {
        listeners.delete(listener)
        if (!listeners.size) window.removeEventListener("storage", onStorage)
      }
    },
  }
}

const EMPTY_QUEUE: LabelQueueItem[] = []

export const labelQueueStore = createLocalStore<LabelQueueItem[]>(LABEL_QUEUE_STORAGE_KEY, parseStoredQueue, EMPTY_QUEUE)

export const LABEL_SETTINGS_STORAGE_KEY = "beyonix-label-settings-v1"

export const labelSettingsStore = createLocalStore<LabelSettings>(LABEL_SETTINGS_STORAGE_KEY, normalizeLabelSettings, DEFAULT_LABEL_SETTINGS)
