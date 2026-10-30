"use client"

import { useState } from "react"
import { Ban, Eye, Infinity as InfinityIcon, ShieldAlert, Unlock } from "lucide-react"

import {
  RESERVATION_ABUSE_EVENT_LABELS,
  RESERVATION_ABUSE_STATUS_LABELS,
  type ReservationAbuseAccount,
  type ReservationAbuseDetail,
  type ReservationAbuseItem,
  type ReservationBlockAction,
  type ReservationIpBlock,
} from "@/lib/admin/reservation-abuse"
import {
  fetchReservationAbuseDetail,
  fetchReservationAbuseOverview,
  setReservationBlock,
  setReservationIpBlock,
} from "@/lib/supabase/queries/reservation-abuse"

import { AdminTextInput } from "../../components/admin-controls"

function formatDate(value?: string | null) {
  if (!value) return "-"
  return new Intl.DateTimeFormat("es-AR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "America/Argentina/Buenos_Aires",
  }).format(new Date(value))
}

function describeItem(item: ReservationAbuseItem) {
  const name = item.productName ?? `Producto #${item.productId}`
  const variant = item.variantName ? ` · ${item.variantName}` : item.conditionedStockId ? " · con descuento" : ""
  return `${item.quantity} × ${name}${variant}`
}

const OUTCOME_LABELS = {
  strike: "Falta",
  purchased: "Pagó",
  forgiven_by_purchase: "Sin falta (compró después)",
} as const

const actionButtonClassName =
  "flex h-8 cursor-pointer items-center justify-center gap-1.5 rounded-xl border border-white/10 px-2.5 text-xs font-bold text-white/70 transition disabled:cursor-not-allowed disabled:opacity-50"

/**
 * Protección de reservas de stock: cuentas con faltas o bloqueos y bloqueos
 * manuales por IP. Carga recién al abrirse (no suma requests a Clientes).
 */
export function ReservationAbusePanel() {
  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [accounts, setAccounts] = useState<ReservationAbuseAccount[]>([])
  const [ipBlocks, setIpBlocks] = useState<ReservationIpBlock[]>([])
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [openUserId, setOpenUserId] = useState<string | null>(null)
  const [details, setDetails] = useState<Record<string, ReservationAbuseDetail>>({})
  const [ipValue, setIpValue] = useState("")
  const [ipReason, setIpReason] = useState("")

  const load = async () => {
    setLoading(true)
    setError("")
    try {
      const overview = await fetchReservationAbuseOverview()
      setAccounts(overview.accounts)
      setIpBlocks(overview.ipBlocks)
      setLoaded(true)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "No se pudo cargar la protección de reservas.")
    } finally {
      setLoading(false)
    }
  }

  const run = async (key: string, action: () => Promise<void>) => {
    if (busyKey) return
    setBusyKey(key)
    setError("")
    try {
      await action()
      setDetails({})
      setOpenUserId(null)
      await load()
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "No se pudo completar la acción.")
    } finally {
      setBusyKey(null)
    }
  }

  const toggleDetail = async (userId: string) => {
    if (openUserId === userId) {
      setOpenUserId(null)
      return
    }
    setOpenUserId(userId)
    if (details[userId]) return
    try {
      const detail = await fetchReservationAbuseDetail(userId)
      setDetails((current) => ({ ...current, [userId]: detail }))
    } catch (detailError) {
      setError(detailError instanceof Error ? detailError.message : "No se pudo cargar el historial.")
    }
  }

  const blockedCount = accounts.filter((account) => account.status !== "active").length
  const accountAction = (account: ReservationAbuseAccount, action: ReservationBlockAction) =>
    void run(`${account.userId}:${action}`, () => setReservationBlock(account.userId, action))

  return (
    <details
      className="rounded-3xl border border-amber-300/15 bg-black"
      onToggle={(event) => {
        if (event.currentTarget.open && !loaded && !loading) void load()
      }}
    >
      <summary className="flex cursor-pointer items-center justify-between gap-4 px-4 py-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-white/92">
            <ShieldAlert className="size-4 text-amber-200" />
            <h2 className="text-lg font-black">Protección de reservas</h2>
          </div>
          <p className="mt-1 text-sm text-white/58">
            Cuentas que reservaron 15+ unidades, vaciaron stock y no compraron. Con 2 faltas no pueden
            reservar por 7 días. No afecta el ingreso ni la navegación.
          </p>
        </div>
        <span className="rounded-full border border-amber-300/25 bg-amber-400/10 px-3 py-1 text-xs font-black text-amber-200">
          {loaded ? blockedCount : "-"}
        </span>
      </summary>

      <div className="space-y-4 border-t border-white/7 p-4">
        {error && <p className="text-sm font-bold text-red-200">{error}</p>}
        {loading && !loaded && <p className="text-sm text-white/58">Cargando…</p>}

        {loaded && (
          <>
            <div className="space-y-2">
              {accounts.length ? (
                accounts.map((account) => (
                  <div key={account.userId} className="rounded-2xl border border-white/7 bg-black px-4 py-3 text-sm text-white/70">
                    <div className="grid gap-2 lg:grid-cols-[minmax(160px,1.2fr)_70px_150px_130px_minmax(150px,1fr)_auto] lg:items-center">
                      <div className="min-w-0">
                        <p className="truncate font-bold text-white/86">{account.name || account.username || "Sin nombre"}</p>
                        <p className="truncate text-xs text-white/52">{account.email || "-"}</p>
                      </div>
                      <span className="text-xs text-white/72">Faltas: <b className="text-white/90">{account.strikes}</b></span>
                      <span className={account.status === "active" ? "text-xs text-emerald-200" : "text-xs font-bold text-amber-200"}>
                        {RESERVATION_ABUSE_STATUS_LABELS[account.status]}
                      </span>
                      <span className="text-xs text-white/60">
                        {account.status === "permanent" ? "Indefinido" : account.blockedUntil ? `Hasta ${formatDate(account.blockedUntil)}` : "-"}
                      </span>
                      <div className="min-w-0 text-xs text-white/52">
                        <p className="truncate">
                          {account.lastEvent
                            ? `${RESERVATION_ABUSE_EVENT_LABELS[account.lastEvent.type]} · ${formatDate(account.lastEvent.createdAt)}`
                            : "Sin eventos"}
                        </p>
                        <p className="truncate">
                          {account.ips.length ? `IP: ${account.ips.join(", ")}` : "Sin IP registrada"}
                          {account.reason ? ` · ${account.reason}` : ""}
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        <button type="button" aria-label="Ver historial" onClick={() => void toggleDetail(account.userId)}
                          className={`${actionButtonClassName} hover:border-beyonix-sky/40 hover:text-beyonix-sky`}>
                          <Eye className="size-3.5" />Ver
                        </button>
                        <button type="button" aria-label="Bloquear 7 días" disabled={Boolean(busyKey) || account.status === "permanent"}
                          onClick={() => accountAction(account, "block_7_days")}
                          className={`${actionButtonClassName} hover:border-amber-300/40 hover:text-amber-200`}>
                          <Ban className="size-3.5" />7 días
                        </button>
                        <button type="button" aria-label="Bloquear permanentemente" disabled={Boolean(busyKey) || account.status === "permanent"}
                          onClick={() => accountAction(account, "block_permanent")}
                          className={`${actionButtonClassName} hover:border-red-300/40 hover:text-red-200`}>
                          <InfinityIcon className="size-3.5" />Permanente
                        </button>
                        <button type="button" aria-label="Desbloquear" disabled={Boolean(busyKey) || (account.status === "active" && account.strikes === 0)}
                          onClick={() => accountAction(account, "unblock")}
                          className={`${actionButtonClassName} hover:border-emerald-300/40 hover:text-emerald-200`}>
                          <Unlock className="size-3.5" />Desbloquear
                        </button>
                      </div>
                    </div>

                    {openUserId === account.userId && (
                      <div className="mt-3 grid gap-3 border-t border-white/7 pt-3 lg:grid-cols-2">
                        {details[account.userId] ? (
                          <>
                            <div className="space-y-2">
                              <p className="text-10px font-bold uppercase tracking-widest text-white/42">Reservas evaluadas</p>
                              {details[account.userId].reservations.length ? details[account.userId].reservations.map((reservation) => (
                                <div key={reservation.sessionId} className="text-xs leading-5 text-white/62">
                                  <p className="font-bold text-white/80">
                                    {formatDate(reservation.createdAt)} · {reservation.reservedUnits} u. ·{" "}
                                    {reservation.outcome ? OUTCOME_LABELS[reservation.outcome] : "En curso"}
                                    {reservation.orderId ? ` · Pedido #${reservation.orderId}` : ""}
                                  </p>
                                  <p>Vació stock: {reservation.emptiedItems.map(describeItem).join(", ") || "-"}</p>
                                  <p>IP: {reservation.clientIp ?? "Sin IP"}</p>
                                </div>
                              )) : <p className="text-xs text-white/52">Sin reservas grandes registradas.</p>}
                            </div>
                            <div className="space-y-1.5">
                              <p className="text-10px font-bold uppercase tracking-widest text-white/42">Historial</p>
                              {details[account.userId].events.map((event) => (
                                <p key={event.id} className="text-xs text-white/62">
                                  {formatDate(event.createdAt)} · {RESERVATION_ABUSE_EVENT_LABELS[event.type]}
                                  {event.clientIp ? ` · ${event.clientIp}` : ""}
                                </p>
                              ))}
                            </div>
                          </>
                        ) : (
                          <p className="text-xs text-white/52">Cargando historial…</p>
                        )}
                      </div>
                    )}
                  </div>
                ))
              ) : (
                <div className="rounded-2xl border border-white/7 bg-black px-4 py-3 text-sm text-white/58">
                  No hay cuentas con faltas ni bloqueos de reservas.
                </div>
              )}
            </div>

            <div className="rounded-2xl border border-white/7 bg-black p-4">
              <p className="text-10px font-bold uppercase tracking-widest text-white/42">IPs bloqueadas para reservar</p>
              <p className="mt-1 text-xs text-white/52">
                Sólo manual. Una IP puede ser compartida (redes móviles, empresas): usalo con evidencia.
              </p>
              <div className="mt-3 grid gap-3 md:grid-cols-[220px_minmax(200px,1fr)_auto] md:items-end">
                <AdminTextInput title="IP" ariaLabel="IP a bloquear" value={ipValue} placeholder="203.0.113.10" onChange={setIpValue} />
                <AdminTextInput title="Motivo" ariaLabel="Motivo del bloqueo de IP" value={ipReason} placeholder="Motivo interno" onChange={setIpReason} />
                <button
                  type="button"
                  aria-label="Bloquear IP"
                  disabled={Boolean(busyKey) || !ipValue.trim()}
                  onClick={() => void run(`ip:${ipValue}`, async () => {
                    await setReservationIpBlock(ipValue.trim(), true, ipReason)
                    setIpValue("")
                    setIpReason("")
                  })}
                  className="flex h-11 cursor-pointer items-center justify-center gap-2 rounded-18px border border-red-300/35 bg-red-400/10 px-4 text-sm font-black text-red-200 transition hover:border-red-200 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Ban className="size-4" />
                  Bloquear IP
                </button>
              </div>
              <div className="mt-3 space-y-1.5">
                {ipBlocks.length ? ipBlocks.map((block) => (
                  <div key={block.ip} className="flex items-center justify-between gap-3 text-xs text-white/66">
                    <span className="truncate">
                      <b className="text-white/86">{block.ip}</b> · {formatDate(block.blockedAt)}{block.reason ? ` · ${block.reason}` : ""}
                    </span>
                    <button type="button" aria-label={`Desbloquear IP ${block.ip}`} disabled={Boolean(busyKey)}
                      onClick={() => void run(`ip:${block.ip}`, () => setReservationIpBlock(block.ip, false))}
                      className={`${actionButtonClassName} hover:border-emerald-300/40 hover:text-emerald-200`}>
                      <Unlock className="size-3.5" />Desbloquear
                    </button>
                  </div>
                )) : <p className="text-xs text-white/52">No hay IPs bloqueadas.</p>}
              </div>
            </div>
          </>
        )}
      </div>
    </details>
  )
}
