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
    <div className="flex gap-4 rounded-xl border border-white/6 bg-white/2 p-3">
      <div className="relative size-20 shrink-0 overflow-hidden rounded-lg bg-white p-2">
        <Image
          src={image || "/placeholder.svg"}
          alt={product.nombre}
          fill
          className="object-cover"
        />
      </div>

      <div className="min-w-0 flex-1">
        <div className="grid grid-cols-product-cart gap-x-3 gap-y-1 text-sm">
          <span className="text-white/55">Producto:</span>
          <h4 className="line-clamp-2 font-semibold text-white">
            {product.nombre}
          </h4>

          <span className="text-white/55">Precio:</span>
          <p className="font-semibold text-white/90">{formatPrice(price)}</p>

          <span className="text-white/55">Unidades:</span>
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

        <div className="mt-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="size-8"
              aria-label="Disminuir cantidad"
              title="Disminuir cantidad"
              onClick={() => onUpdateQuantity(product.id, color, quantity - 1)}
              disabled={quantity <= 1}
            >
              <Minus className="size-3" />
            </Button>

            <span className="w-6 text-center text-sm font-medium text-white">
              {quantity}
            </span>

            <Button
              type="button"
              variant="outline"
              size="icon"
              className="size-8"
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
            className="size-8 text-muted-foreground hover:text-destructive"
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
