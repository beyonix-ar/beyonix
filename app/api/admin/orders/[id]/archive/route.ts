import { NextResponse } from "next/server"

import { requireAdmin } from "@/app/api/admin/clientes/_auth"
import { describeOrderBlockers } from "@/lib/orders/order-visibility"

export const runtime = "nodejs"

const ERRORS: Record<string, { status: number; message: string }> = {
  ORDER_ARCHIVE_FORBIDDEN: { status: 403, message: "Sólo un super administrador puede archivar pedidos." },
  ORDER_ARCHIVE_REASON_REQUIRED: { status: 400, message: "Indicá el motivo (entre 5 y 500 caracteres)." },
  ORDER_NOT_FOUND: { status: 404, message: "El pedido no existe." },
  ORDER_NOT_ARCHIVED: { status: 409, message: "El pedido no está archivado." },
}

type Auth = Exclude<Awaited<ReturnType<typeof requireAdmin>>, { error: unknown }>

async function authorize(request: Request, params: Promise<{ id: string }>) {
  const auth = await requireAdmin(request)
  if ("error" in auth) return { response: auth.error }
  if (auth.profile.rol !== "super_admin") {
    return { response: NextResponse.json({ error: ERRORS.ORDER_ARCHIVE_FORBIDDEN.message }, { status: 403 }) }
  }
  const orderId = Number((await params).id)
  if (!Number.isSafeInteger(orderId) || orderId <= 0) {
    return { response: NextResponse.json({ error: "Pedido inválido." }, { status: 400 }) }
  }
  return { auth: auth as Auth, orderId }
}

async function readReason(request: Request) {
  try {
    const body = (await request.json()) as { reason?: unknown; hideFromCustomer?: unknown }
    return {
      reason: typeof body.reason === "string" ? body.reason.trim() : "",
      hideFromCustomer: body.hideFromCustomer === true,
    }
  } catch {
    return { reason: "", hideFromCustomer: false }
  }
}

function rpcErrorResponse(message: string | undefined, fallback: string) {
  const blocked = /ORDER_ARCHIVE_BLOCKED:([a-z_,]+)/.exec(message ?? "")
  if (blocked) {
    const codes = blocked[1].split(",").filter(Boolean)
    return NextResponse.json(
      { error: "No se puede archivar este pedido.", blockers: codes, reasons: describeOrderBlockers(codes) },
      { status: 409 },
    )
  }
  const known = Object.entries(ERRORS).find(([code]) => message?.includes(code))?.[1]
  return NextResponse.json({ error: known?.message ?? fallback }, { status: known?.status ?? 500 })
}

/** Qué impide archivar el pedido (vacío = se puede archivar). Sólo lectura. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const access = await authorize(request, params)
  if ("response" in access) return access.response
  const { data, error } = await access.auth.admin.rpc("order_archive_blockers", { p_order_id: access.orderId })
  if (error || !Array.isArray(data)) {
    console.error("ORDER_ARCHIVE_BLOCKERS_ERROR", { orderId: access.orderId, message: error?.message })
    return NextResponse.json({ error: "No se pudo comprobar si el pedido se puede archivar." }, { status: 500 })
  }
  const codes = data.filter((code): code is string => typeof code === "string")
  return NextResponse.json({ blockers: codes, reasons: describeOrderBlockers(codes) })
}

/**
 * Archiva un pedido de prueba: sale del listado operativo (y, si se pide, de
 * la cuenta del cliente). No borra nada; la base revalida permisos, motivo y
 * bloqueos dentro de la misma transacción y deja el evento de auditoría.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const access = await authorize(request, params)
  if ("response" in access) return access.response
  const { reason, hideFromCustomer } = await readReason(request)
  if (reason.length < 5 || reason.length > 500) {
    return NextResponse.json({ error: ERRORS.ORDER_ARCHIVE_REASON_REQUIRED.message }, { status: 400 })
  }
  const { data, error } = await access.auth.admin.rpc("archive_order_admin", {
    p_order_id: access.orderId,
    p_actor: access.auth.user.id,
    p_reason: reason,
    p_hide_from_customer: hideFromCustomer,
  })
  if (error) {
    console.error("ORDER_ARCHIVE_ERROR", { orderId: access.orderId, message: error.message })
    return rpcErrorResponse(error.message, "No se pudo archivar el pedido.")
  }
  return NextResponse.json({ archive: data })
}

/** Restaura un pedido archivado al listado operativo (con motivo y auditoría). */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const access = await authorize(request, params)
  if ("response" in access) return access.response
  const { reason } = await readReason(request)
  if (reason.length < 5 || reason.length > 500) {
    return NextResponse.json({ error: ERRORS.ORDER_ARCHIVE_REASON_REQUIRED.message }, { status: 400 })
  }
  const { data, error } = await access.auth.admin.rpc("unarchive_order_admin", {
    p_order_id: access.orderId,
    p_actor: access.auth.user.id,
    p_reason: reason,
  })
  if (error) {
    console.error("ORDER_UNARCHIVE_ERROR", { orderId: access.orderId, message: error.message })
    return rpcErrorResponse(error.message, "No se pudo restaurar el pedido.")
  }
  return NextResponse.json({ archive: data })
}
