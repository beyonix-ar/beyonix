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
export default function CheckoutPage() {
  const router = useRouter()
  const {
    user,
    isLoading,
  } = useAuth()
  const {
    cart: items,
    cartSessionId,
    clearCart,
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
    useState({
      nombre: "",
      email: "",
      telefono: "",
      direccion: "",
    })

  const [stockError, setStockError] =
    useState("")
  const [checkoutError, setCheckoutError] =
    useState("")

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

  const totals = calculateCartTotals(items)

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

      clearCart()
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
      <header className="border-b border-border bg-background/80 backdrop-blur-md sticky top-0 z-50">
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

            <div className="flex min-w-20 justify-end">
              <div className="flex items-center gap-2 rounded-full border border-white/10 bg-white/3 py-1.5 pl-1.5 pr-2 sm:pr-3">
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
              </div>
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
                        aria-label={`Seleccionar ${method.name}`}
                        title={`Seleccionar ${method.name}`}
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
                      </button>
                    )
                  )}
                </div>
              </section>
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
                        key={`${item.product.id}-${item.variantId ?? item.color}`}
                        className="flex gap-3 rounded-xl border border-white/6 bg-white/2 p-3"
                      >
                        <div className="relative size-16 rounded-lg overflow-hidden bg-muted shrink-0">
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
                  <div className="mb-4 rounded-xl border border-red-500/20 bg-red-500/8 px-4 py-3 text-sm text-red-300">
                    {stockError}
                  </div>
                )}

                {checkoutError && (
                  <div className="mb-4 rounded-xl border border-red-500/20 bg-red-500/8 px-4 py-3 text-sm text-red-300">
                    {checkoutError}
                  </div>
                )}

                <Button
                  type="submit"
                  aria-label="Pagar ahora"
                  title="Pagar ahora"
                  form="checkout-form"
                  className="w-full"
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
