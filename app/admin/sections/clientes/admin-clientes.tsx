"use client"

import { useMemo, useState } from "react"
import {
  Ban,
  CheckCircle2,
  ChevronDown,
  CircleDollarSign,
  Eye,
  FileText,
  LockKeyhole,
  MinusCircle,
  PlusCircle,
  Save,
  ShieldOff,
  ShoppingBag,
  Trash2,
  UserCheck,
  Users,
  XCircle,
} from "lucide-react"

import {
  useClientes,
  type CustomerCreditTopupReview,
} from "@/hooks/use-clientes"
import { useAuth } from "@/context/auth-context"
import type {
  BlockedClientIdentifier,
  ClientRiskStatus,
} from "@/lib/clients/client-blocking"
import type { SupabaseCliente } from "@/lib/supabase/types"
import {
  adminPageClassName,
  AdminEmptyState,
  AdminFiltersBar,
  AdminInfoBlock,
  AdminPageHeader,
  AdminSearchInput,
  AdminSelect,
  AdminSkeleton,
  AdminStatCard,
  AdminTextInput,
} from "../../components/admin-controls"
import { AdminDatePicker } from "../../components/admin-date-picker"
import { formatPrice } from "../productos/helpers"



type PurchaseFilter = "todos" | "con_compras" | "sin_compras"
type ActiveFilter = "todos" | "activos" | "inactivos"
type RiskFilter = "todos" | ClientRiskStatus | "bloqueados"

const RISK_LABELS: Record<ClientRiskStatus, string> = {
  normal: "Normal",
  tedioso: "Tedioso",
  complicado: "Complicado",
}

function formatDate(value?: string | null) {
  if (!value) return "-"

  return new Intl.DateTimeFormat("es-AR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "America/Argentina/Buenos_Aires",
  }).format(new Date(value))
}

function parseDateInput(value: string, endOfDay = false) {
  const clean = value.trim()
  if (!clean) return null

  const parts = clean.includes("/")
    ? clean.split("/")
    : clean.includes("-")
      ? clean.split("-").reverse()
      : []

  if (parts.length !== 3) return null

  const [day, month, year] = parts.map((part) => Number(part))
  if (!day || !month || !year) return null

  const date = new Date(year, month - 1, day)
  const isValid =
    date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day

  if (!isValid) return null
  if (endOfDay) date.setHours(23, 59, 59, 999)
  return date
}

function getLastOrderSummary(cliente: SupabaseCliente) {
  const order = cliente.last_order
  if (!order) return "Sin compras"

  const firstItem = order.orden_items?.[0]
  const product = firstItem?.productos?.nombre
  const quantity = firstItem?.cantidad
  const extraItems = Math.max((order.orden_items?.length ?? 0) - 1, 0)

  if (!product) return `Pedido #${order.id}`

  return `${product}${quantity ? ` x${quantity}` : ""}${
    extraItems ? ` y ${extraItems} más` : ""
  }`
}

function getCartItemCount(cart: SupabaseCliente["current_cart"]) {
  return Array.isArray(cart) ? cart.length : 0
}

function RiskBadge({ cliente }: { cliente: SupabaseCliente }) {
  const status = cliente.client_risk_status ?? "normal"

  if (cliente.blocked_at) {
    return (
      <span className="inline-flex w-fit items-center gap-2 rounded-full border border-red-400/30 bg-red-400/10 px-3 py-1 text-11px font-black uppercase tracking-wide text-red-200">
        <Ban className="size-3" />
        Bloqueado
      </span>
    )
  }

  if (status === "normal") return null

  return (
    <span
      className={`inline-flex w-fit items-center gap-2 rounded-full border px-3 py-1 text-11px font-black uppercase tracking-wide ${
        status === "complicado"
          ? "border-amber-300/35 bg-amber-300/10 text-amber-200"
          : "border-fuchsia-300/35 bg-fuchsia-300/10 text-fuchsia-200"
      }`}
    >
      <FileText className="size-3" />
      {RISK_LABELS[status]}
    </span>
  )
}

function ClientStatus({ cliente }: { cliente: SupabaseCliente }) {
  const hasOrders = cliente.order_count > 0
  const active = Boolean(cliente.is_active)

  return (
    <span
      className={`inline-flex w-fit items-center gap-2 rounded-full border px-3 py-1 text-11px font-black uppercase tracking-wide ${
        active
          ? "border-emerald-400/25 bg-emerald-400/10 text-emerald-300"
          : hasOrders
            ? "border-beyonix-blue-light/35 bg-beyonix-blue text-beyonix-sky"
            : "border-white/10 bg-white/5 text-white/55"
      }`}
    >
      <span
        className={`size-1.5 rounded-full ${
          active ? "bg-emerald-300" : hasOrders ? "bg-beyonix-sky" : "bg-white/35"
        }`}
      />
      {active ? "Activo" : hasOrders ? "Cliente" : "Sin compras"}
    </span>
  )
}

function ClientDataItem({
  label,
  value,
}: {
  label: string
  value?: string | null
}) {
  return (
    <div className="min-w-0">
      <dt className="text-10px font-bold uppercase tracking-widest text-white/42">
        {label}
      </dt>
      <dd className="mt-1.5 break-words text-sm font-semibold text-white/82">
        {value?.trim() || "No cargado"}
      </dd>
    </div>
  )
}

function CreditTopupsPanel({
  topups,
  savingId,
  onResolve,
}: {
  topups: CustomerCreditTopupReview[]
  savingId: string | null
  onResolve: (data: {
    topupId: string
    action: "approve" | "reject"
    amount?: string
  }) => Promise<void>
}) {
  const [amounts, setAmounts] = useState<Record<string, string>>({})
  const [topupToReject, setTopupToReject] = useState<CustomerCreditTopupReview | null>(null)
  const hasPendingTopups = topups.length > 0

  return (
    <>
    <section className="overflow-hidden rounded-3xl border border-beyonix-blue-light/28 bg-black p-4 sm:p-5">
      <div className={`-mx-4 -mt-4 flex flex-col gap-3 px-4 py-5 sm:-mx-5 sm:-mt-5 sm:flex-row sm:items-center sm:justify-between sm:px-5 ${
        hasPendingTopups
          ? "bg-[#123B33] shadow-[inset_0_-1px_0_rgba(110,231,183,0.16)]"
          : "bg-transparent"
      }`}>
        <div className="flex items-center gap-3">
          <span className={`flex size-11 shrink-0 items-center justify-center rounded-xl border ${
            hasPendingTopups
              ? "border-emerald-200/35 bg-black/20 text-white"
              : "border-beyonix-blue-light/35 bg-beyonix-blue text-white"
          }`}>
            <CircleDollarSign className="size-5" />
          </span>
          <div>
            <p className={`text-10px font-bold uppercase tracking-widest ${
              hasPendingTopups ? "text-emerald-200/75" : "text-beyonix-sky/70"
            }`}>
              Cargas de saldo
            </p>
            <h2 className={`mt-1 text-lg font-black ${
              hasPendingTopups ? "text-white" : "text-white/94"
            }`}>
              Comprobantes pendientes
            </h2>
            <p className={`mt-1 text-xs ${
              hasPendingTopups ? "text-emerald-100/80" : "text-white/55"
            }`}>
              Verificá la transferencia, ingresá el monto recibido y acreditá el saldo.
            </p>
          </div>
        </div>
        <span className={`inline-flex h-8 min-w-8 items-center justify-center rounded-full border px-2.5 text-xs font-black tabular-nums ${
          hasPendingTopups
            ? "border-emerald-200/30 bg-black/20 text-emerald-100 shadow-[0_0_14px_rgba(110,231,183,0.14)]"
            : "border-amber-300/25 bg-amber-300/10 text-amber-100"
        }`}>
          {topups.length}
        </span>
      </div>

      {topups.length ? (
        <div className="mt-5 overflow-x-auto rounded-2xl border border-[#284865] bg-[#0A0F15]">
          <table className="w-full min-w-[1050px] table-fixed border-collapse">
            <colgroup>
              <col className="w-[14%]" />
              <col className="w-[19%]" />
              <col className="w-[11%]" />
              <col className="w-[23%]" />
              <col className="w-[18%]" />
              <col className="w-[15%]" />
            </colgroup>
            <thead>
              <tr className="border-b border-[#284865] bg-[#111923]">
                {["Usuario", "Nombre y apellido", "DNI", "Email", "Monto a acreditar", "Acciones"].map((label, index) => (
                  <th
                    key={label}
                    className={`px-3 py-3.5 text-xs font-black uppercase tracking-wider text-white/65 ${
                      index > 1 ? "text-center" : "text-left"
                    }`}
                  >
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-[#20384D]">
              {topups.map((topup) => {
                const profile = topup.profile
                const saving = savingId === topup.id
                const amount = amounts[topup.id] ?? ""

                return (
                  <tr key={topup.id} className="bg-[#0D131A] transition hover:bg-[#111B25]">
                    <td className="px-3 py-3">
                      <p className="truncate text-xs font-black uppercase text-white/90">
                        {profile?.username || "Sin usuario"}
                      </p>
                      <p className="mt-1 truncate text-9px text-white/36">
                        {formatDate(topup.created_at)}
                      </p>
                    </td>
                    <td className="px-3 py-3 text-xs font-semibold text-white/82">
                      <p className="truncate">{profile?.nombre || "Sin nombre registrado"}</p>
                    </td>
                    <td className="px-3 py-3 text-center text-xs font-medium tabular-nums text-white/68">
                      {profile?.dni || "—"}
                    </td>
                    <td className="px-3 py-3 text-center text-xs text-white/68">
                      <p className="truncate">{profile?.email || "Sin email"}</p>
                    </td>
                    <td className="px-3 py-3">
                      <div className="relative mx-auto max-w-[190px]">
                        <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-xs font-black text-white/48">
                          $
                        </span>
                        <input
                          value={amount}
                          inputMode="decimal"
                          aria-label={`Monto a acreditar para ${profile?.nombre || "el cliente"}`}
                          placeholder="0"
                          onChange={(event) =>
                            setAmounts((current) => ({
                              ...current,
                              [topup.id]: event.target.value,
                            }))
                          }
                          className="h-9 w-full rounded-lg border border-[#3A6283] bg-[#24282E] px-7 text-center text-sm font-black text-white outline-none placeholder:text-white/28 focus:border-beyonix-sky"
                        />
                      </div>
                    </td>
                    <td className="px-3 py-3">
                      <div className="flex items-center justify-center gap-2">
                        {topup.proof_signed_url ? (
                          <a
                            href={topup.proof_signed_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            aria-label="Ver comprobante"
                            title="Ver comprobante"
                            className="inline-flex size-9 items-center justify-center rounded-lg border border-[#4F82A8] bg-[#132B40] text-white transition hover:border-beyonix-sky hover:bg-[#1A3B57]"
                          >
                            <Eye className="size-4" />
                          </a>
                        ) : (
                          <span
                            title="Comprobante no disponible"
                            className="inline-flex size-9 items-center justify-center rounded-lg border border-white/8 bg-white/[0.03] text-white/22"
                          >
                            <Eye className="size-4" />
                          </span>
                        )}
                        <button
                          type="button"
                          disabled={saving || !amount.trim()}
                          onClick={() =>
                            void onResolve({
                              topupId: topup.id,
                              action: "approve",
                              amount,
                            })
                          }
                          aria-label="Acreditar saldo"
                          title="Acreditar"
                          className="inline-flex size-9 cursor-pointer items-center justify-center rounded-lg border border-emerald-300/30 bg-emerald-300/10 text-emerald-100 transition hover:border-emerald-200 disabled:cursor-not-allowed disabled:opacity-35"
                        >
                          <CheckCircle2 className="size-4" />
                        </button>
                        <button
                          type="button"
                          disabled={saving}
                          onClick={() => setTopupToReject(topup)}
                          aria-label="Rechazar comprobante"
                          title="Rechazar"
                          className="inline-flex size-9 cursor-pointer items-center justify-center rounded-lg border border-red-300/25 bg-red-300/[0.08] text-red-100/85 transition hover:border-red-200 disabled:cursor-not-allowed disabled:opacity-35"
                        >
                          <XCircle className="size-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="mt-4 rounded-2xl border border-dashed border-white/10 bg-[#111418] px-4 py-7 text-center text-sm text-white/48">
          No hay comprobantes de carga pendientes.
        </div>
      )}
    </section>

    {topupToReject ? (
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="reject-topup-title"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !savingId) setTopupToReject(null)
        }}
        onMouseDown={(event) => {
          if (event.target === event.currentTarget && !savingId) {
            setTopupToReject(null)
          }
        }}
        className="fixed inset-0 z-[130] flex items-center justify-center bg-black/80 px-4 py-8 backdrop-blur-sm"
      >
        <div className="w-full max-w-sm overflow-hidden rounded-3xl border border-red-300/25 bg-[#0D1117] shadow-[0_30px_90px_rgba(0,0,0,0.7)]">
          <div className="px-6 pb-5 pt-6 text-center">
            <span className="mx-auto flex size-12 items-center justify-center rounded-2xl border border-red-300/30 bg-red-400/10 text-white">
              <XCircle className="size-5" />
            </span>
            <p className="mt-4 text-10px font-black uppercase tracking-[0.18em] text-red-200/65">
              Carga de saldo
            </p>
            <h2 id="reject-topup-title" className="mt-1 text-lg font-black text-white">
              Rechazar comprobante
            </h2>
            <p className="mt-2 text-sm leading-6 text-white/58">
              El comprobante de <strong className="font-bold text-white/88">
                {topupToReject.profile?.nombre || topupToReject.profile?.username || "este cliente"}
              </strong> quedará rechazado y no se acreditará saldo.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3 border-t border-white/8 bg-black/20 px-5 py-4">
            <button
              type="button"
              autoFocus
              disabled={Boolean(savingId)}
              onClick={() => setTopupToReject(null)}
              className="inline-flex h-10 cursor-pointer items-center justify-center rounded-xl border border-white/12 bg-white/[0.04] text-xs font-black text-white/72 transition hover:border-white/25 hover:bg-white/[0.08] hover:text-white disabled:cursor-not-allowed disabled:opacity-45"
            >
              Cancelar
            </button>
            <button
              type="button"
              disabled={Boolean(savingId)}
              onClick={() => {
                const topupId = topupToReject.id
                void onResolve({ topupId, action: "reject" })
                  .then(() => setTopupToReject(null))
                  .catch(() => undefined)
              }}
              className="inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-xl border border-red-300/35 bg-red-400/12 px-3 text-xs font-black text-red-100 transition hover:border-red-200/60 hover:bg-red-400/20 disabled:cursor-not-allowed disabled:opacity-45"
            >
              <XCircle className="size-3.5" />
              {savingId === topupToReject.id ? "Rechazando..." : "Rechazar"}
            </button>
          </div>
        </div>
      </div>
    ) : null}
    </>
  )
}

function ClientCard({
  cliente,
  saving,
  onUpdate,
  onAdjustBalance,
  isSuperAdmin,
}: {
  cliente: SupabaseCliente
  saving: boolean
  onUpdate: (
    clienteId: string,
    data: {
      client_risk_status?: ClientRiskStatus
      admin_note?: string | null
      blocked?: boolean
      blocked_reason?: string | null
    }
  ) => Promise<void>
  onAdjustBalance: (data: {
    userId: string
    operation: "credit" | "debit"
    amount: string
    description: string
  }) => Promise<void>
  isSuperAdmin: boolean
}) {
  const username = cliente.username || cliente.nombre
  const [riskStatus, setRiskStatus] = useState<ClientRiskStatus>(
    cliente.client_risk_status ?? "normal"
  )
  const [adminNote, setAdminNote] = useState(cliente.admin_note ?? "")
  const [blockReason, setBlockReason] = useState(cliente.blocked_reason ?? "")
  const [balanceOperation, setBalanceOperation] = useState<"credit" | "debit">("credit")
  const [balanceAmount, setBalanceAmount] = useState("")
  const [balanceDescription, setBalanceDescription] = useState("")
  const [balanceNotice, setBalanceNotice] = useState("")
  const [balanceError, setBalanceError] = useState("")
  const [balanceConfirmationOpen, setBalanceConfirmationOpen] = useState(false)
  const isBlocked = Boolean(cliente.blocked_at)

  const saveAdminInfo = () => {
    void onUpdate(cliente.id, {
      client_risk_status: riskStatus,
      admin_note: adminNote,
    })
  }

  const toggleBlocked = () => {
    void onUpdate(cliente.id, {
      blocked: !isBlocked,
      blocked_reason: blockReason,
    })
  }

  const executeBalanceAdjustment = async () => {
    try {
      await onAdjustBalance({
        userId: cliente.id,
        operation: balanceOperation,
        amount: balanceAmount,
        description: balanceDescription,
      })
      setBalanceAmount("")
      setBalanceDescription("")
      setBalanceNotice(
        balanceOperation === "credit"
          ? "Saldo acreditado correctamente."
          : "Saldo debitado correctamente.",
      )
    } catch (error) {
      setBalanceError(
        error instanceof Error ? error.message : "No se pudo actualizar el saldo.",
      )
    }
  }

  const submitBalanceAdjustment = () => {
    setBalanceNotice("")
    setBalanceError("")

    setBalanceConfirmationOpen(true)
  }

  return (
    <details className="rounded-3xl border border-white/8 bg-black">
      <summary className="grid cursor-pointer gap-4 px-4 py-4 lg:grid-cols-admin-clients lg:items-center">
        <div className="min-w-0">
          <p className="truncate text-sm font-black uppercase text-white/92">
            {username}
          </p>
          <p className="mt-1 truncate text-xs text-white/58">
            {cliente.email}
          </p>
          <span className="mt-2 inline-flex rounded-full border border-[#4F82A8]/35 bg-[#112A43]/70 px-2 py-0.5 text-9px font-black uppercase tracking-wider text-beyonix-sky">
            {cliente.rol === "super_admin"
              ? "Superadmin"
              : cliente.rol === "admin"
                ? "Administrador"
                : "Cliente"}
          </span>
        </div>

        <div className="min-w-0">
          <p className="truncate text-sm font-bold text-white/88">
            {cliente.nombre}
          </p>
        </div>

        <p className="truncate text-center text-sm text-white/72">
          {cliente.telefono || "Sin teléfono"}
        </p>

        <div className="text-center">
          <p className="text-sm font-black text-beyonix-sky">
            Saldo {formatPrice(cliente.customer_credit_balance ?? 0)}
          </p>
          <p className="mt-1 text-xs text-white/58">
            {formatPrice(cliente.total_spent)} · {cliente.order_count} pedidos
          </p>
        </div>

        <div className="flex flex-col items-center gap-2">
          <ClientStatus cliente={cliente} />
          <RiskBadge cliente={cliente} />
        </div>
      </summary>

      <div className="border-t border-white/7 px-4 py-4">
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
          <div className="rounded-2xl border border-beyonix-blue-light/20 bg-beyonix-blue/45 p-4">
            <p className="text-11px font-bold uppercase tracking-widest text-beyonix-sky/70">
              Saldo disponible
            </p>
            <p className="mt-2 text-lg font-black text-white">
              {formatPrice(cliente.customer_credit_balance ?? 0)}
            </p>
          </div>
          <div className="rounded-2xl border border-white/7 bg-black p-4">
            <p className="text-11px font-bold uppercase tracking-widest text-white/48">
              Registro
            </p>
            <p className="mt-2 text-sm font-bold text-white/88">
              {formatDate(cliente.created_at)}
            </p>
          </div>
          <div className="rounded-2xl border border-white/7 bg-black p-4">
            <p className="text-11px font-bold uppercase tracking-widest text-white/48">
              Última conexión
            </p>
            <p className="mt-2 text-sm font-bold text-white/88">
              {cliente.last_seen_at ? formatDate(cliente.last_seen_at) : "No disponible"}
            </p>
          </div>
          <div className="rounded-2xl border border-white/7 bg-black p-4">
            <p className="text-11px font-bold uppercase tracking-widest text-white/48">
              Última compra
            </p>
            <p className="mt-2 text-sm font-bold text-white/88">
              {formatDate(cliente.last_order?.created_at)}
            </p>
          </div>
          <div className="rounded-2xl border border-white/7 bg-black p-4">
            <p className="text-11px font-bold uppercase tracking-widest text-white/48">
              Detalle
            </p>
            <p
              className="mt-2 truncate text-sm font-bold text-white/88"
            >
              {getLastOrderSummary(cliente)}
            </p>
          </div>
        </div>

        <div className="mt-4 grid gap-4 xl:grid-cols-2">
          <section className="rounded-2xl border border-white/7 bg-black p-4">
            <p className="text-11px font-bold uppercase tracking-widest text-beyonix-sky/70">
              Datos personales
            </p>
            <dl className="mt-4 grid gap-x-5 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
              <ClientDataItem label="Usuario" value={username} />
              <ClientDataItem label="Nombre y apellido" value={cliente.nombre} />
              <ClientDataItem label="DNI" value={cliente.dni} />
              <ClientDataItem label="Email" value={cliente.email} />
              <ClientDataItem label="Teléfono" value={cliente.telefono} />
              <ClientDataItem label="Rol" value={cliente.rol} />
            </dl>
          </section>

          <section className="rounded-2xl border border-white/7 bg-black p-4">
            <p className="text-11px font-bold uppercase tracking-widest text-beyonix-sky/70">
              Domicilio y envío
            </p>
            <dl className="mt-4 grid gap-x-5 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
              <ClientDataItem label="Calle" value={cliente.calle} />
              <ClientDataItem label="Número" value={cliente.numero} />
              <ClientDataItem label="Piso" value={cliente.piso} />
              <ClientDataItem label="Departamento" value={cliente.departamento} />
              <ClientDataItem label="Localidad" value={cliente.localidad} />
              <ClientDataItem label="Provincia" value={cliente.provincia} />
              <ClientDataItem label="Código postal" value={cliente.codigo_postal} />
              <ClientDataItem label="Referencias" value={cliente.referencias} />
            </dl>
          </section>
        </div>

        <section className="mt-4 rounded-2xl border border-[#4F82A8]/35 bg-[#0A1724] p-4 sm:p-5">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <div className="flex items-center gap-2">
                <CircleDollarSign className="size-4 text-beyonix-sky" />
                <h3 className="text-sm font-black uppercase tracking-wide text-white/92">
                  Administrar saldo
                </h3>
              </div>
              <p className="mt-1.5 text-xs leading-5 text-white/50">
                Acreditá o debitá saldo manualmente. Este movimiento no genera una Gift Card.
              </p>
            </div>
            <p className="text-sm font-black text-beyonix-sky">
              Disponible: {formatPrice(cliente.customer_credit_balance ?? 0)}
            </p>
          </div>

          <div className="mt-4 grid gap-3 md:grid-cols-[290px_180px_minmax(240px,1fr)_auto] md:items-end">
            <fieldset className="block min-w-0">
              <legend className="text-11px font-bold text-white/65">Operación</legend>
              <div className="mt-1.5 grid h-11 grid-cols-2 gap-1 rounded-xl border border-[#4F82A8]/30 bg-black p-1 shadow-[inset_0_1px_4px_rgba(0,0,0,0.45)]">
                <button
                  type="button"
                  aria-pressed={balanceOperation === "credit"}
                  onClick={() => setBalanceOperation("credit")}
                  className={`inline-flex min-w-0 cursor-pointer items-center justify-center gap-2 rounded-lg px-3 text-xs font-black transition-all duration-200 ${
                    balanceOperation === "credit"
                      ? "border border-emerald-300/35 bg-emerald-400/15 text-emerald-100 shadow-[0_4px_14px_rgba(52,211,153,0.1)]"
                      : "border border-transparent text-white/45 hover:bg-white/[0.05] hover:text-white/75"
                  }`}
                >
                  <PlusCircle className="size-3.5 shrink-0" />
                  Acreditar
                </button>
                <button
                  type="button"
                  aria-pressed={balanceOperation === "debit"}
                  onClick={() => setBalanceOperation("debit")}
                  className={`inline-flex min-w-0 cursor-pointer items-center justify-center gap-2 rounded-lg px-3 text-xs font-black transition-all duration-200 ${
                    balanceOperation === "debit"
                      ? "border border-red-300/35 bg-red-400/15 text-red-100 shadow-[0_4px_14px_rgba(248,113,113,0.1)]"
                      : "border border-transparent text-white/45 hover:bg-white/[0.05] hover:text-white/75"
                  }`}
                >
                  <MinusCircle className="size-3.5 shrink-0" />
                  Debitar
                </button>
              </div>
            </fieldset>

            <label className="block">
              <span className="text-11px font-bold text-white/65">Importe</span>
              <input
                value={balanceAmount}
                onChange={(event) => setBalanceAmount(event.target.value)}
                inputMode="decimal"
                placeholder="$ 0"
                className="mt-1.5 h-11 w-full rounded-xl border border-[#4F82A8]/35 bg-black px-3 text-sm font-semibold text-white outline-none placeholder:text-white/25 focus:border-beyonix-sky"
              />
            </label>

            <label className="block">
              <span className="text-11px font-bold text-white/65">
                Motivo interno{isSuperAdmin ? " (opcional)" : ""}
              </span>
              <input
                value={balanceDescription}
                onChange={(event) => setBalanceDescription(event.target.value)}
                maxLength={300}
                placeholder={
                  isSuperAdmin
                    ? "Opcional para superadmin"
                    : "Ej.: Ajuste por devolución o corrección administrativa"
                }
                className="mt-1.5 h-11 w-full rounded-xl border border-[#4F82A8]/35 bg-black px-3 text-sm text-white outline-none placeholder:text-white/25 focus:border-beyonix-sky"
              />
            </label>

            <button
              type="button"
              disabled={
                saving ||
                !balanceAmount.trim() ||
                (!isSuperAdmin && balanceDescription.trim().length < 3)
              }
              onClick={submitBalanceAdjustment}
              className={`inline-flex h-11 cursor-pointer items-center justify-center rounded-xl border px-5 text-sm font-black transition disabled:cursor-not-allowed disabled:opacity-40 ${
                balanceOperation === "credit"
                  ? "border-emerald-300/30 bg-emerald-400/10 text-emerald-200 hover:border-emerald-200/55"
                  : "border-red-300/30 bg-red-400/10 text-red-200 hover:border-red-200/55"
              }`}
            >
              {saving
                ? "Guardando..."
                : balanceOperation === "credit"
                  ? "Acreditar"
                  : "Debitar"}
            </button>
          </div>

          {balanceNotice ? (
            <p className="mt-3 text-xs font-semibold text-emerald-300">{balanceNotice}</p>
          ) : null}
          {balanceError ? (
            <p className="mt-3 text-xs font-semibold text-red-200">{balanceError}</p>
          ) : null}
        </section>

        {cliente.rol === "cliente" ? (
          <>
        <div className="mt-4 rounded-2xl border border-beyonix-blue-light/25 bg-beyonix-blue px-4 py-3 text-sm text-beyonix-sky">
          {cliente.current_cart
            ? "Carrito actual disponible en la base de datos."
            : "Carrito actual no disponible para este cliente."}
        </div>

        <div className="mt-4 grid gap-4 xl:grid-cols-2">
          <div className="rounded-2xl border border-white/7 bg-black p-4">
            <div className="mb-3 flex items-center gap-2 text-white/92">
              <FileText className="size-4 text-beyonix-sky" />
              <h3 className="text-sm font-black uppercase tracking-wide">
                Clasificacion interna
              </h3>
            </div>
            <div className="grid gap-3 md:grid-cols-admin-client-note">
              <AdminSelect
                title="Clasificacion del cliente"
                value={riskStatus}
                onChange={(value) => setRiskStatus(value as ClientRiskStatus)}
              >
                <option value="normal">Normal</option>
                <option value="tedioso">Tedioso</option>
                <option value="complicado">Complicado</option>
              </AdminSelect>
              <button
                type="button"
                aria-label="Guardar clasificacion"
                disabled={saving}
                onClick={saveAdminInfo}
                className="flex h-11 cursor-pointer items-center justify-center gap-2 rounded-18px border border-beyonix-blue-light/40 bg-beyonix-blue px-4 text-sm font-black text-beyonix-sky transition hover:border-beyonix-sky disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Save className="size-4" />
                Guardar
              </button>
            </div>
            <textarea
              aria-label="Nota interna del cliente"
              value={adminNote}
              placeholder="Descripcion privada para recordar por que es tedioso o complicado."
              onChange={(event) => setAdminNote(event.target.value)}
              className="mt-3 min-h-28 w-full resize-none rounded-18px border border-white/12 bg-black px-4 py-3 text-sm leading-6 text-white/86 outline-none placeholder:text-white/32 hover:border-beyonix-blue-light/45 focus:border-beyonix-blue-light"
            />
          </div>

          <div className="rounded-2xl border border-red-400/15 bg-red-400/5 p-4">
            <div className="mb-3 flex items-center gap-2 text-white/92">
              <LockKeyhole className="size-4 text-red-200" />
              <h3 className="text-sm font-black uppercase tracking-wide">
                Bloqueo de cuenta
              </h3>
            </div>
            <textarea
              aria-label="Motivo del bloqueo"
              value={blockReason}
              placeholder="Motivo: estafa, maltrato, disputa, datos falsos..."
              onChange={(event) => setBlockReason(event.target.value)}
              className="min-h-24 w-full resize-none rounded-18px border border-white/12 bg-black px-4 py-3 text-sm leading-6 text-white/86 outline-none placeholder:text-white/32 hover:border-red-300/45 focus:border-red-300"
            />
            <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-xs text-white/52">
                {isBlocked
                  ? `Bloqueado desde ${formatDate(cliente.blocked_at)}.`
                  : "Al bloquearlo se guardan email, usuario y teléfono para frenar nuevos registros."}
              </p>
              <button
                type="button"
                aria-label={isBlocked ? "Desbloquear cliente" : "Bloquear cliente"}
                disabled={saving}
                onClick={toggleBlocked}
                className={`flex h-11 cursor-pointer items-center justify-center gap-2 rounded-18px border px-4 text-sm font-black transition disabled:cursor-not-allowed disabled:opacity-50 ${
                  isBlocked
                    ? "border-emerald-300/35 bg-emerald-300/10 text-emerald-200 hover:border-emerald-200"
                    : "border-red-300/35 bg-red-400/10 text-red-200 hover:border-red-200"
                }`}
              >
                {isBlocked ? <ShieldOff className="size-4" /> : <Ban className="size-4" />}
                {isBlocked ? "Desbloquear" : "Bloquear"}
              </button>
            </div>
          </div>
        </div>
          </>
        ) : null}
      </div>

      {balanceConfirmationOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby={`balance-adjustment-title-${cliente.id}`}
          onKeyDown={(event) => {
            if (event.key === "Escape" && !saving) setBalanceConfirmationOpen(false)
          }}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !saving) {
              setBalanceConfirmationOpen(false)
            }
          }}
          className="fixed inset-0 z-[120] flex items-center justify-center bg-black/80 px-4 py-8 backdrop-blur-sm"
        >
          <div className="w-full max-w-md overflow-hidden rounded-3xl border border-[#4F82A8]/45 bg-[#08131E] shadow-[0_30px_90px_rgba(0,0,0,0.65)]">
            <div className="border-b border-[#31506F]/65 bg-[#0B1C2C] px-6 py-5">
              <div className="flex items-start gap-4">
                <div className={`flex size-11 shrink-0 items-center justify-center rounded-2xl border ${
                  balanceOperation === "credit"
                    ? "border-emerald-300/25 bg-emerald-400/10 text-emerald-200"
                    : "border-red-300/25 bg-red-400/10 text-red-200"
                }`}>
                  {balanceOperation === "credit" ? (
                    <CheckCircle2 className="size-5" />
                  ) : (
                    <XCircle className="size-5" />
                  )}
                </div>
                <div>
                  <p className={`text-9px font-black uppercase tracking-[0.2em] ${
                    balanceOperation === "credit"
                      ? "text-emerald-200/65"
                      : "text-red-200/65"
                  }`}>
                    Ajuste de saldo
                  </p>
                  <h2
                    id={`balance-adjustment-title-${cliente.id}`}
                    className="mt-1 text-xl font-black text-white"
                  >
                    {balanceOperation === "credit"
                      ? "Confirmar acreditación"
                      : "Confirmar débito"}
                  </h2>
                  <p className="mt-1.5 text-sm leading-5 text-white/55">
                    {balanceOperation === "credit"
                      ? "Revisá los datos antes de acreditar saldo en esta cuenta."
                      : "Revisá los datos antes de descontar saldo de esta cuenta."}
                  </p>
                </div>
              </div>
            </div>

            <div className="space-y-4 px-6 py-5">
              <div className={`rounded-2xl border px-5 py-4 text-center ${
                balanceOperation === "credit"
                  ? "border-emerald-300/15 bg-emerald-400/[0.06]"
                  : "border-red-300/15 bg-red-400/[0.06]"
              }`}>
                <p className="text-10px font-bold uppercase tracking-[0.18em] text-white/45">
                  Importe a {balanceOperation === "credit" ? "acreditar" : "debitar"}
                </p>
                <p className="mt-2 text-3xl font-black tracking-tight text-white">
                  {formatPrice(
                    Number(balanceAmount.replace(/\./g, "").replace(",", ".")) || 0,
                  )}
                </p>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-xl border border-white/8 bg-black/25 p-3.5">
                  <p className="text-9px font-bold uppercase tracking-wider text-white/38">Cuenta</p>
                  <p className="mt-1 truncate text-sm font-black text-white/88">{username}</p>
                </div>
                <div className="rounded-xl border border-white/8 bg-black/25 p-3.5 text-right">
                  <p className="text-9px font-bold uppercase tracking-wider text-white/38">Saldo actual</p>
                  <p className="mt-1 text-sm font-black text-beyonix-sky">
                    {formatPrice(cliente.customer_credit_balance ?? 0)}
                  </p>
                </div>
              </div>

              <div className="rounded-xl border border-white/8 bg-black/20 px-4 py-3">
                <p className="text-9px font-bold uppercase tracking-wider text-white/38">Motivo</p>
                <p className="mt-1.5 text-sm leading-5 text-white/72">
                  {balanceDescription.trim() || "Autorización de superadmin sin motivo adicional."}
                </p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 border-t border-[#31506F]/55 bg-black/20 px-6 py-4">
              <button
                type="button"
                disabled={saving}
                onClick={() => setBalanceConfirmationOpen(false)}
                className="inline-flex h-11 cursor-pointer items-center justify-center rounded-xl border border-white/12 bg-white/[0.04] text-sm font-black text-white/70 transition hover:border-white/25 hover:bg-white/[0.08] hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
              >
                Cancelar
              </button>
              <button
                type="button"
                autoFocus
                disabled={saving}
                onClick={() => {
                  setBalanceConfirmationOpen(false)
                  void executeBalanceAdjustment()
                }}
                className={`inline-flex h-11 cursor-pointer items-center justify-center gap-2 rounded-xl border text-sm font-black transition disabled:cursor-not-allowed disabled:opacity-50 ${
                  balanceOperation === "credit"
                    ? "border-emerald-300/35 bg-emerald-400/12 text-emerald-100 hover:border-emerald-200/60 hover:bg-emerald-400/20"
                    : "border-red-300/35 bg-red-400/12 text-red-100 hover:border-red-200/60 hover:bg-red-400/20"
                }`}
              >
                {balanceOperation === "credit" ? (
                  <CheckCircle2 className="size-4" />
                ) : (
                  <XCircle className="size-4" />
                )}
                {saving ? "Procesando..." : "Confirmar"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </details>
  )
}

function BlockedClientsPanel({
  blockedIdentifiers,
  clientes,
  saving,
  onCreate,
  onRemove,
}: {
  blockedIdentifiers: BlockedClientIdentifier[]
  clientes: SupabaseCliente[]
  saving: boolean
  onCreate: (data: {
    lookup_value: string
    reason?: string | null
  }) => Promise<void>
  onRemove: (
    id: number,
    sourceProfileId?: string | null,
    ids?: number[]
  ) => Promise<void>
}) {
  const [value, setValue] = useState("")
  const [reason, setReason] = useState("")
  const blockedRows = useMemo(() => {
    const clientesById = new Map(clientes.map((cliente) => [cliente.id, cliente]))
    const grouped = new Map<
      string,
      {
        id: number
        ids: number[]
        sourceProfileId: string | null
        username: string
        email: string
        phone: string
        address: string
        reason: string
      }
    >()

    for (const identifier of blockedIdentifiers) {
      const matchedCliente =
        (identifier.source_profile_id
          ? clientesById.get(identifier.source_profile_id)
          : null) ??
        clientes.find((cliente) => {
          if (identifier.identifier_type === "username") {
            return (
              cliente.username?.trim().toLowerCase() ===
              identifier.identifier_value.trim().toLowerCase()
            )
          }

          if (identifier.identifier_type === "email") {
            return (
              cliente.email?.trim().toLowerCase() ===
              identifier.identifier_value.trim().toLowerCase()
            )
          }

          return (
            (cliente.telefono ?? "").replace(/\D/g, "") ===
            identifier.identifier_value.replace(/\D/g, "")
          )
        }) ??
        null
      const key = matchedCliente
        ? `profile:${matchedCliente.id}`
        : `manual:${identifier.id}`
      const cliente = matchedCliente
      const current =
        grouped.get(key) ??
        {
          id: identifier.id,
          ids: [],
          sourceProfileId: cliente?.id ?? identifier.source_profile_id,
          username: cliente?.username || "",
          email: cliente?.email || "",
          phone: cliente?.telefono || "",
          address: cliente?.direccion || "",
          reason: identifier.reason || cliente?.blocked_reason || "",
        }

      current.ids.push(identifier.id)

      if (!cliente) {
        if (identifier.identifier_type === "username") {
          current.username = identifier.identifier_value
        }

        if (identifier.identifier_type === "email") {
          current.email = identifier.identifier_value
        }

        if (identifier.identifier_type === "phone") {
          current.phone = identifier.identifier_value
        }
      }

      if (!current.reason && identifier.reason) {
        current.reason = identifier.reason
      }

      grouped.set(key, current)
    }

    return Array.from(grouped.values())
  }, [blockedIdentifiers, clientes])

  const handleCreate = () => {
    void onCreate({
      lookup_value: value,
      reason,
    }).then(() => {
      setValue("")
      setReason("")
    })
  }

  return (
    <details className="rounded-3xl border border-red-400/15 bg-black">
      <summary className="flex cursor-pointer items-center justify-between gap-4 px-4 py-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-white/92">
            <LockKeyhole className="size-4 text-red-200" />
            <h2 className="text-lg font-black">Bloqueos</h2>
          </div>
          <p className="mt-1 text-sm text-white/58">
            Escribí email, usuario o teléfono. Si existe un cliente, se bloquean
            todos sus datos disponibles.
          </p>
        </div>
        <span className="rounded-full border border-red-300/25 bg-red-400/10 px-3 py-1 text-xs font-black text-red-200">
          {blockedRows.length}
        </span>
      </summary>

      <div className="border-t border-white/7 p-4">
        <div className="grid gap-3 xl:grid-cols-admin-blocks">
          <AdminTextInput
            title="Dato a bloquear"
            ariaLabel="Dato a bloquear"
            value={value}
            placeholder="email, usuario o teléfono"
            onChange={setValue}
          />
          <AdminTextInput
            title="Motivo del bloqueo"
            ariaLabel="Motivo del bloqueo"
            value={reason}
            placeholder="Motivo interno"
            onChange={setReason}
          />
          <button
            type="button"
            aria-label="Agregar bloqueo"
            disabled={saving || !value.trim()}
            onClick={handleCreate}
            className="flex h-11 cursor-pointer items-center justify-center gap-2 rounded-18px border border-red-300/35 bg-red-400/10 px-4 text-sm font-black text-red-200 transition hover:border-red-200 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Ban className="size-4" />
            Bloquear
          </button>
        </div>

        <div className="mt-4 space-y-2">
          {blockedRows.length ? (
            <>
              <div className="hidden grid-cols-admin-block-row gap-3 px-4 py-2 md:grid">
                {["Usuario", "Email", "Teléfono", "Dirección", "Motivo", ""].map(
                  (label) => (
                    <span
                      key={label}
                      className="text-10px font-bold uppercase tracking-widest text-white/42"
                    >
                      {label}
                    </span>
                  )
                )}
              </div>
              {blockedRows.map((row) => (
              <div
                key={row.sourceProfileId ?? row.id}
                className="grid gap-3 rounded-2xl border border-white/7 bg-black px-4 py-3 text-sm text-white/70 md:grid-cols-admin-block-row md:items-center"
              >
                <span className="truncate font-bold text-white/86">
                  {row.username || "-"}
                </span>
                <span className="truncate text-white/72">
                  {row.email || "-"}
                </span>
                <span className="truncate text-white/72">
                  {row.phone || "-"}
                </span>
                <span className="truncate text-white/72">
                  {row.address || "-"}
                </span>
                <span className="truncate text-white/52">
                  {row.reason || "Sin motivo"}
                </span>
                <button
                  type="button"
                  aria-label="Quitar bloqueo"
                  disabled={saving}
                  onClick={() => void onRemove(row.id, row.sourceProfileId, row.ids)}
                  className="flex h-9 cursor-pointer items-center justify-center rounded-xl border border-white/10 text-white/62 transition hover:border-emerald-300/35 hover:text-emerald-200 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Trash2 className="size-4" />
                </button>
              </div>
              ))}
            </>
          ) : (
            <div className="rounded-2xl border border-white/7 bg-black px-4 py-3 text-sm text-white/58">
              Todavia no hay identificadores bloqueados.
            </div>
          )}
        </div>
      </div>
    </details>
  )
}
export function AdminClientes({
  initialActiveOnly = false,
}: {
  initialActiveOnly?: boolean
}) {
  const { isSuperAdmin } = useAuth()
  const {
    clientes,
    blockedIdentifiers,
    creditTopups,
    topupSavingId,
    loading,
    saving,
    error,
    updateClientAdminInfo,
    createBlockedIdentifier,
    removeBlockedIdentifier,
    resolveCreditTopup,
    adjustCustomerBalance,
  } = useClientes()
  const [search, setSearch] = useState("")
  const [activeFilter, setActiveFilter] = useState<ActiveFilter>(
    initialActiveOnly ? "activos" : "todos"
  )
  const [purchaseFilter, setPurchaseFilter] = useState<PurchaseFilter>("todos")
  const [riskFilter, setRiskFilter] = useState<RiskFilter>("todos")
  const [minSpent, setMinSpent] = useState("")
  const [minOrders, setMinOrders] = useState("")
  const [registeredFrom, setRegisteredFrom] = useState("")
  const [registeredTo, setRegisteredTo] = useState("")

  const filteredClients = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase()
    const spent = Number(minSpent || 0)
    const orders = Number(minOrders || 0)
    const fromDate = parseDateInput(registeredFrom)
    const toDate = parseDateInput(registeredTo, true)

    return clientes.filter((cliente) => {
      const createdAt = new Date(cliente.created_at)
      const matchesSearch = [
        cliente.nombre,
        cliente.apellido,
        cliente.username,
        cliente.email,
        cliente.telefono,
      ]
        .join(" ")
        .toLowerCase()
        .includes(normalizedSearch)
      const matchesActive =
        activeFilter === "todos" ||
        (activeFilter === "activos" && cliente.is_active) ||
        (activeFilter === "inactivos" && !cliente.is_active)
      const matchesPurchases =
        purchaseFilter === "todos" ||
        (purchaseFilter === "con_compras" && cliente.order_count > 0) ||
        (purchaseFilter === "sin_compras" && cliente.order_count === 0)
      const matchesRisk =
        riskFilter === "todos" ||
        (riskFilter === "bloqueados" && Boolean(cliente.blocked_at)) ||
        (riskFilter !== "bloqueados" &&
          (cliente.client_risk_status ?? "normal") === riskFilter)
      const matchesSpent = cliente.total_spent >= spent
      const matchesOrders = cliente.order_count >= orders
      const matchesDateFrom = !fromDate || createdAt >= fromDate
      const matchesDateTo = !toDate || createdAt <= toDate

      return (
        matchesSearch &&
        matchesActive &&
        matchesPurchases &&
        matchesRisk &&
        matchesSpent &&
        matchesOrders &&
        matchesDateFrom &&
        matchesDateTo
      )
    })
  }, [
    activeFilter,
    clientes,
    minOrders,
    minSpent,
    purchaseFilter,
    riskFilter,
    registeredFrom,
    registeredTo,
    search,
  ])

  const customerAccounts = clientes.filter((cliente) => cliente.rol === "cliente")
  const activeCount = customerAccounts.filter((cliente) => cliente.is_active).length
  const blockedCount = customerAccounts.filter((cliente) => cliente.blocked_at).length
  const clientsWithCart = clientes.filter(
    (cliente) => getCartItemCount(cliente.current_cart) > 0
  )

  return (
    <div className={adminPageClassName}>
      <AdminPageHeader
        eyebrow="Cuentas"
        title="Cuentas registradas"
        description="Clientes y administradores, saldos disponibles, comprobantes de carga, compras y estado operativo."
        actions={
          <div className="grid min-w-0 gap-2 sm:grid-cols-2 xl:grid-cols-4">
            <AdminStatCard
              title="Total clientes"
              value={customerAccounts.length}
              valueClassName="text-center tabular-nums"
              className="min-h-24 min-w-40 p-4 text-center"
            />
            <AdminStatCard
              title="Clientes activos"
              value={activeCount}
              valueClassName="text-center tabular-nums"
              tone="success"
              className="min-h-24 min-w-40 p-4 text-center"
            />
            <AdminStatCard
              title="Bloqueados"
              value={blockedCount}
              valueClassName="text-center tabular-nums"
              tone="danger"
              className="min-h-24 min-w-40 p-4 text-center"
            />
            <AdminStatCard
              title="Comprobantes pendientes"
              value={creditTopups.length}
              valueClassName="text-center tabular-nums"
              tone="success"
              className="min-h-24 min-w-40 border-emerald-300/25 bg-emerald-400/[0.06] p-4 text-center"
            />
          </div>
        }
      />

      <CreditTopupsPanel
        topups={creditTopups}
        savingId={topupSavingId}
        onResolve={resolveCreditTopup}
      />

      <BlockedClientsPanel
        blockedIdentifiers={blockedIdentifiers}
        clientes={clientes}
        saving={saving}
        onCreate={createBlockedIdentifier}
        onRemove={removeBlockedIdentifier}
      />

      <AdminFiltersBar>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4 2xl:grid-cols-admin-client-filters">
          <AdminSearchInput
            title="Buscar cuenta"
            ariaLabel="Buscar cuenta"
            value={search}
            placeholder="Buscar nombre, usuario, email o teléfono"
            onChange={setSearch}
          />

          <AdminSelect
            title="Filtrar actividad"
            value={activeFilter}
            onChange={(value) => setActiveFilter(value as ActiveFilter)}
          >
            <option value="todos">Todos</option>
            <option value="activos">Activos</option>
            <option value="inactivos">Inactivos</option>
          </AdminSelect>

          <AdminSelect
            title="Filtrar compras"
            value={purchaseFilter}
            onChange={(value) => setPurchaseFilter(value as PurchaseFilter)}
          >
            <option value="todos">Todos</option>
            <option value="con_compras">Con compras</option>
            <option value="sin_compras">Sin compras</option>
          </AdminSelect>

          <AdminSelect
            title="Filtrar clasificacion"
            value={riskFilter}
            onChange={(value) => setRiskFilter(value as RiskFilter)}
          >
            <option value="todos">Todas las clasificaciones</option>
            <option value="normal">Normal</option>
            <option value="tedioso">Tedioso</option>
            <option value="complicado">Complicado</option>
            <option value="bloqueados">Bloqueados</option>
          </AdminSelect>

          <input
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            aria-label="Total gastado mínimo"
            value={minSpent}
            placeholder="Gasto mín."
            onChange={(event) => setMinSpent(event.target.value.replace(/\D/g, ""))}
            className="h-11 rounded-18px border border-white/12 bg-black px-4 text-sm font-medium text-white/86 outline-none placeholder:text-white/32 hover:border-beyonix-blue-light/45 focus:border-beyonix-blue-light"
          />

          <input
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            aria-label="Cantidad mínima de pedidos"
            value={minOrders}
            placeholder="Pedidos mín."
            onChange={(event) => setMinOrders(event.target.value.replace(/\D/g, ""))}
            className="h-11 rounded-18px border border-white/12 bg-black px-4 text-sm font-medium text-white/86 outline-none placeholder:text-white/32 hover:border-beyonix-blue-light/45 focus:border-beyonix-blue-light"
          />

          <AdminDatePicker
            title="Fecha de registro desde"
            ariaLabel="Fecha de registro desde"
            value={registeredFrom}
            placeholder="Desde"
            onChange={setRegisteredFrom}
          />

          <AdminDatePicker
            title="Fecha de registro hasta"
            ariaLabel="Fecha de registro hasta"
            value={registeredTo}
            placeholder="Hasta"
            onChange={setRegisteredTo}
          />
        </div>
      </AdminFiltersBar>

      <AdminInfoBlock tone="info">
        {activeCount > 0
          ? `${activeCount} cuenta${activeCount === 1 ? "" : "s"} activa${
              activeCount === 1 ? "" : "s"
            } detectada${activeCount === 1 ? "" : "s"} en los últimos 5 minutos.`
          : "Sin cuentas activas detectadas en los últimos 5 minutos."}
      </AdminInfoBlock>

      {error && (
        <AdminInfoBlock tone="danger">
          {error}
        </AdminInfoBlock>
      )}

      {loading ? (
        <AdminSkeleton rows={6} />
      ) : filteredClients.length ? (
        <div className="space-y-3">
          <div className="hidden grid-cols-admin-clients gap-4 rounded-2xl border border-white/8 bg-black/85 px-4 py-3 lg:grid">
            {["Usuario", "Nombre", "Teléfono", "Saldo / compras", "Estado"].map(
              (label, index) => (
                <span
                  key={label}
                  className={`text-xs font-black uppercase tracking-wider text-white/65 ${
                    index > 1 ? "text-center" : "text-left"
                  }`}
                >
                  {label}
                </span>
              )
            )}
          </div>
          {filteredClients.map((cliente) => (
            <ClientCard
              key={cliente.id}
              cliente={cliente}
              saving={saving}
              onUpdate={updateClientAdminInfo}
              onAdjustBalance={adjustCustomerBalance}
              isSuperAdmin={isSuperAdmin}
            />
          ))}
        </div>
      ) : (
        <AdminEmptyState
          icon={
            initialActiveOnly ? (
              <UserCheck className="size-5" />
            ) : (
              <Users className="size-5" />
            )
          }
          title="No hay clientes para los filtros seleccionados."
          description="Ajustá búsqueda, compras, fechas o mínimos para ampliar resultados."
        />
      )}

      {initialActiveOnly && (
        <div className="rounded-3xl border border-white/8 bg-black p-5">
          <div className="mb-3 flex items-center gap-2 text-white/92">
            <ShoppingBag className="size-4 text-beyonix-sky" />
            <h2 className="text-lg font-black">Carritos actuales</h2>
          </div>
          {clientsWithCart.length ? (
            <div className="space-y-3">
              {clientsWithCart.map((cliente) => (
                <details
                  key={cliente.id}
                  className="rounded-2xl border border-white/7 bg-black px-4 py-3"
                >
                  <summary className="flex cursor-pointer items-center justify-between gap-4 text-sm font-bold text-white/78">
                    <span className="min-w-0 truncate">
                      {cliente.username || cliente.nombre} ·{" "}
                      {getCartItemCount(cliente.current_cart)} item
                      {getCartItemCount(cliente.current_cart) === 1 ? "" : "s"}
                    </span>
                    <ChevronDown className="size-4 shrink-0" />
                  </summary>
                  <div className="mt-3 space-y-2">
                    {(cliente.current_cart as Array<Record<string, unknown>>).map(
                      (item, index) => (
                        <div
                          key={`${cliente.id}-${index}`}
                          className="grid gap-2 rounded-xl border border-white/7 bg-black px-3 py-2 text-xs text-white/62 sm:grid-cols-3"
                        >
                          <span className="truncate font-bold text-white/82">
                            {String(item.name ?? "Producto")}
                          </span>
                          <span>
                            Cantidad: {String(item.quantity ?? "-")}
                          </span>
                          <span className="truncate">
                            Variante: {String(item.variant_name ?? item.color ?? "-")}
                          </span>
                        </div>
                      )
                    )}
                  </div>
                </details>
              ))}
            </div>
          ) : (
            <div className="rounded-2xl border border-white/7 bg-black px-4 py-3 text-sm text-white/58">
              No hay carritos activos guardados en este momento.
            </div>
          )}
        </div>
      )}
    </div>
  )
}
