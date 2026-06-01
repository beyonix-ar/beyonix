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
        className="flex h-9 w-full cursor-pointer items-center justify-center gap-2 rounded-lg bg-white text-13px font-semibold text-black transition-all duration-150 hover:bg-white/90 active:scale-95"
      >
        <ShoppingBag className="size-3.5" />
        A&ntilde;adir al carrito
      </button>
    )
  }

  return (
    <div className="flex w-full items-center gap-1.5">
      <button
        type="button"
        aria-label="Disminuir cantidad"
        title="Disminuir cantidad"
        onClick={onDecrease}
        className="flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-white/10 bg-white/6 text-white/80 transition-colors hover:border-white/20 hover:bg-white/10 hover:text-white active:scale-95"
      >
        <MinusIcon className="size-3.5 stroke-2" />
      </button>

      <div className="flex h-9 flex-1 items-center justify-center rounded-lg border border-beyonix-blue-light/50 bg-beyonix-blue/40 text-13px font-semibold tabular-nums text-white">
        {quantity}
      </div>

      <button
        type="button"
        aria-label="Aumentar cantidad"
        title="Aumentar cantidad"
        onClick={onIncrease}
        className="flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-white/10 bg-white/6 text-white/80 transition-colors hover:border-white/20 hover:bg-white/10 hover:text-white active:scale-95"
      >
        <PlusIcon className="size-3.5 stroke-2" />
      </button>
    </div>
  )
}
