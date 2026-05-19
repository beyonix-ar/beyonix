"use client"

import Image from "next/image"
import { Minus, Plus, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { ProductItem } from "@/components/products/product-details"
import { productColors } from "@/lib/product-colors"

type CartItem = {
  product?: ProductItem
  id?: number
  name?: string
  price?: number
  image?: string
  color?: string
  quantity: number
}

interface Props {
  item: CartItem
  onUpdateQuantity: (
    productId: number,
    color: string,
    quantity: number
  ) => void
  onRemove: (productId: number, color: string) => void
}

export function CartItemRow({
  item,
  onUpdateQuantity,
  onRemove,
}: Props) {
  const productId = item.product?.id ?? item.id
  const name = item.product?.name ?? item.name ?? "Producto"
  const price = item.product?.price ?? item.price ?? 0

  // 🔥 COLOR VALUE (solo UI)
  const colorValue =
    item.product?.colors?.find((c) => c.name === item.color)?.value ||
    item.color ||
    "default"

  // 🔥 imagen segura
  const image =
    item.image ??
    item.product?.colors?.find((c) => c.value === colorValue)?.images?.[0] ??
    "/placeholder.png"

  // 🔥 nombre lindo del color
  const colorName =
    item.product?.colors?.find((c) => c.value === colorValue)?.name ||
    item.color ||
    "Color"

  // 🔥 COLOR REAL (lógica carrito)
  const cartColor = item.color ?? "default"

  if (!productId) return null

  return (
    <div className="flex gap-4">
      {/* Imagen */}
      <div className="relative size-20 rounded-lg overflow-hidden bg-white shrink-0 p-2">
        <Image
          src={image}
          alt={name}
          fill
          className="object-cover"
        />
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <h4 className="text-sm font-medium line-clamp-2">
          {name}
        </h4>

        <p className="text-sm text-white/80 mt-1">
          ${price}
        </p>

        {/* COLOR */}
        <div className="flex items-center gap-2 mt-1">
          <span
            className={`size-3 rounded-full border border-white/20 ${
              productColors[
                colorValue as keyof typeof productColors
              ] || "bg-white"
            }`}
          />
          <span className="text-xs text-white/60">
            {colorName}
          </span>
        </div>

        <div className="flex items-center justify-between mt-2">
          {/* Cantidad */}
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="size-8"
              aria-label="Disminuir cantidad"
              onClick={() =>
                onUpdateQuantity(
                  productId,
                  cartColor,
                  item.quantity - 1
                )
              }
              disabled={item.quantity <= 1}
            >
              <Minus className="size-3" />
            </Button>

            <span className="text-sm font-medium w-6 text-center">
              {item.quantity}
            </span>

            <Button
              type="button"
              variant="outline"
              size="icon"
              className="size-8"
              aria-label="Aumentar cantidad"
              onClick={() =>
                onUpdateQuantity(
                  productId,
                  cartColor,
                  item.quantity + 1
                )
              }
            >
              <Plus className="size-3" />
            </Button>
          </div>

          {/* Eliminar */}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8 text-muted-foreground hover:text-destructive"
            aria-label="Eliminar producto"
            onClick={() =>
              onRemove(productId, cartColor)
            }
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  )
}