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
        title={"A\u00f1adir producto al carrito"}
        onClick={onAdd}
        disabled={maxReached}
        className="flex h-10 w-full items-center justify-center gap-2 whitespace-nowrap rounded-lg border border-beyonix-blue-light/18 bg-black/34 px-4 text-13px font-medium text-white/82 transition-all duration-150 enabled:cursor-pointer enabled:hover:border-beyonix-sky/42 enabled:hover:bg-beyonix-blue/24 enabled:hover:text-white enabled:hover:shadow-[0_0_16px_rgba(30,140,255,0.12)] enabled:active:scale-95 disabled:cursor-not-allowed disabled:opacity-35 sm:h-11 sm:px-5"
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
        className="flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-beyonix-blue-light/18 bg-black/34 text-white/80 transition-colors hover:border-beyonix-sky/42 hover:bg-beyonix-blue/24 hover:text-white active:scale-95 sm:h-11 sm:w-11"
      >
        <MinusIcon className="size-3.5 stroke-2" />
      </button>

      <div className="flex h-10 flex-1 items-center justify-center rounded-lg border border-beyonix-sky/38 bg-beyonix-blue/38 px-3 text-13px font-medium tabular-nums text-white shadow-[0_0_14px_rgba(30,140,255,0.12)] sm:h-11 sm:px-4">
        {quantity}
      </div>

      <button
        type="button"
        aria-label="Aumentar cantidad"
        title="Aumentar cantidad"
        onClick={onIncrease}
        disabled={maxReached}
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-beyonix-blue-light/18 bg-black/34 text-white/80 transition-colors enabled:cursor-pointer enabled:hover:border-beyonix-sky/42 enabled:hover:bg-beyonix-blue/24 enabled:hover:text-white enabled:active:scale-95 disabled:cursor-not-allowed disabled:opacity-35 sm:h-11 sm:w-11"
      >
        <PlusIcon className="size-3.5 stroke-2" />
      </button>
    </div>
  )
}
