import "server-only"

import type { GeoPoint } from "../andreani/branch-distance.ts"

/**
 * Geocodificación server-side vía Nominatim (OpenStreetMap) del domicilio del
 * cliente, para ordenar sucursales Andreani por cercanía real. Nunca se
 * expone al browser (Nominatim se llama desde acá, no desde el checkout) y
 * nunca se inventan coordenadas: si la geocodificación falla, el llamador se
 * queda sin `origin` y el selector de sucursales simplemente no ordena por
 * distancia (ver `sortAndreaniBranchesByDistance`).
 *
 * Política de uso de Nominatim (https://operations.osmfoundation.org/policies/nominatim/):
 * máximo 1 request/segundo y un User-Agent que identifique la app. Acá se
 * cachea 24h por dirección normalizada y se serializan las llamadas salientes
 * con un espaciado > 1s, así que ni con checkouts concurrentes se puede
 * superar ese límite.
 */

const NOMINATIM_BASE_URL =
  process.env.NOMINATIM_URL?.trim() || "https://nominatim.openstreetmap.org"
const GEOCODE_CACHE_TTL_MS = 24 * 60 * 60 * 1000
const GEOCODE_TIMEOUT_MS = 5_000
const MIN_REQUEST_SPACING_MS = 1_100

interface GeocodeAddressInput {
  calle?: string
  numero?: string
  localidad: string
  provincia: string
  codigoPostal?: string
}

interface TimedGeocodeEntry {
  data: GeoPoint | null
  expiresAt: number
}

interface GeocodeDependencies {
  fetchImpl?: typeof fetch
}

const geocodeCache = new Map<string, TimedGeocodeEntry>()
const geocodePending = new Map<string, Promise<GeoPoint | null>>()

let outboundQueue: Promise<void> = Promise.resolve()
let lastRequestAt = 0

function throttledFetch(
  url: string,
  fetchImpl: typeof fetch,
): Promise<Response> {
  const scheduled = outboundQueue.then(async () => {
    const wait = Math.max(0, MIN_REQUEST_SPACING_MS - (Date.now() - lastRequestAt))
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
    lastRequestAt = Date.now()
  })
  outboundQueue = scheduled
  return scheduled.then(() => {
    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL?.trim()
    return fetchImpl(url, {
      headers: {
        "User-Agent": `BEYONIX-ecommerce/1.0 (${siteUrl || "contacto no configurado"})`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(GEOCODE_TIMEOUT_MS),
    })
  })
}

function buildQuery(input: GeocodeAddressInput) {
  const parts = [
    input.calle && input.numero ? `${input.calle} ${input.numero}` : input.calle,
    input.localidad,
    input.provincia,
    input.codigoPostal,
    "Argentina",
  ].filter((part): part is string => Boolean(part && part.trim()))
  return parts.join(", ")
}

async function performGeocode(
  query: string,
  fetchImpl: typeof fetch,
): Promise<GeoPoint | null> {
  try {
    const url = `${NOMINATIM_BASE_URL}/search?${new URLSearchParams({
      q: query,
      format: "jsonv2",
      limit: "1",
      countrycodes: "ar",
    })}`
    const response = await throttledFetch(url, fetchImpl)
    if (!response.ok) return null
    const payload = (await response.json()) as unknown
    if (!Array.isArray(payload) || payload.length === 0) return null
    const first = payload[0] as Record<string, unknown>
    const lat = Number(first.lat)
    const lng = Number(first.lon)
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
    return { lat, lng }
  } catch {
    // Timeout, error de red o respuesta inesperada: se trata igual que "sin
    // resultado" -- nunca se propaga como error fatal del checkout.
    return null
  }
}

/**
 * Geocodifica el domicilio del cliente. Primero intenta con la dirección
 * completa (calle + altura); si no hay resultado, degrada a geocodificar
 * sólo localidad + provincia (sigue siendo una ubicación real de Nominatim,
 * sólo que menos precisa que la dirección exacta) en vez de fallar del todo.
 */
export async function geocodeCustomerAddress(
  input: GeocodeAddressInput,
  dependencies: GeocodeDependencies = {},
): Promise<GeoPoint | null> {
  const fetchImpl = dependencies.fetchImpl ?? fetch
  const localidad = input.localidad.trim()
  const provincia = input.provincia.trim()
  if (!localidad || !provincia) return null

  const preciseQuery = buildQuery(input)
  const fallbackQuery = buildQuery({ localidad, provincia })
  const cacheKey = preciseQuery.toLowerCase()

  const cached = geocodeCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) return cached.data

  const pending = geocodePending.get(cacheKey)
  if (pending) return pending

  const request = (async () => {
    let point = await performGeocode(preciseQuery, fetchImpl)
    if (!point && preciseQuery !== fallbackQuery) {
      point = await performGeocode(fallbackQuery, fetchImpl)
    }
    geocodeCache.set(cacheKey, { data: point, expiresAt: Date.now() + GEOCODE_CACHE_TTL_MS })
    return point
  })()

  geocodePending.set(cacheKey, request)
  try {
    return await request
  } finally {
    if (geocodePending.get(cacheKey) === request) geocodePending.delete(cacheKey)
  }
}

export function resetNominatimGeocodeCacheForTests() {
  geocodeCache.clear()
  geocodePending.clear()
  outboundQueue = Promise.resolve()
  lastRequestAt = 0
}
