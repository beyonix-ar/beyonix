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
  normalizeArgentineProvinceKey,
} from "../validation/account-fields.ts"

import {
  AndreaniClient,
  AndreaniError,
  type AndreaniClientOptions,
} from "./client.ts"
import { isCheckoutDestinationCached } from "./checkout-destinations.ts"
import type {
  AndreaniBranch,
  AndreaniBranchFilters,
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

  return { cpDestino, localidad, provincia, items }
}

export function matchAndreaniCheckoutProvince(
  request: Pick<
    AndreaniCheckoutQuoteRequest,
    "cpDestino" | "provincia"
  >,
  localities: AndreaniLocality[],
) {
  const provinceKey = normalizeArgentineProvinceKey(request.provincia)
  const match = localities.find(
    (locality) =>
      locality.codigosPostales.includes(request.cpDestino) &&
      normalizeArgentineProvinceKey(locality.provincia) === provinceKey,
  )

  if (!match) {
    throw new AndreaniError(
      "VALIDATION_ERROR",
      "El código postal no corresponde a la provincia seleccionada.",
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
      product,
      variant,
      quantity: item.quantity,
      discountPercent: conditioned ? Number(conditioned.discount_percent) || 0 : 0,
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

function readQuotePrice(response: AndreaniTariffResponse) {
  const price = Number(response?.tarifaConIva?.total)
  if (!Number.isFinite(price) || price <= 0) {
    throw new AndreaniError(
      "INVALID_RESPONSE",
      "Andreani devolvió una cotización sin un importe válido.",
    )
  }
  return Number(price.toFixed(2))
}

export async function quoteAndreaniCheckout(
  rawRequest: unknown,
  dependencies: CheckoutQuoteDependencies = {},
) {
  const request = normalizeCheckoutQuoteRequest(rawRequest)
  const env = dependencies.env ?? process.env
  const config = resolveAndreaniCheckoutConfig(env)
  const key = JSON.stringify(request)
  const existing = pendingQuotes.get(key)
  if (existing) return existing

  const promise = (async () => {
    const tariffEnv = { ...env, ANDREANI_ENV: config.environment }
    const client = new AndreaniClient({
      ...dependencies.clientOptions,
      env: tariffEnv,
      productionAccess:
        config.environment === "PROD"
          ? "tariffs-only"
          : dependencies.clientOptions?.productionAccess,
    })
    const referenceClient =
      config.environment === "QA"
        ? client
        : new AndreaniClient({
            ...dependencies.clientOptions,
            env: { ...env, ANDREANI_ENV: "QA" },
            productionAccess: undefined,
          })
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
      ((filters: AndreaniBranchFilters) =>
        getCachedReferenceData(
          request.cpDestino,
          branchCache,
          branchRequests,
          () => referenceClient.getSucursales(filters),
        ))
    const destinationIsCached =
      dependencies.isDestinationCached?.(request) ??
      isCheckoutDestinationCached(
        request.provincia,
        request.localidad,
        request.cpDestino,
      )
    const validateDestinationPromise = (async () => {
      if (destinationIsCached) return

      try {
        const localities = await getLocalities({
          codigosPostales: request.cpDestino,
        })
        matchAndreaniCheckoutProvince(request, localities)
      } catch (error) {
        if (error instanceof AndreaniError && error.status === 404) {
          throw new AndreaniError(
            "VALIDATION_ERROR",
            "No encontramos el código postal indicado.",
          )
        }
        throw error
      }
    })()
    await validateDestinationPromise

    const branchesPromise = (async () => {
      if (!config.sucursalContrato) return []
      try {
        return await getBranches({
          codigoPostal: request.cpDestino,
          canal: "B2C",
          seHaceAtencionAlCliente: true,
        })
      } catch (error) {
        if (error instanceof AndreaniError && error.status === 404) return []
        throw error
      }
    })()
    const authenticationPromise = dependencies.quoteTariff
      ? Promise.resolve()
      : client.authenticate()
    const packagePromise = (dependencies.loadItems ?? loadCheckoutItems)(request)
      .then(aggregateAndreaniPackage)
    const quote =
      dependencies.quoteTariff ??
      ((input: AndreaniTariffRequest) => client.cotizarEnvio(input))
    const quoteContract = async (
      type: AndreaniCheckoutQuoteOption["type"],
      contrato: string,
      packageData: AggregatedAndreaniPackage,
    ) => {
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
        return { type, price: readQuotePrice(response) }
      } catch (error) {
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
        ]).then(
          ([packageData, branches]) =>
            branches.length > 0
              ? quoteContract("sucursal", sucursalContrato, packageData)
              : null,
        )
      : Promise.resolve(null)

    const [homeQuote, branchQuote] = await Promise.all([
      homeQuotePromise,
      branchQuotePromise,
    ])
    const options = [homeQuote, branchQuote].filter(
      (option): option is AndreaniCheckoutQuoteOption => option !== null,
    )
    if (!options.length) {
      throw new AndreaniError(
        "VALIDATION_ERROR",
        ANDREANI_DESTINATION_UNAVAILABLE_MESSAGE,
      )
    }
    return options
  })()

  pendingQuotes.set(key, promise)
  try {
    return await promise
  } finally {
    if (pendingQuotes.get(key) === promise) pendingQuotes.delete(key)
  }
}

export function resetAndreaniCheckoutQuoteStateForTests() {
  pendingQuotes.clear()
  localityCache.clear()
  localityRequests.clear()
  branchCache.clear()
  branchRequests.clear()
}
