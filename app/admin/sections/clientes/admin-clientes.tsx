"use client"

import { useMemo, useState } from "react"
import {
  Ban,
  ChevronDown,
  FileText,
  LockKeyhole,
  Save,
  Search,
  ShieldOff,
  ShoppingBag,
  Trash2,
  UserCheck,
  Users,
} from "lucide-react"

import { useClientes } from "@/hooks/use-clientes"
import type {
  BlockedClientIdentifier,
  ClientRiskStatus,
} from "@/lib/clients/client-blocking"
import type { SupabaseCliente } from "@/lib/supabase/types"
import { AdminSelect, AdminTextInput } from "../../components/admin-controls"
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

function ClientCard({
  cliente,
  saving,
  onUpdate,
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
}) {
  const username = cliente.username || cliente.nombre
  const [riskStatus, setRiskStatus] = useState<ClientRiskStatus>(
    cliente.client_risk_status ?? "normal"
  )
  const [adminNote, setAdminNote] = useState(cliente.admin_note ?? "")
  const [blockReason, setBlockReason] = useState(cliente.blocked_reason ?? "")
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

  return (
    <details className="rounded-3xl border border-white/8 bg-black">
      <summary className="grid cursor-pointer gap-4 px-4 py-4 lg:grid-cols-admin-clients lg:items-center">
        <div className="min-w-0">
          <p title={username} className="truncate text-sm font-black uppercase text-white/92">
            {username}
          </p>
          <p title={cliente.email ?? ""} className="mt-1 truncate text-xs text-white/58">
            {cliente.email}
          </p>
        </div>

        <div className="min-w-0">
          <p title={cliente.nombre} className="truncate text-sm font-bold text-white/88">
            {cliente.nombre}
          </p>
          <p title={cliente.apellido ?? ""} className="mt-1 truncate text-xs text-white/55">
            {cliente.apellido || "Apellido no separado"}
          </p>
        </div>

        <p title={cliente.telefono ?? ""} className="truncate text-sm text-white/72">
          {cliente.telefono || "Sin teléfono"}
        </p>

        <p title={cliente.direccion ?? ""} className="truncate text-sm text-white/72">
          {cliente.direccion || "Sin dirección"}
        </p>

        <div>
          <p className="text-sm font-black text-white/92">
            {formatPrice(cliente.total_spent)}
          </p>
          <p className="mt-1 text-xs text-white/58">{cliente.order_count} pedidos</p>
        </div>

        <div className="flex flex-col gap-2">
          <ClientStatus cliente={cliente} />
          <RiskBadge cliente={cliente} />
        </div>
      </summary>

      <div className="border-t border-white/7 px-4 py-4">
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
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
              title={getLastOrderSummary(cliente)}
              className="mt-2 truncate text-sm font-bold text-white/88"
            >
              {getLastOrderSummary(cliente)}
            </p>
          </div>
        </div>

        <div className="mt-4 rounded-2xl border border-white/7 bg-black p-4">
          <p className="text-11px font-bold uppercase tracking-widest text-white/48">
            Envío
          </p>
          <p className="mt-2 text-sm text-white/72">
            {cliente.direccion || "Sin dirección"} · CP {cliente.codigo_postal || "-"} ·{" "}
            {cliente.provincia || "Sin provincia"}
          </p>
          {cliente.referencias && (
            <p title={cliente.referencias} className="mt-2 text-sm text-white/62">
              {cliente.referencias}
            </p>
          )}
        </div>

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
                title="Guardar clasificacion"
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
              title="Nota interna del cliente"
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
              title="Motivo del bloqueo"
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
                  : "Al bloquearlo se guardan email, usuario y telefono para frenar nuevos registros."}
              </p>
              <button
                type="button"
                title={isBlocked ? "Desbloquear cliente" : "Bloquear cliente"}
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
      </div>
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
            Escribi email, usuario o telefono. Si existe un cliente, se bloquean
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
            placeholder="email, usuario o telefono"
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
            title="Agregar bloqueo"
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
                {["Usuario", "Email", "Telefono", "Direccion", "Motivo", ""].map(
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
                  title="Quitar bloqueo"
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
  const {
    clientes,
    blockedIdentifiers,
    loading,
    saving,
    error,
    updateClientAdminInfo,
    createBlockedIdentifier,
    removeBlockedIdentifier,
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

  const activeCount = clientes.filter((cliente) => cliente.is_active).length
  const blockedCount = clientes.filter((cliente) => cliente.blocked_at).length
  const clientsWithCart = clientes.filter(
    (cliente) => getCartItemCount(cliente.current_cart) > 0
  )

  return (
    <div className="space-y-6 p-4 sm:p-6 lg:p-8">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <p className="mb-1 text-11px font-bold uppercase tracking-widest text-beyonix-cyan">
            Clientes
          </p>
          <h1 className="text-3xl font-black text-white/95">
            Clientes registrados
          </h1>
          <p className="mt-2 text-sm text-white/68">
            Base de clientes, compras, datos de envío y estado operativo.
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-2xl border border-white/8 bg-black px-4 py-3">
            <p className="text-11px font-bold uppercase tracking-widest text-white/48">
              Total
            </p>
            <p className="mt-1 text-2xl font-black text-white/92">{clientes.length}</p>
          </div>
          <div className="rounded-2xl border border-white/8 bg-black px-4 py-3">
            <p className="text-11px font-bold uppercase tracking-widest text-white/48">
              Activos
            </p>
            <p className="mt-1 text-2xl font-black text-white/92">{activeCount}</p>
          </div>
          <div className="rounded-2xl border border-white/8 bg-black px-4 py-3">
            <p className="text-11px font-bold uppercase tracking-widest text-white/48">
              Con compras
            </p>
            <p className="mt-1 text-2xl font-black text-white/92">
              {clientes.filter((cliente) => cliente.order_count > 0).length}
            </p>
          </div>
          <div className="rounded-2xl border border-red-400/15 bg-black px-4 py-3">
            <p className="text-11px font-bold uppercase tracking-widest text-white/48">
              Bloqueados
            </p>
            <p className="mt-1 text-2xl font-black text-red-200">{blockedCount}</p>
          </div>
        </div>
      </div>

      <BlockedClientsPanel
        blockedIdentifiers={blockedIdentifiers}
        clientes={clientes}
        saving={saving}
        onCreate={createBlockedIdentifier}
        onRemove={removeBlockedIdentifier}
      />

      <div className="rounded-3xl border border-white/8 bg-transparent p-4">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4 2xl:grid-cols-admin-client-filters">
          <AdminTextInput
            title="Buscar cliente"
            ariaLabel="Buscar cliente"
            value={search}
            placeholder="Buscar nombre, usuario, email o teléfono"
            icon={<Search className="size-4" />}
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
            type="number"
            min="0"
            title="Total gastado mínimo"
            aria-label="Total gastado mínimo"
            value={minSpent}
            placeholder="Gasto mín."
            onChange={(event) => setMinSpent(event.target.value)}
            className="h-11 rounded-18px border border-white/12 bg-black px-4 text-sm font-medium text-white/86 outline-none placeholder:text-white/32 hover:border-beyonix-blue-light/45 focus:border-beyonix-blue-light"
          />

          <input
            type="number"
            min="0"
            title="Cantidad mínima de pedidos"
            aria-label="Cantidad mínima de pedidos"
            value={minOrders}
            placeholder="Pedidos mín."
            onChange={(event) => setMinOrders(event.target.value)}
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
      </div>

      <div className="rounded-2xl border border-beyonix-blue-light/25 bg-beyonix-blue px-4 py-3 text-sm text-beyonix-sky">
        {activeCount > 0
          ? `${activeCount} cliente${activeCount === 1 ? "" : "s"} activo${
              activeCount === 1 ? "" : "s"
            } detectado${activeCount === 1 ? "" : "s"} en los últimos 5 minutos.`
          : "Sin clientes activos detectados en los últimos 5 minutos."}
      </div>

      {error && (
        <div className="rounded-2xl border border-red-400/20 bg-red-400/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      )}

      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 6 }).map((_, index) => (
            <div
              key={index}
              className="h-88px animate-pulse rounded-3xl border border-white/7 bg-white/3"
            />
          ))}
        </div>
      ) : filteredClients.length ? (
        <div className="space-y-3">
          <div className="hidden grid-cols-admin-clients gap-4 rounded-2xl border border-white/8 bg-black/85 px-4 py-3 lg:grid">
            {["Usuario", "Nombre", "Teléfono", "Dirección", "Compras", "Estado"].map(
              (label) => (
                <span
                  key={label}
                  className="text-10px font-bold uppercase tracking-widest text-white/48"
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
            />
          ))}
        </div>
      ) : (
        <div className="rounded-3xl border border-white/8 bg-black px-6 py-12 text-center">
          {initialActiveOnly ? (
            <UserCheck className="mx-auto mb-4 size-11 text-white/24" />
          ) : (
            <Users className="mx-auto mb-4 size-11 text-white/24" />
          )}
          <p className="text-sm font-bold text-white/72">
            No hay clientes para los filtros seleccionados.
          </p>
          <p className="mt-2 text-xs text-white/48">
            Ajustá búsqueda, compras, fechas o mínimos para ampliar resultados.
          </p>
        </div>
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
