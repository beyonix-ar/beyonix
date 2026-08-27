import "server-only"

import {
  normalizeArgentineLocality,
  normalizeArgentineLocationKey,
  normalizeArgentineProvinceKey,
} from "../validation/account-fields.ts"

import {
  AndreaniClient,
  AndreaniError,
  resolveAndreaniReferenceEnvironment,
  sanitizeAndreaniMessage,
} from "./client.ts"
import type { AndreaniLocality } from "./types.ts"

function logCheckoutDestinationFailure(
  operation: "localidades" | "codigos-postales",
  province: string,
  error: unknown,
) {
  const safeError =
    error instanceof AndreaniError
      ? error.toJSON()
      : {
          code: "REQUEST_FAILED" as const,
          message: sanitizeAndreaniMessage(error),
          status: null,
          retryable: false,
        }

  console.error("[checkout-destinos] fallo", {
    proveedor: operation === "localidades" ? "georef" : "andreani",
    operacion: operation,
    provincia: province,
    status: safeError.status,
    mensaje: safeError.message,
  })
}

const TERRITORIAL_CACHE_TTL_MS = 24 * 60 * 60 * 1000
// v2.0 devuelve 502 (origen caído detrás de Cloudflare) al 2026-08-23; v1.0
// expone el mismo contrato ({ asentamientos: [{ id, nombre }] }) y funciona.
const GEOREF_API_URL =
  "https://apis.datos.gob.ar/georef/api/v1.0/asentamientos"

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

export function isCheckoutDestinationCached(
  province: string,
  locality: string,
  postalCode: string,
): boolean {
  const resolvedProvince = resolveProvince(province)
  const localityKey = normalizeArgentineLocationKey(locality)
  if (!localityKey || !/^\d{4}$/.test(postalCode)) return false

  const cached = postalCodeCache.get(`${resolvedProvince.key}:${localityKey}`)
  return Boolean(
    cached &&
      cached.expiresAt > Date.now() &&
      cached.data.includes(postalCode),
  )
}

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

/**
 * Andreani no ofrece un endpoint "todas las localidades de una provincia"
 * (`/v1/localidades` sólo acepta `localidad` o `codigosPostales` puntuales;
 * filtrar por `provincia`/`idprovincia` solo devuelve 404, verificado en
 * vivo). Por eso no se puede armar la intersección Georef ∩ Andreani con una
 * sola consulta, y consultar Andreani una vez por localidad de Georef sería
 * un N+1 real (miles de requests por provincia grande).
 *
 * En cambio, se reutiliza `postalCodeCache`: cada vez que el flujo normal
 * pide los CP de una localidad puntual (`getCheckoutPostalCodes`) y Andreani
 * responde con cero CP utilizables, esa localidad queda marcada acá. El
 * listado automático se filtra con ese conocimiento ya adquirido -- sin
 * ninguna llamada extra -- y se va autodepurando con el uso real: no es
 * perfecto en frío para una provincia que nadie exploró todavía, pero nunca
 * cuesta una consulta adicional a Andreani ni depende de una lista
 * hardcodeada.
 */
function filterLocalitiesWithUsablePostalCode(
  provinceKey: string,
  localities: CheckoutLocalityOption[],
): CheckoutLocalityOption[] {
  const now = Date.now()
  return localities.filter((option) => {
    const localityKey = normalizeArgentineLocationKey(option.name)
    const cached = postalCodeCache.get(`${provinceKey}:${localityKey}`)
    return !(cached && cached.expiresAt > now && cached.data.length === 0)
  })
}

export async function getCheckoutProvinceLocalities(
  province: string,
  dependencies: CheckoutDestinationDependencies = {},
) {
  const resolvedProvince = resolveProvince(province)

  const localities = await getCachedTerritorialData(
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
      } catch (error) {
        logCheckoutDestinationFailure("localidades", province, error)
        throw new AndreaniError(
          "SERVICE_UNAVAILABLE",
          "No pudimos cargar las localidades.",
          { retryable: true },
        )
      }

      if (!response.ok) {
        const error = new AndreaniError(
          "SERVICE_UNAVAILABLE",
          "No pudimos cargar las localidades.",
          { status: response.status, retryable: true },
        )
        logCheckoutDestinationFailure("localidades", province, error)
        throw error
      }

      const georefLocalities = parseGeorefLocalities(await response.json())
      if (resolvedProvince.key === "CABA") {
        return [
          {
            id: "02",
            name: "CIUDAD AUTÓNOMA DE BUENOS AIRES",
          },
        ]
      }
      return georefLocalities
    },
  )

  return filterLocalitiesWithUsablePostalCode(resolvedProvince.key, localities)
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
        ((name: string) => {
          const referenceEnv = { ...(dependencies.env ?? process.env) }
          const environment = resolveAndreaniReferenceEnvironment(referenceEnv)
          referenceEnv.ANDREANI_ENV = environment

          return new AndreaniClient({
            env: referenceEnv,
            // El catálogo de referencia (localidades/CP/sucursales) se
            // consulta siempre en el mismo ambiente que la tarifa -- ver
            // `resolveAndreaniReferenceEnvironment`. Son GET públicos
            // (`performFetch` los permite en PROD sin más autorización), así
            // que no hace falta ningún permiso adicional de creación/tarifa.
            productionAccess:
              environment === "PROD" ? "tariffs-only" : undefined,
            // CABA se modela como una única localidad Andreani ("CIUDAD
            // AUTÓNOMA DE BUENOS AIRES" / provincia "CAPITAL FEDERAL") que
            // agrupa ~436 códigos postales -- Andreani no tiene una entrada
            // por barrio (verificado: buscar "RECOLETA"/"CABALLITO"/etc. como
            // localidad no devuelve nada). Es la única localidad del país con
            // un resultado tan grande, y puede tardar 15-20s en responder
            // (medido en vivo), muy por encima del timeout general de
            // Andreani (10s) pensado para localidades chicas como el resto
            // del país. Sin este margen, esta consulta puntual siempre
            // expira antes de tiempo y el frontend lo muestra como "sin
            // códigos postales" en vez de como la falla de red que es.
            timeoutMs: 25_000,
          }).getLocalidades({ localidad: name })
        })

      let andreaniLocalities: AndreaniLocality[]
      try {
        andreaniLocalities = await getAndreaniLocalities(officialLocality.name)
      } catch (error) {
        if (error instanceof AndreaniError && error.status === 404) return []
        logCheckoutDestinationFailure("codigos-postales", province, error)
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
