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
    <div className="relative flex gap-3 rounded-xl border border-white/10 bg-beyonix-surface-3 p-2 shadow-sm shadow-black/30">
      <div className="relative size-20 shrink-0 overflow-hidden rounded-md border border-white/10 bg-white p-1">
        <Image
          src={image || "/placeholder.svg"}
          alt={product.nombre}
          fill
          sizes="80px"
          className="object-cover"
        />
      </div>

      <div className="flex min-w-0 flex-1 flex-col justify-between py-0.5">
        <div className="pr-8">
          <h4 className="line-clamp-2 text-sm font-bold leading-snug text-white">
            {product.nombre}
          </h4>

          {colorName && (
            <div className="mt-1 flex items-center gap-1.5">
              {hasColor && (
                <span
                  style={{
                    backgroundColor: colorHex ?? undefined,
                  }}
                  className="size-3 rounded-full border border-white/20"
                />
              )}
              <span className="text-xs capitalize text-white/65">{colorName}</span>
            </div>
          )}
        </div>

        <div className="mt-1.5 flex items-center justify-between gap-2">
          <p className="shrink-0 text-sm font-semibold text-white/90">
            {formatPrice(price)}
          </p>

          <div className="flex min-w-0 items-center gap-1.5">
            <span className="text-11px font-medium text-white/60">Cant.</span>

            <div className="inline-flex h-7 items-center overflow-hidden rounded-full border border-beyonix-blue-light/60 bg-black">
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="h-full w-7 rounded-none border-0 border-r border-white/10 bg-transparent text-white enabled:cursor-pointer enabled:hover:bg-beyonix-blue/60 disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent"
                aria-label="Disminuir cantidad"
                title="Disminuir cantidad"
                onClick={() => onUpdateQuantity(product.id, color, quantity - 1)}
                disabled={quantity <= 1}
              >
                <Minus className="size-3" />
              </Button>

              <span className="flex h-full min-w-8 items-center justify-center px-1.5 text-xs font-bold text-white">
                {quantity}
              </span>

              <Button
                type="button"
                variant="outline"
                size="icon"
                className="h-full w-7 rounded-none border-0 border-l border-white/10 bg-transparent text-white hover:bg-beyonix-blue/60"
                aria-label="Aumentar cantidad"
                title="Aumentar cantidad"
                onClick={() => onUpdateQuantity(product.id, color, quantity + 1)}
              >
                <Plus className="size-3" />
              </Button>
            </div>
          </div>
        </div>
      </div>

      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="absolute right-2 top-2 size-8 cursor-pointer rounded-full border border-red-500/20 bg-red-950/20 text-red-400 transition-colors hover:border-red-400/50 hover:bg-red-500/20 hover:text-red-300"
        aria-label="Eliminar producto"
        title="Eliminar producto"
        onClick={() => onRemove(product.id, color)}
      >
        <Trash2 className="size-4" />
      </Button>
    </div>
  )
}
