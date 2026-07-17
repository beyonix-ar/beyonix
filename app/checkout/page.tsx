"use client"

import {
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react"

import Link from "next/link"

import {
  useRouter,
} from "next/navigation"

import {
  AlertCircle,
  ArrowLeft,
  Check,
  ChevronDown,
  CircleUserRound,
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
import { ProvinceSelect } from "@/components/province-select"

import {
  Separator,
} from "@/components/ui/separator"

import {
  reserveCartStock,
} from "@/lib/cart/stock-reservations"
import {
  STOCK_CHANGED_MESSAGE,
  getProductStock,
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
  calculateCartShippingPackage,
} from "@/lib/cart/shipping-package"
import {
  calculateCustomerShippingCost,
  calculateShippingBonus,
  SHIPPING_COST,
} from "@/lib/store-config"
import {
  formatDeliveryAddress,
  parseDeliveryAddress,
} from "@/lib/delivery-address"
import {
  hasBlockedWords,
} from "@/lib/validation/content-filter"
import {
  FIELD_LIMITS,
} from "@/lib/validation/account-fields"
import {
  TRANSFER_DISCOUNT_PERCENT,
  calculateTransferPaymentTotal,
} from "@/lib/payments/transfer"
import {
  calculateCustomerCreditApplication,
  getMaxApplicableCustomerCredit,
} from "@/lib/customer-credit"
import { supabase } from "@/lib/supabase/client"
import type { SupabaseProfile } from "@/lib/supabase/types"

import {
  beyonixHoverBorder,
  cn,
} from "@/lib/utils"
import { FreeShippingBar } from "@/components/cart/free-shipping-bar"
import { Footer } from "@/components/footer"
import { AdminNotificationsBell } from "@/components/admin-notifications-bell"
import { useOrderNotifications } from "@/hooks/use-order-notifications"
import { TransparencyAwareImage } from "@/components/transparency-aware-image"

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

function normalizeShippingOptionPrice(price: number, fallbackCost: number) {
  const quotedPrice = Number(price)

  return Number.isFinite(quotedPrice) && quotedPrice > 0
    ? quotedPrice
    : fallbackCost
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
    description: "Pagá con tu cuenta, tarjeta o dinero disponible",
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
  provider: "andreani"
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
  if (!/^\d{4,8}$/.test(cpDestino)) return "cpDestino"
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
    logout,
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

  const [stockError, setStockError] =
    useState("")
  const [checkoutError, setCheckoutError] =
    useState("")
  const [shippingMessage, setShippingMessage] =
    useState("")
  const [
    selectedShippingType,
    setSelectedShippingType,
  ] = useState<ShippingType | null>(null)
  const [shippingOptions, setShippingOptions] =
    useState<ShippingOption[]>([])
  const [accountMenuOpen, setAccountMenuOpen] =
    useState(false)
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
  const validationTimerRef =
    useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    setMounted(true)

    return () => {
      if (validationTimerRef.current) {
        clearTimeout(validationTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (!user) return

    const currentUser = user
    let cancelled = false

    async function loadCheckoutProfile() {
      const { data, error } = await supabase
        .from("profiles")
        .select(
          "id, email, nombre, username, telefono, dni, calle, numero, piso, departamento, localidad, codigo_postal, provincia, referencias, rol, created_at"
        )
        .eq("id", currentUser.id)
        .maybeSingle()

      if (cancelled || hasEditedCheckoutFormRef.current) return

      if (error) {
        console.error("CHECKOUT_PROFILE_LOAD_ERROR", {
          message: error.message,
          details: error.details,
          hint: error.hint,
          code: error.code,
          error,
        })
      }

      const profile = data as SupabaseProfile | null
      const fallbackAddress = currentUser.address ?? ""
      const parsedAddress = parseDeliveryAddress(
        fallbackAddress,
        profile?.provincia ?? currentUser.province,
        profile?.codigo_postal ?? currentUser.postalCode
      )

      setFormData((prev) => {
        const next = {
          ...prev,
        }
        const profileValues = {
          nombre: profile?.nombre ?? currentUser.name ?? "",
          email: profile?.email ?? currentUser.email ?? "",
          telefono: profile?.telefono ?? currentUser.phone ?? "",
          dni: (profile?.dni ?? currentUser.dni ?? "")
            .replace(/\D/g, "")
            .slice(0, 8),
          direccion: fallbackAddress,
          calle: profile?.calle ?? currentUser.street ?? parsedAddress.street,
          numero:
            profile?.numero ??
            currentUser.streetNumber ??
            parsedAddress.streetNumber,
          piso: profile?.piso ?? currentUser.floor ?? parsedAddress.floor,
          departamento:
            profile?.departamento ??
            currentUser.apartment ??
            parsedAddress.apartment,
          cpDestino: profile?.codigo_postal ?? currentUser.postalCode ?? "",
          localidad:
            profile?.localidad ?? currentUser.city ?? parsedAddress.locality,
          provincia: profile?.provincia ?? currentUser.province ?? "",
          referencias:
            profile?.referencias ?? currentUser.references ?? "",
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
    }

    void loadCheckoutProfile()

    return () => {
      cancelled = true
    }
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

  useEffect(() => {
    if (
      !mounted ||
      isLoading ||
      !isCartReady ||
      !cartSessionId ||
      items.length === 0
    ) {
      return
    }

    let cancelled = false

    setStockError("")

    reserveCartStock({
      sessionId: cartSessionId,
      items: items.map((item) => ({
        productId: item.product.id,
        quantity: item.quantity,
        variantId: item.variantId,
      })),
    })
      .then((result) => {
        if (cancelled) return

        if (!result.success) {
          setStockError(
            result.message ||
              STOCK_CHANGED_MESSAGE,
          )
        }
      })
      .catch(() => {
        if (cancelled) return

        setStockError(
          STOCK_CHANGED_MESSAGE,
        )
      })

    return () => {
      cancelled = true
    }
  }, [
    cartSessionId,
    isCartReady,
    isLoading,
    items,
    mounted,
    user,
  ])

  const baseTotals = calculateCartTotals(items)
  const totalCartUnits = items.reduce(
    (total, item) => total + item.quantity,
    0,
  )
  const packageInfo = calculateCartShippingPackage(items)
  const manualShippingCost = SHIPPING_COST
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
  const customerCreditIncludesShippingBenefit = customerCredit.balance > 0
  const customerCreditCoversShipping =
    customerCreditIncludesShippingBenefit &&
    selectedShippingOption != null &&
    shippingCostReal > 0
  const shippingBonus =
    selectedShippingOption
      ? customerCreditCoversShipping
        ? shippingCostReal
        : calculateShippingBonus(baseTotals.productsTotal, shippingCostReal)
      : 0
  const shippingCostCharged =
    selectedShippingOption
      ? customerCreditCoversShipping
        ? 0
        : calculateCustomerShippingCost(
            baseTotals.productsTotal,
            shippingCostReal,
          )
      : 0
  const freeShippingApplied =
    selectedShippingOption != null &&
    shippingCostReal > 0 &&
    shippingCostCharged === 0
  const totals = calculateCartTotals(items, {
    shippingCost: shippingCostCharged,
  })
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
  const transferPaymentTotals = calculateTransferPaymentTotal(
    productsTotalAfterStoreBenefit,
    totals.shipping,
  )
  const transferDiscountAmount = isTransferPayment
    ? transferPaymentTotals.discount
    : 0
  const totalBeforeCustomerCredit = isTransferPayment
    ? transferPaymentTotals.total
    : productsTotalAfterStoreBenefit + totals.shipping
  const maxApplicableCustomerCredit = getMaxApplicableCustomerCredit(
    customerCredit.balance,
    totalBeforeCustomerCredit,
  )
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
    const cpDestino = formData.cpDestino.trim()
    const provincia = formData.provincia.trim()
    const localidad = formData.localidad.trim()

    if (!cpDestino || !provincia || !localidad || items.length === 0) {
      setShippingOptions([
        {
          type: "sucursal",
          label: "Retiro en sucursal Andreani",
          price: manualShippingCost,
          provider: "andreani",
        },
        {
          type: "domicilio",
          label: "Envío a domicilio Andreani",
          price: manualShippingCost,
          provider: "andreani",
        },
      ])
      setShippingMessage(
        "Completá código postal, provincia y localidad para cotizar Andreani."
      )
      return
    }

    let cancelled = false

    fetch("/api/andreani/cotizar", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        cpDestino,
        provincia,
        localidad,
        ...packageInfo,
      }),
    })
      .then((response) => response.json())
      .then((data) => {
        if (cancelled) return

        if (Array.isArray(data.options) && data.options.length > 0) {
          setShippingOptions(
            data.options.map((option: ShippingOption) => ({
              type: option.type,
              label: option.label,
              price: normalizeShippingOptionPrice(
                option.price,
                manualShippingCost,
              ),
              provider: "andreani",
            }))
          )
          setShippingMessage("")
          return
        }

        setShippingOptions([
          {
            type: "sucursal",
            label: "Retiro en sucursal Andreani",
            price: manualShippingCost,
            provider: "andreani",
          },
          {
            type: "domicilio",
            label: "Envío a domicilio Andreani",
            price: manualShippingCost,
            provider: "andreani",
          },
        ])
        setShippingMessage(
          data.message ||
            "No pudimos cotizar Andreani en este momento. Intentá nuevamente o contactanos."
        )
      })
      .catch((error) => {
        if (cancelled) return

        console.error("ANDREANI_QUOTE_ERROR", error)
        setShippingOptions([
          {
            type: "sucursal",
            label: "Retiro en sucursal Andreani",
            price: manualShippingCost,
            provider: "andreani",
          },
          {
            type: "domicilio",
            label: "Envío a domicilio Andreani",
            price: manualShippingCost,
            provider: "andreani",
          },
        ])
        setShippingMessage(
          "No pudimos cotizar Andreani en este momento. Intentá nuevamente o contactanos."
        )
      })

    return () => {
      cancelled = true
    }
  }, [
    formData.cpDestino,
    formData.localidad,
    formData.provincia,
    items.length,
    manualShippingCost,
    packageInfo.altoCm,
    packageInfo.anchoCm,
    packageInfo.largoCm,
    packageInfo.pesoGramos,
    packageInfo.valorDeclarado,
  ])

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
      normalizedValue = value.replace(/\D/g, "").slice(0, FIELD_LIMITS.postalCode)
    }

    if (name === "calle") {
      normalizedValue = normalizedValue.slice(0, FIELD_LIMITS.street)
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

    setFormData((prev) => {
      const next = {
        ...prev,
        provincia: normalizedValue,
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
  const isShippingStepValid =
    Boolean(selectedShippingOption)
  const isFormValid = Boolean(
    isRecipientStepValid &&
      isShippingStepValid
  )
  const isCurrentStepValid =
    currentStep === 1
      ? isRecipientStepValid
      : isShippingStepValid
  const getCheckoutInputClassName = (
    field: RequiredCheckoutField
  ) =>
    cn(
      checkoutInputClassName,
      invalidField === field &&
        "border-red-400/70 shadow-[0_0_0_2px_rgba(248,113,113,0.1)]"
    )

  const goToNextStep = () => {
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

    if (!isFormValid || !selectedShippingOption || !isSelectedPaymentValid) return

    if (hasBlockedWords(formData.direccion)) {
      setCheckoutError("La dirección contiene texto no permitido.")
      return
    }

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
            costReal: shippingCostReal,
            costCharged: shippingCostCharged,
            freeShippingApplied,
          },
          storeBenefitId: selectedStoreBenefit?.id ?? null,
          paymentMethodId: selectedPayment || "customer_credit",
          customerCreditAmount: customerCreditApplication.appliedAmount,
          items: items.map((item) => ({
            productId: item.product.id,
            quantity: item.quantity,
            variantId: item.variantId,
            color: item.color,
          })),
        }),
      })

      const data = await response.json()

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
      setIsProcessing(false)
    }
  }
  if (!mounted || isLoading || !isCartReady) {
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
      <main className="min-h-screen bg-[#05070A] font-heading text-white">
      <header className="sticky top-0 z-50 border-b border-beyonix-blue-light/14 bg-[#05070A]/95 backdrop-blur">
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
                <>
                  <button
                    type="button"
                    aria-label="Abrir menú de cuenta"
                    aria-expanded={accountMenuOpen}
                    onClick={() => setAccountMenuOpen((current) => !current)}
                    className={cn(
                      "flex cursor-pointer items-center gap-2 rounded-full bg-black py-1.5 pl-1.5 pr-2 sm:pr-3",
                      beyonixHoverBorder
                    )}
                  >
                    <span className="flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-full border border-white/12 bg-white text-black">
                      {user.avatarUrl ? (
                        <img
                          src={user.avatarUrl}
                          alt=""
                          className="size-full object-cover"
                        />
                      ) : (
                        <CircleUserRound className="size-5" />
                      )}
                    </span>

                    <span className="hidden max-w-32 truncate text-sm font-medium uppercase text-white/86 sm:block">
                      {(user.username || user.name.split(" ")[0]).toUpperCase()}
                    </span>

                    <ChevronDown
                      className={`hidden size-4 text-white/50 transition-transform sm:block ${
                        accountMenuOpen ? "rotate-180" : ""
                      }`}
                    />
                  </button>

                  {accountMenuOpen && (
                    <div className="absolute right-0 top-12 z-50 w-220px overflow-hidden rounded-2xl border border-white/10 bg-black shadow-2xl shadow-black/70">
                      <Link
                        href="/cuenta?tab=datos"
                        aria-label="Ir a Mis datos"
                        title="Ir a Mis datos"
                        className={cn(
                          "block px-4 py-3 text-sm font-medium text-white/78 hover:bg-beyonix-blue hover:text-white",
                          beyonixHoverBorder
                        )}
                      >
                        Mis datos
                      </Link>
                      <Link
                        href="/cuenta?tab=ordenes"
                        aria-label="Ir a Mis compras"
                        title="Ir a Mis compras"
                        className={cn(
                          "block px-4 py-3 text-sm font-medium text-white/78 hover:bg-beyonix-blue hover:text-white",
                          beyonixHoverBorder
                        )}
                      >
                        Mis compras
                      </Link>
                      <Link
                        href="/cuenta?tab=seguridad"
                        aria-label="Ir a Seguridad"
                        title="Ir a Seguridad"
                        className={cn(
                          "block px-4 py-3 text-sm font-medium text-white/78 hover:bg-beyonix-blue hover:text-white",
                          beyonixHoverBorder
                        )}
                      >
                        Seguridad
                      </Link>
                      <button
                        type="button"
                        aria-label="Cerrar sesión"
                        onClick={() => {
                          setAccountMenuOpen(false)
                          logout()
                        }}
                        className="block w-full cursor-pointer border-t border-white/8 px-4 py-3 text-left text-sm font-medium text-white/62 transition-colors hover:bg-red-950 hover:text-red-300"
                      >
                        Cerrar sesión
                      </button>
                    </div>
                  )}
                </>
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
          <div className="mb-4 flex items-end justify-between gap-4">
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

          <div className="mb-3 grid grid-cols-3 gap-2 lg:gap-3" aria-label="Progreso del checkout">
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
            className="grid items-stretch gap-5 lg:grid-cols-[minmax(0,1.65fr)_minmax(22rem,0.85fr)] lg:gap-4 2xl:gap-5"
          >
            <section className={cn(checkoutFormPanelClassName, "flex min-h-[clamp(440px,52vh,560px)] flex-col px-4 pb-3 pt-4 sm:px-5 sm:pb-4 sm:pt-5")}>
              {currentStep === 1 && (
                <div className="animate-in fade-in slide-in-from-right-2 space-y-3 duration-300 [&_label]:text-[13px]">
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
                          <ProvinceSelect
                            value={formData.provincia}
                            onChange={handleProvinceChange}
                            appearance="checkout"
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
                          <Input id="localidad" name="localidad" className={getCheckoutInputClassName("localidad")} value={formData.localidad} onChange={handleInputChange} maxLength={60} required />
                        </div>
                        <div className="space-y-0.5">
                          <Label htmlFor="cpDestino" className="text-white/75">
                            <MapPin aria-hidden="true" className="size-3.5 text-[#4f8cc9]/65" />
                            Código postal *
                          </Label>
                          <Input id="cpDestino" name="cpDestino" inputMode="numeric" className={getCheckoutInputClassName("cpDestino")} value={formData.cpDestino} onChange={handleInputChange} maxLength={FIELD_LIMITS.postalCode} required />
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
                    {shippingOptions.map((option) => {
                      const selected =
                        selectedShippingType === option.type
                      const optionShippingCoveredByBeyonix =
                        customerCreditIncludesShippingBenefit
                      const optionShippingCostCharged =
                        optionShippingCoveredByBeyonix
                          ? 0
                          : calculateCustomerShippingCost(
                              baseTotals.productsTotal,
                              option.price,
                            )

                      return (
                        <button
                          key={option.type}
                          type="button"
                          onClick={() => {
                            setSelectedShippingType(option.type)
                            setShippingSelectionMissing(false)
                          }}
                          className={cn(
                            checkoutOptionClassName,
                            "items-center gap-4 px-4 py-3.5",
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
                            <span className="mt-0.5 block text-xs text-white/42">
                              Cotización Andreani
                            </span>
                          </span>
                          <span className="flex shrink-0 items-center gap-2 text-right">
                            {selected && (
                              <span className="flex size-5 items-center justify-center rounded-full border border-beyonix-blue-light/35 bg-beyonix-blue/50 text-beyonix-sky">
                                <Check className="size-3" />
                              </span>
                            )}
                            <span className={optionShippingCostCharged === 0 ? "text-sm font-semibold text-emerald-400" : "text-sm font-semibold text-white"}>
                              {optionShippingCoveredByBeyonix
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

                  {shippingMessage && (
                    <CheckoutNotice>
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
                  "mt-auto flex items-center gap-3 pt-3",
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
                      !stockError &&
                      isSelectedPaymentValid
                        ? checkoutPrimaryButtonClassName
                        : cn(checkoutSecondaryButtonClassName, checkoutDisabledButtonClassName)
                    )}
                    disabled={
                      !isFormValid ||
                      isProcessing ||
                      Boolean(stockError) ||
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

            <aside className={cn(checkoutPanelClassName, "h-fit self-start px-4 py-3 lg:sticky lg:top-24")}>
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
                />
              </div>

              <div className="custom-scrollbar max-h-[clamp(300px,38vh,390px)] space-y-1.5 overflow-y-auto pr-1">
                {items.map((item) => {
                  const maxQuantity = getProductStock(item.product, item.color)
                  const isMaxQuantity =
                    maxQuantity > 0 && item.quantity >= maxQuantity
                  const stockStatus = getStockStatus(item.product, item.color)
                  const showStockIndicator = stockStatus !== "out"
                  const stockSymbol = getStockIndicatorSymbol(stockStatus)

                  return (
                    <div
                      key={`${item.product.id}-${item.variantId ?? item.color}`}
                      className="checkout-order-item group grid min-h-[92px] grid-cols-[78px_minmax(0,1fr)] gap-2.5 overflow-hidden rounded-lg border border-beyonix-blue-light/14 bg-[#10151C] px-2 py-1.5 transition-all hover:border-beyonix-blue-light/40 hover:shadow-lg hover:shadow-black/20"
                    >
                    <div className="h-full min-h-[80px] overflow-hidden rounded-lg border border-white/8 bg-beyonix-surface-3">
                      <TransparencyAwareImage
                        src={item.image}
                        alt={`${item.product.nombre} en carrito`}
                        className="h-full w-full object-contain p-1.5 transition-transform duration-300 group-hover:scale-[1.025]"
                      />
                    </div>

                    <div className="flex min-w-0 flex-col justify-between py-0.5">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="line-clamp-2 text-sm font-bold text-foreground">
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
                          {formatPrice(item.product.precio * item.quantity)}
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
                          {getStoreBenefitLabel(benefit.benefit_type)}{" "}
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
                      {getStoreBenefitLabel(selectedStoreBenefit.benefit_type)}{" "}
                      {selectedStoreBenefit.percent}%
                    </span>
                    <span className="font-semibold text-emerald-400">
                      -{formatPrice(storeBenefitDiscountAmount)}
                    </span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span className="text-muted-foreground">
                    {customerCreditIncludesShippingBenefit
                      ? "Envío"
                      : shippingBonus > 0
                        ? "Envío bonificado"
                        : "Envío"}
                  </span>
                  <span className={
                    customerCreditIncludesShippingBenefit
                      ? "font-semibold text-emerald-400"
                      : !selectedShippingOption
                      ? "text-white/45"
                      : totals.shipping === 0 &&
                          (shippingBonus > 0 || customerCreditCoversShipping)
                        ? "font-semibold text-emerald-400"
                        : "text-white"
                  }>
                    {customerCreditIncludesShippingBenefit
                      ? "GRATIS"
                      : !selectedShippingOption
                      ? "A definir"
                      : totals.shipping === 0 &&
                          (shippingBonus > 0 || customerCreditCoversShipping)
                        ? "Sin cargo"
                        : formatPrice(totals.shipping)}
                  </span>
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

              {stockError && (
                <CheckoutNotice tone="error" className="mt-4">
                  {stockError}
                </CheckoutNotice>
              )}
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
    </>
  )
}
