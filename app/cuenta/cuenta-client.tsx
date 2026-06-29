"use client"
// @refresh reset

import { useEffect, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  CheckCircle2,
  Download,
  Loader2,
  Lock,
  LogOut,
  Shield,
  ShoppingBag,
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

  const menuItems = [
    { icon: ShoppingBag, label: "Mis compras", sub: "Historial de compras", view: "ordenes" as ProfileView },
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
            onClick={() => goToView(item.view)}
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

  const handleDownloadInvoice = async () => {
    if (!order) return
    setDownloadingInvoice(true)
    setError("")
    try {
      const response = await fetch(`/api/orders/${order.id}/invoice`)
      if (!response.ok) {
        const data = (await response.json()) as { error?: string }
        throw new Error(data.error || "No se pudo descargar la factura.")
      }
      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement("a")
      anchor.href = url
      anchor.download = "Factura-BEYONIX.pdf"
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      URL.revokeObjectURL(url)
    } catch (downloadError) {
      setError(downloadError instanceof Error ? downloadError.message : "No se pudo descargar la factura.")
    } finally {
      setDownloadingInvoice(false)
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
    const refundStatusLabel = refunded
      ? "Cancelado · dinero reintegrado"
      : refundPending
        ? "Reintegro pendiente"
        : "Pedido cancelado"
    const refundStatusClassName = refunded
      ? "border-emerald-300/28 bg-emerald-400/10 text-emerald-50"
      : refundPending
        ? "border-amber-300/26 bg-amber-400/10 text-amber-50"
        : "border-zinc-300/22 bg-zinc-300/8 text-zinc-100"

    return (
      <main className="min-h-screen bg-[#070B11] px-3 pb-10 pt-24 font-heading sm:px-5 lg:px-8">
        <div className="mx-auto max-w-4xl">
          <button
            type="button"
            onClick={() => router.push("/cuenta?tab=ordenes")}
            className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-full border border-white/12 bg-[#111822] px-4 text-sm font-bold text-white/82 transition-colors hover:border-blue-300/35 hover:text-white"
          >
            <ChevronLeft className="size-4" />
            Volver a Mis compras
          </button>

          <section className="mt-4 rounded-2xl border border-white/10 bg-[#101720] p-4 shadow-[0_24px_70px_rgba(0,0,0,0.2)] sm:p-6">
            <div className="flex flex-col gap-4 border-b border-white/9 pb-5 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <p className="text-10px font-black uppercase tracking-[0.18em] text-blue-300">
                  Detalle de compra
                </p>
                <h1 className="mt-1 text-2xl font-black text-white sm:text-3xl">
                  Pedido #{formatPublicOrderId(order.id)}
                </h1>
                <p className="mt-1.5 text-sm font-semibold text-white/58">
                  {formatOrderCardDate(order.created_at)}
                </p>
              </div>
              <span className={`inline-flex w-fit items-center rounded-full border px-3 py-1.5 text-xs font-black ${refundStatusClassName}`}>
                {refundStatusLabel}
              </span>
            </div>

            <section className={`mt-5 rounded-2xl border px-4 py-4 sm:px-5 sm:py-5 ${
              refunded
                ? "border-emerald-300/22 bg-[#12211D]"
                : refundPending
                  ? "border-amber-300/22 bg-[#201C13]"
                  : "border-zinc-300/18 bg-[#151A21]"
            }`}>
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
                <span className={`flex size-12 shrink-0 items-center justify-center rounded-full border ${
                  refunded
                    ? "border-emerald-200/35 bg-emerald-400/12"
                    : refundPending
                      ? "border-amber-200/35 bg-amber-400/12"
                      : "border-zinc-200/22 bg-white/6"
                }`}>
                  {refunded ? (
                    <CheckCircle2 className="size-7 text-emerald-200" />
                  ) : (
                    <X className={`size-6 ${refundPending ? "text-amber-100" : "text-zinc-100"}`} />
                  )}
                </span>
                <div className="min-w-0">
                  <h2 className="text-lg font-black leading-tight text-white sm:text-xl">
                    {refunded
                      ? "¡Reintegro realizado con éxito!"
                      : refundPending
                        ? "Lamentamos que hayas cancelado tu compra."
                        : "Tu compra fue cancelada correctamente."}
                  </h2>
                  <p className="mt-2 max-w-2xl text-sm font-semibold leading-6 text-white/74">
                    {refunded
                      ? "El dinero de tu compra ya fue reintegrado. Esperamos verte pronto para una nueva compra."
                      : refundPending
                        ? "Ya recibimos tu solicitud de arrepentimiento. Revisaremos el pago recibido y nos pondremos en contacto a la brevedad para coordinar el reintegro correspondiente."
                        : "El pedido quedó cancelado y no requiere acciones adicionales."}
                  </p>
                  {refunded && order.refund_proof_url && (
                    <button
                      type="button"
                      disabled={refundProofOpening}
                      onClick={() => void handleOpenRefundProof()}
                      className={cn(beyonixHoverBorder, "mt-4 inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-lg border-beyonix-blue-light/30 bg-[#112A43] px-4 text-xs font-black text-white transition disabled:cursor-wait disabled:opacity-60")}
                    >
                      <Download className="size-4" />
                      {refundProofOpening ? "Abriendo..." : "Ver comprobante de reintegro"}
                    </button>
                  )}
                  {refundProofError && (
                    <p className="mt-2 text-xs font-bold text-red-200">
                      {refundProofError}
                    </p>
                  )}
                </div>
              </div>
            </section>

            <div className="mt-5 grid gap-3 sm:grid-cols-3">
              <div className="flex min-h-[82px] flex-col justify-center rounded-xl border border-white/9 bg-[#16202B] px-4 py-3">
                <p className="text-10px font-black uppercase tracking-widest text-white/45">
                  Pedido
                </p>
                <p className="mt-1.5 text-base font-black text-white">
                  #{formatPublicOrderId(order.id)}
                </p>
              </div>
              <div className="flex min-h-[82px] flex-col justify-center rounded-xl border border-white/9 bg-[#16202B] px-4 py-3">
                <p className="text-10px font-black uppercase tracking-widest text-white/45">
                  Fecha
                </p>
                <p className="mt-1.5 text-base font-black text-white">
                  {formatOrderCardDate(order.created_at)}
                </p>
              </div>
              <div className="flex min-h-[82px] flex-col justify-center rounded-xl border border-white/9 bg-[#16202B] px-4 py-3">
                <p className="text-10px font-black uppercase tracking-widest text-white/45">
                  Total
                </p>
                <p className="mt-1.5 text-base font-black text-white">
                  {formatCuentaPrice(Number(order.total ?? 0))}
                </p>
              </div>
            </div>

            {refundFlow && (
              <section className="mt-5 rounded-2xl border border-white/10 bg-[#111922] p-4 sm:p-5">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <p className="text-10px font-black uppercase tracking-[0.18em] text-blue-300">
                      Reintegro
                    </p>
                    <h2 className="mt-1 text-base font-black text-white">
                      Estado del dinero
                    </h2>
                  </div>
                  <span className={`inline-flex w-fit rounded-full border px-3 py-1 text-xs font-black ${refundStatusClassName}`}>
                    {refundStatusLabel}
                  </span>
                </div>

                <div className="mt-4 grid gap-3 sm:grid-cols-3">
                  <div className="rounded-xl border border-white/8 bg-[#17212C] px-4 py-3">
                    <p className="text-10px font-black uppercase tracking-widest text-white/46">
                      Estado actual
                    </p>
                    <p className="mt-1.5 text-sm font-black text-white">
                      {refundStatusLabel}
                    </p>
                  </div>
                  <div className="rounded-xl border border-white/8 bg-[#17212C] px-4 py-3">
                    <p className="text-10px font-black uppercase tracking-widest text-white/46">
                      Monto abonado
                    </p>
                    <p className="mt-1.5 text-sm font-black text-white">
                      {formatCuentaPrice(Number(order.payment_confirmed_amount ?? order.total ?? 0))}
                    </p>
                  </div>
                  <div className="rounded-xl border border-white/8 bg-[#17212C] px-4 py-3">
                    <p className="text-10px font-black uppercase tracking-widest text-white/46">
                      Fecha de solicitud
                    </p>
                    <p className="mt-1.5 text-sm font-black text-white">
                      {cancellationDate ? formatOrderCardDate(cancellationDate) : "Recibida"}
                    </p>
                  </div>
                </div>

                {refunded ? (
                  <div className="mt-4 rounded-xl border border-emerald-300/22 bg-emerald-400/8 px-4 py-3">
                    <div className="flex gap-3">
                      <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-emerald-200" />
                      <div>
                        <p className="text-sm font-black leading-5 text-emerald-50">
                          El reintegro ya fue registrado por BEYONIX.
                        </p>
                        {order.refund_observation && (
                          <p className="mt-1 text-sm font-semibold leading-6 text-emerald-50/82">
                            {order.refund_observation}
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                ) : (
                  <p className="mt-4 rounded-xl border border-amber-300/18 bg-amber-400/8 px-4 py-3 text-sm font-semibold leading-6 text-amber-50/86">
                    Te avisaremos por este medio cuando el reintegro quede registrado.
                  </p>
                )}
              </section>
            )}

            <section className="mt-5 rounded-2xl border border-white/10 bg-[#111922] p-4 sm:p-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-base font-black text-white">
                  Productos comprados
                </h2>
                <span className="text-xs font-bold text-white/52">
                  {productCount} {productCount === 1 ? "producto" : "productos"}
                </span>
              </div>
              <div className="mt-3 space-y-2.5">
                {items.map((item) => {
                  const quantity = Number(item.cantidad ?? 0)
                  const unitPrice = Number(item.precio ?? 0)
                  const name = item.productos?.nombre ?? `Producto #${item.producto_id}`
                  const image = getCuentaItemImage(item)

                  return (
                    <div key={item.id} className="flex flex-col gap-3 rounded-xl border border-white/8 bg-[#17212C] p-3 sm:flex-row sm:items-center sm:justify-between">
                      <div className="flex min-w-0 items-center gap-3">
                        <div className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-white">
                          {image ? <img src={image} alt={name} className="size-full object-contain" /> : <ShoppingBag className="size-4 text-black/30" />}
                        </div>
                        <div className="min-w-0">
                          <p className="truncate text-sm font-black text-white">{name}</p>
                          <p className="mt-1 text-xs font-semibold text-white/55">
                            {getCuentaItemColor(item)} · Cantidad: {quantity}
                          </p>
                        </div>
                      </div>
                      <p className="shrink-0 text-sm font-black text-white sm:text-right">
                        {formatCuentaPrice(unitPrice * quantity)}
                      </p>
                    </div>
                  )
                })}
              </div>
            </section>

            <button
              type="button"
              onClick={() => router.push("/")}
              className="mt-5 inline-flex h-10 w-full cursor-pointer items-center justify-center rounded-lg border border-white/12 bg-[#151D27] px-4 text-xs font-black text-white/86 transition hover:border-[#77E6E2]/35 hover:text-white sm:w-auto"
            >
              Ir a Inicio
            </button>
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
