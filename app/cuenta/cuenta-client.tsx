"use client"
// @refresh reset

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import Link from "next/link"
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
  Heart,
  IdCard,
  Landmark,
  Loader2,
  LockKeyhole,
  LogOut,
  MessageCircle,
  ShieldCheck,
  ShoppingBag,
  UploadCloud,
  User,
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
import {
  formatARS,
  roundMoney,
} from "@/lib/customer-credit"
import { useSiteSettings } from "@/hooks/use-site-settings"
import {
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
import { ADMIN_ROUTES } from "@/lib/admin/admin-routes"
import { beyonixHoverBorder, cn } from "@/lib/utils"

type ProfileView =
  | "home"
  | "ordenes"
  | "saldo"
  | "cargar-saldo"
  | "datos"
  | "seguridad"

const ACCOUNT_ORDER_SELECT =
  "*, orden_items(id, orden_id, producto_id, variante_id, conditioned_stock_id, conditioned_name, conditioned_sku, conditioned_color_hex, conditioned_images, conditioned_discount_percent, conditioned_reason, cantidad, precio, productos(*), producto_variantes(*)), order_claims(*, order_claim_files(*), order_claim_messages(*))"
const CUSTOMER_PAYMENT_PROOF_EDITABLE_STATUSES = [
  "pendiente_comprobante",
  "en_revision",
  "rechazado",
]

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

  return (
    <AccountPageContainer className="max-w-4xl space-y-4 pb-10">
      <AccountBackButton
        onClick={onBack}
        label="Volver a mi cuenta"
        className="h-10 rounded-full border-[#2A4B6C] bg-[#132033] px-4 text-xs font-medium text-white/82 shadow-sm shadow-black/25 hover:border-[#4B78A4] hover:bg-[#1A2C44] hover:text-white"
      />

      <AccountCard padding="lg" className="overflow-hidden">
        <AccountPageHeader
          eyebrow="Mi cuenta"
          title="Saldo de cuenta"
          description="Cargá saldo en tu cuenta y usalo cuando quieras para comprar en BEYONIX."
          className="border-transparent bg-transparent p-0 shadow-none"
        />

        <div className="mt-5 flex flex-col gap-4 rounded-2xl border border-beyonix-blue-light/25 bg-[linear-gradient(135deg,#112A43,#0B1724)] p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
          <div>
            <p className="text-10px font-semibold uppercase tracking-widest text-beyonix-sky/75">
              Disponible
            </p>
            <div className="mt-2">
              <p className="text-3xl font-black tracking-tight text-white sm:text-4xl">
                {customerCredit.loading ? "Cargando…" : formatARS(customerCredit.balance)}
              </p>
              {customerCredit.error ? (
                <p className="mt-2 text-xs text-red-200">{customerCredit.error}</p>
              ) : (
                <p className="mt-2 text-xs leading-5 text-white/55">
                  Tu saldo se aplica directamente al momento de pagar.
                </p>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onLoadBalance}
            className="inline-flex h-11 shrink-0 items-center justify-center gap-2 self-start rounded-xl border border-beyonix-blue-light/40 bg-[#173C5A] px-5 text-sm font-semibold text-white transition hover:border-beyonix-sky/60 hover:bg-[#1C486B] sm:self-auto"
          >
            <Landmark className="size-4" aria-hidden="true" />
            Cargar saldo
          </button>
        </div>

        <section className="mt-4 overflow-hidden rounded-2xl border border-[var(--account-border)] bg-[linear-gradient(135deg,rgba(17,42,67,0.46),rgba(8,15,23,0.72))] px-4 py-4 sm:px-5">
          <p className="text-sm font-semibold text-white">¿Cómo funciona?</p>

          <div className="relative mt-4 grid gap-5 sm:grid-cols-3 sm:gap-0">
            <div className="pointer-events-none absolute left-[16.66%] right-[16.66%] top-6 hidden h-px bg-emerald-400/65 sm:block" />
            {[
              {
                number: "01",
                title: "Cargá saldo",
                description: "Hacé clic en “Cargar saldo” y seguí las instrucciones.",
                icon: Coins,
              },
              {
                number: "02",
                title: "Lo acreditamos",
                description: "Cuando confirmemos tu pago, el saldo aparecerá en tu cuenta.",
                icon: CheckCircle2,
              },
              {
                number: "03",
                title: "Usalo en tus compras",
                description: "Elegí tu saldo disponible al momento de pagar.",
                icon: ShoppingBag,
              },
            ].map((step) => (
              <div
                key={step.number}
                className="relative z-10 flex min-w-0 items-start gap-3.5 sm:flex-col sm:items-center sm:px-5 sm:text-center"
              >
                <div className="flex size-12 shrink-0 items-center justify-center rounded-full border border-emerald-400/70 bg-[#10263A] text-white shadow-sm shadow-black/30">
                  <step.icon className="size-5.5" strokeWidth={2.1} aria-hidden="true" />
                </div>
                <div className="min-w-0 sm:mt-2.5">
                  <p className="text-xs font-bold tabular-nums tracking-[0.14em] text-emerald-300">
                    {step.number}
                  </p>
                  <h2 className="mt-1 text-sm font-semibold text-white">
                    {step.title}
                  </h2>
                  <p className="mt-1.5 text-xs leading-5 text-white/62">
                    {step.description}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </section>
      </AccountCard>
    </AccountPageContainer>
  )
}

const MERCADOPAGO_ACTIVE_TOPUP_KEY = "beyonix:mercadopago-active-topup"

function CargarSaldo({ onBack }: { onBack: () => void }) {
  const { user } = useAuth()
  const searchParams = useSearchParams()
  const { balance: customerCreditBalance, reload: reloadCustomerCredit } =
    useCustomerCredit()
  const { customerCreditPayments } = useSiteSettings()
  const proofInputRef = useRef<HTMLInputElement>(null)
  const proofDragDepthRef = useRef(0)
  const loadingTopupsRef = useRef(false)
  const creditedTopupIdsRef = useRef<Set<string>>(new Set())
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
    payment_method?: "transfer" | "mercadopago" | null
    gross_amount?: number | string | null
    surcharge_percent?: number | string | null
    surcharge_amount?: number | string | null
    mercadopago_payment_id?: string | null
    mercadopago_status?: string | null
    created_at: string
  }>>([])
  const [error, setError] = useState("")
  const [saving, setSaving] = useState(false)
  const [paymentMethod, setPaymentMethod] = useState<"transfer" | "mercadopago">("transfer")
  const [mercadoPagoAmount, setMercadoPagoAmount] = useState("")
  const [redirectingToMercadoPago, setRedirectingToMercadoPago] = useState(false)
  const [mercadoPagoReconciliation, setMercadoPagoReconciliation] = useState<
    "idle" | "checking" | "credited" | "pending" | "error"
  >("idle")
  const reconciledReturnRef = useRef<string | null>(null)
  const abandoningTopupRef = useRef(false)
  const mercadoPagoSurchargePercent =
    customerCreditPayments.mercadoPagoSurchargePercent
  const mercadoPagoMinimumAmount =
    customerCreditPayments.mercadoPagoMinimumAmount
  const mercadoPagoCreditAmount = roundMoney(
    Number(mercadoPagoAmount.replace(/\./g, "").replace(",", ".")) || 0,
  )
  const mercadoPagoSurchargeAmount = roundMoney(
    mercadoPagoCreditAmount * (mercadoPagoSurchargePercent / 100),
  )
  const mercadoPagoTotal = roundMoney(
    mercadoPagoCreditAmount + mercadoPagoSurchargeAmount,
  )
  const mercadoPagoReturnStatus = searchParams.get("mp")
  const mercadoPagoReturnTopupId = searchParams.get("topup")
  const mercadoPagoReturnPaymentId =
    searchParams.get("payment_id") || searchParams.get("collection_id")
  const latestTopup = topups.find(
    (topup) => topup.payment_method !== "mercadopago",
  )
  const hasSubmittedProof = Boolean(lastSubmittedTopupId || latestTopup)
  const validationFinished = Boolean(
    latestTopup && ["acreditado", "rechazado"].includes(latestTopup.status),
  )
  const timelineSteps = [
    {
      title: "Transferí",
      icon: Landmark,
      completed: true,
      current: !hasSubmittedProof,
    },
    {
      title: "Subí el comprobante",
      icon: UploadCloud,
      completed: hasSubmittedProof,
      current: false,
    },
    {
      title: "Validamos",
      icon: Clock3,
      completed: validationFinished,
      current: hasSubmittedProof && !validationFinished,
    },
    {
      title: "Saldo acreditado",
      icon: Coins,
      completed: latestTopup?.status === "acreditado",
      current: false,
    },
  ]

  const loadTopups = useCallback(async () => {
    if (loadingTopupsRef.current) return
    loadingTopupsRef.current = true

    try {
      const response = await fetch("/api/customer-credit/topups?page=1", {
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

      if (!response.ok) {
        throw new Error(data.error ?? "No pudimos actualizar el estado de la carga.")
      }

      const nextTopups = data.topups ?? []
      const nextCreditedIds = new Set(
        nextTopups
          .filter((topup) => topup.status === "acreditado")
          .map((topup) => topup.id),
      )
      const hasNewAccreditedTopup = [...nextCreditedIds].some(
        (id) => !creditedTopupIdsRef.current.has(id),
      )

      creditedTopupIdsRef.current = nextCreditedIds
      setTopups(nextTopups)
      if (hasNewAccreditedTopup) void reloadCustomerCredit()
    } catch (loadError) {
      console.error("No se pudo actualizar el estado de las cargas", loadError)
    } finally {
      loadingTopupsRef.current = false
    }
  }, [reloadCustomerCredit])

  useEffect(() => {
    void loadTopups()
    const intervalId = window.setInterval(() => void loadTopups(), 5000)
    return () => window.clearInterval(intervalId)
  }, [loadTopups])

  useEffect(() => {
    function clearStoredTopup() {
      try {
        window.sessionStorage.removeItem(MERCADOPAGO_ACTIVE_TOPUP_KEY)
      } catch {
        // El almacenamiento puede estar bloqueado por la configuración del navegador.
      }
    }

    async function restoreAfterMercadoPago() {
      setRedirectingToMercadoPago(false)

      if (mercadoPagoReturnStatus) {
        clearStoredTopup()
        return
      }

      let storedTopupId = ""
      try {
        const storedValue = window.sessionStorage.getItem(
          MERCADOPAGO_ACTIVE_TOPUP_KEY,
        )
        if (storedValue) {
          const parsed = JSON.parse(storedValue) as { topupId?: string }
          storedTopupId = parsed.topupId?.trim() ?? ""
        }
      } catch {
        clearStoredTopup()
      }

      if (!storedTopupId || abandoningTopupRef.current) return

      abandoningTopupRef.current = true
      setPaymentMethod("mercadopago")

      try {
        const response = await fetch(
          "/api/customer-credit/mercadopago/abandon",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ topupId: storedTopupId }),
          },
        )
        const data = (await response.json()) as {
          cancelled?: boolean
          credited?: boolean
          error?: string
        }
        if (!response.ok) {
          throw new Error(data.error ?? "No pudimos cerrar el intento de pago.")
        }

        clearStoredTopup()
        setError(
          data.credited
            ? "El pago fue aprobado y el saldo se acreditó correctamente."
            : data.cancelled
              ? "El intento de pago se canceló. No se generó ningún cargo."
              : "El pago quedó en verificación con Mercado Pago.",
        )
        await Promise.all([loadTopups(), reloadCustomerCredit()])
      } catch (restoreError) {
        console.error("No se pudo cerrar el checkout abandonado", restoreError)
        setError(
          restoreError instanceof Error
            ? restoreError.message
            : "No pudimos cerrar el intento de pago.",
        )
      } finally {
        abandoningTopupRef.current = false
      }
    }

    const handlePageShow = () => void restoreAfterMercadoPago()
    window.addEventListener("pageshow", handlePageShow)
    void restoreAfterMercadoPago()

    return () => window.removeEventListener("pageshow", handlePageShow)
  }, [
    loadTopups,
    mercadoPagoReturnStatus,
    reloadCustomerCredit,
  ])

  useEffect(() => {
    if (
      !user ||
      !mercadoPagoReturnTopupId ||
      !["success", "pending"].includes(mercadoPagoReturnStatus ?? "") ||
      reconciledReturnRef.current === mercadoPagoReturnTopupId
    ) {
      return
    }

    reconciledReturnRef.current = mercadoPagoReturnTopupId
    setMercadoPagoReconciliation("checking")

    void fetch("/api/customer-credit/mercadopago/reconcile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        topupId: mercadoPagoReturnTopupId,
        paymentId: mercadoPagoReturnPaymentId || undefined,
      }),
    })
      .then(async (response) => {
        const data = (await response.json()) as {
          credited?: boolean
          paymentStatus?: string
          error?: string
        }
        if (!response.ok) throw new Error(data.error ?? "No pudimos verificar el pago.")

        setMercadoPagoReconciliation(data.credited ? "credited" : "pending")
        await Promise.all([loadTopups(), reloadCustomerCredit()])
      })
      .catch((reconciliationError) => {
        console.error("No se pudo reconciliar el pago de Mercado Pago", reconciliationError)
        setMercadoPagoReconciliation("error")
      })
  }, [
    loadTopups,
    mercadoPagoReturnPaymentId,
    mercadoPagoReturnStatus,
    mercadoPagoReturnTopupId,
    reloadCustomerCredit,
    user,
  ])

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
        () => {
          void loadTopups()
          void reloadCustomerCredit()
        },
      )
      .subscribe()

    return () => {
      void supabase.removeChannel(channel)
    }
  }, [loadTopups, reloadCustomerCredit, user])

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
      await loadTopups()
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

  async function startMercadoPagoTopup() {
    if (redirectingToMercadoPago) return

    if (mercadoPagoCreditAmount < mercadoPagoMinimumAmount) {
      setError(
        `La carga mínima mediante Mercado Pago es de ${formatARS(mercadoPagoMinimumAmount)}.`,
      )
      return
    }

    setError("")
    setRedirectingToMercadoPago(true)

    try {
      const response = await fetch(
        "/api/customer-credit/mercadopago/preference",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            amount: mercadoPagoCreditAmount,
            expectedSurchargePercent: mercadoPagoSurchargePercent,
            expectedMinimumAmount: mercadoPagoMinimumAmount,
          }),
        },
      )
      const data = (await response.json()) as {
        init_point?: string
        topup_id?: string
        error?: string
      }

      if (!response.ok || !data.init_point || !data.topup_id) {
        throw new Error(data.error ?? "No pudimos iniciar el pago.")
      }

      try {
        window.sessionStorage.setItem(
          MERCADOPAGO_ACTIVE_TOPUP_KEY,
          JSON.stringify({ topupId: data.topup_id, startedAt: Date.now() }),
        )
      } catch {
        // La vuelta sigue funcionando mediante las URLs de retorno y el webhook.
      }

      window.location.assign(data.init_point)
    } catch (paymentError) {
      try {
        window.sessionStorage.removeItem(MERCADOPAGO_ACTIVE_TOPUP_KEY)
      } catch {
        // Sin acción adicional.
      }
      setError(
        paymentError instanceof Error
          ? paymentError.message
          : "No pudimos iniciar el pago con Mercado Pago.",
      )
      setRedirectingToMercadoPago(false)
    }
  }

  return (
    <AccountPageContainer className="max-w-[1120px] space-y-4 pb-6">
      <div className="flex flex-col gap-3 sm:relative sm:block">
        <AccountBackButton
          onClick={onBack}
          label="Volver a mi cuenta"
          className="h-9 w-fit rounded-full border-[#2A4B6C] bg-[#112A43]/55 px-3.5 text-xs font-semibold text-white/82 shadow-sm shadow-black/25 transition hover:-translate-y-0.5 hover:border-[#4B78A4] hover:bg-[#112A43] hover:text-white sm:absolute sm:right-0 sm:top-0"
        />
        <header className="px-1 pb-0.5 sm:pr-48">
          <p className="text-9px font-bold uppercase tracking-[0.2em] text-beyonix-sky/70">
            Saldo de tu cuenta
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <h1 className="text-2xl font-black tracking-tight text-white">Cargar saldo</h1>
            <span className="inline-flex h-7 items-center rounded-full border border-[#4F82A8]/45 bg-[#112A43]/55 px-3 text-xs font-bold text-white/82">
              Saldo actual: {formatARS(customerCreditBalance)}
            </span>
          </div>
          <p className="mt-1 text-xs text-white/52">
            Elegí cómo querés cargar saldo en tu cuenta.
          </p>
        </header>
      </div>

      {mercadoPagoReturnStatus ? (
        <div
          className={cn(
            "rounded-xl border px-4 py-3 text-xs font-semibold",
            mercadoPagoReturnStatus === "success"
              ? "border-emerald-300/25 bg-emerald-400/10 text-emerald-100"
              : mercadoPagoReturnStatus === "pending"
                ? "border-amber-300/25 bg-amber-300/10 text-amber-100"
                : "border-red-300/25 bg-red-400/10 text-red-100",
          )}
        >
          {mercadoPagoReconciliation === "checking"
            ? "Estamos verificando el pago directamente con Mercado Pago."
            : mercadoPagoReconciliation === "credited"
              ? "Pago aprobado y saldo acreditado correctamente en tu cuenta."
              : mercadoPagoReconciliation === "error"
                ? "Mercado Pago informó el regreso, pero la verificación sigue pendiente. No vuelvas a pagar: el sistema reintentará automáticamente."
                : mercadoPagoReturnStatus === "success"
                  ? "Mercado Pago recibió el pago. El saldo se actualizará automáticamente al confirmarse la aprobación."
                  : mercadoPagoReturnStatus === "pending"
                    ? "El pago quedó pendiente en Mercado Pago. Se acreditará automáticamente si luego resulta aprobado."
                    : "Mercado Pago no aprobó el pago. No se acreditó saldo en tu cuenta."}
        </div>
      ) : null}

      <div className="customer-credit-master-surface space-y-4 rounded-3xl border border-[#203A50] p-4 shadow-[0_28px_80px_rgba(0,0,0,0.48)] sm:p-5">
        <div
          className="grid grid-cols-2 gap-2 rounded-2xl border border-white/8 bg-[#0D0E10] p-2"
          role="group"
          aria-label="Método para cargar saldo"
        >
          <button
            type="button"
            aria-pressed={paymentMethod === "transfer"}
            onClick={() => {
              setPaymentMethod("transfer")
              setError("")
            }}
            className={cn(
              "flex min-h-16 items-center gap-3 rounded-xl border px-4 py-3 text-left transition-all",
              paymentMethod === "transfer"
                ? "border-beyonix-sky/70 bg-[#112A43] shadow-[0_0_20px_rgba(79,130,168,0.12)]"
                : "border-transparent bg-white/[0.025] hover:border-white/12 hover:bg-white/[0.04]",
            )}
          >
            <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-[#173B5C] text-white">
              <Landmark className="size-4.5" />
            </span>
            <span>
              <span className="block text-sm font-black text-white">Transferencia</span>
              <span className="mt-0.5 block text-[13px] font-semibold text-emerald-300">
                SIN RECARGO
              </span>
            </span>
          </button>
          <button
            type="button"
            aria-pressed={paymentMethod === "mercadopago"}
            onClick={() => {
              setPaymentMethod("mercadopago")
              setError("")
            }}
            className={cn(
              "flex min-h-16 items-center gap-3 rounded-xl border px-4 py-3 text-left transition-all",
              paymentMethod === "mercadopago"
                ? "border-[#49A9E8]/75 bg-[#0D2D43] shadow-[0_0_20px_rgba(73,169,232,0.13)]"
                : "border-transparent bg-white/[0.025] hover:border-white/12 hover:bg-white/[0.04]",
            )}
          >
            <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-[#0E4D73] text-white">
              <CreditCard className="size-4.5" />
            </span>
            <span>
              <span className="block text-sm font-black text-white">Mercado Pago</span>
              <span className="mt-0.5 block text-xs font-semibold text-[#78C9F5]">
                {mercadoPagoSurchargePercent}% de recargo
              </span>
            </span>
          </button>
        </div>

        {paymentMethod === "transfer" ? (
          <>
            <ol className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-white/7 bg-white/7 sm:grid-cols-4">
              {timelineSteps.map((step) => {
                const StepIcon = step.icon
                const active = step.completed || step.current
                return (
                  <li
                    key={step.title}
                    className="flex min-h-12 items-center gap-2 bg-[#101114] px-3 py-2.5 sm:justify-center"
                  >
                    <span
                      className={cn(
                        "flex size-7 shrink-0 items-center justify-center rounded-full border",
                        active
                          ? "border-[#4F82A8] bg-[#112A43] text-white"
                          : "border-white/12 bg-[#141414] text-white/32",
                      )}
                    >
                      <StepIcon className="size-3.5" />
                    </span>
                    <span
                      className={cn(
                        "text-[11px] font-bold leading-4",
                        active ? "text-white/82" : "text-white/38",
                      )}
                    >
                      {step.title}
                    </span>
                  </li>
                )
              })}
            </ol>

            <div className="grid items-stretch overflow-hidden rounded-2xl border border-white/8 bg-[#101114] lg:grid-cols-2">
              <section className="flex min-h-[280px] flex-col p-4 sm:p-5 lg:border-r lg:border-white/7">
                <div className="flex items-center gap-3">
                  <span className="flex size-8 items-center justify-center rounded-lg bg-[#112A43] text-white">
                    <Landmark className="size-4" />
                  </span>
                  <div>
                    <p className="text-10px font-bold uppercase tracking-[0.18em] text-beyonix-sky/65">
                      Transferencia
                    </p>
                    <h2 className="mt-0.5 text-base font-bold text-white">Datos bancarios</h2>
                  </div>
                </div>
                <div className="mt-4 flex-1 overflow-hidden rounded-xl bg-[#141414] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)]">
                  {[
                    { label: "Alias", value: TRANSFER_ALIAS, field: "alias" as const },
                    { label: "CVU", value: TRANSFER_CVU, field: "cvu" as const },
                    { label: "Titular", value: TRANSFER_ACCOUNT_HOLDER, field: null },
                  ].map((item, index) => (
                    <div
                      key={item.label}
                      className={cn(
                        "group flex min-h-[58px] items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-white/[0.035]",
                        index > 0 && "border-t border-white/6",
                      )}
                    >
                      <span className="text-xs font-semibold text-white/42">{item.label}</span>
                      <div className="flex min-w-0 items-center justify-end gap-3">
                        <span
                          className={cn(
                            "truncate text-right text-sm font-semibold text-white/88",
                            item.field === "cvu" && "tabular-nums",
                            item.label === "Titular" && "uppercase",
                          )}
                        >
                          {item.value}
                        </span>
                        {item.field ? (
                          <button
                            type="button"
                            onClick={() => void copyTransferValue(item.field, item.value)}
                            className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg border border-white/8 bg-white/[0.035] text-white/72 transition-all hover:border-[#4F82A8] hover:bg-[#112A43] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-beyonix-sky/55"
                            aria-label={`Copiar ${item.label.toLowerCase()}`}
                            title={copiedTransferField === item.field ? "Copiado" : `Copiar ${item.label}`}
                          >
                            {copiedTransferField === item.field ? (
                              <CheckCircle2 className="size-3.5" />
                            ) : (
                              <Copy className="size-3.5" />
                            )}
                          </button>
                        ) : (
                          <span className="size-8 shrink-0" aria-hidden="true" />
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </section>

              <section className="flex min-h-[280px] flex-col border-t border-white/7 p-4 sm:p-5 lg:border-t-0">
                <div className="flex items-center gap-3">
                  <span className="flex size-8 items-center justify-center rounded-lg bg-[#112A43] text-white">
                    <UploadCloud className="size-4" />
                  </span>
                  <div>
                    <p className="text-10px font-bold uppercase tracking-[0.18em] text-beyonix-sky/65">
                      Comprobante
                    </p>
                    <h2 className="mt-0.5 text-base font-bold text-white">Subí tu comprobante</h2>
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
                    "group mt-4 flex min-h-36 w-full flex-1 flex-col items-center justify-center rounded-xl border border-dashed bg-[#141414] px-5 py-4 text-center transition-all duration-200 hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-beyonix-sky/55 disabled:cursor-wait disabled:hover:translate-y-0",
                    isDraggingProof
                      ? "border-beyonix-sky bg-[#112A43]/45 shadow-[0_0_28px_rgba(79,130,168,0.14)]"
                      : "border-[#31506F] hover:border-beyonix-sky hover:bg-[#112A43]/22",
                  )}
                >
                  <span className="flex size-10 items-center justify-center rounded-xl bg-[#112A43]/70 text-white transition-transform duration-200 group-hover:scale-105">
                    {saving ? (
                      <Loader2 className="size-5 animate-spin" />
                    ) : lastSubmittedTopupId && proofFile ? (
                      <CheckCircle2 className="size-5" />
                    ) : (
                      <UploadCloud className="size-5" />
                    )}
                  </span>
                  <span className="mt-2 max-w-full truncate text-sm font-bold text-white">
                    {saving
                      ? "Enviando comprobante..."
                      : proofFile?.name ?? "Arrastrá el archivo o hacé clic"}
                  </span>
                  <span className="mt-1.5 text-xs text-white/48">
                    {lastSubmittedTopupId && proofFile && !saving
                      ? "Comprobante enviado correctamente"
                      : "Seleccioná tu comprobante de transferencia"}
                  </span>
                  {!lastSubmittedTopupId || !proofFile ? (
                    <span className="mt-2 text-9px font-semibold uppercase tracking-[0.16em] text-white/28">
                      JPG · PNG · PDF
                    </span>
                  ) : null}
                </button>
                {lastSubmittedTopupId && !saving ? (
                  <div className="mt-3 flex items-center justify-center gap-2 text-center">
                    <span className="text-xs text-white/42">¿Archivo incorrecto?</span>
                    <button
                      type="button"
                      onClick={() => proofInputRef.current?.click()}
                      className="text-xs font-bold text-beyonix-sky transition hover:text-white focus-visible:outline-none focus-visible:underline"
                    >
                      Cambiarlo
                    </button>
                  </div>
                ) : null}
                {error ? (
                  <p className="mt-3 text-center text-xs text-red-200/85">{error}</p>
                ) : null}
              </section>
            </div>

            <div className="customer-credit-info-blue flex items-start gap-3 rounded-xl bg-[#112A43]/42 px-4 py-3 shadow-[inset_0_0_0_1px_rgba(79,130,168,0.2)] sm:items-center">
              <Clock3 className="mt-0.5 size-4.5 shrink-0 text-white sm:mt-0" />
              <p className="text-xs leading-5 text-white/64">
                Validamos transferencias de lunes a viernes, de 8:00 a 20:00 h.
                Fuera de ese horario se procesan el próximo día hábil.
              </p>
            </div>
          </>
        ) : (
          <>
            <ol className="grid gap-px overflow-hidden rounded-xl border border-white/7 bg-white/7 sm:grid-cols-3">
              {[
                ["1", "Ingresá el saldo"],
                ["2", "Pagá en Mercado Pago"],
                ["3", "Acreditación automática"],
              ].map(([number, title]) => (
                <li
                  key={number}
                  className="flex min-h-12 items-center gap-2 bg-[#101114] px-3 py-2.5 sm:justify-center"
                >
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-full border border-[#4F9AC8] bg-[#103653] text-[11px] font-black text-white">
                    {number}
                  </span>
                  <span className="text-[11px] font-bold leading-4 text-white/82">{title}</span>
                </li>
              ))}
            </ol>

            <div className="grid items-stretch overflow-hidden rounded-2xl border border-white/8 bg-[#101114] lg:grid-cols-2">
              <section className="flex min-h-[300px] flex-col p-4 sm:p-5 lg:border-r lg:border-white/7">
                <div className="flex items-center gap-3">
                  <span className="flex size-9 items-center justify-center rounded-xl bg-[#0E4D73] text-white">
                    <CreditCard className="size-4.5" />
                  </span>
                  <div>
                    <p className="text-10px font-bold uppercase tracking-[0.18em] text-[#78C9F5]">
                      Mercado Pago
                    </p>
                    <h2 className="mt-0.5 text-base font-bold text-white">
                      ¿Cuánto saldo querés cargar?
                    </h2>
                  </div>
                </div>
                <label
                  className="mt-5 flex items-center justify-between gap-3 text-xs font-bold text-white/70"
                  htmlFor="mercadopago-credit-amount"
                >
                  <span>Saldo a acreditar</span>
                  <span className="rounded-full border border-[#315A7A] bg-[#0B2233] px-2.5 py-1 text-10px font-black text-[#78C9F5]">
                    Mínimo: {formatARS(mercadoPagoMinimumAmount)}
                  </span>
                </label>
                <div className="mt-2 flex h-12 items-center rounded-xl border border-[#315A7A] bg-[#0B151F] px-4 focus-within:border-[#69A5D0] focus-within:ring-2 focus-within:ring-[#49A9E8]/15">
                  <span className="mr-2 text-sm font-bold text-[#78C9F5]">$</span>
                  <input
                    id="mercadopago-credit-amount"
                    value={mercadoPagoAmount}
                    onChange={(event) =>
                      setMercadoPagoAmount(event.target.value.replace(/[^\d.,]/g, ""))
                    }
                    inputMode="decimal"
                    placeholder="100.000"
                    className="min-w-0 flex-1 bg-transparent text-base font-bold text-white outline-none placeholder:text-white/25"
                  />
                </div>
                {mercadoPagoCreditAmount > 0 &&
                mercadoPagoCreditAmount < mercadoPagoMinimumAmount ? (
                  <p className="mt-2 text-xs font-semibold text-amber-200">
                    Ingresá al menos {formatARS(mercadoPagoMinimumAmount)} para continuar.
                  </p>
                ) : null}
                {error ? <p className="mt-3 text-xs text-red-200/85">{error}</p> : null}
              </section>

              <section className="flex min-h-[300px] flex-col border-t border-white/7 bg-[#0B151F]/45 p-4 sm:p-5 lg:border-t-0">
                <p className="text-10px font-black uppercase tracking-[0.18em] text-[#78C9F5]">
                  Resumen
                </p>
                <dl className="mt-5 space-y-3 text-xs">
                  <div className="flex items-center justify-between gap-4 text-white/58">
                    <dt>Saldo a acreditar</dt>
                    <dd className="font-bold text-white">{formatARS(mercadoPagoCreditAmount)}</dd>
                  </div>
                  <div className="flex items-center justify-between gap-4 text-white/58">
                    <dt>Comisión Mercado Pago ({mercadoPagoSurchargePercent}%)</dt>
                    <dd className="font-bold text-white">{formatARS(mercadoPagoSurchargeAmount)}</dd>
                  </div>
                  <div className="flex items-center justify-between gap-4 border-t border-white/10 pt-4">
                    <dt className="font-bold text-white">Total a pagar</dt>
                    <dd className="text-lg font-black text-[#78C9F5]">{formatARS(mercadoPagoTotal)}</dd>
                  </div>
                </dl>
                <button
                  type="button"
                  disabled={
                    redirectingToMercadoPago ||
                    mercadoPagoCreditAmount < mercadoPagoMinimumAmount
                  }
                  onClick={() => void startMercadoPagoTopup()}
                  className="mt-auto inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl border border-[#69A5D0] bg-[#146B9B] px-4 text-sm font-black text-white shadow-[0_0_20px_rgba(73,169,232,0.18)] transition hover:-translate-y-0.5 hover:bg-[#197DB3] disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:translate-y-0"
                >
                  {redirectingToMercadoPago ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <CreditCard className="size-4" />
                  )}
                  {redirectingToMercadoPago ? "Abriendo Mercado Pago..." : "Continuar en Mercado Pago"}
                </button>
              </section>
            </div>

            <div className="customer-credit-info-blue flex items-start gap-3 rounded-xl bg-[#112A43]/42 px-4 py-3 shadow-[inset_0_0_0_1px_rgba(79,130,168,0.2)] sm:items-center">
              <CheckCircle2 className="mt-0.5 size-4.5 shrink-0 text-white sm:mt-0" />
              <p className="text-xs leading-5 text-white/64">
                El saldo se acredita cuando Mercado Pago confirma el pago.
              </p>
            </div>
          </>
        )}
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
    { icon: CreditCard, label: "Saldo de cuenta", sub: "Disponible para tus compras", view: "saldo" as ProfileView },
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
              <Link
                href={ADMIN_ROUTES.dashboard}
                aria-label="Ir al panel admin"
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
              </Link>
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
    <main className="customer-order-detail-page order-detail-solid-surface min-h-screen bg-[#05070A] px-3 pb-10 pt-24 font-heading sm:px-5 lg:px-8">
      <div className="customer-order-detail-container mx-auto max-w-[1200px]">
        <button type="button" onClick={() => router.push("/cuenta?tab=ordenes")} className="customer-order-detail-back inline-flex h-10 cursor-pointer items-center gap-2 rounded-full border border-white/12 bg-[#0D1117] px-4 text-sm font-bold text-white/80 transition-colors hover:border-blue-300/35 hover:text-white"><ChevronLeft className="size-4" />Volver a Mis compras</button>

        <header className="customer-order-detail-header mt-4 rounded-2xl border border-[#18334D] bg-[#0B1118] p-3.5 shadow-[0_0_22px_rgba(17,42,67,0.16)] sm:p-4">
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

        <div className="customer-order-detail-timeline mt-3">
          <OrderProgressTimeline order={order} />
        </div>

        <div className="order-detail-components-shell mt-3 grid items-start gap-4 p-3 sm:p-4 lg:grid-cols-[minmax(0,1.62fr)_minmax(315px,0.78fr)]">
          <div className="customer-order-detail-main space-y-4">
            <section className="customer-order-products rounded-2xl border border-[#18334D] bg-[#101923] p-3.5 sm:p-4">
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
              <section className="customer-order-management rounded-2xl border border-beyonix-blue-500/50 bg-beyonix-gray-900 p-3.5 sm:p-4">
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
              <section className="customer-order-help rounded-2xl border border-beyonix-blue-500/50 bg-beyonix-gray-900 p-3.5 sm:p-4">
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

            {order.estado === "entregado" && (
              <div className="space-y-3">
                <OrderProductFeedback order={order} />
                <OrderExperienceFeedback order={order} />
              </div>
            )}
          </div>

          <aside className="customer-order-detail-aside space-y-3.5 lg:sticky lg:top-24">
            <section className="customer-order-payment-summary rounded-2xl border border-[#18334D] bg-[#101923] p-3.5 sm:p-4">
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
  const [cancellationCompleted, setCancellationCompleted] = useState(false)

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

  if (
    cancellationCompleted ||
    (order.estado ?? "").toLowerCase() === "cancelado"
  ) {
    return (
      <main className="flex min-h-screen items-start justify-center bg-[#05070A] px-4 pt-32 font-heading sm:pt-36">
        <section
          className="customer-cancellation-success-card relative z-20 w-full max-w-md rounded-xl border border-[#18334D] px-5 py-6 text-center shadow-[0_18px_50px_rgba(0,0,0,0.4)]"
        >
          <CheckCircle2 className="mx-auto size-8 text-emerald-300" />
          <h1 className="mt-3 text-base font-medium text-white">
            Compra cancelada correctamente.
          </h1>
          <button
            type="button"
            onClick={() => router.push("/")}
            className="mt-5 inline-flex h-9 cursor-pointer items-center justify-center rounded-lg border border-emerald-300/25 bg-emerald-400/10 px-4 text-xs font-normal text-emerald-50 transition-colors hover:border-emerald-300/45 hover:bg-emerald-400/15"
          >
            Volver al inicio
          </button>
        </section>
      </main>
    )
  }

  return (
    <main className="customer-claim-create-page min-h-screen px-3 pt-20 font-heading sm:px-5 sm:pt-24 lg:px-8">
      <div className="customer-claim-page-frame w-full py-2">
        <div className="mx-auto w-full max-w-[72rem]">
          <AccountBackButton
            type="button"
            label="Volver a la compra"
            onClick={() => router.push(`/cuenta/compras/${order.id}`)}
            className="border-[#31465B] bg-[#0D151E]/75 text-white/78 transition-all duration-200 hover:border-[#5CA9E6]/55 hover:bg-[#111D28] hover:text-white hover:[&_svg]:-translate-x-0.5 [&_svg]:text-white [&_svg]:transition-transform"
          />

          <section className="customer-claim-experience mt-3">
            <CustomerClaimExperience
              order={order}
              claimsVerified
              onOrderCancelled={() => setCancellationCompleted(true)}
            />
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
    <main className="min-h-screen pt-20">
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
