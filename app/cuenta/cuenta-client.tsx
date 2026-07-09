"use client"
// @refresh reset

import { useEffect, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import {
  AlertTriangle,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  CheckCircle2,
  CreditCard,
  Download,
  DollarSign,
  Eye,
  FileText,
  Heart,
  Loader2,
  Lock,
  LogOut,
  Mail,
  Shield,
  ShoppingBag,
  Truck,
  RefreshCcw,
  User,
  X,
} from "lucide-react"

import { useAuth } from "@/context/auth-context"
import { LoginForm, RegisterForm } from "@/components/account/auth-forms"
import { MisOrdenes } from "@/components/account/account-orders"
import { MisDatos, Seguridad } from "@/components/account/profile-sections"
import {
  OrderProductFeedback,
  OrderProgressTimeline,
  PaymentProofViewButton,
} from "@/components/account/account-order-components"
import { PaymentProofActionButton } from "@/components/payment-proof-uploader"
import { CustomerClaimExperience } from "@/components/claims/customer-claim-experience"
import { supabase } from "@/lib/supabase/client"
import type { SupabasePedido } from "@/lib/supabase/types"
import {
  formatCuentaInvoiceNumber,
  formatCuentaPrice,
  formatOrderCardDate,
  formatPublicOrderId,
} from "@/lib/account/account-formatters"
import {
  getClientOrderStatusBadge,
  getCuentaItemColor,
  getCuentaItemImage,
  isInvoiceAvailable,
  normalizeTrackingUrl,
} from "@/lib/account/account-utils"
import { beyonixHoverBorder, cn } from "@/lib/utils"

type ProfileView = "home" | "ordenes" | "datos" | "seguridad"

function isOrderDetailDispatched(order: SupabasePedido) {
  const status = (order.estado ?? "").toLowerCase()
  const andreaniStatus = (order.andreani_estado ?? "").toLowerCase()

  return (
    ["enviado", "en_camino", "entregado"].includes(status) ||
    Boolean(order.tracking_number || order.andreani_tracking || order.andreani_envio_id) ||
    ["camino", "tránsito", "transito", "distribución", "distribucion", "reparto", "visita", "entregado"].some((value) =>
      andreaniStatus.includes(value),
    )
  )
}

function isOrderDetailDelivered(order: SupabasePedido) {
  const status = (order.estado ?? "").toLowerCase()
  return status === "entregado" || Boolean(order.delivered_at)
}

function isOrderDetailInvoiced(order: SupabasePedido) {
  return (
    order.invoice_status === "authorized" ||
    order.invoice_status === "processing" ||
    Boolean(order.invoice_cae) ||
    Boolean(order.invoice_number && order.invoice_point)
  )
}

function ProfilePanel({ initialView }: { initialView: ProfileView }) {
  const { user, logout, isInternal } = useAuth()
  const router = useRouter()
  const [view, setView] = useState<ProfileView>(initialView)

  useEffect(() => {
    setView(initialView)
  }, [initialView])

  if (!user) return null

  const goToView = (nextView: ProfileView) => {
    setView(nextView)

    router.replace(
      nextView === "home"
        ? "/cuenta"
        : `/cuenta?tab=${nextView}`,
      { scroll: false }
    )
  }

  if (view === "ordenes") return <MisOrdenes onBack={() => goToView("home")} />
  if (view === "datos") return <MisDatos onBack={() => goToView("home")} />
  if (view === "seguridad") return <Seguridad onBack={() => goToView("home")} />

  const menuItems: Array<{
    icon: typeof ShoppingBag
    label: string
    sub: string
    view?: ProfileView
    href?: string
  }> = [
    { icon: ShoppingBag, label: "Mis compras", sub: "Historial de compras", view: "ordenes" as ProfileView },
    { icon: Heart, label: "Favoritos", sub: "Productos guardados", href: "/cuenta/favoritos" },
    { icon: User, label: "Mis datos", sub: "Nombre, email y dirección", view: "datos" as ProfileView },
    { icon: Lock, label: "Seguridad", sub: "Contraseña y acceso", view: "seguridad" as ProfileView },
  ]

  return (
    <div className="mx-auto max-w-md space-y-6">
      <div className="flex items-center gap-4 p-5 rounded-2xl border border-white/7 bg-white/2">
        <div className="flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-full border border-white/12 bg-white text-black">
          {user.avatarUrl ? (
            <img src={user.avatarUrl} alt="" className="size-full object-cover" />
          ) : (
            <User className="size-8" />
          )}
        </div>
        <div className="min-w-0">
          <p className="font-semibold text-white truncate">{user.name}</p>
          <p className="text-sm text-white/55 truncate">{user.email}</p>
          <p className="mt-1 text-11px text-beyonix-cyan font-medium">Cliente BEYONIX</p>
        </div>
      </div>

      <div className="space-y-2">
        {menuItems.map((item) => (
          <button
            key={item.label}
            type="button"
            aria-label={item.label}
            title={item.label}
            onClick={() => {
              if (item.href) {
                router.push(item.href)
                return
              }

              if (item.view) {
                goToView(item.view)
              }
            }}
            className={cn(
              "w-full flex items-center gap-4 p-4 rounded-xl bg-white/2 hover:bg-white/4 group cursor-pointer text-left",
              beyonixHoverBorder
            )}
          >
            <div className="size-9 rounded-lg bg-beyonix-blue/50 border border-beyonix-blue-light/30 flex items-center justify-center shrink-0">
              <item.icon className="size-4 text-beyonix-cyan" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-white">{item.label}</p>
              <p className="text-xs text-white/50">{item.sub}</p>
            </div>
            <ChevronRight className="size-4 text-white/25 group-hover:text-white/60 transition-colors shrink-0" />
          </button>
        ))}
      </div>

      {isInternal && (
        <button
          type="button"
          aria-label="Ir al panel admin"
          title="Ir al panel admin"
          onClick={() => router.push("/admin")}
          className={cn(
            "w-full flex items-center gap-4 p-4 rounded-xl bg-beyonix-account hover:bg-beyonix-blue group cursor-pointer text-left",
            beyonixHoverBorder
          )}
        >
          <div className="size-9 rounded-lg bg-beyonix-blue/60 border border-beyonix-blue-light/40 flex items-center justify-center shrink-0">
            <Shield className="size-4 text-beyonix-cyan" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-white">Panel administrador</p>
            <p className="text-xs text-white/55">Gestión de tienda</p>
          </div>
          <ChevronRight className="size-4 text-white/25 group-hover:text-white/70 transition-colors shrink-0" />
        </button>
      )}

      <button
        type="button"
        aria-label="Cerrar sesión"
        title="Cerrar sesión"
        onClick={() => { logout(); router.push("/") }}
        className="w-full flex items-center justify-center gap-2 h-11 rounded-xl border border-white/8 text-sm font-medium text-white/60 hover:text-white hover:border-white/20 transition-all cursor-pointer"
      >
        <LogOut className="size-4" />
        Cerrar sesión
      </button>
    </div>
  )
}

export function CompraDetalleClient({ orderId }: { orderId: number }) {
  const { user, isLoading } = useAuth()
  const router = useRouter()
  const searchParams = useSearchParams()
  const [order, setOrder] = useState<SupabasePedido | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [downloadingInvoice, setDownloadingInvoice] = useState(false)
  const [downloadingCreditNote, setDownloadingCreditNote] = useState(false)
  const [cancelModalOpen, setCancelModalOpen] = useState(false)
  const [cancellingOrder, setCancellingOrder] = useState(false)
  const [cancelError, setCancelError] = useState("")
  const [refundProofOpening, setRefundProofOpening] = useState(false)
  const [refundProofError, setRefundProofError] = useState("")

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "auto" })
  }, [orderId])

  useEffect(() => {
    if (searchParams.get("section") !== "reclamo") return
    router.replace(`/cuenta/compras/${orderId}`)
  }, [orderId, router, searchParams])

  useEffect(() => {
    if (isLoading) return
    if (!user) {
      router.replace(`/login?redirect=/cuenta/compras/${orderId}`)
      return
    }

    const currentUser = user
    let active = true

    async function loadOrder() {
      setLoading(true)
      setError("")
      const { data, error: orderError } = await supabase
        .from("ordenes")
        .select("*, orden_items(*, productos(*), producto_variantes(*))")
        .eq("id", orderId)
        .maybeSingle()

      if (!active) return

      if (orderError || !data) {
        setError("No encontramos esta compra.")
        setLoading(false)
        return
      }

      const currentOrder = data as SupabasePedido
      const userValues = [currentUser.id, currentUser.email]
        .filter(Boolean)
        .map((value) => String(value).trim().toLowerCase())
      const orderValues = [currentOrder.usuario_id, currentOrder.cliente_email]
        .filter(Boolean)
        .map((value) => String(value).trim().toLowerCase())

      if (!orderValues.some((value) => userValues.includes(value))) {
        setError("No tenés acceso a esta compra.")
        setLoading(false)
        return
      }

      setOrder(currentOrder)
      setLoading(false)
    }

    void loadOrder()
    return () => { active = false }
  }, [isLoading, orderId, router, user])

  const handleProofUploaded = (updatedOrder: SupabasePedido) => {
    setOrder((current) => current ? { ...current, ...updatedOrder, orden_items: current.orden_items } : current)
  }

  const handleDownloadInvoice = async (documentType: "invoice" | "credit_note" = "invoice") => {
    if (!order) return
    const isCreditNote = documentType === "credit_note"
    if (isCreditNote) {
      setDownloadingCreditNote(true)
    } else {
      setDownloadingInvoice(true)
    }
    setError("")
    try {
      const response = await fetch(
        `/api/orders/${order.id}/invoice${isCreditNote ? "?type=credit_note" : ""}`,
      )
      if (!response.ok) {
        const data = (await response.json()) as { error?: string }
        throw new Error(data.error || `No se pudo descargar ${isCreditNote ? "la nota de crédito" : "la factura"}.`)
      }
      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement("a")
      anchor.href = url
      anchor.download = isCreditNote ? "Nota-Credito-BEYONIX.pdf" : "Factura-BEYONIX.pdf"
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      URL.revokeObjectURL(url)
    } catch (downloadError) {
      setError(
        downloadError instanceof Error
          ? downloadError.message
          : `No se pudo descargar ${isCreditNote ? "la nota de crédito" : "la factura"}.`,
      )
    } finally {
      if (isCreditNote) {
        setDownloadingCreditNote(false)
      } else {
        setDownloadingInvoice(false)
      }
    }
  }

  const handleCancelOrder = async () => {
    if (!order || cancellingOrder) return

    setCancellingOrder(true)
    setCancelError("")
    try {
      const response = await fetch(`/api/orders/${order.id}/cancel`, {
        method: "POST",
      })
      const data = (await response.json()) as { order?: SupabasePedido; error?: string }

      if (!response.ok || !data.order) {
        setCancelError(data.error || "No se pudo cancelar la compra.")
        return
      }

      setOrder((current) =>
        current
          ? { ...current, ...data.order, orden_items: current.orden_items }
          : data.order ?? current,
      )
      setCancelModalOpen(false)
    } catch {
      setCancelError("No se pudo cancelar la compra. Intentá nuevamente.")
    } finally {
      setCancellingOrder(false)
    }
  }

  const handleOpenRefundProof = async () => {
    if (!order || refundProofOpening) return

    setRefundProofOpening(true)
    setRefundProofError("")

    try {
      const response = await fetch(`/api/orders/${order.id}/refund-proof`)
      const data = (await response.json()) as {
        signedUrl?: string | null
        error?: string
      }

      if (!response.ok || !data.signedUrl) {
        throw new Error(data.error || "No se pudo abrir el comprobante de reintegro.")
      }

      const anchor = document.createElement("a")
      anchor.href = data.signedUrl
      anchor.target = "_blank"
      anchor.rel = "noreferrer"
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
    } catch (proofError) {
      setRefundProofError(
        proofError instanceof Error
          ? proofError.message
          : "No se pudo abrir el comprobante de reintegro.",
      )
    } finally {
      setRefundProofOpening(false)
    }
  }

  if (isLoading || loading) {
    return <main className="flex min-h-screen items-center justify-center bg-[#05070A] pt-20"><div className="size-9 animate-spin rounded-full border-2 border-white/10 border-t-blue-300" /></main>
  }

  if (!order) {
    return <main className="min-h-screen bg-[#05070A] px-4 pt-28"><div className="mx-auto max-w-3xl rounded-2xl border border-white/10 bg-[#0D1117] p-6 text-center"><p className="text-sm font-bold text-white">{error || "No encontramos esta compra."}</p><button type="button" onClick={() => router.push("/cuenta?tab=ordenes")} className="mt-4 h-10 rounded-lg bg-[#112A43] px-4 text-xs font-black text-white">Volver a Mis compras</button></div></main>
  }

  const items = order.orden_items ?? []
  const productsSubtotal = items.reduce(
    (sum, item) => sum + Number(item.precio ?? 0) * Number(item.cantidad ?? 0),
    0,
  )
  const discount = Number(order.transfer_discount_amount ?? 0)
  const shipping = Number(
    order.shipping_cost_charged ?? Math.max(0, Number(order.total) + discount - productsSubtotal),
  )
  const invoiceAvailable = isInvoiceAvailable(order)
  const hasProof = Boolean(order.payment_proof_url)
  const status = getClientOrderStatusBadge(order)
  const isCancelled = (order.estado ?? "").toLowerCase() === "cancelado"
  const trackingNumber = order.andreani_tracking || order.tracking_number || ""
  const trackingUrl = normalizeTrackingUrl(order.tracking_url)
  const canCancelOrder =
    !isCancelled &&
    !isOrderDetailDelivered(order) &&
    !isOrderDetailDispatched(order)

  if (isCancelled) {
    const productCount = items.reduce(
      (total, item) => total + Number(item.cantidad ?? 0),
      0,
    )
    const financialStatus = order.financial_status ?? ""
    const refundPending = ["cancellation_requested", "refund_pending"].includes(financialStatus)
    const refunded = order.financial_status === "refunded"
    const refundFlow = refundPending || refunded
    const cancellationDate = order.cancellation_requested_at || order.cancelled_at
    const paidAmount = Number(order.payment_confirmed_amount ?? order.refund_amount ?? order.total ?? 0)
    const invoiceIssued = isOrderDetailInvoiced(order)
    const orderDispatched = isOrderDetailDispatched(order)
    const creditNoteAvailable =
      invoiceIssued &&
      order.credit_note_status === "authorized" &&
      Boolean(order.credit_note_number && order.credit_note_point && order.credit_note_cae)
    const refundProofAvailable = Boolean(order.refund_proof_url)
    const shippingChargeDetail = orderDispatched
      ? "El pedido ya fue despachado. Podés cancelar la compra, pero el costo del envío queda a tu cargo."
      : "El envío no figura despachado para esta cancelación."
    const refundStatusLabel = refunded
      ? "Cancelado · dinero reintegrado"
      : refundPending
        ? "Reintegro pendiente"
        : "Pedido cancelado"
    const headerRefundStatusClassName = refunded
      ? "border-emerald-300/30 bg-[#123329] text-emerald-50"
      : refundPending
        ? "border-amber-300/35 bg-amber-400/12 text-amber-100"
        : "border-[#3b4656] bg-[#252B33] text-zinc-100"
    return (
      <main className="relative isolate min-h-screen overflow-hidden bg-[#070B11] px-3 pb-8 pt-24 font-heading sm:px-5 lg:px-8">
        <div className="relative z-20 mx-auto max-w-[1320px]">
          <button
            type="button"
            onClick={() => router.push("/cuenta?tab=ordenes")}
            className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-lg border border-[#2a4b6c] bg-[#132033] px-3.5 text-xs font-medium text-white/84 shadow-sm shadow-black/20 transition-colors hover:border-[#4b78a4] hover:bg-[#1a2c44] hover:text-white"
          >
            <ChevronLeft className="size-4" />
            Volver a Mis compras
          </button>

          <section
            className="relative isolate z-30 mt-3 overflow-hidden rounded-2xl border border-[#223249] !bg-[#101114] bg-none p-3 shadow-[0_18px_44px_#000000] sm:p-4"
            style={{ backgroundColor: "#101114", backgroundImage: "none" }}
          >
            <div className="relative z-20 flex flex-col gap-3 rounded-xl border border-[#2a4c72] bg-[#132238] px-3.5 py-3 shadow-[0_12px_30px_rgba(0,0,0,0.28)] sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-10px font-medium uppercase tracking-[0.18em] text-blue-300">
                  Detalle de compra
                </p>
                <h1 className="mt-0.5 text-lg font-bold text-white sm:text-xl">
                  Pedido #{formatPublicOrderId(order.id)}
                </h1>
                <p className="mt-1 text-xs font-normal text-white/62">
                  {formatOrderCardDate(order.created_at)}
                </p>
              </div>
              <span className={`inline-flex w-fit items-center rounded-full border px-3 py-0.5 text-xs font-medium ${headerRefundStatusClassName}`}>
                {refundStatusLabel}
              </span>
            </div>

            <div className="relative z-20 mt-3 grid items-start gap-3 lg:grid-cols-[minmax(0,0.72fr)_minmax(260px,0.28fr)]">
              <div className="space-y-3">
                <section className={`rounded-xl border px-3.5 py-3 shadow-[0_14px_34px_rgba(0,0,0,0.18)] sm:px-4 ${
                  refunded
                    ? "border-emerald-300/30 bg-[#102A22]"
                    : refundPending
                      ? "border-[#6a3340] bg-[#181216]"
                      : "border-zinc-300/26 bg-[#191C22]"
                }`}>
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
                    <span className={`flex size-10 shrink-0 items-center justify-center rounded-full border ${
                      refunded
                        ? "border-emerald-200/35 bg-[#123329]"
                        : refundPending
                          ? "border-[#8a4a58] bg-[#2a171d]"
                          : "border-zinc-200/22 bg-[#252B33]"
                    }`}>
                      {refunded ? (
                        <CheckCircle2 className="size-5 text-emerald-200" />
                      ) : (
                        <X className={`size-5 ${refundPending ? "text-[#f0a8b7]" : "text-zinc-100"}`} />
                      )}
                    </span>
                    <div className="min-w-0">
                      <h2 className="text-base font-bold leading-tight text-white sm:text-lg">
                        {refunded
                          ? "¡Reintegro realizado con éxito!"
                          : refundPending
                            ? "Lamentamos que hayas cancelado tu compra."
                            : "Tu compra fue cancelada correctamente."}
                      </h2>
                      <p className="mt-1.5 max-w-3xl text-sm font-normal leading-5 text-white/78">
                        {refunded
                          ? "El dinero de tu compra ya fue reintegrado. Esperamos verte pronto para una nueva compra."
                          : refundPending
                            ? "Estamos revisando tu situación. Te devolveremos tu dinero una vez validado todo el proceso."
                            : "El pedido quedó cancelado y no requiere acciones adicionales."}
                      </p>
                    </div>
                  </div>
                </section>

                {refundFlow && (
                  <section className="rounded-xl border border-[#28435e] bg-[#0f1824] p-3.5 shadow-[0_14px_36px_rgba(0,0,0,0.34)] sm:p-4">
                    <div>
                      <p className="text-10px font-medium uppercase tracking-[0.18em] text-[#9fd8ff]">
                        Reintegro
                      </p>
                      <h2 className="mt-0.5 text-base font-bold text-white">
                        Estado del reintegro
                      </h2>
                    </div>

                    <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                      <div className="flex items-center gap-2.5 rounded-lg border border-[#335274] bg-[#162235] px-3 py-2.5">
                        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-[#6f4b55]/70 bg-[#24171d]">
                          <RefreshCcw className="size-3.5 text-[#e9b8c1]" />
                        </span>
                        <div className="min-w-0">
                          <p className="text-10px font-medium uppercase tracking-widest text-[#9fb3c9]">
                            Estado actual
                          </p>
                          <p className="mt-0.5 truncate text-sm font-medium text-white">
                            {refundStatusLabel}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2.5 rounded-lg border border-emerald-300/22 bg-[#122A24] px-3 py-2.5">
                        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-emerald-300/24 bg-emerald-400/10">
                          <DollarSign className="size-3.5 text-emerald-200" />
                        </span>
                        <div className="min-w-0">
                          <p className="text-10px font-medium uppercase tracking-widest text-emerald-100">
                            Monto abonado
                          </p>
                          <p className="mt-0.5 truncate text-sm font-medium text-white">
                            {formatCuentaPrice(paidAmount)}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2.5 rounded-lg border border-[#335274] bg-[#162235] px-3 py-2.5">
                        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-[#3d5875] bg-[#13263a]">
                          <CalendarDays className="size-3.5 text-[#b8d7f4]" />
                        </span>
                        <div className="min-w-0">
                          <p className="text-10px font-medium uppercase tracking-widest text-[#9fb3c9]">
                            Fecha de solicitud
                          </p>
                          <p className="mt-0.5 truncate text-sm font-normal text-white">
                            {cancellationDate ? formatOrderCardDate(cancellationDate) : "Recibida"}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2.5 rounded-lg border border-[#335274] bg-[#142232] px-3 py-2.5">
                        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-[#3d5875] bg-[#13263a]">
                          <FileText className="size-3.5 text-[#b8d7f4]" />
                        </span>
                        <div className="min-w-0">
                          <p className="text-10px font-medium uppercase tracking-widest text-[#9fb3c9]">
                            Documentación
                          </p>
                          <div className="mt-0.5 flex min-h-8 items-center gap-2">
                            {!refundProofAvailable && !creditNoteAvailable && (
                              <span className="text-sm font-normal text-[#9fb3c9]">Pendiente</span>
                            )}
                            {refundProofAvailable && (
                              <button
                                type="button"
                                title="Ver comprobante de reintegro"
                                aria-label="Ver comprobante de reintegro"
                                disabled={refundProofOpening}
                                onClick={() => void handleOpenRefundProof()}
                                className={cn(beyonixHoverBorder, "inline-flex size-8 cursor-pointer items-center justify-center rounded-lg border-beyonix-blue-light/25 bg-[#112A43] text-white transition disabled:cursor-wait disabled:opacity-60")}
                              >
                                <Eye className="size-3.5" />
                              </button>
                            )}
                            {creditNoteAvailable && (
                              <button
                                type="button"
                                title="Descargar nota de crédito"
                                aria-label="Descargar nota de crédito"
                                disabled={downloadingCreditNote}
                                onClick={() => void handleDownloadInvoice("credit_note")}
                                className={cn(beyonixHoverBorder, "inline-flex size-8 cursor-pointer items-center justify-center rounded-lg border-beyonix-blue-light/25 bg-[#112A43] text-white transition disabled:cursor-wait disabled:opacity-60")}
                              >
                                <Download className="size-3.5" />
                              </button>
                            )}
                          </div>
                          {refundProofError && (
                            <p className="mt-1.5 text-xs font-normal text-red-200">
                              {refundProofError}
                            </p>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="mt-5 rounded-lg border border-[#2a4b6c] bg-[#111b28] px-3 py-2.5">
                      <h3 className="text-10px font-bold uppercase tracking-[0.16em] text-[#9fd8ff]">
                        ¿Cómo es el proceso de reintegro?
                      </h3>
                      <div className="mt-2.5 space-y-2">
                        <div className="flex gap-2.5">
                          <span className="flex size-8 shrink-0 items-center justify-center rounded-full border border-[#3d658c] bg-[#132843]">
                            <CreditCard className="size-4 text-blue-200" />
                          </span>
                          <div className="min-w-0 border-b border-white/7 pb-2">
                            <p className="text-sm font-medium leading-5 text-white">
                              Si la factura aún no fue emitida
                            </p>
                            <p className="mt-0.5 text-xs font-normal leading-5 text-white/66">
                              Se realizará la devolución del dinero al mismo medio de pago.
                            </p>
                          </div>
                        </div>
                        <div className="flex gap-2.5">
                          <span className="flex size-8 shrink-0 items-center justify-center rounded-full border border-[#3d658c] bg-[#132843]">
                            <FileText className="size-4 text-blue-200" />
                          </span>
                          <div className="min-w-0 border-b border-white/7 pb-2">
                            <p className="text-sm font-medium leading-5 text-white">
                              Si la factura ya fue emitida
                            </p>
                            <p className="mt-0.5 text-xs font-normal leading-5 text-white/66">
                              Se emitirá la nota de crédito correspondiente y quedará disponible para visualizar o descargar desde la sección Documentación.
                            </p>
                          </div>
                        </div>
                        <div className="flex gap-2.5">
                          <span className="flex size-8 shrink-0 items-center justify-center rounded-full border border-[#5f3c48] bg-[#24171d]">
                            <Truck className="size-4 text-[#e9b8c1]" />
                          </span>
                          <div className="min-w-0">
                            <p className="text-sm font-medium leading-5 text-white">
                              Si el envío ya fue despachado
                            </p>
                            <p className="mt-0.5 text-xs font-normal leading-5 text-white/66">
                              Podrás cancelar la compra, pero el costo del envío quedará a tu cargo.
                            </p>
                          </div>
                        </div>
                      </div>
                      <div className="mt-2.5 flex items-center gap-2 rounded-lg border border-cyan-300/35 bg-cyan-400/10 px-3 py-2">
                        <Mail className="size-4 shrink-0 text-cyan-200" />
                        <p className="text-xs font-normal leading-5 text-cyan-50/88">
                          Te notificaremos por email y desde tu cuenta sobre cualquier actualización del reintegro.
                        </p>
                      </div>
                    </div>

                    {order.refund_observation && (
                      <p className="mt-3 rounded-lg border border-emerald-300/18 bg-[#102A22] px-3 py-2 text-xs font-normal leading-5 text-emerald-50/82">
                        {order.refund_observation}
                      </p>
                    )}

                    {orderDispatched && (
                      <div className="mt-3 rounded-lg border border-[#6f4b55]/70 bg-[#21171c] px-3 py-2.5">
                        <div className="flex gap-2.5">
                          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-[#e9b8c1]" />
                          <p className="text-sm font-normal leading-5 text-[#efd8dd]">
                            {shippingChargeDetail}
                          </p>
                        </div>
                      </div>
                    )}
                  </section>
                )}

              </div>

              <section className="rounded-xl border border-[#28435e] bg-[#0f1824] p-3.5 shadow-[0_14px_36px_rgba(0,0,0,0.34)] sm:p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="text-base font-bold text-white">
                    Productos comprados
                  </h2>
                  <span className="text-xs font-medium text-[#9fb3c9]">
                    {productCount} {productCount === 1 ? "producto" : "productos"}
                  </span>
                </div>
                <div className="mt-2.5 space-y-2">
                  {items.map((item) => {
                    const quantity = Number(item.cantidad ?? 0)
                    const unitPrice = Number(item.precio ?? 0)
                    const name = item.productos?.nombre ?? `Producto #${item.producto_id}`
                    const image = getCuentaItemImage(item)
                    const color = getCuentaItemColor(item)

                    return (
                      <div key={item.id} className="flex min-w-0 items-center gap-2.5 rounded-lg border border-[#31506f] bg-[#162438] px-2.5 py-2 transition-all hover:border-[#4b78a4] hover:bg-[#1b2c44]">
                        <div className="flex min-w-0 flex-1 items-center gap-2.5">
                          <div className="flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-white/10 bg-white">
                            {image ? <img src={image} alt={name} className="size-full object-contain" /> : <ShoppingBag className="size-4 text-black/30" />}
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium text-white">{name}</p>
                            <p className="mt-0.5 truncate text-xs font-normal text-[#b7c6d6]">
                              {color ? `${color} · ` : ""}Cantidad: {quantity}
                            </p>
                          </div>
                        </div>
                        <p className="self-center shrink-0 text-right text-sm font-medium text-white">
                          {formatCuentaPrice(unitPrice * quantity)}
                        </p>
                      </div>
                    )
                  })}
                </div>
              </section>
            </div>
          </section>
        </div>
      </main>
    )
  }

  return (
    <main className="min-h-screen bg-[#05070A] px-3 pb-10 pt-24 font-heading sm:px-5 lg:px-8">
      <div className="mx-auto max-w-[1200px]">
        <button type="button" onClick={() => router.push("/cuenta?tab=ordenes")} className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-full border border-white/12 bg-[#0D1117] px-4 text-sm font-bold text-white/80 transition-colors hover:border-blue-300/35 hover:text-white"><ChevronLeft className="size-4" />Volver a Mis compras</button>

        <header className="mt-4 rounded-2xl border border-[#112A43]/70 bg-[#0D1117] p-4 shadow-[0_0_22px_rgba(17,42,67,0.16)] sm:p-5">
          <div className="flex flex-col gap-3.5 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <p className="text-10px font-semibold uppercase tracking-[0.18em] text-blue-300">Detalle de compra</p>
              <h1 className="mt-1 text-xl font-black text-white sm:text-2xl">Pedido #{formatPublicOrderId(order.id)}</h1>
              <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs font-medium text-white/58"><span>{formatOrderCardDate(order.created_at)}</span><span className={`rounded-full border px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${status.className}`}>{status.label}</span></div>
            </div>
            <div className="flex min-h-20 items-center justify-center rounded-xl border border-emerald-300/30 bg-emerald-400/10 px-5 py-3.5 text-center shadow-[0_14px_32px_rgba(16,185,129,0.1)] lg:min-w-52">
              <div>
                <p className="text-10px font-semibold uppercase tracking-[0.16em] text-emerald-200">Total pagado</p>
                <p className="mt-1.5 text-xl font-bold leading-none text-emerald-50">{formatCuentaPrice(Number(order.total))}</p>
              </div>
            </div>
          </div>
        </header>

        {error && <p className="mt-3 rounded-xl border border-red-300/20 bg-red-500/10 px-4 py-3 text-sm font-bold text-red-200">{error}</p>}

        <div className="mt-4 grid items-start gap-4 lg:grid-cols-[minmax(0,1.62fr)_minmax(315px,0.78fr)]">
          <div className="space-y-4">
            <section className="rounded-2xl border border-white/9 bg-[#0D1117] p-3 sm:p-4">
              <OrderProgressTimeline order={order} />
            </section>

            <section className="rounded-2xl border border-white/9 bg-[#141820] p-3.5 sm:p-4">
              <h2 className="text-sm font-bold text-white">Productos comprados</h2>
              <div className="mt-3 space-y-2">
                {items.map((item) => {
                  const quantity = Number(item.cantidad ?? 0)
                  const unitPrice = Number(item.precio ?? 0)
                  const name = item.productos?.nombre ?? `Producto #${item.producto_id}`
                  const image = getCuentaItemImage(item)
                  return <div key={item.id} className="grid gap-3 rounded-xl border border-white/8 bg-[#1B2028] px-3 py-2.5 sm:grid-cols-[minmax(0,1.5fr)_repeat(3,minmax(90px,0.55fr))] sm:items-center">
                    <div className="flex min-w-0 items-center gap-3"><div className="flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-white">{image ? <img src={image} alt={name} className="size-full object-contain" /> : <ShoppingBag className="size-4 text-black/30" />}</div><div className="min-w-0"><p className="truncate text-sm font-semibold text-white">{name}</p><p className="mt-0.5 text-xs font-normal text-white/55">{getCuentaItemColor(item)}</p></div></div>
                    <div><p className="text-9px font-semibold uppercase tracking-widest text-white/40">Cantidad</p><p className="mt-0.5 text-sm font-bold text-white">{quantity}</p></div>
                    <div><p className="text-9px font-semibold uppercase tracking-widest text-white/40">Precio unitario</p><p className="mt-0.5 text-sm font-bold text-white">{formatCuentaPrice(unitPrice)}</p></div>
                    <div><p className="text-9px font-semibold uppercase tracking-widest text-white/40">Subtotal</p><p className="mt-0.5 text-sm font-bold text-white">{formatCuentaPrice(unitPrice * quantity)}</p></div>
                  </div>
                })}
              </div>
            </section>

            {order.estado === "entregado" && <OrderProductFeedback order={order} />}
          </div>

          <aside className="space-y-3.5 lg:sticky lg:top-24">
            <section className="rounded-2xl border border-white/9 bg-[#141820] p-3.5 sm:p-4">
              <h2 className="text-sm font-bold text-white">Resumen de pago</h2>
              <dl className="mt-3 space-y-2 text-xs"><div className="flex justify-between gap-3 text-white/65"><dt>Productos</dt><dd className="font-semibold text-white">{formatCuentaPrice(productsSubtotal)}</dd></div><div className="flex justify-between gap-3 text-white/65"><dt>Envío</dt><dd className="font-semibold text-white">{shipping > 0 ? formatCuentaPrice(shipping) : "Sin cargo"}</dd></div>{discount > 0 && <div className="flex justify-between gap-3 text-emerald-300"><dt>Descuento transferencia</dt><dd className="font-semibold">− {formatCuentaPrice(discount)}</dd></div>}</dl>
              <div className="mt-3.5 flex items-center justify-between gap-3 rounded-xl border border-emerald-400/25 bg-emerald-500/12 px-3.5 py-3"><span className="text-10px font-semibold uppercase tracking-widest text-emerald-100">Total pagado</span><strong className="text-base font-bold text-white">{formatCuentaPrice(Number(order.total))}</strong></div>
            </section>

            <section className="rounded-2xl border border-white/9 bg-[#141820] p-3.5 sm:p-4">
              <h2 className="text-sm font-bold text-white">Comprobante</h2>
              <div className="mt-2.5">
                {hasProof ? (
                  <PaymentProofViewButton order={order} className="h-9 w-full" />
                ) : order.payment_method_id === "transferencia" ? (
                  <PaymentProofActionButton
                    orderId={order.id}
                    onUploaded={handleProofUploaded}
                    label="Subir comprobante"
                    className={cn(beyonixHoverBorder, "inline-flex h-9 w-full cursor-pointer items-center justify-center gap-2 rounded-lg border-beyonix-blue-light/25 bg-[#112A43] px-4 text-xs font-black text-white disabled:opacity-60")}
                  />
                ) : (
                  <p className="rounded-xl bg-[#1B2028] px-3 py-2 text-xs font-semibold leading-5 text-white/65">Este medio de pago no requiere comprobante.</p>
                )}
              </div>
            </section>

            <section className="rounded-2xl border border-white/9 bg-[#141820] p-3.5 sm:p-4">
              <h2 className="text-sm font-bold text-white">Seguimiento</h2>
              {trackingNumber || trackingUrl ? (
                <div className="mt-2.5 space-y-2">
                  {trackingNumber && (
                    <p className="rounded-xl bg-[#1B2028] px-3.5 py-2.5 text-xs font-medium leading-5 text-white/70">
                      {trackingNumber}
                    </p>
                  )}
                  {trackingUrl && (
                    <a
                      href={trackingUrl}
                      target="_blank"
                      rel="noreferrer"
                      className={cn(beyonixHoverBorder, "inline-flex h-9 w-full cursor-pointer items-center justify-center rounded-lg border-beyonix-blue-light/25 bg-[#112A43] px-4 text-xs font-black text-white")}
                    >
                      Ver seguimiento
                    </a>
                  )}
                </div>
              ) : (
                <p className="mt-2.5 rounded-xl bg-[#1B2028] px-3.5 py-2.5 text-xs font-medium leading-5 text-white/65">
                  Estará disponible una vez despachado tu pedido
                </p>
              )}
            </section>

            <section className="rounded-2xl border border-white/9 bg-[#141820] p-3.5 sm:p-4">
              <h2 className="text-sm font-bold text-white">Factura</h2>
              {invoiceAvailable ? <><p className="mt-2 text-xs font-medium text-white/60">Factura C {formatCuentaInvoiceNumber(order.invoice_point, order.invoice_number)}</p><button type="button" disabled={downloadingInvoice} onClick={() => void handleDownloadInvoice()} className={cn(beyonixHoverBorder, "mt-2.5 inline-flex h-9 w-full cursor-pointer items-center justify-center gap-2 rounded-lg border-beyonix-blue-light/25 bg-[#112A43] px-4 text-xs font-black text-white disabled:cursor-not-allowed disabled:opacity-60")}><Download className="size-4" />{downloadingInvoice ? "Preparando..." : "Ver factura"}</button></> : <p className="mt-2.5 rounded-xl bg-[#1B2028] px-3.5 py-2.5 text-xs font-medium leading-5 text-white/65">Estará disponible una vez confirmado el pago</p>}
            </section>

            {canCancelOrder && (
              <div className="flex justify-end pt-1">
                <button
                  type="button"
                  disabled={cancellingOrder}
                  onClick={() => {
                    setCancelError("")
                    setCancelModalOpen(true)
                  }}
                  className="inline-flex h-8 shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-red-300/20 bg-red-500/8 px-3 text-[11px] font-black text-red-100/90 transition hover:border-red-300/35 hover:bg-red-500/12 disabled:cursor-not-allowed disabled:opacity-45"
                >
                  <X className="size-3.5" />
                  Cancelar compra
                </button>
              </div>
            )}
          </aside>
        </div>
      </div>

      {cancelModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4 py-6 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="cancel-order-title">
          <div className="w-full max-w-lg rounded-2xl border border-blue-300/16 bg-[#0D1117] p-4 shadow-[0_24px_80px_rgba(0,0,0,0.5)]">
            <div className="flex items-start gap-3">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-red-300/20 bg-red-500/12">
                <AlertTriangle className="size-5 text-red-200" />
              </span>
              <div>
                <h4 id="cancel-order-title" className="text-lg font-black text-white">
                  ¿Querés cancelar el pedido {formatPublicOrderId(order.id)}?
                </h4>
                <p className="mt-2 text-sm leading-6 text-white/72">
                  {order.payment_status === "confirmado" || order.payment_status === "approved" || order.paid_at
                    ? "Si confirmás la cancelación, registraremos tu solicitud de arrepentimiento y el reintegro quedará pendiente de gestión."
                    : "Si confirmás la cancelación, vamos a cancelar tu compra automáticamente."}
                </p>
              </div>
            </div>
            {cancelError && <p className="mt-3 rounded-lg border border-red-300/20 bg-red-500/10 px-3 py-2 text-xs font-bold text-red-200">{cancelError}</p>}
            <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <button
                type="button"
                disabled={cancellingOrder}
                onClick={() => setCancelModalOpen(false)}
                className="inline-flex h-10 cursor-pointer items-center justify-center rounded-lg border border-white/12 px-4 text-xs font-black text-white/85 transition hover:border-blue-300/30 disabled:cursor-not-allowed disabled:opacity-45"
              >
                Continuar con el pedido
              </button>
              <button
                type="button"
                disabled={cancellingOrder}
                onClick={() => void handleCancelOrder()}
                className="inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-lg border border-red-300/30 bg-red-500/14 px-4 text-xs font-black text-red-50 transition hover:border-red-300/55 hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-45"
              >
                {cancellingOrder && <Loader2 className="size-3.5 animate-spin" />}
                {cancellingOrder ? "Procesando..." : "Sí, cancelar compra"}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  )
}

export function CompraAyudaClient({ orderId }: { orderId: number }) {
  const { user, isLoading } = useAuth()
  const router = useRouter()
  const [order, setOrder] = useState<SupabasePedido | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "auto" })
  }, [orderId])

  useEffect(() => {
    if (isLoading) return
    if (!user) {
      router.replace(`/login?redirect=/cuenta/compras/${orderId}/ayuda`)
      return
    }

    const currentUser = user
    let active = true

    async function loadOrder() {
      setLoading(true)
      const { data, error: orderError } = await supabase
        .from("ordenes")
        .select("*, orden_items(*, productos(*), producto_variantes(*))")
        .eq("id", orderId)
        .maybeSingle()

      if (!active) return
      if (orderError || !data) {
        setError("No encontramos esta compra.")
        setLoading(false)
        return
      }

      const currentOrder = data as SupabasePedido
      const userValues = [currentUser.id, currentUser.email]
        .filter(Boolean)
        .map((value) => String(value).trim().toLowerCase())
      const orderValues = [currentOrder.usuario_id, currentOrder.cliente_email]
        .filter(Boolean)
        .map((value) => String(value).trim().toLowerCase())

      if (!orderValues.some((value) => userValues.includes(value))) {
        setError("No tenés acceso a esta compra.")
        setLoading(false)
        return
      }

      setOrder(currentOrder)
      setLoading(false)
    }

    void loadOrder()
    return () => { active = false }
  }, [isLoading, orderId, router, user])

  if (isLoading || loading) {
    return <main className="flex min-h-screen items-center justify-center bg-[#05070A] pt-20"><div className="size-9 animate-spin rounded-full border-2 border-white/10 border-t-blue-300" /></main>
  }

  if (!order) {
    return <main className="min-h-screen bg-[#05070A] px-4 pt-28"><div className="mx-auto max-w-3xl rounded-2xl border border-white/10 bg-[#0D1117] p-6 text-center"><p className="text-sm font-bold text-white">{error || "No encontramos esta compra."}</p><button type="button" onClick={() => router.push(`/cuenta/compras/${orderId}`)} className="mt-4 h-10 rounded-lg bg-[#112A43] px-4 text-xs font-black text-white">Volver a la compra</button></div></main>
  }

  return (
    <main className="min-h-screen bg-[#05070A] px-3 pb-12 pt-24 font-heading sm:px-5 lg:px-8">
      <div className="mx-auto max-w-5xl">
        <button type="button" onClick={() => router.push(`/cuenta/compras/${order.id}`)} className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-full border border-white/12 bg-[#0D1117] px-4 text-sm font-bold text-white/80 transition-colors hover:border-blue-300/35 hover:text-white"><ChevronLeft className="size-4" />Volver a la compra</button>

        <header className="mt-3 rounded-xl border border-[#112A43]/55 bg-[#0D1117] px-4 py-3 shadow-[0_0_18px_rgba(17,42,67,0.16)]">
          <div className="flex flex-wrap items-center justify-between gap-2"><div><h1 className="text-lg font-black text-white">Ayuda con tu compra</h1><p className="mt-0.5 text-xs font-semibold text-white/55">Pedido #{formatPublicOrderId(order.id)} · {formatOrderCardDate(order.created_at)}</p></div></div>
        </header>

        <section className="customer-claim-experience mt-4">
          <CustomerClaimExperience order={order} />
        </section>
      </div>
    </main>
  )
}

export function CuentaClient() {
  const { user, isLoading } = useAuth()
  const [tab, setTab] = useState<"login" | "register">("login")
  const searchParams = useSearchParams()

  const tabParam = searchParams.get("tab")
  const initialView: ProfileView =
    tabParam === "ordenes" ||
    tabParam === "datos" ||
    tabParam === "seguridad"
      ? tabParam
      : tabParam === "detalle" ||
          tabParam === "factura" ||
          tabParam === "reclamo"
        ? "ordenes"
      : "home"

  useEffect(() => {
    if (user) setTab("login")
  }, [user])

  useEffect(() => {
    if (isLoading || user) return

    const redirect = `${window.location.pathname}${window.location.search}`
    window.location.replace(`/login?redirect=${encodeURIComponent(redirect)}`)
  }, [isLoading, user])

  if (isLoading) {
    return (
      <main className="min-h-screen bg-black flex items-center justify-center pt-20">
        <div className="size-8 rounded-full border-2 border-white/10 border-t-white/60 animate-spin" />
      </main>
    )
  }

  if (!user) {
    return (
      <main className="min-h-screen bg-black flex items-center justify-center pt-20">
        <div className="size-8 rounded-full border-2 border-white/10 border-t-white/60 animate-spin" />
      </main>
    )
  }

  return (
    <main className="min-h-screen bg-black pt-20">
      <div className="account-page container mx-auto max-w-7xl px-4 py-8 lg:py-10">
        {user ? (
          <>
            {initialView !== "ordenes" && <div className="account-welcome mb-8">
              <p className="text-11px font-semibold uppercase tracking-widest text-beyonix-cyan mb-2">
                Mi cuenta
              </p>
              <h1 className="text-2xl font-bold text-white tracking-tight">
                Hola, {(user.username || user.name.split(" ")[0]).toUpperCase()}
              </h1>
            </div>}
            <ProfilePanel initialView={initialView} />
          </>
        ) : null}
        {false && (
          <>
            <div className="mb-8 text-center">
              <p className="text-11px font-semibold uppercase tracking-widest text-beyonix-cyan mb-2">
                Mi cuenta
              </p>
              <h1 className="text-2xl font-bold text-white tracking-tight mb-1">
                {tab === "login" ? "Bienvenido de vuelta" : "Creá tu cuenta"}
              </h1>
              <p className="text-sm text-white/50">
                {tab === "login"
                  ? "Inicia sesión para ver tus compras y datos."
                  : "Registrate para comprar en BEYONIX."}
              </p>
            </div>

            <div className="flex rounded-xl border border-white/7 bg-white/2 p-1 mb-7">
              {(["login", "register"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-label={value === "login" ? "Iniciar sesión" : "Registrarse"}
                  title={value === "login" ? "Iniciar sesión" : "Registrarse"}
                  onClick={() => setTab(value)}
                  className={`flex-1 py-2.5 rounded-lg text-sm font-semibold transition-all cursor-pointer ${
                    tab === value
                      ? "bg-beyonix-blue border border-beyonix-blue-light/60 text-white shadow-sm"
                      : "text-white/50 hover:text-white/80"
                  }`}
                >
                  {value === "login" ? "Iniciar sesión" : "Registrarse"}
                </button>
              ))}
            </div>

            <div className="rounded-2xl border border-white/7 bg-beyonix-surface p-6">
              {tab === "login" ? (
                <LoginForm onSwitch={() => setTab("register")} />
              ) : (
                <RegisterForm onSwitch={() => setTab("login")} />
              )}
            </div>
          </>
        )}
      </div>
    </main>
  )
}
