import "server-only"

import {
  normalizeArgentineLocality,
  normalizeArgentineLocationKey,
  normalizeArgentineProvinceKey,
} from "../validation/account-fields.ts"

import { AndreaniClient, AndreaniError } from "./client.ts"
import type { AndreaniLocality } from "./types.ts"

const TERRITORIAL_CACHE_TTL_MS = 24 * 60 * 60 * 1000
const GEOREF_API_URL =
  "https://apis.datos.gob.ar/georef/api/v2.0/asentamientos"

const PROVINCE_IDS = new Map([
  ["BUENOSAIRES", "06"],
  ["CABA", "02"],
  ["CATAMARCA", "10"],
  ["CHACO", "22"],
  ["CHUBUT", "26"],
  ["CORDOBA", "14"],
  ["CORRIENTES", "18"],
  ["ENTRERIOS", "30"],
  ["FORMOSA", "34"],
  ["JUJUY", "38"],
  ["LAPAMPA", "42"],
  ["LARIOJA", "46"],
  ["MENDOZA", "50"],
  ["MISIONES", "54"],
  ["NEUQUEN", "58"],
  ["RIONEGRO", "62"],
  ["SALTA", "66"],
  ["SANJUAN", "70"],
  ["SANLUIS", "74"],
  ["SANTACRUZ", "78"],
  ["SANTAFE", "82"],
  ["SANTIAGODELESTERO", "86"],
  ["TIERRADELFUEGO", "94"],
  ["TUCUMAN", "90"],
])

export interface CheckoutLocalityOption {
  id: string
  name: string
}

interface TimedCacheEntry<T> {
  data: T
  expiresAt: number
}

interface GeorefSettlementRecord {
  id: string
  nombre: string
}

interface CheckoutDestinationDependencies {
  env?: NodeJS.ProcessEnv
  fetch?: typeof fetch
  getAndreaniLocalities?: (locality: string) => Promise<AndreaniLocality[]>
}

const provinceLocalityCache = new Map<
  string,
  TimedCacheEntry<CheckoutLocalityOption[]>
>()
const provinceLocalityRequests = new Map<
  string,
  Promise<CheckoutLocalityOption[]>
>()
const postalCodeCache = new Map<string, TimedCacheEntry<string[]>>()
const postalCodeRequests = new Map<string, Promise<string[]>>()

async function getCachedTerritorialData<T>(
  key: string,
  cache: Map<string, TimedCacheEntry<T>>,
  requests: Map<string, Promise<T>>,
  load: () => Promise<T>,
) {
  const cached = cache.get(key)
  if (cached && cached.expiresAt > Date.now()) return cached.data

  const pending = requests.get(key)
  if (pending) return pending

  const request = load()
  requests.set(key, request)
  try {
    const data = await request
    cache.set(key, {
      data,
      expiresAt: Date.now() + TERRITORIAL_CACHE_TTL_MS,
    })
    return data
  } finally {
    if (requests.get(key) === request) requests.delete(key)
  }
}

function resolveProvince(value: string) {
  const name = value.trim()
  const key = normalizeArgentineProvinceKey(name)
  const id = PROVINCE_IDS.get(key)

  if (!id) {
    throw new AndreaniError(
      "VALIDATION_ERROR",
      "Seleccioná una provincia válida.",
    )
  }

  return { id, key }
}

function parseGeorefLocalities(payload: unknown): CheckoutLocalityOption[] {
  if (!payload || typeof payload !== "object") {
    throw new AndreaniError(
      "INVALID_RESPONSE",
      "Georef devolvió una respuesta territorial inválida.",
    )
  }

  const records = (payload as { asentamientos?: unknown }).asentamientos
  if (!Array.isArray(records)) {
    throw new AndreaniError(
      "INVALID_RESPONSE",
      "Georef devolvió un listado territorial inválido.",
    )
  }

  const unique = new Map<string, CheckoutLocalityOption>()
  for (const record of records) {
    if (!record || typeof record !== "object") continue
    const item = record as Partial<GeorefSettlementRecord>
    if (typeof item.id !== "string" || typeof item.nombre !== "string") continue

    const name = normalizeArgentineLocality(item.nombre)
    const key = normalizeArgentineLocationKey(name)
    if (name && key && !unique.has(key)) unique.set(key, { id: item.id, name })
  }

  return [...unique.values()].sort((left, right) =>
    left.name.localeCompare(right.name, "es-AR", { sensitivity: "base" }),
  )
}

export async function getCheckoutProvinceLocalities(
  province: string,
  dependencies: CheckoutDestinationDependencies = {},
) {
  const resolvedProvince = resolveProvince(province)

  return getCachedTerritorialData(
    resolvedProvince.key,
    provinceLocalityCache,
    provinceLocalityRequests,
    async () => {
      const url = new URL(GEOREF_API_URL)
      url.searchParams.set("provincia", resolvedProvince.id)
      url.searchParams.set("campos", "id,nombre")
      url.searchParams.set("max", "5000")

      let response: Response
      try {
        response = await (dependencies.fetch ?? fetch)(url, {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(8_000),
          next: { revalidate: 86_400 },
        })
      } catch {
        throw new AndreaniError(
          "SERVICE_UNAVAILABLE",
          "No pudimos cargar las localidades.",
          { retryable: true },
        )
      }

      if (!response.ok) {
        throw new AndreaniError(
          "SERVICE_UNAVAILABLE",
          "No pudimos cargar las localidades.",
          { status: response.status, retryable: true },
        )
      }

      const localities = parseGeorefLocalities(await response.json())
      if (resolvedProvince.key === "CABA") {
        return [
          {
            id: "02",
            name: "CIUDAD AUTÓNOMA DE BUENOS AIRES",
          },
        ]
      }
      return localities
    },
  )
}

export async function getCheckoutPostalCodes(
  province: string,
  locality: string,
  dependencies: CheckoutDestinationDependencies = {},
) {
  const resolvedProvince = resolveProvince(province)
  const normalizedLocality = normalizeArgentineLocality(locality)
  const localityKey = normalizeArgentineLocationKey(normalizedLocality)
  if (
    normalizedLocality.length < 2 ||
    normalizedLocality.length > 80 ||
    !/\p{L}/u.test(normalizedLocality) ||
    !localityKey
  ) {
    throw new AndreaniError(
      "VALIDATION_ERROR",
      "Seleccioná una localidad válida.",
    )
  }

  const officialLocalities = await getCheckoutProvinceLocalities(
    province,
    dependencies,
  )
  const officialLocality = officialLocalities.find(
    (option) => normalizeArgentineLocationKey(option.name) === localityKey,
  )
  if (!officialLocality) {
    throw new AndreaniError(
      "VALIDATION_ERROR",
      "La localidad no corresponde a la provincia seleccionada.",
    )
  }

  const cacheKey = `${resolvedProvince.key}:${localityKey}`
  const postalCodes = await getCachedTerritorialData(
    cacheKey,
    postalCodeCache,
    postalCodeRequests,
    async () => {
      const getAndreaniLocalities =
        dependencies.getAndreaniLocalities ??
        ((name: string) =>
          new AndreaniClient({
            env: { ...(dependencies.env ?? process.env), ANDREANI_ENV: "QA" },
          }).getLocalidades({ localidad: name }))

      let andreaniLocalities: AndreaniLocality[]
      try {
        andreaniLocalities = await getAndreaniLocalities(officialLocality.name)
      } catch (error) {
        if (error instanceof AndreaniError && error.status === 404) return []
        throw error
      }

      return [
        ...new Set(
          andreaniLocalities
            .filter(
              (item) =>
                normalizeArgentineProvinceKey(item.provincia) ===
                resolvedProvince.key,
            )
            .flatMap((item) => item.codigosPostales)
            .filter((postalCode) => /^\d{4}$/.test(postalCode)),
        ),
      ].sort((left, right) => left.localeCompare(right, "es-AR"))
    },
  )

  return {
    locality: officialLocality.name,
    postalCodes,
  }
}

export function resetCheckoutDestinationStateForTests() {
  provinceLocalityCache.clear()
  provinceLocalityRequests.clear()
  postalCodeCache.clear()
  postalCodeRequests.clear()
}
