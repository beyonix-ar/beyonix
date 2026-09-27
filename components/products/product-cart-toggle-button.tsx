"use client"

import { MinusIcon, PlusIcon, ShoppingBag } from "lucide-react"

interface ProductCartToggleButtonProps {
  quantity: number
  onAdd: () => void
  onIncrease: () => void
  onDecrease: () => void
  maxReached?: boolean
  /** Motivo real del bloqueo (getQuantityLimitMessage); se muestra como tooltip. */
  limitMessage?: string | null
}

export function ProductCartToggleButton({
  quantity,
  onAdd,
  onIncrease,
  onDecrease,
  maxReached = false,
  limitMessage = null,
}: ProductCartToggleButtonProps) {
  // Un botón deshabilitado no recibe el hover: el tooltip vive en el
  // contenedor y el botón deja pasar el puntero mientras está bloqueado.
  const blockedTitle = maxReached && limitMessage ? limitMessage : undefined

  if (quantity === 0) {
    return (
      <span title={blockedTitle} data-quantity-limit={blockedTitle ? "" : undefined} className={blockedTitle ? "block w-full cursor-not-allowed" : "block w-full"}>
        <button
          type="button"
          aria-label={"Añadir producto al carrito"}
          onClick={onAdd}
          disabled={maxReached}
          className="flex h-12 w-full items-center justify-center gap-2.5 whitespace-nowrap rounded-xl border border-beyonix-blue-light/45 bg-[#112A43] px-5 text-14px font-bold text-white transition-all duration-200 enabled:cursor-pointer enabled:hover:border-emerald-300/55 enabled:hover:bg-[#153A2B] enabled:hover:text-emerald-50 enabled:active:scale-95 disabled:pointer-events-none disabled:opacity-35"
        >
          <ShoppingBag className="size-4 shrink-0" />
          A&ntilde;adir al carrito
        </button>
        {blockedTitle && <span className="sr-only">{blockedTitle}</span>}
      </span>
    )
  }

  return (
    <div className="beyonix-qty-stepper grid h-12 w-full grid-cols-[48px_minmax(72px,1fr)_48px] overflow-hidden rounded-xl border border-beyonix-blue-light/24 bg-[#121820] shadow-[inset_0_1px_0_rgba(255,255,255,0.045)]">
      <button
        type="button"
        aria-label="Disminuir cantidad"
        onClick={onDecrease}
        className="beyonix-qty-stepper-btn flex h-full cursor-pointer items-center justify-center border-r border-beyonix-blue-light/18 bg-[#112A43]/72 text-white/82 transition-colors hover:bg-[#183B5E] hover:text-white active:bg-[#1E4D7B]"
      >
        <MinusIcon className="size-3.5 stroke-2" />
      </button>

      <div className="beyonix-qty-stepper-value flex h-full items-center justify-center bg-[#191B1F] px-2 text-14px font-bold tabular-nums text-white">
        {quantity}
      </div>

      <span title={blockedTitle} data-quantity-limit={blockedTitle ? "" : undefined} className={blockedTitle ? "flex h-full cursor-not-allowed" : "flex h-full"}>
        <button
          type="button"
          aria-label="Aumentar cantidad"
          onClick={onIncrease}
          disabled={maxReached}
          className="beyonix-qty-stepper-btn flex h-full w-full items-center justify-center border-l border-beyonix-blue-light/18 bg-[#112A43]/72 text-white/82 transition-colors enabled:cursor-pointer enabled:hover:bg-[#183B5E] enabled:hover:text-white enabled:active:bg-[#1E4D7B] disabled:pointer-events-none disabled:opacity-35"
        >
          <PlusIcon className="size-3.5 stroke-2" />
        </button>
        {blockedTitle && <span className="sr-only">{blockedTitle}</span>}
      </span>
    </div>
  )
}
