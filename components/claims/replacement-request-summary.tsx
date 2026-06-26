"use client"

import type { ReactNode } from "react"

import type { SupabaseOrderClaim } from "@/lib/supabase/types"

const REPLACEMENT_ITEMS_PREFIX = "__replacement_items__:"

type ReplacementItemDetail = {
  productName?: string | null
  variantName?: string | null
  quantity?: number | null
  unitPrice?: number | null
  subtotal?: number | null
  image?: string | null
}

type DisplayItem = {
  productName: string
  variantName?: string | null
  quantity: number
  unitPrice: number
  subtotal: number
  image?: string | null
}

function formatPrice(value: number) {
  return new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    maximumFractionDigits: 0,
  }).format(value)
}

function parseReplacementItems(claim: SupabaseOrderClaim): ReplacementItemDetail[] {
  const raw = claim.replacement_change_reason ?? ""
  if (raw.startsWith(REPLACEMENT_ITEMS_PREFIX)) {
    try {
      const parsed = JSON.parse(raw.slice(REPLACEMENT_ITEMS_PREFIX.length))
      if (Array.isArray(parsed.items)) return parsed.items
    } catch {
      return []
    }
  }

  return (claim.replacement_requested_product ?? "")
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((label) => {
      const quantityMatch = label.match(/\sx(\d+)$/)
      const cleanLabel = label.replace(/\sx\d+$/, "")
      const [productName, variantName] = cleanLabel.split(" · ").map((part) => part.trim())
      const quantity = quantityMatch ? Number(quantityMatch[1]) : claim.replacement_requested_quantity ?? 1
      const total = Number(claim.replacement_requested_price ?? 0)
      const unitPrice = quantity > 0 && total > 0 ? Math.round(total / quantity) : 0

      return {
        productName,
        variantName,
        quantity,
        unitPrice,
        subtotal: unitPrice * quantity,
      }
    })
}

export function ReplacementRequestSummary({ claim, actions }: { claim: SupabaseOrderClaim; actions?: ReactNode }) {
  const items = parseReplacementItems(claim)
  if (items.length === 0) return null

  const originalTotal = Number(claim.replacement_original_price ?? 0)
  const requestedTotal = Number(claim.replacement_requested_price ?? 0)
  const difference = Number(claim.replacement_price_difference ?? requestedTotal - originalTotal)
  const resultTitle = difference > 0 ? "Diferencia a pagar" : difference < 0 ? "Saldo a favor" : "Sin diferencia"
  const resultValue = difference === 0 ? formatPrice(0) : formatPrice(Math.abs(difference))
  const resultTone =
    difference > 0
      ? "border-amber-300/25 bg-amber-400/10 text-amber-100"
      : difference < 0
        ? "border-[#77E6E2]/25 bg-[#77E6E2]/10 text-[#D7FFFD]"
        : "border-blue-300/20 bg-[#112A43]/25 text-blue-100"
  const originalItem: DisplayItem = {
    productName: claim.replacement_original_product || "Producto original",
    variantName: claim.replacement_original_variant,
    quantity: 1,
    unitPrice: originalTotal,
    subtotal: originalTotal,
  }
  const requestedItems: DisplayItem[] = items.map((item) => ({
    productName: item.productName || "Producto solicitado",
    variantName: item.variantName,
    quantity: Number(item.quantity ?? 1),
    unitPrice: Number(item.unitPrice ?? 0),
    subtotal: Number(item.subtotal ?? 0),
    image: item.image,
  }))

  const renderCartRow = (item: DisplayItem, index: number, tone: "neutral" | "requested" = "neutral") => (
    <div
      key={`${item.productName}-${item.variantName}-${index}`}
      className={`flex gap-2 rounded-lg border px-2 py-1.5 shadow-sm shadow-black/20 ${
        tone === "requested"
          ? "border-blue-300/18 bg-[#112A43]/16"
          : "border-white/10 bg-[#15191F]"
      }`}
    >
      <div className="relative size-11 shrink-0 overflow-hidden rounded-md border border-white/10 bg-white p-0.5">
        {item.image ? <img src={item.image} alt={item.productName} className="size-full object-contain" /> : <div className="flex size-full items-center justify-center text-10px font-black text-black/35">BX</div>}
      </div>
      <div className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] gap-2">
        <div className="min-w-0">
          <h4 className="truncate text-xs font-bold leading-4 text-white">{item.productName}</h4>
          <p className="mt-0.5 truncate text-10px text-white/58">{item.variantName ? `Color: ${item.variantName}` : "Sin variante"}</p>
          <p className="mt-0.5 text-10px text-white/45">Cantidad: <span className="font-bold text-white/75">{item.quantity}</span></p>
        </div>
        <div className="text-right">
          <div><span className="block text-[9px] font-black uppercase tracking-wide text-white/35">Unitario</span><strong className="text-10px text-white">{formatPrice(item.unitPrice)}</strong></div>
          <div className="mt-1"><span className="block text-[9px] font-black uppercase tracking-wide text-white/35">Subtotal</span><strong className="text-xs text-white">{formatPrice(item.subtotal)}</strong></div>
        </div>
      </div>
    </div>
  )

  return (
    <div className="rounded-xl border border-white/10 bg-beyonix-surface p-2.5 text-xs text-white shadow-lg shadow-black/20">
      <p className="text-10px font-black uppercase tracking-wide text-beyonix-cyan">Solicitud de cambio de producto</p>

      <div className="mt-2 space-y-1.5">
        <p className="text-10px font-black uppercase tracking-wide text-white/45">Producto actual</p>
        {renderCartRow(originalItem, 0, "neutral")}
      </div>

      <div className="mt-2 space-y-1.5">
        <p className="text-10px font-black uppercase tracking-wide text-blue-200">Producto/s solicitado/s</p>
        {requestedItems.map((item, index) => renderCartRow(item, index, "requested"))}
      </div>

      <div className="mt-2 rounded-lg border border-white/10 bg-[#101820] px-2.5 py-2">
        <h3 className="mb-1.5 text-xs font-bold tracking-wide text-white">Resumen</h3>
        <div className="space-y-1">
          <div className="flex justify-between gap-3 text-xs"><span className="text-white/60">Subtotal actual</span><span className="font-semibold text-white">{formatPrice(originalTotal)}</span></div>
          <div className="flex justify-between gap-3 text-xs"><span className="text-white/60">Subtotal solicitado</span><span className="font-semibold text-white">{formatPrice(requestedTotal)}</span></div>
          <div className="h-px bg-white/10" />
          <div className={`rounded-lg border px-2 py-1.5 ${resultTone}`}>
            <div className="flex justify-between gap-3 text-xs font-bold"><span>{resultTitle}</span><span>{resultValue}</span></div>
          </div>
        </div>
        {difference < 0 && <p className="mt-1.5 rounded-lg border border-[#77E6E2]/20 bg-[#77E6E2]/5 px-2 py-1.5 text-10px leading-4 text-[#D7FFFD]">Tenés un saldo a favor de {formatPrice(Math.abs(difference))}. BEYONIX podrá acreditarlo como gift card, cupón o crédito interno para una próxima compra.</p>}
        {difference > 0 && <p className="mt-1.5 rounded-lg border border-amber-300/20 bg-amber-400/10 px-2 py-1.5 text-10px leading-4 text-amber-100">Hay una diferencia a pagar de {formatPrice(difference)}. Subí el comprobante cuando realices el pago.</p>}
        <p className="mt-1.5 text-10px leading-4 text-white/45">El costo de envío puede variar según el producto elegido.</p>
      </div>
      {actions && <div className="mt-2">{actions}</div>}
    </div>
  )
}

export { REPLACEMENT_ITEMS_PREFIX }
