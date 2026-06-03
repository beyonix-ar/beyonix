"use client"

import {
  useEffect,
  useState,
} from "react"

import Image from "next/image"
import Link from "next/link"

import {
  useRouter,
} from "next/navigation"

import {
  ArrowLeft,
  ChevronDown,
  CircleUserRound,
  Smartphone,
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
  hasBlockedWords,
} from "@/lib/validation/content-filter"

import {
  cn,
} from "@/lib/utils"

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
]

const checkoutInputClassName =
  "border-beyonix-blue-light bg-beyonix-surface-3 text-foreground placeholder:text-muted-foreground focus-visible:border-beyonix-sky focus-visible:ring-beyonix-blue"

const initialCheckoutFormData = {
  nombre: "",
  email: "",
  telefono: "",
  direccion: "",
  cpDestino: "",
  localidad: "",
  provincia: "",
}

type ShippingType = "sucursal" | "domicilio"

interface ShippingOption {
  type: ShippingType
  label: string
  price: number
  provider: "andreani" | "manual"
}

function hasLetters(value: string) {
  return /[a-zA-ZáéíóúÁÉÍÓÚñÑ]/.test(value)
}

function isValidCheckoutForm(data: typeof initialCheckoutFormData) {
  const nombre = data.nombre.trim()
  const email = data.email.trim()
  const telefono = data.telefono.replace(/\D/g, "")
  const direccion = data.direccion.trim()
  const cpDestino = data.cpDestino.trim()
  const localidad = data.localidad.trim()
  const provincia = data.provincia.trim()

  return (
    nombre.length >= 3 &&
    hasLetters(nombre) &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) &&
    telefono.length >= 8 &&
    telefono.length <= 15 &&
    direccion.length >= 5 &&
    hasLetters(direccion) &&
    /\d/.test(direccion) &&
    /^\d{4,8}$/.test(cpDestino) &&
    localidad.length >= 2 &&
    hasLetters(localidad) &&
    provincia.length >= 2 &&
    hasLetters(provincia)
  )
}

export default function CheckoutPage() {
  const router = useRouter()
  const {
    user,
    isLoading,
    logout,
  } = useAuth()
  const {
    cart: items,
    cartSessionId,
    isReady: isCartReady,
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
  ] = useState<ShippingType>("domicilio")
  const [shippingOptions, setShippingOptions] =
    useState<ShippingOption[]>([])
  const [accountMenuOpen, setAccountMenuOpen] =
    useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  useEffect(() => {
    if (!mounted || isLoading || user) return

    router.replace("/login?redirect=/checkout")
  }, [isLoading, mounted, router, user])

  useEffect(() => {
    if (!user) return

    setFormData({
      nombre: user.name ?? "",
      email: user.email ?? "",
      telefono: user.phone ?? "",
      direccion: user.address ?? "",
      cpDestino: user.postalCode ?? "",
      localidad: "",
      provincia: user.province ?? "",
    })
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
    shippingOptions.find((option) => option.type === selectedShippingType) ??
    shippingOptions[0] ??
    null
  const shippingCostReal = selectedShippingOption?.price ?? manualShippingCost
  const freeShippingApplied = manualShippingCost === 0
  const shippingCostCharged = freeShippingApplied ? 0 : shippingCostReal
  const totals = calculateCartTotals(items, {
    shippingCost: shippingCostCharged,
  })

  useEffect(() => {
    const cpDestino = formData.cpDestino.trim()
    const provincia = formData.provincia.trim()
    const localidad = formData.localidad.trim()

    if (!cpDestino || !provincia || !localidad || items.length === 0) {
      setShippingOptions([
        {
          type: "domicilio",
          label: "Envío estándar",
          price: manualShippingCost,
          provider: "manual",
        },
      ])
      setShippingMessage(
        "Completá los datos de destino para ver las opciones de envío."
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
            provider: "manual",
          },
          {
            type: "domicilio",
            label: "Envío a domicilio Andreani",
            price: manualShippingCost,
            provider: "manual",
          },
        ])
        setShippingMessage(
          data.message ||
            "La cotización automática todavía no está disponible. Vas a poder continuar con el envío estándar."
        )
      })
      .catch(() => {
        if (cancelled) return

        setShippingOptions([
          {
            type: "domicilio",
            label: "Envío estándar",
            price: manualShippingCost,
            provider: "manual",
          },
        ])
        setShippingMessage(
          "No pudimos preparar la cotización automática. Vas a poder continuar con el envío estándar."
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

    setFormData((prev) => ({
      ...prev,
      [name]: value,
    }))
  }

  const isFormValid = Boolean(
    isValidCheckoutForm(formData) &&
      selectedShippingOption
  )

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
      const response = await fetch("/api/mercadopago/create-preference", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          reservationSessionId: cartSessionId,
          customer: formData,
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
      <main className="min-h-screen bg-background">
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
    )
  }

  return (
    <main className="min-h-screen bg-background">
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
              className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors"
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
              className="font-heading text-26px lg:text-28px font-bold tracking-tight text-foreground transition-colors hover:text-white/80"
            >
              BEYONIX
            </Link>

            <div className="relative flex min-w-20 justify-end">
              <button
                type="button"
                aria-label="Abrir menú de cuenta"
                title="Abrir menú de cuenta"
                aria-expanded={accountMenuOpen}
                onClick={() => setAccountMenuOpen((current) => !current)}
                className="flex cursor-pointer items-center gap-2 rounded-full border border-white/10 bg-black py-1.5 pl-1.5 pr-2 transition-colors hover:border-beyonix-blue-light/45 sm:pr-3"
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
                    className="block px-4 py-3 text-sm font-medium text-white/78 transition-colors hover:bg-beyonix-blue hover:text-white"
                  >
                    Mis datos
                  </Link>
                  <Link
                    href="/cuenta?tab=ordenes"
                    aria-label="Ir a Mis órdenes"
                    title="Ir a Mis órdenes"
                    className="block px-4 py-3 text-sm font-medium text-white/78 transition-colors hover:bg-beyonix-blue hover:text-white"
                  >
                    Mis órdenes
                  </Link>
                  <Link
                    href="/cuenta?tab=seguridad"
                    aria-label="Ir a Seguridad"
                    title="Ir a Seguridad"
                    className="block px-4 py-3 text-sm font-medium text-white/78 transition-colors hover:bg-beyonix-blue hover:text-white"
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

      <div className="container mx-auto px-4 lg:px-8 py-8 lg:py-12">
        <div className="max-w-6xl mx-auto">
          <h1 className="text-2xl lg:text-3xl font-bold text-foreground mb-8">
            Checkout
          </h1>

          <div className="grid lg:grid-cols-3 gap-8 lg:gap-12">
            <div className="lg:col-span-2 space-y-8">
              <section className="checkout-solid-card rounded-xl border border-beyonix-blue-light p-6">
                <h2 className="text-lg font-semibold text-foreground mb-6">
                  <span className="border-l-4 border-beyonix-blue pl-3">
                    Datos de contacto
                  </span>
                </h2>

                <form
                  id="checkout-form"
                  onSubmit={
                    handleSubmit
                  }
                  className="space-y-4"
                >
                  <div className="grid sm:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="nombre">
                        Nombre completo
                      </Label>

                      <Input
                        id="nombre"
                        name="nombre"
                        className={checkoutInputClassName}
                        value={
                          formData.nombre
                        }
                        onChange={
                          handleInputChange
                        }
                        required
                      />
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="email">
                        Email
                      </Label>

                      <Input
                        id="email"
                        name="email"
                        type="email"
                        className={checkoutInputClassName}
                        value={
                          formData.email
                        }
                        onChange={
                          handleInputChange
                        }
                        required
                      />
                    </div>
                  </div>

                  <div className="grid sm:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="telefono">
                        Teléfono
                      </Label>

                      <Input
                        id="telefono"
                        name="telefono"
                        type="tel"
                        className={checkoutInputClassName}
                        value={
                          formData.telefono
                        }
                        onChange={
                          handleInputChange
                        }
                        required
                      />
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="direccion">
                        Dirección
                      </Label>

                      <Input
                        id="direccion"
                        name="direccion"
                        className={checkoutInputClassName}
                        value={
                          formData.direccion
                        }
                        onChange={
                          handleInputChange
                        }
                        required
                      />
                    </div>
                  </div>

                  <div className="grid sm:grid-cols-3 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="provincia">
                        Provincia
                      </Label>

                      <Input
                        id="provincia"
                        name="provincia"
                        className={checkoutInputClassName}
                        value={formData.provincia}
                        onChange={handleInputChange}
                        required
                      />
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="localidad">
                        Localidad
                      </Label>

                      <Input
                        id="localidad"
                        name="localidad"
                        className={checkoutInputClassName}
                        value={formData.localidad}
                        onChange={handleInputChange}
                        required
                      />
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="cpDestino">
                        Código postal
                      </Label>

                      <Input
                        id="cpDestino"
                        name="cpDestino"
                        inputMode="numeric"
                        className={checkoutInputClassName}
                        value={formData.cpDestino}
                        onChange={handleInputChange}
                        required
                      />
                    </div>
                  </div>
                </form>
              </section>

              <section className="checkout-solid-card rounded-xl border border-beyonix-blue-light p-6">
                <h2 className="text-lg font-semibold text-foreground mb-6">
                  <span className="border-l-4 border-beyonix-blue pl-3">
                    Método de envío
                  </span>
                </h2>

                <div className="space-y-3">
                  {shippingOptions.map((option) => {
                    const selected = selectedShippingType === option.type
                    const displayPrice =
                      freeShippingApplied ? "GRATIS" : formatPrice(option.price)

                    return (
                      <button
                        key={option.type}
                        type="button"
                        aria-label={`Seleccionar ${option.label}`}
                        title={`Seleccionar ${option.label}`}
                        onClick={() => setSelectedShippingType(option.type)}
                        className={cn(
                          "checkout-solid-card flex w-full cursor-pointer items-center justify-between gap-4 rounded-lg border p-4 text-left transition-all",
                          selected
                            ? "border-beyonix-sky bg-beyonix-blue"
                            : "border-beyonix-blue-light hover:border-beyonix-sky"
                        )}
                      >
                        <div>
                          <p className="font-medium text-foreground">
                            {option.label}
                          </p>
                          <p className="mt-1 text-sm text-muted-foreground">
                            {option.provider === "andreani"
                              ? "Cotización Andreani"
                              : "Disponible para continuar la compra"}
                          </p>
                        </div>

                        <span
                          className={
                            freeShippingApplied
                              ? "font-semibold text-emerald-400"
                              : "font-semibold text-foreground"
                          }
                        >
                          {displayPrice}
                        </span>
                      </button>
                    )
                  })}
                </div>

                {shippingMessage && (
                  <div className="checkout-solid-card mt-4 rounded-xl border border-beyonix-blue-light px-4 py-3 text-sm text-beyonix-sky">
                    {shippingMessage}
                  </div>
                )}
              </section>

              <section className="checkout-solid-card rounded-xl border border-beyonix-blue-light p-6">
                <h2 className="text-lg font-semibold text-foreground mb-6">
                  <span className="border-l-4 border-beyonix-blue pl-3">
                    Método de pago
                  </span>
                </h2>

                <div className="space-y-3">
                  {paymentMethods.map(
                    (method) => (
                      <button
                        key={
                          method.id
                        }
                        type="button"
                        aria-label={`Seleccionar ${method.name}`}
                        title={`Seleccionar ${method.name}`}
                        onClick={() =>
                          setSelectedPayment(
                            method.id
                          )
                        }
                        className={cn(
                          "checkout-solid-card w-full flex cursor-pointer items-center gap-4 rounded-lg border p-4 text-left transition-all",

                          selectedPayment ===
                            method.id
                            ? "border-beyonix-sky bg-beyonix-blue"
                            : "border-beyonix-blue-light hover:border-beyonix-sky"
                        )}
                      >
                        <div
                          className={cn(
                            "size-12 rounded-lg flex items-center justify-center",

                            selectedPayment ===
                              method.id
                              ? "bg-beyonix-blue-hover text-primary-foreground"
                              : "bg-neutral-950"
                          )}
                        >
                          <method.icon className="size-6" />
                        </div>

                        <div className="flex-1">
                          <p className="font-medium text-foreground">
                            {
                              method.name
                            }
                          </p>

                          <p className="text-sm text-muted-foreground">
                            {
                              method.description
                            }
                          </p>
                        </div>
                      </button>
                    )
                  )}
                </div>
              </section>
            </div>

            <div className="lg:col-span-1">
              <div className="checkout-solid-card sticky top-24 rounded-xl border border-beyonix-blue-light p-6">
                <h2 className="text-lg font-semibold text-foreground mb-6">
                  <span className="border-l-4 border-beyonix-blue pl-3">
                    Resumen del pedido
                  </span>
                </h2>

                <div className="space-y-4 mb-6">
                  {items.map(
                    (item) => (
                      <div
                        key={`${item.product.id}-${item.variantId ?? item.color}`}
                        className="checkout-solid-card flex gap-3 rounded-xl border border-beyonix-blue-light p-3"
                      >
                        <div className="relative size-16 shrink-0 overflow-hidden rounded-lg bg-neutral-950">
                          <Image
                            fill
                            src={
                              item.image
                            }
                            alt={
                              item.product.nombre
                                ? `${item.product.nombre} en carrito`
                                : "Producto en carrito"
                            }
                            className="object-cover"
                          />
                        </div>

                        <div className="flex-1 min-w-0">
                          <p className="text-xs text-muted-foreground">
                            Producto:
                          </p>

                          <p className="text-sm font-semibold text-foreground line-clamp-2">
                            {
                              item.product
                                .nombre
                            }
                          </p>

                          <p className="mt-1 text-sm text-foreground">
                            Precio:{" "}
                            <span className="font-semibold">
                              {formatPrice(
                                item.product
                                  .precio
                              )}
                            </span>
                          </p>

                          <p className="text-sm text-muted-foreground">
                            Unidades:{" "}
                            <span className="font-semibold text-foreground">
                              x{item.quantity}{" "}
                              {item.quantity === 1
                                ? "unidad"
                                : "unidades"}
                            </span>
                          </p>
                        </div>
                      </div>
                    )
                  )}
                </div>

                <Separator className="mb-4" />

                <div className="space-y-2 mb-6">
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">
                      Subtotal
                    </span>

                    <span className="text-foreground">
                      {formatPrice(
                        totals.subtotal
                      )}
                    </span>
                  </div>

                  {totals.discount > 0 && (
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">
                        Descuento
                      </span>

                      <span className="font-semibold text-emerald-400">
                        -{formatPrice(totals.discount)}
                      </span>
                    </div>
                  )}

                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">
                      Envío
                    </span>

                    <span
                      className={
                        totals.shipping === 0
                          ? "font-semibold text-emerald-400"
                          : "text-foreground"
                      }
                    >
                      {totals.shipping ===
                      0
                        ? "GRATIS"
                        : formatPrice(
                            totals.shipping
                          )}
                    </span>
                  </div>

                  <Separator />

                  <div className="flex justify-between pt-2">
                    <span className="font-semibold text-foreground">
                      Total
                    </span>

                    <span className="font-bold text-foreground text-xl">
                      {formatPrice(
                        totals.total
                      )}
                    </span>
                  </div>
                </div>

                {stockError && (
                  <div className="mb-4 rounded-xl border border-red-500/20 bg-red-950 px-4 py-3 text-sm text-red-300">
                    {stockError}
                  </div>
                )}

                {checkoutError && (
                  <div className="mb-4 rounded-xl border border-red-500/20 bg-red-950 px-4 py-3 text-sm text-red-300">
                    {checkoutError}
                  </div>
                )}

                <Button
                  type="submit"
                  aria-label="Pagar ahora"
                  title="Pagar ahora"
                  form="checkout-form"
                  className={cn(
                    "w-full",
                    isFormValid && !isProcessing && !stockError
                      ? "bg-beyonix-blue text-white hover:bg-beyonix-blue-hover"
                      : "cursor-not-allowed bg-neutral-700 text-white/55 hover:bg-neutral-700"
                  )}
                  size="lg"
                  disabled={
                    !isFormValid ||
                    isProcessing ||
                    Boolean(stockError)
                  }
                >
                  {isProcessing
                    ? "Procesando..."
                    : "Pagar ahora"}
                </Button>

                <p className="text-xs text-muted-foreground text-center mt-4">
                  Al completar tu
                  compra aceptás
                  nuestros{" "}
                  <Link
                    href="/terminos"
                    className="font-medium text-foreground underline underline-offset-4 transition-colors hover:text-white"
                  >
                    términos y condiciones
                  </Link>
                  .
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </main>
  )
}
