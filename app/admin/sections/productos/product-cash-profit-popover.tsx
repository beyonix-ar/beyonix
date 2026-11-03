"use client"

import { useEffect, useState } from "react"
import { createPortal } from "react-dom"
import { Eye } from "lucide-react"

import type { ProductCashProfitEstimate } from "@/lib/pricing/product-cash-profit"
import { getProductCashProfit } from "@/lib/supabase/queries/productos"

import { useAnchoredPopover } from "./use-anchored-popover"

interface ProductCashProfitPopoverProps {
  productId: number
  productName: string
  price: number | null
  /** `productos.activo`: si cambia, la estimación guardada deja de valer. */
  active: boolean
  catalogRevision?: number | null
}

type LoadState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "done"; estimate: ProductCashProfitEstimate }

const formatMoney = (value: number) => {
  const rounded = Math.round(value)
  const formatted = `$${Math.abs(rounded).toLocaleString("es-AR")}`
  return rounded < 0 ? `-${formatted}` : formatted
}

/** Verde/rojo/neutro con los tonos que ya usa el listado (stock, estado). */
const profitTone = (value: number) =>
  Math.round(value) > 0 ? "text-green-400" : Math.round(value) < 0 ? "text-red-400" : "text-white/70"

function Amount({ value }: { value: number }) {
  return <span className={`tabular-nums ${profitTone(value)}`}>{formatMoney(value)}</span>
}

function variantLabel(variant: { variantId: number | null; variantName: string | null }) {
  return variant.variantName?.trim() || (variant.variantId == null ? "Producto" : `Variante #${variant.variantId}`)
}

/**
 * Ojo de la columna Acciones: "Ganancia estimada al contado" (Mercado Pago,
 * 1 pago). El cálculo vive en el servidor (exclusivo de Admin, expone costos)
 * y se pide sólo al abrir el panel; nunca al renderizar el listado.
 */
export function ProductCashProfitPopover({ productId, productName, price, active, catalogRevision = null }: ProductCashProfitPopoverProps) {
  const popover = useAnchoredPopover({ width: 300, hover: true })
  const [state, setState] = useState<LoadState>({ status: "idle" })

  useEffect(() => {
    if (!popover.open) return
    let current = true
    setState({ status: "loading" })
    getProductCashProfit(productId, { price, active, catalogRevision })
      .then((estimate) => { if (current) setState({ status: "done", estimate }) })
      .catch((cause: unknown) => {
        if (current) {
          setState({
            status: "error",
            message: cause instanceof Error && cause.message ? cause.message : "No se pudo calcular la ganancia estimada.",
          })
        }
      })
    return () => { current = false }
  }, [popover.open, productId, price, active, catalogRevision])

  return (
    <span ref={popover.anchorRef} className="relative inline-flex" {...popover.hoverHandlers}>
      <button
        type="button"
        aria-label={`Ver ganancia estimada al contado de ${productName}`}
        title="Ganancia estimada al contado"
        aria-haspopup="dialog"
        aria-expanded={popover.open}
        onClick={popover.toggle}
        className={`flex size-9 cursor-pointer items-center justify-center rounded-xl border text-white/55 transition-colors hover:text-white ${
          popover.open ? "border-beyonix-sky/40" : "border-white/8 hover:border-white/22"
        }`}
      >
        <Eye className="size-3.5" aria-hidden="true" />
      </button>

      {popover.open &&
        createPortal(
          <div
            ref={popover.panelRef}
            role="dialog"
            aria-label={`Ganancia estimada al contado de ${productName}`}
            {...popover.hoverHandlers}
            className="admin-portal-scope fixed z-100 rounded-2xl border border-[rgba(92,159,215,0.28)] bg-[#07111b] p-3 text-left shadow-[0_22px_52px_rgba(0,0,0,0.52)]"
            style={{ left: popover.position.left, top: popover.position.top, width: popover.position.width }}
          >
            <p className="text-10px font-black uppercase tracking-widest text-white/55">
              Ganancia estimada al contado
            </p>
            <CashProfitBody state={state} />
          </div>,
          document.body,
        )}
    </span>
  )
}

function CashProfitBody({ state }: { state: LoadState }) {
  if (state.status === "idle" || state.status === "loading") {
    return <p className="mt-1.5 text-sm font-bold text-white/55" role="status">Calculando…</p>
  }
  if (state.status === "error") {
    return (
      <>
        <p className="mt-1.5 text-base font-black text-white/45">No disponible</p>
        <p role="alert" className="mt-0.5 text-11px leading-4 text-red-300">{state.message}</p>
      </>
    )
  }

  const { estimate } = state
  if (estimate.status === "unavailable") {
    return (
      <>
        <p className="mt-1.5 text-base font-black text-white/45">No disponible</p>
        <p className="mt-0.5 text-11px leading-4 text-white/60">{estimate.message}</p>
      </>
    )
  }

  const single = estimate.minProfit === estimate.maxProfit
  return (
    <>
      <p className="mt-1.5 text-base font-black">
        {single ? (
          <Amount value={estimate.minProfit} />
        ) : (
          <>
            <span className="text-white/70">Desde </span>
            <Amount value={estimate.minProfit} />
            <span className="text-white/70"> hasta </span>
            <Amount value={estimate.maxProfit} />
          </>
        )}
      </p>
      <p className="mt-0.5 text-10px leading-4 text-white/50">
        Mercado Pago · 1 pago ({estimate.feePercent}%
        {estimate.feeSource === "observed" ? ", último pago real" : ", configurado"}) · contado {formatMoney(estimate.cashPrice)}
      </p>

      {estimate.variants.length > 1 && (
        <ul className="mt-2 space-y-0.5 border-t border-white/8 pt-2 text-11px">
          {estimate.variants.map((variant) => (
            <li key={variant.variantId ?? "producto"} className="flex items-center justify-between gap-3">
              <span className="min-w-0 truncate text-white/65">{variantLabel(variant)}</span>
              <Amount value={variant.profitAmount} />
            </li>
          ))}
        </ul>
      )}

      {estimate.missingCostVariants.length > 0 && (
        <p className="mt-2 rounded-lg border border-amber-300/25 bg-amber-300/8 px-2 py-1.5 text-11px font-bold leading-4 text-amber-200">
          Costo incompleto: sin costo de compra en {estimate.missingCostVariants.map(variantLabel).join(", ")}. No entran en el valor mostrado.
        </p>
      )}
    </>
  )
}
