import { NextResponse } from "next/server"

import { requireAdmin } from "@/app/api/admin/clientes/_auth"
import {
  createCustomerCreditMovement,
  getCustomerCreditBalance,
} from "@/lib/customer-credit/server"

interface RouteContext {
  params: Promise<{ id: string }>
}

function normalizeAmount(value: unknown) {
  const parsed = Number(String(value ?? "").replace(/\./g, "").replace(",", "."))
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : 0
}

export async function POST(request: Request, context: RouteContext) {
  const auth = await requireAdmin(request)
  if ("error" in auth) return auth.error

  const { id: userId } = await context.params
  const body = (await request.json()) as {
    operation?: unknown
    amount?: unknown
    description?: unknown
  }
  const operation = body.operation === "debit" ? "debit" : "credit"
  const amount = normalizeAmount(body.amount)
  const submittedDescription = String(body.description ?? "").trim().slice(0, 300)
  const description = submittedDescription.length >= 3 ? submittedDescription : (
    operation === "credit"
      ? "Acreditación manual autorizada por superadmin"
      : "Débito manual autorizado por superadmin"
  )

  if (!userId) {
    return NextResponse.json({ error: "Indicá el cliente." }, { status: 400 })
  }
  if (amount <= 0) {
    return NextResponse.json(
      { error: "Ingresá un monto mayor a cero." },
      { status: 400 },
    )
  }
  if (submittedDescription.length < 3 && auth.profile.rol !== "super_admin") {
    return NextResponse.json(
      { error: "Ingresá el motivo del ajuste." },
      { status: 400 },
    )
  }

  const { data: profile, error: profileError } = await auth.admin
    .from("profiles")
    .select("id")
    .eq("id", userId)
    .maybeSingle()

  if (profileError || !profile) {
    return NextResponse.json(
      { error: "No encontramos la cuenta seleccionada." },
      { status: 404 },
    )
  }

  try {
    const adjustmentId = crypto.randomUUID()
    await createCustomerCreditMovement(auth.admin, {
      userId,
      movementType: operation,
      amount,
      description,
      sourceType: "admin_adjustment",
      createdBy: auth.user.id,
      metadata: {
        created_from: "admin_client_balance",
        source_kind: "balance_adjustment",
        operation,
        adjusted_by: auth.user.id,
      },
      sourceKey: `admin-balance-adjustment:${adjustmentId}`,
    })

    const balance = await getCustomerCreditBalance(auth.admin, userId)
    return NextResponse.json({ balance, operation, amount })
  } catch (error) {
    const message = error instanceof Error ? error.message : ""
    return NextResponse.json(
      {
        error: message.includes("INSUFFICIENT_CUSTOMER_CREDIT")
          ? "El cliente no tiene saldo suficiente para realizar ese débito."
          : message || "No se pudo actualizar el saldo.",
      },
      { status: 400 },
    )
  }
}
