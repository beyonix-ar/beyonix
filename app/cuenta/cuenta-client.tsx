"use client"
// @refresh reset

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  CheckCircle2,
  Clock3,
  Coins,
  Copy,
  CreditCard,
  Download,
  Eye,
  FileText,
  Gift,
  Heart,
  IdCard,
  Landmark,
  Loader2,
  LockKeyhole,
  LogOut,
  MessageCircle,
  ShieldCheck,
  ShoppingBag,
  Sparkles,
  Truck,
  UploadCloud,
  User,
  X,
} from "lucide-react"

import { useAuth } from "@/context/auth-context"
import { useCustomerCredit } from "@/context/customer-credit-context"
import {
  AccountBackButton,
  AccountCard,
  AccountPageContainer,
  AccountPageHeader,
  IconContainer,
} from "@/components/account/account-ui"
import { LoginForm, RegisterForm } from "@/components/account/auth-forms"
import { MisOrdenes } from "@/components/account/account-orders"
import { MisDatos, Seguridad } from "@/components/account/profile-sections"
import {
  OrderExperienceFeedback,
  OrderProductFeedback,
  OrderProgressTimeline,
  PaymentProofViewButton,
} from "@/components/account/account-order-components"
import { PaymentProofActionButton } from "@/components/payment-proof-uploader"
import { CustomerClaimExperience } from "@/components/claims/customer-claim-experience"
import { supabase } from "@/lib/supabase/client"
import type { SupabaseOrderClaim, SupabasePedido } from "@/lib/supabase/types"
import { formatARS } from "@/lib/customer-credit"
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
import {
  TRANSFER_ALIAS,
  TRANSFER_ACCOUNT_HOLDER,
  TRANSFER_CVU,
} from "@/lib/payments/transfer"
import { BEYONIX_SUPPORT_HOURS } from "@/lib/legal-contact"
import { beyonixHoverBorder, cn } from "@/lib/utils"

type ProfileView =
  | "home"
  | "ordenes"
  | "saldo"
  | "cargar-saldo"
  | "datos"
  | "seguridad"

const ACCOUNT_ORDER_SELECT =
  "*, orden_items(id, orden_id, producto_id, variante_id, cantidad, precio, productos(*), producto_variantes(*)), order_claims(*, order_claim_files(*), order_claim_messages(*))"
const CUSTOMER_PAYMENT_PROOF_EDITABLE_STATUSES = [
  "pendiente_comprobante",
  "en_revision",
  "rechazado",
]

function formatGiftCardExpiration(value?: string | null) {
  if (!value) return null

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null

  return new Intl.DateTimeFormat("es-AR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "America/Argentina/Buenos_Aires",
  }).format(date)
}

function formatGiftCardEmission(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "Fecha no disponible"

  return new Intl.DateTimeFormat("es-AR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "America/Argentina/Buenos_Aires",
  }).format(date)
}

function isOrderPaymentConfirmed(order: SupabasePedido) {
  const paymentStatus = (order.payment_status ?? "").toLowerCase()

  return (
    order.estado === "pagado" ||
    paymentStatus === "confirmado" ||
    paymentStatus === "confirmed" ||
    paymentStatus === "approved" ||
    Boolean(order.paid_at) ||
    Number(order.payment_confirmed_amount ?? 0) > 0
  )
}

function isOrderDetailDispatched(order: SupabasePedido) {
  const status = (order.estado ?? "").toLowerCase()
  const andreaniStatus = (order.andreani_estado ?? "").toLowerCase()

  return (
    [
      "enviado",
      "en_camino",
      "visita_fallida",
      "en_sucursal",
      "retiro_pendiente",
      "retiro_vencido",
      "en_devolucion",
      "devuelto_beyonix",
      "entregado",
    ].includes(status) ||
    Boolean(order.tracking_number || order.andreani_tracking || order.andreani_envio_id) ||
    ["camino", "tránsito", "transito", "distribución", "distribucion", "reparto", "visita", "entregado"].some((value) =>
      andreaniStatus.includes(value),
    )
  )
}

function isOrderDetailDelivered(order: SupabasePedido) {
  const status = (order.estado ?? "").toLowerCase()
  const andreaniStatus = (order.andreani_estado ?? "").toLowerCase()
  return status === "entregado" || Boolean(order.delivered_at) || andreaniStatus.includes("entregado")
}

function isOrderDetailInvoiced(order: SupabasePedido) {
  return (
    order.invoice_status === "authorized" ||
    order.invoice_status === "processing" ||
    Boolean(order.invoice_cae) ||
    Boolean(order.invoice_number && order.invoice_point)
  )
}

function canShowOrderClaimHelp(order: SupabasePedido) {
  if ((order.estado ?? "").toLowerCase() === "cancelado") return false

  return isOrderDetailDelivered(order)
}

function getLatestCustomerClaim(claims: SupabaseOrderClaim[] = []) {
  return claims
    .filter((claim) => claim.failure_type !== "cancelar_compra")
    .sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at))[0]
}

function getLatestFormalCustomerClaim(claims: SupabaseOrderClaim[] = []) {
  return claims
    .filter((claim) => claim.failure_type !== "cancelar_compra" && claim.failure_type !== "consulta_pedido")
    .sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at))[0]
}

function getCustomerClaimDetailStatus(claim?: SupabaseOrderClaim | null) {
  if (!claim) return null

  if (claim.status === "rechazado") {
    return {
      label: "Estado: Reclamo rechazado",
      className: "border-red-300/25 bg-red-500/10 text-red-100",
    }
  }

  if (claim.status === "cerrado") {
    return {
      label: "Estado: Reclamo solucionado",
      className: "border-[#77E6E2]/35 bg-[#77E6E2]/12 text-[#D7FFFD]",
    }
  }

  return {
    label: "Estado: En proceso de resolución",
    className: "border-blue-300/35 bg-[#112A43] text-blue-50",
  }
}

async function getOrderClaims(orderId: number) {
  try {
    const response = await fetch(`/api/orders/${orderId}/claims`, {
      cache: "no-store",
    })

    if (!response.ok) return []

    const data = (await response.json()) as {
      claims?: SupabaseOrderClaim[]
    }

    return data.claims ?? []
  } catch {
    return []
  }
}

function OrderPageLoadingState({ variant = "detail" }: { variant?: "detail" | "claim" }) {
  const isClaim = variant === "claim"

  return (
    <main
      aria-busy="true"
      aria-label="Cargando compra"
      className={
        isClaim
          ? "min-h-screen px-3 pt-24 font-heading sm:px-5 lg:px-8"
          : "min-h-screen bg-[#05070A] px-3 pt-20 font-heading sm:px-5 lg:px-8"
      }
    >
      <div
        className={
          isClaim
            ? "customer-claim-page-frame w-full py-3"
            : "customer-claim-page-frame flex min-h-[calc(100vh-5rem)] w-full items-center justify-center py-8"
        }
      >
        <div className={isClaim ? "mx-auto w-full max-w-[72rem]" : "w-full max-w-6xl 2xl:max-w-7xl"}>
          <div className="h-10 w-44 rounded-full border border-white/10 bg-[#111418]" />

          {variant === "claim" ? (
            <div className="claim-chat-shell mt-4 overflow-hidden rounded-2xl border border-[#21476B] bg-[#070C12]">
              <div className="border-b border-[#18334D] bg-[#0B1724] px-5 py-4">
                <div className="h-3 w-56 rounded bg-[#18334D]" />
                <div className="mt-3 h-7 w-64 rounded bg-[#1B222B]" />
                <div className="mt-3 h-4 max-w-2xl rounded bg-[#151B22]" />
              </div>
              <div className="min-h-[22rem] bg-[#070C12] px-5 py-5">
                <div className="ml-auto h-28 max-w-3xl rounded-2xl rounded-br-md border border-[#2C6CA3]/35 bg-[#112A43]" />
              </div>
              <div className="border-t border-[#18334D] bg-[#0B1724] px-5 py-4">
                <div className="h-12 rounded-xl border border-[#21476B] bg-[#101820]" />
              </div>
            </div>
          ) : (
            <>
              <div className="mt-4 rounded-2xl border border-[#18334D] bg-[#0B1118] p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="space-y-2">
                    <div className="h-3 w-36 rounded bg-[#15202B]" />
                    <div className="h-7 w-52 rounded bg-[#1B222B]" />
                    <div className="h-4 w-44 rounded bg-[#151B22]" />
                  </div>
                  <div className="h-16 w-full rounded-xl border border-emerald-300/20 bg-[#102A22] sm:w-48" />
                </div>
              </div>
              <div className="order-detail-components-shell mt-4 grid items-start gap-4 rounded-2xl border border-[#18334D] bg-[#111418] p-3 sm:p-4 lg:grid-cols-[minmax(0,1.62fr)_minmax(315px,0.78fr)]">
                <div className="space-y-4">
                  <div className="h-44 rounded-2xl border border-[#18334D] bg-[#101923]" />
                  <div className="h-32 rounded-2xl border border-[#18334D] bg-[#101923]" />
                  <div className="h-32 rounded-2xl border border-[#18334D] bg-[#101923]" />
                </div>
                <aside className="space-y-3.5">
                  <div className="h-44 rounded-2xl border border-[#18334D] bg-[#101923]" />
                  <div className="h-36 rounded-2xl border border-[#18334D] bg-[#101923]" />
                </aside>
              </div>
            </>
          )}
        </div>
      </div>
    </main>
  )
}

function MiSaldo({
  onBack,
  onLoadBalance,
}: {
  onBack: () => void
  onLoadBalance: () => void
}) {
  const customerCredit = useCustomerCredit()
  const loadCustomerCreditMovements = customerCredit.loadMovements
  const [giftRecipientName, setGiftRecipientName] = useState("")
  const [giftRecipientLookup, setGiftRecipientLookup] = useState("")
  const [giftAmount, setGiftAmount] = useState("")
  const [giftMessage, setGiftMessage] = useState("")
  const [giftSaving, setGiftSaving] = useState(false)
  const [giftNotice, setGiftNotice] = useState("")
  const [giftError, setGiftError] = useState("")
  const [showReceivedGiftCards, setShowReceivedGiftCards] = useState(false)
  const giftCardMovements = customerCredit.movements.filter((movement) => {
    const metadata = movement.metadata ?? {}

    return (
      movement.movement_type === "credit" &&
      (metadata.source_kind === "gift_card" ||
        metadata.created_from === "admin_gift_card_panel" ||
        metadata.created_from === "admin_gift_card_transfer" ||
      movement.description.toLowerCase().includes("giftcard"))
    )
  })
  const normalizedGiftAmount = Number(
    giftAmount.replace(/\./g, "").replace(",", "."),
  )
  const previewGiftAmount =
    Number.isFinite(normalizedGiftAmount) && normalizedGiftAmount > 0
      ? normalizedGiftAmount
      : 0
  const hasAvailableBalance = customerCredit.balance > 0
  const previewRecipientName =
    giftRecipientName.trim() || "Nombre de la persona"
  const previewRecipientLookup =
    giftRecipientLookup.trim() || "Email del destinatario"

  useEffect(() => {
    void loadCustomerCreditMovements()
  }, [loadCustomerCreditMovements])

  async function submitGiftCard() {
    setGiftNotice("")
    setGiftError("")
    setGiftSaving(true)

    try {
      const response = await fetch("/api/customer-credit/gift-card", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          recipientName: giftRecipientName,
          recipientEmail: giftRecipientLookup,
          amount: giftAmount,
          message: giftMessage,
        }),
      })
      const data = (await response.json()) as {
        balance?: number
        movements?: typeof customerCredit.movements
        emailSent?: boolean
        emailMessage?: string
        creditedImmediately?: boolean
        error?: string
      }

      if (!response.ok) {
        throw new Error(data.error ?? "No se pudo enviar la Gift Card.")
      }

      setGiftRecipientName("")
      setGiftRecipientLookup("")
      setGiftAmount("")
      setGiftMessage("")
      setGiftNotice(data.emailMessage || (
        data.creditedImmediately
          ? data.emailSent
            ? "Gift Card acreditada. También enviamos la presentación por email."
            : "Gift Card acreditada correctamente, pero el email quedó pendiente de reintento."
          : data.emailSent
            ? "Gift Card creada. Enviamos el enlace de acreditación por email."
            : "Gift Card creada. El email quedó pendiente de reintento administrativo."
      ))
      await Promise.all([
        customerCredit.reload(),
        loadCustomerCreditMovements(),
      ])
    } catch (error) {
      setGiftError(
        error instanceof Error ? error.message : "No se pudo enviar la Gift Card.",
      )
    } finally {
      setGiftSaving(false)
    }
  }

  return (
    <AccountPageContainer className="max-w-6xl space-y-3 pb-10">
      <AccountBackButton
        onClick={onBack}
        label="Volver a mi cuenta"
        className="h-10 rounded-full border-[#2A4B6C] bg-[#132033] px-4 text-xs font-medium text-white/82 shadow-sm shadow-black/25 hover:border-[#4B78A4] hover:bg-[#1A2C44] hover:text-white"
      />

      <div className="space-y-4 rounded-2xl border border-[#172633] bg-[#070C12] p-4 shadow-[0_22px_60px_rgba(0,0,0,0.24)] sm:p-5">
      <header className="border-b border-[#192936] px-1 pb-4">
        <p className="text-9px font-medium uppercase tracking-[0.18em] text-beyonix-sky/70">
          Mi cuenta
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight text-white/95 sm:text-3xl">
            BEYONIX Gift Card
          </h1>
          <button
            type="button"
            aria-pressed={showReceivedGiftCards}
            onClick={() => setShowReceivedGiftCards((current) => !current)}
            className={cn(
              "group inline-flex h-10 items-center gap-2 rounded-full border px-4 text-xs font-semibold transition-all duration-200",
              showReceivedGiftCards
                ? "border-beyonix-sky/70 bg-[linear-gradient(135deg,#1C5279,#14324C)] text-white shadow-[0_0_22px_rgba(77,167,224,0.2)]"
                : "border-[#4F82A8] bg-[linear-gradient(135deg,#183C59,#10263A)] text-white/90 shadow-[0_8px_22px_rgba(0,0,0,0.2)] hover:-translate-y-px hover:border-beyonix-sky/75 hover:text-white hover:shadow-[0_10px_28px_rgba(56,145,205,0.18)]",
            )}
          >
            <Gift className="size-4 transition-transform duration-200 group-hover:-rotate-6 group-hover:scale-110" />
            Tus Gift!
            {giftCardMovements.length ? (
              <span className="flex size-5 items-center justify-center rounded-full border border-white/15 bg-black/20 text-9px tabular-nums text-white/90">
                {giftCardMovements.length}
              </span>
            ) : null}
          </button>
        </div>
        <p className="mt-1.5 max-w-2xl text-sm font-normal leading-6 text-white/48">
          {showReceivedGiftCards
            ? "Consultá las Gift Cards que recibiste."
            : "Cargá saldo en tu cuenta y prepará una tarjeta personalizada para otra persona."}
        </p>
      </header>

      {!showReceivedGiftCards ? (
        <>
      <section className="rounded-xl border border-[#294B68] bg-[#1C1C1C] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-9px font-medium uppercase tracking-[0.18em] text-beyonix-sky/70">
              Antes de enviar
            </p>
            <h2 className="mt-1 text-base font-medium text-white/92">
              Primero necesitás saldo validado en tu cuenta
            </h2>
            <p className="mt-1 max-w-2xl text-xs font-normal leading-5 text-white/62">
              Realizá una transferencia, enviá el comprobante y esperá la validación. Cuando el saldo esté disponible, vas a poder entregar la Gift Card.
            </p>
          </div>
          <button
            type="button"
            onClick={onLoadBalance}
            className="inline-flex h-9 shrink-0 items-center justify-center rounded-lg border border-[#5B91BB]/38 bg-[#132B40] px-4 text-xs font-medium text-white/92 transition hover:border-[#77ADD5]/52 hover:bg-[#173750]"
          >
            {hasAvailableBalance ? "Administrar carga" : "Cargar saldo"}
          </button>
        </div>

        <div className="mt-4 grid gap-2 sm:grid-cols-3">
          {[
            ["1", "Transferí el dinero", "Usá los datos bancarios disponibles en Cargar saldo."],
            ["2", "Esperá la validación", "El saldo aparecerá cuando confirmemos el comprobante."],
            ["3", "Enviá la tarjeta", "Completá los datos de la persona y elegí el importe."],
          ].map(([step, title, description]) => (
            <div key={step} className="flex gap-3 rounded-lg border border-[#31506F] bg-[#282828] p-3">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-beyonix-sky/25 bg-beyonix-blue/24 text-10px font-medium text-beyonix-sky">
                {step}
              </span>
              <div>
                <p className="text-xs font-medium text-white/92">{title}</p>
                <p className="mt-1 text-10px font-normal leading-4 text-white/56">
                  {description}
                </p>
              </div>
            </div>
          ))}
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-[0.96fr_1.04fr]">
        <section className="rounded-xl border border-[#294B68] bg-[#181818] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] sm:p-5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-9px font-medium uppercase tracking-[0.18em] text-white/52">
                Vista previa
              </p>
              <p className="mt-1 text-xs font-normal text-white/64">
                La tarjeta se completa con los datos del formulario.
              </p>
            </div>
            <span className="rounded-full border border-emerald-300/15 bg-emerald-400/[0.06] px-2.5 py-1 text-10px font-normal text-emerald-100/70">
              Saldo: {formatARS(customerCredit.balance)}
            </span>
          </div>

          <div className="relative mt-4 min-h-[270px] overflow-hidden rounded-2xl border border-[#6AA9D2]/28 bg-[#07131F] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.055),0_18px_42px_rgba(0,0,0,0.26)] sm:p-6">
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_10%_0%,rgba(58,151,218,0.25),transparent_38%),radial-gradient(circle_at_100%_100%,rgba(24,76,114,0.2),transparent_42%),linear-gradient(135deg,#12324b_0%,#081725_48%,#040a11_100%)]" />
            <div className="pointer-events-none absolute -right-20 -top-24 size-64 rounded-full border border-white/[0.055]" />
            <div className="pointer-events-none absolute -right-8 -top-12 size-48 rounded-full border border-white/[0.035]" />
            <div className="pointer-events-none absolute -bottom-16 -left-10 size-44 rounded-full bg-beyonix-blue/10 blur-2xl" />
            <div className="pointer-events-none absolute bottom-12 right-[-4rem] h-px w-72 rotate-[-27deg] bg-gradient-to-r from-transparent via-beyonix-sky/22 to-transparent" />

            <div className="relative flex min-h-[222px] flex-col justify-between">
              <div className="flex items-center justify-between gap-4">
                <p className="text-base font-semibold tracking-[0.1em] text-white/94">
                  BEYONIX
                </p>
                <span className="rounded-md border border-white/[0.1] bg-black/15 px-2.5 py-1.5 text-8px font-medium uppercase tracking-[0.2em] text-beyonix-sky/76">
                  Gift Card
                </span>
              </div>

              <div>
                <p className="text-9px font-normal uppercase tracking-[0.18em] text-white/34">
                  Importe de la tarjeta
                </p>
                <p className="mt-1 text-3xl font-medium tracking-tight text-white">
                  {formatARS(previewGiftAmount)}
                </p>
                <p className="mt-2 line-clamp-1 max-w-[85%] text-xs font-normal text-white/48">
                  {giftMessage.trim() || "Un regalo especial para vos"}
                </p>
              </div>

              <div className="flex items-end justify-between gap-5 border-t border-white/[0.07] pt-3">
                <div className="min-w-0">
                  <p className="text-8px font-normal uppercase tracking-[0.18em] text-white/28">
                    Para
                  </p>
                  <p className="mt-1 truncate text-sm font-medium text-white/88">
                    {previewRecipientName}
                  </p>
                  <p className="mt-0.5 truncate text-10px font-normal text-white/38">
                    {previewRecipientLookup}
                  </p>
                </div>
                <span className="shrink-0 text-8px font-normal uppercase tracking-[0.17em] text-white/24">
                  BX · GIFT
                </span>
              </div>
            </div>
          </div>
        </section>

        <section className="rounded-xl border border-[#294B68] bg-[#181818] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] sm:p-5">
          <div>
            <h2 className="text-base font-medium text-white/92">Preparar la Gift Card</h2>
            <p className="mt-1 text-xs font-normal leading-5 text-white/62">
              Completá los datos exactos de la persona que va a recibirla.
            </p>
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="block sm:col-span-2">
              <span className="text-xs font-medium text-white/88">
                Nombre y apellido de la persona que recibirá la tarjeta
              </span>
              <input
                value={giftRecipientName}
                onChange={(event) => setGiftRecipientName(event.target.value)}
                placeholder="Ej.: María González"
                className="mt-1.5 h-11 w-full rounded-lg border border-[#3A6283] bg-[#303030] px-3.5 text-sm font-medium text-[#F4F5F6] caret-white outline-none transition placeholder:font-normal placeholder:text-[#B5B5B5] focus:border-beyonix-sky focus:bg-[#393939]"
              />
              <span className="mt-1 block text-10px font-normal text-white/52">
                Este nombre aparecerá impreso en la Gift Card.
              </span>
            </label>

            <label className="block">
              <span className="text-xs font-medium text-white/88">
                Email de la persona
              </span>
              <input
                value={giftRecipientLookup}
                onChange={(event) => setGiftRecipientLookup(event.target.value)}
                type="email"
                autoComplete="email"
                placeholder="nombre@email.com"
                className="mt-1.5 h-11 w-full rounded-lg border border-[#3A6283] bg-[#303030] px-3.5 text-sm font-medium text-[#F4F5F6] caret-white outline-none transition placeholder:font-normal placeholder:text-[#B5B5B5] focus:border-beyonix-sky focus:bg-[#393939]"
              />
            </label>

            <label className="block">
              <span className="text-xs font-medium text-white/88">
                Importe que querés entregar
              </span>
              <input
                value={giftAmount}
                onChange={(event) => setGiftAmount(event.target.value)}
                inputMode="decimal"
                placeholder="Monto"
                className="mt-1.5 h-11 w-full rounded-lg border border-[#3A6283] bg-[#303030] px-3.5 text-sm font-medium text-[#F4F5F6] caret-white outline-none transition placeholder:font-normal placeholder:text-[#B5B5B5] focus:border-beyonix-sky focus:bg-[#393939]"
              />
            </label>

            <label className="block sm:col-span-2">
              <span className="text-xs font-medium text-white/88">
                Mensaje para la persona <span className="font-normal text-white/52">(opcional)</span>
              </span>
              <textarea
                value={giftMessage}
                onChange={(event) => setGiftMessage(event.target.value)}
                maxLength={240}
                placeholder="Escribí una dedicatoria breve"
                className="mt-1.5 min-h-[82px] w-full resize-none rounded-lg border border-[#3A6283] bg-[#303030] px-3.5 py-3 text-sm font-medium leading-5 text-[#F4F5F6] caret-white outline-none transition placeholder:font-normal placeholder:text-[#B5B5B5] focus:border-beyonix-sky focus:bg-[#393939]"
              />
            </label>
          </div>

          {giftNotice ? (
            <p className="mt-2 text-11px font-normal text-emerald-300/80">{giftNotice}</p>
          ) : null}
          {giftError ? (
            <p className="mt-2 text-11px font-normal text-red-200/85">{giftError}</p>
          ) : null}

          <div className="mt-4">
            <button
              type="button"
              disabled={giftSaving || !hasAvailableBalance}
              onClick={() => void submitGiftCard()}
              className="inline-flex h-11 w-full items-center justify-center rounded-lg border border-[#5B91BB]/38 bg-[#12304A] px-4 text-sm font-medium text-white/94 transition hover:border-[#77ADD5]/52 hover:bg-[#173C5A] disabled:cursor-not-allowed disabled:border-[#3A3F46] disabled:bg-[#282C31] disabled:text-white/58"
            >
              {giftSaving
                ? "Enviando..."
                : hasAvailableBalance
                  ? "Enviar Gift Card"
                  : "Primero cargá saldo"}
            </button>
            <p className="mt-2 text-center text-10px font-normal leading-4 text-white/32">
              El importe se reservará al confirmar. La persona recibirá un enlace personal para acreditarlo, tenga o no una cuenta.
            </p>
          </div>
        </section>
      </div>
        </>
      ) : null}

      {showReceivedGiftCards ? (
        <section className="overflow-hidden rounded-2xl border border-[#315B7D] bg-[#181818] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.045),0_22px_50px_rgba(0,0,0,0.2)] sm:p-6">
          {customerCredit.movementsLoading ? (
            <div className="flex min-h-72 items-center justify-center">
              <Loader2 className="size-6 animate-spin text-beyonix-sky/65" />
            </div>
          ) : giftCardMovements.length ? (
            <div className="grid gap-5">
              {giftCardMovements.map((movement) => {
                const message = movement.description
                  .replace(/^GiftCard recibida:\s*/i, "")
                  .replace(/^Transferencia GiftCard enviada:\s*/i, "")
                const senderName =
                  typeof movement.metadata?.sender_name === "string" &&
                  movement.metadata.sender_name.trim()
                    ? movement.metadata.sender_name.trim()
                    : "BEYONIX"
                const expirationDate = formatGiftCardExpiration(
                  movement.expires_at,
                )
                const emissionDate = formatGiftCardEmission(
                  movement.created_at,
                )

                return (
                  <article
                    key={movement.id}
                    className="group relative isolate w-full min-h-[340px] overflow-hidden rounded-2xl border border-[#5B91BB]/55 bg-[radial-gradient(circle_at_8%_0%,rgba(91,145,187,0.34),transparent_40%),radial-gradient(circle_at_100%_100%,rgba(17,42,67,0.88),transparent_48%),linear-gradient(135deg,#1B4565_0%,#112A43_48%,#091827_100%)] p-5 shadow-[inset_0_1px_0_rgba(143,199,235,0.14),0_22px_44px_rgba(0,0,0,0.28)] transition-all duration-300 hover:-translate-y-0.5 hover:border-[#75B3DA]/65 hover:shadow-[inset_0_1px_0_rgba(143,199,235,0.18),0_28px_55px_rgba(0,0,0,0.34)] sm:min-h-[365px] sm:p-7"
                  >
                    <div className="pointer-events-none absolute inset-x-5 top-7 z-0 overflow-hidden text-center sm:inset-x-8 sm:top-8">
                      <span className="font-heading block whitespace-nowrap text-[clamp(3.5rem,10vw,8.5rem)] font-black leading-none tracking-[0.11em] text-white/[0.13]">
                        BEYONIX
                      </span>
                    </div>
                    <div className="pointer-events-none absolute -right-20 -top-24 size-64 rounded-full border border-[#75B3DA]/[0.12] transition-transform duration-500 group-hover:scale-105" />
                    <div className="pointer-events-none absolute -right-8 -top-12 size-48 rounded-full border border-[#75B3DA]/[0.08]" />
                    <div className="pointer-events-none absolute -right-16 top-16 h-12 w-64 rotate-45 bg-[#75B3DA]/[0.035]" />

                    <div className="relative z-10 flex min-h-[300px] flex-col sm:min-h-[309px]">
                      <div className="mt-auto grid gap-6 pt-28 sm:grid-cols-[minmax(210px,0.72fr)_minmax(0,1.28fr)] sm:items-end sm:pt-32 lg:gap-10">
                        <div className="self-center sm:self-end sm:pb-3">
                          <p className="text-10px font-medium uppercase tracking-[0.2em] text-white/45">
                            Un regalo para vos
                          </p>
                          <p className="mt-2 text-4xl font-semibold tracking-tight text-white drop-shadow-sm sm:text-5xl">
                            {formatARS(Number(movement.amount ?? 0))}
                          </p>
                        </div>

                        <div className="rounded-2xl border border-[#5B91BB]/25 bg-[#0A1D30]/90 p-4 shadow-[0_18px_40px_rgba(0,0,0,0.16)] backdrop-blur-md sm:p-5">
                          <div className="border-l-2 border-beyonix-sky/65 pl-4">
                            <p className="text-9px font-semibold uppercase tracking-[0.2em] text-beyonix-sky/70">
                              Dedicatoria
                            </p>
                            <p className="mt-2 line-clamp-3 min-h-6 text-sm font-normal italic leading-6 text-white/90 sm:text-base">
                              “{message}”
                            </p>
                          </div>
                          <div className="mt-5 grid gap-4 border-t border-white/[0.09] pt-4 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-end sm:gap-7">
                            <div className="min-w-0">
                              <p className="text-9px font-medium uppercase tracking-[0.17em] text-white/42">
                                Te la envió
                              </p>
                              <p className="mt-1 truncate text-sm font-medium text-white/82">
                                {senderName}
                              </p>
                            </div>
                            <div className="sm:text-right">
                              <p className="text-9px font-medium uppercase tracking-[0.16em] text-white/42">
                                Emitida
                              </p>
                              <p className="mt-1 text-sm font-semibold text-white/82">
                                {emissionDate}
                              </p>
                            </div>
                            <div className="sm:text-right">
                              <p className="text-9px font-medium uppercase tracking-[0.16em] text-beyonix-sky/65">
                                Vence
                              </p>
                              <p className="mt-1 text-sm font-semibold text-beyonix-sky">
                                {expirationDate
                                  ? expirationDate
                                  : "Sin vencimiento informado"}
                              </p>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </article>
                )
              })}
            </div>
          ) : (
            <div className="mt-6 flex min-h-72 flex-col items-center justify-center rounded-2xl border border-dashed border-[#31506F] bg-[#242424] px-6 text-center">
              <div className="flex size-14 items-center justify-center rounded-2xl border border-[#4F82A8] bg-[#132B40] text-beyonix-sky">
                <Gift className="size-6" />
              </div>
              <h3 className="mt-4 text-base font-medium text-white/88">
                Todavía no recibiste Gift Cards
              </h3>
              <p className="mt-1.5 max-w-sm text-xs font-normal leading-5 text-white/50">
                Cuando alguien te envíe un regalo, vas a encontrarlo acá con su dedicatoria.
              </p>
            </div>
          )}
        </section>
      ) : null}
      </div>
    </AccountPageContainer>
  )
}

const TOPUPS_PER_PAGE = 10

function CargarSaldo({ onBack }: { onBack: () => void }) {
  const { user } = useAuth()
  const proofInputRef = useRef<HTMLInputElement>(null)
  const proofDragDepthRef = useRef(0)
  const [proofFile, setProofFile] = useState<File | null>(null)
  const [lastSubmittedTopupId, setLastSubmittedTopupId] = useState<string | null>(null)
  const [isDraggingProof, setIsDraggingProof] = useState(false)
  const [copiedTransferField, setCopiedTransferField] = useState<"alias" | "cvu" | null>(null)
  const [topups, setTopups] = useState<Array<{
    id: string
    amount?: number | string | null
    proof_file_name?: string | null
    proof_signed_url?: string | null
    status: string
    created_at: string
  }>>([])
  const [topupPage, setTopupPage] = useState(1)
  const [topupTotal, setTopupTotal] = useState(0)
  const [error, setError] = useState("")
  const [saving, setSaving] = useState(false)
  const statusLabels: Record<string, string> = {
    en_revision: "En revisión",
    acreditado: "Acreditado",
    rechazado: "Rechazado",
  }
  const statusClasses: Record<string, string> = {
    en_revision: "text-amber-200/82",
    acreditado: "text-emerald-300/88",
    rechazado: "text-red-200/82",
  }
  const topupTotalPages = Math.max(1, Math.ceil(topupTotal / TOPUPS_PER_PAGE))

  const loadTopups = useCallback(async () => {
    const response = await fetch(`/api/customer-credit/topups?page=${topupPage}`, {
      cache: "no-store",
    })
    const data = (await response.json()) as {
      topups?: typeof topups
      pagination?: {
        total?: number
        total_pages?: number
      }
      error?: string
    }

    if (response.ok) {
      setTopups(data.topups ?? [])
      setTopupTotal(Number(data.pagination?.total ?? 0))
    }
  }, [topupPage])

  useEffect(() => {
    void loadTopups()
  }, [loadTopups])

  useEffect(() => {
    if (topupPage > topupTotalPages) setTopupPage(topupTotalPages)
  }, [topupPage, topupTotalPages])

  useEffect(() => {
    if (!user) return

    const channel = supabase
      .channel(`customer-credit-topups-${user.id}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "customer_credit_topups",
          filter: `user_id=eq.${user.id}`,
        },
        () => void loadTopups(),
      )
      .subscribe()

    return () => {
      void supabase.removeChannel(channel)
    }
  }, [loadTopups, user])

  async function copyTransferValue(field: "alias" | "cvu", value: string) {
    try {
      await navigator.clipboard.writeText(value)
      setCopiedTransferField(field)
      window.setTimeout(() => {
        setCopiedTransferField((current) => current === field ? null : current)
      }, 1800)
    } catch {
      setError("No pudimos copiar el dato. Seleccionalo manualmente.")
    }
  }

  async function submitTopupProof(file: File) {
    if (saving) return

    const previousProofFile = proofFile
    const replaceTopupId = lastSubmittedTopupId
    setProofFile(file)
    setError("")
    setSaving(true)

    try {
      const formData = new FormData()
      formData.set("file", file)
      if (replaceTopupId) formData.set("replace_topup_id", replaceTopupId)

      const response = await fetch("/api/customer-credit/topups", {
        method: "POST",
        body: formData,
      })
      const data = (await response.json()) as {
        error?: string
        topup?: { id?: string }
      }

      if (!response.ok) {
        throw new Error(data.error ?? "No se pudo enviar el comprobante.")
      }

      setLastSubmittedTopupId(data.topup?.id ?? replaceTopupId)
      if (proofInputRef.current) proofInputRef.current.value = ""
      if (topupPage === 1) {
        await loadTopups()
      } else {
        setTopupPage(1)
      }
    } catch (submitError) {
      setProofFile(previousProofFile)
      setError(
        submitError instanceof Error
          ? submitError.message
          : "No se pudo enviar el comprobante.",
      )
    } finally {
      setSaving(false)
    }
  }

  function selectAndUploadProof(file?: File | null) {
    if (!file || saving) return
    void submitTopupProof(file)
  }

  return (
    <AccountPageContainer className="max-w-5xl space-y-4 pb-12">
      <AccountBackButton
        onClick={onBack}
        label="Volver a mi cuenta"
        className="h-10 rounded-full border-[#2A4B6C] bg-[#132033] px-4 text-xs font-medium text-white/82 shadow-sm shadow-black/25 hover:border-[#4B78A4] hover:bg-[#1A2C44] hover:text-white"
      />

      <div className="rounded-2xl border border-[#203A50] bg-[#070C12] p-4 shadow-[0_24px_64px_rgba(0,0,0,0.28)] sm:p-6">
        <header className="border-b border-[#29455C] px-1 pb-5">
          <p className="text-9px font-medium uppercase tracking-[0.18em] text-beyonix-sky/65">
            Saldo de tu cuenta
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-white/95 sm:text-3xl">
            Cargar saldo
          </h1>
          <p className="mt-2 max-w-2xl text-sm font-normal leading-6 text-white/56">
            Transferí a la cuenta de BEYONIX y adjuntá el comprobante. No necesitás ingresar tu nombre, DNI ni el monto: vinculamos la solicitud automáticamente con tu cuenta.
          </p>
        </header>

        <div className="mt-5 grid gap-4 lg:grid-cols-2">
          <section className="flex h-full flex-col rounded-2xl border border-[#315B7D] bg-[#181818] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
            <div className="flex items-center gap-3">
              <span className="flex size-10 items-center justify-center rounded-xl border border-[#4F82A8] bg-[#132B40] text-white">
                <Landmark className="size-4.5" />
              </span>
              <div>
                <p className="text-9px font-medium uppercase tracking-[0.17em] text-beyonix-sky/62">
                  Paso 1
                </p>
                <h2 className="mt-0.5 text-base font-medium text-white/92">
                  Realizá la transferencia
                </h2>
              </div>
            </div>

            <div className="mt-4 overflow-hidden rounded-xl border border-[#3A6283] bg-[#282828]">
              <div className="flex items-center justify-between gap-3 border-b border-[#31506F] px-4 py-3">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="w-12 shrink-0 text-xs font-normal text-white/58">Alias</span>
                  <span className="truncate text-sm font-semibold text-white/90">{TRANSFER_ALIAS}</span>
                </div>
                <button
                  type="button"
                  onClick={() => void copyTransferValue("alias", TRANSFER_ALIAS)}
                  className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-[#4F82A8] bg-[#132B40] px-2.5 text-11px font-medium text-white transition hover:border-beyonix-sky/70 hover:bg-[#1A3B57]"
                  aria-label="Copiar alias"
                >
                  {copiedTransferField === "alias" ? (
                    <CheckCircle2 className="size-3.5 text-white" />
                  ) : (
                    <Copy className="size-3.5 text-white" />
                  )}
                  {copiedTransferField === "alias" ? "Copiado" : "Copiar"}
                </button>
              </div>
              <div className="flex items-center gap-3 border-b border-[#31506F] px-4 py-3.5">
                <span className="w-12 shrink-0 text-xs font-normal text-white/58">Titular</span>
                <span className="truncate text-sm font-medium text-white/90">
                  {TRANSFER_ACCOUNT_HOLDER}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="w-12 shrink-0 text-xs font-normal text-white/58">CVU</span>
                  <span className="truncate text-sm font-medium tabular-nums text-white/90">
                    {TRANSFER_CVU}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => void copyTransferValue("cvu", TRANSFER_CVU)}
                  className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-[#4F82A8] bg-[#132B40] px-2.5 text-11px font-medium text-white transition hover:border-beyonix-sky/70 hover:bg-[#1A3B57]"
                  aria-label="Copiar CVU"
                >
                  {copiedTransferField === "cvu" ? (
                    <CheckCircle2 className="size-3.5 text-white" />
                  ) : (
                    <Copy className="size-3.5 text-white" />
                  )}
                  {copiedTransferField === "cvu" ? "Copiado" : "Copiar"}
                </button>
              </div>
            </div>
            <p className="mt-3 text-xs font-normal leading-5 text-white/52">
              Transferí el importe que quieras incorporar a tu saldo. El monto se confirmará al verificar el ingreso bancario.
            </p>
          </section>

          <section className="flex h-full flex-col rounded-2xl border border-[#315B7D] bg-[#181818] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
            <div className="flex items-center gap-3">
              <span className="flex size-10 items-center justify-center rounded-xl border border-[#4F82A8] bg-[#132B40] text-white">
                <UploadCloud className="size-4.5" />
              </span>
              <div>
                <p className="text-9px font-medium uppercase tracking-[0.17em] text-beyonix-sky/62">
                  Paso 2
                </p>
                <h2 className="mt-0.5 text-base font-medium text-white/92">
                  Enviá el comprobante
                </h2>
              </div>
            </div>

            <input
              ref={proofInputRef}
              type="file"
              accept="image/*,.pdf"
              className="hidden"
              onChange={(event) => selectAndUploadProof(event.target.files?.[0])}
            />

            <button
              type="button"
              disabled={saving}
              onClick={() => proofInputRef.current?.click()}
              onDragEnter={(event) => {
                event.preventDefault()
                proofDragDepthRef.current += 1
                setIsDraggingProof(true)
              }}
              onDragOver={(event) => {
                event.preventDefault()
                event.dataTransfer.dropEffect = "copy"
              }}
              onDragLeave={(event) => {
                event.preventDefault()
                proofDragDepthRef.current = Math.max(0, proofDragDepthRef.current - 1)
                if (proofDragDepthRef.current === 0) setIsDraggingProof(false)
              }}
              onDrop={(event) => {
                event.preventDefault()
                proofDragDepthRef.current = 0
                setIsDraggingProof(false)
                selectAndUploadProof(event.dataTransfer.files?.[0])
              }}
              className={cn(
                "group mt-4 flex min-h-40 w-full flex-1 flex-col items-center justify-center rounded-xl border border-dashed bg-[#282828] px-5 text-center transition disabled:cursor-wait",
                isDraggingProof
                  ? "border-beyonix-sky bg-[#303A43]"
                  : "border-[#4F82A8] hover:border-beyonix-sky/70 hover:bg-[#303030]",
              )}
            >
              {saving ? (
                <Loader2 className="size-6 animate-spin text-white" />
              ) : lastSubmittedTopupId && proofFile ? (
                <CheckCircle2 className="size-6 text-emerald-300" />
              ) : (
                <FileText className="size-6 text-white/85 transition group-hover:text-white" />
              )}
              <span className="mt-3 max-w-full truncate text-sm font-medium text-white/88">
                {saving
                  ? "Enviando comprobante..."
                  : proofFile?.name ?? "Seleccioná o arrastrá tu comprobante"}
              </span>
              <span className="mt-1 text-10px font-normal text-white/45">
                {lastSubmittedTopupId && proofFile && !saving
                  ? "Comprobante enviado correctamente"
                  : "JPG, PNG o PDF · Máximo 5 MB · Se enviará automáticamente"}
              </span>
            </button>

            <div className="mt-3 flex min-h-8 items-center justify-center gap-2 text-center">
              {lastSubmittedTopupId && !saving ? (
                <>
                  <span className="text-xs font-normal text-white/55">
                    ¿Te equivocaste de archivo?
                  </span>
                  <button
                    type="button"
                    onClick={() => proofInputRef.current?.click()}
                    className="inline-flex h-7 items-center justify-center rounded-lg border border-[#4F82A8] bg-[#132B40] px-2.5 text-11px font-semibold text-white transition hover:border-beyonix-sky/70 hover:bg-[#1A3B57]"
                  >
                    Cambiarlo
                  </button>
                </>
              ) : (
                <span className="text-11px font-normal text-white/42">
                  {saving ? "No cierres esta página durante el envío." : "La carga comenzará al elegir el archivo."}
                </span>
              )}
            </div>

            {error ? (
              <p className="mt-1 text-center text-11px font-normal text-red-200/85">{error}</p>
            ) : null}
          </section>
        </div>

        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <section className="rounded-xl border border-[#315B7D] bg-[#202020] p-4">
            <div className="flex gap-3">
              <Clock3 className="mt-0.5 size-4.5 shrink-0 text-white" />
              <div>
                <h2 className="text-sm font-medium text-white/90">Horarios de validación</h2>
                <p className="mt-1 text-xs font-normal leading-5 text-white/62">
                  {BEYONIX_SUPPORT_HOURS}. Los comprobantes enviados fuera de ese horario se revisan el próximo día hábil.
                </p>
              </div>
            </div>
          </section>

          <section className="rounded-xl border border-amber-300/25 bg-[#24211A] p-4">
            <div className="flex gap-3">
              <AlertTriangle className="mt-0.5 size-4.5 shrink-0 text-white" />
              <div>
                <h2 className="text-sm font-medium text-amber-50/90">Importante</h2>
                <p className="mt-1 text-xs font-normal leading-5 text-amber-50/65">
                  Si la transferencia no ingresa a nuestra cuenta o el comprobante no es válido, el saldo no será acreditado.
                </p>
              </div>
            </div>
          </section>
        </div>

        <section className="mt-4 rounded-2xl border border-[#315B7D] bg-[#181818] p-5">
          <h2 className="text-sm font-medium text-white/90">Comprobantes enviados</h2>

          {topups.length ? (
            <div className="mt-3 space-y-2">
              {topups.map((topup) => (
                <div
                  key={topup.id}
                  className="grid grid-cols-2 items-center gap-x-4 gap-y-3 rounded-lg border border-[#31506F] bg-[#282828] px-4 py-3 lg:grid-cols-4"
                >
                  <p className="min-w-0 text-base font-semibold text-white lg:justify-self-center lg:text-center">
                    {topup.status === "acreditado" && Number(topup.amount ?? 0) > 0
                      ? formatARS(Number(topup.amount))
                      : topup.status === "rechazado"
                        ? "Sin acreditar"
                        : "Monto a confirmar"}
                  </p>
                  <p className="min-w-0 text-base font-normal text-white lg:justify-self-center lg:text-center">
                    {formatOrderCardDate(topup.created_at)}
                  </p>
                  <span className={cn(
                    "inline-flex w-fit items-center gap-1.5 justify-self-start text-base font-medium lg:justify-self-center",
                    statusClasses[topup.status] ?? "text-white/60",
                  )}>
                    {topup.status === "acreditado" ? (
                      <CheckCircle2 className="size-4" />
                    ) : topup.status === "rechazado" ? (
                      <X className="size-4" />
                    ) : (
                      <Clock3 className="size-4" />
                    )}
                    {statusLabels[topup.status] ?? topup.status}
                  </span>
                  <div className="justify-self-end lg:justify-self-center">
                    {topup.proof_signed_url ? (
                      <a
                        href={topup.proof_signed_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex h-9 w-fit items-center justify-center gap-1.5 rounded-lg border border-[#4F82A8] bg-[#132B40] px-3 text-xs font-semibold text-white transition hover:border-beyonix-sky/70 hover:bg-[#1A3B57]"
                      >
                        <Eye className="size-3.5" />
                        Comprobante
                      </a>
                    ) : null}
                  </div>
                </div>
              ))}

              <div className="flex items-center justify-between gap-3 pt-2">
                <p className="text-10px font-normal text-white/42">
                  Página {topupPage} de {topupTotalPages} · {topupTotal} comprobante{topupTotal === 1 ? "" : "s"}
                </p>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={topupPage <= 1}
                    onClick={() => setTopupPage((current) => Math.max(1, current - 1))}
                    aria-label="Página anterior de comprobantes"
                    className="inline-flex size-8 items-center justify-center rounded-lg border border-[#3A6283] bg-[#132B40] text-white transition hover:border-beyonix-sky/70 disabled:cursor-not-allowed disabled:opacity-30"
                  >
                    <ChevronLeft className="size-4" />
                  </button>
                  <button
                    type="button"
                    disabled={topupPage >= topupTotalPages}
                    onClick={() => setTopupPage((current) => Math.min(topupTotalPages, current + 1))}
                    aria-label="Página siguiente de comprobantes"
                    className="inline-flex size-8 items-center justify-center rounded-lg border border-[#3A6283] bg-[#132B40] text-white transition hover:border-beyonix-sky/70 disabled:cursor-not-allowed disabled:opacity-30"
                  >
                    <ChevronRight className="size-4" />
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <p className="mt-3 rounded-lg border border-dashed border-[#31506F] bg-[#282828] px-3 py-5 text-center text-xs font-normal text-white/56">
              Todavía no enviaste comprobantes.
            </p>
          )}
        </section>
      </div>
    </AccountPageContainer>
  )
}

function ProfilePanel({ initialView }: { initialView: ProfileView }) {
  const { user, logout, isInternal } = useAuth()
  const customerCredit = useCustomerCredit()
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
  if (view === "saldo") {
    return (
      <MiSaldo
        onBack={() => goToView("home")}
        onLoadBalance={() => goToView("cargar-saldo")}
      />
    )
  }
  if (view === "cargar-saldo") return <CargarSaldo onBack={() => goToView("home")} />
  if (view === "datos") return <MisDatos onBack={() => goToView("home")} />
  if (view === "seguridad") return <Seguridad onBack={() => goToView("home")} />

  const menuItems: Array<{
    icon: typeof ShoppingBag
    label: string
    sub: string
    filled?: boolean
    dollarBadge?: boolean
    danger?: boolean
    view?: ProfileView
    href?: string
  }> = [
    { icon: ShoppingBag, label: "Mis compras", sub: "Historial de compras", view: "ordenes" as ProfileView },
    { icon: CreditCard, label: "BEYONIX Gift Card", sub: "Enviá y recibí regalos", view: "saldo" as ProfileView },
    { icon: Heart, label: "Favoritos", sub: "Productos guardados", filled: true, href: "/cuenta/favoritos" },
    { icon: IdCard, label: "Mis datos", sub: "Nombre, email y dirección", view: "datos" as ProfileView },
    { icon: LockKeyhole, label: "Seguridad", sub: "Contraseña y acceso", view: "seguridad" as ProfileView },
    { icon: AlertTriangle, label: "Eliminar cuenta", sub: "Acción permanente", danger: true, href: "/cuenta/eliminar" },
  ]

  return (
    <AccountPageContainer className="max-w-[1160px] space-y-4">
      <AccountPageHeader
        eyebrow="Mi cuenta"
        title={`Hola, ${(user.username || user.name.split(" ")[0]).toUpperCase()}`}
        className="border-transparent bg-transparent p-0 shadow-none"
      />

      <div className="grid gap-5 lg:grid-cols-[minmax(270px,0.32fr)_minmax(0,0.68fr)]">
        <AccountCard
          padding="md"
          className="self-start"
        >
          <div className="flex items-center gap-3">
            <div className="flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-full border border-white/14 bg-white text-black shadow-sm shadow-black/35">
              {user.avatarUrl ? (
                <img src={user.avatarUrl} alt="" className="size-full object-cover" />
              ) : (
                <User className="size-8" />
              )}
            </div>
            <div className="min-w-0">
              <p className="truncate text-base font-semibold text-[var(--account-text-primary)]">{user.name}</p>
              <p className="truncate text-sm text-[var(--account-text-secondary)]">{user.email}</p>
              <p className="mt-1 text-10px font-medium uppercase tracking-widest text-[var(--account-accent-soft)]">
                Cliente BEYONIX
              </p>
            </div>
          </div>

          <button
            type="button"
            aria-label="Ver y cargar saldo"
            onClick={() => goToView("cargar-saldo")}
            className="group mt-4 flex w-full cursor-pointer items-center justify-between gap-3 rounded-xl border border-[var(--account-border)] bg-[var(--account-surface-raised)] px-3 py-2.5 text-left transition hover:border-beyonix-blue-light/45 hover:bg-[var(--account-surface-hover)]"
          >
            <span className="flex min-w-0 items-center gap-3">
              <IconContainer size="sm" dollarBadge>
                <Coins className="stroke-[2.35]" />
              </IconContainer>
              <span className="min-w-0">
                <span className="block text-10px font-semibold uppercase tracking-widest text-[var(--account-accent-soft)]">
                  Saldo disponible
                </span>
                <span className="mt-0.5 block text-lg font-black text-white">
                  {formatARS(customerCredit.balance)}
                </span>
              </span>
            </span>
            <span className="inline-flex shrink-0 items-center gap-1 text-10px font-semibold text-beyonix-sky/75 transition group-hover:text-white">
              Cargar saldo
              <ChevronRight className="size-3.5" />
            </span>
          </button>

          <div className="mt-4 border-t border-[var(--account-border-subtle)] pt-4">
            <button
              type="button"
              aria-label="Cerrar sesión"
              onClick={() => { logout(); router.push("/") }}
              className="account-logout-button group"
            >
              <span className="account-logout-button__icon">
                <LogOut className="size-4 stroke-[2.3]" />
              </span>
              <span className="account-logout-button__label">Cerrar sesión</span>
            </button>
          </div>
        </AccountCard>

        <div className="min-w-0 space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            {menuItems.map((item) => (
              <AccountCard
                asChild
                variant="interactive"
                padding="sm"
                key={item.label}
                className={cn(
                  "min-h-[104px] bg-[var(--account-surface-raised)]",
                  item.danger &&
                    "border-red-400/18 hover:border-red-400/45 hover:bg-red-500/8",
                )}
              >
                <button
                  type="button"
                  aria-label={item.label}
                  onClick={() => {
                    if (item.href) {
                      router.push(item.href)
                      return
                    }

                    if (item.view) {
                      goToView(item.view)
                    }
                  }}
                  className="group flex w-full cursor-pointer items-center gap-4 text-left"
                >
                  <IconContainer
                    dollarBadge={item.dollarBadge}
                    className={
                      item.danger
                        ? "border-red-400/24 bg-red-500/10 text-red-300 group-hover:border-red-400/55 group-hover:text-red-400"
                        : undefined
                    }
                  >
                    <item.icon
                      className={`size-5 stroke-[2.35] drop-shadow-[0_0_5px_rgba(255,255,255,0.22)] ${
                        item.filled ? "fill-white" : "fill-none"
                      }`}
                    />
                  </IconContainer>
                  <div className="min-w-0 flex-1">
                    <p
                      className={cn(
                        "text-sm font-semibold text-[var(--account-text-primary)]",
                        item.danger && "text-red-200 group-hover:text-red-300",
                      )}
                    >
                      {item.label}
                    </p>
                    <p className="mt-0.5 text-xs text-[var(--account-text-secondary)]">{item.sub}</p>
                  </div>
                  <ChevronRight
                    className={cn(
                      "size-4 shrink-0 text-[var(--account-text-muted)] transition-colors group-hover:text-[var(--account-text-primary)]",
                      item.danger && "group-hover:text-red-300",
                    )}
                  />
                </button>
              </AccountCard>
            ))}
          </div>

          {isInternal && (
            <AccountCard
              asChild
              variant="interactive"
              padding="sm"
              className="border-[var(--account-border-highlight)] bg-[rgba(9,21,34,0.92)] hover:bg-[rgba(17,42,67,0.74)]"
            >
              <button
                type="button"
                aria-label="Ir al panel admin"
                onClick={() => router.push("/admin")}
                className="group flex min-h-[82px] w-full cursor-pointer items-center gap-4 text-left"
              >
                <IconContainer>
                  <ShieldCheck className="size-5 fill-white/10 stroke-[2.35] drop-shadow-[0_0_5px_rgba(255,255,255,0.22)]" />
                </IconContainer>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-white">Panel administrador</p>
                  <p className="text-xs text-white/55">Gestión de tienda</p>
                </div>
                <ChevronRight className="size-4 shrink-0 text-white/25 transition-colors group-hover:text-white/70" />
              </button>
            </AccountCard>
          )}
        </div>
      </div>
    </AccountPageContainer>
  )
}

export function CompraDetalleClient({ orderId }: { orderId: number }) {
  const { user, isLoading } = useAuth()
  const router = useRouter()
  const searchParams = useSearchParams()
  const authenticatedUserId = user?.id ?? ""
  const authenticatedUserEmail = user?.email ?? ""
  const hasAuthenticatedUser = Boolean(authenticatedUserId || authenticatedUserEmail)
  const [order, setOrder] = useState<SupabasePedido | null>(null)
  const loadedOrderIdRef = useRef<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [downloadingInvoice, setDownloadingInvoice] = useState(false)
  const [downloadingCreditNote, setDownloadingCreditNote] = useState(false)
  const [cancelModalOpen, setCancelModalOpen] = useState(false)
  const [cancellingOrder, setCancellingOrder] = useState(false)
  const [cancelError, setCancelError] = useState("")
  const [refundProofOpening, setRefundProofOpening] = useState(false)
  const [refundProofError, setRefundProofError] = useState("")

  useLayoutEffect(() => {
    window.scrollTo({ top: 0, behavior: "auto" })
  }, [orderId])

  useEffect(() => {
    if (searchParams.get("section") !== "reclamo") return
    router.replace(`/cuenta/compras/${orderId}`)
  }, [orderId, router, searchParams])

  useEffect(() => {
    if (isLoading) return
    if (!hasAuthenticatedUser) {
      router.replace(`/login?redirect=/cuenta/compras/${orderId}`)
      return
    }

    let active = true

    async function loadOrder() {
      if (loadedOrderIdRef.current !== orderId) setLoading(true)
      setError("")
      const { data, error: orderError } = await supabase
        .from("ordenes")
        .select(ACCOUNT_ORDER_SELECT)
        .eq("id", orderId)
        .maybeSingle()

      if (!active) return

      if (orderError || !data) {
        setError("No encontramos esta compra.")
        setLoading(false)
        return
      }

      const currentOrder = data as SupabasePedido
      const userValues = [authenticatedUserId, authenticatedUserEmail]
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

      setOrder({
        ...currentOrder,
        order_claims:
          currentOrder.order_claims && currentOrder.order_claims.length > 0
            ? currentOrder.order_claims
            : await getOrderClaims(currentOrder.id),
      })
      loadedOrderIdRef.current = currentOrder.id
      setLoading(false)
    }

    void loadOrder()
    return () => { active = false }
  }, [authenticatedUserEmail, authenticatedUserId, hasAuthenticatedUser, isLoading, orderId, router])

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

  const hasCurrentOrder = order?.id === orderId

  if (!hasAuthenticatedUser || ((isLoading || loading) && !hasCurrentOrder)) {
    return <OrderPageLoadingState />
  }

  if (!order || !hasCurrentOrder) {
    return <main className="min-h-screen bg-[#05070A] px-4 pt-28"><div className="mx-auto max-w-3xl rounded-2xl border border-white/10 bg-[#0D1117] p-6 text-center"><p className="text-sm font-bold text-white">{error || "No encontramos esta compra."}</p><button type="button" onClick={() => router.push("/cuenta?tab=ordenes")} className="mt-4 h-10 rounded-lg bg-[#112A43] px-4 text-xs font-black text-white">Volver a Mis compras</button></div></main>
  }

  const items = order.orden_items ?? []
  const productsSubtotal = items.reduce(
    (sum, item) => sum + Number(item.precio ?? 0) * Number(item.cantidad ?? 0),
    0,
  )
  const discount = Number(order.transfer_discount_amount ?? 0)
  const creditBalanceUsed = Number(order.credit_balance_used ?? 0)
  const externalAmountDue = Number(
    order.external_amount_due ?? Math.max(Number(order.total ?? 0) - creditBalanceUsed, 0)
  )
  const shipping = Number(
    order.shipping_cost_charged ?? Math.max(0, Number(order.total) + discount - productsSubtotal),
  )
  const invoiceAvailable = isInvoiceAvailable(order)
  const hasProof = Boolean(order.payment_proof_url)
  const paymentStatus = (order.payment_status ?? "pendiente_comprobante").toLowerCase()
  const isTransferPayment = order.payment_method_id === "transferencia"
  const paymentConfirmed = isOrderPaymentConfirmed(order)
  const status = getClientOrderStatusBadge(order)
  const isCancelled = (order.estado ?? "").toLowerCase() === "cancelado"
  const orderDelivered = isOrderDetailDelivered(order)
  const trackingNumber = order.andreani_tracking || order.tracking_number || ""
  const trackingUrl = normalizeTrackingUrl(order.tracking_url)
  const rawShippingProvider = (
    order.envio_proveedor ||
    order.shipping_provider ||
    ""
  ).trim()
  const shippingProvider =
    rawShippingProvider.toLowerCase() === "andreani"
      ? "Andreani"
      : rawShippingProvider
  const showClaimHelp = canShowOrderClaimHelp(order)
  const existingClaim = orderDelivered
    ? getLatestFormalCustomerClaim(order.order_claims)
    : getLatestCustomerClaim(order.order_claims)
  const existingHelpMessage = !orderDelivered && existingClaim?.failure_type === "consulta_pedido"
  const showPreDeliveryHelp = !isCancelled && !orderDelivered && !showClaimHelp
  const claimHelpTitle = existingClaim
    ? existingHelpMessage
      ? "Ver mensaje de ayuda"
      : "Ver reclamo"
    : "Iniciar reclamo"
  const claimHelpAriaLabel = existingClaim
    ? existingHelpMessage
      ? `Ver mensaje de ayuda del pedido ${formatPublicOrderId(order.id)}`
      : `Ver reclamo del pedido ${formatPublicOrderId(order.id)}`
    : `Iniciar reclamo del pedido ${formatPublicOrderId(order.id)}`
  const claimDetailStatus = getCustomerClaimDetailStatus(existingClaim)
  const canCancelOrder =
    !isCancelled &&
    !orderDelivered &&
    !isOrderDetailDispatched(order)
  const showPaymentProofSection =
    isTransferPayment &&
    !paymentConfirmed &&
    !isCancelled &&
    CUSTOMER_PAYMENT_PROOF_EDITABLE_STATUSES.includes(paymentStatus)

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
        ? "Cancelado · reintegro pendiente"
        : "Pedido cancelado"
    const headerRefundStatusClassName = refunded
      ? "border-emerald-300/30 bg-[#123329] text-emerald-50"
      : refundPending
        ? "border-amber-300/35 bg-amber-400/12 text-amber-100"
        : "border-[#3b4656] bg-[#252B33] text-zinc-100"
    return (
      <main className="relative isolate min-h-screen overflow-hidden bg-[#070B11] px-3 py-24 font-heading sm:px-5 lg:px-8">
        <div className="relative z-20 mx-auto flex min-h-[calc(100vh-12rem)] max-w-[860px] flex-col justify-center">
          <button
            type="button"
            onClick={() => router.push("/cuenta?tab=ordenes")}
            className="mb-3 inline-flex h-9 w-fit cursor-pointer items-center gap-2 rounded-lg border border-[#2a4b6c] bg-[#132033] px-3.5 text-xs font-medium text-white/84 shadow-sm shadow-black/20 transition-colors hover:border-[#4b78a4] hover:bg-[#1a2c44] hover:text-white"
          >
            <ChevronLeft className="size-4" />
            Volver a Mis compras
          </button>

          <section
            className="relative isolate z-30 overflow-hidden rounded-2xl border border-[#223249] !bg-[#101114] bg-none p-3 shadow-[0_18px_44px_#000000] sm:p-4"
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

            <div className="relative z-20 mt-3">
              <div className="space-y-3">
                <section className={`rounded-xl border px-4 py-4 shadow-[0_18px_42px_rgba(0,0,0,0.28)] ${
                  refunded
                    ? "border-emerald-300/30 bg-[linear-gradient(135deg,#102A22,#0c1519)]"
                    : refundPending
                      ? "border-[#315f85] bg-[linear-gradient(135deg,#101a25,#111317)]"
                      : "border-[#315f85] bg-[linear-gradient(135deg,#111b27,#111317)]"
                }`}>
                  <div className="flex flex-col items-center gap-4 text-center sm:flex-row sm:items-start sm:text-left">
                    <span className={`flex size-12 shrink-0 items-center justify-center rounded-full border shadow-[0_0_28px_rgba(120,190,255,0.16)] ${
                      refunded
                        ? "border-emerald-200/35 bg-[#123329]"
                        : refundPending
                          ? "border-[#7fb9ef]/35 bg-[#13263a]"
                          : "border-[#7fb9ef]/35 bg-[#13263a]"
                    }`}>
                      <CheckCircle2 className={`size-6 ${refunded ? "text-emerald-200" : "text-[#b8d7f4]"}`} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-10px font-medium uppercase tracking-[0.22em] text-[#9fd8ff]">
                        Estado de compra
                      </p>
                      <h2 className="mt-1 text-xl font-bold leading-tight text-white sm:text-2xl">
                        Pedido cancelado correctamente
                      </h2>
                      <p className="mt-1.5 max-w-3xl text-sm font-normal leading-5 text-white/78">
                        {refunded
                          ? "El pedido fue cancelado y el dinero ya fue reintegrado."
                          : refundPending
                            ? "La cancelación quedó registrada. Estamos gestionando el reintegro correspondiente."
                            : "El pedido quedó cancelado y no requiere acciones adicionales."}
                      </p>
                      <dl className="mt-4 grid gap-2 text-left sm:grid-cols-2">
                        <div className="rounded-lg border border-white/8 bg-black/20 px-3 py-2.5">
                          <dt className="text-9px font-medium uppercase tracking-[0.18em] text-[#91a8be]">Pedido</dt>
                          <dd className="mt-1 text-sm font-medium text-white">{formatPublicOrderId(order.id)}</dd>
                        </div>
                        <div className="rounded-lg border border-white/8 bg-black/20 px-3 py-2.5">
                          <dt className="text-9px font-medium uppercase tracking-[0.18em] text-[#91a8be]">Fecha</dt>
                          <dd className="mt-1 truncate text-sm font-medium text-white">{formatOrderCardDate(order.created_at)}</dd>
                        </div>
                        <div className="rounded-lg border border-white/8 bg-black/20 px-3 py-2.5">
                          <dt className="text-9px font-medium uppercase tracking-[0.18em] text-[#91a8be]">Estado</dt>
                          <dd className="mt-1 truncate text-sm font-medium text-white">{refundStatusLabel}</dd>
                        </div>
                        <div className="rounded-lg border border-white/8 bg-black/20 px-3 py-2.5">
                          <dt className="text-9px font-medium uppercase tracking-[0.18em] text-[#91a8be]">Total</dt>
                          <dd className="mt-1 text-sm font-medium text-white">{formatCuentaPrice(Number(order.total ?? 0))}</dd>
                        </div>
                      </dl>
                    </div>
                  </div>
                </section>

                {refundFlow && (
                  <section className="rounded-xl border border-[#28435e] bg-[#0f1824] px-3.5 py-3 shadow-[0_14px_36px_rgba(0,0,0,0.26)]">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <p className="text-10px font-medium uppercase tracking-[0.18em] text-[#9fd8ff]">
                          Reintegro
                        </p>
                        <p className="mt-0.5 text-sm font-medium text-white">
                          {refunded ? "Dinero reintegrado" : "Gestión de reintegro pendiente"}
                        </p>
                      </div>
                      <p className="text-xs font-normal text-[#9fb3c9]">
                        {cancellationDate ? formatOrderCardDate(cancellationDate) : "Solicitud recibida"}
                      </p>
                    </div>

                    {(refundProofAvailable || creditNoteAvailable) && (
                      <div className="mt-2 flex flex-wrap gap-2">
                        {refundProofAvailable && (
                          <button
                            type="button"
                            aria-label="Ver comprobante de reintegro"
                            disabled={refundProofOpening}
                            onClick={() => void handleOpenRefundProof()}
                            className={cn(beyonixHoverBorder, "inline-flex h-8 cursor-pointer items-center gap-2 rounded-lg border-beyonix-blue-light/25 bg-[#112A43] px-3 text-xs font-medium text-white transition disabled:cursor-wait disabled:opacity-60")}
                          >
                            <Eye className="size-3.5" />
                            Comprobante
                          </button>
                        )}
                        {creditNoteAvailable && (
                          <button
                            type="button"
                            aria-label="Descargar nota de crédito"
                            disabled={downloadingCreditNote}
                            onClick={() => void handleDownloadInvoice("credit_note")}
                            className={cn(beyonixHoverBorder, "inline-flex h-8 cursor-pointer items-center gap-2 rounded-lg border-beyonix-blue-light/25 bg-[#112A43] px-3 text-xs font-medium text-white transition disabled:cursor-wait disabled:opacity-60")}
                          >
                            <Download className="size-3.5" />
                            Nota de crédito
                          </button>
                        )}
                      </div>
                    )}

                    {refundProofError && (
                      <p className="mt-2 text-xs font-normal text-red-200">
                        {refundProofError}
                      </p>
                    )}

                    {order.refund_observation && (
                      <p className="mt-2 rounded-lg border border-emerald-300/18 bg-[#102A22] px-3 py-2 text-xs font-normal leading-5 text-emerald-50/82">
                        {order.refund_observation}
                      </p>
                    )}

                    {orderDispatched && (
                      <p className="mt-2 flex gap-2 rounded-lg border border-[#6f4b55]/70 bg-[#21171c] px-3 py-2 text-xs font-normal leading-5 text-[#efd8dd]">
                        <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-[#e9b8c1]" />
                        {shippingChargeDetail}
                      </p>
                    )}
                  </section>
                )}

              <section className="rounded-xl border border-[#28435e] bg-[#0f1824] p-3.5 shadow-[0_14px_36px_rgba(0,0,0,0.34)]">
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
            </div>
          </section>
        </div>
      </main>
    )
  }

  return (
    <main className="order-detail-solid-surface min-h-screen bg-[#05070A] px-3 pb-10 pt-24 font-heading sm:px-5 lg:px-8">
      <div className="mx-auto max-w-[1200px]">
        <button type="button" onClick={() => router.push("/cuenta?tab=ordenes")} className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-full border border-white/12 bg-[#0D1117] px-4 text-sm font-bold text-white/80 transition-colors hover:border-blue-300/35 hover:text-white"><ChevronLeft className="size-4" />Volver a Mis compras</button>

        <header className="mt-4 rounded-2xl border border-[#18334D] bg-[#0B1118] p-3.5 shadow-[0_0_22px_rgba(17,42,67,0.16)] sm:p-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <p className="text-10px font-semibold uppercase tracking-[0.18em] text-blue-300">Detalle de compra</p>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <h1 className="text-xl font-black text-white sm:text-2xl">Pedido #{formatPublicOrderId(order.id)}</h1>
                {invoiceAvailable && (
                  <button
                    type="button"
                    disabled={downloadingInvoice}
                    onClick={() => void handleDownloadInvoice()}
                    className={cn(beyonixHoverBorder, "inline-flex h-8 cursor-pointer items-center justify-center gap-2 rounded-lg border-beyonix-blue-light/25 bg-[#112A43] px-3.5 text-xs font-black text-white disabled:cursor-not-allowed disabled:opacity-60")}
                  >
                    <Download className="size-3.5" />
                    {downloadingInvoice ? "Preparando..." : "Ver factura"}
                  </button>
                )}
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs font-medium text-white/58"><span>{formatOrderCardDate(order.created_at)}</span><span className={`rounded-full border px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${status.className}`}>{status.label}</span></div>
            </div>
            <div className="flex flex-col gap-2 lg:items-end">
              <div className="flex min-h-16 items-center justify-center rounded-xl border border-emerald-300/35 bg-[#102A22] px-5 py-3 text-center shadow-[0_14px_32px_rgba(16,185,129,0.1)] lg:min-w-48">
                <div>
                  <p className="text-10px font-semibold uppercase tracking-[0.16em] text-emerald-200">Total pagado</p>
                  <p className="mt-1.5 text-xl font-bold leading-none text-emerald-50">{formatCuentaPrice(Number(order.total))}</p>
                </div>
              </div>
            </div>
          </div>
        </header>

        {error && <p className="mt-3 rounded-xl border border-red-300/20 bg-red-500/10 px-4 py-3 text-sm font-bold text-red-200">{error}</p>}

        <div className="mt-3">
          <OrderProgressTimeline order={order} />
        </div>

        <div className="order-detail-components-shell mt-3 grid items-start gap-4 p-3 sm:p-4 lg:grid-cols-[minmax(0,1.62fr)_minmax(315px,0.78fr)]">
          <div className="space-y-4">
            <section className="rounded-2xl border border-[#18334D] bg-[#101923] p-3.5 sm:p-4">
              <h2 className="text-sm font-bold text-white">Productos comprados</h2>
              <div className="mt-3 space-y-2">
                {items.map((item) => {
                  const quantity = Number(item.cantidad ?? 0)
                  const unitPrice = Number(item.precio ?? 0)
                  const name = item.productos?.nombre ?? `Producto #${item.producto_id}`
                  const image = getCuentaItemImage(item)
                  return <div key={item.id} className="grid gap-3 rounded-xl border border-[#21476B] bg-[#13263B] px-3 py-2.5 sm:grid-cols-[minmax(0,1.5fr)_repeat(3,minmax(90px,0.55fr))] sm:items-center">
                    <div className="flex min-w-0 items-center gap-3"><div className="flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-white">{image ? <img src={image} alt={name} className="size-full object-contain" /> : <ShoppingBag className="size-4 text-black/30" />}</div><div className="min-w-0"><p className="truncate text-sm font-semibold text-white">{name}</p><p className="mt-0.5 text-xs font-normal text-white/55">{getCuentaItemColor(item)}</p></div></div>
                    <div className="sm:text-center"><p className="text-9px font-semibold uppercase tracking-widest text-white/40">Cantidad</p><p className="mt-0.5 text-sm font-bold text-white">{quantity}</p></div>
                    <div className="sm:text-center"><p className="text-9px font-semibold uppercase tracking-widest text-white/40">Precio unitario</p><p className="mt-0.5 text-sm font-bold text-white">{formatCuentaPrice(unitPrice)}</p></div>
                    <div className="sm:text-center"><p className="text-9px font-semibold uppercase tracking-widest text-white/40">Subtotal</p><p className="mt-0.5 text-sm font-bold text-white">{formatCuentaPrice(unitPrice * quantity)}</p></div>
                  </div>
                })}
              </div>
            </section>

            {(showPaymentProofSection || !orderDelivered) && (
              <section className="rounded-2xl border border-beyonix-blue-500/50 bg-beyonix-gray-900 p-3.5 sm:p-4">
                <h2 className="text-sm font-bold text-white">
                  Gestión del pedido
                </h2>

                <div
                  className={cn(
                    "mt-3 grid gap-3",
                    showPaymentProofSection && !orderDelivered
                      ? "sm:grid-cols-2 sm:divide-x sm:divide-beyonix-gray-700"
                      : "grid-cols-1",
                  )}
                >
                  {showPaymentProofSection && (
                    <div
                      className={cn(
                        "flex min-w-0 flex-col",
                        !orderDelivered && "sm:pr-3",
                      )}
                    >
                      <p className="text-xs font-bold text-white">
                        Comprobante
                      </p>
                      <p className="mt-0.5 text-xs font-medium text-beyonix-gray-500">
                        {hasProof
                          ? "El comprobante ya fue cargado."
                          : "Pendiente de carga."}
                      </p>
                      <div className="mt-auto space-y-2 pt-3">
                        {hasProof ? (
                          <>
                            <PaymentProofViewButton
                              order={order}
                              className="h-9 w-full"
                            />
                            <PaymentProofActionButton
                              orderId={order.id}
                              initialUploaded
                              onUploaded={handleProofUploaded}
                              label="Cambiar comprobante"
                              className={cn(
                                beyonixHoverBorder,
                                "inline-flex h-9 w-full cursor-pointer items-center justify-center gap-2 rounded-lg border-beyonix-blue-500/50 bg-beyonix-blue-700 px-4 text-xs font-black text-white hover:border-beyonix-blue-300 hover:bg-beyonix-blue-500 disabled:opacity-60",
                              )}
                            />
                          </>
                        ) : (
                          <PaymentProofActionButton
                            orderId={order.id}
                            onUploaded={handleProofUploaded}
                            label="Subir comprobante"
                            className={cn(
                              beyonixHoverBorder,
                              "inline-flex h-9 w-full cursor-pointer items-center justify-center gap-2 rounded-lg border-beyonix-blue-500/50 bg-beyonix-blue-700 px-4 text-xs font-black text-white hover:border-beyonix-blue-300 hover:bg-beyonix-blue-500 disabled:opacity-60",
                            )}
                          />
                        )}
                      </div>
                    </div>
                  )}

                  {!orderDelivered && (
                    <div
                      className={cn(
                        "flex min-w-0 flex-col",
                        showPaymentProofSection &&
                          "border-t border-beyonix-gray-700 pt-3 sm:border-t-0 sm:pt-0 sm:pl-3",
                      )}
                    >
                      <p className="text-xs font-bold text-white">
                        Seguimiento
                      </p>
                      {shippingProvider && (
                        <p className="mt-0.5 text-xs font-semibold text-white">
                          {shippingProvider}
                        </p>
                      )}
                      <p className="mt-0.5 text-xs font-medium text-beyonix-gray-500">
                        {trackingNumber
                          ? `Código: ${trackingNumber}`
                          : "Disponible después del despacho."}
                      </p>
                      <div className="pt-3">
                        {trackingUrl ? (
                          <a
                            href={trackingUrl}
                            target="_blank"
                            rel="noreferrer"
                            aria-label={`Ver seguimiento del pedido ${formatPublicOrderId(order.id)}`}
                            title="Ver seguimiento"
                            className={cn(
                              beyonixHoverBorder,
                              "inline-flex h-9 w-full cursor-pointer items-center justify-center rounded-lg border-beyonix-blue-500/50 bg-beyonix-blue-700 px-4 text-xs font-black text-white hover:border-beyonix-blue-300 hover:bg-beyonix-blue-500",
                            )}
                          >
                            Ver seguimiento
                          </a>
                        ) : (
                          <button
                            type="button"
                            aria-label="Seguimiento no disponible"
                            title="Seguimiento no disponible"
                            disabled
                            className="inline-flex h-9 w-full cursor-not-allowed items-center justify-center rounded-lg border border-beyonix-gray-700 bg-beyonix-gray-900 px-4 text-xs font-black text-beyonix-gray-500 opacity-75"
                          >
                            Seguimiento no disponible
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </section>
            )}

            {showPreDeliveryHelp && (
              <section className="rounded-2xl border border-beyonix-blue-500/50 bg-beyonix-gray-900 p-3.5 sm:p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <h2 className="text-sm font-bold text-white">
                      ¿Necesitás ayuda?
                    </h2>
                    <p className="mt-1 text-xs font-medium leading-5 text-beyonix-gray-300">
                      {existingClaim
                        ? "Ya recibimos tu mensaje. Podés ver el seguimiento desde acá."
                        : "Si tuviste un problema con tu pedido, contactanos para que podamos ayudarte."}
                    </p>
                    {claimDetailStatus && (
                      <div
                        className={`mt-2 inline-flex rounded-lg border px-2.5 py-1.5 text-xs font-black ${claimDetailStatus.className}`}
                      >
                        {claimDetailStatus.label}
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    aria-label={`Enviar mensaje de ayuda del pedido ${formatPublicOrderId(order.id)}`}
                    title={
                      existingClaim
                        ? "Ver mensaje de ayuda"
                        : "Contactanos"
                    }
                    onClick={() =>
                      router.push(`/cuenta/compras/${order.id}/ayuda`)
                    }
                    className={cn(
                      beyonixHoverBorder,
                      "inline-flex h-9 w-full shrink-0 cursor-pointer items-center justify-center gap-2 rounded-lg border-beyonix-blue-500/50 bg-beyonix-blue-700 px-4 text-xs font-black text-white transition-colors duration-200 hover:border-beyonix-blue-300 hover:bg-beyonix-blue-500 focus-visible:ring-2 focus-visible:ring-beyonix-blue-500 sm:w-auto",
                    )}
                  >
                    <MessageCircle className="size-3.5" />
                    {existingClaim
                      ? "Ver mensaje de ayuda"
                      : "Contactanos"}
                  </button>
                </div>
              </section>
            )}

            {canCancelOrder && (
              <div className="flex justify-end">
                <button
                  type="button"
                  aria-label={`Cancelar pedido ${formatPublicOrderId(order.id)}`}
                  title="Cancelar compra"
                  disabled={cancellingOrder}
                  onClick={() => {
                    setCancelError("")
                    setCancelModalOpen(true)
                  }}
                  className="inline-flex h-8 shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-beyonix-status-danger/25 bg-beyonix-status-danger/8 px-3 text-11px font-black text-beyonix-status-danger transition-colors hover:border-beyonix-status-danger/45 hover:bg-beyonix-status-danger/12 disabled:cursor-not-allowed disabled:opacity-45"
                >
                  <X className="size-3.5" />
                  Cancelar compra
                </button>
              </div>
            )}

            {order.estado === "entregado" && (
              <div className="space-y-3">
                <OrderProductFeedback order={order} />
                <OrderExperienceFeedback order={order} />
              </div>
            )}
          </div>

          <aside className="space-y-3.5 lg:sticky lg:top-24">
            <section className="rounded-2xl border border-[#18334D] bg-[#101923] p-3.5 sm:p-4">
              <h2 className="text-sm font-bold text-white">Resumen de pago</h2>
              <dl className="mt-3 space-y-2 text-xs"><div className="flex justify-between gap-3 text-white/65"><dt>Productos</dt><dd className="font-semibold text-white">{formatCuentaPrice(productsSubtotal)}</dd></div><div className="flex justify-between gap-3 text-white/65"><dt>Envío</dt><dd className="font-semibold text-white">{shipping > 0 ? formatCuentaPrice(shipping) : "Sin cargo"}</dd></div>{discount > 0 && <div className="flex justify-between gap-3 text-emerald-300"><dt>Descuento transferencia</dt><dd className="font-semibold">− {formatCuentaPrice(discount)}</dd></div>}{creditBalanceUsed > 0 && <div className="flex justify-between gap-3 text-emerald-300"><dt>Saldo a favor</dt><dd className="font-semibold">− {formatCuentaPrice(creditBalanceUsed)}</dd></div>}{creditBalanceUsed > 0 && externalAmountDue > 0 && <div className="flex justify-between gap-3 text-white/65"><dt>Diferencia pagada</dt><dd className="font-semibold text-white">{formatCuentaPrice(externalAmountDue)}</dd></div>}</dl>
              <div className="mt-3.5 flex items-center justify-between gap-3 rounded-xl border border-emerald-400/35 bg-[#102A22] px-3.5 py-3"><span className="text-10px font-semibold uppercase tracking-widest text-emerald-100">Total pagado</span><strong className="text-base font-bold text-white">{formatCuentaPrice(Number(order.total))}</strong></div>
            </section>

            {showClaimHelp && (
              <section className="rounded-2xl border border-[#18334D] bg-[#101923] p-3.5 sm:p-4">
                <h2 className="text-sm font-bold text-white">Ayuda con tu compra</h2>
                <p className="mt-2.5 rounded-xl border border-[#21476B] bg-[#13263B] px-3.5 py-2.5 text-xs font-medium leading-5 text-[#9EB4C8]">
                  {existingClaim
                    ? "Ya recibimos tu reclamo. Podés ver el seguimiento y la conversación desde acá."
                    : "¿Tuviste un problema con el pedido? Contactanos para que podamos ayudarte."}
                </p>
                {claimDetailStatus && (
                  <div className={`mt-2 rounded-xl border px-3.5 py-2.5 text-xs font-black shadow-[0_0_22px_rgba(119,230,226,0.08)] ${claimDetailStatus.className}`}>
                    {claimDetailStatus.label}
                  </div>
                )}
                <button
                  type="button"
                  aria-label={claimHelpAriaLabel}
                  onClick={() => router.push(`/cuenta/compras/${order.id}/ayuda`)}
                  className={cn(
                    beyonixHoverBorder,
                    "claim-start-button mt-2.5 inline-flex h-9 w-full cursor-pointer items-center justify-center gap-2 rounded-lg border-beyonix-blue-light/25 bg-[#112A43] px-4 text-xs font-black text-white transition-[background-color,border-color,box-shadow,transform] duration-200 hover:-translate-y-px hover:border-[#2C6CA3] hover:bg-[#163A5C] hover:text-white hover:shadow-[0_0_0_1px_rgba(44,108,163,0.35),0_6px_18px_rgba(17,42,67,0.28)] active:translate-y-0 active:shadow-[0_0_0_1px_rgba(44,108,163,0.25)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2C6CA3]",
                  )}
                >
                  {claimHelpTitle}
                </button>
              </section>
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
  const authenticatedUserId = user?.id ?? ""
  const authenticatedUserEmail = user?.email ?? ""
  const hasAuthenticatedUser = Boolean(authenticatedUserId || authenticatedUserEmail)
  const [order, setOrder] = useState<SupabasePedido | null>(null)
  const loadedOrderIdRef = useRef<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [redirecting, setRedirecting] = useState(false)
  const [error, setError] = useState("")

  useLayoutEffect(() => {
    window.scrollTo({ top: 0, behavior: "auto" })
  }, [orderId])

  useEffect(() => {
    if (isLoading) return
    if (!hasAuthenticatedUser) {
      setRedirecting(true)
      router.replace(`/login?redirect=/cuenta/compras/${orderId}/ayuda`)
      return
    }

    setRedirecting(false)
    let active = true

    async function loadOrder() {
      if (loadedOrderIdRef.current !== orderId) setLoading(true)
      const { data, error: orderError } = await supabase
        .from("ordenes")
        .select(ACCOUNT_ORDER_SELECT)
        .eq("id", orderId)
        .maybeSingle()

      if (!active) return
      if (orderError || !data) {
        setError("No encontramos esta compra.")
        setLoading(false)
        return
      }

      const currentOrder = data as SupabasePedido
      const userValues = [authenticatedUserId, authenticatedUserEmail]
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

      const currentClaims =
        currentOrder.order_claims && currentOrder.order_claims.length > 0
          ? currentOrder.order_claims
          : await getOrderClaims(currentOrder.id)

      if (!active) return

      setOrder({
        ...currentOrder,
        order_claims: currentClaims,
      })
      loadedOrderIdRef.current = currentOrder.id
      setLoading(false)
    }

    void loadOrder()
    return () => { active = false }
  }, [authenticatedUserEmail, authenticatedUserId, hasAuthenticatedUser, isLoading, orderId, router])

  const hasCurrentOrder = order?.id === orderId

  if (!hasAuthenticatedUser || redirecting || ((isLoading || loading) && !hasCurrentOrder)) {
    return <OrderPageLoadingState variant="claim" />
  }

  if (!order || !hasCurrentOrder) {
    return <main className="min-h-screen bg-[#05070A] px-4 pt-28"><div className="mx-auto max-w-3xl rounded-2xl border border-white/10 bg-[#0D1117] p-6 text-center"><p className="text-sm font-bold text-white">{error || "No encontramos esta compra."}</p><button type="button" onClick={() => router.push(`/cuenta/compras/${orderId}`)} className="mt-4 h-10 rounded-lg bg-[#112A43] px-4 text-xs font-black text-white">Volver a la compra</button></div></main>
  }

  return (
    <main className="min-h-screen px-3 pt-24 font-heading sm:px-5 lg:px-8">
      <div className="customer-claim-page-frame w-full py-3">
        <div className="mx-auto w-full max-w-[72rem]">
          <AccountBackButton
            type="button"
            label="Volver a la compra"
            onClick={() => router.push(`/cuenta/compras/${order.id}`)}
          />

          <section className="customer-claim-experience mt-4">
            <CustomerClaimExperience order={order} claimsVerified />
          </section>
        </div>
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
    tabParam === "saldo" ||
    tabParam === "cargar-saldo" ||
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
      <main className="flex min-h-screen items-center justify-center bg-[var(--account-background)] pt-20">
        <div className="size-8 rounded-full border-2 border-white/10 border-t-white/60 animate-spin" />
      </main>
    )
  }

  if (!user) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[var(--account-background)] pt-20">
        <div className="size-8 rounded-full border-2 border-white/10 border-t-white/60 animate-spin" />
      </main>
    )
  }

  return (
    <main className="min-h-screen bg-[var(--account-background)] pt-20">
      <div className="account-page py-6 lg:py-7">
        {user ? (
          <ProfilePanel initialView={initialView} />
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
                  ? "Iniciá sesión para ver tus compras y datos."
                  : "Registrate para comprar en BEYONIX."}
              </p>
            </div>

            <div className="flex rounded-xl border border-white/7 bg-white/2 p-1 mb-7">
              {(["login", "register"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-label={value === "login" ? "Iniciar sesión" : "Registrarse"}
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
