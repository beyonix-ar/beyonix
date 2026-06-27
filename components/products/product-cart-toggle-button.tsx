"use client"

import { MinusIcon, PlusIcon, ShoppingBag } from "lucide-react"

interface ProductCartToggleButtonProps {
  quantity: number
  onAdd: () => void
  onIncrease: () => void
  onDecrease: () => void
}

export function ProductCartToggleButton({
  quantity,
  onAdd,
  onIncrease,
  onDecrease,
}: ProductCartToggleButtonProps) {
  if (quantity === 0) {
    return (
      <button
        type="button"
        aria-label={"A\u00f1adir producto al carrito"}
        title={"A\u00f1adir producto al carrito"}
        onClick={onAdd}
        className="flex h-10 w-full cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-lg border border-white/12 bg-black/45 px-4 text-13px font-medium text-white/85 transition-all duration-150 hover:border-beyonix-blue-light/45 hover:bg-white/7 hover:text-white active:scale-95 sm:h-11 sm:px-5"
      >
        <ShoppingBag className="size-3.5 shrink-0" />
        A&ntilde;adir al carrito
      </button>
    )
  }

  return (
    <div className="flex h-10 w-full items-center gap-1.5 sm:h-11">
      <button
        type="button"
        aria-label="Disminuir cantidad"
        title="Disminuir cantidad"
        onClick={onDecrease}
        className="flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-white/12 bg-black/45 text-white/80 transition-colors hover:border-beyonix-blue-light/45 hover:bg-white/7 hover:text-white active:scale-95 sm:h-11 sm:w-11"
      >
        <MinusIcon className="size-3.5 stroke-2" />
      </button>

      <div className="flex h-10 flex-1 items-center justify-center rounded-lg border border-beyonix-blue-light/40 bg-beyonix-blue/35 px-3 text-13px font-medium tabular-nums text-white sm:h-11 sm:px-4">
        {quantity}
      </div>

      <button
        type="button"
        aria-label="Aumentar cantidad"
        title="Aumentar cantidad"
        onClick={onIncrease}
        className="flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-white/12 bg-black/45 text-white/80 transition-colors hover:border-beyonix-blue-light/45 hover:bg-white/7 hover:text-white active:scale-95 sm:h-11 sm:w-11"
      >
        <PlusIcon className="size-3.5 stroke-2" />
      </button>
    </div>
  )
}
