/**
 * Cliente compartido para resolver destino + cotización de envío en checkout.
 *
 * Única fuente de verdad para: (a) cómo se arma la clave de caché de una
 * cotización, (b) cómo se canonicaliza localidad/CP contra el catálogo de
 * Andreani, y (c) cómo se cachea/dedupe cada paso. La usan tanto el
 * checkout (`app/checkout/page.tsx`) como el prefetch disparado desde el
 * carrito (`hooks/use-checkout-shipping-prefetch.ts`).
 *
 * Separación clave: cotizar un destino ya conocido (provincia + localidad +
 * CP con formato válido) NUNCA requiere haber descargado antes el catálogo
 * completo de localidades/CP -- `/api/andreani/cotizar` valida el destino
 * server-side por su cuenta (por CP puntual, no por nombre de localidad). El
 * catálogo territorial (`getLocalitiesForProvince`/`getPostalCodesForLocality`)
 * es una herramienta aparte, para cuando el usuario edita la dirección o
 * cuando el fast-path de cotización falla y hace falta guiarlo con un
 * selector. Ver `prefetchCheckoutShippingQuote`.
 */

import {
  normalizeArgentineLocationKey,
  normalizeArgentineProvinceKey,
} from "../validation/account-fields.ts"
import {
  canonicalizeCheckoutQuoteItems,
  type CheckoutQuoteItemInput,
} from "../cart/checkout-shipping-items.ts"
import type { AndreaniBranchWithDistance } from "./types.ts"

export type { CheckoutQuoteItemInput }

export interface CheckoutLocalityOption {
  id: string
  name: string
}

export interface CheckoutPostalCodeResult {
  locality: string
  postalCodes: string[]
}

export interface CheckoutQuoteDestinationInput {
  cpDestino: string
  localidad: string
  provincia: string
  items: CheckoutQuoteItemInput[]
  /** Calle y altura del domicilio -- opcionales, sólo se envían para ordenar sucursales por cercanía. Nunca forman parte de la clave de caché: cambiarlas no dispara una cotización nueva. */
  calle?: string
  numero?: string
}

export interface CheckoutQuoteRawOption {
  type?: string
  price?: number
  quoteToken?: string
  branches?: AndreaniBranchWithDistance[]
}

interface MinimalCartItem {
  product: { id: number }
  quantity: number
  variantId: number | null
  conditionedStockId: string | null
}

/** Motivo de una request fallida, para que la UI distinga "sin resultados" de "no pudimos consultar". */
export type CheckoutCatalogFailureReason =
  | "timeout"
  | "network"
  | "service_unavailable"
  | "invalid_request"

export class CheckoutCatalogError extends Error {
  readonly reason: CheckoutCatalogFailureReason

  constructor(message: string, reason: CheckoutCatalogFailureReason) {
    super(message)
    this.name = "CheckoutCatalogError"
    this.reason = reason
  }
}

interface CacheEntry<T> {
  promise: Promise<T>
  expiresAt: number | null
  value?: T
}

// Catálogos de localidades/CP: ya cacheados 24h server-side
// (`checkout-destinations.ts`), pero el cliente no debe retenerlos por
// tiempo indefinido durante toda la vida del tab -- se alinea al mismo TTL
// que el servidor para no quedar más "fresco" que la fuente real.
const TERRITORIAL_CACHE_TTL_MS = 24 * 60 * 60 * 1000
// Resultado de cotización: TTL corto porque depende del carrito vigente: no
// queremos mostrar una tarifa vieja. El servidor vuelve a validar/firmar
// igual al crear la orden, así que este TTL es solo una decisión de UX.
const QUOTE_CACHE_TTL_MS = 3 * 60 * 1000
// Techo interno del fetch subyacente de cada entrada compartida. No está
// atado a ningún consumidor particular (ver `loadWithCache`): protege contra
// una request colgada para siempre, no contra que un consumidor individual
// se desentienda del resultado.
const CATALOG_FETCH_TIMEOUT_MS = 27_000
const QUOTE_FETCH_TIMEOUT_MS = 20_000

const localityCache = new Map<string, CacheEntry<CheckoutLocalityOption[]>>()
const postalCodeCache = new Map<string, CacheEntry<CheckoutPostalCodeResult>>()
const quoteCache = new Map<string, CacheEntry<CheckoutQuoteRawOption[]>>()

function readFresh<T>(
  cache: Map<string, CacheEntry<T>>,
  key: string,
): CacheEntry<T> | null {
  const entry = cache.get(key)
  if (!entry) return null
  if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
    cache.delete(key)
    return null
  }
  return entry
}

/**
 * Ejecuta `loader` una única vez por clave y comparte la Promise entre
 * todos los consumidores concurrentes (dedupe). Deliberadamente NO acepta
 * un `AbortSignal` por consumidor: la vida de la request compartida es
 * independiente de que un consumidor particular deje de necesitarla -- solo
 * el timeout interno (`timeoutMs`) puede terminarla. Un consumidor que
 * quiere dejar de esperar simplemente ignora la promesa (ver los efectos de
 * checkout, que usan un contador de generación en vez de abortar).
 */
function loadWithCache<T>(
  cache: Map<string, CacheEntry<T>>,
  key: string,
  ttlMs: number | null,
  timeoutMs: number,
  loader: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const cached = readFresh(cache, key)
  if (cached) return cached.promise

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const promise = loader(controller.signal).finally(() => clearTimeout(timer))
  const entry: CacheEntry<T> = {
    promise,
    expiresAt: ttlMs === null ? null : Date.now() + ttlMs,
  }
  cache.set(key, entry)

  promise
    .then((value) => {
      if (cache.get(key) === entry) entry.value = value
    })
    .catch(() => {
      // Una request fallida (incluye timeout interno) no debe quedar
      // cacheada: el próximo intento tiene que poder reintentar desde cero.
      if (cache.get(key) === entry) cache.delete(key)
    })

  return promise
}

function peek<T>(cache: Map<string, CacheEntry<T>>, key: string): T | null {
  const entry = readFresh(cache, key)
  return entry?.value ?? null
}

async function parseCatalogResponse<T>(
  response: Response,
  parse: (data: Record<string, unknown>) => T | null,
  fallbackMessage: string,
): Promise<T> {
  const data = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >

  if (!response.ok) {
    const message =
      typeof data.message === "string" ? data.message : fallbackMessage
    const reason: CheckoutCatalogFailureReason =
      response.status === 504
        ? "timeout"
        : response.status === 400
          ? "invalid_request"
          : "service_unavailable"
    throw new CheckoutCatalogError(message, reason)
  }

  const parsed = parse(data)
  if (parsed === null) {
    throw new CheckoutCatalogError(fallbackMessage, "service_unavailable")
  }

  return parsed
}

function toCatalogError(error: unknown, fallbackMessage: string) {
  if (error instanceof CheckoutCatalogError) return error
  if (error instanceof DOMException && error.name === "AbortError") {
    return new CheckoutCatalogError(
      "La consulta tardó demasiado. Intentá nuevamente.",
      "timeout",
    )
  }
  return new CheckoutCatalogError(fallbackMessage, "network")
}

export function mapCartItemsToQuoteItems(
  items: readonly MinimalCartItem[],
): CheckoutQuoteItemInput[] {
  return items.map((item) => ({
    productId: item.product.id,
    quantity: item.quantity,
    variantId: item.variantId,
    conditionedStockId: item.conditionedStockId,
  }))
}

/**
 * Clave canónica de cotización: provincia/localidad se normalizan igual que
 * `normalizeArgentineProvinceKey`/`normalizeArgentineLocationKey` (las
 * mismas funciones que usa la firma HMAC server-side en
 * `checkout-shipping.ts`, para que el criterio de "mismo destino" sea
 * conceptualmente el mismo en cliente y servidor), el CP se recorta y
 * pasa a mayúsculas, y los ítems se agrupan/ordenan con
 * `canonicalizeCheckoutQuoteItems` -- mayúsculas, tildes, y el orden
 * accidental del array nunca generan una clave distinta para el mismo
 * destino/carrito.
 */
export function buildShippingQuoteKey(
  input: CheckoutQuoteDestinationInput,
): string {
  return JSON.stringify({
    cpDestino: input.cpDestino.trim().toUpperCase(),
    localidad: normalizeArgentineLocationKey(input.localidad),
    provincia: normalizeArgentineProvinceKey(input.provincia),
    items: canonicalizeCheckoutQuoteItems(input.items),
  })
}

export function findCanonicalLocality(
  localities: readonly CheckoutLocalityOption[],
  localidad: string,
): CheckoutLocalityOption | undefined {
  const key = normalizeArgentineLocationKey(localidad)
  return localities.find(
    (option) => normalizeArgentineLocationKey(option.name) === key,
  )
}

export function resolvePostalCodeFromCatalog(
  postalCodes: readonly string[],
  currentPostalCode: string,
): string {
  if (postalCodes.includes(currentPostalCode)) return currentPostalCode
  return postalCodes.length === 1 ? postalCodes[0] : ""
}

/** Un destino con provincia + localidad + CP de 4 dígitos ya es apto para intentar cotizar directamente. */
export function isQuotableDestination(input: {
  provincia?: string | null
  localidad?: string | null
  cpDestino?: string | null
}): boolean {
  return Boolean(
    input.provincia?.trim() &&
      input.localidad?.trim() &&
      /^\d{4}$/.test(input.cpDestino?.trim() ?? ""),
  )
}

/**
 * Catálogo de localidades de una provincia. Es la herramienta de EDICIÓN
 * (poblar un selector), nunca un requisito para cotizar un destino ya
 * conocido -- ver `getShippingQuoteOptions`/`prefetchCheckoutShippingQuote`.
 */
export function getLocalitiesForProvince(
  provincia: string,
): Promise<CheckoutLocalityOption[]> {
  const cacheKey = normalizeArgentineLocationKey(provincia)

  return loadWithCache(
    localityCache,
    cacheKey,
    TERRITORIAL_CACHE_TTL_MS,
    CATALOG_FETCH_TIMEOUT_MS,
    async (signal) => {
      let response: Response
      try {
        response = await fetch(
          `/api/andreani/destinos?provincia=${encodeURIComponent(provincia)}&catalogo=asentamientos-v1`,
          { signal },
        )
      } catch (error) {
        throw toCatalogError(error, "No pudimos cargar las localidades.")
      }

      return parseCatalogResponse(
        response,
        (data) =>
          Array.isArray(data.localities)
            ? (data.localities as unknown[]).filter(
                (option): option is CheckoutLocalityOption =>
                  Boolean(option) &&
                  typeof (option as CheckoutLocalityOption).id === "string" &&
                  typeof (option as CheckoutLocalityOption).name === "string",
              )
            : null,
        "No pudimos cargar las localidades.",
      )
    },
  )
}

export function peekLocalitiesForProvince(
  provincia: string,
): CheckoutLocalityOption[] | null {
  return peek(localityCache, normalizeArgentineLocationKey(provincia))
}

/**
 * Catálogo de códigos postales de una localidad. Herramienta de EDICIÓN,
 * igual que `getLocalitiesForProvince` -- ver el comentario de arriba. Para
 * CABA esta consulta puede tardar ~15-20s (Andreani agrupa toda la ciudad
 * en una única localidad con ~436 CP, medido en vivo); por eso nunca debe
 * ejecutarse en el camino crítico de una cotización con destino ya
 * conocido.
 */
export function getPostalCodesForLocality(
  provincia: string,
  localidad: string,
): Promise<CheckoutPostalCodeResult> {
  const cacheKey = `${normalizeArgentineLocationKey(provincia)}:${normalizeArgentineLocationKey(localidad)}`

  return loadWithCache(
    postalCodeCache,
    cacheKey,
    TERRITORIAL_CACHE_TTL_MS,
    CATALOG_FETCH_TIMEOUT_MS,
    async (signal) => {
      let response: Response
      try {
        response = await fetch(
          `/api/andreani/destinos?provincia=${encodeURIComponent(provincia)}&localidad=${encodeURIComponent(localidad)}`,
          { signal },
        )
      } catch (error) {
        throw toCatalogError(
          error,
          "No pudimos cargar los códigos postales.",
        )
      }

      return parseCatalogResponse(
        response,
        (data) =>
          typeof data.locality === "string" &&
          Array.isArray(data.postalCodes)
            ? {
                locality: data.locality,
                postalCodes: data.postalCodes as string[],
              }
            : null,
        "No pudimos cargar los códigos postales.",
      )
    },
  )
}

export function peekPostalCodesForLocality(
  provincia: string,
  localidad: string,
): CheckoutPostalCodeResult | null {
  const cacheKey = `${normalizeArgentineLocationKey(provincia)}:${normalizeArgentineLocationKey(localidad)}`
  return peek(postalCodeCache, cacheKey)
}

/**
 * Cotización real para el destino/carrito exactos: siempre pasa por
 * `/api/andreani/cotizar` (server-side, firmada). Reutiliza una request en
 * vuelo o un resultado reciente (<=3min) si ya existe para la misma clave
 * canónica -- sin importar si quien la disparó fue el checkout o el
 * prefetch del carrito -- para no duplicar cotizaciones. No requiere haber
 * resuelto antes el catálogo de localidades/CP: el backend valida el
 * destino por su cuenta contra Andreani.
 */
export function getShippingQuoteOptions(
  input: CheckoutQuoteDestinationInput,
): Promise<CheckoutQuoteRawOption[]> {
  const key = buildShippingQuoteKey(input)

  return loadWithCache(
    quoteCache,
    key,
    QUOTE_CACHE_TTL_MS,
    QUOTE_FETCH_TIMEOUT_MS,
    async (signal) => {
      let response: Response
      try {
        response = await fetch("/api/andreani/cotizar", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            cpDestino: input.cpDestino.trim(),
            localidad: input.localidad.trim(),
            provincia: input.provincia.trim(),
            items: input.items,
            calle: input.calle?.trim() || undefined,
            numero: input.numero?.trim() || undefined,
          }),
          signal,
          cache: "no-store",
        })
      } catch (error) {
        throw toCatalogError(error, "No pudimos calcular el envío.")
      }

      return parseCatalogResponse(
        response,
        (data) =>
          Array.isArray(data.options)
            ? (data.options as CheckoutQuoteRawOption[])
            : null,
        "No pudimos calcular el envío.",
      )
    },
  )
}

/** Cotización ya resuelta para esta clave exacta, si existe — sin disparar ninguna request. */
export function peekShippingQuoteOptions(
  input: CheckoutQuoteDestinationInput,
): CheckoutQuoteRawOption[] | null {
  return peek(quoteCache, buildShippingQuoteKey(input))
}

/**
 * Fast-path: si el destino guardado del usuario ya tiene provincia +
 * localidad + CP con formato válido, cotiza directamente contra
 * `/api/andreani/cotizar` -- SIN pasar por el catálogo de
 * localidades/CP. Es exactamente lo que Codex detectó que faltaba: el
 * backend ya valida el destino por su cuenta (por CP puntual, no por
 * catálogo completo de una localidad), así que no hay ninguna razón para
 * que el prefetch descargue antes el catálogo territorial -- ni siquiera
 * para CABA.
 *
 * Pensado para dispararse antes de que el checkout monte (al abrir el
 * carrito, al hacer click en "Finalizar compra"). Es best-effort y
 * silencioso: si el destino guardado resulta inválido (la cotización
 * falla), no hace nada más -- el checkout se encarga de la validación
 * guiada por catálogo como fallback.
 */
export function resetCheckoutQuoteClientStateForTests() {
  localityCache.clear()
  postalCodeCache.clear()
  quoteCache.clear()
}

export async function prefetchCheckoutShippingQuote(input: {
  provincia?: string | null
  localidad?: string | null
  cpDestino?: string | null
  items: readonly MinimalCartItem[]
}): Promise<void> {
  if (!input.items.length) return
  if (
    !isQuotableDestination({
      provincia: input.provincia,
      localidad: input.localidad,
      cpDestino: input.cpDestino,
    })
  ) {
    return
  }

  try {
    await getShippingQuoteOptions({
      cpDestino: (input.cpDestino as string).trim(),
      localidad: (input.localidad as string).trim(),
      provincia: (input.provincia as string).trim(),
      items: mapCartItemsToQuoteItems(input.items),
    })
  } catch {
    // Best-effort: si el destino guardado no es válido (o Andreani no
    // responde), no hay nada que hacer acá -- el checkout muestra su propio
    // estado de error y, si hace falta, guía al usuario con el catálogo.
  }
}
