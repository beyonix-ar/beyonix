"use client"

import { DollarSign, Percent } from "lucide-react"

import type {
  ProductProfitabilitySimulation,
  TargetMarginPriceResult,
} from "@/lib/pricing/product-pricing"
import type { ProductVariantCostInfo } from "@/lib/supabase/queries/productos"
import {
  adminControlClassName,
  AdminCard,
  AdminFormField,
  AdminInfoBlock,
} from "../../components/admin-controls"
import { ProfitabilityPopover } from "./product-profitability-popover"

const inputCls = `${adminControlClassName} text-base`

// whitespace-nowrap es crítico acá: si "Ganancia neta" hace wrap a 2 líneas
// (label más larga que las otras dos, "Precio calculado"/"Precio anterior"),
// su input queda más abajo que los otros dos y rompe la alineación
// horizontal de la fila -- ver Ganancia neta más abajo, único campo cuyo
// wrapper no fuerza el mismo ancho que su contenido.
const fieldLabelClassName =
  "product-editor-field-label whitespace-nowrap text-xs normal-case tracking-normal text-white"

// Precios ARS en este panel nunca superan 7 dígitos enteros; el margen es
// siempre un entero de 0-99 (2 dígitos). Clamps a nivel de handler porque
// `maxLength` no lo respeta un <input type="number">.
const MAX_PRICE_INTEGER_DIGITS = 7
const MAX_TARGET_MARGIN_DIGITS = 2

function clampIntegerDigits(rawValue: string, maxDigits: number): string {
  if (!rawValue) return rawValue
  const [integerPart, ...decimalParts] = rawValue.split(".")
  const clampedInteger = integerPart.slice(0, maxDigits)
  return decimalParts.length ? `${clampedInteger}.${decimalParts.join(".")}` : clampedInteger
}

function clampDigitsOnly(rawValue: string, maxDigits: number): string {
  return rawValue.replace(/\D/g, "").slice(0, maxDigits)
}

// Ancho fijo compacto para los campos de precio ($/precio calculado/precio
// anterior): visualmente alcanza justo para "$9.999.999" (7 dígitos +
// separadores de miles) sin estirarse más que eso. Los inputs con prefijo
// "$" además recortan el padding derecho heredado (que sólo tiene sentido
// cuando hay un ícono a la derecha) para no desperdiciar espacio.
const priceFieldWidthClassName = "w-32 shrink-0"
const priceInputTightPaddingClassName = "!pr-2"

interface ProductPriceCardProps {
  pricingMode: "manual" | "target_margin"
  onPricingModeChange: (mode: "manual" | "target_margin") => void
  precio: string
  onPrecioChange: (value: string) => void
  precioAnterior: string
  onPrecioAnteriorChange: (value: string) => void
  precioAnteriorError: string | null
  targetMarginPercent: string
  onTargetMarginPercentChange: (value: string) => void
  knownUnitCost: number | null | undefined
  targetMarginResult: TargetMarginPriceResult | null
  profitabilitySimulation: ProductProfitabilitySimulation | null
  profitabilityPrice: number | null
  priceFormatter: Intl.NumberFormat
  variantCostsDiffer: boolean
  realVariantCosts: ProductVariantCostInfo[]
}

/**
 * Card "Precio": modo manual ($) vs margen objetivo (%) por selector
 * segmentado compacto, con la rentabilidad estimada disponible bajo demanda
 * en el ícono de ojo (ProfitabilityPopover) en vez de ocupar layout fijo.
 * Ningún cálculo vive acá -- todo llega ya resuelto desde producto-form.tsx
 * (mismo targetMarginResult/profitabilitySimulation que usaba el layout
 * anterior).
 */
export function ProductPriceCard({
  pricingMode,
  onPricingModeChange,
  precio,
  onPrecioChange,
  precioAnterior,
  onPrecioAnteriorChange,
  precioAnteriorError,
  targetMarginPercent,
  onTargetMarginPercentChange,
  knownUnitCost,
  targetMarginResult,
  profitabilitySimulation,
  profitabilityPrice,
  priceFormatter,
  variantCostsDiffer,
  realVariantCosts,
}: ProductPriceCardProps) {
  const isManual = pricingMode === "manual"
  const currentPriceNumber = Number(precio)
  const computedPriceLabel =
    targetMarginResult != null
      ? priceFormatter.format(targetMarginResult.commercialPrice)
      : Number.isFinite(currentPriceNumber) && currentPriceNumber > 0
        ? priceFormatter.format(currentPriceNumber)
        : "—"

  return (
    <AdminCard className="product-editor-panel flex min-w-0 flex-col space-y-2 p-2.5">
      <div className="product-editor-panel-heading flex items-center justify-between gap-2">
        <h2 className="text-base font-black text-white">Precio</h2>
        <div className="flex items-center gap-1.5">
          <div
            role="group"
            aria-label="Forma de cálculo del precio"
            className="flex items-center gap-1 rounded-lg border border-white/10 bg-white/[0.02] p-0.5"
          >
            <button
              type="button"
              title="Precio manual"
              aria-label="Precio manual"
              aria-pressed={isManual}
              onClick={() => onPricingModeChange("manual")}
              className={`product-editor-pricing-mode inline-flex size-7 cursor-pointer items-center justify-center rounded-md border transition-all duration-150 ${
                isManual ? "product-editor-pricing-mode-active" : ""
              }`}
            >
              <DollarSign className="product-editor-pricing-mode-icon size-3.5 text-white" />
            </button>
            <button
              type="button"
              title="Ganancia por porcentaje"
              aria-label="Ganancia por porcentaje"
              aria-pressed={!isManual}
              onClick={() => onPricingModeChange("target_margin")}
              className={`product-editor-pricing-mode inline-flex size-7 cursor-pointer items-center justify-center rounded-md border transition-all duration-150 ${
                !isManual ? "product-editor-pricing-mode-active" : ""
              }`}
            >
              <Percent className="product-editor-pricing-mode-icon size-3.5 text-white" />
            </button>
          </div>
          <ProfitabilityPopover
            simulation={profitabilitySimulation}
            price={profitabilityPrice}
            priceFormatter={priceFormatter}
          />
        </div>
      </div>

      {isManual ? (
        <div className="flex min-w-0 flex-wrap items-start gap-2.5">
          <AdminFormField
            label="Precio actual"
            labelClassName={fieldLabelClassName}
            className={priceFieldWidthClassName}
          >
            <span className="relative block">
              <span className="pointer-events-none absolute left-3 top-1/2 z-10 -translate-y-1/2 text-sm font-black text-white">
                $
              </span>
              <input
                id="precio"
                min="0"
                type="number"
                value={precio}
                placeholder="0"
                onChange={(event) =>
                  onPrecioChange(clampIntegerDigits(event.target.value, MAX_PRICE_INTEGER_DIGITS))
                }
                className={`${inputCls} admin-product-price-input !pl-8 ${priceInputTightPaddingClassName} [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none`}
              />
            </span>
          </AdminFormField>

          <AdminFormField
            label="Precio anterior"
            labelClassName={fieldLabelClassName}
            className={priceFieldWidthClassName}
            error={precioAnteriorError}
          >
            <span className="relative block">
              <span className="pointer-events-none absolute left-3 top-1/2 z-10 -translate-y-1/2 text-sm font-black text-white">
                $
              </span>
              <input
                id="precio_anterior"
                min="0"
                type="number"
                value={precioAnterior}
                placeholder="0"
                onChange={(event) =>
                  onPrecioAnteriorChange(
                    clampIntegerDigits(event.target.value, MAX_PRICE_INTEGER_DIGITS),
                  )
                }
                className={`${inputCls} admin-product-price-input !pl-8 ${priceInputTightPaddingClassName} [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none ${
                  precioAnteriorError ? "!border-red-400/60" : ""
                }`}
              />
            </span>
          </AdminFormField>
        </div>
      ) : (
        <div className="flex min-w-0 flex-wrap items-start gap-2.5">
          <AdminFormField
            label="Ganancia neta"
            labelClassName={fieldLabelClassName}
            className="w-28 shrink-0"
          >
            {/* Input compacto explícito en 5rem (idéntico al ancho anterior):
                el wrapper de arriba es más ancho sólo para que el label
                "Ganancia neta" quepa en una línea sin empujar este input
                hacia abajo; el input en sí no cambia de tamaño. */}
            <span className="relative inline-flex w-20">
              <input
                id="target_margin_percent"
                min="0"
                max="99"
                type="number"
                inputMode="numeric"
                value={targetMarginPercent}
                placeholder="40"
                disabled={knownUnitCost == null}
                onChange={(event) =>
                  onTargetMarginPercentChange(
                    clampDigitsOnly(event.target.value, MAX_TARGET_MARGIN_DIGITS),
                  )
                }
                className="admin-control-input admin-ds-control w-full !pl-3 !pr-6 text-sm font-medium text-white outline-none transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-45 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
              />
              <span className="pointer-events-none absolute right-2 top-1/2 z-10 -translate-y-1/2 text-sm font-black text-white">
                %
              </span>
            </span>
          </AdminFormField>

          <AdminFormField
            label="Precio calculado"
            labelClassName={fieldLabelClassName}
            className={priceFieldWidthClassName}
          >
            <span className="admin-control-input admin-ds-control flex h-11 w-full items-center justify-end px-2 text-base font-black text-white opacity-90">
              {computedPriceLabel}
            </span>
          </AdminFormField>

          <AdminFormField
            label="Precio anterior"
            labelClassName={fieldLabelClassName}
            className={priceFieldWidthClassName}
            error={precioAnteriorError}
          >
            <span className="relative block">
              <span className="pointer-events-none absolute left-3 top-1/2 z-10 -translate-y-1/2 text-sm font-black text-white">
                $
              </span>
              <input
                id="precio_anterior"
                min="0"
                type="number"
                value={precioAnterior}
                placeholder="0"
                onChange={(event) =>
                  onPrecioAnteriorChange(
                    clampIntegerDigits(event.target.value, MAX_PRICE_INTEGER_DIGITS),
                  )
                }
                className={`${inputCls} admin-product-price-input !pl-8 ${priceInputTightPaddingClassName} [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none ${
                  precioAnteriorError ? "!border-red-400/60" : ""
                }`}
              />
            </span>
          </AdminFormField>
        </div>
      )}

      {knownUnitCost === undefined && (
        <p className="text-xs font-medium leading-5 text-white">Consultando costo cargado...</p>
      )}

      {knownUnitCost === null && (
        <AdminInfoBlock tone="warning">
          Costo desconocido para este producto. Cargá un costo de compra en Admin &gt; Costos para poder usar el
          porcentaje de ganancia neta.
        </AdminInfoBlock>
      )}

      {!isManual &&
        knownUnitCost != null &&
        targetMarginPercent.trim() !== "" &&
        !targetMarginResult && (
          <AdminInfoBlock tone="danger">
            Ese margen no es alcanzable con el costo y la financiación configurada. Probá un porcentaje menor o
            revisá las cuotas habilitadas.
          </AdminInfoBlock>
        )}

      {variantCostsDiffer && (
        <div className="space-y-1 rounded-lg border border-amber-400/25 bg-amber-400/[0.06] p-2.5">
          <p className="text-10px font-black uppercase tracking-widest text-white">
            Las variantes tienen costos distintos
          </p>
          {realVariantCosts.map((entry) => (
            <div key={entry.variantId} className="flex items-center justify-between text-sm">
              <span className="text-white">{entry.variantName ?? `Variante ${entry.variantId}`}</span>
              <span className="font-bold text-white">
                {entry.unitCost != null ? priceFormatter.format(entry.unitCost) : "Sin costo"}
              </span>
            </div>
          ))}
          <p className="text-xs font-medium leading-5 text-white">
            La rentabilidad usa el mayor costo conocido ({priceFormatter.format(knownUnitCost ?? 0)}) para no
            arriesgar el margen en ninguna variante.
          </p>
        </div>
      )}
    </AdminCard>
  )
}
