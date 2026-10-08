import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from "node:crypto"

import {
  calculateCustomerShippingCost,
  DEFAULT_SHIPPING_SETTINGS,
  type ShippingBonusSettings,
} from "../store-config.ts"
import {
  normalizeArgentineLocationKey,
  normalizeArgentineProvinceKey,
} from "../validation/account-fields.ts"
import {
  fromCents,
  isConsistentShippingPriceBreakdown,
  markupPercentToBasisPoints,
  toCents,
} from "../shipping/shipping-pricing.ts"

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
  direccion?: string | null
  sucursalId?: string | number | null
  items: CheckoutShippingQuoteItem[]
}

/** Bulto estimado que se usó para cotizar (snapshot para calibrar). */
export interface CheckoutShippingEstimatedParcel {
  lengthCm: number
  widthCm: number
  heightCm: number
  volumeCm3: number
  weightKg: number
}

export interface CheckoutShippingEstimate {
  version: string
  parcels: CheckoutShippingEstimatedParcel[]
  productsWeightKg: number
  productsVolumeCm3: number
}

/** Desglose interno de la tarifa. Nunca se envía al navegador en claro. */
export interface CheckoutShippingPricing {
  /** Tarifa de Andreani tal como la informó (con IVA). */
  providerAmount: number
  markupPercent: number
  markupAmount: number
  /** Ajuste por el redondeo de envío a $10 (puede ser negativo). */
  roundingAmount: number
}

export interface CheckoutShippingQuoteOption {
  type: CheckoutShippingType
  /** Precio logístico = tarifa + recargo + ajuste comercial. */
  price: number
  /**
   * Importe final que el cliente vio y aceptó para esta opción (precio
   * logístico ya con la bonificación/subsidio comercial vigente AL MOMENTO
   * DE COTIZAR -- ver calculateCustomerShippingCost). Si al crear la orden el
   * mismo cálculo da otro número, se exige recotizar: nunca se persiste en
   * silencio un importe distinto del que el cliente aceptó.
   */
  costCharged: number
  pricing: CheckoutShippingPricing
  estimate: CheckoutShippingEstimate
}

export interface NormalizedCheckoutShipping {
  provider: "andreani"
  type: CheckoutShippingType
  costReal: number
  costCharged: number
  freeShippingApplied: boolean
  pricing: CheckoutShippingPricing
  /** Parte del precio logístico cubierta por BEYONIX (costReal - costCharged). */
  benefitAmount: number
  estimate: CheckoutShippingEstimate
}

interface CanonicalCheckoutShippingQuoteBinding {
  cpDestino: string
  localidad: string
  provincia: string
  direccion: string
  sucursalId: string | null
  items: Array<{
    productId: number
    quantity: number
    variantId: number | null
    conditionedStockId: string | null
  }>
}

interface CheckoutShippingQuoteClaims {
  version: 3
  provider: "andreani"
  type: CheckoutShippingType
  /** Precio logístico. */
  costCents: number
  /** Importe final aceptado por el cliente. `0` es válido (envío gratis). */
  costChargedCents: number
  providerCents: number
  markupBasisPoints: number
  markupCents: number
  roundingCents: number
  estimate: CheckoutShippingEstimate
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

const CHECKOUT_SHIPPING_QUOTE_VERSION = 3
const CHECKOUT_SHIPPING_QUOTE_TTL_MS = 30 * 60 * 1000
/**
 * v3 cifra y autentica el contenido (AES-256-GCM): el token viaja por el
 * navegador y ahora incluye la tarifa del proveedor y el recargo. Un token v2
 * en vuelo al desplegar se rechaza y el checkout pide recotizar.
 */
const CHECKOUT_SHIPPING_QUOTE_DOMAIN = "beyonix:checkout-shipping-quote:v3"
const MAX_CHECKOUT_SHIPPING_QUOTE_TOKEN_LENGTH = 16_384
const MAX_ESTIMATED_PARCELS = 50

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

function quoteEncryptionKey(secret: string) {
  return createHmac("sha256", secret).update(`${CHECKOUT_SHIPPING_QUOTE_DOMAIN}:aes-256-gcm`).digest()
}

function toMoneyCents(value: number) {
  if (!Number.isFinite(value) || value <= 0) invalidQuote()

  return toMoneyCentsAllowingZero(value)
}

/** Igual que toMoneyCents, pero admite 0 -- para costCharged (envío gratis). */
function toMoneyCentsAllowingZero(value: number) {
  if (!Number.isFinite(value) || value < 0) invalidQuote()

  const cents = Math.round(value * 100)
  if (
    !Number.isSafeInteger(cents) ||
    Math.abs(value * 100 - cents) > 0.000001
  ) {
    invalidQuote()
  }

  return cents
}

const isPositiveFinite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0

function canonicalizeEstimate(estimate: CheckoutShippingEstimate): CheckoutShippingEstimate {
  if (
    !estimate ||
    typeof estimate.version !== "string" ||
    estimate.version.length > 40 ||
    !Array.isArray(estimate.parcels) ||
    estimate.parcels.length < 1 ||
    estimate.parcels.length > MAX_ESTIMATED_PARCELS ||
    !isPositiveFinite(estimate.productsWeightKg) ||
    !isPositiveFinite(estimate.productsVolumeCm3)
  ) {
    invalidQuote()
  }
  return {
    version: estimate.version,
    parcels: estimate.parcels.map((parcel) => {
      const values = [parcel?.lengthCm, parcel?.widthCm, parcel?.heightCm, parcel?.volumeCm3, parcel?.weightKg]
      if (!values.every(isPositiveFinite)) invalidQuote()
      return {
        lengthCm: parcel.lengthCm,
        widthCm: parcel.widthCm,
        heightCm: parcel.heightCm,
        volumeCm3: parcel.volumeCm3,
        weightKg: parcel.weightKg,
      }
    }),
    productsWeightKg: estimate.productsWeightKg,
    productsVolumeCm3: estimate.productsVolumeCm3,
  }
}

function canonicalizeQuoteBinding(
  binding: CheckoutShippingQuoteBinding,
): CanonicalCheckoutShippingQuoteBinding {
  const cpDestino = binding.cpDestino?.trim().toUpperCase() ?? ""
  const localidad = normalizeArgentineLocationKey(binding.localidad ?? "")
  const provincia = normalizeArgentineProvinceKey(binding.provincia ?? "")
  const direccion = (binding.direccion ?? "").split(/\.\s*Referencias:/i)[0]
    .normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase()
  const branchId = binding.sucursalId == null ? null : Number(binding.sucursalId)
  if (direccion.length > 500 || (branchId !== null && (!Number.isSafeInteger(branchId) || branchId <= 0))) invalidQuote()
  const sucursalId = branchId === null ? null : String(branchId)

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

  return { cpDestino, localidad, provincia, direccion, sucursalId, items }
}

function encryptClaims(claims: CheckoutShippingQuoteClaims, secret: string) {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", quoteEncryptionKey(secret), iv)
  cipher.setAAD(Buffer.from(CHECKOUT_SHIPPING_QUOTE_DOMAIN, "utf8"))
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(claims), "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ])
  return `${iv.toString("base64url")}.${encrypted.toString("base64url")}`
}

function decryptClaims(token: string, secret: string): CheckoutShippingQuoteClaims {
  const [ivPart, bodyPart, extraPart] = token.split(".")
  if (!ivPart || !bodyPart || extraPart) invalidQuote()
  const iv = Buffer.from(ivPart, "base64url")
  const body = Buffer.from(bodyPart, "base64url")
  if (iv.length !== 12 || body.length <= 16) invalidQuote()
  try {
    const decipher = createDecipheriv("aes-256-gcm", quoteEncryptionKey(secret), iv)
    decipher.setAAD(Buffer.from(CHECKOUT_SHIPPING_QUOTE_DOMAIN, "utf8"))
    decipher.setAuthTag(body.subarray(body.length - 16))
    const plain = Buffer.concat([
      decipher.update(body.subarray(0, body.length - 16)),
      decipher.final(),
    ])
    return JSON.parse(plain.toString("utf8")) as CheckoutShippingQuoteClaims
  } catch {
    invalidQuote()
  }
}

export function createCheckoutShippingQuoteToken(
  binding: CheckoutShippingQuoteBinding,
  option: CheckoutShippingQuoteOption,
  options: CreateCheckoutShippingQuoteOptions = {},
) {
  if (option.type !== "domicilio" && option.type !== "sucursal") {
    invalidQuote()
  }
  if (option.type === "sucursal" && binding.sucursalId == null) invalidQuote()

  const now = options.now ?? Date.now()
  const ttlMs = options.ttlMs ?? CHECKOUT_SHIPPING_QUOTE_TTL_MS
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    invalidQuote()
  }

  let markupBasisPoints: number
  try {
    markupBasisPoints = markupPercentToBasisPoints(option.pricing?.markupPercent)
  } catch {
    invalidQuote()
  }

  const claims: CheckoutShippingQuoteClaims = {
    version: CHECKOUT_SHIPPING_QUOTE_VERSION,
    provider: "andreani",
    type: option.type,
    costCents: toMoneyCents(option.price),
    costChargedCents: toMoneyCentsAllowingZero(option.costCharged),
    providerCents: toMoneyCents(option.pricing.providerAmount),
    markupBasisPoints,
    markupCents: toMoneyCentsAllowingZero(option.pricing.markupAmount),
    roundingCents: toCents(option.pricing.roundingAmount),
    estimate: canonicalizeEstimate(option.estimate),
    expiresAt: now + ttlMs,
    binding: canonicalizeQuoteBinding(binding),
  }
  if (
    claims.costChargedCents > claims.costCents ||
    !isConsistentShippingPriceBreakdown({
      providerCents: claims.providerCents,
      markupBasisPoints: claims.markupBasisPoints,
      markupCents: claims.markupCents,
      roundingCents: claims.roundingCents,
      logisticsCents: claims.costCents,
    })
  ) {
    invalidQuote()
  }

  return encryptClaims(claims, getCheckoutShippingQuoteSecret(options.secret))
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

  const claims = decryptClaims(token, getCheckoutShippingQuoteSecret(options.secret))

  const now = options.now ?? Date.now()
  const canonicalBinding = canonicalizeQuoteBinding(binding)
  if (
    claims.version !== CHECKOUT_SHIPPING_QUOTE_VERSION ||
    claims.provider !== "andreani" ||
    (claims.type !== "domicilio" && claims.type !== "sucursal") ||
    shipping?.provider && shipping.provider !== claims.provider ||
    shipping?.type !== claims.type ||
    !Number.isSafeInteger(claims.expiresAt) ||
    claims.expiresAt <= now ||
    (claims.type === "sucursal" && canonicalBinding.sucursalId === null) ||
    !Number.isSafeInteger(claims.costCents) ||
    claims.costCents <= 0 ||
    !Number.isSafeInteger(claims.costChargedCents) ||
    claims.costChargedCents < 0 ||
    claims.costChargedCents > claims.costCents ||
    !isConsistentShippingPriceBreakdown({
      providerCents: claims.providerCents,
      markupBasisPoints: claims.markupBasisPoints,
      markupCents: claims.markupCents,
      roundingCents: claims.roundingCents,
      logisticsCents: claims.costCents,
    }) ||
    JSON.stringify(claims.binding) !== JSON.stringify(canonicalBinding)
  ) {
    invalidQuote()
  }

  return {
    provider: claims.provider,
    type: claims.type,
    costReal: fromCents(claims.costCents),
    costChargedAtQuote: fromCents(claims.costChargedCents),
    markupBasisPoints: claims.markupBasisPoints,
    pricing: {
      providerAmount: fromCents(claims.providerCents),
      markupPercent: claims.markupBasisPoints / 100,
      markupAmount: fromCents(claims.markupCents),
      roundingAmount: fromCents(claims.roundingCents),
    },
    estimate: canonicalizeEstimate(claims.estimate),
  } as const
}

export function normalizeCheckoutShipping(
  shipping: CheckoutShippingInput | null | undefined,
  binding: CheckoutShippingQuoteBinding,
  productsTotal: number,
  options: {
    customerCreditApplied?: boolean
    settings?: Partial<ShippingBonusSettings> | null
    /** Recargo logístico vigente al crear la orden (Admin → Configuración). */
    markupPercent: number
    now?: number
    secret?: string
  },
): NormalizedCheckoutShipping {
  const verifiedQuote = verifyCheckoutShippingQuote(shipping, binding, options)
  const costReal = verifiedQuote.costReal

  // Mismo criterio que la bonificación: si el recargo cambió entre cotizar y
  // crear la orden, se recotiza. Cada orden queda con el porcentaje vigente.
  let currentBasisPoints: number
  try {
    currentBasisPoints = markupPercentToBasisPoints(options.markupPercent)
  } catch {
    invalidQuote()
  }
  if (currentBasisPoints !== verifiedQuote.markupBasisPoints) invalidQuote()

  const costCharged = options.customerCreditApplied
    ? 0
    : calculateCustomerShippingCost(
        productsTotal,
        costReal,
        options.settings ?? DEFAULT_SHIPPING_SETTINGS,
      )

  // El importe final que ve y acepta el cliente se firmó al cotizar. Si
  // recalcularlo ahora (con el subtotal/configuración comercial VIGENTES al
  // crear la orden) da un número distinto, algo cambió entre medio (precio de
  // catálogo, subsidio, umbral de envío gratis): nunca se persiste ese importe
  // distinto en silencio, se exige recotizar. El pago con saldo a favor
  // bonifica el envío completo y no depende de ese importe.
  if (
    !options.customerCreditApplied &&
    Math.round(costCharged * 100) !== Math.round(verifiedQuote.costChargedAtQuote * 100)
  ) {
    invalidQuote()
  }

  return {
    provider: verifiedQuote.provider,
    type: verifiedQuote.type,
    costReal,
    costCharged,
    freeShippingApplied: options.customerCreditApplied ? true : costCharged === 0,
    pricing: verifiedQuote.pricing,
    benefitAmount: fromCents(Math.round(costReal * 100) - Math.round(costCharged * 100)),
    estimate: verifiedQuote.estimate,
  }
}
