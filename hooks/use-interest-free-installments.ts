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
 * Todos los montos pedidos en el mismo tick (p. ej. una grilla de catálogo)
 * viajan en una sola llamada; el resultado queda en memoria unos minutos.
 */

type Counts = InstallmentCount[] | null
type Listener = () => void

const CONFIRMED_TTL_MS = 5 * 60 * 1000
const ERROR_TTL_MS = 30 * 1000
const MAX_AMOUNTS_PER_REQUEST = 48

const cache = new Map<string, { expiresAt: number; counts: Counts }>()
const pending = new Set<string>()
const inFlight = new Set<string>()
const listeners = new Set<Listener>()
let flushScheduled = false

function notify() {
  for (const listener of listeners) listener()
}

function readCached(key: string): Counts | undefined {
  const entry = cache.get(key)
  if (!entry) return undefined
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key)
    return undefined
  }
  return entry.counts
}

function store(key: string, counts: Counts) {
  cache.set(key, {
    expiresAt: Date.now() + (counts === null ? ERROR_TTL_MS : CONFIRMED_TTL_MS),
    counts,
  })
}

async function fetchBatch(keys: string[]) {
  try {
    const response = await fetch(`/api/mercadopago/installments?amounts=${keys.join(",")}`, {
      signal: AbortSignal.timeout(10_000),
    })
    const data = (await response.json()) as { interestFree?: Record<string, Counts> }
    for (const key of keys) {
      const counts = response.ok ? data.interestFree?.[key] : null
      store(key, Array.isArray(counts) ? counts : null)
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
  const keys = [...pending].filter((key) => !inFlight.has(key) && readCached(key) === undefined)
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
    if (readCached(key) === undefined && !inFlight.has(key)) {
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
    if (signature) request(signature.split(","))
    return () => {
      listeners.delete(listener)
    }
  }, [signature, currentGeneration])

  return (amount) => {
    const key = toInstallmentsAmountKey(amount)
    return key === null ? null : readCached(key)
  }
}
