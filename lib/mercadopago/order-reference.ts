import { randomUUID } from "node:crypto"

import type { createAdminClient } from "../supabase/admin.ts"

type AdminClient = ReturnType<typeof createAdminClient>

/**
 * `external_reference` de Mercado Pago para pedidos: `order:<uuid>` con
 * `ordenes.mercadopago_reference`, único y nunca reutilizable. El número
 * visible del pedido (BX-1000 + id) no participa: los ids numéricos pueden
 * reutilizarse y una referencia numérica sola no prueba a qué orden
 * pertenece un pago.
 */
export const MERCADOPAGO_ORDER_REFERENCE_PREFIX = "order:"
export const MERCADOPAGO_CREDIT_TOPUP_REFERENCE_PREFIX = "credit-topup:"

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const LEGACY_ORDER_REFERENCE_PATTERN = /^[1-9]\d*$/

export interface MercadoPagoOrderReferenceFields {
  id: number
  mercadopago_reference?: string | null
  /** Sólo en órdenes legadas que recibieron UUID después de creadas. */
  mercadopago_reference_assigned_at?: string | null
}

export type ParsedMercadoPagoExternalReference =
  | { kind: "credit_topup" }
  | { kind: "order"; reference: string }
  | { kind: "legacy_order"; orderId: number }
  | { kind: "invalid" }

/** Cómo coincidió la referencia de un pago con la orden (null = no es suya). */
export type MercadoPagoOrderReferenceMatch = "reference" | "legacy_numeric" | null

export function normalizeMercadoPagoOrderReference(value: string | null | undefined) {
  const trimmed = typeof value === "string" ? value.trim() : ""
  return UUID_PATTERN.test(trimmed) ? trimmed.toLowerCase() : null
}

/** Helper canónico: la referencia con la que se emiten y buscan pagos de la orden. */
export function getMercadoPagoOrderExternalReference(order: MercadoPagoOrderReferenceFields) {
  const reference = normalizeMercadoPagoOrderReference(order.mercadopago_reference)
  return reference ? `${MERCADOPAGO_ORDER_REFERENCE_PREFIX}${reference}` : String(order.id)
}

export function parseMercadoPagoExternalReference(
  value: string | null | undefined,
): ParsedMercadoPagoExternalReference {
  const externalReference = typeof value === "string" ? value.trim() : ""

  if (externalReference.startsWith(MERCADOPAGO_CREDIT_TOPUP_REFERENCE_PREFIX)) {
    return { kind: "credit_topup" }
  }

  if (externalReference.startsWith(MERCADOPAGO_ORDER_REFERENCE_PREFIX)) {
    const reference = normalizeMercadoPagoOrderReference(
      externalReference.slice(MERCADOPAGO_ORDER_REFERENCE_PREFIX.length),
    )
    return reference ? { kind: "order", reference } : { kind: "invalid" }
  }

  if (LEGACY_ORDER_REFERENCE_PATTERN.test(externalReference)) {
    const orderId = Number(externalReference)
    if (Number.isSafeInteger(orderId)) return { kind: "legacy_order", orderId }
  }

  return { kind: "invalid" }
}

/**
 * Una orden acepta su referencia numérica sólo si es legada: sin UUID, o con
 * UUID asignado DESPUÉS de creada (pudo emitir preferencias numéricas antes).
 * Una orden nacida con UUID nunca acepta una referencia numérica.
 */
export function acceptsLegacyMercadoPagoOrderReference(order: MercadoPagoOrderReferenceFields) {
  return (
    !normalizeMercadoPagoOrderReference(order.mercadopago_reference) ||
    Boolean(order.mercadopago_reference_assigned_at)
  )
}

export function matchMercadoPagoOrderExternalReference(
  externalReference: string | null | undefined,
  order: MercadoPagoOrderReferenceFields,
): MercadoPagoOrderReferenceMatch {
  const parsed = parseMercadoPagoExternalReference(externalReference)

  if (parsed.kind === "order") {
    return parsed.reference === normalizeMercadoPagoOrderReference(order.mercadopago_reference)
      ? "reference"
      : null
  }

  if (parsed.kind === "legacy_order") {
    return parsed.orderId === order.id && acceptsLegacyMercadoPagoOrderReference(order)
      ? "legacy_numeric"
      : null
  }

  return null
}

/** Referencias bajo las que pueden existir pagos de esta orden en Mercado Pago. */
export function getMercadoPagoOrderPaymentSearchReferences(order: MercadoPagoOrderReferenceFields) {
  const references = [getMercadoPagoOrderExternalReference(order)]
  if (
    normalizeMercadoPagoOrderReference(order.mercadopago_reference) &&
    acceptsLegacyMercadoPagoOrderReference(order)
  ) {
    references.push(String(order.id))
  }
  return references
}

const ORDER_REFERENCE_SELECT = "id, mercadopago_reference, mercadopago_reference_assigned_at"

/**
 * Garantiza que la orden tenga UUID antes de emitir una preferencia. Las
 * órdenes nuevas ya lo traen por default; a una orden legada se le asigna en
 * este momento con un UPDATE condicional (`mercadopago_reference is null`):
 * si otro request ganó la carrera, se relee el valor persistido. El UUID es
 * inmutable en la base (trigger), nunca se reemplaza.
 */
export async function ensureMercadoPagoOrderReference(
  admin: AdminClient,
  order: MercadoPagoOrderReferenceFields,
  now: Date = new Date(),
): Promise<MercadoPagoOrderReferenceFields> {
  if (normalizeMercadoPagoOrderReference(order.mercadopago_reference)) return order

  const { data: assigned, error: assignError } = await admin
    .from("ordenes")
    .update({
      mercadopago_reference: randomUUID(),
      mercadopago_reference_assigned_at: now.toISOString(),
    } as never)
    .eq("id", order.id)
    .is("mercadopago_reference", null)
    .select(ORDER_REFERENCE_SELECT)
    .maybeSingle()

  if (assignError) {
    throw new Error(assignError.message || "No se pudo asignar la referencia de pago.")
  }

  let persisted = assigned as MercadoPagoOrderReferenceFields | null
  if (!persisted) {
    const { data, error } = await admin
      .from("ordenes")
      .select(ORDER_REFERENCE_SELECT)
      .eq("id", order.id)
      .maybeSingle()
    if (error) {
      throw new Error(error.message || "No se pudo leer la referencia de pago.")
    }
    persisted = data as MercadoPagoOrderReferenceFields | null
  }

  if (!persisted || !normalizeMercadoPagoOrderReference(persisted.mercadopago_reference)) {
    throw new Error("La orden no tiene una referencia de pago válida.")
  }

  return {
    ...order,
    mercadopago_reference: persisted.mercadopago_reference,
    mercadopago_reference_assigned_at: persisted.mercadopago_reference_assigned_at ?? null,
  }
}
