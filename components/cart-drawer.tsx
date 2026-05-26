"use client"

import {
  useEffect,
  useMemo,
  useRef,
} from "react"

import Image from "next/image"

import { useRouter } from "next/navigation"

import {
  Minus,
  Plus,
  Trash2,
  X,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"

import { cn } from "@/lib/utils"

import type { SupabaseProducto } from "@/lib/supabase/types"

import {
  FREE_SHIPPING_MIN,
  SHIPPING_COST,
} from "@/lib/store-config"

export interface CartItem {
  product: SupabaseProducto
  color: string
  image: string
  quantity: number
}

interface CartDrawerProps {
  isOpen: boolean

  items: CartItem[]

  onClose: () => void

  onUpdateQuantity: (
    productId: number,
    color: string,
    quantity: number
  ) => void

  onRemoveItem: (
    productId: number,
    color: string
  ) => void
}

const formatPrice = (
  price: number
) =>
  new Intl.NumberFormat(
    "es-AR",
    {
      style: "currency",
      currency: "ARS",
      minimumFractionDigits: 0,
    }
  ).format(price)

export function CartDrawer({
  isOpen,
  items,
  onClose,
  onUpdateQuantity,
  onRemoveItem,
}: CartDrawerProps) {
  const router = useRouter()

  const drawerRef =
    useRef<HTMLDivElement>(null)

  const subtotal = useMemo(() => {
    return items.reduce(
      (sum, item) =>
        sum +
        item.product.precio *
          item.quantity,
      0
    )
  }, [items])

  const shipping =
    subtotal >=
    FREE_SHIPPING_MIN
      ? 0
      : SHIPPING_COST

  const total =
    subtotal + shipping

  const freeShippingProgress =
    Math.min(
      (subtotal /
        FREE_SHIPPING_MIN) *
        100,
      100
    )

  const remainingForFreeShipping =
    Math.max(
      FREE_SHIPPING_MIN -
        subtotal,
      0
    )

  const handleCheckout = () => {
    localStorage.setItem(
      "beyonix-cart",
      JSON.stringify(items)
    )

    onClose()

    router.push("/checkout")
  }

  useEffect(() => {
    const handleEscape = (
      event: KeyboardEvent
    ) => {
      if (
        event.key ===
        "Escape"
      ) {
        onClose()
      }
    }

    if (isOpen) {
      document.body.style.overflow =
        "hidden"

      document.addEventListener(
        "keydown",
        handleEscape
      )
    }

    return () => {
      document.body.style.overflow =
        ""

      document.removeEventListener(
        "keydown",
        handleEscape
      )
    }
  }, [isOpen, onClose])

  if (!isOpen) {
    return null
  }

  return (
    <div className="fixed inset-0 z-50">
      <button
        type="button"
        aria-label="Cerrar carrito"
        title="Cerrar carrito"
        onClick={onClose}
        className="absolute inset-0 bg-background/80 backdrop-blur-sm"
      />

      <div
        ref={drawerRef}
        className={cn(
          "absolute right-0 top-0 flex h-full w-full flex-col border-l border-border bg-background shadow-xl sm:max-w-md",
          "animate-in slide-in-from-right duration-300"
        )}
      >
        <div className="flex items-center justify-between border-b border-border p-4">
          <h2 className="text-lg font-semibold text-foreground">
            Tu carrito (
            {items.length})
          </h2>

          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Cerrar carrito"
            title="Cerrar carrito"
            onClick={onClose}
            className="cursor-pointer"
          >
            <X className="size-5" />
          </Button>
        </div>

        {!items.length ? (
          <div className="flex flex-1 items-center justify-center">
            <p>
              Tu carrito está vacío
            </p>
          </div>
        ) : (
          <>
            <div className="flex-1 space-y-4 overflow-y-auto p-4">
              {items.map(
                (item, index) => (
                  <div
                    key={`${item.product.id}-${item.color}-${index}`}
                    className="flex gap-4"
                  >
                    <div className="relative size-20 shrink-0 overflow-hidden rounded-lg bg-muted">
                      <Image
                        src={
                          item.image ||
                          "/placeholder.svg"
                        }
                        alt={
                          item.product
                            .nombre
                        }
                        fill
                        className="object-cover"
                      />
                    </div>

                    <div className="flex flex-1 flex-col">
                      <h4 className="text-sm font-medium">
                        {
                          item
                            .product
                            .nombre
                        }
                      </h4>

                      <p className="text-sm text-muted-foreground">
                        {formatPrice(
                          item
                            .product
                            .precio
                        )}
                      </p>

                      <div className="mt-2 flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <Button
                            type="button"
                            size="icon"
                            variant="outline"
                            aria-label="Disminuir cantidad"
                            title="Disminuir cantidad"
                            disabled={
                              item.quantity <=
                              1
                            }
                            onClick={() =>
                              onUpdateQuantity(
                                item
                                  .product
                                  .id,
                                item.color,
                                item.quantity -
                                  1
                              )
                            }
                            className="h-9 w-9 cursor-pointer"
                          >
                            <Minus className="size-4" />
                          </Button>

                          <span>
                            {
                              item.quantity
                            }
                          </span>

                          <Button
                            type="button"
                            size="icon"
                            variant="outline"
                            aria-label="Aumentar cantidad"
                            title="Aumentar cantidad"
                            onClick={() =>
                              onUpdateQuantity(
                                item
                                  .product
                                  .id,
                                item.color,
                                item.quantity +
                                  1
                              )
                            }
                            className="h-9 w-9 cursor-pointer"
                          >
                            <Plus className="size-4" />
                          </Button>
                        </div>

                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          aria-label="Eliminar producto"
                          title="Eliminar producto"
                          onClick={() =>
                            onRemoveItem(
                              item
                                .product
                                .id,
                              item.color
                            )
                          }
                          className="cursor-pointer"
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    </div>
                  </div>
                )
              )}
            </div>

            <div className="space-y-3 border-t p-4">
              {shipping > 0 && (
                <div>
                  <div className="mb-2 flex items-center justify-between text-sm">
                    <span>
                      Te faltan
                    </span>

                    <span className="font-medium">
                      {formatPrice(
                        remainingForFreeShipping
                      )}
                    </span>
                  </div>

                  <div className="h-2 overflow-hidden rounded-full bg-white/10">
                    <div
                      style={{
                        width: `${freeShippingProgress}%`,
                      }}
                      className="h-full rounded-full bg-white transition-all duration-300"
                    />
                  </div>
                </div>
              )}

              <div className="flex justify-between">
                <span>
                  Subtotal
                </span>

                <span>
                  {formatPrice(
                    subtotal
                  )}
                </span>
              </div>

              <div className="flex justify-between">
                <span>
                  Envío
                </span>

                <span>
                  {shipping === 0
                    ? "Gratis"
                    : formatPrice(
                        shipping
                      )}
                </span>
              </div>

              <Separator />

              <div className="flex justify-between font-bold">
                <span>Total</span>

                <span>
                  {formatPrice(total)}
                </span>
              </div>

              <Button
                type="button"
                aria-label="Finalizar compra"
                title="Finalizar compra"
                onClick={
                  handleCheckout
                }
                className="h-12 w-full cursor-pointer text-base font-semibold"
              >
                Finalizar compra
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}