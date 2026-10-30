/**
 * Refresco del carrito contra el catálogo VIGENTE (precio, variante, stock,
 * cuotas habilitadas) mientras el cliente tiene abierto carrito/checkout.
 *
 * Es sólo UX: el carrito vive en sessionStorage con un snapshot del producto
 * tomado al agregarlo, y antes nunca se refrescaba. La seguridad NO depende
 * de esto -- el botón Pagar siempre recalcula todo server-side
 * (`/api/mercadopago/create-preference`, transferencia, saldo).
 *
 * Funciones puras: sin fetch ni React, testeables en `node --test`.
 */

import { getVariantOptionByValue } from "../products/product-variants.ts"
import { getMaxPurchasableQuantity, getStockStatus } from "./stock-status.ts"
import type { SupabaseProducto } from "../supabase/types.ts"

export interface RefreshableCartItem {
  product: SupabaseProducto
  color: string
  quantity: number
  variantId: number | null
  conditionedStockId: string | null
  variantName: string | null
  colorHex: string | null
  secondaryColorHex?: string | null
  unitPrice: number
  originalUnitPrice: number | null
  discountReason: string | null
}

/**
 * Cuánto disponible importa para esta línea: si alcanza para lo que ya eligió
 * y si puede sumar una unidad más (disponible = físico - reservas activas).
 * Más allá de `cantidad + 1` un cambio de stock no cambia nada para el
 * cliente, así que no re-renderiza ni genera aviso.
 */
function getRelevantPurchasableQuantity(item: RefreshableCartItem) {
  return Math.min(getMaxPurchasableQuantity(item.product, item.color), item.quantity + 1)
}

/**
 * Lo que, si cambia, cambia lo que el cliente paga o puede comprar. Del stock
 * sólo cuenta el estado agotado/bajo/disponible y el disponible relevante
 * para la línea (`getRelevantPurchasableQuantity`).
 */
function getCartItemCommercialKey(item: RefreshableCartItem) {
  return JSON.stringify([
    item.product.id,
    item.color,
    item.quantity,
    item.variantId,
    item.conditionedStockId,
    item.unitPrice,
    item.originalUnitPrice,
    item.discountReason,
    item.product.precio,
    getStockStatus(item.product, item.color),
    getRelevantPurchasableQuantity(item),
  ])
}

// Partes de la firma, para poder decir QUÉ cambió sin afirmar de más.
function getCartItemPriceKey(item: RefreshableCartItem) {
  return JSON.stringify([item.unitPrice, item.originalUnitPrice, item.discountReason, item.product.precio])
}

function getCartItemAvailabilityKey(item: RefreshableCartItem) {
  return JSON.stringify([
    getStockStatus(item.product, item.color),
    getRelevantPurchasableQuantity(item),
  ])
}

export function getCartCommercialSignature(items: RefreshableCartItem[]) {
  return items.map(getCartItemCommercialKey).join("|")
}

export interface CartCatalogReconciliation<T extends RefreshableCartItem> {
  items: T[]
  /** `true` si cambió algo que afecta precio, cuotas, stock o qué hay en el carrito. */
  changed: boolean
  /** Líneas que se quitaron porque el producto/variante ya no se vende. */
  removed: T[]
  /** Cambió el precio/descuento de alguna línea que sigue en el carrito. */
  priceChanged: boolean
  /** Cambió el stock vendible de alguna línea que sigue en el carrito. */
  availabilityChanged: boolean
}

/**
 * Aplica el catálogo fresco a los ítems del carrito. Si nada comercialmente
 * relevante cambió, devuelve EXACTAMENTE el mismo array (misma referencia):
 * el carrito no se toca ni se re-renderiza. Sólo se quita un producto
 * desactivado/borrado o una variante que ya no existe. Una línea sin stock
 * disponible (o con menos del pedido) se CONSERVA con el stock vigente: el
 * carrito la marca (getCartStockIssues) y no deja avanzar hasta corregirla.
 */
export function reconcileCartWithCatalog<T extends RefreshableCartItem>(
  items: T[],
  freshProducts: SupabaseProducto[],
): CartCatalogReconciliation<T> {
  const productsById = new Map(freshProducts.map((product) => [product.id, product]))
  const removed: T[] = []
  let changed = false
  let priceChanged = false
  let availabilityChanged = false

  const next = items.flatMap((item) => {
    const fresh = productsById.get(item.product.id)

    if (!fresh || fresh.activo === false) {
      removed.push(item)
      changed = true
      return []
    }

    // Conserva relaciones que la consulta liviana no trae (categorías,
    // especificaciones) y pisa todo lo comercial con el valor vigente.
    const product = { ...item.product, ...fresh } as SupabaseProducto
    const variant = getVariantOptionByValue(product, item.color)
    const sameVariant =
      variant != null &&
      variant.value === item.color &&
      (variant.id ?? null) === (item.variantId ?? null) &&
      (variant.conditionedStockId ?? null) === (item.conditionedStockId ?? null)

    if (!sameVariant) {
      removed.push(item)
      changed = true
      return []
    }

    const refreshed: T = {
      ...item,
      product,
      variantName: variant.name,
      colorHex: variant.colorHex,
      secondaryColorHex: variant.secondaryColorHex,
      unitPrice: variant.price,
      originalUnitPrice: variant.originalPrice,
      discountReason: variant.reason,
    }

    if (getCartItemCommercialKey(refreshed) !== getCartItemCommercialKey(item)) {
      changed = true
      if (getCartItemPriceKey(refreshed) !== getCartItemPriceKey(item)) priceChanged = true
      if (getCartItemAvailabilityKey(refreshed) !== getCartItemAvailabilityKey(item)) availabilityChanged = true
      return [refreshed]
    }

    return [item]
  })

  return { items: changed ? next : items, changed, removed, priceChanged, availabilityChanged }
}

export const COMMERCIAL_REFRESH_INTERVAL_MS = 30_000
export const COMMERCIAL_REFRESH_MIN_GAP_MS = 5_000

/**
 * Por qué cambió la compra del cliente, según lo que el refresco puede
 * afirmar con evidencia. Una cotización de envío (primera o por cambiar el
 * destino) NO es una causa: la provoca el cliente y el resumen ya la refleja.
 */
export type CommercialChangeCause =
  | "price"
  | "availability"
  | "removed"
  | "cart"
  | "shipping_settings"
  | "settings"
  | "multiple"

export interface CommercialChangeSignals {
  cartChanged: boolean
  priceChanged: boolean
  availabilityChanged: boolean
  removedCount: number
  settingsChanged: boolean
  shippingSettingsChanged: boolean
  /** Configuración comercial distinta del envío (precios, cuotas, saldo, stock…). */
  otherSettingsChanged: boolean
}

export function getCommercialChangeCause(signals: CommercialChangeSignals): CommercialChangeCause | null {
  const cartCause: CommercialChangeCause | null = !signals.cartChanged
    ? null
    : signals.priceChanged && (signals.availabilityChanged || signals.removedCount > 0)
      ? "multiple"
      : signals.priceChanged
        ? "price"
        : signals.removedCount > 0
          ? "removed"
          : signals.availabilityChanged
            ? "availability"
            : "cart"
  const settingsCause: CommercialChangeCause | null = !signals.settingsChanged
    ? null
    : signals.shippingSettingsChanged && signals.otherSettingsChanged
      ? "multiple"
      : signals.shippingSettingsChanged
        ? "shipping_settings"
        : "settings"

  if (cartCause && settingsCause) return "multiple"
  return cartCause ?? settingsCause
}

export function getCommercialUpdateNotice(cause: CommercialChangeCause, removedCount = 0): string {
  switch (cause) {
    case "price":
      return "Cambió el precio de uno o más productos. Revisá el nuevo total antes de pagar."
    case "availability":
      return "Cambió la disponibilidad de uno o más productos. Revisá tu carrito."
    case "removed":
      return removedCount > 1
        ? "Algunos productos ya no están disponibles y los quitamos de tu carrito."
        : "Un producto ya no está disponible y lo quitamos de tu carrito."
    case "cart":
      return "Tu carrito cambió. Revisalo antes de continuar."
    case "shipping_settings":
      return "Se actualizó el costo de envío. Revisá el nuevo total antes de pagar."
    case "settings":
      return "Se actualizaron las condiciones de tu compra. Revisá el nuevo total antes de continuar."
    case "multiple":
      return "Tu compra cambió. Revisá los productos, el envío y el nuevo total antes de pagar."
  }
}

export const PRICING_CHANGED_UNKNOWN_NOTICE = "El total de tu compra cambió. Revisalo antes de pagar."

/**
 * Aviso del 409 PRICING_CHANGED: el servidor sólo devuelve el nuevo total,
 * así que sin una causa detectada por el refresco no se afirma cuál fue.
 */
export function getPricingChangedNotice({
  cause,
  removedCount = 0,
  newTotalLabel,
}: {
  cause: CommercialChangeCause | null
  removedCount?: number
  newTotalLabel: string | null
}): string {
  if (!cause) {
    return newTotalLabel
      ? `El total de tu compra cambió. Nuevo total: ${newTotalLabel}. Revisalo antes de pagar.`
      : PRICING_CHANGED_UNKNOWN_NOTICE
  }
  const notice = getCommercialUpdateNotice(cause, removedCount)
  if (!newTotalLabel) return notice
  // Primera oración (la causa) + el total del servidor: "Se actualizó el costo
  // de envío. Nuevo total: $X. Revisalo antes de pagar."
  const causeSentence = notice.split(". ")[0].replace(/\.$/, "")
  return `${causeSentence}. Nuevo total: ${newTotalLabel}. Revisalo antes de pagar.`
}

/** Cambio detectado por un refresco comercial (causa + productos quitados). */
export interface DetectedCommercialChange {
  cause: CommercialChangeCause
  removedCount: number
}

export function getDetectedCommercialChange(signals: CommercialChangeSignals): DetectedCommercialChange | null {
  const cause = getCommercialChangeCause(signals)
  return cause ? { cause, removedCount: signals.removedCount } : null
}

/**
 * 409 PRICING_CHANGED pendiente. El total que recalculó el servidor manda en
 * la presentación hasta que el resumen visible lo refleje. `selectionKey` es
 * la huella de lo que había elegido el cliente (pago, envío, cantidades): si
 * después cambia, ese total ya no corresponde y el conflicto deja de aplicar.
 */
export interface PricingConflict {
  id: number
  serverTotal: number | null
  newTotalLabel: string | null
  selectionKey: string
  syncing: boolean
  /** La relectura del saldo a favor falló: no se puede dar por sincronizado. */
  creditSyncFailed: boolean
}

/**
 * Huella de la selección del cliente que define el total: medio de pago,
 * envío (proveedor, modalidad, sucursal), beneficio, cantidades y el destino
 * canónico de la cotización (`buildShippingQuoteKey`: CP, localidad,
 * provincia y dirección normalizados). Sólo datos que cambia el cliente:
 * nada volátil como tokens o fechas de cotización.
 */
export function buildPricingSelectionKey({
  paymentOption,
  shippingProvider,
  shippingType,
  sucursalId,
  storeBenefitId,
  destinationKey,
  items,
}: {
  paymentOption: string | null
  shippingProvider: string | null | undefined
  shippingType: string | null | undefined
  sucursalId: number | null
  storeBenefitId: string
  destinationKey: string
  items: ReadonlyArray<{
    product: { id: number }
    variantId: number | string | null
    conditionedStockId: number | string | null
    quantity: number
  }>
}): string {
  return JSON.stringify([
    paymentOption,
    shippingProvider ?? null,
    shippingType ?? null,
    sucursalId,
    storeBenefitId,
    destinationKey,
    items.map((item) => [item.product.id, item.variantId, item.conditionedStockId, item.quantity]),
  ])
}

/** Cierra la sincronización (o un reintento del saldo) del conflicto `id`. */
export function finishPricingConflictSync(
  conflict: PricingConflict | null,
  id: number,
  { creditReloaded }: { creditReloaded: boolean },
): PricingConflict | null {
  return conflict?.id === id ? { ...conflict, syncing: false, creditSyncFailed: !creditReloaded } : conflict
}

export const PRICING_CONFLICT_CREDIT_FAILED_MESSAGE = "No pudimos actualizar tu saldo. Intentá nuevamente."

/** Texto que se suma al aviso según el estado del conflicto (null si no hace falta). */
export function getPricingConflictStatusMessage(status: PricingConflictStatus): string | null {
  switch (status) {
    case "syncing":
      return "Actualizando el resumen…"
    case "credit_failed":
      return PRICING_CONFLICT_CREDIT_FAILED_MESSAGE
    case "mismatch":
      return "No pudimos actualizar el resumen con el nuevo total. Recargá la página antes de pagar."
    default:
      return null
  }
}

/**
 * - `none`: no hay conflicto vigente.
 * - `syncing`: se están releyendo catálogo/configuración/saldo o cuotas.
 * - `credit_failed`: no se pudo releer el saldo a favor (se puede reintentar).
 * - `mismatch`: terminó la sincronización pero el resumen no muestra el total
 *   del servidor (no se puede pagar viendo otro importe).
 * - `synced`: el resumen ya muestra el total confirmado por el servidor.
 */
export type PricingConflictStatus = "none" | "syncing" | "credit_failed" | "mismatch" | "synced"

export function pricingConflictBlocksPayment(status: PricingConflictStatus) {
  return status === "syncing" || status === "credit_failed" || status === "mismatch"
}

export function getPricingConflictStatus({
  conflict,
  selectionKey,
  visibleTotal,
  installmentsPending,
}: {
  conflict: PricingConflict | null
  selectionKey: string
  visibleTotal: number
  installmentsPending: boolean
}): PricingConflictStatus {
  if (!conflict || conflict.selectionKey !== selectionKey) return "none"
  if (conflict.syncing || installmentsPending) return "syncing"
  if (conflict.creditSyncFailed) return "credit_failed"
  if (conflict.serverTotal !== null && Math.abs(conflict.serverTotal - visibleTotal) > 0.009) return "mismatch"
  return "synced"
}

/**
 * Aviso del checkout. Con un 409 vigente tiene prioridad su "Nuevo total";
 * un refresco posterior sólo puede precisar la causa, nunca quitar el total.
 */
export function getCheckoutCommercialNotice({
  change,
  conflict,
}: {
  change: DetectedCommercialChange | null
  conflict: PricingConflict | null
}): string | null {
  if (conflict) {
    return getPricingChangedNotice({
      cause: change?.cause ?? null,
      removedCount: change?.removedCount,
      newTotalLabel: conflict.newTotalLabel,
    })
  }
  return change ? getCommercialUpdateNotice(change.cause, change.removedCount) : null
}

/**
 * Cuándo corresponde volver a leer catálogo+configuración: sólo con la
 * pestaña visible, sin otra lectura en curso y respetando un mínimo entre
 * lecturas (foco + visibilitychange + intervalo pueden dispararse juntos).
 * `force` (p. ej. después de un 409 PRICING_CHANGED) ignora el mínimo.
 */
export function shouldRunCommercialRefresh({
  visible,
  inFlight,
  lastRunAt,
  now,
  force = false,
}: {
  visible: boolean
  inFlight: boolean
  lastRunAt: number
  now: number
  force?: boolean
}) {
  if (inFlight) return false
  if (force) return true
  if (!visible) return false
  return now - lastRunAt >= COMMERCIAL_REFRESH_MIN_GAP_MS
}

/**
 * Una sola lectura comercial a la vez. Un `force` que llega con otra lectura
 * en curso (p. ej. un 409 PRICING_CHANGED) no se descarta ni reusa esa
 * lectura, que pudo empezar antes del cambio: se encadena una lectura nueva
 * al terminar, compartida por los `force` que lleguen mientras tanto. Así la
 * última lectura aplicada siempre es posterior al pedido.
 */
export function createCommercialRefreshRunner<T>(
  execute: () => Promise<T | null>,
  { isVisible, now = Date.now }: { isVisible: () => boolean; now?: () => number },
) {
  let current: Promise<T | null> | null = null
  let queuedForce: Promise<T | null> | null = null
  let lastRunAt = 0

  const start = () => {
    lastRunAt = now()
    const run: Promise<T | null> = execute().finally(() => {
      if (current === run) current = null
    })
    current = run
    return run
  }

  return (force = false): Promise<T | null> => {
    if (current) {
      if (!force) return Promise.resolve(null)
      const startQueued = () => {
        queuedForce = null
        return start()
      }
      queuedForce ??= current.then(startQueued, startQueued)
      return queuedForce
    }
    if (!shouldRunCommercialRefresh({ visible: isVisible(), inFlight: false, lastRunAt, now: now(), force })) {
      return Promise.resolve(null)
    }
    return start()
  }
}

interface CommercialSettingsInput {
  shipping?: unknown
  installmentsFinancing?: unknown
  pricing?: unknown
  customerCreditPayments?: unknown
  stock?: unknown
  financedPricePolicy?: unknown
  interestFreeOffer?: { tiers?: unknown } | null
}

/**
 * Configuración comercial que cambia totales, envío, cuotas, descuentos o qué
 * se puede comprar. De la oferta de cuotas sólo cuentan las cuotas: su
 * `checkedAt` cambia en cada sincronización con Mercado Pago sin que cambie
 * nada para el cliente.
 */
export function getCommercialSettingsSignature(settings: CommercialSettingsInput) {
  return JSON.stringify([settings.shipping ?? null, getOtherCommercialSettingsSignature(settings)])
}

function getOtherCommercialSettingsSignature(settings: CommercialSettingsInput) {
  return JSON.stringify([
    settings.installmentsFinancing ?? null,
    settings.pricing ?? null,
    settings.customerCreditPayments ?? null,
    settings.stock ?? null,
    settings.financedPricePolicy ?? null,
    settings.interestFreeOffer?.tiers ?? null,
  ])
}

/**
 * Diferencia comercial entre dos lecturas de configuración, separando el
 * envío del resto (si cambian ambos, son varias causas). Sin una lectura
 * válida anterior no hay "cambio": la primera carga sólo fija la base.
 */
export function diffCommercialSettings(
  previous: CommercialSettingsInput | null | undefined,
  next: CommercialSettingsInput | null | undefined,
): { changed: boolean; shippingChanged: boolean; otherChanged: boolean } {
  if (!previous || !next) return { changed: false, shippingChanged: false, otherChanged: false }
  const shippingChanged = JSON.stringify(previous.shipping ?? null) !== JSON.stringify(next.shipping ?? null)
  const otherChanged = getOtherCommercialSettingsSignature(previous) !== getOtherCommercialSettingsSignature(next)
  return { changed: shippingChanged || otherChanged, shippingChanged, otherChanged }
}
