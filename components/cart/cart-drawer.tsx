"use client"

import { useEffect, useRef } from "react"
import { X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { CartItemRow } from "./cart-item"
import { CartSummary } from "./cart-summary"

type CartItem = {
  product?: any
  id?: number
  name?: string
  price?: number
  image?: string
  color?: string
  quantity: number
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
  const drawerRef = useRef<HTMLDivElement>(null)

  const subtotal = items.reduce((sum, item) => {
    const price = item.product?.price ?? item.price ?? 0
    return sum + price * item.quantity
  }, 0)

  const normalizedItems = items.map((item) => ({
    product: {
      id: item.product?.id ?? item.id ?? 0,
      price: item.product?.price ?? item.price ?? 0,
    },
    quantity: item.quantity,
  }))

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
    <div className="fixed inset-0 z-100">
      <button
        type="button"
        aria-label="Cerrar carrito"
        className="absolute inset-0 bg-black/80 backdrop-blur-sm"
        onClick={onClose}
      />

      <div
        ref={drawerRef}
        className={cn(
          "absolute right-0 top-0 h-full w-full max-w-md bg-[#111111] border-l border-white/10 shadow-xl flex flex-col",
          "animate-in slide-in-from-right duration-300"
        )}
      >
        <div className="flex items-center justify-between p-4 border-b border-white/10">
          <h2 className="text-18px font-semibold text-white tracking-wide">
            Tu carrito ({items.length})
          </h2>

          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="rounded-full hover:bg-white/10"
            onClick={onClose}
          >
            <X className="size-5" />
          </Button>
        </div>

        {items.length === 0 ? (
          <div className="flex-1 flex items-center justify-center text-white/60">
            Tu carrito está vacío
          </div>
        ) : (
          <>
            <div className="flex-1 overflow-y-auto p-4 space-y-4 custom-scrollbar">
              {items.map((item, index) => {
                const id = item.product?.id ?? item.id ?? index
                const color = item.color ?? "default"

                return (
                  <CartItemRow
                    key={`${id}-${color}-${index}`}
                    item={item}
                    onUpdateQuantity={onUpdateQuantity}
                    onRemove={onRemoveItem}
                  />
                )
              })}
            </div>

            <CartSummary
              subtotal={subtotal}
              items={normalizedItems}
              onCheckout={() => {}}
            />
          </>
        )}
      </div>
    </div>
  )
}