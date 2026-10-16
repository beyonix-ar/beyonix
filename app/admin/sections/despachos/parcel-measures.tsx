"use client"

import { AlertTriangle } from "lucide-react"
import { useState } from "react"

import { AdminHelpTip } from "@/app/admin/components/admin-help-tip"
import type { DispatchParcel, DispatchShippingInfo } from "@/lib/admin/dispatch"
import {
  MAX_PARCELS,
  PARCEL_MEASURE_FIELDS,
  parseMeasureText,
  type ParcelMeasures,
} from "@/lib/shipping/parcel-measures"

export type ParcelDraft = Record<keyof ParcelMeasures, string>

const ANDREANI_B2C_MAX_WEIGHT_KG = 50
const emptyDraft = (): ParcelDraft => ({ weightKg: "", lengthCm: "", widthCm: "", heightCm: "" })
const decimal = (value: number, digits = 1) =>
  new Intl.NumberFormat("es-AR", { maximumFractionDigits: digits }).format(value)
const money = (value: number) =>
  new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 0 }).format(value)

/** Borrador inicial: medidas ya cargadas (al cambiar bultos) o vacío. */
export function initialParcelDrafts(parcels: DispatchParcel[], count: number): ParcelDraft[] {
  return Array.from({ length: count }, (_, index) => {
    const parcel = parcels[index]
    if (!parcel || parcel.weight_kg == null) return emptyDraft()
    return {
      weightKg: decimal(parcel.weight_kg, 3),
      lengthCm: decimal(parcel.length_cm ?? 0),
      widthCm: decimal(parcel.width_cm ?? 0),
      heightCm: decimal(parcel.height_cm ?? 0),
    }
  })
}

export function resizeParcelDrafts(drafts: ParcelDraft[], count: number) {
  return Array.from({ length: count }, (_, index) => drafts[index] ?? emptyDraft())
}

/** Cada bulto toma sólo su propia estimación. Una cantidad distinta requiere carga manual. */
export function estimatedParcelDrafts(estimate: DispatchShippingInfo["estimate"], count: number): ParcelDraft[] | null {
  if (!estimate || estimate.parcels.length !== count) return null
  return estimate.parcels.map((parcel) => ({
    weightKg: decimal(parcel.weightKg, 3),
    lengthCm: decimal(parcel.lengthCm),
    widthCm: decimal(parcel.widthCm),
    heightCm: decimal(parcel.heightCm),
  }))
}

/** Medidas listas para enviar, o el primer error a mostrar. */
export function readParcelDrafts(drafts: ParcelDraft[]): { parcels: ParcelMeasures[] } | { error: string } {
  if (drafts.length < 1 || drafts.length > MAX_PARCELS) return { error: `Indicá entre 1 y ${MAX_PARCELS} paquetes.` }
  const parcels: ParcelMeasures[] = []
  for (const [index, draft] of drafts.entries()) {
    const values = {} as ParcelMeasures
    for (const field of PARCEL_MEASURE_FIELDS) {
      const value = parseMeasureText(draft[field.key])
      if (value === null || value <= 0 || value > field.max) {
        return { error: `Paquete ${index + 1}: completá ${field.label.toLowerCase()} (mayor que 0 y hasta ${field.max} ${field.unit}).` }
      }
      values[field.key] = value
    }
    parcels.push(values)
  }
  return { parcels }
}

type ParcelSize = { lengthCm: number; widthCm: number; heightCm: number; weightKg: number }

/** "1 paquete · 35 × 25 × 18 cm · 2,2 kg" o, con varios, una línea por paquete. */
function sizeSummary(parcels: ParcelSize[]) {
  if (!parcels.length) return null
  const line = (parcel: ParcelSize) =>
    `${decimal(parcel.lengthCm)} × ${decimal(parcel.widthCm)} × ${decimal(parcel.heightCm)} cm · ${decimal(parcel.weightKg, 3)} kg`
  if (parcels.length === 1) return [`1 paquete · ${line(parcels[0])}`]
  return [`${parcels.length} paquetes`, ...parcels.map((parcel, index) => `Paquete ${index + 1}: ${line(parcel)}`)]
}

export function estimateSummary(estimate: DispatchShippingInfo["estimate"]) {
  return sizeSummary(estimate?.parcels ?? [])
}

/** Medidas reales cargadas al armar (null si algún bulto es legacy sin medidas). */
export function realSummary(parcels: DispatchParcel[]) {
  if (!parcels.length || parcels.some((parcel) => parcel.weight_kg == null)) return null
  return sizeSummary(parcels.map((parcel) => ({
    lengthCm: parcel.length_cm ?? 0,
    widthCm: parcel.width_cm ?? 0,
    heightCm: parcel.height_cm ?? 0,
    weightKg: parcel.weight_kg ?? 0,
  })))
}

/** Estimado en checkout vs real del armado, para calibrar el estimador. */
export function EstimateVsReal({ estimate, parcels }: { estimate: DispatchShippingInfo["estimate"]; parcels: DispatchParcel[] }) {
  const estimated = estimateSummary(estimate)
  const real = realSummary(parcels)
  if (!estimated && !real) return null
  return (
    <div className="mt-3 grid gap-2 text-xs sm:grid-cols-2" data-estimate-vs-real>
      <div>
        <p className="font-black uppercase tracking-widest text-white/55">Estimado</p>
        {(estimated ?? ["Sin estimación (pedido anterior)"]).map((text, index) => <p key={index} className="text-white/80">{text}</p>)}
      </div>
      <div>
        <p className="font-black uppercase tracking-widest text-white/55">Real</p>
        {(real ?? ["Medidas no cargadas"]).map((text, index) => <p key={index} className="font-bold text-white">{text}</p>)}
      </div>
    </div>
  )
}

export function ParcelMeasuresEditor({ drafts, onChange, disabled, estimate }: {
  drafts: ParcelDraft[]
  onChange: (drafts: ParcelDraft[]) => void
  disabled: boolean
  estimate: DispatchShippingInfo["estimate"]
}) {
  const summary = estimateSummary(estimate)
  const [copied, setCopied] = useState(false)
  const canCopy = Boolean(estimatedParcelDrafts(estimate, drafts.length))
  return (
    <div className="mt-3 space-y-3">
      {summary ? (
        <div className="rounded-xl border border-white/12 bg-black/25 p-3 text-sm" data-checkout-estimate>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="flex items-center gap-1.5 text-11px font-black uppercase tracking-widest text-white/60">
              Estimación utilizada en checkout
              <AdminHelpTip label="Estimación de checkout" text="Paquete que BEYONIX calculó para cotizar el envío. Es sólo una referencia: cargá las medidas reales." />
            </p>
            <button type="button" disabled={disabled || !canCopy} onClick={() => {
              const next = estimatedParcelDrafts(estimate, drafts.length)
              if (next) { onChange(next); setCopied(true) }
            }} className="dispatch-copy-estimate rounded-lg border border-sky-400/45 px-2.5 py-1.5 text-xs font-bold text-sky-100 disabled:cursor-not-allowed disabled:opacity-45">Usar medidas estimadas</button>
          </div>
          <ul className="mt-1 space-y-0.5 font-bold text-white">{summary.map((line, index) => <li key={index}>{line}</li>)}</ul>
          {copied && canCopy && <p role="status" className="mt-1 text-xs font-bold text-emerald-300">Medidas copiadas ✓ · podés editarlas.</p>}
          {!canCopy && <p className="mt-1 text-xs text-amber-200">La cantidad de paquetes no coincide con la estimación; cargá las medidas reales de cada uno.</p>}
        </div>
      ) : null}
      <p className="text-11px font-black uppercase tracking-widest text-white/60">Medidas reales</p>
      {drafts.map((draft, index) => {
        const weight = parseMeasureText(draft.weightKg)
        return (
          <fieldset key={index} className="rounded-xl border border-white/12 bg-white/[0.025] p-3" data-parcel-measures={index + 1}>
            <legend className="px-1 text-sm font-black text-white">PAQUETE {index + 1}</legend>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {PARCEL_MEASURE_FIELDS.map((field) => (
                <label key={field.key} className="block min-w-0 text-xs font-bold text-white/70">
                  {field.label}
                  <span className="relative mt-1 block">
                    <input
                      inputMode="decimal"
                      autoComplete="off"
                      required
                      disabled={disabled}
                      aria-label={`Paquete ${index + 1}: ${field.label} en ${field.unit}`}
                      value={draft[field.key]}
                      onChange={(event) => {
                        const value = event.target.value.replace(/[^\d,.]/g, "").slice(0, 9)
                        setCopied(false)
                        onChange(drafts.map((current, position) => position === index ? { ...current, [field.key]: value } : current))
                      }}
                      className="admin-control-input admin-ds-control h-11 w-full pl-3 pr-9 text-base font-black text-white outline-none"
                    />
                    <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs font-black text-white/70">{field.unit}</span>
                  </span>
                </label>
              ))}
            </div>
            {weight !== null && weight > ANDREANI_B2C_MAX_WEIGHT_KG ? (
              <p className="mt-2 text-xs font-bold text-amber-200">Andreani admite hasta {ANDREANI_B2C_MAX_WEIGHT_KG} kg por paquete en envíos B2C.</p>
            ) : null}
          </fieldset>
        )
      })}
    </div>
  )
}

/** Recotización con los bultos reales: sólo Admin, nunca se cobra al cliente. */
export function ParcelQuoteNotice({ shipping }: { shipping: DispatchShippingInfo }) {
  const quote = shipping.parcelQuote
  if (!shipping.costsVisible) return null
  if (!quote?.current) {
    return <p className="mt-2 text-xs text-white/60" data-parcel-quote="pending">Cotización con paquete real: pendiente.</p>
  }
  if (quote.status === "failed" || quote.amount === null) {
    return <p className="mt-2 text-xs font-bold text-amber-200" data-parcel-quote="failed">No se pudo cotizar con el paquete real. Se puede generar el envío igual.</p>
  }
  const difference = quote.differenceAmount
  const signed = difference === null ? null : `${difference >= 0 ? "+" : "−"}${money(Math.abs(difference))}`
  const percent = quote.differencePercent === null ? "" : ` (${quote.differencePercent >= 0 ? "+" : "−"}${decimal(Math.abs(quote.differencePercent), 1)}%)`
  if (quote.alert && quote.checkoutAmount !== null) {
    return (
      <div role="alert" className="mt-3 rounded-xl border border-amber-400/45 bg-amber-950 p-3 text-sm text-white" data-parcel-quote="alert">
        <p className="flex items-center gap-1.5 font-black"><AlertTriangle className="size-4" /> El costo estimado de Andreani cambió {decimal(Math.abs(quote.differencePercent ?? 0), 1)}%.</p>
        <p className="mt-1">Checkout: {money(quote.checkoutAmount)}</p>
        <p>Paquete real: {money(quote.amount)}</p>
        <p className="mt-1 font-bold">Revisar antes de generar envío.</p>
      </div>
    )
  }
  return (
    <p className="mt-2 text-xs text-white/70" data-parcel-quote="quoted">
      Cotizado con paquete real: <strong className="text-white">{money(quote.amount)}</strong>
      {quote.checkoutAmount !== null ? <> · tarifa checkout {money(quote.checkoutAmount)}{signed ? ` · ${signed}${percent}` : ""}</> : null}
    </p>
  )
}
