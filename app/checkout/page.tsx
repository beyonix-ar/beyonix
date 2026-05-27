"use client"

import {
  useEffect,
  useState,
} from "react"

import Image from "next/image"

import {
  useRouter,
} from "next/navigation"

import {
  ArrowLeft,
  Building2,
  CheckCircle2,
  CreditCard,
  Shield,
  Smartphone,
  Truck,
} from "lucide-react"

import {
  Button,
} from "@/components/ui/button"

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
  createOrder,
} from "@/lib/orders/create-order"

import {
  FREE_SHIPPING_MIN,
  getProductDiscount,
  SHIPPING_COST,
  TRANSFER_DISCOUNT,
  TRANSFER_DISCOUNT_LABEL,
} from "@/lib/store-config"

import {
  cn,
} from "@/lib/utils"

interface CartItem {
  id: number
  name: string
  price: number
  image: string
  quantity: number
}

function formatPrice(
  price: number
): string {
  return new Intl.NumberFormat(
    "es-AR",
    {
      style: "currency",
      currency: "ARS",
      minimumFractionDigits: 0,
    }
  ).format(price)
}

const paymentMethods = [
  {
    id: "mercadopago",
    name: "Mercado Pago",
    description:
      "Pagá con tu cuenta o tarjeta",
    icon: Smartphone,
  },

  {
    id: "transfer",

    name: "Transferencia Bancaria",

    description: `CBU/Alias - ${TRANSFER_DISCOUNT_LABEL} de descuento`,

    icon: Building2,
  },

  {
    id: "card",

    name: "Tarjeta de Crédito/Débito",

    description:
      "Visa, Mastercard, AMEX",

    icon: CreditCard,
  },
]

export default function CheckoutPage() {
  const router = useRouter()

  const [mounted, setMounted] =
    useState(false)

  const [items, setItems] =
    useState<CartItem[]>([])

  const [
    selectedPayment,
    setSelectedPayment,
  ] = useState("mercadopago")

  const [
    isProcessing,
    setIsProcessing,
  ] = useState(false)

  const [formData, setFormData] =
    useState({
      nombre: "",
      email: "",
      telefono: "",
      direccion: "",
    })

  useEffect(() => {
    setMounted(true)

    const savedCart =
      localStorage.getItem(
        "beyonix-cart"
      )

    if (!savedCart) return

    try {
      setItems(
        JSON.parse(savedCart)
      )
    } catch {
      setItems([])
    }
  }, [])

  const subtotal = items.reduce(
    (sum, item) =>
      sum +
      Math.round(
        item.price *
          (1 -
            getProductDiscount(
              item.id
            ))
      ) *
        item.quantity,
    0
  )

  const discount =
    selectedPayment ===
    "transfer"
      ? Math.round(
          subtotal *
            TRANSFER_DISCOUNT
        )
      : 0

  const discountedSubtotal =
    subtotal - discount

  const shipping =
    discountedSubtotal >=
    FREE_SHIPPING_MIN
      ? 0
      : SHIPPING_COST

  const total =
    discountedSubtotal + shipping

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

  const isFormValid =
    formData.nombre &&
    formData.email &&
    formData.telefono &&
    formData.direccion

  const handleSubmit = async (
    e: React.FormEvent
  ) => {
    e.preventDefault()

    if (!isFormValid) return

    setIsProcessing(true)

    try {
      const result =
        await createOrder({
          items: items.map(
            (item) => ({
              productId: item.id,

              quantity:
                item.quantity,

              price: item.price,
            })
          ),
        })

      if (!result.success) {
        throw new Error(
          "No se pudo crear la orden"
        )
      }

      localStorage.setItem(
        "beyonix-last-order",
        JSON.stringify({
          name: formData.nombre,

          province:
            formData.direccion,

          approved: true,

          canReview: true,
        })
      )

      localStorage.removeItem(
        "beyonix-cart"
      )

      router.push(
        `/checkout/success?order=${result.orderId}`
      )
    } catch (error) {
      console.error(error)

      alert(
        error instanceof Error
          ? error.message
          : "Error al crear la orden"
      )
    } finally {
      setIsProcessing(false)
    }
  }

  if (!mounted) {
    return null
  }

  if (items.length === 0) {
    return (
      <main className="min-h-screen bg-background">
        <div className="container mx-auto px-4 py-16 lg:py-24">
          <div className="max-w-md mx-auto text-center">
            <div className="size-20 rounded-full bg-secondary flex items-center justify-center mx-auto mb-6">
              <svg
                className="size-10 text-muted-foreground"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  d="M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z"
                  stroke="currentColor"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                />
              </svg>
            </div>

            <h1 className="text-2xl font-bold text-foreground mb-4">
              Tu carrito está vacío
            </h1>

            <p className="text-muted-foreground mb-8">
              Agregá productos a tu
              carrito antes de
              continuar con el
              checkout.
            </p>

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
      <header className="border-b border-border bg-background/80 backdrop-blur-md sticky top-0 z-50">
        <div className="container mx-auto px-4 lg:px-8">
          <div className="flex items-center justify-between h-16 lg:h-20">
            <button
              type="button"
              aria-label="Volver"
              title="Volver"
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

            <span className="text-xl lg:text-2xl font-bold tracking-tight text-foreground">
              BEYONIX
            </span>

            <div className="w-20" />
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
              <section className="bg-card rounded-xl border border-border p-6">
                <h2 className="text-lg font-semibold text-foreground mb-6">
                  Datos de contacto
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
                        placeholder="Juan Pérez"
                        value={
                          formData.nombre
                        }
                        onChange={
                          handleInputChange
                        }
                        required
                        className="bg-secondary border-border"
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
                        placeholder="juan@email.com"
                        value={
                          formData.email
                        }
                        onChange={
                          handleInputChange
                        }
                        required
                        className="bg-secondary border-border"
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
                        placeholder="+54 11 1234-5678"
                        value={
                          formData.telefono
                        }
                        onChange={
                          handleInputChange
                        }
                        required
                        className="bg-secondary border-border"
                      />
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="direccion">
                        Dirección de
                        envío
                      </Label>

                      <Input
                        id="direccion"
                        name="direccion"
                        placeholder="Av. Corrientes 1234, CABA"
                        value={
                          formData.direccion
                        }
                        onChange={
                          handleInputChange
                        }
                        required
                        className="bg-secondary border-border"
                      />
                    </div>
                  </div>
                </form>
              </section>

              <section className="bg-card rounded-xl border border-border p-6">
                <h2 className="text-lg font-semibold text-foreground mb-6">
                  Método de pago
                </h2>

                <div className="space-y-3">
                  {paymentMethods.map(
                    (method) => (
                      <button
                        key={
                          method.id
                        }
                        type="button"
                        aria-label={
                          method.name
                        }
                        title={
                          method.name
                        }
                        onClick={() =>
                          setSelectedPayment(
                            method.id
                          )
                        }
                        className={cn(
                          "w-full flex items-center gap-4 p-4 rounded-lg border transition-all text-left",

                          selectedPayment ===
                            method.id
                            ? "border-primary bg-primary/5"
                            : "border-border hover:border-muted-foreground/50"
                        )}
                      >
                        <div
                          className={cn(
                            "size-12 rounded-lg flex items-center justify-center",

                            selectedPayment ===
                              method.id
                              ? "bg-primary text-primary-foreground"
                              : "bg-secondary"
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

                        <div
                          className={cn(
                            "size-5 rounded-full border-2 transition-colors",

                            selectedPayment ===
                              method.id
                              ? "border-primary bg-primary"
                              : "border-muted-foreground/30"
                          )}
                        >
                          {selectedPayment ===
                            method.id && (
                            <CheckCircle2 className="size-full text-primary-foreground" />
                          )}
                        </div>
                      </button>
                    )
                  )}
                </div>
              </section>

              <div className="flex flex-wrap items-center justify-center gap-6 py-4">
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Shield className="size-5" />

                  <span className="text-sm">
                    Compra 100%
                    segura
                  </span>
                </div>

                <div className="flex items-center gap-2 text-muted-foreground">
                  <Truck className="size-5" />

                  <span className="text-sm">
                    Envío a todo el
                    país
                  </span>
                </div>
              </div>
            </div>

            <div className="lg:col-span-1">
              <div className="bg-card rounded-xl border border-border p-6 sticky top-24">
                <h2 className="text-lg font-semibold text-foreground mb-6">
                  Resumen del pedido
                </h2>

                <div className="space-y-4 mb-6">
                  {items.map(
                    (item) => (
                      <div
                        key={item.id}
                        className="flex gap-3"
                      >
                        <div className="relative size-16 rounded-lg overflow-hidden bg-muted shrink-0">
                          <Image
                            fill
                            src={
                              item.image
                            }
                            alt={
                              item.name
                            }
                            className="object-cover"
                          />

                          <span className="absolute -top-1 -right-1 size-5 rounded-full bg-primary text-primary-foreground text-xs flex items-center justify-center font-medium">
                            {
                              item.quantity
                            }
                          </span>
                        </div>

                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-foreground line-clamp-2">
                            {
                              item.name
                            }
                          </p>

                          <p className="text-sm text-muted-foreground">
                            {formatPrice(
                              item.price
                            )}
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
                        subtotal
                      )}
                    </span>
                  </div>

                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">
                      Envío
                    </span>

                    <span className="text-foreground">
                      {shipping ===
                      0
                        ? "Gratis"
                        : formatPrice(
                            shipping
                          )}
                    </span>
                  </div>

                  {discount >
                    0 && (
                    <div className="flex justify-between text-sm text-green-500">
                      <span>
                        Descuento
                        transferencia (
                        {
                          TRANSFER_DISCOUNT_LABEL
                        }
                        )
                      </span>

                      <span>
                        -
                        {formatPrice(
                          discount
                        )}
                      </span>
                    </div>
                  )}

                  <Separator />

                  <div className="flex justify-between pt-2">
                    <span className="font-semibold text-foreground">
                      Total
                    </span>

                    <span className="font-bold text-foreground text-xl">
                      {formatPrice(
                        total
                      )}
                    </span>
                  </div>
                </div>

                <Button
                  type="submit"
                  aria-label="Pagar ahora"
                  title="Pagar ahora"
                  form="checkout-form"
                  className="w-full"
                  size="lg"
                  disabled={
                    !isFormValid ||
                    isProcessing
                  }
                >
                  {isProcessing ? (
                    <span className="flex items-center gap-2">
                      <svg
                        className="animate-spin size-4"
                        viewBox="0 0 24 24"
                      >
                        <circle
                          cx="12"
                          cy="12"
                          r="10"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="4"
                          className="opacity-25"
                        />

                        <path
                          fill="currentColor"
                          className="opacity-75"
                          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                        />
                      </svg>

                      Procesando...
                    </span>
                  ) : (
                    "Pagar ahora"
                  )}
                </Button>

                <p className="text-xs text-muted-foreground text-center mt-4">
                  Al completar tu
                  compra aceptás
                  nuestros términos y
                  condiciones.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </main>
  )
}