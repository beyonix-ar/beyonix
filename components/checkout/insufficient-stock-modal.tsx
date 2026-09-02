"use client"

import { useEffect, useState } from "react"
import { createPortal } from "react-dom"
import { AlertTriangle, X } from "lucide-react"

import { BeyonixButton } from "@/components/beyonix-ui"
import {
  INSUFFICIENT_STOCK_MESSAGE_PLURAL,
  INSUFFICIENT_STOCK_MESSAGE_SINGULAR,
  INSUFFICIENT_STOCK_TITLE,
} from "@/lib/cart/stock-status"

export interface InsufficientStockModalItem {
  productId: number
  variantId: number | null
  conditionedStockId: string | null
  displayName: string
  variantName: string | null
}

interface InsufficientStockModalProps {
  items: InsufficientStockModalItem[]
  onClose: () => void
}

export function InsufficientStockModal({
  items,
  onClose,
}: InsufficientStockModalProps) {
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [onClose])

  if (!mounted || items.length === 0) return null

  const isPlural = items.length > 1

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 px-4 py-5 backdrop-blur-sm">
      <button
        type="button"
        aria-label="Cerrar"
        onClick={onClose}
        className="absolute inset-0 cursor-pointer"
      />

      <div className="beyonix-modal-shell relative z-10 w-[min(400px,calc(100vw-32px))] rounded-2xl border border-red-400/24 bg-[#080D13] p-4 shadow-[0_28px_90px_rgba(0,0,0,0.72)]">
        <div className="flex items-center gap-2.5">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-full border border-red-400/30 bg-red-500/10">
            <AlertTriangle className="size-4 text-red-300" />
          </div>

          <h2 className="beyonix-modal-title flex-1 text-[15px] font-bold leading-tight text-white">
            {INSUFFICIENT_STOCK_TITLE}
          </h2>

          <button
            type="button"
            aria-label="Cerrar"
            onClick={onClose}
            className="beyonix-modal-close flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-full text-white/50 transition-colors hover:bg-white/8 hover:text-white"
          >
            <X className="size-3.5" />
          </button>
        </div>

        <p className="beyonix-modal-body mt-2.5 text-[13px] leading-5 text-white/65">
          {isPlural
            ? INSUFFICIENT_STOCK_MESSAGE_PLURAL
            : INSUFFICIENT_STOCK_MESSAGE_SINGULAR}
        </p>

        <p className="beyonix-modal-muted mb-1.5 mt-3.5 text-[10px] font-bold uppercase tracking-widest text-white/40">
          {isPlural ? "Productos afectados" : "Producto afectado"}
        </p>

        <ul className="beyonix-modal-list divide-y divide-white/[0.06] rounded-lg border border-white/8 bg-white/[0.03] px-3">
          {items.map((item) => (
            <li
              key={`${item.productId}-${item.variantId ?? item.conditionedStockId ?? "default"}`}
              className="py-2"
            >
              <p className="beyonix-modal-title text-[13px] font-semibold text-white/90">
                {item.displayName}
              </p>
              {item.variantName && (
                <p className="beyonix-modal-muted mt-0.5 flex items-center gap-1.5 text-[11.5px] text-white/50">
                  <span className="size-1.5 shrink-0 rounded-full bg-white/25" />
                  {item.variantName}
                </p>
              )}
            </li>
          ))}
        </ul>

        <div className="mt-3.5">
          <BeyonixButton
            variant="primary"
            size="md"
            onClick={onClose}
            className="w-full"
          >
            Revisar cantidades
          </BeyonixButton>
        </div>
      </div>
    </div>,
    document.body,
  )
}
