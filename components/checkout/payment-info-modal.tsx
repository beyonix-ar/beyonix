"use client"

import { useEffect, useState, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { X } from "lucide-react"

import { BeyonixButton } from "@/components/beyonix-ui"

/**
 * Modal chico del paso de pago. Sin `footer` es SÓLO informativo ("Ver
 * cuotas", "Ver medios"): no tiene controles de selección ni modifica el
 * estado del checkout. Con `footer` se usa para confirmar antes de ir a
 * Mercado Pago. Mismo patrón y clases de tema que InsufficientStockModal.
 */
export function PaymentInfoModal({
  title,
  onClose,
  children,
  footer,
}: {
  title: string
  onClose: () => void
  children: ReactNode
  /** Reemplaza el botón "Entendido" (p. ej. confirmar / volver). */
  footer?: ReactNode
}) {
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

  if (!mounted) return null

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 px-4 py-5 backdrop-blur-sm">
      <button
        type="button"
        aria-label="Cerrar"
        onClick={onClose}
        className="absolute inset-0 cursor-pointer"
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="beyonix-modal-shell checkout-info-modal relative z-10 w-[min(400px,calc(100vw-32px))] rounded-2xl border border-beyonix-blue-light/24 bg-[#080D13] p-4 shadow-[0_28px_90px_rgba(0,0,0,0.72)]"
      >
        <div className="flex items-center gap-2.5">
          <h2 className="beyonix-modal-title flex-1 text-[15px] font-bold leading-tight text-white">
            {title}
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

        <div className="mt-3">{children}</div>

        <div className="mt-4">
          {footer ?? (
            <BeyonixButton variant="primary" size="md" onClick={onClose} className="w-full">
              Entendido
            </BeyonixButton>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
