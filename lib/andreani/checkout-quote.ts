import "server-only"

import { createAdminClient } from "../supabase/admin.ts"
import {
  IncompleteProductLogisticsError,
  resolveProductLogistics,
  type ProductLogisticsSource,
} from "../shipping/product-logistics.ts"
import { ProductLogisticsValidationError } from "../shipping/logistics-validation.ts"

import {
  AndreaniClient,
  AndreaniError,
  type AndreaniClientOptions,
} from "./client.ts"
import type {
  AndreaniCheckoutQuoteOption,
  AndreaniCheckoutQuoteRequest,
  AndreaniPackageQuoteInput,
  AndreaniQuoteResponse,
} from "./types.ts"

const PRODUCT_SELECT =
  "id, nombre, sku, precio, peso_empaquetado_kg, alto_paquete_cm, ancho_paquete_cm, largo_paquete_cm"
const VARIANT_SELECT =
  "id, producto_id, nombre, sku, peso_empaquetado_kg, alto_paquete_cm, ancho_paquete_cm, largo_paquete_cm"
const PENDING_QUOTE_TTL_MS = 2_000

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
  cliente: string
  domicilioContrato?: string
  sucursalContrato?: string
  sucursalOrigen?: string
}

interface CheckoutQuoteDependencies {
  env?: NodeJS.ProcessEnv
  loadItems?: (
    request: AndreaniCheckoutQuoteRequest,
  ) => Promise<LoadedCheckoutQuoteItem[]>
  quotePackage?: (
    input: AndreaniPackageQuoteInput,
  ) => Promise<AndreaniQuoteResponse>
  clientOptions?: AndreaniClientOptions
}

const pendingQuotes = new Map<
  string,
  { startedAt: number; promise: Promise<AndreaniCheckoutQuoteOption[]> }
>()

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
  if (requiredText(env.ANDREANI_ENV).toUpperCase() !== "QA") {
    throw new AndreaniError(
      "PRODUCTION_BLOCKED",
      "La cotización del checkout solo está habilitada en Andreani QA.",
    )
  }
  const cliente =
    requiredText(env.ANDREANI_QA_CLIENT) || requiredText(env.ANDREANI_CLIENTE)
  const domicilioContrato =
    optionalText(env.ANDREANI_QA_HOME_CONTRACT) ||
    optionalText(env.ANDREANI_QA_CONTRACT) ||
    optionalText(env.ANDREANI_CONTRATO)
  const sucursalContrato = optionalText(env.ANDREANI_QA_BRANCH_CONTRACT)

  if (!cliente || (!domicilioContrato && !sucursalContrato)) {
    throw new AndreaniError(
      "CONFIGURATION_ERROR",
      "La configuración de cotización Andreani QA está incompleta.",
    )
  }

  return {
    cliente,
    domicilioContrato,
    sucursalContrato,
    sucursalOrigen: optionalText(env.ANDREANI_QA_ORIGIN_BRANCH),
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
  if (!/^(?:\d{4}|[A-Z]\d{4}[A-Z]{3})$/.test(cpDestino)) {
    throw new AndreaniError("VALIDATION_ERROR", "Ingresá un código postal válido.")
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

  return { cpDestino, items }
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

function readQuotePrice(response: AndreaniQuoteResponse) {
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
  if (existing && Date.now() - existing.startedAt < PENDING_QUOTE_TTL_MS) {
    return existing.promise
  }

  const promise = (async () => {
    const items = await (dependencies.loadItems ?? loadCheckoutItems)(request)
    const packageData = aggregateAndreaniPackage(items)
    const client = dependencies.quotePackage
      ? null
      : new AndreaniClient({ env, ...dependencies.clientOptions })
    const quote = dependencies.quotePackage ?? ((input) => client!.cotizarPaquete(input))
    const contracts = [
      config.domicilioContrato
        ? { type: "domicilio" as const, contrato: config.domicilioContrato }
        : null,
      config.sucursalContrato
        ? { type: "sucursal" as const, contrato: config.sucursalContrato }
        : null,
    ].filter((entry): entry is NonNullable<typeof entry> => entry !== null)

    return Promise.all(
      contracts.map(async ({ type, contrato }) => {
        const response = await quote({
          codigoPostalDestino: request.cpDestino,
          contrato,
          cliente: config.cliente,
          codigoSucursalOrigen: config.sucursalOrigen,
          ...packageData,
        })
        return { type, price: readQuotePrice(response) }
      }),
    )
  })()

  pendingQuotes.set(key, { startedAt: Date.now(), promise })
  try {
    return await promise
  } finally {
    if (pendingQuotes.get(key)?.promise === promise) pendingQuotes.delete(key)
  }
}

export function resetAndreaniCheckoutQuoteStateForTests() {
  pendingQuotes.clear()
}
