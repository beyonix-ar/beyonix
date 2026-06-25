"use client"

import { useCallback, useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { AlertTriangle, ExternalLink, FileText, LoaderCircle, RefreshCw, Search } from "lucide-react"

import { supabase } from "@/lib/supabase/client"
import { AdminTextInput } from "../../components/admin-controls"
import { formatPrice } from "../productos/helpers"

interface PendingInvoiceOrder {
  id: number
  cliente_nombre?: string | null
  cliente_email?: string | null
  total: number
  paid_at?: string | null
  created_at: string
  payment_status?: string | null
  invoice_status?: "pending" | "processing" | "authorized" | "error" | null
  invoice_cae?: string | null
  invoice_error?: string | null
}

type Notice = { type: "ok" | "error"; message: string } | null

function formatPublicOrderId(id: number) {
  return `BX-${1000 + id}`
}

function formatDate(value?: string | null) {
  if (!value) return "-"

  return new Intl.DateTimeFormat("es-AR", {
    dateStyle: "short",
    timeZone: "America/Argentina/Buenos_Aires",
  }).format(new Date(value))
}

function getInvoiceStatusLabel(status?: PendingInvoiceOrder["invoice_status"]) {
  if (status === "processing") return "Procesando"
  if (status === "error") return "Error"
  if (status === "pending") return "Pendiente"
  return "Pendiente"
}

function getInvoiceStatusClass(status?: PendingInvoiceOrder["invoice_status"]) {
  if (status === "processing") return "border-blue-300/25 bg-blue-400/10 text-blue-200"
  if (status === "error") return "border-red-300/25 bg-red-400/10 text-red-200"
  return "border-amber-300/25 bg-amber-300/10 text-amber-100"
}

function getInvoiceErrorText(order: PendingInvoiceOrder) {
  if (order.invoice_error?.trim()) return order.invoice_error.trim()
  if (order.invoice_status === "error") return "Error sin detalle registrado."
  return ""
}

export function AdminFacturacion() {
  const router = useRouter()
  const [orders, setOrders] = useState<PendingInvoiceOrder[]>([])
  const [loading, setLoading] = useState(true)
  const [notice, setNotice] = useState<Notice>(null)
  const [search, setSearch] = useState("")
  const [issuingId, setIssuingId] = useState<number | null>(null)

  const loadOrders = useCallback(async ({ silent = false }: { silent?: boolean } = {}) => {
    try {
      if (!silent) setLoading(true)

      const {
        data: { session },
      } = await supabase.auth.getSession()

      if (!session?.access_token) {
        throw new Error("La sesión administrativa venció.")
      }

      const response = await fetch("/api/admin/facturacion", {
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
      })
      const data = (await response.json()) as {
        orders?: PendingInvoiceOrder[]
        error?: string
      }

      if (!response.ok) {
        throw new Error(data.error || "No se pudieron cargar las facturas pendientes.")
      }

      setOrders(data.orders ?? [])
    } catch (error) {
      setNotice({
        type: "error",
        message:
          error instanceof Error
            ? error.message
            : "No se pudieron cargar las facturas pendientes.",
      })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadOrders()
  }, [loadOrders])

  useEffect(() => {
    const channel = supabase
      .channel("admin-facturacion-live")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "ordenes" },
        () => {
          void loadOrders({ silent: true })
        },
      )
      .subscribe()

    return () => {
      void supabase.removeChannel(channel)
    }
  }, [loadOrders])

  const filteredOrders = orders.filter((order) => {
    const normalizedSearch = search.trim().toLowerCase()
    if (!normalizedSearch) return true

    return [
      formatPublicOrderId(order.id),
      String(order.id),
      order.cliente_nombre ?? "",
      order.cliente_email ?? "",
      order.invoice_status ?? "",
      order.invoice_error ?? "",
    ]
      .join(" ")
      .toLowerCase()
      .includes(normalizedSearch)
  })

  const handleIssueInvoice = async (order: PendingInvoiceOrder) => {
    try {
      setIssuingId(order.id)
      setNotice(null)

      const {
        data: { session },
      } = await supabase.auth.getSession()

      if (!session?.access_token) {
        throw new Error("La sesión administrativa venció.")
      }

      const response = await fetch(`/api/admin/orders/${order.id}/invoice`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
      })
      const data = (await response.json()) as { error?: string }

      if (!response.ok) {
        throw new Error(data.error || "No se pudo emitir la factura.")
      }

      setNotice({
        type: "ok",
        message: `Factura emitida para el pedido ${formatPublicOrderId(order.id)}.`,
      })
      await loadOrders({ silent: true })
    } catch (error) {
      setNotice({
        type: "error",
        message:
          error instanceof Error
            ? error.message
            : "No se pudo emitir la factura.",
      })
      await loadOrders({ silent: true })
    } finally {
      setIssuingId(null)
    }
  }

  return (
    <section className="mx-auto w-full max-w-7xl space-y-4 px-4 py-5 sm:px-6 lg:px-8">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <p className="mb-1 text-11px font-bold uppercase tracking-widest text-beyonix-cyan">
            Facturación
          </p>
          <h1 className="text-3xl font-black text-white/95">Facturas pendientes</h1>
          <p className="mt-2 text-sm text-white/68">
            Pedidos pagos que necesitan emisión de Factura C.
          </p>
        </div>

        <div className="w-full max-w-md">
          <AdminTextInput
            title="Buscar factura pendiente"
            ariaLabel="Buscar factura pendiente"
            value={search}
            placeholder="Buscar pedido, cliente o error"
            icon={<Search className="size-4" />}
            onChange={setSearch}
          />
        </div>
      </div>

      {notice && (
        <div
          role="status"
          className={`flex items-center gap-3 rounded-2xl border px-4 py-3 text-sm ${
            notice.type === "ok"
              ? "border-emerald-400/20 bg-emerald-400/10 text-emerald-200"
              : "border-red-400/20 bg-red-400/10 text-red-200"
          }`}
        >
          {notice.type === "error" && <AlertTriangle className="size-4 shrink-0" />}
          {notice.message}
        </div>
      )}

      <div className="overflow-hidden rounded-2xl border border-white/8 bg-black">
        <div className="hidden grid-cols-[1fr_1.8fr_1fr_1fr_1fr_1.8fr] gap-3 border-b border-white/8 px-4 py-3 text-11px font-black uppercase tracking-wide text-white/55 xl:grid">
          <span>Pedido</span>
          <span>Cliente</span>
          <span>Total</span>
          <span>Fecha de pago</span>
          <span>Estado</span>
          <span className="text-right">Acción</span>
        </div>

        {loading ? (
          <div className="divide-y divide-white/8">
            {Array.from({ length: 8 }).map((_, index) => (
              <div key={index} className="h-14 animate-pulse bg-white/4" />
            ))}
          </div>
        ) : filteredOrders.length === 0 ? (
          <div className="px-5 py-12 text-center">
            <FileText className="mx-auto mb-4 size-10 text-white/24" />
            <p className="text-sm font-bold text-white/72">
              No hay facturas pendientes para los filtros seleccionados.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-white/8">
            {filteredOrders.map((order) => {
              const isIssuing = issuingId === order.id
              const canRetry = order.invoice_status === "error"
              const isProcessing = order.invoice_status === "processing"
              const actionDisabled = isIssuing || isProcessing
              const errorText = getInvoiceErrorText(order)

              return (
                <div
                  key={order.id}
                  className="grid gap-2 px-4 py-3 text-sm text-white/78 transition-colors hover:bg-white/3 xl:grid-cols-[1fr_1.8fr_1fr_1fr_1fr_1.8fr] xl:items-center"
                >
                  <div>
                    <p className="text-11px font-bold uppercase text-white/42 xl:hidden">Pedido</p>
                    <p className="font-black text-white">{formatPublicOrderId(order.id)}</p>
                  </div>

                  <div className="min-w-0">
                    <p className="text-11px font-bold uppercase text-white/42 xl:hidden">Cliente</p>
                    <p className="truncate font-semibold text-white">
                      {order.cliente_nombre || "Sin nombre"}
                    </p>
                    <p className="truncate text-xs text-white/45">
                      {order.cliente_email || "Sin email"}
                    </p>
                  </div>

                  <div>
                    <p className="text-11px font-bold uppercase text-white/42 xl:hidden">Total</p>
                    <p className="font-black text-white">{formatPrice(Number(order.total ?? 0))}</p>
                  </div>

                  <div>
                    <p className="text-11px font-bold uppercase text-white/42 xl:hidden">
                      Fecha de pago
                    </p>
                    <p>{formatDate(order.paid_at || order.created_at)}</p>
                  </div>

                  <div>
                    <p className="text-11px font-bold uppercase text-white/42 xl:hidden">Estado</p>
                    <span
                      className={`inline-flex rounded-full border px-2.5 py-1 text-10px font-black uppercase tracking-wide ${getInvoiceStatusClass(order.invoice_status)}`}
                    >
                      {getInvoiceStatusLabel(order.invoice_status)}
                    </span>
                    {errorText && (
                      <p className="mt-1 line-clamp-2 text-xs leading-5 text-red-200/78 xl:hidden">
                        {errorText}
                      </p>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-2 xl:justify-end">
                    <button
                      type="button"
                      disabled={actionDisabled}
                      onClick={() => void handleIssueInvoice(order)}
                      className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-lg border border-beyonix-blue-light/30 bg-[#112A43] px-3 text-xs font-black text-white transition-all hover:border-[#1e6fae] hover:shadow-[0_0_0_1px_rgba(30,111,174,0.35)] disabled:cursor-not-allowed disabled:opacity-55"
                    >
                      {isIssuing || isProcessing ? (
                        <LoaderCircle className="size-4 animate-spin" />
                      ) : canRetry ? (
                        <RefreshCw className="size-4" />
                      ) : (
                        <FileText className="size-4" />
                      )}
                      {isIssuing || isProcessing
                        ? "Procesando..."
                        : canRetry
                          ? "Reintentar emisión"
                          : "Emitir factura"}
                    </button>

                    <button
                      type="button"
                      onClick={() => router.push(`/admin/pedidos/${order.id}?tab=pago`)}
                      className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-lg border border-white/10 px-3 text-xs font-black text-white/72 transition-all hover:border-[#1e6fae] hover:text-white hover:shadow-[0_0_0_1px_rgba(30,111,174,0.35)]"
                    >
                      <ExternalLink className="size-4" />
                      Ver pedido
                    </button>
                  </div>

                  {errorText && (
                    <div className="min-w-0 rounded-lg border border-red-300/12 bg-red-400/5 px-3 py-2 text-xs leading-5 text-red-100/80 xl:col-span-6">
                      <span className="font-black text-red-100">Último error ARCA: </span>
                      {errorText}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </section>
  )
}
