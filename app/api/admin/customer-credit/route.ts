import { NextResponse } from "next/server"

import { requireAdmin } from "@/app/api/admin/clientes/_auth"
import {
  createCustomerCreditMovement,
  getCustomerCreditBalance,
  listCustomerCreditMovements,
  type CustomerCreditMovementRow,
  type CustomerCreditMovementType,
} from "@/lib/customer-credit/server"
import type { createAdminClient } from "@/lib/supabase/admin"

type AdminClient = ReturnType<typeof createAdminClient>

type CreditAction = "issue" | "reverse" | "transfer"

function normalizeAmount(value: unknown) {
  const parsed =
    typeof value === "number"
      ? value
      : Number(String(value ?? "").replace(/\./g, "").replace(",", "."))

  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : 0
}

function isCreditAction(value: unknown): value is CreditAction {
  return value === "issue" || value === "reverse" || value === "transfer"
}

function isMovementType(value: unknown): value is CustomerCreditMovementType {
  return (
    value === "credit" ||
    value === "debit" ||
    value === "reversal" ||
    value === "adjustment" ||
    value === "expiration"
  )
}

async function getMovementById(
  admin: AdminClient,
  movementId: string
) {
  const { data, error } = await admin
    .from("customer_credit_movements")
    .select("*")
    .eq("id", movementId)
    .maybeSingle()

  if (error) {
    throw new Error(error.message || "No se pudo leer el movimiento.")
  }

  return data as CustomerCreditMovementRow | null
}

export async function GET(request: Request) {
  const auth = await requireAdmin(request)

  if ("error" in auth) return auth.error

  const url = new URL(request.url)
  const userId = url.searchParams.get("userId")?.trim()
  const query = url.searchParams.get("q")?.trim()

  if (!userId && !query) {
    return NextResponse.json(
      { error: "Indicá un cliente para consultar." },
      { status: 400 }
    )
  }

  try {
    let targetUserId = userId ?? ""
    let profile = null

    if (!targetUserId && query) {
      const normalizedQuery = `%${query.toLowerCase()}%`
      const { data, error } = await auth.admin
        .from("profiles")
        .select("id, email, username, nombre, dni, rol")
        .or(
          `email.ilike.${normalizedQuery},username.ilike.${normalizedQuery},nombre.ilike.${normalizedQuery},dni.ilike.${normalizedQuery}`
        )
        .eq("rol", "cliente")
        .limit(1)
        .maybeSingle()

      if (error) {
        throw new Error(error.message || "No se pudo buscar el cliente.")
      }

      profile = data
      targetUserId = data?.id ?? ""
    } else if (targetUserId) {
      const { data } = await auth.admin
        .from("profiles")
        .select("id, email, username, nombre, dni, rol")
        .eq("id", targetUserId)
        .maybeSingle()

      profile = data
    }

    if (!targetUserId) {
      return NextResponse.json(
        { error: "No encontramos un cliente con esos datos." },
        { status: 404 }
      )
    }

    const [balance, movements] = await Promise.all([
      getCustomerCreditBalance(auth.admin, targetUserId),
      listCustomerCreditMovements(auth.admin, targetUserId),
    ])

    return NextResponse.json({
      profile,
      balance,
      movements,
    })
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "No se pudo consultar el saldo del cliente.",
      },
      { status: 500 }
    )
  }
}

export async function POST(request: Request) {
  const auth = await requireAdmin(request)

  if ("error" in auth) return auth.error

  const body = (await request.json()) as {
    action?: unknown
    userId?: unknown
    movementId?: unknown
    movementType?: unknown
    amount?: unknown
    description?: unknown
    destinationUserId?: unknown
    expiresAt?: unknown
  }
  const action = isCreditAction(body.action) ? body.action : "issue"

  try {
    if (action === "transfer") {
      const sourceUserId =
        typeof body.userId === "string" ? body.userId.trim() : ""
      const destinationUserId =
        typeof body.destinationUserId === "string"
          ? body.destinationUserId.trim()
          : ""
      const amount = normalizeAmount(body.amount)
      const description =
        typeof body.description === "string" ? body.description.trim() : ""

      if (!sourceUserId || !destinationUserId) {
        return NextResponse.json(
          { error: "Indicá cuenta de origen y destino." },
          { status: 400 },
        )
      }

      if (sourceUserId === destinationUserId) {
        return NextResponse.json(
          { error: "La cuenta de origen y destino no puede ser la misma." },
          { status: 400 },
        )
      }

      if (amount <= 0) {
        return NextResponse.json(
          { error: "Ingresá un monto mayor a cero." },
          { status: 400 },
        )
      }

      if (description.length < 3) {
        return NextResponse.json(
          { error: "Ingresá un mensaje para la GiftCard." },
          { status: 400 },
        )
      }

      const transferId = crypto.randomUUID()

      await createCustomerCreditMovement(auth.admin, {
        userId: sourceUserId,
        movementType: "debit",
        amount,
        description: `Transferencia GiftCard enviada: ${description}`,
        sourceType: "admin_adjustment",
        createdBy: auth.user.id,
        metadata: {
          created_from: "admin_gift_card_transfer",
          source_kind: "gift_card",
          transfer_id: transferId,
          destination_user_id: destinationUserId,
        },
        sourceKey: `gift-card-transfer:${transferId}:debit`,
      })

      await createCustomerCreditMovement(auth.admin, {
        userId: destinationUserId,
        movementType: "credit",
        amount,
        description: `GiftCard recibida: ${description}`,
        sourceType: "admin_adjustment",
        createdBy: auth.user.id,
        metadata: {
          created_from: "admin_gift_card_transfer",
          source_kind: "gift_card",
          transfer_id: transferId,
          source_user_id: sourceUserId,
        },
        sourceKey: `gift-card-transfer:${transferId}:credit`,
      })

      const [balance, movements] = await Promise.all([
        getCustomerCreditBalance(auth.admin, sourceUserId),
        listCustomerCreditMovements(auth.admin, sourceUserId),
      ])

      return NextResponse.json({ balance, movements })
    }

    if (action === "reverse") {
      const movementId =
        typeof body.movementId === "string" ? body.movementId.trim() : ""

      if (!movementId) {
        return NextResponse.json(
          { error: "Indicá el movimiento a reversar." },
          { status: 400 }
        )
      }

      const movement = await getMovementById(auth.admin, movementId)

      if (!movement) {
        return NextResponse.json(
          { error: "No encontramos el movimiento." },
          { status: 404 }
        )
      }

      const effect =
        movement.movement_type === "debit" ||
        movement.movement_type === "expiration"
          ? "reversal"
          : "debit"
      const amount = normalizeAmount(movement.amount)

      await createCustomerCreditMovement(auth.admin, {
        userId: movement.user_id,
        movementType: effect,
        amount,
        description:
          effect === "reversal"
            ? `Reversión del movimiento ${movement.id}`
            : `Anulación del crédito ${movement.id}`,
        sourceType: "reversal",
        sourceId: movement.id,
        orderId: movement.order_id ?? null,
        claimId: movement.claim_id ?? null,
        createdBy: auth.user.id,
        relatedMovementId: movement.id,
        sourceKey: `customer-credit:${movement.id}:admin-reversal`,
        metadata: {
          reversed_by: auth.user.id,
          original_movement_type: movement.movement_type,
        },
      })

      const [balance, movements] = await Promise.all([
        getCustomerCreditBalance(auth.admin, movement.user_id),
        listCustomerCreditMovements(auth.admin, movement.user_id),
      ])

      return NextResponse.json({ balance, movements })
    }

    const userId = typeof body.userId === "string" ? body.userId.trim() : ""
    const amount = normalizeAmount(body.amount)
    const description =
      typeof body.description === "string" ? body.description.trim() : ""
    const movementType = isMovementType(body.movementType)
      ? body.movementType
      : "credit"
    const expiresAt =
      typeof body.expiresAt === "string" && body.expiresAt.trim()
        ? body.expiresAt.trim()
        : null

    if (!userId) {
      return NextResponse.json(
        { error: "Indicá el cliente." },
        { status: 400 }
      )
    }

    if (amount <= 0) {
      return NextResponse.json(
        { error: "Ingresá un monto mayor a cero." },
        { status: 400 }
      )
    }

    if (description.length < 3) {
      return NextResponse.json(
        { error: "Ingresá una descripción." },
        { status: 400 }
      )
    }

    await createCustomerCreditMovement(auth.admin, {
      userId,
      movementType,
      amount,
      description,
      sourceType: "admin_adjustment",
      sourceId: null,
      orderId: null,
      claimId: null,
      creditNoteId: null,
      createdBy: auth.user.id,
      expiresAt,
      metadata: {
        created_from: "admin_gift_card_panel",
        source_kind: "gift_card",
      },
      sourceKey: `gift-card:${userId}:${crypto.randomUUID()}`,
    })

    const [balance, movements] = await Promise.all([
      getCustomerCreditBalance(auth.admin, userId),
      listCustomerCreditMovements(auth.admin, userId),
    ])

    return NextResponse.json({ balance, movements })
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "No se pudo registrar el movimiento de saldo.",
      },
      { status: 500 }
    )
  }
}
