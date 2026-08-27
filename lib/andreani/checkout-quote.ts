import "server-only"

import { createAdminClient } from "../supabase/admin.ts"
import {
  IncompleteProductLogisticsError,
  resolveProductLogistics,
  type ProductLogisticsSource,
} from "../shipping/product-logistics.ts"
import { ProductLogisticsValidationError } from "../shipping/logistics-validation.ts"
import {
  normalizeArgentineLocality,
  normalizeArgentineLocationKey,
  normalizeArgentineProvinceKey,
} from "../validation/account-fields.ts"
import { canonicalizeCheckoutQuoteItems } from "../cart/checkout-shipping-items.ts"
import { getCheckoutOrderItemUnitPrice } from "../orders/conditioned-checkout.ts"

import {
  AndreaniClient,
  AndreaniError,
  type AndreaniClientOptions,
} from "./client.ts"
import { formatAndreaniBranchAddress } from "./branch-address.ts"
import { isCheckoutDestinationCached } from "./checkout-destinations.ts"
import { sortAndreaniBranchesByDistance } from "./branch-distance.ts"
import { geocodeCustomerAddress } from "../geocoding/nominatim.ts"
import type {
  AndreaniBranch,
  AndreaniBranchFilters,
  AndreaniBranchWithDistance,
  AndreaniCheckoutQuoteOption,
  AndreaniCheckoutQuoteRequest,
  AndreaniLocality,
  AndreaniLocalityFilters,
  AndreaniTariffRequest,
  AndreaniTariffResponse,
} from "./types.ts"
import { ANDREANI_DESTINATION_UNAVAILABLE_MESSAGE } from "./types.ts"

const PRODUCT_SELECT =
  "id, nombre, sku, precio, peso_empaquetado_kg, alto_paquete_cm, ancho_paquete_cm, largo_paquete_cm"
const VARIANT_SELECT =
  "id, producto_id, nombre, sku, peso_empaquetado_kg, alto_paquete_cm, ancho_paquete_cm, largo_paquete_cm"
const REFERENCE_DATA_CACHE_TTL_MS = 24 * 60 * 60 * 1000

interface ProductRow extends ProductLogisticsSource {
  precio: number
}

interface VariantRow extends ProductLogisticsSource {
  producto_id: number
}

interface ConditionedRow {
  id: string
  product_id: number
  source_variant_id: number | null
  discount_percent: number
}

export interface LoadedCheckoutQuoteItem {
  product: ProductRow
  variant: VariantRow | null
  quantity: number
  discountPercent: number
}

export interface AggregatedAndreaniPackage {
  pesoKg: number
  volumenCm3: number
  valorDeclarado: number
  altoCm?: number
  anchoCm?: number
  largoCm?: number
}

interface CheckoutQuoteConfig {
  environment: "QA" | "PROD"
  cliente: string
  domicilioContrato?: string
  sucursalContrato?: string
  sucursalOrigen: string
}

interface CheckoutQuoteDependencies {
  env?: NodeJS.ProcessEnv
  loadItems?: (
    request: AndreaniCheckoutQuoteRequest,
  ) => Promise<LoadedCheckoutQuoteItem[]>
  getLocalities?: (
    filters: AndreaniLocalityFilters,
  ) => Promise<AndreaniLocality[]>
  getBranches?: (
    filters: AndreaniBranchFilters,
  ) => Promise<AndreaniBranch[]>
  quoteTariff?: (
    input: AndreaniTariffRequest,
  ) => Promise<AndreaniTariffResponse>
  geocodeAddress?: typeof geocodeCustomerAddress
  isDestinationCached?: (
    request: Pick<
      AndreaniCheckoutQuoteRequest,
      "cpDestino" | "localidad" | "provincia"
    >,
  ) => boolean
  clientOptions?: AndreaniClientOptions
}

interface TimedCacheEntry<T> {
  data: T
  expiresAt: number
}

const pendingQuotes = new Map<
  string,
  Promise<AndreaniCheckoutQuoteOption[]>
>()
// Cache corto del RESULTADO de una cotización ya resuelta, para el caso de
// pedir dos veces exactamente el mismo destino+carrito (ida y vuelta entre
// pasos del checkout, doble click, etc.). La key es el JSON exacto del
// request normalizado (mismo carrito, cantidades, variantes, destino), así
// que nunca puede devolver una tarifa de otro carrito/peso/destino. El TTL
// es deliberadamente corto y muy inferior a los 30 min que ya tolera el
// token de cotización firmado (`CHECKOUT_SHIPPING_QUOTE_TTL_MS`), así que no
// introduce una ventana de staleness nueva: la orden vuelve a validar todo
// server-side igual que siempre.
const RESOLVED_QUOTE_CACHE_TTL_MS = 60 * 1000
const resolvedQuoteCache = new Map<
  string,
  TimedCacheEntry<AndreaniCheckoutQuoteOption[]>
>()
const localityCache = new Map<string, TimedCacheEntry<AndreaniLocality[]>>()
const localityRequests = new Map<string, Promise<AndreaniLocality[]>>()
const branchCache = new Map<string, TimedCacheEntry<AndreaniBranch[]>>()
const branchRequests = new Map<string, Promise<AndreaniBranch[]>>()

async function getCachedReferenceData<T>(
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
      expiresAt: Date.now() + REFERENCE_DATA_CACHE_TTL_MS,
    })
    return data
  } finally {
    if (requests.get(key) === request) requests.delete(key)
  }
}

function requiredText(value: string | undefined) {
  return typeof value === "string" ? value.trim() : ""
}

function optionalText(value: string | undefined) {
  const normalized = requiredText(value)
  return normalized || undefined
}

/**
 * Los catálogos son GET públicos y se consultan en el mismo ambiente que la
 * tarifa. Así, checkout PROD no depende de username/password del ambiente QA.
 */
function buildAndreaniReferenceClient(
  environment: CheckoutQuoteConfig["environment"],
  env: NodeJS.ProcessEnv,
  clientOptions: AndreaniClientOptions | undefined,
) {
  return new AndreaniClient({
    ...clientOptions,
    env: { ...env, ANDREANI_ENV: environment },
    productionAccess:
      environment === "PROD" ? "tariffs-only" : clientOptions?.productionAccess,
  })
}

/**
 * Catálogo NACIONAL de sucursales aptas para retiro de cliente: una única
 * consulta sin filtro de localidad (confirmado en vivo contra Andreani QA:
 * `GET /v2/sucursales?canal=B2C&seHaceAtencionAlCliente=true`, sin
 * `localidad`, devuelve el listado completo -- 156 sucursales en QA -- en
 * una sola respuesta). Reemplaza la estrategia anterior de consultar
 * `/v2/sucursales?localidad=<nombre>` por destino: esa consulta depende de
 * que el nombre de localidad que maneja BEYONIX coincida EXACTO con la
 * etiqueta interna de Andreani, lo cual no es una garantía general (CABA
 * agrupa todo bajo "C.A.B.A."; la única sucursal de la ciudad de San Juan
 * está taggeada con `localidad: "Santa Lucia"`, un partido vecino, no "San
 * Juan"). Con el catálogo completo en memoria, el matching territorial pasa
 * a resolverse server-side contra datos reales (ver
 * `resolveAndreaniDestinationBranches`), sin depender de adivinar el string
 * exacto que Andreani usa para cada ciudad del país.
 *
 * Cacheado bajo una key fija en el mismo `branchCache`/`branchRequests` que
 * antes indexaban por destino -- ahora hay una sola entrada para todo el
 * país, con el mismo TTL de 24h (`REFERENCE_DATA_CACHE_TTL_MS`) que ya usan
 * localidades/sucursales. Si Andreani falla, el error se propaga tal cual
 * (mismo comportamiento que antes): no hay sucursales "de repuesto".
 */
const NATIONAL_BRANCH_CATALOG_CACHE_KEY = "__NATIONAL_CATALOG__"

function getAndreaniBranchCatalog(
  getBranches: (filters: AndreaniBranchFilters) => Promise<AndreaniBranch[]>,
): Promise<AndreaniBranch[]> {
  return getCachedReferenceData(
    NATIONAL_BRANCH_CATALOG_CACHE_KEY,
    branchCache,
    branchRequests,
    () => getBranches({ canal: "B2C", seHaceAtencionAlCliente: true }),
  )
}

/**
 * CABA, a diferencia de cualquier otra provincia, es una única localidad
 * Andreani que agrupa toda la ciudad (confirmado en vivo: en el catálogo
 * nacional, las ~29 sucursales de todos los barrios de CABA comparten el
 * valor literal `direccion.localidad = "C.a.b.a."`). Por eso la clave de
 * localidad para matchear sucursales de CABA se deriva de la PROVINCIA, no
 * del texto de localidad que haya tipeado la UI (que puede ser "CABA",
 * "Capital Federal" o "Ciudad Autónoma de Buenos Aires" según el origen del
 * dato) -- todos esos alias son la misma única localidad real de Andreani.
 * Es una excepción ESTRUCTURAL del catálogo (una ciudad, cero barrios
 * propios), no una entrada de un diccionario de ciudades: no crece con cada
 * destino nuevo que se agregue.
 */
function resolveAndreaniBranchLocalityKey(
  localidad: string,
  provinceKey: string,
): string {
  return provinceKey === "CABA" ? "CABA" : normalizeArgentineLocationKey(localidad)
}

/**
 * En el catálogo de sucursales (a diferencia de `/v1/localidades`), Andreani
 * no modela CABA como su propia provincia: las sucursales de "C.A.B.A."
 * quedan taggeadas con `direccion.provincia = "Buenos Aires"` (confirmado en
 * vivo, 29/29), nunca "CABA" ni "Capital Federal". La equivalencia se acepta
 * únicamente cuando la LOCALIDAD ya resolvió a la clave "CABA" -- así una
 * localidad homónima real de la provincia de Buenos Aires (localidad
 * distinta, provincia "Buenos Aires" genuina) nunca puede colarse por esta
 * vía: sigue exigiendo que la localidad matchee primero.
 */
function branchProvinceMatchesRequest(
  branchProvinceKey: string,
  requestProvinceKey: string,
  localityKey: string,
): boolean {
  if (branchProvinceKey === requestProvinceKey) return true
  return (
    localityKey === "CABA" &&
    requestProvinceKey === "CABA" &&
    branchProvinceKey === "BUENOSAIRES"
  )
}

/**
 * Matching territorial único (misma función para descubrimiento y para
 * `resolveVerifiedAndreaniBranch`): filtra el catálogo nacional ya obtenido
 * contra un destino provincia+localidad+CP, usando DOS señales -- ambas
 * declaradas por Andreani, ninguna inventada:
 *
 *  1) Nombre de localidad normalizado (tolerante a mayúsculas/tildes) +
 *     provincia -- cubre la enorme mayoría del país (Rosario, Córdoba,
 *     Mendoza, Neuquén, etc.), incluyendo la excepción estructural de CABA.
 *  2) Código postal atendido (`codigosPostalesAtendidos`, un campo que
 *     Andreani expone por sucursal) + provincia -- cubre el caso real donde
 *     Andreani etiqueta la sucursal con la localidad/partido vecino en vez
 *     del nombre de ciudad que reconoce el cliente (confirmado en vivo: la
 *     única sucursal de la ciudad de San Juan lista "5400" -- el CP real de
 *     San Juan Capital -- entre sus códigos postales atendidos, aunque su
 *     propia dirección figura en "Santa Lucia").
 *
 * La provincia NUNCA se relaja fuera del caso CABA documentado arriba: ninguna
 * de las dos vías puede devolver una sucursal de otra provincia. El CP sólo
 * amplía el conjunto -- nunca lo reduce -- así que una sucursal real de la
 * misma localidad con un CP distinto al del destino sigue apareciendo (vía
 * la señal 1), igual que antes de este cambio.
 */
function resolveAndreaniDestinationBranches(
  catalog: readonly AndreaniBranch[],
  destination: { localidad: string; provincia: string; cpDestino?: string },
): AndreaniBranch[] {
  const provinceKey = normalizeArgentineProvinceKey(destination.provincia)
  const localityKey = resolveAndreaniBranchLocalityKey(destination.localidad, provinceKey)
  const cpDestino = destination.cpDestino?.trim()

  return catalog.filter((branch) => {
    const branchProvinceKey = normalizeArgentineProvinceKey(branch.direccion.provincia)
    if (!branchProvinceMatchesRequest(branchProvinceKey, provinceKey, localityKey)) {
      return false
    }

    const branchLocalityKey = normalizeArgentineLocationKey(branch.direccion.localidad)
    if (branchLocalityKey === localityKey) return true

    return cpDestino !== undefined && cpDestino !== "" && (branch.codigosPostalesAtendidos ?? []).includes(cpDestino)
  })
}

async function fetchAndreaniDestinationBranches(
  destination: { localidad: string; provincia: string; cpDestino?: string },
  getBranches: (filters: AndreaniBranchFilters) => Promise<AndreaniBranch[]>,
): Promise<AndreaniBranch[]> {
  const catalog = await getAndreaniBranchCatalog(getBranches)
  return resolveAndreaniDestinationBranches(catalog, destination)
}

export function resolveAndreaniCheckoutConfig(
  env: NodeJS.ProcessEnv = process.env,
): CheckoutQuoteConfig {
  const environment = requiredText(
    env.ANDREANI_TARIFF_ENV || env.ANDREANI_ENV,
  ).toUpperCase()
  if (environment !== "QA" && environment !== "PROD") {
    throw new AndreaniError(
      "CONFIGURATION_ERROR",
      "El ambiente de cotización Andreani no está configurado correctamente.",
    )
  }
  const prefix = `ANDREANI_${environment}`
  const cliente =
    requiredText(env[`${prefix}_CLIENT`]) || requiredText(env.ANDREANI_CLIENTE)
  const domicilioContrato =
    optionalText(env[`${prefix}_HOME_CONTRACT`]) ||
    optionalText(env[`${prefix}_CONTRACT`]) ||
    optionalText(env.ANDREANI_CONTRATO)
  const sucursalContrato = optionalText(env[`${prefix}_BRANCH_CONTRACT`])
  const sucursalOrigen = requiredText(env[`${prefix}_ORIGIN_BRANCH`])

  if (!cliente || !sucursalOrigen || (!domicilioContrato && !sucursalContrato)) {
    throw new AndreaniError(
      "CONFIGURATION_ERROR",
      `La configuración de cotización Andreani ${environment} está incompleta.`,
    )
  }

  return {
    environment,
    cliente,
    domicilioContrato,
    sucursalContrato,
    sucursalOrigen,
  }
}

export function normalizeCheckoutQuoteRequest(
  value: unknown,
): AndreaniCheckoutQuoteRequest {
  if (!value || typeof value !== "object") {
    throw new AndreaniError("VALIDATION_ERROR", "La solicitud de cotización no es válida.")
  }

  const record = value as Record<string, unknown>
  const cpDestino =
    typeof record.cpDestino === "string"
      ? record.cpDestino.trim().toUpperCase()
      : ""
  const localidad =
    typeof record.localidad === "string"
      ? normalizeArgentineLocality(record.localidad)
      : ""
  const provincia =
    typeof record.provincia === "string" ? record.provincia.trim() : ""
  if (!/^\d{4}$/.test(cpDestino)) {
    throw new AndreaniError("VALIDATION_ERROR", "Ingresá un código postal válido.")
  }
  if (
    provincia.length < 2 ||
    provincia.length > 40 ||
    !/\p{L}/u.test(provincia)
  ) {
    throw new AndreaniError(
      "VALIDATION_ERROR",
      "Ingresá una provincia válida.",
    )
  }
  if (!Array.isArray(record.items) || record.items.length === 0 || record.items.length > 50) {
    throw new AndreaniError("VALIDATION_ERROR", "El carrito no es válido para cotizar.")
  }
  // calle/numero son opcionales y sólo se usan para geocodificar y ordenar
  // sucursales por cercanía -- un valor ausente o demasiado largo simplemente
  // se descarta acá, nunca invalida la cotización en sí.
  const calle =
    typeof record.calle === "string" && record.calle.trim().length <= 200
      ? record.calle.trim()
      : undefined
  const numero =
    typeof record.numero === "string" && record.numero.trim().length <= 20
      ? record.numero.trim()
      : undefined

  const items = record.items.map((rawItem) => {
    if (!rawItem || typeof rawItem !== "object") {
      throw new AndreaniError("VALIDATION_ERROR", "Un producto del carrito no es válido.")
    }
    const item = rawItem as Record<string, unknown>
    const productId = Number(item.productId)
    const quantity = Number(item.quantity)
    const variantId = item.variantId == null ? null : Number(item.variantId)
    const conditionedStockId =
      typeof item.conditionedStockId === "string" && item.conditionedStockId.trim()
        ? item.conditionedStockId.trim()
        : null

    if (
      !Number.isSafeInteger(productId) ||
      productId <= 0 ||
      !Number.isSafeInteger(quantity) ||
      quantity <= 0 ||
      quantity > 100 ||
      (variantId !== null && (!Number.isSafeInteger(variantId) || variantId <= 0)) ||
      (conditionedStockId !== null &&
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          conditionedStockId,
        ))
    ) {
      throw new AndreaniError("VALIDATION_ERROR", "Un producto del carrito no es válido.")
    }

    return { productId, quantity, variantId, conditionedStockId }
  })

  return { cpDestino, localidad, provincia, items, calle, numero }
}

/**
 * Valida la terna completa provincia + localidad + CP contra el catálogo
 * real de Andreani, no solo CP + provincia. Sin esto, un destino con CP y
 * provincia válidos pero una localidad arbitraria (que no corresponde a ese
 * CP) pasaba silenciosamente. La comparación de localidad usa la misma
 * clave normalizada tolerante a mayúsculas/tildes que el resto del código
 * (`normalizeArgentineLocationKey`), así que alias legítimos como
 * "Ciudad Autónoma de Buenos Aires" vs. el "CIUDAD AUTONOMA DE BUENOS
 * AIRES" (sin tilde) que devuelve Andreani siguen matcheando -- verificado
 * en vivo contra Andreani QA.
 *
 * Un mismo CP+provincia puede tener varias entradas homónimas en el
 * catálogo de Andreani (confirmado en vivo: el CP 1424 de CABA devuelve 5
 * entradas -- "C.A.B.A.", "Ciudad Autonoma Buenos Aires", "Ciudad Autonoma
 * De Buenos Aires", "Caba - Parque Chacabuco" -- todas con la misma
 * provincia). Por eso se busca la coincidencia de localidad entre TODAS las
 * entradas de esa provincia+CP, no sólo la primera: quedarse con la primera
 * hacía depender el resultado del orden en que Andreani devuelve el
 * listado, y podía rechazar un destino válido si la entrada que matcheaba
 * el nombre real no era la primera de la lista.
 */
export function matchAndreaniCheckoutProvince(
  request: Pick<
    AndreaniCheckoutQuoteRequest,
    "cpDestino" | "provincia" | "localidad"
  >,
  localities: AndreaniLocality[],
) {
  const provinceKey = normalizeArgentineProvinceKey(request.provincia)
  const localityKey = normalizeArgentineLocationKey(request.localidad)
  const sameProvinceAndPostalCode = localities.filter(
    (locality) =>
      locality.codigosPostales.includes(request.cpDestino) &&
      normalizeArgentineProvinceKey(locality.provincia) === provinceKey,
  )

  if (!sameProvinceAndPostalCode.length) {
    throw new AndreaniError(
      "VALIDATION_ERROR",
      "El código postal no corresponde a la provincia seleccionada.",
    )
  }

  const match = sameProvinceAndPostalCode.find(
    (locality) => normalizeArgentineLocationKey(locality.localidad) === localityKey,
  )

  if (!match) {
    throw new AndreaniError(
      "VALIDATION_ERROR",
      "La localidad no corresponde al código postal indicado.",
    )
  }

  return match
}

async function loadCheckoutItems(
  request: AndreaniCheckoutQuoteRequest,
): Promise<LoadedCheckoutQuoteItem[]> {
  const admin = createAdminClient()
  const productIds = [...new Set(request.items.map((item) => item.productId))]
  const requestedVariantIds = request.items
    .map((item) => item.variantId)
    .filter((id): id is number => id !== null && id !== undefined)
  const conditionedIds = request.items
    .map((item) => item.conditionedStockId)
    .filter((id): id is string => Boolean(id))

  const [productsResult, conditionedResult] = await Promise.all([
    admin.from("productos").select(PRODUCT_SELECT).in("id", productIds),
    conditionedIds.length
      ? admin
          .from("conditioned_inventory_offers")
          .select("id, product_id, source_variant_id, discount_percent")
          .in("id", conditionedIds)
      : Promise.resolve({ data: [], error: null }),
  ])

  if (productsResult.error || conditionedResult.error) {
    throw new AndreaniError(
      "REQUEST_FAILED",
      "No se pudieron obtener los datos logísticos del carrito.",
    )
  }

  const conditionedRows = (conditionedResult.data ?? []) as unknown as ConditionedRow[]
  const allVariantIds = [
    ...new Set([
      ...requestedVariantIds,
      ...conditionedRows
        .map((row) => row.source_variant_id)
        .filter((id): id is number => id !== null),
    ]),
  ]
  const variantsResult = allVariantIds.length
    ? await admin
        .from("producto_variantes")
        .select(VARIANT_SELECT)
        .in("id", allVariantIds)
    : { data: [], error: null }

  if (variantsResult.error) {
    throw new AndreaniError(
      "REQUEST_FAILED",
      "No se pudieron obtener las variantes del carrito.",
    )
  }

  const productMap = new Map(
    ((productsResult.data ?? []) as unknown as ProductRow[]).map((row) => [
      Number(row.id),
      { ...row, id: Number(row.id), precio: Number(row.precio) },
    ]),
  )
  const variantMap = new Map(
    ((variantsResult.data ?? []) as unknown as VariantRow[]).map((row) => [
      Number(row.id),
      { ...row, id: Number(row.id), producto_id: Number(row.producto_id) },
    ]),
  )
  const conditionedMap = new Map(conditionedRows.map((row) => [String(row.id), row]))

  return request.items.map((item) => {
    const product = productMap.get(item.productId)
    const conditioned = item.conditionedStockId
      ? conditionedMap.get(item.conditionedStockId)
      : undefined
    const effectiveVariantId = conditioned?.source_variant_id ?? item.variantId ?? null
    const variant = effectiveVariantId ? variantMap.get(effectiveVariantId) ?? null : null

    if (
      !product ||
      (item.conditionedStockId && !conditioned) ||
      (conditioned && conditioned.product_id !== product.id) ||
      (effectiveVariantId && (!variant || variant.producto_id !== product.id))
    ) {
      throw new AndreaniError(
        "VALIDATION_ERROR",
        "El carrito cambió. Actualizá la página para volver a cotizar.",
      )
    }

    return {
      product: {
        ...product,
        precio: getCheckoutOrderItemUnitPrice(
          product.id,
          product.precio,
          conditioned,
        ),
      },
      variant,
      quantity: item.quantity,
      // El precio ya quedó normalizado con la misma fuente de verdad que se
      // persiste en orden_items; no se debe aplicar el descuento otra vez.
      discountPercent: 0,
    }
  })
}

export function aggregateAndreaniPackage(
  items: LoadedCheckoutQuoteItem[],
): AggregatedAndreaniPackage {
  let pesoKg = 0
  let volumenCm3 = 0
  let valorDeclarado = 0
  let singleUnitDimensions:
    | { altoCm: number; anchoCm: number; largoCm: number }
    | undefined
  const totalUnits = items.reduce((total, item) => total + item.quantity, 0)

  try {
    for (const item of items) {
      const logistics = resolveProductLogistics(item.product, item.variant)
      pesoKg += logistics.pesoKg * item.quantity
      volumenCm3 +=
        logistics.altoCm * logistics.anchoCm * logistics.largoCm * item.quantity
      const discountFactor = Math.max(0, 1 - item.discountPercent / 100)
      valorDeclarado += item.product.precio * discountFactor * item.quantity
      if (totalUnits === 1) {
        singleUnitDimensions = {
          altoCm: logistics.altoCm,
          anchoCm: logistics.anchoCm,
          largoCm: logistics.largoCm,
        }
      }
    }
  } catch (error) {
    if (
      error instanceof IncompleteProductLogisticsError ||
      error instanceof ProductLogisticsValidationError
    ) {
      throw new AndreaniError("VALIDATION_ERROR", error.message)
    }
    throw error
  }

  if (!items.length || pesoKg <= 0 || volumenCm3 <= 0 || valorDeclarado <= 0) {
    throw new AndreaniError(
      "VALIDATION_ERROR",
      "El carrito no tiene datos suficientes para cotizar el envío.",
    )
  }

  return {
    pesoKg: Number(pesoKg.toFixed(3)),
    volumenCm3: Number(volumenCm3.toFixed(3)),
    valorDeclarado: Number(valorDeclarado.toFixed(2)),
    ...singleUnitDimensions,
  }
}

/**
 * Regla comercial de BEYONIX para el costo de envío: se expresa siempre en
 * miles enteros, usando $300 como punto de corte para redondear al millar
 * superior (ej. $13.299 → $13.000, pero $13.300 → $14.000). Es la única
 * transformación que sufre la tarifa cruda de Andreani, y se aplica acá —
 * en el punto donde esa tarifa se convierte por primera vez en un número —
 * para que todo lo que consume `AndreaniCheckoutQuoteOption.price` aguas
 * abajo (token firmado, checkout, creación de la orden, Mercado Pago,
 * transferencia, saldo a favor) use exactamente el mismo importe ya
 * normalizado. Opera en centavos enteros para no depender de comparaciones
 * de punto flotante justo en el límite de $300.
 */
export function roundShippingCostToNearestThousand(rawCost: number): number {
  const cents = Math.round(rawCost * 100)
  const baseCents = Math.floor(cents / 100_000) * 100_000
  const remainderCents = cents - baseCents
  const roundedCents =
    remainderCents >= 30_000 ? baseCents + 100_000 : baseCents

  return roundedCents / 100
}

function readQuotePrice(response: AndreaniTariffResponse) {
  const price = Number(response?.tarifaConIva?.total)
  if (!Number.isFinite(price) || price <= 0) {
    throw new AndreaniError(
      "INVALID_RESPONSE",
      "Andreani devolvió una cotización sin un importe válido.",
    )
  }
  return roundShippingCostToNearestThousand(price)
}

export async function quoteAndreaniCheckout(
  rawRequest: unknown,
  dependencies: CheckoutQuoteDependencies = {},
) {
  const request = normalizeCheckoutQuoteRequest(rawRequest)
  const env = dependencies.env ?? process.env
  const config = resolveAndreaniCheckoutConfig(env)
  // El dedupe/caché de esta función es puramente de performance (evita
  // repetir la llamada real a Andreani), nunca la fuente de verdad del
  // precio -- por eso la clave puede canonicalizar el orden de los ítems
  // sin ningún riesgo: dos carritos con las mismas líneas en distinto orden
  // son el mismo carrito y deben compartir cotización.
  const key = JSON.stringify({
    ...request,
    items: canonicalizeCheckoutQuoteItems(request.items),
  })
  const cached = resolvedQuoteCache.get(key)
  if (cached && cached.expiresAt > Date.now()) return cached.data

  const existing = pendingQuotes.get(key)
  if (existing) return existing

  const promise = (async () => {
    const t0 = performance.now()
    const timings: Record<string, number> = {}
    const mark = (label: string, start: number) => {
      timings[label] = Math.round(performance.now() - start)
    }
    const tariffEnv = { ...env, ANDREANI_ENV: config.environment }
    const client = new AndreaniClient({
      ...dependencies.clientOptions,
      env: tariffEnv,
      productionAccess:
        config.environment === "PROD"
          ? "tariffs-only"
          : dependencies.clientOptions?.productionAccess,
    })
    const referenceClient = buildAndreaniReferenceClient(
      config.environment,
      env,
      dependencies.clientOptions,
    )
    const getLocalities =
      dependencies.getLocalities ??
      ((filters: AndreaniLocalityFilters) =>
        getCachedReferenceData(
          request.cpDestino,
          localityCache,
          localityRequests,
          () => referenceClient.getLocalidades(filters),
        ))
    const getBranches =
      dependencies.getBranches ??
      ((filters: AndreaniBranchFilters) => referenceClient.getSucursales(filters))
    const destinationIsCached =
      dependencies.isDestinationCached?.(request) ??
      isCheckoutDestinationCached(
        request.provincia,
        request.localidad,
        request.cpDestino,
      )
    const validateStart = performance.now()
    const validateDestinationPromise = (async () => {
      if (destinationIsCached) {
        mark("destinoCacheado", validateStart)
        return
      }

      try {
        const localities = await getLocalities({
          codigosPostales: request.cpDestino,
        })
        matchAndreaniCheckoutProvince(request, localities)
        mark("validacionDestino", validateStart)
      } catch (error) {
        mark("validacionDestino", validateStart)
        if (error instanceof AndreaniError && error.status === 404) {
          throw new AndreaniError(
            "VALIDATION_ERROR",
            "No encontramos el código postal indicado.",
          )
        }
        throw error
      }
    })()

    const branchesStart = performance.now()
    const branchesPromise = (async () => {
      if (!config.sucursalContrato) return []
      try {
        const result = await fetchAndreaniDestinationBranches(
          { localidad: request.localidad, provincia: request.provincia, cpDestino: request.cpDestino },
          getBranches,
        )
        mark("sucursales", branchesStart)
        return result
      } catch (error) {
        mark("sucursales", branchesStart)
        if (error instanceof AndreaniError && error.status === 404) return []
        throw error
      }
    })()
    const authStart = performance.now()
    const authenticationPromise = dependencies.quoteTariff
      ? Promise.resolve()
      : client.authenticate().then((token) => {
          mark("token", authStart)
          return token
        })

    // Token, validación de destino y sucursales son 3 llamadas independientes
    // entre sí (ninguna depende del resultado de las otras) -- se disparan
    // todas en paralelo arriba. Si la validación pierde la carrera y rechaza
    // primero, token/sucursales quedan sin nadie que los espere: se les
    // adjunta un catch mudo solo para que Node no los reporte como rechazos
    // no manejados (el rechazo real, si lo hay, se sigue propagando más
    // abajo a través de authenticationPromise/branchesPromise sin cortar).
    authenticationPromise.catch(() => {})
    branchesPromise.catch(() => {})

    // Recién acá se espera la validación: es la única que debe bloquear
    // antes de tocar la base de datos o cotizar, para no gastar ese trabajo
    // en un destino que va a resultar inválido.
    await validateDestinationPromise

    const dbStart = performance.now()
    const packagePromise = (dependencies.loadItems ?? loadCheckoutItems)(request)
      .then((items) => {
        mark("db", dbStart)
        return items
      })
      .then(aggregateAndreaniPackage)
    const quote =
      dependencies.quoteTariff ??
      ((input: AndreaniTariffRequest) => client.cotizarEnvio(input))
    const quoteContract = async (
      type: AndreaniCheckoutQuoteOption["type"],
      contrato: string,
      packageData: AggregatedAndreaniPackage,
    ) => {
      const tariffStart = performance.now()
      try {
        const response = await quote({
          cpDestino: request.cpDestino,
          contrato,
          cliente: config.cliente,
          sucursalOrigen: config.sucursalOrigen,
          bultos: [
            {
              valorDeclarado: packageData.valorDeclarado,
              volumen: packageData.volumenCm3,
              kilos: packageData.pesoKg,
              altoCm: packageData.altoCm,
              anchoCm: packageData.anchoCm,
              largoCm: packageData.largoCm,
            },
          ],
        })
        mark(`tarifa_${type}`, tariffStart)
        return { type, price: readQuotePrice(response) }
      } catch (error) {
        mark(`tarifa_${type}`, tariffStart)
        if (
          error instanceof AndreaniError &&
          (error.code === "INVALID_RESPONSE" ||
            (error.code === "REQUEST_FAILED" &&
              error.status !== null &&
              [400, 404, 422].includes(error.status)))
        ) {
          throw new AndreaniError(
            "VALIDATION_ERROR",
            ANDREANI_DESTINATION_UNAVAILABLE_MESSAGE,
          )
        }
        throw error
      }
    }
    const domicilioContrato = config.domicilioContrato
    const sucursalContrato = config.sucursalContrato
    const homeQuotePromise = domicilioContrato
      ? Promise.all([packagePromise, authenticationPromise]).then(
          ([packageData]) =>
            quoteContract("domicilio", domicilioContrato, packageData),
        )
      : Promise.resolve(null)
    const branchQuotePromise = sucursalContrato
      ? Promise.all([
          packagePromise,
          branchesPromise,
          authenticationPromise,
        ]).then(async ([packageData, branches]) => {
          if (branches.length === 0) return null
          // Geocodificar el domicilio corre en paralelo con la tarifa (no la
          // bloquea): si no hay resultado, las sucursales se devuelven sin
          // ordenar por distancia en vez de fallar la cotización entera.
          const originStart = performance.now()
          const geocodeAddress = dependencies.geocodeAddress ?? geocodeCustomerAddress
          const originPromise = geocodeAddress({
            calle: request.calle,
            numero: request.numero,
            localidad: request.localidad,
            provincia: request.provincia,
            codigoPostal: request.cpDestino,
          }).then((point) => {
            mark("geocoding", originStart)
            return point
          })
          const [quoted, origin] = await Promise.all([
            quoteContract("sucursal", sucursalContrato, packageData),
            originPromise,
          ])
          // Se exponen las sucursales reales ya consultadas para decidir si
          // ofrecer la modalidad -- el checkout las usa para el selector, en
          // vez de tener que volver a pedirlas aparte.
          const sortedBranches: AndreaniBranchWithDistance[] =
            sortAndreaniBranchesByDistance(branches, origin)
          return { ...quoted, branches: sortedBranches }
        })
      : Promise.resolve(null)

    const [homeQuote, branchQuote] = await Promise.all([
      homeQuotePromise,
      branchQuotePromise,
    ])
    const options = [homeQuote, branchQuote].filter(
      (option): option is AndreaniCheckoutQuoteOption => option !== null,
    )
    console.info("[cotizar-timing]", {
      totalMs: Math.round(performance.now() - t0),
      ...timings,
    })
    if (!options.length) {
      throw new AndreaniError(
        "VALIDATION_ERROR",
        ANDREANI_DESTINATION_UNAVAILABLE_MESSAGE,
      )
    }
    resolvedQuoteCache.set(key, {
      data: options,
      expiresAt: Date.now() + RESOLVED_QUOTE_CACHE_TTL_MS,
    })
    return options
  })()

  pendingQuotes.set(key, promise)
  try {
    return await promise
  } finally {
    if (pendingQuotes.get(key) === promise) pendingQuotes.delete(key)
  }
}

export interface VerifiedAndreaniBranch {
  /** idgla numérico (como texto): lo que espera destino.sucursal.id en POST /v2/ordenes-de-envio. */
  id: string
  /** Código/nomenclatura (ej. "RAC"), sólo de referencia -- nunca identificador de envío. */
  codigo: string
  nombre: string
  direccion: string
  localidad: string
  provincia: string
  codigoPostal: string
}

interface ResolveVerifiedAndreaniBranchDependencies {
  env?: NodeJS.ProcessEnv
  clientOptions?: AndreaniClientOptions
  getBranches?: (filters: AndreaniBranchFilters) => Promise<AndreaniBranch[]>
}

/**
 * Verificación server-side de la sucursal Andreani que eligió el cliente:
 * el cliente sólo manda un id (idgla); acá se vuelve a resolver el MISMO
 * catálogo nacional y el MISMO matching territorial que usa la cotización
 * (`resolveAndreaniDestinationBranches` -- casi siempre un cache hit sobre
 * el catálogo, porque ya se consultó momentos antes al cotizar) y se exige
 * que el id elegido esté en esa lista. Todo lo que se persiste después sale
 * de acá (respuesta real de Andreani), nunca de nombre/dirección/CP que
 * pudo mandar el navegador -- por eso no existe una versión de esta función
 * que reciba esos campos como input.
 */
export async function resolveVerifiedAndreaniBranch(
  destination: { localidad: string; provincia: string; cpDestino: string },
  sucursalId: string | number,
  dependencies: ResolveVerifiedAndreaniBranchDependencies = {},
): Promise<VerifiedAndreaniBranch> {
  const env = dependencies.env ?? process.env
  const config = resolveAndreaniCheckoutConfig(env)

  if (!config.sucursalContrato) {
    throw new AndreaniError(
      "VALIDATION_ERROR",
      "La entrega en sucursal Andreani no está disponible.",
    )
  }

  const localidad = requiredText(destination?.localidad)
  const provincia = requiredText(destination?.provincia)
  const cpDestino = requiredText(destination?.cpDestino)
  const targetId = Number(sucursalId)
  if (
    !localidad ||
    !provincia ||
    !/^\d{4}$/.test(cpDestino) ||
    !Number.isSafeInteger(targetId) ||
    targetId <= 0
  ) {
    throw new AndreaniError(
      "VALIDATION_ERROR",
      "La sucursal Andreani seleccionada no es válida.",
    )
  }

  const getBranches =
    dependencies.getBranches ??
    ((filters: AndreaniBranchFilters) => {
      const referenceClient = buildAndreaniReferenceClient(
        config.environment,
        env,
        dependencies.clientOptions,
      )
      return referenceClient.getSucursales(filters)
    })

  const branches = await fetchAndreaniDestinationBranches(
    { localidad, provincia, cpDestino },
    getBranches,
  )

  const branch = branches.find((item) => item.id === targetId)
  if (!branch) {
    throw new AndreaniError(
      "VALIDATION_ERROR",
      "La sucursal Andreani seleccionada no está disponible para este destino.",
    )
  }

  return {
    id: String(branch.id),
    codigo: branch.codigo,
    nombre: branch.descripcion,
    direccion: formatAndreaniBranchAddress(branch.direccion),
    localidad: branch.direccion.localidad,
    provincia: branch.direccion.provincia,
    codigoPostal: branch.direccion.codigoPostal,
  }
}

export function resetAndreaniCheckoutQuoteStateForTests() {
  pendingQuotes.clear()
  resolvedQuoteCache.clear()
  localityCache.clear()
  localityRequests.clear()
  branchCache.clear()
  branchRequests.clear()
}
