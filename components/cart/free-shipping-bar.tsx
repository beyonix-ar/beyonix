"use client"

import { Truck } from "lucide-react"

import {
  FREE_SHIPPING_MIN,
  IS_FREE_SHIPPING_ENABLED,
  hasShippingBonus,
} from "@/lib/store-config"

interface Props {
  subtotal: number
  coveredByBeyonix?: boolean
}

const formatPrice = (price: number) =>
  new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    minimumFractionDigits: 0,
  }).format(price)

export function FreeShippingBar({
  subtotal,
  coveredByBeyonix = false,
}: Props) {
  if (coveredByBeyonix) {
    return (
      <p className="flex items-center gap-2 text-sm font-semibold text-emerald-400">
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-emerald-500/10">
          <Truck className="size-3" aria-hidden="true" />
        </span>
        <span>Envío a cargo de BEYONIX</span>
      </p>
    )
  }

  if (!IS_FREE_SHIPPING_ENABLED) {
    return null
  }

  const progress =
    FREE_SHIPPING_MIN <= 0
      ? 100
      : Math.min((subtotal / FREE_SHIPPING_MIN) * 100, 100)
  const remaining = Math.max(FREE_SHIPPING_MIN - subtotal, 0)
  const isComplete = hasShippingBonus(subtotal)

  return (
    <div className="space-y-1.5">
      <p
        className={`flex items-center gap-2 transition-all duration-300 ${
          isComplete
            ? "text-emerald-400 font-semibold text-sm tracking-wide"
            : "text-muted-foreground text-xs"
        }`}
      >
        {isComplete ? (
          <>
            <span className="flex items-center justify-center size-20px rounded-full bg-emerald-500/10">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="size-12px text-emerald-400"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M3 3h13v13H3z" />
                <path d="M16 8h4l2 3v5h-6z" />
                <circle cx="5.5" cy="18.5" r="1.5" />
                <circle cx="18.5" cy="18.5" r="1.5" />
              </svg>
            </span>

            <span className="beyonix-success-glow">
              🎉 ¡Conseguiste envío bonificado!
            </span>
          </>
        ) : (
          <span className="text-white/80 text-sm">
            🚚 Te faltan{" "}
            <span className="text-white font-semibold tracking-wide">
              {formatPrice(remaining)}
            </span>{" "}
            <span className="text-white/80 text-sm">
              para conseguir envío bonificado.
            </span>
          </span>
        )}
      </p>

      <div className="w-full h-1.5 bg-white/60 rounded-full overflow-hidden">
        <div
          className={`h-full transition-all duration-300 ease-out ${
            isComplete
              ? "bg-emerald-500 beyonix-success-bar-glow"
              : "bg-sky-950 beyonix-progress-glow"
          }`}
          style={{ width: `${progress}%` }}
        />
      </div>
    </div>
  )
}
