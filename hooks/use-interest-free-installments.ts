"use client"

import { useEffect, useState } from "react"

import type { InstallmentCount } from "@/lib/products/installments"
import { toInstallmentsAmountKey } from "@/lib/mercadopago/interest-free-display"

/**
 * Cuotas sin interés confirmadas por Mercado Pago para uno o varios montos
 * (vía /api/mercadopago/installments, que consulta del lado servidor).
 *
 * - `undefined`: todavía no se sabe (no mostrar "sin interés").
 * - `null`: no se pudo confirmar (no mostrar "sin interés").
 * - `[]`: Mercado Pago no ofrece cuotas sin interés para ese monto.
 *
 * Todos los montos pedidos en el mismo tick viajan en una sola llamada; el
 * resultado queda en memoria poco tiempo (el checkout tiene que reflejar la
 * disponibilidad prácticamente en tiempo real).
 */

type Counts = InstallmentCount[] | null
/** Marcas de referencia (visa/master) que confirman cada cuota para ese monto. */
export type InterestFreeBrandsByCount = Partial<Record<InstallmentCount, string[]>>
type Listener = () => void

const CONFIRMED_TTL_MS = 2 * 60 * 1000
const ERROR_TTL_MS = 30 * 1000
/** Cada cuánto se revisa si algún monto en pantalla venció y hay que reconsultarlo. */
const REVALIDATE_INTERVAL_MS = 15 * 1000
const MAX_AMOUNTS_PER_REQUEST = 48
const MAX_CACHE_ENTRIES = 200

const cache = new Map<string, { expiresAt: number; counts: Counts; brands: InterestFreeBrandsByCount }>()
const pending = new Set<string>()
const inFlight = new Set<string>()
const listeners = new Set<Listener>()
let flushScheduled = false

function notify() {
  for (const listener of listeners) listener()
}

/**
 * Último valor conocido aunque haya vencido (stale-while-revalidate): la
 * pantalla no salta a "consultando" mientras se reconsulta en segundo plano.
 */
function readEntry(key: string) {
  return cache.get(key)
}

function isFresh(key: string) {
  const entry = cache.get(key)
  return entry !== undefined && entry.expiresAt > Date.now()
}

function store(key: string, counts: Counts, brands: InterestFreeBrandsByCount = {}) {
  cache.delete(key)
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(key, {
    expiresAt: Date.now() + (counts === null ? ERROR_TTL_MS : CONFIRMED_TTL_MS),
    counts,
    brands: counts === null ? {} : brands,
  })
}

function normalizeBrands(value: unknown): InterestFreeBrandsByCount {
  if (!value || typeof value !== "object") return {}
  const source = value as Record<string, unknown>
  const result: InterestFreeBrandsByCount = {}
  for (const count of [2, 3, 6] as const) {
    const brands = source[String(count)]
    if (Array.isArray(brands)) result[count] = brands.filter((brand): brand is string => typeof brand === "string")
  }
  return result
}

async function fetchBatch(keys: string[]) {
  try {
    const response = await fetch(`/api/mercadopago/installments?amounts=${keys.join(",")}`, {
      signal: AbortSignal.timeout(10_000),
    })
    const data = (await response.json()) as {
      interestFree?: Record<string, Counts>
      brands?: Record<string, unknown>
    }
    for (const key of keys) {
      const counts = response.ok ? data.interestFree?.[key] : null
      store(key, Array.isArray(counts) ? counts : null, normalizeBrands(data.brands?.[key]))
    }
  } catch {
    for (const key of keys) store(key, null)
  } finally {
    for (const key of keys) inFlight.delete(key)
    notify()
  }
}

function flush() {
  flushScheduled = false
  const keys = [...pending].filter((key) => !inFlight.has(key) && !isFresh(key))
  pending.clear()
  for (let index = 0; index < keys.length; index += MAX_AMOUNTS_PER_REQUEST) {
    const batch = keys.slice(index, index + MAX_AMOUNTS_PER_REQUEST)
    for (const key of batch) inFlight.add(key)
    void fetchBatch(batch)
  }
}

function request(keys: string[]) {
  let added = false
  for (const key of keys) {
    if (!isFresh(key) && !inFlight.has(key)) {
      pending.add(key)
      added = true
    }
  }
  if (added && !flushScheduled) {
    flushScheduled = true
    setTimeout(flush, 0)
  }
}

let generation = 0

/** Descarta lo cacheado (p. ej. cuando el servidor avisa que cambiaron las condiciones). */
export function invalidateInterestFreeInstallments() {
  generation += 1
  cache.clear()
  notify()
}

/**
 * Marcas con las que Mercado Pago confirmó cada cuota para un monto ya
 * consultado (para no presentar compatibilidad universal si no existe).
 */
export function readInterestFreeBrands(amount: number | null | undefined): InterestFreeBrandsByCount {
  const key = toInstallmentsAmountKey(amount)
  return (key === null ? undefined : readEntry(key)?.brands) ?? {}
}

/**
 * Devuelve un lector por monto. Sólo resuelve los montos pasados en
 * `amounts` (se piden al montar y cuando cambian por valor).
 */
export function useInterestFreeInstallments(
  amounts: ReadonlyArray<number | null | undefined>,
): (amount: number | null | undefined) => Counts | undefined {
  // Firma por valor: un arreglo nuevo con los mismos montos no vuelve a pedir.
  const signature = [
    ...new Set(amounts.map(toInstallmentsAmountKey).filter((key): key is string => key !== null)),
  ].join(",")
  const [, setVersion] = useState(0)
  // Tras invalidar, los mismos montos se vuelven a pedir.
  const currentGeneration = generation

  useEffect(() => {
    const listener = () => setVersion((version) => version + 1)
    listeners.add(listener)
    if (!signature) {
      return () => {
        listeners.delete(listener)
      }
    }
    const keys = signature.split(",")
    request(keys)
    const revalidate = window.setInterval(() => request(keys), REVALIDATE_INTERVAL_MS)
    return () => {
      listeners.delete(listener)
      window.clearInterval(revalidate)
    }
  }, [signature, currentGeneration])

  return (amount) => {
    const key = toInstallmentsAmountKey(amount)
    return key === null ? null : readEntry(key)?.counts
  }
}
