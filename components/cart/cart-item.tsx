import Image from "next/image"
import { Minus, Plus, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { CartItem } from "@/context/cart-context"

interface Props {
  item: CartItem
  onUpdateQuantity: (productId: number, color: string, quantity: number) => void
  onRemove: (productId: number, color: string) => void
}

const formatPrice = (price: number) =>
  new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    minimumFractionDigits: 0,
  }).format(price)

export function CartItemRow({ item, onUpdateQuantity, onRemove }: Props) {
  const { product, color, image, quantity, variantName, colorHex } = item
  const price = product.precio
  const colorName = variantName || (color !== "default" ? color : null)
  const hasColor = Boolean(colorHex)

  return (
    <div className="flex gap-3 rounded-lg border border-white/10 bg-beyonix-surface-3 p-2">
      <div className="relative size-16 shrink-0 overflow-hidden rounded-md border border-white/10 bg-white p-1">
        <Image
          src={image || "/placeholder.svg"}
          alt={product.nombre}
          fill
          className="object-cover"
        />
      </div>

      <div className="min-w-0 flex-1">
        <div className="grid grid-cols-product-cart gap-x-2 gap-y-0.5 text-xs">
          <span className="text-white/60">Producto:</span>
          <h4 className="line-clamp-2 font-semibold text-white">
            {product.nombre}
          </h4>

          <span className="text-white/60">Precio:</span>
          <p className="font-semibold text-white/90">{formatPrice(price)}</p>

          <span className="text-white/60">Unidades:</span>
          <p className="font-semibold text-white">x{quantity}</p>
        </div>

        {colorName && (
          <div className="mt-1 flex items-center gap-2">
            {hasColor && (
              <span
                style={{
                  backgroundColor: colorHex ?? undefined,
                }}
                className="size-3 rounded-full border border-white/20"
              />
            )}
            <span className="text-xs capitalize text-white/70">{colorName}</span>
          </div>
        )}

        <div className="mt-2 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="size-6 border-white/15 bg-black text-white hover:bg-neutral-900"
              aria-label="Disminuir cantidad"
              title="Disminuir cantidad"
              onClick={() => onUpdateQuantity(product.id, color, quantity - 1)}
              disabled={quantity <= 1}
            >
              <Minus className="size-3" />
            </Button>

            <span className="flex size-6 items-center justify-center text-xs font-medium text-white">
              {quantity}
            </span>

            <Button
              type="button"
              variant="outline"
              size="icon"
              className="size-6 border-white/15 bg-black text-white hover:bg-neutral-900"
              aria-label="Aumentar cantidad"
              title="Aumentar cantidad"
              onClick={() => onUpdateQuantity(product.id, color, quantity + 1)}
            >
              <Plus className="size-3" />
            </Button>
          </div>

          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7 bg-black text-red-500 hover:bg-black hover:text-red-400"
            aria-label="Eliminar producto"
            title="Eliminar producto"
            onClick={() => onRemove(product.id, color)}
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  )
}
