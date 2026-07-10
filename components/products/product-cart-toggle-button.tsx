"use client"

import { MinusIcon, PlusIcon, ShoppingBag } from "lucide-react"

interface ProductCartToggleButtonProps {
  quantity: number
  onAdd: () => void
  onIncrease: () => void
  onDecrease: () => void
  maxReached?: boolean
}

export function ProductCartToggleButton({
  quantity,
  onAdd,
  onIncrease,
  onDecrease,
  maxReached = false,
}: ProductCartToggleButtonProps) {
  if (quantity === 0) {
    return (
      <button
        type="button"
        aria-label={"A\u00f1adir producto al carrito"}
        onClick={onAdd}
        disabled={maxReached}
        className="flex h-12 w-full items-center justify-center gap-2.5 whitespace-nowrap rounded-xl border border-beyonix-blue-light/45 bg-[#112A43] px-5 text-14px font-bold text-white transition-all duration-200 enabled:cursor-pointer enabled:hover:border-emerald-300/55 enabled:hover:bg-[#153A2B] enabled:hover:text-emerald-50 enabled:active:scale-95 disabled:cursor-not-allowed disabled:opacity-35"
      >
        <ShoppingBag className="size-4 shrink-0" />
        A&ntilde;adir al carrito
      </button>
    )
  }

  return (
    <div className="grid h-12 w-full grid-cols-[48px_minmax(72px,1fr)_48px] overflow-hidden rounded-xl border border-beyonix-blue-light/24 bg-[#121820] shadow-[inset_0_1px_0_rgba(255,255,255,0.045)]">
      <button
        type="button"
        aria-label="Disminuir cantidad"
        onClick={onDecrease}
        className="flex h-full cursor-pointer items-center justify-center border-r border-beyonix-blue-light/18 bg-[#112A43]/72 text-white/82 transition-colors hover:bg-[#183B5E] hover:text-white active:bg-[#1E4D7B]"
      >
        <MinusIcon className="size-3.5 stroke-2" />
      </button>

      <div className="flex h-full items-center justify-center bg-[#191B1F] px-4 text-14px font-bold tabular-nums text-white">
        {quantity}
      </div>

      <button
        type="button"
        aria-label="Aumentar cantidad"
        onClick={onIncrease}
        disabled={maxReached}
        className="flex h-full items-center justify-center border-l border-beyonix-blue-light/18 bg-[#112A43]/72 text-white/82 transition-colors enabled:cursor-pointer enabled:hover:bg-[#183B5E] enabled:hover:text-white enabled:active:bg-[#1E4D7B] disabled:cursor-not-allowed disabled:opacity-35"
      >
        <PlusIcon className="size-3.5 stroke-2" />
      </button>
    </div>
  )
}
