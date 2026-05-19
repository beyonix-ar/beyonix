"use client"

import { useEffect, useRef } from "react"
import Image from "next/image"
import { useRouter } from "next/navigation"
import { Minus, Plus, Trash2, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"
import type { StoreProduct } from "@/lib/types/product"
import {
  FREE_SHIPPING_MIN,
  SHIPPING_COST,
  getProductDiscount,
} from "@/lib/store-config"

export interface CartItem {
  product: StoreProduct
  color: string
  quantity: number
}

function formatPrice(price: number): string {
  return new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    minimumFractionDigits: 0,
  }).format(price)
}

interface CartDrawerProps {
  isOpen: boolean
  onClose: () => void
  items: CartItem[]
  onUpdateQuantity: (
    productId: number,
    color: string,
    quantity: number
  ) => void
  onRemoveItem: (productId: number, color: string) => void
}

export function CartDrawer({
  isOpen,
  onClose,
  items,
  onUpdateQuantity,
  onRemoveItem,
}: CartDrawerProps) {
  const router = useRouter()
  const drawerRef = useRef<HTMLDivElement>(null)

  const subtotal = items.reduce((sum, item) => {
    const priceWithDiscount = Math.round(
      item.product.price *
        (1 - getProductDiscount(item.product.id))
    )
    return sum + priceWithDiscount * item.quantity
  }, 0)

  const shipping = subtotal >= FREE_SHIPPING_MIN ? 0 : SHIPPING_COST
  const total = subtotal + shipping

  const remainingForFreeShipping = Math.max(
    FREE_SHIPPING_MIN - subtotal,
    0
  )

  const freeShippingProgress = Math.min(
    (subtotal / FREE_SHIPPING_MIN) * 100,
    100
  )

  const handleCheckout = () => {
    localStorage.setItem("beyonix-cart", JSON.stringify(items))
    onClose()
    router.push("/checkout")
  }

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }

    if (isOpen) {
      document.addEventListener("keydown", handleEscape)
      document.body.style.overflow = "hidden"
    }

    return () => {
      document.removeEventListener("keydown", handleEscape)
      document.body.style.overflow = ""
    }
  }, [isOpen, onClose])

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50">
      <div
        className="absolute inset-0 bg-background/80 backdrop-blur-sm"
        onClick={onClose}
      />

      <div
        ref={drawerRef}
        className={cn(
          "absolute right-0 top-0 h-full w-full sm:max-w-md bg-background border-l border-border shadow-xl flex flex-col",
          "animate-in slide-in-from-right duration-300"
        )}
      >
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h2 className="text-lg font-semibold text-foreground">
            Tu carrito ({items.length})
          </h2>

          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onClose}
            className="cursor-pointer"
          >
            <X className="size-5" />
          </Button>
        </div>

        {items.length === 0 ? (
          <div className="flex-1 flex items-center justify-center">
            <p>Tu carrito está vacío</p>
          </div>
        ) : (
          <>
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {items.map((item, index) => (
                <div key={index} className="flex gap-4">
                  <div className="relative size-20 rounded-lg overflow-hidden bg-muted shrink-0">
                    <Image
                      src={
                        item.product.colors?.find(
                          (c) => c.name === item.color
                        )?.images?.[0] || "/placeholder.svg"
                      }
                      alt={item.product.name}
                      fill
                      className="object-cover"
                    />
                  </div>

                  <div className="flex-1">
                    <h4 className="text-sm font-medium">
                      {item.product.name}
                    </h4>

                    <p className="text-sm text-muted-foreground">
                      {formatPrice(item.product.price)}
                    </p>

                    <div className="flex items-center justify-between mt-2">
                      <div className="flex items-center gap-2">
                        <Button
                          type="button"
                          size="icon"
                          variant="outline"
                          onClick={() =>
                            onUpdateQuantity(
                              item.product.id,
                              item.color,
                              item.quantity - 1
                            )
                          }
                          disabled={item.quantity <= 1}
                          className="cursor-pointer h-9 w-9"
                        >
                          <Minus className="size-4" />
                        </Button>

                        <span>{item.quantity}</span>

                        <Button
                          type="button"
                          size="icon"
                          variant="outline"
                          onClick={() =>
                            onUpdateQuantity(
                              item.product.id,
                              item.color,
                              item.quantity + 1
                            )
                          }
                          className="cursor-pointer h-9 w-9"
                        >
                          <Plus className="size-4" />
                        </Button>
                      </div>

                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        onClick={() =>
                          onRemoveItem(
                            item.product.id,
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
              ))}
            </div>

            <div className="p-4 border-t space-y-3">
              <div className="flex justify-between">
                <span>Subtotal</span>
                <span>{formatPrice(subtotal)}</span>
              </div>

              <div className="flex justify-between">
                <span>Envío</span>
                <span>
                  {shipping === 0 ? "Gratis" : formatPrice(shipping)}
                </span>
              </div>

              <Separator />

              <div className="flex justify-between font-bold">
                <span>Total</span>
                <span>{formatPrice(total)}</span>
              </div>

              <Button
                onClick={handleCheckout}
                className="w-full h-12 text-base font-semibold cursor-pointer"
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