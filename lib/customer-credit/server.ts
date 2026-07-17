import "server-only"

import type { createAdminClient } from "@/lib/supabase/admin"
import { roundMoney } from "@/lib/customer-credit"

type AdminClient = ReturnType<typeof createAdminClient>

export type CustomerCreditMovementType =
  | "credit"
  | "debit"
  | "reversal"
  | "adjustment"
  | "expiration"

export type CustomerCreditSourceType =
  | "credit_note"
  | "claim"
  | "return"
  | "exchange"
  | "order"
  | "admin_adjustment"
  | "reversal"

export interface CustomerCreditMovementRow {
  id: string
  user_id: string
  movement_type: CustomerCreditMovementType
  amount: number | string
  description: string
  source_type: string
  source_id?: string | null
  order_id?: number | null
  claim_id?: number | null
  credit_note_id?: string | null
  created_by?: string | null
  related_movement_id?: string | null
  expires_at?: string | null
  created_at: string
  metadata?: Record<string, unknown> | null
  source_key?: string | null
  resulting_balance?: number | string | null
}

function formatCreditNoteId(point?: number | string | null, number?: number | string | null) {
  const pointNumber = Number(point ?? 0)
  const pointText =
    Number.isFinite(pointNumber) && pointNumber > 0
      ? String(pointNumber).padStart(4, "0")
      : "0000"
  const numberText = String(number ?? "").trim()

  return `${pointText}-${numberText.padStart(8, "0")}`
}

function getCreditNoteSourceKey({
  orderId,
  creditNotePoint,
  creditNoteNumber,
  creditNoteCae,
}: {
  orderId: number
  creditNotePoint?: number | string | null
  creditNoteNumber?: number | string | null
  creditNoteCae?: string | null
}) {
  const point = String(creditNotePoint ?? "").trim() || "sin-punto"
  const number =
    String(creditNoteNumber ?? "").trim() ||
    String(creditNoteCae ?? "").trim() ||
    "autorizada"

  return `credit-note:${orderId}:${point}:${number}`
}

export async function getCustomerCreditBalance(
  admin: AdminClient,
  userId: string
) {
  const { data, error } = await admin.rpc("get_customer_credit_balance", {
    p_user_id: userId,
  })

  if (error) {
    throw new Error(error.message || "No se pudo consultar el saldo.")
  }

  return roundMoney(Number(data ?? 0))
}

export async function applyCustomerCreditToOrder(
  admin: AdminClient,
  {
    userId,
    orderId,
    amount,
    description,
    sourceKey,
  }: {
    userId: string
    orderId: number
    amount: number
    description?: string
    sourceKey?: string
  }
) {
  const safeAmount = roundMoney(amount)

  if (safeAmount <= 0) {
    return null
  }

  const { data, error } = await admin.rpc("apply_customer_credit_to_order", {
    p_user_id: userId,
    p_order_id: orderId,
    p_amount: safeAmount,
    p_description: description ?? "Saldo a favor aplicado a compra",
    p_source_key: sourceKey ?? null,
  })

  if (error) {
    throw new Error(error.message || "No se pudo aplicar el saldo a favor.")
  }

  return Array.isArray(data) ? data[0] ?? null : data
}

export async function reverseCustomerCreditForOrder(
  admin: AdminClient,
  {
    orderId,
    description,
    createdBy,
  }: {
    orderId: number
    description?: string
    createdBy?: string | null
  }
) {
  const { data, error } = await admin.rpc("reverse_customer_credit_for_order", {
    p_order_id: orderId,
    p_description:
      description ?? "Reintegro de saldo a favor por cancelación",
    p_created_by: createdBy ?? null,
  })

  if (error) {
    throw new Error(error.message || "No se pudo reintegrar el saldo a favor.")
  }

  return Array.isArray(data) ? data[0] ?? null : data
}

export async function createCustomerCreditMovement(
  admin: AdminClient,
  {
    userId,
    movementType,
    amount,
    description,
    sourceType = "admin_adjustment",
    sourceId = null,
    orderId = null,
    claimId = null,
    creditNoteId = null,
    createdBy = null,
    relatedMovementId = null,
    expiresAt = null,
    metadata = {},
    sourceKey = null,
  }: {
    userId: string
    movementType: CustomerCreditMovementType
    amount: number
    description: string
    sourceType?: CustomerCreditSourceType
    sourceId?: string | null
    orderId?: number | null
    claimId?: number | null
    creditNoteId?: string | null
    createdBy?: string | null
    relatedMovementId?: string | null
    expiresAt?: string | null
    metadata?: Record<string, unknown>
    sourceKey?: string | null
  }
) {
  const safeAmount = roundMoney(amount)

  if (safeAmount <= 0) {
    throw new Error("Ingresá un monto mayor a cero.")
  }

  const { data, error } = await admin.rpc("create_customer_credit_movement", {
    p_user_id: userId,
    p_movement_type: movementType,
    p_amount: safeAmount,
    p_description: description,
    p_source_type: sourceType,
    p_source_id: sourceId,
    p_order_id: orderId,
    p_claim_id: claimId,
    p_credit_note_id: creditNoteId,
    p_created_by: createdBy,
    p_related_movement_id: relatedMovementId,
    p_expires_at: expiresAt,
    p_metadata: metadata,
    p_source_key: sourceKey,
  })

  if (error) {
    throw new Error(error.message || "No se pudo registrar el movimiento.")
  }

  return Array.isArray(data) ? data[0] ?? null : data
}

export async function creditCustomerForOrderCreditNote(
  admin: AdminClient,
  {
    userId,
    orderId,
    amount,
    creditNoteNumber,
    creditNotePoint,
    creditNoteCae,
    claimId = null,
    createdBy = null,
    metadata = {},
  }: {
    userId: string | null | undefined
    orderId: number
    amount: number
    creditNoteNumber?: number | string | null
    creditNotePoint?: number | string | null
    creditNoteCae?: string | null
    claimId?: number | null
    createdBy?: string | null
    metadata?: Record<string, unknown>
  }
) {
  const safeAmount = roundMoney(amount)

  if (!userId) {
    throw new Error("La orden no tiene una cuenta de cliente asociada para acreditar el saldo.")
  }

  if (safeAmount <= 0) {
    throw new Error("El monto a acreditar debe ser mayor que cero.")
  }

  const creditNoteId = formatCreditNoteId(creditNotePoint, creditNoteNumber)
  const { data: existingMovements, error: existingError } = await admin
    .from("customer_credit_movements")
    .select("id, resulting_balance")
    .eq("user_id", userId)
    .eq("movement_type", "credit")
    .eq("source_type", "credit_note")
    .eq("order_id", orderId)
    .eq("credit_note_id", creditNoteId)
    .limit(1)

  if (existingError) {
    throw new Error(existingError.message || "No se pudo verificar el saldo ya acreditado.")
  }

  const existingMovement = existingMovements?.[0]

  if (existingMovement) {
    return {
      movement_id: existingMovement.id,
      resulting_balance:
        existingMovement.resulting_balance ?? await getCustomerCreditBalance(admin, userId),
    }
  }

  return createCustomerCreditMovement(admin, {
    userId,
    movementType: "credit",
    amount: safeAmount,
    description: `Nota de crédito C ${creditNoteId} acreditada en saldo a favor`,
    sourceType: "credit_note",
    sourceId: creditNoteId,
    orderId,
    claimId,
    creditNoteId,
    createdBy,
    metadata: {
      created_from: "arca_credit_note",
      credit_note_cae: creditNoteCae ?? null,
      order_public_id: `BX-${1000 + orderId}`,
      ...metadata,
    },
    sourceKey: getCreditNoteSourceKey({
      orderId,
      creditNotePoint,
      creditNoteNumber,
      creditNoteCae,
    }),
  })
}

export async function listCustomerCreditMovements(
  admin: AdminClient,
  userId: string
) {
  const { data, error } = await admin
    .from("customer_credit_movements")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })

  if (error) {
    throw new Error(error.message || "No se pudieron cargar los movimientos.")
  }

  return (data ?? []) as CustomerCreditMovementRow[]
}
