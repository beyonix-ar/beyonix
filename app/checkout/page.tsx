"use client"

import {
  type ReactNode,
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"

import Image from "next/image"
import Link from "next/link"
import dynamic from "next/dynamic"

import {
  useRouter,
} from "next/navigation"

import {
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronDown,
  Clock3,
  CreditCard,
  Home,
  IdCard,
  Instagram,
  Landmark,
  Loader2,
  Mail,
  MapPin,
  Minus,
  Plus,
  ShieldCheck,
  Smartphone,
  Trash2,
  Truck,
  UserRound,
  Wallet,
  type LucideIcon,
} from "lucide-react"

import {
  Button,
} from "@/components/ui/button"
import {
  useAuth,
} from "@/context/auth-context"
import {
  useCart,
} from "@/context/cart-context"
import { useCustomerCredit } from "@/context/customer-credit-context"

import {
  Input,
} from "@/components/ui/input"

import {
  Label,
} from "@/components/ui/label"
import { AccountMenu } from "@/components/account-menu"
import { AccountThemeToggle } from "@/components/account/account-theme-toggle"
import { BeyonixButton, BeyonixHeaderLoginLink, BeyonixHeaderRegisterLink } from "@/components/beyonix-ui"
import { GeographicSelect } from "@/components/checkout/geographic-select"
import { PublicMinimalHeader } from "@/components/public-minimal-header"
import { ArgentinaPhoneInput } from "@/components/phone/argentina-phone-input"
import { PaymentInfoModal } from "@/components/checkout/payment-info-modal"
import {
  InsufficientStockModal,
  type InsufficientStockModalItem,
} from "@/components/checkout/insufficient-stock-modal"
import { storeGuestOrderToken } from "@/lib/orders/guest-order-token-client"

import {
  Separator,
} from "@/components/ui/separator"

import {
  MAX_CART_ITEM_QUANTITY,
  STOCK_CHANGED_MESSAGE,
  getStockStatus,
  getStockStatusLabel,
  type StockStatus,
} from "@/lib/cart/stock-status"

import {
  calculateCartTotals,
} from "@/lib/cart/cart-totals"
import { getPriceWithoutNationalTaxes } from "@/lib/pricing/financed-pricing"
import { getTransferSummaryBreakdown } from "@/lib/payments/transfer-checkout"
import {
  calculateMercadoPagoCheckoutPricing,
  getMercadoPagoModeQuote,
  getMercadoPagoSummaryBreakdown,
  getCheckoutSummaryLineAmounts,
  type CheckoutInstallmentPlan,
  type CheckoutPricingLine,
  type MercadoPagoCheckoutMode,
} from "@/lib/pricing/checkout-pricing"
import { COMMERCIAL_UPDATE_NOTICE } from "@/lib/cart/cart-catalog-refresh"
import {
  getCartStockReservation,
  reserveCartStock,
  type StockReservationItem,
  type StockReservationResult,
} from "@/lib/cart/stock-reservations"
import {
  CHECKOUT_STEP_RESERVATION_KEY,
  formatReservationCountdown,
  reservationItemsFromCart,
  reservationMatchesCart,
  reservationSecondsLeft,
} from "@/lib/cart/checkout-step-reservation"
import { useCommercialRefresh } from "@/hooks/use-commercial-refresh"
import {
  calculateStoreBenefitDiscount,
  getStoreBenefitLabel,
  type StoreBenefitType,
} from "@/lib/customer-store-benefits"
import {
  calculateCustomerShippingCost,
  calculateShippingBonus,
  hasShippingBonus,
} from "@/lib/store-config"
import {
  formatDeliveryAddress,
  parseDeliveryAddress,
} from "@/lib/delivery-address"
import {
  hasBlockedWords,
} from "@/lib/validation/content-filter"
import {
  ARGENTINA_PROVINCES,
  FIELD_LIMITS,
  normalizeArgentineLocality,
  normalizeArgentineLocationKey,
} from "@/lib/validation/account-fields"
import {
  isValidArgentineNationalPhone,
  normalizeArgentineNationalPhone,
} from "@/lib/validation/phone-ar"
import {
  ANDREANI_DESTINATION_UNAVAILABLE_MESSAGE,
  type AndreaniBranchWithDistance,
} from "@/lib/andreani/types"
import {
  buildShippingQuoteKey,
  CheckoutCatalogError,
  findCanonicalLocality,
  getLocalitiesForProvince,
  getPostalCodesForLocality,
  getShippingQuoteOptions,
  isQuotableDestination,
  mapCartItemsToQuoteItems,
  peekLocalitiesForProvince,
  peekPostalCodesForLocality,
  peekShippingQuoteOptions,
  resolvePostalCodeFromCatalog,
  type CheckoutLocalityOption,
  type CheckoutPostalCodeResult,
  type CheckoutQuoteRawOption,
} from "@/lib/andreani/checkout-quote-client"
import {
  calculateTransferPaymentTotalAfterCustomerCredit,
} from "@/lib/payments/transfer"
import {
  calculateCustomerCreditApplication,
  getMaxApplicableCustomerCredit,
} from "@/lib/customer-credit"

import {
  cn,
} from "@/lib/utils"
import { FreeShippingBar } from "@/components/cart/free-shipping-bar"
import { Footer } from "@/components/footer"
import { AdminNotificationsBell } from "@/components/admin-notifications-bell"
import { useOrderNotifications } from "@/hooks/use-order-notifications"
import { useSiteSettings } from "@/hooks/use-site-settings"

// Leaflet (mapa de sucursales) sólo se descarga cuando el cliente elige
// "sucursal" -- este import dinámico mantiene ese bundle entero (leaflet +
// react-leaflet + su CSS) fuera del checkout de domicilio.
const BranchMapPicker = dynamic(
  () =>
    import("@/components/checkout/branch-map-picker").then(
      (module) => module.BranchMapPicker,
    ),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-64 items-center justify-center rounded-2xl border border-beyonix-blue-light/16 bg-black/20 text-xs text-white/50 lg:h-[420px]">
        Cargando mapa de sucursales…
      </div>
    ),
  },
)

function formatPrice(
  price: number
): string {
  const safePrice = Number.isFinite(price) ? price : 0

  return new Intl.NumberFormat(
    "es-AR",
    {
      style: "currency",
      currency: "ARS",
      minimumFractionDigits: 0,
    }
  ).format(safePrice)
}

const cfteaPercentFormatter = new Intl.NumberFormat("es-AR", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
})

function formatCfteaPercent(value: number) {
  return cfteaPercentFormatter.format(value)
}

function getShippingOptionLabel(type: ShippingType) {
  return type === "domicilio" ? "Envío a domicilio" : "Entrega en sucursal"
}

function getStockIndicatorClassName(status: StockStatus) {
  // Tokens semánticos (--account-warning/danger/success-text) en vez de
  // colores fijos de Tailwind: esos ya tienen su propia variante clara
  // (ámbar/rojo/verde oscuro, legible sobre fondo claro) y oscura (pastel,
  // legible sobre fondo oscuro) -- un color fijo de paleta como
  // text-amber-200 no reacciona al theme y sobre el Resumen del pedido en
  // Light quedaba prácticamente invisible.
  if (status === "low") {
    return "text-[var(--account-warning-text)]"
  }

  if (status === "out") {
    return "text-[var(--account-danger-text)]"
  }

  return "text-[var(--account-success-text)]"
}

function getStockIndicatorSymbol(status: StockStatus) {
  if (status === "available") return "✓"

  return ""
}

/**
 * Opciones de pago VISIBLES (3): el cliente elige una sola. Por debajo se
 * siguen representando con el estado existente -- medio `mercadopago` /
 * `transferencia` + modalidad de Mercado Pago `cash` / `financed` --, así
 * que el backend y el payload no cambian.
 */
type CheckoutPaymentOption =
  | "transferencia"
  | "mercadopago_cash"
  | "mercadopago_financed"

const CHECKOUT_PAYMENT_METHOD_IDS = ["mercadopago", "transferencia"] as const

function getCheckoutPaymentOption(
  selectedPayment: string,
  mercadoPagoMode: MercadoPagoCheckoutMode,
): CheckoutPaymentOption | null {
  if (selectedPayment === "transferencia") return "transferencia"
  if (selectedPayment !== "mercadopago") return null
  return mercadoPagoMode === "financed" ? "mercadopago_financed" : "mercadopago_cash"
}

const checkoutInputClassName =
  "beyonix-checkout-input h-10 rounded-lg border-beyonix-blue-light/18 bg-[#10151C] font-heading text-sm font-semibold text-white placeholder:text-white/36 hover:border-beyonix-blue-light/35 focus-visible:border-beyonix-blue-light/65 focus-visible:ring-2 focus-visible:ring-beyonix-blue-light/18"

const checkoutPanelClassName =
  "checkout-panel relative overflow-hidden rounded-xl border border-beyonix-blue-light/18 bg-[#0B1118] shadow-[0_24px_70px_rgba(0,0,0,0.34)]"

const checkoutFormPanelClassName =
  "checkout-panel checkout-form-panel relative overflow-hidden rounded-xl border border-[#112A43] bg-[#070C12] shadow-[0_24px_70px_#000000]"

const checkoutSectionHeadingClassName =
  "border-l-4 border-beyonix-blue py-0.5 pl-3 text-lg font-bold text-white"

const checkoutDividerClassName =
  "h-px flex-1 bg-beyonix-blue-light/14"

const checkoutSectionKickerClassName =
  "shrink-0 text-9px font-bold uppercase tracking-[0.16em] text-white/46"

const checkoutManualToggleClassName =
  "text-11px font-bold text-[#4f8cc9]/85 underline-offset-2 hover:text-[#4f8cc9] hover:underline"

const checkoutOptionClassName =
  "checkout-option flex w-full cursor-pointer rounded-lg border border-beyonix-blue-light/16 bg-[#10151C] text-left transition-all hover:border-beyonix-blue-light/55 hover:bg-[#112A43]/38 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-beyonix-blue-light/22"

const checkoutOptionSelectedClassName =
  "checkout-option-selected border-beyonix-blue-light/70 bg-[#112A43] shadow-[inset_0_1px_0_rgba(255,255,255,0.045),0_0_0_1px_rgba(79,131,173,0.18)]"

const checkoutPrimaryButtonClassName =
  "inline-flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-beyonix-blue-light/42 bg-beyonix-blue font-black text-white shadow-[0_0_14px_rgba(47,111,163,0.16)] transition-all duration-200 hover:border-beyonix-blue-light/70 hover:bg-[#183B5E] hover:shadow-[0_0_18px_rgba(47,111,163,0.22)]"

const checkoutSecondaryButtonClassName =
  "inline-flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-beyonix-blue-light/24 bg-[#10151C] font-bold text-white/78 transition-all duration-200 hover:border-beyonix-blue-light/55 hover:bg-[#112A43]/42 hover:text-white"

const checkoutDisabledButtonClassName =
  "cursor-not-allowed border-white/10 bg-[#111820] text-white/45 shadow-none hover:border-white/10 hover:bg-[#111820] hover:text-white/45"

function CheckoutNotice({
  children,
  tone = "info",
  className,
}: {
  children: ReactNode
  tone?: "info" | "error" | "warning"
  className?: string
}) {
  return (
    <div
      className={cn(
        "checkout-note flex items-start gap-2.5 rounded-lg border px-3.5 py-3 text-sm leading-5",
        tone === "error"
          ? "beyonix-checkout-notice-error border-red-400/24 bg-red-500/10 text-red-200"
          : tone === "warning"
            ? "beyonix-checkout-notice-warning border-amber-300/22 bg-amber-300/[0.055] text-white/82"
            : "border-beyonix-blue-light/16 bg-[#10151C] text-white/68",
        className,
      )}
    >
      {tone === "error" ? (
        <AlertCircle className="beyonix-checkout-notice-error-icon mt-0.5 size-4 shrink-0 text-red-300" />
      ) : tone === "warning" ? (
        <Clock3 className="beyonix-checkout-notice-warning-icon mt-0.5 size-4 shrink-0 text-amber-300" />
      ) : null}
      <div className="min-w-0">{children}</div>
    </div>
  )
}

/**
 * Tarjeta de una opción de pago: radio nativo (teclado y lectores de
 * pantalla funcionan sin estado extra) envuelto en un label grande y
 * clickeable. `action` (p. ej. "Ver cuotas") es un botón aparte: al estar
 * dentro del label no selecciona la opción, sólo abre información.
 */
function CheckoutPaymentOptionCard({
  option,
  checked,
  onSelect,
  icon: Icon,
  title,
  description,
  badge,
  highlight,
  action,
}: {
  option: CheckoutPaymentOption
  checked: boolean
  onSelect: (option: CheckoutPaymentOption) => void
  icon: LucideIcon
  title: string
  description: string
  badge?: ReactNode
  highlight?: ReactNode
  action?: ReactNode
}) {
  return (
    <label
      data-payment-option={option}
      className={cn(
        checkoutOptionClassName,
        "checkout-choice items-start gap-3 p-4 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-beyonix-blue-light/40",
        checked && checkoutOptionSelectedClassName,
      )}
    >
      <input
        type="radio"
        name="checkout-payment-option"
        value={option}
        checked={checked}
        onChange={() => onSelect(option)}
        className="sr-only"
      />
      <span className="mt-0.5">
        <CheckoutRadioIndicator checked={checked} />
      </span>
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-black/35 text-white/65">
        <Icon aria-hidden="true" className="size-4.5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-semibold text-white">{title}</span>
          {badge}
        </span>
        <span className="mt-0.5 block text-sm text-white/55">{description}</span>
        {highlight && <span className="mt-1 block text-sm text-white/55">{highlight}</span>}
        {action}
      </span>
    </label>
  )
}

/** Cuotas SÓLO informativas: filas de texto, sin controles ni estado. */
function InstallmentPlanList({ plans }: { plans: CheckoutInstallmentPlan[] }) {
  return (
    <ul
      data-installment-plans
      className="beyonix-modal-list mt-3 divide-y divide-white/[0.06] rounded-lg border border-white/8 bg-white/[0.03] px-3"
    >
      {plans.map((plan) => (
        <li
          key={plan.count}
          data-installment-plan={plan.count}
          className="flex items-center justify-between gap-3 py-2 text-[13px]"
        >
          <span className="beyonix-modal-title text-white/90">
            {plan.count} cuotas sin interés de
          </span>
          <span className="beyonix-modal-title font-semibold text-white">
            {formatPrice(plan.amount)}
          </span>
        </li>
      ))}
    </ul>
  )
}

/** Advertencia obligatoria del modal "en cuotas" (Checkout Pro permite 1 pago sobre el total financiado). */
const MERCADOPAGO_FINANCED_TOTAL_WARNING =
  "Si dentro de Mercado Pago elegís pagar en 1 solo pago o con dinero en cuenta, se mantendrá este total financiado."

/** Medios que admite la preferencia al contado (installments=1). */
const MERCADOPAGO_CASH_MEDIA = [
  "Dinero disponible en tu cuenta de Mercado Pago",
  "Tarjeta de débito",
  "Tarjeta de crédito en 1 pago",
] as const

function MercadoPagoCashMediaList() {
  return (
    <ul className="beyonix-modal-list divide-y divide-white/[0.06] rounded-lg border border-white/8 bg-white/[0.03] px-3">
      {MERCADOPAGO_CASH_MEDIA.map((medium) => (
        <li key={medium} className="beyonix-modal-title py-2 text-[13px] text-white/90">
          {medium}
        </li>
      ))}
    </ul>
  )
}

function CheckoutPaymentInfoLink({
  onClick,
  children,
}: {
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={(event) => {
        event.preventDefault()
        onClick()
      }}
      className="mt-1 cursor-pointer text-xs font-semibold text-beyonix-sky underline-offset-2 hover:underline"
    >
      {children}
    </button>
  )
}

/**
 * Indicador visual del radio nativo (que queda sr-only dentro del label):
 * círculo vacío sin elegir; círculo lleno con un check al elegir.
 */
function CheckoutRadioIndicator({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden="true"
      data-checked={checked ? "true" : "false"}
      className={cn(
        "checkout-choice-radio flex size-5 shrink-0 items-center justify-center rounded-full border-2 transition-colors",
        checked
          ? "border-[var(--checkout-choice-indicator)] bg-[var(--checkout-choice-indicator)]"
          : "border-[var(--checkout-choice-indicator-idle)]",
      )}
    >
      {checked && (
        <Check
          strokeWidth={3.5}
          className="checkout-choice-radio-check size-3 text-[var(--checkout-choice-indicator-dot)]"
        />
      )}
    </span>
  )
}

const CHECKOUT_EMAIL = "beyonix.ar@gmail.com"
const CHECKOUT_EMAIL_URL = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(CHECKOUT_EMAIL)}&su=${encodeURIComponent("Consulta sobre mi compra en BEYONIX")}`

const initialCheckoutFormData = {
  nombre: "",
  email: "",
  telefono: "",
  dni: "",
  direccion: "",
  calle: "",
  numero: "",
  piso: "",
  departamento: "",
  cpDestino: "",
  localidad: "",
  provincia: "",
  referencias: "",
}

type ShippingType = "sucursal" | "domicilio"

interface ShippingOption {
  type: ShippingType
  label: string
  price: number
  quoteToken: string
  provider: "andreani"
  quoteStatus: "quoted" | "pending"
  /** Sucursales Andreani reales disponibles para el destino cotizado, ordenadas por cercanía cuando se pudo geocodificar el domicilio. Sólo presente en la opción "sucursal". */
  branches?: AndreaniBranchWithDistance[]
}

interface CheckoutStoreBenefit {
  id: string
  benefit_type: StoreBenefitType
  code: string
  percent: number
}

type CheckoutStep = 1 | 2 | 3

const checkoutSteps = [
  {
    id: 1 as const,
    label: "Quién recibe",
  },
  {
    id: 2 as const,
    label: "Envío",
  },
  {
    id: 3 as const,
    label: "Pago",
  },
]

function hasLetters(value: string) {
  return /\p{L}/u.test(value)
}

type RequiredCheckoutField =
  | "nombre"
  | "email"
  | "telefono"
  | "dni"
  | "calle"
  | "numero"
  | "cpDestino"
  | "localidad"
  | "provincia"

function getFirstInvalidCheckoutField(
  data: typeof initialCheckoutFormData
): RequiredCheckoutField | null {
  const nombre = data.nombre.trim()
  const email = data.email.trim()
  const telefono = normalizeArgentineNationalPhone(data.telefono)
  const dni = data.dni.replace(/\D/g, "")
  const calle = data.calle.trim()
  const numero = data.numero.trim()
  const cpDestino = data.cpDestino.trim()
  const localidad = data.localidad.trim()
  const provincia = data.provincia.trim()

  if (nombre.length < 3 || !hasLetters(nombre)) return "nombre"
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "email"
  if (!isValidArgentineNationalPhone(telefono)) return "telefono"
  if (!/^\d{7,8}$/.test(dni)) return "dni"
  if (calle.length < 2 || calle.length > FIELD_LIMITS.street || !hasLetters(calle)) return "calle"
  if (numero.length < 1) return "numero"
  if (!/^\d{4}$/.test(cpDestino)) return "cpDestino"
  if (localidad.length < 2 || !hasLetters(localidad)) return "localidad"
  if (provincia.length < 2 || !hasLetters(provincia)) return "provincia"

  return null
}

function isValidCheckoutForm(data: typeof initialCheckoutFormData) {
  return getFirstInvalidCheckoutField(data) === null
}

export default function CheckoutPage() {
  const router = useRouter()
  const {
    user,
    isLoading,
    isInternal,
  } = useAuth()
  const adminNotifications = useOrderNotifications(isInternal)
  const {
    cart: items,
    cartSessionId,
    isReady: isCartReady,
    clearCart,
    startNewCheckoutSession,
    increaseQuantity,
    decreaseQuantity,
    removeFromCart,
  } = useCart()
  const customerCredit = useCustomerCredit()
  const siteSettings = useSiteSettings()

  const [mounted, setMounted] =
    useState(false)

  const [
    selectedPayment,
    setSelectedPayment,
  ] = useState("")

  const [mercadoPagoMode, setMercadoPagoMode] =
    useState<MercadoPagoCheckoutMode>("cash")
  // Aceptación de términos ligada a la sesión de checkout (cartSessionId):
  // se conserva al cambiar de medio/modalidad y queda sin efecto sola en una
  // compra/sesión nueva (clearCart genera otro id). Nunca se persiste.
  const [termsAcceptedSessionId, setTermsAcceptedSessionId] =
    useState<string | null>(null)
  const termsAccepted =
    Boolean(cartSessionId) && termsAcceptedSessionId === cartSessionId
  // Confirmación antes de ir a Mercado Pago (la preferencia se crea al confirmar).
  const [mercadoPagoConfirmOpen, setMercadoPagoConfirmOpen] = useState(false)
  // Detalle informativo abierto ("Ver cuotas" / "Ver medios"): no afecta el pago.
  const [paymentInfoModal, setPaymentInfoModal] =
    useState<"installments" | "mercadopago_cash" | null>(null)
  // Aviso de "precios o condiciones actualizados" (refresco en vivo o 409
  // PRICING_CHANGED del servidor): un total nunca cambia en silencio.
  const [commercialUpdateNotice, setCommercialUpdateNotice] =
    useState<string | null>(null)
  // Total recalculado por el servidor en un 409 PRICING_CHANGED, ligado al
  // total que mostraba la pantalla en ese momento. Si después del refresco
  // la pantalla sigue mostrando lo mismo, se reenvía el total del servidor
  // (el cliente ya lo vio en el aviso); si la pantalla cambió, se usa el
  // nuevo total de pantalla.
  const [serverConfirmedTotal, setServerConfirmedTotal] = useState<{
    displayedTotal: number
    serverTotal: number
  } | null>(null)

  const [
    isProcessing,
    setIsProcessing,
  ] = useState(false)

  const [formData, setFormData] =
    useState(initialCheckoutFormData)
  const [localityOptions, setLocalityOptions] =
    useState<CheckoutLocalityOption[]>([])
  const [postalCodeOptions, setPostalCodeOptions] = useState<string[]>([])
  const [localitiesLoading, setLocalitiesLoading] = useState(false)
  const [localityLoadError, setLocalityLoadError] = useState("")
  const [postalCodesLoading, setPostalCodesLoading] = useState(false)
  // Separado de "sin resultados" real: un timeout/error de red al pedir el
  // catálogo de CP no debe mostrarse como "sin códigos postales disponibles"
  // (ver showManualPostalCodeOption más abajo).
  const [postalCodeLoadError, setPostalCodeLoadError] = useState("")
  const [postalCodeRetryNonce, setPostalCodeRetryNonce] = useState(0)
  const [manualLocalityMode, setManualLocalityMode] = useState(false)
  const [manualPostalCodeMode, setManualPostalCodeMode] = useState(false)

  const [checkoutError, setCheckoutError] =
    useState("")
  const [insufficientStockItems, setInsufficientStockItems] =
    useState<InsufficientStockModalItem[]>([])
  const [reservationStockError, setReservationStockError] = useState(false)
  const [shippingMessage, setShippingMessage] =
    useState("")
  const [shippingMessageTone, setShippingMessageTone] =
    useState<"info" | "error">("info")
  const [shippingLoading, setShippingLoading] = useState(false)
  const [shippingQuoteCurrent, setShippingQuoteCurrent] = useState(false)
  const [
    selectedShippingType,
    setSelectedShippingType,
  ] = useState<ShippingType | null>(null)
  const [shippingOptions, setShippingOptions] =
    useState<ShippingOption[]>([])
  const [selectedSucursalId, setSelectedSucursalId] =
    useState<number | null>(null)
  const [currentStep, setCurrentStep] =
    useState<CheckoutStep>(1)
  const [stockReservation, setStockReservation] = useState<{
    expiresAt: string
    serverNow: string
    receivedAt: number
    items: ReturnType<typeof reservationItemsFromCart>
  } | null>(null)
  const [reservationSeconds, setReservationSeconds] = useState(0)
  const [reservationPending, setReservationPending] = useState(false)
  const [reservationExpired, setReservationExpired] = useState(false)
  const reservationExpiryHandledRef = useRef(false)
  const reservationActionInFlightRef = useRef(false)
  const reservationRevisionRef = useRef(0)
  const reservationRedirectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [invalidField, setInvalidField] =
    useState<RequiredCheckoutField | null>(null)
  const [shippingSelectionMissing, setShippingSelectionMissing] =
    useState(false)
  const [storeBenefits, setStoreBenefits] =
    useState<CheckoutStoreBenefit[]>([])
  const [selectedStoreBenefitId, setSelectedStoreBenefitId] =
    useState("")
  const hasEditedCheckoutFormRef = useRef(false)
  const submissionInFlightRef = useRef(false)
  const validationTimerRef =
    useRef<ReturnType<typeof setTimeout> | null>(null)
  // Identidad de request por efecto (no AbortController): la caché
  // compartida de `checkout-quote-client.ts` deja de depender del
  // AbortSignal de quien la disparó primero, así que "cancelar" acá ya no
  // significa abortar la request real -- significa ignorar su resultado si
  // llega para una selección que ya quedó vieja.
  const localityRequestIdRef = useRef(0)
  const postalCodeRequestIdRef = useRef(0)
  const shippingRequestIdRef = useRef(0)
  // Espejo en ref de `shippingQuoteCurrent`, legible desde los efectos de
  // catálogo territorial (que no lo tienen en sus dependencias) para no
  // dejar que una respuesta de catálogo le gane a un destino que la
  // cotización real ya confirmó válido.
  const shippingQuoteCurrentRef = useRef(false)
  // Última calle/numero tipeados, leídos al momento de armar una cotización
  // real (no forman parte de la clave de caché ni disparan una cotización
  // nueva por sí solos -- ver `shippingQuoteDestination`/`buildShippingQuoteKey`).
  // Así, cuando el efecto sí se dispara por otro motivo (CP/localidad/carrito),
  // usa la dirección más actual sin geocodificar en cada tecla.
  const latestStreetAddressRef = useRef({ calle: "", numero: "" })
  const provinceSelectOptions = useMemo(
    () =>
      ARGENTINA_PROVINCES.map((province) => ({
        value: province.toLocaleUpperCase("es-AR"),
        label: province.toLocaleUpperCase("es-AR"),
      })),
    [],
  )
  const localitySelectOptions = useMemo(
    () =>
      localityOptions.map((option) => ({
        value: option.name,
        label: option.name,
      })),
    [localityOptions],
  )
  const postalCodeSelectOptions = useMemo(
    () =>
      postalCodeOptions.map((postalCode) => ({
        value: postalCode,
        label: postalCode,
      })),
    [postalCodeOptions],
  )

  useEffect(() => {
    setMounted(true)

    return () => {
      if (validationTimerRef.current) {
        clearTimeout(validationTimerRef.current)
      }
      if (reservationRedirectTimerRef.current) {
        clearTimeout(reservationRedirectTimerRef.current)
      }
    }
  }, [])

  const expireStockReservation = useCallback(() => {
    if (reservationExpiryHandledRef.current) return
    reservationExpiryHandledRef.current = true
    sessionStorage.removeItem(CHECKOUT_STEP_RESERVATION_KEY)
    setReservationExpired(true)
    setStockReservation(null)
    setReservationSeconds(0)
    setMercadoPagoConfirmOpen(false)
    startNewCheckoutSession()
    reservationRedirectTimerRef.current = setTimeout(() => router.replace("/"), 2800)
  }, [router, startNewCheckoutSession])

  useEffect(() => {
    if (!mounted || !isCartReady || !cartSessionId) return
    if (sessionStorage.getItem(CHECKOUT_STEP_RESERVATION_KEY) !== cartSessionId) return
    let cancelled = false
    startTransition(() => {
      void getCartStockReservation(cartSessionId).then((snapshot) => {
        if (cancelled) return
        if (snapshot.status === "expired" || snapshot.status === "missing") {
          expireStockReservation()
        } else if (snapshot.status === "active") {
          const receivedAt = performance.now()
          setStockReservation({
            expiresAt: snapshot.expiresAt,
            serverNow: snapshot.serverNow,
            receivedAt,
            items: snapshot.items,
          })
          setReservationSeconds(reservationSecondsLeft(
            snapshot.expiresAt, snapshot.serverNow, receivedAt, receivedAt,
          ))
        } else if (snapshot.status === "error") {
          setCheckoutError("No pudimos comprobar tu reserva. Intentá nuevamente.")
        } else {
          sessionStorage.removeItem(CHECKOUT_STEP_RESERVATION_KEY)
          setCheckoutError("Tu reserva ya no está disponible. Volvé a revisar tu compra.")
        }
      }).catch(() => {
        if (!cancelled) setCheckoutError("No pudimos comprobar tu reserva. Intentá nuevamente.")
      })
    })
    return () => { cancelled = true }
  }, [mounted, isCartReady, cartSessionId, expireStockReservation])

  useEffect(() => {
    if (!stockReservation || reservationExpired || !cartSessionId) return
    let cancelled = false
    const synchronize = () => {
      if (reservationActionInFlightRef.current) return
      const revision = reservationRevisionRef.current
      startTransition(() => {
        void getCartStockReservation(cartSessionId).then((snapshot) => {
          if (cancelled || revision !== reservationRevisionRef.current) return
          if (snapshot.status === "expired" || snapshot.status === "missing") {
            expireStockReservation()
          } else if (snapshot.status === "active") {
            const receivedAt = performance.now()
            setStockReservation({
              expiresAt: snapshot.expiresAt,
              serverNow: snapshot.serverNow,
              receivedAt,
              items: snapshot.items,
            })
            if (!reservationMatchesCart(snapshot.items, reservationItemsFromCart(items))) {
              setCurrentStep(2)
              setMercadoPagoConfirmOpen(false)
              setCheckoutError("La reserva cambió en otra pestaña. Revisá tu carrito y volvé a continuar.")
            }
          }
        }).catch(() => {
          if (!cancelled) setCheckoutError("No pudimos comprobar tu reserva. Intentá nuevamente.")
        })
      })
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") synchronize()
    }
    window.addEventListener("focus", synchronize)
    document.addEventListener("visibilitychange", onVisibilityChange)
    return () => {
      cancelled = true
      window.removeEventListener("focus", synchronize)
      document.removeEventListener("visibilitychange", onVisibilityChange)
    }
  }, [stockReservation, reservationExpired, cartSessionId, items, expireStockReservation])

  useEffect(() => {
    if (!stockReservation || reservationExpired) return
    const tick = () => {
      const seconds = reservationSecondsLeft(
        stockReservation.expiresAt,
        stockReservation.serverNow,
        stockReservation.receivedAt,
        performance.now(),
      )
      setReservationSeconds(seconds)
      if (seconds === 0) expireStockReservation()
    }
    tick()
    const timer = window.setInterval(tick, 1000)
    return () => window.clearInterval(timer)
  }, [stockReservation, reservationExpired, expireStockReservation])

  // `useAuth().user` ya está poblado con el mismo perfil que antes se
  // volvía a pedir acá (login/restauración de sesión lo carga vía
  // `profileToUser`, y "Mi cuenta" lo mantiene sincronizado en la misma
  // sesión: `updateUser()` en auth-context.tsx hace `setUser` con la
  // respuesta confirmada del servidor apenas se guarda un cambio). Seedear
  // el checkout directamente desde memoria evita un round-trip a Supabase
  // redundante en cada mount, sin perder frescura.
  useEffect(() => {
    if (!user) return
    if (hasEditedCheckoutFormRef.current) return

    const currentUser = user
    const fallbackAddress = currentUser.address ?? ""
    const parsedAddress = parseDeliveryAddress(
      fallbackAddress,
      currentUser.province,
      currentUser.postalCode
    )

    setFormData((prev) => {
      const next = {
        ...prev,
      }
      const profileValues = {
        nombre: currentUser.name ?? "",
        email: currentUser.email ?? "",
        telefono: currentUser.phone ?? "",
        dni: (currentUser.dni ?? "").replace(/\D/g, "").slice(0, 8),
        direccion: fallbackAddress,
        calle: currentUser.street ?? parsedAddress.street,
        numero: currentUser.streetNumber ?? parsedAddress.streetNumber,
        piso: currentUser.floor ?? parsedAddress.floor,
        departamento: currentUser.apartment ?? parsedAddress.apartment,
        cpDestino: currentUser.postalCode ?? "",
        localidad: currentUser.city ?? parsedAddress.locality,
        provincia: currentUser.province ?? "",
        referencias: currentUser.references ?? "",
      }

      for (const [key, value] of Object.entries(profileValues)) {
        const field = key as keyof typeof initialCheckoutFormData
        const normalizedValue = String(value ?? "").trim()

        if (!next[field] && normalizedValue) {
          next[field] = String(value).toLocaleUpperCase("es-AR")
        }
      }

      if (!next.direccion && next.calle && next.numero) {
        next.direccion = formatDeliveryAddress({
          street: next.calle,
          streetNumber: next.numero,
          floor: next.piso,
          apartment: next.departamento,
          locality: next.localidad,
          region: next.provincia,
          postalCode: next.cpDestino,
        })
      }

      return next
    })
  }, [user])

  useEffect(() => {
    if (!user) {
      setStoreBenefits([])
      setSelectedStoreBenefitId("")
      return
    }

    let cancelled = false

    async function loadStoreBenefits() {
      try {
        const response = await fetch("/api/account/store-benefits")
        const data = (await response.json()) as {
          benefits?: CheckoutStoreBenefit[]
        }

        if (cancelled) return

        const benefits = data.benefits ?? []
        setStoreBenefits(benefits)
        setSelectedStoreBenefitId((current) =>
          benefits.some((benefit) => benefit.id === current)
            ? current
            : benefits[0]?.id ?? "",
        )
      } catch {
        if (!cancelled) {
          setStoreBenefits([])
          setSelectedStoreBenefitId("")
        }
      }
    }

    void loadStoreBenefits()

    return () => {
      cancelled = true
    }
  }, [user])

  const baseTotals = calculateCartTotals(items)
  const totalCartUnits = items.reduce(
    (total, item) => total + item.quantity,
    0,
  )
  const selectedShippingOption =
    selectedShippingType
      ? shippingOptions.find(
          (option) =>
            option.type ===
            selectedShippingType
        ) ?? null
      : null
  const shippingCostReal =
    selectedShippingOption?.price ?? 0
  const hasAndreaniQuote = selectedShippingOption?.quoteStatus === "quoted"
  const customerCreditIncludesShippingBenefit = customerCredit.balance > 0
  const customerCreditCoversShipping =
    customerCreditIncludesShippingBenefit &&
    selectedShippingOption != null &&
    shippingCostReal > 0
  const shippingBonus =
    hasAndreaniQuote
      ? customerCreditCoversShipping
        ? shippingCostReal
        : calculateShippingBonus(
            baseTotals.productsTotal,
            shippingCostReal,
            siteSettings.shipping,
          )
      : 0
  const shippingCostCharged =
    selectedShippingOption && hasAndreaniQuote
      ? customerCreditCoversShipping
        ? 0
        : calculateCustomerShippingCost(
            baseTotals.productsTotal,
            shippingCostReal,
            siteSettings.shipping,
          )
      : 0
  const totals = calculateCartTotals(items, {
    shippingCost: shippingCostCharged,
  })
  // Distingue las dos políticas de envío para la UI (nunca se acumulan, ver
  // calculateCustomerShippingCost): la política grande por compra mínima se
  // comunica con precio tachado + "Ahorrás" (GRATIS incluido); el subsidio
  // logístico chico para pedidos que no llegan al mínimo es sólo un precio
  // final ("Envío $X"), sin tachado ni promoción -- es lo que BEYONIX decide
  // cobrar por el servicio, no lo que "descontó" de la tarifa de Andreani.
  const qualifiesForMainShippingBonus = hasShippingBonus(
    baseTotals.productsTotal,
    siteSettings.shipping,
  )
  const selectedStoreBenefit =
    storeBenefits.find((benefit) => benefit.id === selectedStoreBenefitId) ??
    null
  const storeBenefitDiscountAmount = selectedStoreBenefit
    ? calculateStoreBenefitDiscount(
        totals.productsTotal,
        selectedStoreBenefit.percent,
      )
    : 0
  const productsTotalAfterStoreBenefit = Math.max(
    totals.productsTotal - storeBenefitDiscountAmount,
    0,
  )
  const isTransferPayment = selectedPayment === "transferencia"
  const isMercadoPagoPayment = selectedPayment === "mercadopago"
  // Mismo cálculo canónico que create-preference (lib/pricing/checkout-pricing.ts).
  // Acá es sólo informativo: el servidor recalcula TODO con datos actuales
  // de la base al presionar Pagar y nunca cobra lo que mande el navegador.
  const checkoutPricingLines: CheckoutPricingLine[] = items.map((item) => ({
    productId: item.product.id,
    variantId: item.variantId,
    conditionedStockId: item.conditionedStockId,
    quantity: item.quantity,
    unitPrice: item.unitPrice ?? item.product.precio,
    installments: item.product,
  }))
  const checkoutPricingSettings = {
    installmentsFinancing: siteSettings.installmentsFinancing,
    transferDiscountPercent: siteSettings.pricing.transferDiscountPercent,
    nationalTaxesIncidencePercent: siteSettings.pricing.nationalTaxesIncidencePercent,
  }
  const mercadoPagoPricingBeforeCredit = calculateMercadoPagoCheckoutPricing({
    lines: checkoutPricingLines,
    shippingCharged: totals.shipping,
    storeBenefitPercent: selectedStoreBenefit?.percent ?? null,
    requestedCustomerCredit: 0,
    settings: checkoutPricingSettings,
  })
  // "En cuotas" sólo existe si todo el carrito admite financiación; si deja
  // de estar disponible (Admin cambió cuotas), se vuelve a "Al contado".
  const effectiveMercadoPagoMode: MercadoPagoCheckoutMode =
    mercadoPagoMode === "financed" && mercadoPagoPricingBeforeCredit.financed
      ? "financed"
      : "cash"
  const cashTotalBeforeCredit = mercadoPagoPricingBeforeCredit.cashTotal
  const totalBeforeCustomerCreditByMethod =
    isMercadoPagoPayment &&
    effectiveMercadoPagoMode === "financed" &&
    mercadoPagoPricingBeforeCredit.financedTotal != null
      ? mercadoPagoPricingBeforeCredit.financedTotal
      : cashTotalBeforeCredit
  const maxApplicableCustomerCredit = getMaxApplicableCustomerCredit(
    customerCredit.balance,
    totalBeforeCustomerCreditByMethod,
  )
  const transferPaymentTotals = calculateTransferPaymentTotalAfterCustomerCredit({
    productsTotal: productsTotalAfterStoreBenefit,
    shipping: totals.shipping,
    customerCreditAmount: maxApplicableCustomerCredit,
    transferDiscountPercent: siteSettings.pricing.transferDiscountPercent,
  })
  const transferDiscountAmount = isTransferPayment
    ? transferPaymentTotals.discount
    : 0
  const totalBeforeCustomerCredit = isTransferPayment
    ? totalBeforeCustomerCreditByMethod - transferDiscountAmount
    : totalBeforeCustomerCreditByMethod
  const customerCreditApplication = calculateCustomerCreditApplication({
    availableBalance: customerCredit.balance,
    eligibleTotal: totalBeforeCustomerCredit,
    requestedAmount: maxApplicableCustomerCredit,
  })
  const customerCreditCoversTotal =
    customerCreditApplication.appliedAmount > 0 &&
    customerCreditApplication.externalAmountDue === 0
  const isSelectedPaymentValid =
    customerCreditCoversTotal ||
    CHECKOUT_PAYMENT_METHOD_IDS.some((methodId) => methodId === selectedPayment)
  // El modal de "Stock insuficiente" solo puede aparecer como respuesta al
  // intento real de pago (ver handleSubmit): no hay ninguna validación
  // proactiva de stock mientras el cliente completa el Checkout.
  const hasKnownStockConflict = insufficientStockItems.length > 0
  // Con saldo a favor: mismo pedido de saldo que se envía al servidor
  // (customerCreditAmount), mismas dos modalidades calculadas con él.
  const mercadoPagoPricing = calculateMercadoPagoCheckoutPricing({
    lines: checkoutPricingLines,
    shippingCharged: totals.shipping,
    storeBenefitPercent: selectedStoreBenefit?.percent ?? null,
    requestedCustomerCredit: customerCreditApplication.appliedAmount,
    settings: checkoutPricingSettings,
  })
  const mercadoPagoQuote = isMercadoPagoPayment
    ? getMercadoPagoModeQuote(mercadoPagoPricing, effectiveMercadoPagoMode)
    : null
  const isMercadoPagoFinanced = mercadoPagoQuote?.mode === "financed"
  const finalTotal =
    mercadoPagoQuote?.externalAmountDue ?? customerCreditApplication.externalAmountDue
  // Con cuotas, el saldo aplicado se ajusta al múltiplo de las cuotas (ver
  // roundUpCheckoutTotalForInstallments); el mismo que aplica create-preference.
  const appliedCustomerCredit =
    mercadoPagoQuote?.customerCreditApplied ?? customerCreditApplication.appliedAmount
  // Opción visible elegida, derivada del estado existente (no hay estado nuevo).
  const selectedPaymentOption = getCheckoutPaymentOption(
    selectedPayment,
    effectiveMercadoPagoMode,
  )
  const isMercadoPagoFinancingAvailable = mercadoPagoPricingBeforeCredit.financed != null
  const selectPaymentOption = (option: CheckoutPaymentOption) => {
    if (option === "transferencia") {
      setSelectedPayment("transferencia")
      return
    }
    setSelectedPayment("mercadopago")
    setMercadoPagoMode(option === "mercadopago_financed" ? "financed" : "cash")
  }
  // Filas del resumen: Productos − Beneficio + Envío = Total, exacto y con
  // los valores canónicos de la modalidad elegida (contado, financiado o
  // con descuento por transferencia).
  const checkoutSummary = isTransferPayment
    ? getTransferSummaryBreakdown({
        productsTotal: totals.productsTotal,
        storeBenefitDiscountAmount,
        shipping: totals.shipping,
        transferDiscountAmount,
      })
    : getMercadoPagoSummaryBreakdown(
        mercadoPagoPricing,
        isMercadoPagoPayment ? effectiveMercadoPagoMode : "cash",
      )
  // Importe de cada línea del resumen en la modalidad elegida: suma
  // exactamente la fila "Productos" (cálculo canónico, sólo presentación).
  const summaryLineAmounts = getCheckoutSummaryLineAmounts({
    lines: checkoutPricingLines,
    mode: isTransferPayment
      ? "transfer"
      : isMercadoPagoPayment && effectiveMercadoPagoMode === "financed"
        ? "financed"
        : "cash",
    installmentsFinancing: siteSettings.installmentsFinancing,
    productsSubtotal: checkoutSummary.productsSubtotal,
  })
  // Cuotas informativas ("Ver cuotas") con el MISMO saldo a favor que se
  // aplicaría al elegir "en cuotas" (el checkout aplica siempre el máximo
  // aplicable sobre el total de la modalidad): así coinciden con lo que se
  // va a cobrar, esté elegida o no esa opción. Idéntico a mercadoPagoPricing
  // cuando "en cuotas" ya está seleccionada.
  const financedPreviewPricing = calculateMercadoPagoCheckoutPricing({
    lines: checkoutPricingLines,
    shippingCharged: totals.shipping,
    storeBenefitPercent: selectedStoreBenefit?.percent ?? null,
    requestedCustomerCredit:
      mercadoPagoPricingBeforeCredit.financedTotal != null
        ? getMaxApplicableCustomerCredit(
            customerCredit.balance,
            mercadoPagoPricingBeforeCredit.financedTotal,
          )
        : 0,
    settings: checkoutPricingSettings,
  })
  const financedPreviewQuote = financedPreviewPricing.financed
  // Disclosure CFTEA compacto: sólo presentación de los valores canónicos
  // (calculateCftea sin cambios), 1 decimal es-AR como en el resto del sitio.
  const cfteaSummary = financedPreviewPricing.installmentPlans
    .flatMap((plan) =>
      plan.cfteaPercent != null
        ? [`${plan.count} cuotas ${formatCfteaPercent(plan.cfteaPercent)}%`]
        : [],
    )
    .join(" · ")
  const maxInstallmentPlan = isMercadoPagoFinanced
    ? mercadoPagoPricing.installmentPlans.find(
        (plan) => plan.count === mercadoPagoPricing.maxInstallmentCount,
      ) ?? null
    : null
  // Total que se envía como `expectedTotal` (Mercado Pago y transferencia):
  // sólo para que el servidor rechace (409) si recalcula otro monto; nunca
  // se usa para cobrar.
  const expectedCheckoutTotal =
    serverConfirmedTotal &&
    Math.abs(serverConfirmedTotal.displayedTotal - finalTotal) <= 0.009
      ? serverConfirmedTotal.serverTotal
      : finalTotal
  const priceWithoutNationalTaxesTotal = getPriceWithoutNationalTaxes(
    finalTotal,
    siteSettings.pricing.nationalTaxesIncidencePercent,
  )

  // Cambios administrativos (precio, stock, cuotas, fees, transferencia,
  // envío) mientras el checkout está abierto: se refrescan carrito y
  // configuración y se avisa. Sólo UX -- Pagar revalida todo server-side.
  const refreshCommercialData = useCommercialRefresh({
    enabled: mounted && isCartReady && items.length > 0,
    onChange: () => setCommercialUpdateNotice(COMMERCIAL_UPDATE_NOTICE),
  })

  useEffect(() => {
    if (customerCredit.loading) return

    if (
      Math.abs(customerCredit.appliedAmount - maxApplicableCustomerCredit) >
      0.009
    ) {
      customerCredit.setAppliedAmount(maxApplicableCustomerCredit)
    }
  }, [
    customerCredit.loading,
    customerCredit.appliedAmount,
    customerCredit.setAppliedAmount,
    maxApplicableCustomerCredit,
  ])

  useEffect(() => {
    const province = formData.provincia.trim()
    if (!province) {
      setLocalityOptions([])
      setLocalitiesLoading(false)
      setLocalityLoadError("")
      return
    }
    if (manualLocalityMode) {
      setLocalitiesLoading(false)
      return
    }

    const cacheKey = normalizeArgentineLocationKey(province)
    const requestId = ++localityRequestIdRef.current
    const isStale = () => localityRequestIdRef.current !== requestId

    const applyLocalities = (localities: CheckoutLocalityOption[]) => {
      setLocalityOptions(localities)

      // Si ya tenemos una cotización vigente para el destino actual (fast
      // path desde el perfil guardado, o una cotización manual ya
      // confirmada), Andreani ya validó ese destino de verdad -- el
      // catálogo de Georef no debe pisarlo aunque no encuentre un match
      // textual exacto.
      if (shippingQuoteCurrentRef.current) return

      setFormData((prev) => {
        if (normalizeArgentineLocationKey(prev.provincia) !== cacheKey) return prev
        if (!prev.localidad) return prev

        const canonical = findCanonicalLocality(localities, prev.localidad)
        if (
          (canonical?.name ?? "") === prev.localidad &&
          (canonical || !prev.cpDestino)
        ) {
          return prev
        }

        const next = {
          ...prev,
          localidad: canonical?.name ?? "",
          cpDestino: canonical ? prev.cpDestino : "",
        }
        next.direccion = formatDeliveryAddress({
          street: next.calle,
          streetNumber: next.numero,
          floor: next.piso,
          apartment: next.departamento,
          locality: next.localidad,
          region: next.provincia,
          postalCode: next.cpDestino,
        })
        return next
      })
    }

    const cached = peekLocalitiesForProvince(province)
    if (cached) {
      setLocalityLoadError("")
      applyLocalities(cached)
      setLocalitiesLoading(false)
      return
    }

    setLocalitiesLoading(true)
    setLocalityLoadError("")
    getLocalitiesForProvince(province)
      .then((localities) => {
        if (isStale()) return
        setLocalityLoadError("")
        applyLocalities(localities)
      })
      .catch((error: unknown) => {
        if (isStale()) return
        setLocalityOptions([])
        setLocalityLoadError("No pudimos cargar las localidades. Intentá nuevamente.")
        setShippingMessageTone("error")
        setShippingMessage(
          error instanceof Error
            ? error.message
            : "No pudimos cargar las localidades.",
        )
      })
      .finally(() => {
        if (!isStale()) setLocalitiesLoading(false)
      })
  }, [formData.provincia, manualLocalityMode])

  useEffect(() => {
    const province = formData.provincia.trim()
    const locality = formData.localidad.trim()
    if (!province || !locality) {
      setPostalCodeOptions([])
      setPostalCodesLoading(false)
      setPostalCodeLoadError("")
      return
    }
    if (manualLocalityMode || manualPostalCodeMode) {
      setPostalCodesLoading(false)
      return
    }

    const provinceKey = normalizeArgentineLocationKey(province)
    const localityKey = normalizeArgentineLocationKey(locality)
    const requestId = ++postalCodeRequestIdRef.current
    const isStale = () => postalCodeRequestIdRef.current !== requestId

    const applyPostalCodes = (result: CheckoutPostalCodeResult) => {
      const postalCodes = result.postalCodes.filter((code) => /^\d{4}$/.test(code))
      setPostalCodeOptions(postalCodes)

      // Igual que en el efecto de localidades: no pisar un destino que la
      // cotización real ya confirmó válido (fast path desde el perfil
      // guardado). El catálogo sigue sirviendo para poblar el selector.
      if (shippingQuoteCurrentRef.current) return

      const currentPostalCode = formData.cpDestino.trim()
      const nextPostalCode = resolvePostalCodeFromCatalog(
        postalCodes,
        currentPostalCode,
      )

      setFormData((prev) => {
        if (
          normalizeArgentineLocationKey(prev.provincia) !== provinceKey ||
          normalizeArgentineLocationKey(prev.localidad) !== localityKey
        ) {
          return prev
        }

        const next = {
          ...prev,
          localidad: normalizeArgentineLocality(result.locality),
          cpDestino: nextPostalCode,
        }
        if (
          next.localidad === prev.localidad &&
          next.cpDestino === prev.cpDestino
        ) {
          return prev
        }
        next.direccion = formatDeliveryAddress({
          street: next.calle,
          streetNumber: next.numero,
          floor: next.piso,
          apartment: next.departamento,
          locality: next.localidad,
          region: next.provincia,
          postalCode: next.cpDestino,
        })
        return next
      })

    }

    const cached = peekPostalCodesForLocality(province, locality)
    if (cached) {
      setPostalCodeLoadError("")
      applyPostalCodes(cached)
      setPostalCodesLoading(false)
      return
    }

    setPostalCodesLoading(true)
    setPostalCodeLoadError("")
    getPostalCodesForLocality(province, locality)
      .then((result) => {
        if (isStale()) return
        setPostalCodeLoadError("")
        applyPostalCodes(result)
      })
      .catch((error: unknown) => {
        if (isStale()) return
        setPostalCodeOptions([])
        setPostalCodeLoadError(
          error instanceof Error
            ? error.message
            : "No pudimos cargar los códigos postales.",
        )
      })
      .finally(() => {
        if (!isStale()) setPostalCodesLoading(false)
      })
  }, [
    postalCodeRetryNonce,
    formData.cpDestino,
    formData.localidad,
    formData.provincia,
    manualLocalityMode,
    manualPostalCodeMode,
  ])

  const shippingQuoteDestination = {
    cpDestino: formData.cpDestino.trim(),
    localidad: formData.localidad.trim(),
    provincia: formData.provincia.trim(),
    direccion: formData.direccion,
    items: mapCartItemsToQuoteItems(items),
  }
  const shippingQuotePayload = buildShippingQuoteKey(shippingQuoteDestination)
  latestStreetAddressRef.current = {
    calle: formData.calle.trim(),
    numero: formData.numero.trim(),
  }
  // Fast path: un destino con provincia + localidad + CP de 4 dígitos ya es
  // apto para intentar cotizar directamente, sin esperar a que el catálogo
  // de localidades/CP termine de descargarse ni validarse -- ese catálogo
  // es una herramienta de edición aparte (ver los dos efectos anteriores).
  // El backend (`/api/andreani/cotizar`) valida el destino real por su
  // cuenta y es la autoridad final.
  const isDestinationQuotable = isQuotableDestination(shippingQuoteDestination)

  useEffect(() => {
    shippingQuoteCurrentRef.current = shippingQuoteCurrent
  }, [shippingQuoteCurrent])

  useEffect(() => {
    const payload = JSON.parse(shippingQuotePayload) as {
      cpDestino: string
      localidad: string
      provincia: string
      direccion: string
      items: Array<{
        productId: number
        quantity: number
        variantId: number | null
        conditionedStockId: string | null
      }>
    }
    const requestId = ++shippingRequestIdRef.current
    const isStale = () => shippingRequestIdRef.current !== requestId

    if (!isDestinationQuotable) {
      setShippingLoading(false)
      setShippingQuoteCurrent(false)
      setShippingOptions([])
      setSelectedShippingType(null)
      setSelectedSucursalId(null)
      setShippingMessageTone("info")
      setShippingMessage(
        !payload.provincia
          ? "Seleccioná una provincia."
          : !payload.localidad
            ? "Seleccioná una localidad."
            : "Seleccioná un código postal.",
      )
      return
    }
    if (payload.items.length === 0) {
      setShippingLoading(false)
      setShippingQuoteCurrent(false)
      setShippingOptions([])
      setSelectedShippingType(null)
      setSelectedSucursalId(null)
      setShippingMessage("")
      return
    }

    const applyRawOptions = (rawOptions: CheckoutQuoteRawOption[]) => {
      const options = rawOptions.flatMap<ShippingOption>((option) => {
        const price = Number(option.price)
        if (
          (option.type !== "domicilio" && option.type !== "sucursal") ||
          !Number.isFinite(price) ||
          price <= 0 ||
          typeof option.quoteToken !== "string" ||
          !option.quoteToken
        ) {
          return []
        }
        return [{
          type: option.type,
          label: getShippingOptionLabel(option.type),
          price,
          quoteToken: option.quoteToken,
          provider: "andreani" as const,
          quoteStatus: "quoted" as const,
          branches: option.type === "sucursal" ? option.branches : undefined,
        }]
      })
      if (!options.length) {
        throw new Error(ANDREANI_DESTINATION_UNAVAILABLE_MESSAGE)
      }

      setShippingOptions(options)
      setShippingQuoteCurrent(true)
      // El destino pudo haber cambiado: si la sucursal elegida antes ya no
      // está en la lista real recién cotizada, se descarta -- nunca se
      // arrastra una sucursal de otro destino.
      const branchOption = options.find((option) => option.type === "sucursal")
      setSelectedSucursalId((current) =>
        current !== null &&
        branchOption?.branches?.some((branch) => branch.id === current)
          ? current
          : null,
      )
      setSelectedShippingType((current) =>
        current && options.some((option) => option.type === current)
          ? current
          : options.find((option) => option.type === "domicilio")?.type ??
            options[0].type,
      )
      // La cotización quedó validada internamente (shippingQuoteCurrent ya
      // lo refleja) -- no hace falta mostrarle al cliente una confirmación
      // técnica neutra. Los mensajes de error reales siguen su propio
      // camino en handleQuoteFailure, sin tocar este componente.
      setShippingMessageTone("info")
      setShippingMessage("")
    }

    const handleQuoteFailure = (error: unknown, timedOut = false) => {
      const errorMessage =
        error instanceof Error ? error.message : "QUOTE_FAILED"
      if (process.env.NODE_ENV === "development") {
        console.info("[Andreani checkout] cotización no disponible", {
          reason: errorMessage.slice(0, 120),
        })
      }
      setShippingQuoteCurrent(false)
      setShippingMessageTone("error")
      setShippingMessage(
        timedOut
          ? "La cotización tardó demasiado. Intentá nuevamente."
          : errorMessage !== "QUOTE_FAILED"
            ? errorMessage
            : "No pudimos calcular el envío. Intentá nuevamente.",
      )
    }

    // La calle/numero actuales se suman acá (nunca en la clave de caché ni
    // en las dependencias del efecto): sólo se usan para geocodificar y
    // ordenar sucursales por cercanía cuando de cualquier forma ya toca
    // cotizar por otro motivo.
    const requestPayload = { ...payload, ...latestStreetAddressRef.current }

    // Si ya hay una cotización vigente para este destino+carrito exactos
    // (precargada al abrir el carrito o al hacer click en "Finalizar
    // compra"), se usa de inmediato: sin fetch ni parpadeo de "Calculando…".
    const cachedOptions = peekShippingQuoteOptions(requestPayload)
    if (cachedOptions) {
      setShippingLoading(false)
      try {
        applyRawOptions(cachedOptions)
      } catch (error) {
        handleQuoteFailure(error)
      }
      return
    }

    setShippingLoading(true)
    setShippingQuoteCurrent(false)
    setShippingMessageTone("info")
    setShippingMessage("")

    // Timer puramente informativo: no cancela nada. La request compartida
    // (`getShippingQuoteOptions`) no depende de este efecto para seguir
    // viva -- si esta selección deja de ser la vigente, `isStale()` ignora
    // el resultado cuando llegue, pero la request sigue su curso para quien
    // más la necesite (otro consumidor, o esta misma clave si el usuario
    // vuelve a este destino).
    const slowNoticeTimer = setTimeout(() => {
      if (isStale()) return
      setShippingMessageTone("info")
      setShippingMessage("Esto está tardando más de lo normal…")
    }, 8_000)

    getShippingQuoteOptions(requestPayload)
      .then((rawOptions) => {
        if (isStale()) return
        applyRawOptions(rawOptions)
      })
      .catch((error: unknown) => {
        if (isStale()) return
        const timedOut =
          error instanceof CheckoutCatalogError && error.reason === "timeout"
        handleQuoteFailure(error, timedOut)
      })
      .finally(() => {
        clearTimeout(slowNoticeTimer)
        if (!isStale()) setShippingLoading(false)
      })
  }, [isDestinationQuotable, shippingQuotePayload])

  const handleInputChange = (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const { name, value } =
      e.target
    let normalizedValue =
      value.toLocaleUpperCase(
        "es-AR"
      )

    if (name === "email") {
      normalizedValue = value.trim().toLowerCase()
    }

    if (name === "dni") {
      normalizedValue = value.replace(/\D/g, "").slice(0, 8)
    }

    if (name === "numero") {
      normalizedValue = value.replace(/\D/g, "").slice(0, 8)
    }

    if (name === "cpDestino") {
      normalizedValue = value.replace(/\D/g, "").slice(0, 4)
    }

    if (name === "calle") {
      normalizedValue = normalizedValue.slice(0, FIELD_LIMITS.street)
    }

    if (name === "departamento") {
      normalizedValue = normalizedValue.toLocaleUpperCase("es-AR")
    }

    hasEditedCheckoutFormRef.current = true

    if (invalidField === name) {
      setInvalidField(null)
    }

    setFormData((prev) => {
      const next = {
        ...prev,
        [name]: normalizedValue,
      }

      if (
        [
          "calle",
          "numero",
          "piso",
          "departamento",
          "localidad",
          "provincia",
          "cpDestino",
        ].includes(name)
      ) {
        next.direccion = formatDeliveryAddress({
          street: next.calle,
          streetNumber: next.numero,
          floor: next.piso,
          apartment: next.departamento,
          locality: next.localidad,
          region: next.provincia,
          postalCode: next.cpDestino,
        })
      }

      return next
    })
  }

  const handlePhoneChange = (nationalDigits: string) => {
    hasEditedCheckoutFormRef.current = true

    if (invalidField === "telefono") {
      setInvalidField(null)
    }

    setFormData((prev) => ({ ...prev, telefono: nationalDigits }))
  }

  const handleProvinceChange = (value: string) => {
    const normalizedValue = value.toLocaleUpperCase("es-AR")

    hasEditedCheckoutFormRef.current = true

    if (invalidField === "provincia") {
      setInvalidField(null)
    }

    setLocalityOptions([])
    setLocalityLoadError("")
    setPostalCodeOptions([])
    setPostalCodeLoadError("")
    setManualLocalityMode(false)
    setManualPostalCodeMode(false)

    setFormData((prev) => {
      const next = {
        ...prev,
        provincia: normalizedValue,
        localidad: "",
        cpDestino: "",
      }

      next.direccion = formatDeliveryAddress({
        street: next.calle,
        streetNumber: next.numero,
        floor: next.piso,
        apartment: next.departamento,
        locality: next.localidad,
        region: next.provincia,
        postalCode: next.cpDestino,
      })

      return next
    })
  }

  const isRecipientStepValid =
    isValidCheckoutForm(formData)
  const areCriticalCheckoutStatesReady =
    !isLoading &&
    !customerCredit.loading &&
    !siteSettings.loading
  const isShippingStepValid =
    Boolean(
      selectedShippingOption &&
        shippingQuoteCurrent &&
        !shippingLoading &&
        isDestinationQuotable &&
        (selectedShippingType !== "sucursal" || selectedSucursalId !== null),
    )
  // Sólo domicilio en el paso de envío no necesita la altura reservada para
  // el selector de sucursales (listado + mapa) -- el resto de los pasos, y
  // sucursal, conservan el panel alto habitual.
  const isCompactShippingStep =
    currentStep === 2 && selectedShippingType === "domicilio"
  const isFormValid = Boolean(
    areCriticalCheckoutStatesReady &&
      isRecipientStepValid &&
      isShippingStepValid
  )
  const isCurrentStepValid =
    areCriticalCheckoutStatesReady &&
    (currentStep === 1
      ? isRecipientStepValid
      : isShippingStepValid)
  const cartReservationItems = reservationItemsFromCart(items)
  const hasMatchingStockReservation = Boolean(
    stockReservation &&
    reservationSeconds > 0 &&
    reservationMatchesCart(stockReservation.items, cartReservationItems),
  )

  const showReservationFailure = (
    result: Extract<StockReservationResult, { success: false }>,
    requestedItems: StockReservationItem[],
  ) => {
    if (result.code === "RESERVATION_EXPIRED") {
      expireStockReservation()
      return
    }
    if (result.code === "OUT_OF_STOCK") {
      const affected = (result.conflicts ?? []).flatMap((conflict) => {
        const cartItem = items.find((item) =>
          item.product.id === conflict.productId &&
          item.variantId === (conflict.variantId ?? null) &&
          item.conditionedStockId === (conflict.conditionedStockId ?? null),
        )
        const requested = requestedItems.find((item) =>
          item.productId === conflict.productId &&
          (item.variantId ?? null) === (conflict.variantId ?? null) &&
          (item.conditionedStockId ?? null) === (conflict.conditionedStockId ?? null),
        )
        return cartItem && requested ? [{
          productId: conflict.productId,
          variantId: conflict.variantId ?? null,
          conditionedStockId: conflict.conditionedStockId ?? null,
          displayName: cartItem.product.nombre,
          variantName: cartItem.variantName,
          requestedQuantity: requested.quantity,
        }] : []
      })
      if (affected.length) {
        setReservationStockError(true)
        setInsufficientStockItems(affected)
      }
      setCheckoutError("Uno de los productos de tu compra acaba de quedarse sin stock. Revisá las cantidades antes de continuar.")
      return
    }
    setCheckoutError(result.code === "INVALID_QUANTITY"
      ? "Podés comprar hasta 3 unidades por producto o variante. Revisá tu carrito."
      : "No pudimos reservar los productos. Revisá tu carrito e intentá nuevamente.")
  }

  const reserveCheckoutItems = async (
    requestedItems: StockReservationItem[],
    onSuccess: () => void,
  ) => {
    if (reservationActionInFlightRef.current || reservationExpired || !cartSessionId) return
    reservationActionInFlightRef.current = true
    reservationRevisionRef.current += 1
    setReservationPending(true)
    setCheckoutError("")
    try {
      const result = await reserveCartStock({ sessionId: cartSessionId, items: requestedItems })
      if (!result.success) {
        showReservationFailure(result, requestedItems)
        return
      }
      const receivedAt = performance.now()
      if (reservationSecondsLeft(result.expiresAt, result.serverNow, receivedAt, receivedAt) === 0) {
        expireStockReservation()
        return
      }
      setStockReservation({
        expiresAt: result.expiresAt,
        serverNow: result.serverNow,
        receivedAt,
        items: requestedItems,
      })
      setReservationSeconds(reservationSecondsLeft(
        result.expiresAt, result.serverNow, receivedAt, receivedAt,
      ))
      sessionStorage.setItem(CHECKOUT_STEP_RESERVATION_KEY, cartSessionId)
      onSuccess()
    } catch {
      setCheckoutError("No pudimos comprobar el stock. Intentá nuevamente.")
    } finally {
      reservationActionInFlightRef.current = false
      setReservationPending(false)
    }
  }

  const changeCheckoutCartItem = (
    index: number,
    quantity: number | null,
    applyChange: () => void,
  ) => {
    if (!stockReservation) {
      applyChange()
      return
    }
    const requestedItems = cartReservationItems.flatMap((item, itemIndex) =>
      itemIndex !== index ? [item] : quantity === null ? [] : [{ ...item, quantity }],
    )
    void reserveCheckoutItems(requestedItems, applyChange)
  }
  const getCheckoutInputClassName = (
    field: RequiredCheckoutField
  ) =>
    cn(
      checkoutInputClassName,
      invalidField === field &&
        "border-red-400/70 shadow-[0_0_0_2px_rgba(248,113,113,0.1)]"
    )

  const goToNextStep = () => {
    if (!areCriticalCheckoutStatesReady) return

    if (
      currentStep === 1 &&
      !isRecipientStepValid
    ) {
      const firstInvalidField =
        getFirstInvalidCheckoutField(formData)

      if (firstInvalidField) {
        setInvalidField(firstInvalidField)

        if (validationTimerRef.current) {
          clearTimeout(validationTimerRef.current)
        }

        requestAnimationFrame(() => {
          const field = document.getElementById(firstInvalidField)
          field?.scrollIntoView({
            behavior: "smooth",
            block: "center",
          })
          field?.focus({
            preventScroll: true,
          })
        })

        validationTimerRef.current = setTimeout(() => {
          setInvalidField(null)
        }, 1400)
      }

      return
    }

    if (
      currentStep === 2 &&
      !isShippingStepValid
    ) {
      setShippingSelectionMissing(true)

      if (validationTimerRef.current) {
        clearTimeout(validationTimerRef.current)
      }

      validationTimerRef.current = setTimeout(() => {
        setShippingSelectionMissing(false)
      }, 1400)
      return
    }

    setInvalidField(null)
    setShippingSelectionMissing(false)
    if (currentStep === 2) {
      void reserveCheckoutItems(cartReservationItems, () => setCurrentStep(3))
      return
    }
    setCurrentStep(2)
  }

  const canSubmitCheckout =
    isFormValid &&
    !isProcessing &&
    !reservationPending &&
    hasMatchingStockReservation &&
    !reservationExpired &&
    !hasKnownStockConflict &&
    isSelectedPaymentValid &&
    termsAccepted

  // "Pagar": valida y, si es Mercado Pago, primero abre la confirmación. La
  // preferencia se crea recién en submitCheckout (al confirmar): cancelar el
  // modal no crea ni reutiliza ningún intento de pago.
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()

    if (currentStep !== 3) return
    if (submissionInFlightRef.current) return
    if (!hasMatchingStockReservation || reservationPending || reservationExpired) return
    if (!isFormValid || !selectedShippingOption || !isSelectedPaymentValid) return
    if (!termsAccepted) return

    if (hasBlockedWords(formData.direccion)) {
      setCheckoutError("La dirección contiene texto no permitido.")
      return
    }

    if (!customerCreditCoversTotal && selectedPayment === "mercadopago") {
      setMercadoPagoConfirmOpen(true)
      return
    }

    void submitCheckout()
  }

  const submitCheckout = async () => {
    if (currentStep !== 3) return
    if (submissionInFlightRef.current) return
    if (!hasMatchingStockReservation || reservationPending || reservationExpired) return
    if (!isFormValid || !selectedShippingOption || !isSelectedPaymentValid || !termsAccepted) return

    submissionInFlightRef.current = true
    setIsProcessing(true)
    setCheckoutError("")

    try {
      const liveReservation = await getCartStockReservation(cartSessionId)
      if (liveReservation.status === "expired") {
        expireStockReservation()
        return
      }
      if (liveReservation.status !== "active" ||
          !reservationMatchesCart(liveReservation.items, cartReservationItems)) {
        setCheckoutError("Tu reserva cambió o ya no está disponible. Revisá tu compra antes de continuar.")
        return
      }
      const customerData = {
        ...formData,
        direccion: [
          formData.direccion,
          formData.referencias.trim()
            ? `Referencias: ${formData.referencias.trim()}`
            : "",
        ]
          .filter(Boolean)
          .join(". "),
      }
      const endpoint =
        customerCreditCoversTotal
          ? "/api/customer-credit/create-order"
          : selectedPayment === "transferencia"
          ? "/api/transferencia/create-order"
          : "/api/mercadopago/create-preference"

      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          reservationSessionId: cartSessionId,
          customer: customerData,
          shipping: {
            provider: selectedShippingOption.provider,
            type: selectedShippingOption.type,
            quoteToken: selectedShippingOption.type === "sucursal"
              ? selectedShippingOption.branches?.find((branch) => branch.id === selectedSucursalId)?.quoteToken
              : selectedShippingOption.quoteToken,
            sucursalId:
              selectedShippingOption.type === "sucursal"
                ? selectedSucursalId
                : undefined,
          },
          storeBenefitId: selectedStoreBenefit?.id ?? null,
          paymentMethodId: selectedPayment || "customer_credit",
          customerCreditAmount: customerCreditApplication.appliedAmount,
          mercadoPagoMode: effectiveMercadoPagoMode,
          termsAccepted: true,
          expectedTotal: customerCreditCoversTotal ? undefined : expectedCheckoutTotal,
          items: items.map((item) => ({
            productId: item.product.id,
            quantity: item.quantity,
            variantId: item.variantId,
            conditionedStockId: item.conditionedStockId,
            color: item.color,
          })),
        }),
      })

      const data = await response.json()

      if (
        !response.ok &&
        data?.code === "INSUFFICIENT_STOCK" &&
        Array.isArray(data.items)
      ) {
        setReservationStockError(false)
        setInsufficientStockItems(data.items)
        return
      }

      // El servidor recalculó con datos actuales y el total no coincide con
      // el que estaba en pantalla: no se redirige a pagar. Se refrescan
      // catálogo/configuración y se muestra el nuevo total antes de reintentar.
      if (response.status === 409 && data?.code === "PRICING_CHANGED") {
        const serverTotal = Number(data.total)
        if (Number.isFinite(serverTotal)) {
          setServerConfirmedTotal({ displayedTotal: finalTotal, serverTotal })
        }
        setCommercialUpdateNotice(
          Number.isFinite(serverTotal)
            ? `${COMMERCIAL_UPDATE_NOTICE} Nuevo total: ${formatPrice(serverTotal)}. Revisalo y volvé a presionar Pagar.`
            : data.error || COMMERCIAL_UPDATE_NOTICE,
        )
        void refreshCommercialData(true)
        return
      }

      if (customerCreditCoversTotal) {
        if (!response.ok || !data.order_id || !data.redirect_url) {
          setCheckoutError(
            data.error ||
              STOCK_CHANGED_MESSAGE,
          )
          return
        }

        clearCart()
        customerCredit.clearAppliedAmount()
        await customerCredit.reload()
        storeGuestOrderToken(data.order_id, data.guest_token)
        window.location.href = data.redirect_url
        return
      }

      if (selectedPayment === "transferencia") {
        if (!response.ok || !data.order_id || !data.redirect_url) {
          setCheckoutError(
            data.error ||
              STOCK_CHANGED_MESSAGE,
          )
          return
        }

        clearCart()
        customerCredit.clearAppliedAmount()
        await customerCredit.reload()
        storeGuestOrderToken(data.order_id, data.guest_token)
        window.location.href = data.redirect_url
        return
      }

      if (!response.ok || !data.init_point) {
        setCheckoutError(
          data.error ||
            STOCK_CHANGED_MESSAGE,
        )
        return
      }

      window.location.href = data.init_point
    } catch {
      setCheckoutError(
        STOCK_CHANGED_MESSAGE,
      )
    } finally {
      submissionInFlightRef.current = false
      setIsProcessing(false)
      setMercadoPagoConfirmOpen(false)
    }
  }

  const handleLocalityChange = (value: string) => {
    const normalizedValue = normalizeArgentineLocality(value)
    hasEditedCheckoutFormRef.current = true

    if (invalidField === "localidad") setInvalidField(null)
    setPostalCodeOptions([])
    setPostalCodeLoadError("")
    setManualPostalCodeMode(false)

    setFormData((prev) => {
      const next = {
        ...prev,
        localidad: normalizedValue,
        cpDestino: "",
      }
      next.direccion = formatDeliveryAddress({
        street: next.calle,
        streetNumber: next.numero,
        floor: next.piso,
        apartment: next.departamento,
        locality: next.localidad,
        region: next.provincia,
        postalCode: next.cpDestino,
      })
      return next
    })
  }

  const handlePostalCodeChange = (value: string) => {
    hasEditedCheckoutFormRef.current = true
    if (invalidField === "cpDestino") setInvalidField(null)

    setFormData((prev) => {
      const next = { ...prev, cpDestino: value }
      next.direccion = formatDeliveryAddress({
        street: next.calle,
        streetNumber: next.numero,
        floor: next.piso,
        apartment: next.departamento,
        locality: next.localidad,
        region: next.provincia,
        postalCode: next.cpDestino,
      })
      return next
    })
  }

  const handleManualPostalCodeInputChange = (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    handlePostalCodeChange(e.target.value.replace(/\D/g, "").slice(0, 4))
  }

  const handleEnableManualLocality = () => {
    hasEditedCheckoutFormRef.current = true
    setManualLocalityMode(true)
    setLocalityLoadError("")
    setLocalitiesLoading(false)
    setLocalityOptions([])
    setPostalCodesLoading(false)
    setPostalCodeOptions([])
    setPostalCodeLoadError("")
  }

  const handleDisableManualLocality = () => {
    setManualLocalityMode(false)
    setManualPostalCodeMode(false)

    setFormData((prev) => {
      const next = { ...prev, localidad: "", cpDestino: "" }
      next.direccion = formatDeliveryAddress({
        street: next.calle,
        streetNumber: next.numero,
        floor: next.piso,
        apartment: next.departamento,
        locality: next.localidad,
        region: next.provincia,
        postalCode: next.cpDestino,
      })
      return next
    })
  }

  const handleEnableManualPostalCode = () => {
    hasEditedCheckoutFormRef.current = true
    setManualPostalCodeMode(true)
  }

  const cpEntryIsManual = manualLocalityMode || manualPostalCodeMode
  // "Sin códigos postales disponibles" es solo para el resultado real y
  // válido de cero CP -- si la request falló (timeout, red, servicio no
  // disponible), `postalCodeLoadError` lo intercepta antes.
  const showManualPostalCodeOption =
    !cpEntryIsManual &&
    Boolean(formData.localidad) &&
    !postalCodesLoading &&
    !postalCodeLoadError &&
    postalCodeOptions.length === 0

  if (!mounted || !isCartReady) {
    return null
  }

  if (reservationExpired) {
    return (
      <main className="checkout-page flex min-h-screen flex-col items-center justify-center bg-[#05070A] px-4 font-heading text-white">
        <div role="alert" data-stock-reservation-expired className="max-w-md rounded-xl border border-beyonix-blue-light/25 bg-[#0B1118] p-6 text-center">
          <Clock3 className="mx-auto mb-3 size-8 text-beyonix-sky" />
          <h1 className="text-xl font-bold">Tu reserva venció.</h1>
          <p className="mt-2 text-sm leading-6 text-white/70">
            Pasaron los 20 minutos disponibles para completar la compra y liberamos los productos reservados.
          </p>
          <p className="mt-3 text-xs text-white/50">Te estamos llevando al inicio.</p>
        </div>
      </main>
    )
  }

  if (items.length === 0) {
    return (
      <>
        <main className="checkout-page min-h-screen bg-[#05070A] px-4 py-6 font-heading text-white sm:py-8">
          <PublicMinimalHeader className="mx-auto mb-10 max-w-md sm:mb-14" />
          <div className="mx-auto max-w-md rounded-xl border border-beyonix-blue-light/18 bg-[#0B1118] p-6 text-center shadow-2xl shadow-black/45">
            <h1 className="mb-3 text-2xl font-bold text-white">
              Tu carrito está vacío
            </h1>
            <p className="mb-5 text-sm leading-6 text-white/58">
              Agregá productos para continuar con la compra.
            </p>

            <Button
              type="button"
              aria-label="Volver a la tienda"
              title="Volver a la tienda"
              onClick={() =>
                router.push("/")
              }
              className={cn("h-10 px-5 text-sm", checkoutPrimaryButtonClassName)}
            >
              Volver a la tienda
            </Button>
          </div>
        </main>
        <Footer />
      </>
    )
  }

  return (
    <>
      <main className="checkout-page min-h-screen bg-[#05070A] font-heading text-white">
      <header className="checkout-header sticky top-0 z-50 border-b border-beyonix-blue-light/14 bg-[#05070A]/95 backdrop-blur">
        <div className="container mx-auto px-4 lg:px-8">
          <div className="flex items-center justify-between h-16 lg:h-20">
            <button
              type="button"
              aria-label="Volver a la tienda"
              onClick={() =>
                router.push("/")
              }
              className={cn("h-9 px-3 text-sm", checkoutSecondaryButtonClassName)}
            >
              <ArrowLeft className="size-4" />

              <span className="text-sm font-medium">
                Volver
              </span>
            </button>

            <Link
              href="/"
              aria-label="Ir al inicio de BEYONIX"
              title="Ir al inicio de BEYONIX"
              className="cursor-pointer font-heading text-26px font-bold tracking-tight text-foreground transition-colors duration-150 hover:text-[#2F6FA3] lg:text-28px"
            >
              BEYONIX
            </Link>

            <div className="relative flex min-w-20 items-center justify-end gap-2">
              <AccountThemeToggle className="size-9" />
              {isInternal && (
                <AdminNotificationsBell
                  variant="storefront"
                  count={adminNotifications.notificationCount}
                  tone={adminNotifications.notificationTone}
                  groups={adminNotifications.notificationGroups}
                  notifications={adminNotifications.notifications}
                  loading={adminNotifications.loading}
                  error={adminNotifications.error}
                  onRetry={adminNotifications.reloadNotificationCount}
                />
              )}
              {isLoading ? (
                <div
                  aria-hidden="true"
                  className="hidden h-11 w-36 items-center gap-2 rounded-full border border-white/8 bg-white/5 px-3 sm:flex"
                >
                  <span className="size-7 shrink-0 animate-pulse rounded-full bg-white/10" />
                  <span className="h-2.5 w-16 animate-pulse rounded-full bg-white/10" />
                </div>
              ) : user ? (
                <AccountMenu />
              ) : (
                <div className="hidden items-center gap-2 sm:flex">
                  <BeyonixHeaderLoginLink href="/login?redirect=/checkout" />
                  <BeyonixHeaderRegisterLink href="/login?mode=register&redirect=/checkout" />
                </div>
              )}
            </div>
          </div>
        </div>
      </header>

      <div className="beyonix-checkout-container py-5 lg:py-7">
        <div className="mx-auto max-w-none">
          <div className="checkout-heading-row mb-4 flex items-end justify-between gap-4">
            <div>
              <p className="text-10px font-semibold uppercase tracking-[0.2em] text-beyonix-cyan/75">
                Compra segura
              </p>
              <h1 className="mt-1 text-2xl font-bold text-foreground lg:text-3xl">
                Checkout
              </h1>
            </div>

            <span className="hidden text-sm text-white/45 sm:block">
              Paso {currentStep} de 3
            </span>
          </div>

          <div className="checkout-progress mb-3 grid grid-cols-3 gap-2 lg:gap-3" aria-label="Progreso del checkout">
            {checkoutSteps.map((step) => {
              const active =
                currentStep === step.id
              const complete =
                currentStep > step.id

              return (
                <div
                  key={step.id}
                  className={cn(
                    "flex min-h-12 min-w-0 items-center gap-2 rounded-lg border px-3 py-2 text-left transition-all",
                    complete
                      ? "checkout-step-complete border-beyonix-blue-light/38 bg-beyonix-blue/55 text-white/88"
                      : active
                        ? "checkout-step-active border-beyonix-blue-light/70 bg-beyonix-blue text-white shadow-[0_0_18px_rgba(47,111,163,0.16)]"
                        : "checkout-step-pending border-beyonix-blue-light/12 bg-[#10151C] text-white/44"
                  )}
                >
                  <span
                    className={cn(
                      "checkout-step-icon flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-bold",
                      complete
                        ? "border-beyonix-blue-light/36 bg-beyonix-blue/40 text-beyonix-sky"
                        : active
                          ? "border-beyonix-sky/35 bg-[#0B1118] text-beyonix-sky"
                          : "border-white/10 bg-black/35 text-white/45"
                    )}
                  >
                    {complete ? (
                      <Check className="size-3.5" />
                    ) : (
                      step.id
                    )}
                  </span>
                  <span className="truncate text-xs font-semibold sm:text-sm">
                    {step.label}
                  </span>
                </div>
              )
            })}
          </div>

          <form
            id="checkout-form"
            onSubmit={handleSubmit}
            className={cn(
              "checkout-layout grid gap-5 lg:grid-cols-[minmax(0,1.65fr)_minmax(22rem,0.85fr)] lg:gap-4 2xl:gap-5",
              isCompactShippingStep ? "items-start" : "items-stretch",
            )}
          >
            <section
              className={cn(
                checkoutFormPanelClassName,
                "checkout-main-panel flex flex-col px-4 pb-3 pt-4 sm:px-5 sm:pb-4 sm:pt-5",
                !isCompactShippingStep && "min-h-[clamp(440px,52vh,560px)]",
              )}
            >
              {stockReservation && !reservationExpired && (
                <div
                  data-stock-reservation-countdown
                  role="status"
                  className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-beyonix-blue-light/30 bg-beyonix-blue/15 px-4 py-3 text-sm text-white/80"
                >
                  <span>Productos reservados para completar tu compra</span>
                  <span className="font-bold tabular-nums text-beyonix-sky">
                    {formatReservationCountdown(reservationSeconds)}
                  </span>
                </div>
              )}
              {stockReservation && !hasMatchingStockReservation && !reservationPending && (
                <CheckoutNotice tone="warning" className="mb-4">
                  Tu carrito cambió. Volvé a continuar desde el paso de envío para actualizar la reserva.
                </CheckoutNotice>
              )}
              {currentStep === 1 && (
                <div className="checkout-receiver-step animate-in fade-in slide-in-from-right-2 space-y-3 duration-300 [&_label]:text-[13px]">
                  <h2 className={checkoutSectionHeadingClassName}>
                    Datos de quien recibe
                  </h2>

                  <div className="space-y-3">
                    <div className="space-y-2">
                      <div className="flex items-center gap-3">
                        <p className={checkoutSectionKickerClassName}>
                          Datos personales
                        </p>
                        <span className={checkoutDividerClassName} />
                      </div>

                      <div className="grid gap-x-3 gap-y-2.5 sm:grid-cols-2">
                        <div className="space-y-0.5">
                          <Label htmlFor="nombre" className="text-white/75">
                            <UserRound aria-hidden="true" className="size-3.5 text-[#4f8cc9]/65" />
                            Nombre completo *
                          </Label>
                          <Input id="nombre" name="nombre" className={getCheckoutInputClassName("nombre")} value={formData.nombre} onChange={handleInputChange} required />
                        </div>
                        <div className="space-y-0.5">
                          <Label htmlFor="email" className="text-white/75">
                            <Mail aria-hidden="true" className="size-3.5 text-[#4f8cc9]/65" />
                            Email *
                          </Label>
                          <Input id="email" name="email" type="email" className={getCheckoutInputClassName("email")} value={formData.email} onChange={handleInputChange} maxLength={FIELD_LIMITS.email} required />
                        </div>
                        <div className="space-y-0.5">
                          <Label htmlFor="telefono" className="text-white/75">
                            <Smartphone aria-hidden="true" className="size-3.5 text-[#4f8cc9]/65" />
                            Teléfono *
                          </Label>
                          <ArgentinaPhoneInput
                            id="telefono"
                            name="telefono"
                            label={null}
                            value={formData.telefono}
                            onChange={handlePhoneChange}
                            heightClassName="h-10"
                            outerClassName={cn(
                              "beyonix-checkout-input border rounded-lg border-beyonix-blue-light/18 hover:border-beyonix-blue-light/35 focus-within:border-beyonix-blue-light/65 focus-within:ring-beyonix-blue-light/18",
                              invalidField === "telefono" &&
                                "border-red-400/70 shadow-[0_0_0_2px_rgba(248,113,113,0.1)]",
                            )}
                            prefixClassName="border-r border-beyonix-blue-light/18 text-white/45"
                            inputClassName="font-heading text-sm font-semibold text-white placeholder:text-white/36"
                            helperClassName="text-11px text-white/40"
                          />
                        </div>
                        <div className="space-y-0.5">
                          <Label htmlFor="dni" className="text-white/75">
                            <IdCard aria-hidden="true" className="size-3.5 text-[#4f8cc9]/65" />
                            DNI *
                          </Label>
                          <Input id="dni" name="dni" type="tel" inputMode="numeric" className={getCheckoutInputClassName("dni")} value={formData.dni} onChange={handleInputChange} maxLength={FIELD_LIMITS.dni} required />
                        </div>
                      </div>
                    </div>

                    <div className="space-y-2">
                      <div className="flex items-center gap-3">
                        <p className={checkoutSectionKickerClassName}>
                          Dirección de entrega
                        </p>
                        <span className={checkoutDividerClassName} />
                      </div>

                      <div className="grid gap-x-3 gap-y-2.5 sm:grid-cols-2">
                        <div className="space-y-0.5">
                          <Label htmlFor="calle" className="text-white/75">
                            <Home aria-hidden="true" className="size-3.5 text-[#4f8cc9]/65" />
                            Calle *
                          </Label>
                          <Input id="calle" name="calle" className={getCheckoutInputClassName("calle")} value={formData.calle} onChange={handleInputChange} maxLength={FIELD_LIMITS.street} required />
                        </div>
                        <div className="space-y-0.5">
                          <Label htmlFor="numero" className="text-white/75">
                            <Home aria-hidden="true" className="size-3.5 text-[#4f8cc9]/65" />
                            Número *
                          </Label>
                          <Input id="numero" name="numero" inputMode="numeric" className={getCheckoutInputClassName("numero")} value={formData.numero} onChange={handleInputChange} maxLength={8} required />
                        </div>
                        <div className="grid grid-cols-2 gap-3 sm:col-span-2">
                          <div className="space-y-0.5">
                            <Label htmlFor="piso" className="text-white/75">Piso opcional</Label>
                            <Input id="piso" name="piso" className={checkoutInputClassName} value={formData.piso} onChange={handleInputChange} />
                          </div>
                          <div className="space-y-0.5">
                            <Label htmlFor="departamento" className="text-white/75">Departamento opcional</Label>
                            <Input id="departamento" name="departamento" className={checkoutInputClassName} value={formData.departamento} onChange={handleInputChange} />
                          </div>
                        </div>
                        <div className="space-y-0.5 sm:col-span-2">
                          <Label htmlFor="provincia" className="text-white/75">
                            <MapPin aria-hidden="true" className="size-3.5 text-[#4f8cc9]/65" />
                            Provincia *
                          </Label>
                          <GeographicSelect
                            id="provincia"
                            value={formData.provincia}
                            options={provinceSelectOptions}
                            onChange={handleProvinceChange}
                            placeholder="Seleccioná una provincia"
                            ariaLabel="Seleccionar provincia"
                            invalid={invalidField === "provincia"}
                          />
                          {invalidField === "provincia" && (
                            <p className="text-xs font-semibold text-red-300">
                              Seleccioná una provincia.
                            </p>
                          )}
                        </div>
                        <div className="space-y-0.5">
                          <Label htmlFor="localidad" className="text-white/75">
                            <MapPin aria-hidden="true" className="size-3.5 text-[#4f8cc9]/65" />
                            Localidad *
                          </Label>
                          {manualLocalityMode ? (
                            <>
                              <Input
                                id="localidad"
                                name="localidad"
                                className={getCheckoutInputClassName("localidad")}
                                value={formData.localidad}
                                onChange={handleInputChange}
                                placeholder="Ingresá tu localidad"
                                maxLength={80}
                                required
                              />
                              <button
                                type="button"
                                onClick={handleDisableManualLocality}
                                className={checkoutManualToggleClassName}
                              >
                                Volver a selección automática
                              </button>
                            </>
                          ) : (
                            <>
                              <GeographicSelect
                                id="localidad"
                                value={formData.localidad}
                                options={localitySelectOptions}
                                onChange={handleLocalityChange}
                                placeholder="Seleccioná una localidad"
                                loading={localitiesLoading}
                                loadingLabel="Cargando localidades…"
                                disabled={!formData.provincia || localitiesLoading}
                                searchable
                                emptyLabel="No hay localidades disponibles para esta provincia."
                                errorMessage={localityLoadError}
                                ariaLabel="Seleccionar localidad"
                                invalid={invalidField === "localidad"}
                              />
                              {localityLoadError && (
                                <p className="text-xs font-semibold text-red-300">
                                  {localityLoadError}
                                </p>
                              )}
                              {formData.provincia && (
                                <button
                                  type="button"
                                  onClick={handleEnableManualLocality}
                                  className={checkoutManualToggleClassName}
                                >
                                  ¿No encontrás tu localidad? Ingresar manualmente
                                </button>
                              )}
                            </>
                          )}
                        </div>
                        <div className="space-y-0.5">
                          <Label htmlFor="cpDestino" className="text-white/75">
                            <MapPin aria-hidden="true" className="size-3.5 text-[#4f8cc9]/65" />
                            Código postal *
                          </Label>
                          {cpEntryIsManual ? (
                            <Input
                              id="cpDestino"
                              name="cpDestino"
                              inputMode="numeric"
                              className={getCheckoutInputClassName("cpDestino")}
                              value={formData.cpDestino}
                              onChange={handleManualPostalCodeInputChange}
                              placeholder="Ej: 9410"
                              maxLength={4}
                              required
                            />
                          ) : (
                            <>
                              <GeographicSelect
                                id="cpDestino"
                                value={formData.cpDestino}
                                options={postalCodeSelectOptions}
                                onChange={handlePostalCodeChange}
                                placeholder={
                                  postalCodeLoadError
                                    ? "No disponible"
                                    : showManualPostalCodeOption
                                      ? "Sin códigos postales disponibles"
                                      : "Seleccioná un código postal"
                                }
                                loading={postalCodesLoading}
                                loadingLabel="Cargando códigos postales…"
                                disabled={
                                  !formData.localidad ||
                                  postalCodesLoading ||
                                  postalCodeOptions.length === 0
                                }
                                locked={postalCodeOptions.length === 1}
                                compact
                                errorMessage={postalCodeLoadError}
                                ariaLabel="Seleccionar código postal"
                                invalid={invalidField === "cpDestino"}
                              />
                              {postalCodeLoadError && (
                                <div className="space-y-0.5">
                                  <p className="text-xs font-semibold text-red-300">
                                    {postalCodeLoadError}
                                  </p>
                                  <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
                                    <button
                                      type="button"
                                      onClick={() =>
                                        setPostalCodeRetryNonce((current) => current + 1)
                                      }
                                      className={checkoutManualToggleClassName}
                                    >
                                      Reintentar
                                    </button>
                                    <button
                                      type="button"
                                      onClick={handleEnableManualPostalCode}
                                      className={checkoutManualToggleClassName}
                                    >
                                      Ingresar código postal manualmente
                                    </button>
                                  </div>
                                </div>
                              )}
                              {showManualPostalCodeOption && (
                                <div className="space-y-0.5">
                                  <p className="text-xs text-white/50">
                                    No encontramos códigos postales para esta localidad.
                                  </p>
                                  <button
                                    type="button"
                                    onClick={handleEnableManualPostalCode}
                                    className={checkoutManualToggleClassName}
                                  >
                                    Ingresar código postal manualmente
                                  </button>
                                </div>
                              )}
                            </>
                          )}
                        </div>
                        <div className="space-y-0.5 sm:col-span-2">
                          <Label htmlFor="referencias" className="text-white/75">Referencias opcionales</Label>
                          <Input id="referencias" name="referencias" className={checkoutInputClassName} value={formData.referencias} onChange={handleInputChange} />
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {currentStep === 2 && (
                <div className="animate-in fade-in slide-in-from-right-2 space-y-4 duration-300">
                  <h2 className={checkoutSectionHeadingClassName}>
                    Método de envío
                  </h2>

                  <div
                    className={cn(
                      "grid gap-3 rounded-2xl transition-shadow",
                      shippingSelectionMissing &&
                        "shadow-[0_0_0_2px_rgba(248,113,113,0.12)]"
                    )}
                  >
                    {shippingLoading && shippingOptions.length === 0 && (
                      <p
                        role="status"
                        className="flex items-center gap-2 text-xs font-semibold text-white/55"
                      >
                        <Loader2 className="size-3.5 animate-spin text-beyonix-sky" />
                        Consultando tarifa Andreani…
                      </p>
                    )}
                    {shippingLoading && shippingOptions.length > 0 && (
                      <p
                        role="status"
                        className="flex items-center gap-2 text-xs font-semibold text-white/55"
                      >
                        <Loader2 className="size-3.5 animate-spin text-beyonix-sky" />
                        Actualizando tarifa…
                      </p>
                    )}
                    {shippingOptions.map((option) => {
                      const selected =
                        selectedShippingType === option.type
                      const optionHasQuote = option.quoteStatus === "quoted"
                      const optionShippingCoveredByBeyonix =
                        optionHasQuote && customerCreditIncludesShippingBenefit
                      const optionShippingCostCharged =
                        !optionHasQuote
                          ? 0
                          : optionShippingCoveredByBeyonix
                          ? 0
                          : calculateCustomerShippingCost(
                              baseTotals.productsTotal,
                              option.price,
                              siteSettings.shipping,
                            )

                      return (
                        <button
                          key={option.type}
                          type="button"
                          onClick={() => {
                            setSelectedShippingType(option.type)
                            setShippingSelectionMissing(false)
                            // Volver a domicilio no debe arrastrar una
                            // selección de sucursal anterior si el cliente
                            // vuelve a elegir sucursal más tarde.
                            if (option.type !== "sucursal") {
                              setSelectedSucursalId(null)
                            }
                          }}
                          className={cn(
                            checkoutOptionClassName,
                            "items-center gap-4 px-4 py-3",
                            selected
                              ? checkoutOptionSelectedClassName
                              : "border-beyonix-blue-light/16 bg-[#10151C]"
                          )}
                        >
                          <span className={cn(
                            "flex size-10 shrink-0 items-center justify-center rounded-xl border",
                            selected
                              ? "border-beyonix-sky/35 bg-beyonix-blue/55 text-beyonix-sky"
                              : "border-white/8 bg-black/30 text-white/55"
                          )}>
                            <Truck className="size-4" />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block text-sm font-semibold text-white">
                              {option.label}
                            </span>
                          </span>
                          <span className="flex shrink-0 items-center gap-2 text-right">
                            {selected && (
                              <span className="flex size-5 items-center justify-center rounded-full border border-beyonix-blue-light/35 bg-beyonix-blue/50 text-beyonix-sky">
                                <Check className="size-3" />
                              </span>
                            )}
                            <span className={optionShippingCostCharged === 0 ? "text-sm font-semibold text-emerald-400" : "text-sm font-semibold text-white"}>
                              {!optionHasQuote
                                ? "A confirmar"
                                : optionShippingCoveredByBeyonix
                                ? "GRATIS"
                                : optionShippingCostCharged === 0
                                  ? "Sin cargo"
                                  : formatPrice(optionShippingCostCharged)}
                            </span>
                          </span>
                        </button>
                      )
                    })}
                  </div>

                  {selectedShippingType === "sucursal" && hasAndreaniQuote && (
                    <div className="space-y-2">
                      <div>
                        <p className="text-sm font-semibold text-white">
                          Elegí la sucursal Andreani donde vas a retirar tu pedido
                        </p>
                        {Boolean(selectedShippingOption?.branches?.length) && (
                          <p className="text-xs text-white/50">
                            Te mostramos primero las más cercanas a tu domicilio.
                          </p>
                        )}
                      </div>
                      {!selectedShippingOption?.branches?.length ? (
                        <div className="space-y-2 rounded-2xl border border-beyonix-blue-light/16 p-4">
                          <p className="text-xs text-white/55">
                            No encontramos sucursales Andreani disponibles en tu localidad.
                          </p>
                          <button
                            type="button"
                            onClick={() => {
                              setSelectedShippingType("domicilio")
                              setSelectedSucursalId(null)
                            }}
                            className="text-xs font-semibold text-beyonix-sky hover:underline"
                          >
                            Volver a envío a domicilio
                          </button>
                        </div>
                      ) : (
                        <BranchMapPicker
                          branches={selectedShippingOption.branches}
                          selectedId={selectedSucursalId}
                          hasSelectionError={shippingSelectionMissing}
                          onSelect={(branchId) => {
                            setSelectedSucursalId(branchId)
                            setShippingSelectionMissing(false)
                          }}
                        />
                      )}
                      {selectedSucursalId !== null && (
                        <p className="text-xs font-semibold text-beyonix-sky">
                          Sucursal seleccionada:{" "}
                          {
                            selectedShippingOption?.branches?.find(
                              (branch) => branch.id === selectedSucursalId,
                            )?.descripcion
                          }
                        </p>
                      )}
                    </div>
                  )}

                  {shippingMessage && (
                    <CheckoutNotice tone={shippingMessageTone}>
                      {shippingMessage}
                    </CheckoutNotice>
                  )}
                </div>
              )}

              {currentStep === 3 && (
                <div className="animate-in fade-in slide-in-from-right-2 space-y-4 duration-300">
                  <h2 className={checkoutSectionHeadingClassName}>
                    Método de pago
                  </h2>

                  {/* Lista simple de 3 opciones (radio nativo): el cliente
                      elige UNA. Sin paneles anidados: el detalle de cuotas y
                      de medios es informativo y vive en un modal chico. */}
                  <fieldset className="grid gap-3" data-payment-options>
                    <legend className="sr-only">Elegí cómo pagar</legend>

                    <CheckoutPaymentOptionCard
                      option="transferencia"
                      checked={selectedPaymentOption === "transferencia"}
                      onSelect={selectPaymentOption}
                      icon={Landmark}
                      title="Depósito / Transferencia"
                      description="En cuenta bancaria o virtual"
                      badge={<span className="checkout-badge checkout-badge-success">¡Mejor precio!</span>}
                      highlight={
                        <>
                          Incluye{" "}
                          <span
                            data-transfer-discount-highlight
                            className="font-semibold text-[var(--checkout-offer-text)]"
                          >
                            {siteSettings.pricing.transferDiscountPercent}% de descuento
                          </span>
                        </>
                      }
                    />

                    <CheckoutPaymentOptionCard
                      option="mercadopago_cash"
                      checked={selectedPaymentOption === "mercadopago_cash"}
                      onSelect={selectPaymentOption}
                      icon={Wallet}
                      title="Mercado Pago al contado"
                      description="Débito, crédito en 1 pago o dinero en cuenta"
                      badge={<span className="checkout-badge checkout-badge-neutral">1 pago</span>}
                      action={
                        <CheckoutPaymentInfoLink onClick={() => setPaymentInfoModal("mercadopago_cash")}>
                          Ver medios
                        </CheckoutPaymentInfoLink>
                      }
                    />

                    {isMercadoPagoFinancingAvailable &&
                      mercadoPagoPricing.maxInstallmentCount != null && (
                        <CheckoutPaymentOptionCard
                          option="mercadopago_financed"
                          checked={selectedPaymentOption === "mercadopago_financed"}
                          onSelect={selectPaymentOption}
                          icon={CreditCard}
                          title="Mercado Pago en cuotas"
                          description="Pagá con tarjeta vía Mercado Pago"
                          badge={
                            <span className="checkout-badge checkout-badge-info">
                              Hasta {mercadoPagoPricing.maxInstallmentCount} cuotas sin interés
                            </span>
                          }
                          action={
                            <CheckoutPaymentInfoLink onClick={() => setPaymentInfoModal("installments")}>
                              Ver cuotas
                            </CheckoutPaymentInfoLink>
                          }
                        />
                      )}
                  </fieldset>

                  {paymentInfoModal === "installments" && financedPreviewQuote && (
                    <PaymentInfoModal
                      title="Cuotas con Mercado Pago"
                      onClose={() => setPaymentInfoModal(null)}
                    >
                      {/* Precio y aclaración en dos líneas propias: el precio
                          nunca queda partido a mitad de una oración. */}
                      <div data-installments-intro>
                        <p className="flex items-baseline justify-between gap-3">
                          <span className="beyonix-modal-body text-[13px] text-white/65">
                            Precio en cuotas
                          </span>
                          <span className="beyonix-modal-title shrink-0 text-[15px] font-bold text-white">
                            {formatPrice(financedPreviewQuote.externalAmountDue)}
                          </span>
                        </p>
                        <p className="beyonix-modal-body mt-1 text-[12px] leading-5 text-white/65">
                          La cantidad de cuotas la elegís dentro de Mercado Pago.
                        </p>
                      </div>
                      <InstallmentPlanList plans={financedPreviewPricing.installmentPlans} />
                      {/* Disclosure legal (CFTEA): discreto y junto al detalle
                          de cuotas. Fórmula sin cambios; 1 decimal es-AR. */}
                      {cfteaSummary && (
                        <p
                          data-cftea-disclosure
                          className="beyonix-modal-muted mt-2.5 text-[11px] leading-4 text-white/45"
                        >
                          CFTEA: {cfteaSummary}
                        </p>
                      )}
                    </PaymentInfoModal>
                  )}

                  {paymentInfoModal === "mercadopago_cash" && (
                    <PaymentInfoModal
                      title="Mercado Pago al contado"
                      onClose={() => setPaymentInfoModal(null)}
                    >
                      <MercadoPagoCashMediaList />
                      <p className="beyonix-modal-muted mt-2.5 text-[12px] leading-5 text-white/55">
                        Es el precio de contado: se paga en un solo pago, sin cuotas.
                      </p>
                    </PaymentInfoModal>
                  )}

                  {isMercadoPagoPayment && (
                    <p className="flex items-center gap-1.5 text-11px font-medium text-white/45">
                      <ShieldCheck className="size-3.5 shrink-0 text-white/45" />
                      Pago protegido por Mercado Pago
                    </p>
                  )}

                  {/* Obligatorio para las 3 opciones: sin aceptar, "Pagar"
                      queda deshabilitado (y el servidor exige el flag). */}
                  <label
                    data-terms-acceptance
                    className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-beyonix-blue-light/16 bg-[#10151C] px-3.5 py-3 text-sm text-white/75"
                  >
                    <input
                      type="checkbox"
                      name="checkout-terms-accepted"
                      checked={termsAccepted}
                      onChange={(event) =>
                        setTermsAcceptedSessionId(event.target.checked ? cartSessionId : null)
                      }
                      className="mt-0.5 size-4 shrink-0 cursor-pointer accent-[var(--checkout-choice-indicator)]"
                    />
                    <span>
                      Al comprar, aceptás los{" "}
                      <Link
                        href="/terminos"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-semibold text-beyonix-sky underline underline-offset-2"
                      >
                        términos y condiciones
                      </Link>
                      .
                    </span>
                  </label>

                  <div className="rounded-lg border border-beyonix-blue-light/12 bg-[#10151C] p-4">
                    <p className="text-xs font-semibold uppercase tracking-wider text-white/45">
                      ¿Necesitás ayuda con tu pago?
                    </p>
                    <div className="mt-3 grid gap-3 sm:grid-cols-2">
                      <a
                        href="https://instagram.com/beyonix.ar"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="checkout-help-link group flex cursor-pointer items-center gap-3 rounded-lg border border-beyonix-blue-light/12 bg-[#0B1118] p-3 transition-colors duration-200 hover:border-beyonix-blue-light/40 hover:bg-white/[0.05]"
                      >
                        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-beyonix-blue-light/20 bg-beyonix-blue/25 text-beyonix-sky">
                          <Instagram className="size-4" />
                        </span>
                        <span>
                          <span className="block text-sm font-semibold text-white">Instagram</span>
                          <span className="block text-xs text-white/50 group-hover:text-white/75">Atención rápida</span>
                        </span>
                      </a>

                      <a
                        href={CHECKOUT_EMAIL_URL}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="checkout-help-link group flex cursor-pointer items-center gap-3 rounded-lg border border-beyonix-blue-light/12 bg-[#0B1118] p-3 transition-colors duration-200 hover:border-beyonix-blue-light/40 hover:bg-white/[0.05]"
                      >
                        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-beyonix-blue-light/20 bg-beyonix-blue/25 text-beyonix-sky">
                          <Mail className="size-4" />
                        </span>
                        <span className="min-w-0">
                          <span className="block text-sm font-semibold text-white">Email</span>
                          <span className="block truncate text-xs text-white/50 group-hover:text-white/75">Consultas administrativas</span>
                        </span>
                      </a>
                    </div>
                  </div>
                </div>
              )}

              <div
                className={cn(
                  "checkout-actions flex items-center gap-3 pt-3",
                  isCompactShippingStep ? "mt-0" : "mt-auto",
                  currentStep === 1 ? "justify-end" : "justify-between",
                )}
              >
                {currentStep > 1 && (
                  <button
                    type="button"
                    disabled={reservationPending}
                    onClick={() =>
                      setCurrentStep(
                        Math.max(
                          currentStep - 1,
                          1
                        ) as CheckoutStep
                      )
                    }
                    className={cn("h-10 min-w-110px px-4 text-sm", checkoutSecondaryButtonClassName)}
                  >
                    Anterior
                  </button>
                )}

                {currentStep < 3 ? (
                  <button
                    type="button"
                    onClick={goToNextStep}
                    disabled={!areCriticalCheckoutStatesReady || reservationPending || reservationExpired}
                    className={cn(
                      "h-10 min-w-140px px-5 text-sm",
                      isCurrentStepValid
                        ? checkoutPrimaryButtonClassName
                        : cn(checkoutSecondaryButtonClassName, checkoutDisabledButtonClassName)
                    )}
                  >
                    {reservationPending ? "Reservando productos..." : "Continuar"}
                  </button>
                ) : (
                  <Button
                    type="submit"
                    className={cn(
                      "h-10 min-w-180px px-5 text-sm",
                      canSubmitCheckout
                        ? checkoutPrimaryButtonClassName
                        : cn(checkoutSecondaryButtonClassName, checkoutDisabledButtonClassName)
                    )}
                    disabled={!canSubmitCheckout}
                  >
                    {isProcessing ? (
                      <>
                        <Loader2 className="size-4 animate-spin" />
                        Procesando...
                      </>
                    ) : (
                      customerCreditCoversTotal ? "Confirmar compra" : "Pagar"
                    )}
                  </Button>
                )}
              </div>
            </section>

            <aside className={cn(checkoutPanelClassName, "checkout-summary h-fit self-start px-4 py-3 lg:sticky lg:top-24")}>
              <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-linear-to-r from-transparent via-beyonix-blue-light/75 to-transparent" />
              <div className="flex items-center justify-between gap-3">
                <h2 className={checkoutSectionHeadingClassName}>
                  Resumen del pedido
                </h2>
                <span className="rounded-full border border-beyonix-blue-light/25 bg-[#10151C] px-2.5 py-1 text-10px font-semibold uppercase tracking-widest text-white/60">
                  {totalCartUnits} {totalCartUnits === 1 ? "UNIDAD" : "UNIDADES"}
                </span>
              </div>

              <div className="my-2.5 rounded-lg border border-beyonix-blue-light/14 bg-[#10151C] px-3 py-2 shadow-inner shadow-black/20">
                <FreeShippingBar
                  subtotal={baseTotals.productsTotal}
                  coveredByBeyonix={customerCreditIncludesShippingBenefit}
                  settings={siteSettings.shipping}
                  shippingCostReal={hasAndreaniQuote ? shippingCostReal : undefined}
                  shippingBonus={hasAndreaniQuote ? shippingBonus : undefined}
                />
              </div>

              <div className="custom-scrollbar max-h-[clamp(300px,38vh,390px)] space-y-1.5 overflow-y-auto pr-1">
                {items.map((item, itemIndex) => {
                  const isMaxQuantity =
                    item.quantity >= MAX_CART_ITEM_QUANTITY
                  const stockStatus = getStockStatus(item.product, item.color)
                  const showStockIndicator = stockStatus !== "out"
                  const stockSymbol = getStockIndicatorSymbol(stockStatus)

                  return (
                    <div
                      key={`${item.product.id}-${item.variantId ?? item.color}`}
                      className="checkout-order-item group grid grid-cols-[56px_minmax(0,1fr)] items-center gap-2.5 overflow-hidden rounded-lg border border-beyonix-blue-light/14 bg-[#10151C] px-2 py-1.5 transition-all hover:border-beyonix-blue-light/40 hover:shadow-lg hover:shadow-black/20"
                    >
                    <div className="relative size-14 shrink-0 overflow-hidden rounded-lg border border-white/8 bg-white">
                      <Image
                        src={item.image}
                        alt={`${item.product.nombre} en carrito`}
                        fill
                        sizes="56px"
                        className="object-contain p-1 transition-transform duration-300 group-hover:scale-[1.025]"
                      />
                    </div>

                    <div className="flex min-w-0 flex-col justify-between py-0.5">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p
                            title={item.product.nombre}
                            className="truncate whitespace-nowrap text-sm font-bold text-foreground"
                          >
                            {item.product.nombre}
                          </p>
                          <div className="mt-1 flex min-w-0 flex-col items-start gap-0.5">
                            {(item.variantName || item.colorHex) && (
                              <div className="flex max-w-full items-center gap-1.5">
                                {item.colorHex && (
                                  <span
                                    className="size-2.5 shrink-0 rounded-full border border-white/35 shadow-sm shadow-black"
                                    style={{
                                      backgroundColor: item.colorHex,
                                    }}
                                  />
                                )}
                                <span className="truncate text-xs capitalize text-white/60">
                                  {item.variantName || item.color}
                                </span>
                              </div>
                            )}
                            {showStockIndicator && (
                              <span
                                style={{
                                  display: "inline-flex",
                                  alignItems: "center",
                                  gap: "4px",
                                  marginTop: "2px",
                                  marginBottom: "2px",
                                  fontSize: "12px",
                                  fontWeight: 400,
                                  lineHeight: 1.1,
                                  letterSpacing: "normal",
                                }}
                                className={cn(
                                  "truncate text-[12px] font-normal leading-[1.1] tracking-normal",
                                  getStockIndicatorClassName(stockStatus),
                                )}
                              >
                                {stockSymbol && (
                                  <span aria-hidden="true" className="shrink-0">
                                    {stockSymbol}
                                  </span>
                                )}
                                <span className="truncate">
                                  {getStockStatusLabel(stockStatus)}
                                </span>
                              </span>
                            )}
                          </div>
                        </div>
                        <span className="shrink-0 text-sm font-semibold text-white">
                          {/* Importe de la línea en la modalidad elegida: las
                              líneas suman exactamente la fila "Productos". */}
                          {formatPrice(summaryLineAmounts[itemIndex] ?? item.unitPrice * item.quantity)}
                        </span>
                      </div>

                      <div className="mt-1 flex items-center justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-1.5">
                          <span className="text-11px font-medium text-white/55">Cant.</span>
                          <div className="inline-flex h-7 items-center overflow-hidden rounded-full border border-beyonix-blue-light/35 bg-black/40">
                            <button
                              type="button"
                              aria-label="Disminuir cantidad"
                              onClick={() =>
                                item.quantity > 1 && changeCheckoutCartItem(
                                  itemIndex,
                                  item.quantity - 1,
                                  () => decreaseQuantity(item.product.id, item.color),
                                )
                              }
                              disabled={item.quantity <= 1 || reservationPending || reservationExpired}
                              className="flex h-full w-7 items-center justify-center border-r border-white/10 text-white/65 transition-colors enabled:cursor-pointer enabled:hover:bg-beyonix-blue/45 enabled:hover:text-white disabled:cursor-not-allowed disabled:opacity-35"
                            >
                              <Minus className="size-3" />
                            </button>
                            <span className="flex h-full min-w-8 items-center justify-center px-1.5 text-xs font-bold tabular-nums text-white">
                              {item.quantity}
                            </span>
                            <button
                              type="button"
                              aria-label="Agregar una unidad"
                              onClick={() => changeCheckoutCartItem(
                                itemIndex,
                                item.quantity + 1,
                                () => increaseQuantity(item.product.id, item.color),
                              )}
                              disabled={isMaxQuantity || reservationPending || reservationExpired}
                              className="flex h-full w-7 items-center justify-center border-l border-white/10 text-white/65 transition-colors enabled:cursor-pointer enabled:hover:bg-beyonix-blue/45 enabled:hover:text-white disabled:cursor-not-allowed disabled:opacity-35"
                            >
                              <Plus className="size-3" />
                            </button>
                          </div>
                          {isMaxQuantity && <span className="text-10px text-white/50">Máximo 3</span>}
                        </div>

                        <button
                          type="button"
                          aria-label="Eliminar producto"
                          onClick={() => changeCheckoutCartItem(
                            itemIndex,
                            null,
                            () => removeFromCart(item.product.id, item.color),
                          )}
                          disabled={reservationPending || reservationExpired}
                          className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-red-500/25 bg-red-950/25 text-red-400 transition-colors hover:border-red-400/55 hover:bg-red-500/20 hover:text-red-300"
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      </div>
                    </div>
                    </div>
                  )
                })}
              </div>

              {storeBenefits.length > 0 && (
                <div className="mt-2 rounded-lg border border-beyonix-blue-light/18 bg-[#10151C] px-3 py-2.5">
                  <label
                    htmlFor="store-benefit"
                    className="mb-1 block text-10px font-bold uppercase tracking-widest text-white/62"
                  >
                    Beneficio disponible
                  </label>
                  <div className="relative">
                    <select
                      id="store-benefit"
                      value={selectedStoreBenefitId}
                      onChange={(event) =>
                        setSelectedStoreBenefitId(event.target.value)
                      }
                      className="h-10 w-full appearance-none rounded-lg border border-beyonix-blue-light/24 bg-[#0B1118] px-3 pr-9 text-xs font-bold text-white outline-none transition-colors focus:border-beyonix-blue-light/70 focus:ring-2 focus:ring-beyonix-blue-light/18"
                    >
                      {storeBenefits.map((benefit) => (
                        <option key={benefit.id} value={benefit.id}>
                          {getStoreBenefitLabel()}{" "}
                          {benefit.percent}% · {benefit.code}
                        </option>
                      ))}
                    </select>
                    <ChevronDown className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-white/45" />
                  </div>
                  <p className="mt-1.5 text-11px font-semibold leading-5 text-white/56">
                    Se aplica una sola vez y queda consumido al confirmar la compra.
                  </p>
                </div>
              )}

              <Separator className="my-2 bg-beyonix-blue-light/12" />

              <div className="space-y-1 rounded-lg border border-beyonix-blue-light/14 bg-[#0B1118] px-3 py-2.5 text-sm shadow-inner shadow-black/20">
                {/* Productos − Beneficio + Envío (− Saldo) = Total, con el
                    precio de productos de la modalidad elegida: contado,
                    financiado (Mercado Pago en cuotas) o con descuento por
                    transferencia. El envío nunca se financia ni se descuenta. */}
                <div className="space-y-0.5">
                  <div className="flex justify-between" data-summary-row="products">
                    <span className="text-muted-foreground">Productos</span>
                    <span className="text-white">
                      {formatPrice(checkoutSummary.productsSubtotal)}
                    </span>
                  </div>
                  {isTransferPayment && transferDiscountAmount > 0 && (
                    <p className="text-right text-11px font-semibold text-[var(--checkout-offer-text)]">
                      Incluye {siteSettings.pricing.transferDiscountPercent}% OFF por transferencia
                    </p>
                  )}
                </div>
                {selectedStoreBenefit && checkoutSummary.storeBenefitDiscount > 0 && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">
                      {getStoreBenefitLabel()}{" "}
                      {selectedStoreBenefit.percent}%
                    </span>
                    <span className="font-semibold text-emerald-400">
                      -{formatPrice(checkoutSummary.storeBenefitDiscount)}
                    </span>
                  </div>
                )}
                <div className="space-y-0.5">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">
                      {customerCreditCoversShipping
                        ? "Envío"
                        : qualifiesForMainShippingBonus && shippingBonus > 0
                          ? "Envío bonificado"
                          : "Envío"}
                    </span>
                    <span className={
                      !selectedShippingOption &&
                        shippingMessage === ANDREANI_DESTINATION_UNAVAILABLE_MESSAGE
                        ? "font-semibold text-red-400"
                        : customerCreditCoversShipping
                          ? "font-semibold text-emerald-400"
                        : !selectedShippingOption
                        ? "text-white/45"
                        : totals.shipping === 0 &&
                            (shippingBonus > 0 || customerCreditCoversShipping)
                          ? "font-semibold text-emerald-400"
                          : "text-white"
                    }>
                      {selectedShippingOption?.quoteStatus === "pending"
                        ? "A confirmar"
                        : !selectedShippingOption &&
                            shippingMessage === ANDREANI_DESTINATION_UNAVAILABLE_MESSAGE
                          ? "No disponible"
                        : customerCreditCoversShipping
                        ? "GRATIS"
                        : !selectedShippingOption && shippingLoading
                        ? "Calculando…"
                        : !selectedShippingOption
                        ? "A definir"
                        : totals.shipping === 0 &&
                            (shippingBonus > 0 || customerCreditCoversShipping)
                          ? "GRATIS"
                          : qualifiesForMainShippingBonus && shippingBonus > 0
                            ? (
                              <span className="inline-flex items-baseline gap-1.5">
                                <span className="text-11px font-medium text-white/40 line-through">
                                  {formatPrice(shippingCostReal)}
                                </span>
                                <span className="font-semibold">
                                  {formatPrice(totals.shipping)}
                                </span>
                              </span>
                            )
                            : formatPrice(totals.shipping)}
                    </span>
                  </div>
                  {qualifiesForMainShippingBonus &&
                    shippingBonus > 0 &&
                    totals.shipping > 0 &&
                    selectedShippingOption && (
                    <p className="text-right text-11px font-semibold text-emerald-400">
                      Ahorrás {formatPrice(shippingBonus)} en tu envío
                    </p>
                  )}
                </div>
                {appliedCustomerCredit > 0 && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">
                      Saldo a favor
                    </span>
                    <span className="font-semibold text-emerald-400">
                      -{formatPrice(appliedCustomerCredit)}
                    </span>
                  </div>
                )}
                <Separator className="bg-beyonix-blue-light/12" />
                <div className="flex items-end justify-between pt-0.5 font-heading text-white">
                  <span className="font-bold">
                    {appliedCustomerCredit > 0
                      ? "Total a pagar"
                      : "Total"}
                  </span>
                  <span className="text-xl font-bold">
                    {formatPrice(finalTotal)}
                  </span>
                </div>
                {mercadoPagoQuote && (
                  <p
                    className="text-right text-11px font-semibold text-beyonix-sky"
                    data-mercadopago-summary={mercadoPagoQuote.mode}
                  >
                    {isMercadoPagoFinanced && maxInstallmentPlan
                      ? `Hasta ${maxInstallmentPlan.count} cuotas sin interés de ${formatPrice(maxInstallmentPlan.amount)}`
                      : "Pago con Mercado Pago al contado"}
                  </p>
                )}
                <p className="text-right text-10px font-medium text-white/40">
                  Precio sin impuestos nacionales: {formatPrice(priceWithoutNationalTaxesTotal)}
                </p>
              </div>

              {commercialUpdateNotice && (
                <CheckoutNotice tone="warning" className="mt-4">
                  <span role="status">{commercialUpdateNotice}</span>{" "}
                  <button
                    type="button"
                    onClick={() => setCommercialUpdateNotice(null)}
                    className="cursor-pointer text-xs font-semibold underline underline-offset-2"
                  >
                    Entendido
                  </button>
                </CheckoutNotice>
              )}

              {checkoutError && (
                <CheckoutNotice tone="error" className="mt-4">
                  {checkoutError}
                </CheckoutNotice>
              )}

            </aside>
          </form>
        </div>
      </div>
      </main>
      <Footer />
      {/* Confirmación ANTES de ir a Mercado Pago: la preferencia se crea
          recién al confirmar (submitCheckout). "Volver" no llama al servidor. */}
      {mercadoPagoConfirmOpen && mercadoPagoQuote && (
        <PaymentInfoModal
          title="Vas a continuar a Mercado Pago"
          onClose={() => {
            if (!isProcessing) setMercadoPagoConfirmOpen(false)
          }}
          footer={
            <div className="grid gap-2">
              <BeyonixButton
                variant="primary"
                size="md"
                className="w-full"
                data-confirm-mercadopago
                disabled={isProcessing}
                onClick={() => void submitCheckout()}
              >
                {isProcessing ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    Redirigiendo…
                  </>
                ) : (
                  "Continuar a Mercado Pago"
                )}
              </BeyonixButton>
              <BeyonixButton
                variant="outline"
                size="md"
                className="w-full"
                disabled={isProcessing}
                onClick={() => setMercadoPagoConfirmOpen(false)}
              >
                Volver
              </BeyonixButton>
            </div>
          }
        >
          {isMercadoPagoFinanced ? (
            <div data-mercadopago-confirm="financed">
              <p className="beyonix-modal-body text-[13px] leading-5 text-white/65">
                Elegiste pagar en cuotas.
              </p>
              <p className="beyonix-modal-title mt-2 text-[15px] font-bold text-white">
                Total financiado: {formatPrice(finalTotal)}
              </p>
              {maxInstallmentPlan && (
                <p className="beyonix-modal-body mt-0.5 text-[13px] text-white/65">
                  Hasta {maxInstallmentPlan.count} cuotas sin interés.
                </p>
              )}
              <InstallmentPlanList plans={mercadoPagoPricing.installmentPlans} />
              <div
                role="note"
                aria-labelledby="financed-total-warning-title"
                data-financed-total-warning
                className="checkout-financed-warning mt-3 flex gap-2.5 px-3 py-2.5"
              >
                <AlertTriangle
                  aria-hidden="true"
                  className="checkout-financed-warning-icon mt-0.5 size-4 shrink-0"
                />
                <div className="min-w-0">
                  <p
                    id="financed-total-warning-title"
                    data-financed-total-warning-title
                    className="checkout-financed-warning-title text-[12px] font-black tracking-wide"
                  >
                    ¡ATENCIÓN!
                  </p>
                  <p className="checkout-financed-warning-text mt-0.5 text-[13px] font-semibold leading-5">
                    {MERCADOPAGO_FINANCED_TOTAL_WARNING}
                  </p>
                </div>
              </div>
            </div>
          ) : (
            <div data-mercadopago-confirm="cash">
              <p className="beyonix-modal-body text-[13px] leading-5 text-white/65">
                Elegiste pagar al contado.
              </p>
              <p className="beyonix-modal-title mt-2 text-[15px] font-bold text-white">
                Total: {formatPrice(finalTotal)}
              </p>
              <p className="beyonix-modal-body mb-2 mt-3 text-[13px] text-white/65">
                Dentro de Mercado Pago elegí:
              </p>
              <MercadoPagoCashMediaList />
            </div>
          )}
        </PaymentInfoModal>
      )}
      {insufficientStockItems.length > 0 && (
        <InsufficientStockModal
          items={insufficientStockItems}
          reservationAttempt={reservationStockError}
          onClose={() => setInsufficientStockItems([])}
        />
      )}
    </>
  )
}
