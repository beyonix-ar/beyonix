"use client"

import { useCallback, useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { AlertTriangle, ExternalLink, FileText, LoaderCircle, RefreshCw } from "lucide-react"

import { supabase } from "@/lib/supabase/client"
import {
  adminPageClassName,
  AdminBadge,
  AdminEmptyState,
  AdminInfoBlock,
  AdminPageHeader,
  AdminPrimaryButton,
  AdminSearchInput,
  AdminSecondaryButton,
  AdminSkeleton,
  AdminTable,
} from "../../components/admin-controls"
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

function getInvoiceStatusTone(status?: PendingInvoiceOrder["invoice_status"]) {
  if (status === "processing") return "info"
  if (status === "error") return "danger"
  return "warning"
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
    <section className={adminPageClassName}>
      <AdminPageHeader
        eyebrow="Facturación"
        title="Facturas pendientes"
        description="Pedidos pagos que necesitan emisión de Factura C."
        actions={
          <div className="w-full min-w-80 sm:w-96">
            <AdminSearchInput
            title="Buscar factura pendiente"
            ariaLabel="Buscar factura pendiente"
            value={search}
            placeholder="Buscar pedido, cliente o error"
            onChange={setSearch}
          />
          </div>
        }
      />

      {notice && (
        <AdminInfoBlock
          role="status"
          tone={notice.type === "ok" ? "success" : "danger"}
          icon={notice.type === "error" ? <AlertTriangle className="size-4" /> : null}
        >
          {notice.message}
        </AdminInfoBlock>
      )}

      <AdminTable>
        <div className="hidden grid-cols-[1fr_1.8fr_1fr_1fr_1fr_1.8fr] gap-3 border-b border-white/8 px-4 py-3 text-11px font-black uppercase tracking-wide text-white/55 xl:grid">
          <span>Pedido</span>
          <span>Cliente</span>
          <span>Total</span>
          <span>Fecha de pago</span>
          <span>Estado</span>
          <span className="text-right">Acción</span>
        </div>

        {loading ? (
          <AdminSkeleton rows={8} className="p-3" />
        ) : filteredOrders.length === 0 ? (
          <AdminEmptyState
            icon={<FileText className="size-5" />}
            title="No hay facturas pendientes para los filtros seleccionados."
            className="rounded-none border-0 bg-transparent shadow-none"
          />
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
                    <AdminBadge tone={getInvoiceStatusTone(order.invoice_status)}>
                      {getInvoiceStatusLabel(order.invoice_status)}
                    </AdminBadge>
                    {errorText && (
                      <p className="mt-1 line-clamp-2 text-xs leading-5 text-red-200/78 xl:hidden">
                        {errorText}
                      </p>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-2 xl:justify-end">
                    <AdminPrimaryButton
                      disabled={actionDisabled}
                      size="sm"
                      onClick={() => void handleIssueInvoice(order)}
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
                    </AdminPrimaryButton>

                    <AdminSecondaryButton
                      size="sm"
                      onClick={() => router.push(`/admin/pedidos/${order.id}?tab=pago`)}
                    >
                      <ExternalLink className="size-4" />
                      Ver pedido
                    </AdminSecondaryButton>
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
      </AdminTable>
    </section>
  )
}
