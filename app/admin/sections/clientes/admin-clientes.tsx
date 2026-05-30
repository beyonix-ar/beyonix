"use client"

import { useMemo, useState } from "react"
import { ChevronDown, Search, ShoppingBag, UserCheck, Users } from "lucide-react"

import { useClientes } from "@/hooks/use-clientes"
import type { SupabaseCliente } from "@/lib/supabase/types"
import { AdminSelect, AdminTextInput } from "../../components/admin-controls"
import { AdminDatePicker } from "../../components/admin-date-picker"
import { formatPrice } from "../productos/helpers"



type PurchaseFilter = "todos" | "con_compras" | "sin_compras"
type ActiveFilter = "todos" | "activos" | "inactivos"

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

function ClientCard({ cliente }: { cliente: SupabaseCliente }) {
  const username = cliente.username || cliente.nombre

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

        <ClientStatus cliente={cliente} />
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
      </div>
    </details>
  )
}

export function AdminClientes({
  initialActiveOnly = false,
}: {
  initialActiveOnly?: boolean
}) {
  const { clientes, loading, error } = useClientes()
  const [search, setSearch] = useState("")
  const [activeFilter, setActiveFilter] = useState<ActiveFilter>(
    initialActiveOnly ? "activos" : "todos"
  )
  const [purchaseFilter, setPurchaseFilter] = useState<PurchaseFilter>("todos")
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
      const matchesSpent = cliente.total_spent >= spent
      const matchesOrders = cliente.order_count >= orders
      const matchesDateFrom = !fromDate || createdAt >= fromDate
      const matchesDateTo = !toDate || createdAt <= toDate

      return (
        matchesSearch &&
        matchesActive &&
        matchesPurchases &&
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
    registeredFrom,
    registeredTo,
    search,
  ])

  const activeCount = clientes.filter((cliente) => cliente.is_active).length

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

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
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
        </div>
      </div>

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
            <option value="todos">Compras</option>
            <option value="con_compras">Con compras</option>
            <option value="sin_compras">Sin compras</option>
          </AdminSelect>

          <input
            type="number"
            min="0"
            title="Total gastado mínimo"
            aria-label="Total gastado mínimo"
            value={minSpent}
            placeholder="Gasto mín."
            onChange={(event) => setMinSpent(event.target.value)}
            className="h-11 rounded-[18px] border border-white/12 bg-black px-4 text-sm font-medium text-white/86 outline-none placeholder:text-white/32 hover:border-beyonix-blue-light/45 focus:border-beyonix-blue-light"
          />

          <input
            type="number"
            min="0"
            title="Cantidad mínima de pedidos"
            aria-label="Cantidad mínima de pedidos"
            value={minOrders}
            placeholder="Pedidos mín."
            onChange={(event) => setMinOrders(event.target.value)}
            className="h-11 rounded-[18px] border border-white/12 bg-black px-4 text-sm font-medium text-white/86 outline-none placeholder:text-white/32 hover:border-beyonix-blue-light/45 focus:border-beyonix-blue-light"
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
            <ClientCard key={cliente.id} cliente={cliente} />
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
          <details className="rounded-2xl border border-white/7 bg-black px-4 py-3">
            <summary className="flex cursor-pointer items-center justify-between text-sm font-bold text-white/78">
              Estructura preparada
              <ChevronDown className="size-4" />
            </summary>
            <p className="mt-3 text-sm leading-6 text-white/62">
              Para mostrar carritos actuales con datos reales, el sitio tiene que
              escribir `client_carts` cuando el usuario modifica el carrito.
            </p>
          </details>
        </div>
      )}
    </div>
  )
}
