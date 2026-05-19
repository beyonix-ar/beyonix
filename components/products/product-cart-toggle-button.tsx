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
        aria-label="Añadir producto al carrito"
        onClick={onAdd}
        className="flex w-full h-9 items-center justify-center gap-2 rounded-lg bg-white text-[13px] font-semibold text-black transition-all duration-150 hover:bg-white/90 active:scale-[0.98] cursor-pointer"
      >
        <ShoppingBag className="size-3.5" />
        Añadir al carrito
      </button>
    )
  }

  return (
    <div className="flex items-center w-full gap-1.5">

      <button
        type="button"
        aria-label="Disminuir cantidad"
        title="Disminuir cantidad"
        onClick={onDecrease}
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/[0.06] text-white/70 hover:bg-white/[0.10] hover:text-white hover:border-white/20 transition-colors active:scale-95 cursor-pointer"
      >
        <MinusIcon className="size-3.5 stroke-[2]" />
      </button>

      <div className="flex h-9 flex-1 items-center justify-center rounded-lg border border-[#1E4D7B]/50 bg-[#112A43]/40 text-[13px] font-semibold text-white tabular-nums">
        {quantity}
      </div>

      <button
        type="button"
        aria-label="Aumentar cantidad"
        title="Aumentar cantidad"
        onClick={onIncrease}
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/[0.06] text-white/70 hover:bg-white/[0.10] hover:text-white hover:border-white/20 transition-colors active:scale-95 cursor-pointer"
      >
        <PlusIcon className="size-3.5 stroke-[2]" />
      </button>

    </div>
  )
}