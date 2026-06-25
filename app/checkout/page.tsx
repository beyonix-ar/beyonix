"use client"

import {
  useEffect,
  useRef,
  useState,
} from "react"

import Link from "next/link"

import {
  useRouter,
} from "next/navigation"

import {
  ArrowLeft,
  Check,
  ChevronDown,
  CircleUserRound,
  Clock3,
  Home,
  Instagram,
  Landmark,
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
  calculateCartTotals,
} from "@/lib/cart/cart-totals"
import {
  calculateCartShippingPackage,
} from "@/lib/cart/shipping-package"
import {
  getShippingCost,
} from "@/lib/store-config"
import {
  formatDeliveryAddress,
  parseDeliveryAddress,
} from "@/lib/delivery-address"
import {
  hasBlockedWords,
} from "@/lib/validation/content-filter"
import {
  TRANSFER_ALIAS,
  TRANSFER_ACCOUNT_HOLDER,
  TRANSFER_CVU,
  TRANSFER_DISCOUNT_PERCENT,
  calculateTransferPaymentTotal,
} from "@/lib/payments/transfer"
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
    description: `Transferencia con ${TRANSFER_DISCOUNT_PERCENT}% OFF y validación manual`,
    icon: Landmark,
  },
]

const checkoutInputClassName =
  "beyonix-checkout-input h-9 rounded-xl border-[#30363D] bg-[#1F242B] font-heading uppercase text-white placeholder:normal-case placeholder:text-white/40 hover:border-[#46505c] focus-visible:border-[#112A43] focus-visible:ring-1 focus-visible:ring-[#112A43]/70"

const CHECKOUT_EMAIL = "beyonix.ar@gmail.com"
const CHECKOUT_EMAIL_URL = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(CHECKOUT_EMAIL)}&su=${encodeURIComponent("Consulta sobre mi compra en BEYONIX")}`

const initialCheckoutFormData = {
  nombre: "",
  email: "",
  telefono: "",
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
  provider: "andreani" | "manual"
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

function normalizePlaceName(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
}

function isRosarioLocality(value: string) {
  return normalizePlaceName(value) === "rosario"
}

type RequiredCheckoutField =
  | "nombre"
  | "email"
  | "telefono"
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
  const calle = data.calle.trim()
  const numero = data.numero.trim()
  const cpDestino = data.cpDestino.trim()
  const localidad = data.localidad.trim()
  const provincia = data.provincia.trim()

  if (nombre.length < 3 || !hasLetters(nombre)) return "nombre"
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "email"
  if (telefono.length < 8 || telefono.length > 15) return "telefono"
  if (calle.length < 2 || !hasLetters(calle)) return "calle"
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

  const [mounted, setMounted] =
    useState(false)

  const [
    selectedPayment,
    setSelectedPayment,
  ] = useState("mercadopago")

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
    if (!mounted || isLoading || user) return

    router.replace("/login?redirect=/checkout")
  }, [isLoading, mounted, router, user])

  useEffect(() => {
    if (!user) return

    const currentUser = user
    let cancelled = false

    async function loadCheckoutProfile() {
      const { data, error } = await supabase
        .from("profiles")
        .select(
          "id, email, nombre, username, telefono, calle, numero, piso, departamento, localidad, codigo_postal, provincia, referencias, rol, created_at"
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
    if (
      !mounted ||
      isLoading ||
      !user ||
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
              "No hay stock suficiente para reservar este carrito.",
          )
        }
      })
      .catch(() => {
        if (cancelled) return

        setStockError(
          "No pudimos validar el stock del carrito. Probá nuevamente.",
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
  const packageInfo = calculateCartShippingPackage(items)
  const manualShippingCost = getShippingCost(baseTotals.productsTotal)
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
  const freeShippingApplied =
    manualShippingCost === 0 || selectedShippingOption?.price === 0
  const shippingCostCharged =
    selectedShippingOption &&
    !freeShippingApplied
      ? shippingCostReal
      : 0
  const totals = calculateCartTotals(items, {
    shippingCost: shippingCostCharged,
  })
  const isTransferPayment = selectedPayment === "transferencia"
  const isSelectedPaymentValid = paymentMethods.some(
    (method) => method.id === selectedPayment,
  )
  const transferPaymentTotals = calculateTransferPaymentTotal(
    totals.productsTotal,
    totals.shipping,
  )
  const transferDiscountAmount = isTransferPayment
    ? transferPaymentTotals.discount
    : 0
  const finalTotal = isTransferPayment
    ? transferPaymentTotals.total
    : totals.total

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

    if (isRosarioLocality(localidad)) {
      setShippingOptions([
        {
          type: "domicilio",
          label: "Envío sin costo Rosario",
          price: 0,
          provider: "manual",
        },
      ])
      setSelectedShippingType("domicilio")
      setShippingMessage("Entrega local sin costo dentro de Rosario.")
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
              price: Number(option.price) || 0,
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
    const normalizedValue =
      value.toLocaleUpperCase(
        "es-AR"
      )

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

    if (!isFormValid || !selectedShippingOption) return

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
        selectedPayment === "transferencia"
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
          items: items.map((item) => ({
            productId: item.product.id,
            quantity: item.quantity,
            variantId: item.variantId,
            color: item.color,
          })),
        }),
      })

      const data = await response.json()

      if (selectedPayment === "transferencia") {
        if (!response.ok || !data.order_id || !data.redirect_url) {
          setCheckoutError(
            data.error ||
              "No pudimos registrar el pedido por transferencia. Intentá nuevamente.",
          )
          return
        }

        clearCart()
        window.location.href = data.redirect_url
        return
      }

      if (!response.ok || !data.init_point) {
        setCheckoutError(
          data.error ||
            "No pudimos completar la compra. Revisá el stock e intentá nuevamente.",
        )
        return
      }

      window.location.href = data.init_point
    } catch {
      setCheckoutError(
        "No pudimos completar la compra. Revisá el stock e intentá nuevamente.",
      )
    } finally {
      setIsProcessing(false)
    }
  }
  if (!mounted || isLoading || !user || !isCartReady) {
    return null
  }

  if (items.length === 0) {
    return (
      <>
        <main className="bg-background">
          <div className="container mx-auto px-4 py-16 lg:py-24">
            <div className="max-w-md mx-auto text-center">
              <h1 className="text-2xl font-bold text-foreground mb-4">
                Tu carrito está vacío
              </h1>

              <Button
                type="button"
                aria-label="Volver a la tienda"
                title="Volver a la tienda"
                onClick={() =>
                  router.push("/")
                }
              >
                Volver a la tienda
              </Button>
            </div>
          </div>
        </main>
        <Footer />
      </>
    )
  }

  return (
    <>
      <main className="bg-[#05070A] font-heading">
      <header className="border-b border-border bg-black sticky top-0 z-50">
        <div className="container mx-auto px-4 lg:px-8">
          <div className="flex items-center justify-between h-16 lg:h-20">
            <button
              type="button"
              aria-label="Volver a la tienda"
              title="Volver a la tienda"
              onClick={() =>
                router.push("/")
              }
              className="flex cursor-pointer items-center gap-2 rounded-xl px-3 py-2 text-muted-foreground transition-colors hover:bg-[#112A43] hover:text-white"
            >
              <ArrowLeft className="size-5" />

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
              <button
                type="button"
                aria-label="Abrir menú de cuenta"
                title="Abrir menú de cuenta"
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
                    title="Cerrar sesión"
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
            </div>
          </div>
        </div>
      </header>

      <div className="container mx-auto px-4 py-5 lg:px-8 lg:py-7">
        <div className="mx-auto max-w-7xl">
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
                    "flex min-w-0 items-center gap-2 rounded-xl border px-3 py-2 text-left transition-all",
                    active
                      ? "border-beyonix-blue-light bg-beyonix-blue/45 text-white"
                      : complete
                        ? "border-beyonix-blue-light/25 bg-[#15191d] text-white/80"
                        : "border-white/8 bg-[#121212] text-white/40"
                  )}
                >
                  <span
                    className={cn(
                      "flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-bold",
                      active || complete
                        ? "border-beyonix-sky/35 bg-beyonix-blue text-beyonix-sky"
                        : "border-white/10 bg-black/35"
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
            className="grid items-stretch gap-5 lg:grid-cols-3 lg:gap-3"
          >
            <section className="checkout-panel flex min-h-[480px] flex-col rounded-2xl border px-4 pb-3 pt-4 shadow-xl shadow-black/25 sm:px-5 sm:pb-4 sm:pt-5 lg:col-span-2">
              {currentStep === 1 && (
                <div className="animate-in fade-in slide-in-from-right-2 space-y-4 rounded-2xl border border-[#30363D]/80 bg-[#15191F] px-4 py-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.025)] duration-300 sm:px-5 sm:py-4 [&_label]:text-[13px]">
                  <h2 className="border-l-4 border-beyonix-blue py-0.5 pl-3 text-xl font-bold text-foreground">
                    Datos de quien recibe
                  </h2>

                  <div className="space-y-4">
                    <div className="space-y-2.5">
                      <div className="flex items-center gap-3">
                        <p className="shrink-0 text-9px font-bold uppercase tracking-[0.16em] text-white/45">
                          Datos personales
                        </p>
                        <span className="h-px flex-1 bg-[#30363D]" />
                      </div>

                      <div className="grid gap-x-3 gap-y-3 sm:grid-cols-2">
                        <div className="space-y-1">
                          <Label htmlFor="nombre" className="text-white/75">
                            <UserRound aria-hidden="true" className="size-3.5 text-[#4f8cc9]/65" />
                            Nombre completo *
                          </Label>
                          <Input id="nombre" name="nombre" className={getCheckoutInputClassName("nombre")} value={formData.nombre} onChange={handleInputChange} required />
                        </div>
                        <div className="space-y-1">
                          <Label htmlFor="email" className="text-white/75">
                            <Mail aria-hidden="true" className="size-3.5 text-[#4f8cc9]/65" />
                            Email *
                          </Label>
                          <Input id="email" name="email" type="email" className={getCheckoutInputClassName("email")} value={formData.email} onChange={handleInputChange} required />
                        </div>
                        <div className="space-y-1">
                          <Label htmlFor="telefono" className="text-white/75">
                            <Smartphone aria-hidden="true" className="size-3.5 text-[#4f8cc9]/65" />
                            Teléfono *
                          </Label>
                          <Input id="telefono" name="telefono" type="tel" className={getCheckoutInputClassName("telefono")} value={formData.telefono} onChange={handleInputChange} required />
                        </div>
                      </div>
                    </div>

                    <div className="space-y-2.5">
                      <div className="flex items-center gap-3">
                        <p className="shrink-0 text-9px font-bold uppercase tracking-[0.16em] text-white/45">
                          Dirección de entrega
                        </p>
                        <span className="h-px flex-1 bg-[#30363D]" />
                      </div>

                      <div className="grid gap-x-3 gap-y-3 sm:grid-cols-2">
                        <div className="space-y-1">
                          <Label htmlFor="calle" className="text-white/75">
                            <Home aria-hidden="true" className="size-3.5 text-[#4f8cc9]/65" />
                            Calle *
                          </Label>
                          <Input id="calle" name="calle" className={getCheckoutInputClassName("calle")} value={formData.calle} onChange={handleInputChange} required />
                        </div>
                        <div className="space-y-1">
                          <Label htmlFor="numero" className="text-white/75">
                            <Home aria-hidden="true" className="size-3.5 text-[#4f8cc9]/65" />
                            Número *
                          </Label>
                          <Input id="numero" name="numero" inputMode="numeric" className={getCheckoutInputClassName("numero")} value={formData.numero} onChange={handleInputChange} required />
                        </div>
                        <div className="grid grid-cols-2 gap-3 sm:col-span-2">
                          <div className="space-y-1">
                            <Label htmlFor="piso" className="text-white/75">Piso opcional</Label>
                            <Input id="piso" name="piso" className={checkoutInputClassName} value={formData.piso} onChange={handleInputChange} />
                          </div>
                          <div className="space-y-1">
                            <Label htmlFor="departamento" className="text-white/75">Departamento opcional</Label>
                            <Input id="departamento" name="departamento" className={checkoutInputClassName} value={formData.departamento} onChange={handleInputChange} />
                          </div>
                        </div>
                        <div className="space-y-1 sm:col-span-2">
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
                        <div className="space-y-1">
                          <Label htmlFor="localidad" className="text-white/75">
                            <MapPin aria-hidden="true" className="size-3.5 text-[#4f8cc9]/65" />
                            Localidad *
                          </Label>
                          <Input id="localidad" name="localidad" className={getCheckoutInputClassName("localidad")} value={formData.localidad} onChange={handleInputChange} required />
                        </div>
                        <div className="space-y-1">
                          <Label htmlFor="cpDestino" className="text-white/75">
                            <MapPin aria-hidden="true" className="size-3.5 text-[#4f8cc9]/65" />
                            Código postal *
                          </Label>
                          <Input id="cpDestino" name="cpDestino" inputMode="numeric" className={getCheckoutInputClassName("cpDestino")} value={formData.cpDestino} onChange={handleInputChange} required />
                        </div>
                        <div className="space-y-1 sm:col-span-2">
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
                  <h2 className="border-l-4 border-beyonix-blue pl-3 text-lg font-semibold text-foreground">
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

                      return (
                        <button
                          key={option.type}
                          type="button"
                          onClick={() => {
                            setSelectedShippingType(option.type)
                            setShippingSelectionMissing(false)
                          }}
                          className={cn(
                            "checkout-option flex w-full cursor-pointer items-center gap-4 rounded-xl border p-4 text-left transition-all hover:border-beyonix-blue-light/55",
                            selected &&
                              "checkout-option-selected"
                          )}
                        >
                          <span className={cn(
                            "flex size-11 shrink-0 items-center justify-center rounded-xl border",
                            selected
                              ? "border-beyonix-sky/25 bg-beyonix-blue text-beyonix-sky"
                              : "border-white/8 bg-black/30 text-white/55"
                          )}>
                            <Truck className="size-5" />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block font-semibold text-white">
                              {option.label}
                            </span>
                            <span className="mt-1 block text-sm text-white/45">
                              {option.provider === "manual"
                                ? "Entrega local BEYONIX"
                                : "Cotización Andreani"}
                            </span>
                          </span>
                          <span className={freeShippingApplied ? "font-semibold text-emerald-400" : "font-semibold text-white"}>
                            {freeShippingApplied
                              ? "GRATIS"
                              : formatPrice(option.price)}
                          </span>
                        </button>
                      )
                    })}
                  </div>

                  {shippingMessage && (
                    <div className="checkout-note rounded-xl border px-4 py-3 text-sm text-white/65">
                      {shippingMessage}
                    </div>
                  )}
                </div>
              )}

              {currentStep === 3 && (
                <div className="animate-in fade-in slide-in-from-right-2 space-y-4 duration-300">
                  <h2 className="border-l-4 border-beyonix-blue pl-3 text-lg font-semibold text-foreground">
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
                          "checkout-option flex w-full cursor-pointer items-center gap-3 rounded-xl border p-4 text-left transition-all hover:border-beyonix-blue-light/55",
                          selectedPayment === method.id &&
                            "checkout-option-selected"
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

                  {isTransferPayment && (
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="checkout-note rounded-xl border p-4">
                        <p className="text-xs font-semibold uppercase tracking-wider text-beyonix-cyan/80">
                          Datos de transferencia
                        </p>
                        <p className="mt-2 text-base font-semibold text-white">
                          Alias: <span className="uppercase text-beyonix-sky">{TRANSFER_ALIAS}</span>
                          <br />
                          <span className="text-sm font-medium">
                            Titular: {TRANSFER_ACCOUNT_HOLDER}
                          </span>
                          <br />
                          <span className="text-xs font-medium">
                            CVU: {TRANSFER_CVU}
                          </span>
                        </p>
                        <p className="mt-1 text-sm text-white/55">
                          {TRANSFER_DISCOUNT_PERCENT}% OFF con validación manual.
                        </p>
                      </div>

                      <div className="checkout-note flex items-start gap-3 rounded-xl border p-4">
                        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-beyonix-blue-light/20 bg-beyonix-blue/25 text-beyonix-sky">
                          <Clock3 className="size-5" />
                        </span>
                        <div>
                          <p className="text-xs font-semibold uppercase tracking-wider text-beyonix-cyan/80">
                            Validación de pagos
                          </p>
                          <p className="mt-2 text-sm text-white/75">
                            Comprobantes revisados:
                            <br />
                            Lunes a viernes: 7:00 a 20:00 hs
                          </p>
                          <p className="mt-1 text-sm text-white/55">
                            Sábados: 8:00 a 14:00 hs
                          </p>
                        </div>
                      </div>
                    </div>
                  )}

                  <div className="rounded-xl border border-white/8 bg-[#141414] p-4">
                    <p className="text-xs font-semibold uppercase tracking-wider text-white/45">
                      ¿Necesitás ayuda con tu pago?
                    </p>
                    <div className="mt-3 grid gap-3 sm:grid-cols-2">
                      <a
                        href="https://instagram.com/beyonix.ar"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="group flex cursor-pointer items-center gap-3 rounded-xl border border-white/8 bg-[#1b1b1b] p-3 transition-colors hover:border-beyonix-blue-light/55 hover:bg-[#112A43]"
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
                        className="group flex cursor-pointer items-center gap-3 rounded-xl border border-white/8 bg-[#1b1b1b] p-3 transition-colors hover:border-beyonix-blue-light/55 hover:bg-[#112A43]"
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

              <div className="mt-auto flex items-center justify-between gap-3 border-t border-white/8 pt-3">
                <button
                  type="button"
                  disabled={currentStep === 1}
                  onClick={() =>
                    setCurrentStep(
                      Math.max(
                        currentStep - 1,
                        1
                      ) as CheckoutStep
                    )
                  }
                  className="h-10 min-w-110px cursor-pointer rounded-xl border border-white/10 bg-[#181818] px-4 text-sm font-semibold text-white/70 transition-colors hover:border-beyonix-blue-light/55 hover:bg-beyonix-blue/45 hover:text-white disabled:cursor-not-allowed disabled:opacity-25"
                >
                  Anterior
                </button>

                {currentStep < 3 ? (
                  <button
                    type="button"
                    onClick={goToNextStep}
                    className={cn(
                      "h-10 min-w-140px cursor-pointer rounded-xl px-5 text-sm font-semibold text-white transition-colors",
                      isCurrentStepValid
                        ? "bg-[#16A34A] hover:bg-[#15803D]"
                        : "bg-beyonix-blue hover:bg-beyonix-blue-hover"
                    )}
                  >
                    Continuar
                  </button>
                ) : (
                  <Button
                    type="submit"
                    className={cn(
                      "h-10 min-w-180px",
                      isFormValid &&
                      !isProcessing &&
                      !stockError
                        ? isTransferPayment && isSelectedPaymentValid
                          ? "bg-[#16A34A] text-white hover:bg-[#15803D]"
                          : "bg-beyonix-blue text-white hover:bg-beyonix-blue-hover"
                        : "cursor-not-allowed bg-neutral-700 text-white/55 hover:bg-neutral-700"
                    )}
                    disabled={
                      !isFormValid ||
                      isProcessing ||
                      Boolean(stockError)
                    }
                  >
                    {isProcessing
                      ? "Procesando..."
                      : isTransferPayment
                        ? "Registrar pedido"
                        : "Pagar ahora"}
                  </Button>
                )}
              </div>
            </section>

            <aside className="checkout-panel relative h-fit self-start overflow-hidden rounded-2xl border px-4 py-3 shadow-2xl shadow-black/25 lg:sticky lg:top-24">
              <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-linear-to-r from-transparent via-beyonix-blue-light/75 to-transparent" />
              <div className="flex items-center justify-between gap-3">
                <h2 className="border-l-4 border-beyonix-blue pl-3 text-lg font-semibold text-foreground">
                  Resumen del pedido
                </h2>
                <span className="rounded-full border border-beyonix-blue-light/30 bg-transparent px-2.5 py-1 text-10px font-semibold uppercase tracking-widest text-white/60">
                  {items.reduce((total, item) => total + item.quantity, 0)} unidades
                </span>
              </div>

              <div className="my-2.5 rounded-xl border border-[#30363D] bg-[#15191F] px-3 py-2 shadow-inner shadow-black/20">
                <FreeShippingBar subtotal={baseTotals.productsTotal} />
              </div>

              <div className="custom-scrollbar max-h-[320px] space-y-1.5 overflow-y-auto pr-1">
                {items.map((item) => (
                  <div
                    key={`${item.product.id}-${item.variantId ?? item.color}`}
                    className="checkout-order-item group grid min-h-104px grid-cols-[88px_minmax(0,1fr)] gap-3 overflow-hidden rounded-xl border border-[#30363D] bg-[#15191F] px-2 py-1.5 transition-all hover:border-beyonix-blue-light/40 hover:shadow-lg hover:shadow-black/20"
                  >
                    <div className="h-full min-h-92px overflow-hidden rounded-lg border border-white/8 bg-beyonix-surface-3">
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
                          {(item.variantName || item.colorHex) && (
                            <div className="mt-1 inline-flex max-w-full items-center gap-1.5">
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
                              title="Disminuir cantidad"
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
                              className="flex h-full w-7 cursor-pointer items-center justify-center border-l border-white/10 text-white/65 transition-colors hover:bg-beyonix-blue/45 hover:text-white"
                            >
                              <Plus className="size-3" />
                            </button>
                          </div>
                        </div>

                        <button
                          type="button"
                          title="Eliminar producto"
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
                ))}
              </div>

              <Separator className="my-2 bg-[#242424]" />

              <div className="space-y-1 rounded-xl border border-[#242a31] bg-[#090C10] px-3 py-2.5 text-sm shadow-inner shadow-black/20">
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
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Envío</span>
                  <span className={
                    !selectedShippingOption
                      ? "text-white/45"
                      : totals.shipping === 0
                        ? "font-semibold text-emerald-400"
                        : "text-white"
                  }>
                    {!selectedShippingOption
                      ? "A definir"
                      : totals.shipping === 0
                        ? "GRATIS"
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
                <Separator className="bg-[#242424]" />
                <div className="flex items-end justify-between pt-0.5 font-heading text-white">
                  <span className="font-bold">Total</span>
                  <span className="text-xl font-bold">
                    {formatPrice(finalTotal)}
                  </span>
                </div>
              </div>

              {stockError && (
                <div className="mt-4 rounded-xl border border-red-500/20 bg-red-950 px-4 py-3 text-sm text-red-300">
                  {stockError}
                </div>
              )}
              {checkoutError && (
                <div className="mt-4 rounded-xl border border-red-500/20 bg-red-950 px-4 py-3 text-sm text-red-300">
                  {checkoutError}
                </div>
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
