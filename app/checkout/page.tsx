"use client"

import {
  type ReactNode,
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
  ArrowLeft,
  Check,
  ChevronDown,
  Clock3,
  Home,
  IdCard,
  Instagram,
  Landmark,
  Loader2,
  Mail,
  MapPin,
  Minus,
  Plus,
  Smartphone,
  Trash2,
  Truck,
  UserRound,
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
import { GeographicSelect } from "@/components/checkout/geographic-select"
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
  TRANSFER_DISCOUNT_PERCENT,
  calculateTransferPaymentTotalAfterCustomerCredit,
} from "@/lib/payments/transfer"
import { BEYONIX_SUPPORT_HOURS_DETAIL } from "@/lib/legal-contact"
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

function getShippingOptionLabel(type: ShippingType) {
  return type === "domicilio" ? "Envío a domicilio" : "Entrega en sucursal"
}

function getStockIndicatorClassName(status: StockStatus) {
  if (status === "low") {
    return "text-amber-200/75"
  }

  if (status === "out") {
    return "text-red-200/70"
  }

  return "text-emerald-300/70"
}

function getStockIndicatorSymbol(status: StockStatus) {
  if (status === "available") return "✓"

  return ""
}

const paymentMethods = [
  {
    id: "mercadopago",
    name: "Mercado Pago",
    description: "Pagá con saldo en Mercado Pago o con tarjeta",
    icon: Smartphone,
  },
  {
    id: "transferencia",
    name: "Transferencia bancaria",
    description: `Transferencia bancaria con ${TRANSFER_DISCOUNT_PERCENT}% OFF`,
    icon: Landmark,
  },
]

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
  "inline-flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-beyonix-blue-light/42 bg-[#112A43] font-black text-white shadow-[0_0_14px_rgba(47,111,163,0.16)] transition-all duration-200 hover:border-beyonix-blue-light/70 hover:bg-[#183B5E] hover:shadow-[0_0_18px_rgba(47,111,163,0.22)]"

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
          ? "border-red-400/24 bg-red-500/10 text-red-200"
          : tone === "warning"
            ? "border-amber-300/22 bg-amber-300/[0.055] text-white/82"
            : "border-beyonix-blue-light/16 bg-[#10151C] text-white/68",
        className,
      )}
    >
      {tone === "error" ? (
        <AlertCircle className="mt-0.5 size-4 shrink-0 text-red-300" />
      ) : tone === "warning" ? (
        <Clock3 className="mt-0.5 size-4 shrink-0 text-amber-300" />
      ) : null}
      <div className="min-w-0">{children}</div>
    </div>
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
  const telefono = data.telefono.replace(/\D/g, "")
  const dni = data.dni.replace(/\D/g, "")
  const calle = data.calle.trim()
  const numero = data.numero.trim()
  const cpDestino = data.cpDestino.trim()
  const localidad = data.localidad.trim()
  const provincia = data.provincia.trim()

  if (nombre.length < 3 || !hasLetters(nombre)) return "nombre"
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "email"
  if (telefono.length < 8 || telefono.length > 15) return "telefono"
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
    }
  }, [])

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
  const totalBeforeTransferDiscount = productsTotalAfterStoreBenefit + totals.shipping
  const maxApplicableCustomerCredit = getMaxApplicableCustomerCredit(
    customerCredit.balance,
    totalBeforeTransferDiscount,
  )
  const transferPaymentTotals = calculateTransferPaymentTotalAfterCustomerCredit({
    productsTotal: productsTotalAfterStoreBenefit,
    shipping: totals.shipping,
    customerCreditAmount: maxApplicableCustomerCredit,
  })
  const transferDiscountAmount = isTransferPayment
    ? transferPaymentTotals.discount
    : 0
  const totalBeforeCustomerCredit = isTransferPayment
    ? totalBeforeTransferDiscount - transferDiscountAmount
    : totalBeforeTransferDiscount
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
    paymentMethods.some(
      (method) => method.id === selectedPayment,
    )
  // El modal de "Stock insuficiente" solo puede aparecer como respuesta al
  // intento real de pago (ver handleSubmit): no hay ninguna validación
  // proactiva de stock mientras el cliente completa el Checkout.
  const hasKnownStockConflict = insufficientStockItems.length > 0
  const finalTotal = customerCreditApplication.externalAmountDue

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

    if (name === "telefono") {
      normalizedValue = value.replace(/\D/g, "").slice(0, FIELD_LIMITS.phone)
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
    setCurrentStep(
      Math.min(
        currentStep + 1,
        3
      ) as CheckoutStep
    )
  }

  const handleSubmit = async (
    e: React.FormEvent
  ) => {
    e.preventDefault()

    if (submissionInFlightRef.current) return
    if (!isFormValid || !selectedShippingOption || !isSelectedPaymentValid) return

    if (hasBlockedWords(formData.direccion)) {
      setCheckoutError("La dirección contiene texto no permitido.")
      return
    }

    submissionInFlightRef.current = true
    setIsProcessing(true)
    setCheckoutError("")

    try {
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
            quoteToken: selectedShippingOption.quoteToken,
            sucursalId:
              selectedShippingOption.type === "sucursal"
                ? selectedSucursalId
                : undefined,
          },
          storeBenefitId: selectedStoreBenefit?.id ?? null,
          paymentMethodId: selectedPayment || "customer_credit",
          customerCreditAmount: customerCreditApplication.appliedAmount,
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
        setInsufficientStockItems(data.items)
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

  if (items.length === 0) {
    return (
      <>
        <main className="min-h-screen bg-[#05070A] px-4 py-16 font-heading text-white lg:py-24">
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

            <div className="relative flex min-w-20 justify-end gap-2">
              {isInternal && (
                <AdminNotificationsBell
                  count={adminNotifications.notificationCount}
                  tone={adminNotifications.notificationTone}
                  groups={adminNotifications.notificationGroups}
                  notifications={adminNotifications.notifications}
                  loading={adminNotifications.loading}
                  error={adminNotifications.error}
                  onRetry={adminNotifications.reloadNotificationCount}
                />
              )}
              {user ? (
                <AccountMenu />
              ) : (
                <div className="hidden items-center gap-2 sm:flex">
                  <Link
                    href="/login?redirect=/checkout"
                    className="flex h-9 items-center rounded-full border border-beyonix-blue-light/22 bg-white/4 px-3 text-sm font-semibold text-white/78 transition hover:border-beyonix-blue-light/45 hover:text-white"
                  >
                    Iniciar sesión
                  </Link>
                  <Link
                    href="/login?mode=register&redirect=/checkout"
                    className="flex h-9 items-center rounded-full border border-beyonix-blue-light/45 bg-beyonix-blue px-3 text-sm font-semibold text-white transition hover:border-beyonix-blue-light/75 hover:bg-beyonix-blue-hover"
                  >
                    Registrarse
                  </Link>
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
                      ? "border-beyonix-blue-light/38 bg-[#112A43]/55 text-white/88"
                      : active
                        ? "border-beyonix-blue-light/70 bg-[#112A43] text-white shadow-[0_0_18px_rgba(47,111,163,0.16)]"
                        : "border-beyonix-blue-light/12 bg-[#10151C] text-white/44"
                  )}
                >
                  <span
                    className={cn(
                      "flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-bold",
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
                          <Input id="telefono" name="telefono" type="tel" inputMode="numeric" className={getCheckoutInputClassName("telefono")} value={formData.telefono} onChange={handleInputChange} maxLength={FIELD_LIMITS.phone} required />
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
                                    ? "No pudimos consultar los códigos postales"
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

                  <div className="grid gap-3">
                    {paymentMethods.map((method) => (
                      <button
                        key={method.id}
                        type="button"
                        onClick={() =>
                          setSelectedPayment(method.id)
                        }
                        className={cn(
                          checkoutOptionClassName,
                          "items-center gap-3 p-4",
                          selectedPayment === method.id &&
                            checkoutOptionSelectedClassName
                        )}
                      >
                        <span className={cn(
                          "flex size-11 shrink-0 items-center justify-center rounded-xl",
                          selectedPayment === method.id
                            ? "bg-beyonix-blue-light text-white"
                            : "bg-black/35 text-white/65"
                        )}>
                          <method.icon className="size-5" />
                        </span>
                        <span className="min-w-0">
                          <span className="block font-semibold text-white">
                            {method.name}
                          </span>
                          <span className="mt-1 block text-sm text-white/45">
                            {method.description}
                          </span>
                        </span>
                      </button>
                    ))}
                  </div>

                  {selectedPayment === "transferencia" && (
                    <CheckoutNotice tone="warning">
                      <strong className="text-white">Horario de validación de comprobantes:</strong>{" "}
                      {BEYONIX_SUPPORT_HOURS_DETAIL}
                    </CheckoutNotice>
                  )}

                  <div className="rounded-lg border border-beyonix-blue-light/12 bg-[#10151C] p-4">
                    <p className="text-xs font-semibold uppercase tracking-wider text-white/45">
                      ¿Necesitás ayuda con tu pago?
                    </p>
                    <div className="mt-3 grid gap-3 sm:grid-cols-2">
                      <a
                        href="https://instagram.com/beyonix.ar"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="group flex cursor-pointer items-center gap-3 rounded-lg border border-beyonix-blue-light/12 bg-[#0B1118] p-3 transition-colors hover:border-beyonix-blue-light/55 hover:bg-[#112A43]"
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
                        className="group flex cursor-pointer items-center gap-3 rounded-lg border border-beyonix-blue-light/12 bg-[#0B1118] p-3 transition-colors hover:border-beyonix-blue-light/55 hover:bg-[#112A43]"
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
                    disabled={!areCriticalCheckoutStatesReady}
                    className={cn(
                      "h-10 min-w-140px px-5 text-sm",
                      isCurrentStepValid
                        ? checkoutPrimaryButtonClassName
                        : cn(checkoutSecondaryButtonClassName, checkoutDisabledButtonClassName)
                    )}
                  >
                    Continuar
                  </button>
                ) : (
                  <Button
                    type="submit"
                    className={cn(
                      "h-10 min-w-180px px-5 text-sm",
                      isFormValid &&
                      !isProcessing &&
                      !hasKnownStockConflict &&
                      isSelectedPaymentValid
                        ? checkoutPrimaryButtonClassName
                        : cn(checkoutSecondaryButtonClassName, checkoutDisabledButtonClassName)
                    )}
                    disabled={
                      !isFormValid ||
                      isProcessing ||
                      hasKnownStockConflict ||
                      !isSelectedPaymentValid
                    }
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
                {items.map((item) => {
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
                          {formatPrice(item.unitPrice * item.quantity)}
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
                                item.quantity > 1 &&
                                decreaseQuantity(item.product.id, item.color)
                              }
                              disabled={item.quantity <= 1}
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
                              onClick={() =>
                                increaseQuantity(item.product.id, item.color)
                              }
                              disabled={isMaxQuantity}
                              className="flex h-full w-7 items-center justify-center border-l border-white/10 text-white/65 transition-colors enabled:cursor-pointer enabled:hover:bg-beyonix-blue/45 enabled:hover:text-white disabled:cursor-not-allowed disabled:opacity-35"
                            >
                              <Plus className="size-3" />
                            </button>
                          </div>
                        </div>

                        <button
                          type="button"
                          aria-label="Eliminar producto"
                          onClick={() =>
                            removeFromCart(item.product.id, item.color)
                          }
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
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Subtotal</span>
                  <span>{formatPrice(totals.subtotal)}</span>
                </div>
                {totals.discount > 0 && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Descuento</span>
                    <span className="font-semibold text-emerald-400">
                      -{formatPrice(totals.discount)}
                    </span>
                  </div>
                )}
                {selectedStoreBenefit && storeBenefitDiscountAmount > 0 && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">
                      {getStoreBenefitLabel()}{" "}
                      {selectedStoreBenefit.percent}%
                    </span>
                    <span className="font-semibold text-emerald-400">
                      -{formatPrice(storeBenefitDiscountAmount)}
                    </span>
                  </div>
                )}
                <div className="space-y-0.5">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">
                      {customerCreditIncludesShippingBenefit
                        ? "Envío"
                        : qualifiesForMainShippingBonus && shippingBonus > 0
                          ? "Envío bonificado"
                          : "Envío"}
                    </span>
                    <span className={
                      !selectedShippingOption &&
                        shippingMessage === ANDREANI_DESTINATION_UNAVAILABLE_MESSAGE
                        ? "font-semibold text-red-400"
                        : customerCreditIncludesShippingBenefit
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
                        : customerCreditIncludesShippingBenefit
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
                {transferDiscountAmount > 0 && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">
                      Transferencia {TRANSFER_DISCOUNT_PERCENT}% OFF
                    </span>
                    <span className="font-semibold text-emerald-400">
                      -{formatPrice(transferDiscountAmount)}
                    </span>
                  </div>
                )}
                {customerCreditApplication.appliedAmount > 0 && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">
                      Saldo a favor
                    </span>
                    <span className="font-semibold text-emerald-400">
                      -{formatPrice(customerCreditApplication.appliedAmount)}
                    </span>
                  </div>
                )}
                <Separator className="bg-beyonix-blue-light/12" />
                <div className="flex items-end justify-between pt-0.5 font-heading text-white">
                  <span className="font-bold">
                    {customerCreditApplication.appliedAmount > 0
                      ? "Total a pagar"
                      : "Total"}
                  </span>
                  <span className="text-xl font-bold">
                    {formatPrice(finalTotal)}
                  </span>
                </div>
              </div>

              {checkoutError && (
                <CheckoutNotice tone="error" className="mt-4">
                  {checkoutError}
                </CheckoutNotice>
              )}

              <p className="mt-2.5 text-center text-xs text-muted-foreground">
                Al completar tu compra aceptás nuestros{" "}
                <Link
                  href="/terminos"
                  className="font-medium text-foreground underline underline-offset-4 transition-colors hover:text-white"
                >
                  términos y condiciones
                </Link>
                .
              </p>
            </aside>
          </form>
        </div>
      </div>
      </main>
      <Footer />
      {insufficientStockItems.length > 0 && (
        <InsufficientStockModal
          items={insufficientStockItems}
          onClose={() => setInsufficientStockItems([])}
        />
      )}
    </>
  )
}
