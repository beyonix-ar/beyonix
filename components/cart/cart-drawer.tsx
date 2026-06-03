"use client"

import {
  useEffect,
  useRef,
} from "react"

import { useRouter } from "next/navigation"

import { X } from "lucide-react"

import { Button } from "@/components/ui/button"

import { cn } from "@/lib/utils"

import { CartItemRow } from "./cart-item"

import { CartSummary } from "./cart-summary"

import type {
  CartItem,
} from "@/context/cart-context"

interface CartDrawerProps {
  isOpen: boolean

  onClose: () => void

  items: CartItem[]

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

export function CartDrawer({
  isOpen,
  onClose,
  items,
  onUpdateQuantity,
  onRemoveItem,
}: CartDrawerProps) {
  const router = useRouter()

  const drawerRef =
    useRef<HTMLDivElement>(null)

  // ─────────────────────────────────────
  // Subtotal
  // ─────────────────────────────────────

  const subtotal = items.reduce(
    (sum, item) => {
      return (
        sum +
        item.product.precio *
          item.quantity
      )
    },
    0
  )

  // ─────────────────────────────────────
  // ESC close
  // ─────────────────────────────────────

  useEffect(() => {
    const handleEscape = (
      e: KeyboardEvent
    ) => {
      if (e.key === "Escape") {
        onClose()
      }
    }

    if (isOpen) {
      document.addEventListener(
        "keydown",
        handleEscape
      )

      document.body.style.overflow =
        "hidden"
    }

    return () => {
      document.removeEventListener(
        "keydown",
        handleEscape
      )

      document.body.style.overflow =
        ""
    }
  }, [isOpen, onClose])

  if (!isOpen) {
    return null
  }

  return (
    <div className="fixed inset-0 z-100">
      {/* Overlay */}
      <button
        type="button"
        aria-label="Cerrar carrito"
        title="Cerrar carrito"
        className="absolute inset-0 bg-black/80 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Drawer */}
      <div
        ref={drawerRef}
        className={cn(
          "absolute right-0 top-0 z-10 flex h-full w-full max-w-md flex-col border-l border-beyonix-blue-light bg-beyonix-surface shadow-xl shadow-beyonix-blue",
          "animate-in slide-in-from-right duration-300"
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/10 bg-black p-4">
          <h2 className="text-18px font-semibold tracking-wide text-white">
            Tu carrito ({items.length})
          </h2>

          <Button
            type="button"
            aria-label="Cerrar carrito"
            title="Cerrar carrito"
            variant="ghost"
            size="icon"
            className="rounded-full bg-black text-white hover:bg-neutral-900"
            onClick={onClose}
          >
            <X className="size-5" />
          </Button>
        </div>

        {/* Empty */}
        {items.length === 0 ? (
          <div className="flex flex-1 items-center justify-center text-white/70">
            Tu carrito está vacío
          </div>
        ) : (
          <>
            {/* Items */}
            <div className="custom-scrollbar flex-1 space-y-4 overflow-y-auto p-4">
              {items.map(
                (item, index) => (
                  <CartItemRow
                    key={`${item.product.id}-${item.color}-${index}`}
                    item={item}
                    onUpdateQuantity={
                      onUpdateQuantity
                    }
                    onRemove={
                      onRemoveItem
                    }
                  />
                )
              )}
            </div>

            {/* Summary */}
            <CartSummary
              subtotal={subtotal}
              items={items.map(
                (item) => ({
                  product: {
                    id: item.product.id,
                    precio:
                      item.product
                        .precio,
                  },

                  quantity:
                    item.quantity,
                })
              )}
              onCheckout={() => {
                onClose()

                router.push("/checkout")
              }}
              onContinueShopping={onClose}
            />
          </>
        )}
      </div>
    </div>
  )
}
