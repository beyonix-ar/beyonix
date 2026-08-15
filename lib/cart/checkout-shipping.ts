import { createHmac, timingSafeEqual } from "node:crypto"

import {
  calculateCustomerShippingCost,
  DEFAULT_SHIPPING_SETTINGS,
  type ShippingBonusSettings,
} from "../store-config.ts"
import {
  normalizeArgentineLocationKey,
  normalizeArgentineProvinceKey,
} from "../validation/account-fields.ts"

export type CheckoutShippingType = "sucursal" | "domicilio"

export interface CheckoutShippingInput {
  provider?: string | null
  type?: CheckoutShippingType | null
  quoteToken?: string | null
  /** Se conserva solo por compatibilidad; nunca es una fuente de verdad. */
  costReal?: number | null
}

export interface CheckoutShippingQuoteItem {
  productId: number
  quantity: number
  variantId?: number | null
  conditionedStockId?: string | null
}

export interface CheckoutShippingQuoteBinding {
  cpDestino?: string | null
  localidad?: string | null
  provincia?: string | null
  items: CheckoutShippingQuoteItem[]
}

export interface CheckoutShippingQuoteOption {
  type: CheckoutShippingType
  price: number
}

export interface NormalizedCheckoutShipping {
  provider: "andreani"
  type: CheckoutShippingType
  costReal: number
  costCharged: number
  freeShippingApplied: boolean
}

interface CanonicalCheckoutShippingQuoteBinding {
  cpDestino: string
  localidad: string
  provincia: string
  items: Array<{
    productId: number
    quantity: number
    variantId: number | null
    conditionedStockId: string | null
  }>
}

interface CheckoutShippingQuoteClaims {
  version: 1
  provider: "andreani"
  type: CheckoutShippingType
  costCents: number
  expiresAt: number
  binding: CanonicalCheckoutShippingQuoteBinding
}

interface CheckoutShippingQuoteCryptoOptions {
  now?: number
  secret?: string
}

interface CreateCheckoutShippingQuoteOptions
  extends CheckoutShippingQuoteCryptoOptions {
  ttlMs?: number
}

const CHECKOUT_SHIPPING_QUOTE_VERSION = 1
const CHECKOUT_SHIPPING_QUOTE_TTL_MS = 30 * 60 * 1000
const CHECKOUT_SHIPPING_QUOTE_DOMAIN =
  "beyonix:checkout-shipping-quote:v1\0"
const MAX_CHECKOUT_SHIPPING_QUOTE_TOKEN_LENGTH = 16_384

export class CheckoutShippingQuoteError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CheckoutShippingQuoteError"
  }
}

function invalidQuote(): never {
  throw new CheckoutShippingQuoteError(
    "La cotización de envío venció o cambió. Volvé a cotizar antes de continuar.",
  )
}

function getCheckoutShippingQuoteSecret(explicitSecret?: string) {
  const secret =
    explicitSecret?.trim() ||
    process.env.CHECKOUT_SHIPPING_QUOTE_SECRET?.trim() ||
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()

  if (!secret || Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error(
      "La firma server-side de cotizaciones de envío no está configurada.",
    )
  }

  return secret
}

function toMoneyCents(value: number) {
  if (!Number.isFinite(value) || value <= 0) invalidQuote()

  const cents = Math.round(value * 100)
  if (
    !Number.isSafeInteger(cents) ||
    Math.abs(value * 100 - cents) > 0.000001
  ) {
    invalidQuote()
  }

  return cents
}

function canonicalizeQuoteBinding(
  binding: CheckoutShippingQuoteBinding,
): CanonicalCheckoutShippingQuoteBinding {
  const cpDestino = binding.cpDestino?.trim().toUpperCase() ?? ""
  const localidad = normalizeArgentineLocationKey(binding.localidad ?? "")
  const provincia = normalizeArgentineProvinceKey(binding.provincia ?? "")

  if (
    !/^\d{4}$/.test(cpDestino) ||
    !localidad ||
    !provincia ||
    !Array.isArray(binding.items) ||
    binding.items.length === 0 ||
    binding.items.length > 50
  ) {
    invalidQuote()
  }

  const groupedItems = new Map<
    string,
    CanonicalCheckoutShippingQuoteBinding["items"][number]
  >()

  for (const item of binding.items) {
    const productId = Number(item.productId)
    const quantity = Number(item.quantity)
    const conditionedStockId = item.conditionedStockId?.trim() || null
    const variantId = conditionedStockId ? null : Number(item.variantId) || null

    if (
      !Number.isSafeInteger(productId) ||
      productId <= 0 ||
      !Number.isSafeInteger(quantity) ||
      quantity <= 0 ||
      (variantId !== null &&
        (!Number.isSafeInteger(variantId) || variantId <= 0)) ||
      (conditionedStockId !== null &&
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          conditionedStockId,
        ))
    ) {
      invalidQuote()
    }

    const key = `${productId}:${variantId ?? ""}:${conditionedStockId ?? ""}`
    const existing = groupedItems.get(key)
    const groupedQuantity = (existing?.quantity ?? 0) + quantity
    if (!Number.isSafeInteger(groupedQuantity) || groupedQuantity > 5_000) {
      invalidQuote()
    }

    groupedItems.set(key, {
      productId,
      quantity: groupedQuantity,
      variantId,
      conditionedStockId,
    })
  }

  const items = [...groupedItems.values()].sort(
    (left, right) =>
      left.productId - right.productId ||
      (left.variantId ?? 0) - (right.variantId ?? 0) ||
      (left.conditionedStockId ?? "").localeCompare(
        right.conditionedStockId ?? "",
      ),
  )

  return { cpDestino, localidad, provincia, items }
}

function signQuotePayload(payload: string, secret: string) {
  return createHmac("sha256", secret)
    .update(CHECKOUT_SHIPPING_QUOTE_DOMAIN)
    .update(payload)
    .digest("base64url")
}

export function createCheckoutShippingQuoteToken(
  binding: CheckoutShippingQuoteBinding,
  option: CheckoutShippingQuoteOption,
  options: CreateCheckoutShippingQuoteOptions = {},
) {
  if (option.type !== "domicilio" && option.type !== "sucursal") {
    invalidQuote()
  }

  const now = options.now ?? Date.now()
  const ttlMs = options.ttlMs ?? CHECKOUT_SHIPPING_QUOTE_TTL_MS
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    invalidQuote()
  }

  const claims: CheckoutShippingQuoteClaims = {
    version: CHECKOUT_SHIPPING_QUOTE_VERSION,
    provider: "andreani",
    type: option.type,
    costCents: toMoneyCents(option.price),
    expiresAt: now + ttlMs,
    binding: canonicalizeQuoteBinding(binding),
  }
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString(
    "base64url",
  )
  const signature = signQuotePayload(
    payload,
    getCheckoutShippingQuoteSecret(options.secret),
  )

  return `${payload}.${signature}`
}

function verifyCheckoutShippingQuote(
  shipping: CheckoutShippingInput | null | undefined,
  binding: CheckoutShippingQuoteBinding,
  options: CheckoutShippingQuoteCryptoOptions = {},
) {
  const token = shipping?.quoteToken?.trim() ?? ""
  if (!token || token.length > MAX_CHECKOUT_SHIPPING_QUOTE_TOKEN_LENGTH) {
    invalidQuote()
  }

  const [payload, receivedSignature, extraPart] = token.split(".")
  if (!payload || !receivedSignature || extraPart) invalidQuote()

  const expectedSignature = signQuotePayload(
    payload,
    getCheckoutShippingQuoteSecret(options.secret),
  )
  const expectedBuffer = Buffer.from(expectedSignature)
  const receivedBuffer = Buffer.from(receivedSignature)
  if (
    expectedBuffer.length !== receivedBuffer.length ||
    !timingSafeEqual(expectedBuffer, receivedBuffer)
  ) {
    invalidQuote()
  }

  let claims: CheckoutShippingQuoteClaims
  try {
    claims = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as CheckoutShippingQuoteClaims
  } catch {
    invalidQuote()
  }

  const now = options.now ?? Date.now()
  const canonicalBinding = canonicalizeQuoteBinding(binding)
  if (
    claims.version !== CHECKOUT_SHIPPING_QUOTE_VERSION ||
    claims.provider !== "andreani" ||
    (claims.type !== "domicilio" && claims.type !== "sucursal") ||
    shipping?.provider && shipping.provider !== claims.provider ||
    shipping?.type !== claims.type ||
    !Number.isSafeInteger(claims.expiresAt) ||
    claims.expiresAt < now ||
    !Number.isSafeInteger(claims.costCents) ||
    claims.costCents <= 0 ||
    JSON.stringify(claims.binding) !== JSON.stringify(canonicalBinding)
  ) {
    invalidQuote()
  }

  return {
    provider: claims.provider,
    type: claims.type,
    costReal: claims.costCents / 100,
  } as const
}

export function normalizeCheckoutShipping(
  shipping: CheckoutShippingInput | null | undefined,
  binding: CheckoutShippingQuoteBinding,
  productsTotal: number,
  options: {
    customerCreditApplied?: boolean
    settings?: Partial<ShippingBonusSettings> | null
    now?: number
    secret?: string
  } = {},
): NormalizedCheckoutShipping {
  const verifiedQuote = verifyCheckoutShippingQuote(shipping, binding, options)
  const costReal = verifiedQuote.costReal
  const costCharged = options.customerCreditApplied
    ? 0
    : calculateCustomerShippingCost(
        productsTotal,
        costReal,
        options.settings ?? DEFAULT_SHIPPING_SETTINGS,
      )
  const freeShippingApplied = costCharged === 0

  return {
    provider: verifiedQuote.provider,
    type: verifiedQuote.type,
    costReal,
    costCharged,
    freeShippingApplied,
  }
}
