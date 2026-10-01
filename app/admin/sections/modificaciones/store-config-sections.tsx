"use client"

import { useState } from "react"
import { Boxes, Percent, Truck, Wallet } from "lucide-react"

import type { ShippingBonusSettings } from "@/lib/store-config"
import type {
  CustomerCreditPaymentSettings,
  PricingSettings,
  StockSettings,
} from "@/lib/site-settings"
import { getTransferPrice } from "@/lib/pricing/financed-pricing"
import {
  AdminFormField,
  AdminSelect,
  AdminTextInput,
} from "../../components/admin-controls"
import {
  ConfigSaveActions,
  ConfigSection,
  ConfigSummary,
  formatARS,
  parseAmount,
  parsePercentage,
  sanitizeAmountInput,
  sanitizePercentInput,
  withInputSymbol,
  type ConfigFeedback,
  type ConfigTone,
} from "./config-ui"

export interface ConfigSectionProps<T> {
  saved: T
  disabled: boolean
  saving: boolean
  feedback: ConfigFeedback | null
  onSave: (value: T) => void
}

const fieldLabelClassName = "mb-1.5 text-11px"
const fieldHelpClassName = "mt-1 text-12px leading-4"
const inputClassName = "text-center text-sm font-bold"

// ─────────────────────────────────────────────────────────────
// Stock
// ─────────────────────────────────────────────────────────────

interface StockTileProps {
  label: string
  tone: ConfigTone
  value: string
  range: string
  disabled: boolean
  readOnly?: boolean
  onChange?: (value: string) => void
}

function StockTile({ label, tone, value, range, disabled, readOnly = false, onChange }: StockTileProps) {
  return (
    <label className="admin-config-tile admin-stock-threshold-box flex min-w-0 flex-col items-center gap-0.5 px-3 py-2" data-tone={tone}>
      <span className="flex items-center gap-1.5 text-10px font-black uppercase tracking-widest text-white/60">
        <span className="admin-config-dot size-1.5 rounded-full" data-tone={tone} />
        {label}
      </span>
      <input
        type="text"
        aria-label={label}
        inputMode="numeric"
        maxLength={2}
        value={value}
        disabled={disabled || readOnly}
        readOnly={readOnly}
        onChange={(event) => onChange?.(event.target.value.replace(/\D/g, "").slice(0, 2))}
        className="admin-config-stock-input w-full min-w-0 bg-transparent text-center text-xl font-black text-white outline-none disabled:opacity-80"
      />
      <span className="text-12px font-semibold text-white/60">{range}</span>
    </label>
  )
}

export function StockSection({ saved, disabled, saving, feedback, onSave }: ConfigSectionProps<StockSettings>) {
  const [critical, setCritical] = useState(String(saved.criticalStockThreshold))
  const [low, setLow] = useState(String(saved.lowStockThreshold))
  const criticalValue = parseAmount(critical)
  const lowValue = Math.min(98, parseAmount(low))
  const next: StockSettings = {
    criticalStockThreshold: criticalValue,
    lowStockThreshold: lowValue,
    availableStockThreshold: lowValue + 1,
  }
  const invalid = !critical || !low || criticalValue >= lowValue
  const dirty =
    next.criticalStockThreshold !== saved.criticalStockThreshold ||
    next.lowStockThreshold !== saved.lowStockThreshold

  return (
    <ConfigSection
      icon={<Boxes className="size-3.5" />}
      eyebrow="Inventario"
      title="Stock"
      description="Cuándo cambia el estado de stock en el panel y en la tienda."
      feedback={feedback}
      actions={
        <ConfigSaveActions dirty={dirty} saving={saving} disabled={disabled || invalid} onSave={() => onSave(next)} />
      }
    >
      <div className="grid grid-cols-3 gap-2">
        <StockTile
          label="Crítico"
          tone="danger"
          value={critical}
          range={criticalValue > 0 ? `1 a ${criticalValue} u.` : "Sin rango"}
          disabled={disabled || saving}
          onChange={setCritical}
        />
        <StockTile
          label="Bajo"
          tone="warning"
          value={low}
          range={lowValue > criticalValue ? `${criticalValue + 1} a ${lowValue} u.` : "Revisar"}
          disabled={disabled || saving}
          onChange={setLow}
        />
        <StockTile
          label="Disponible"
          tone="success"
          value={low ? String(lowValue + 1) : ""}
          range={low ? `Desde ${lowValue + 1} u.` : "—"}
          disabled={disabled || saving}
          readOnly
        />
      </div>
      <p className={`mt-2 text-12px leading-4 ${invalid ? "font-semibold text-red-200" : "text-white/58"}`}>
        {invalid
          ? "El stock crítico debe ser menor que el stock bajo."
          : "Editá crítico y bajo; disponible se calcula solo (bajo + 1)."}
      </p>
    </ConfigSection>
  )
}

// ─────────────────────────────────────────────────────────────
// Envíos
// ─────────────────────────────────────────────────────────────

export function ShippingSection({ saved, disabled, saving, feedback, onSave }: ConfigSectionProps<ShippingBonusSettings>) {
  const [defaultCost, setDefaultCost] = useState(String(saved.defaultShippingCost))
  const [minAmount, setMinAmount] = useState(String(saved.freeShippingMinAmount))
  const [bonusMax, setBonusMax] = useState(String(saved.shippingBonusMax))
  const [baseSubsidy, setBaseSubsidy] = useState(String(saved.logisticsBaseSubsidy))
  const [mode, setMode] = useState(saved.freeShippingMode)
  const next: ShippingBonusSettings = {
    defaultShippingCost: parseAmount(defaultCost),
    freeShippingMinAmount: parseAmount(minAmount),
    shippingBonusMax: parseAmount(bonusMax),
    freeShippingMode: mode,
    logisticsBaseSubsidy: parseAmount(baseSubsidy),
  }
  const dirty = (Object.keys(next) as Array<keyof ShippingBonusSettings>).some((key) => next[key] !== saved[key])
  const inputsDisabled = disabled || saving
  const active = next.freeShippingMode === "full"

  const moneyField = (
    label: string,
    help: string,
    value: string,
    onChange: (value: string) => void,
    ariaLabel: string,
  ) => (
    <AdminFormField label={label} help={help} labelClassName={fieldLabelClassName} helpClassName={fieldHelpClassName}>
      <AdminTextInput
        title={label}
        ariaLabel={ariaLabel}
        value={withInputSymbol(value, "$")}
        placeholder="$ 0"
        inputMode="numeric"
        className={inputClassName}
        disabled={inputsDisabled}
        onChange={(nextValue) => onChange(sanitizeAmountInput(nextValue))}
      />
    </AdminFormField>
  )

  return (
    <ConfigSection
      icon={<Truck className="size-3.5" />}
      eyebrow="Comercial"
      title="Envíos"
      description="Bonificación del envío según el monto de compra."
      feedback={feedback}
      actions={<ConfigSaveActions dirty={dirty} saving={saving} disabled={disabled} onSave={() => onSave(next)} />}
    >
      <ConfigSummary className="mb-3">
        <p className="flex items-center gap-1.5 font-bold text-white">
          <span className="admin-config-dot size-1.5 rounded-full" data-tone={active ? "success" : "neutral"} />
          {active ? "Bonificación por monto activa" : "Bonificación por monto desactivada"}
        </p>
        <p className="mt-0.5">
          {active ? (
            <>
              Desde <strong className="text-white">{formatARS(next.freeShippingMinAmount)}</strong> de compra, BEYONIX bonifica
              hasta <strong className="text-beyonix-cyan">{formatARS(next.shippingBonusMax)}</strong> del envío.{" "}
              {next.logisticsBaseSubsidy > 0 ? (
                <>
                  Por debajo de ese monto, absorbe una bonificación base de{" "}
                  <strong className="text-beyonix-cyan">{formatARS(next.logisticsBaseSubsidy)}</strong>.
                </>
              ) : (
                "Por debajo de ese monto, el cliente paga el costo real del envío."
              )}
            </>
          ) : next.logisticsBaseSubsidy > 0 ? (
            <>
              En todas las compras se aplica sólo la bonificación base de{" "}
              <strong className="text-beyonix-cyan">{formatARS(next.logisticsBaseSubsidy)}</strong>.
            </>
          ) : (
            "El cliente paga el costo real del envío en todas las compras."
          )}
        </p>
      </ConfigSummary>

      <div className="grid grid-cols-2 gap-3">
        {moneyField("Compra mínima", "Activa la bonificación.", minAmount, setMinAmount, "Monto mínimo para acceder a envío bonificado")}
        {moneyField("Bonificación máxima", "Tope que cubre BEYONIX.", bonusMax, setBonusMax, "Tope máximo de bonificación de envío")}
        {moneyField("Bonificación base", "Debajo del mínimo.", baseSubsidy, setBaseSubsidy, "Bonificación base de envío para compras por debajo del mínimo")}
        <AdminFormField label="Estado" help="Bonificación por monto." labelClassName={fieldLabelClassName} helpClassName={fieldHelpClassName}>
          <AdminSelect
            title="Estado de la bonificación"
            value={mode}
            centered
            leadingIcon={
              <span
                className={`size-2 rounded-full shadow-[0_0_10px_currentColor] ${
                  active ? "bg-emerald-400 text-emerald-400" : "bg-white/35 text-white/35"
                }`}
              />
            }
            triggerClassName="admin-modifications-status-select !text-sm !font-bold"
            optionClassName="font-bold hover:!bg-beyonix-blue/25"
            disabled={inputsDisabled}
            onChange={(value) => setMode(value === "off" ? "off" : "full")}
          >
            <option value="full">Activa</option>
            <option value="off">Desactivada</option>
          </AdminSelect>
        </AdminFormField>
      </div>

      <details className="admin-config-details mt-3 text-12px leading-5 text-white/62">
        <summary className="cursor-pointer font-bold text-white/72">Costo de envío de referencia</summary>
        <div className="mt-2 max-w-xs">
          {moneyField(
            "Costo predeterminado",
            "Referencia cuando no hay cotización; Andreani usa el costo real que informa.",
            defaultCost,
            setDefaultCost,
            "Costo de envío predeterminado",
          )}
        </div>
      </details>
    </ConfigSection>
  )
}

// ─────────────────────────────────────────────────────────────
// Precios y transferencia
// ─────────────────────────────────────────────────────────────

const PRICING_PREVIEW_AMOUNT = 75_000

export function PricingSection({ saved, disabled, saving, feedback, onSave }: ConfigSectionProps<PricingSettings>) {
  const [transferDiscount, setTransferDiscount] = useState(String(saved.transferDiscountPercent))
  const [taxesIncidence, setTaxesIncidence] = useState(String(saved.nationalTaxesIncidencePercent))
  const next: PricingSettings = {
    transferDiscountPercent: parsePercentage(transferDiscount),
    nationalTaxesIncidencePercent: parsePercentage(taxesIncidence),
  }
  const dirty =
    next.transferDiscountPercent !== saved.transferDiscountPercent ||
    next.nationalTaxesIncidencePercent !== saved.nationalTaxesIncidencePercent
  const inputsDisabled = disabled || saving

  return (
    <ConfigSection
      icon={<Percent className="size-3.5" />}
      eyebrow="Comercial"
      title="Precios y transferencia"
      description="Descuento por transferencia y leyenda legal de impuestos."
      feedback={feedback}
      actions={<ConfigSaveActions dirty={dirty} saving={saving} disabled={disabled} onSave={() => onSave(next)} />}
    >
      <div className="grid grid-cols-2 gap-3">
        <AdminFormField label="Descuento transferencia" help="Sobre el precio de contado." labelClassName={fieldLabelClassName} helpClassName={fieldHelpClassName}>
          <AdminTextInput
            title="Descuento por transferencia"
            ariaLabel="Descuento por transferencia"
            value={withInputSymbol(transferDiscount, "%")}
            placeholder="% 10"
            inputMode="decimal"
            className={inputClassName}
            disabled={inputsDisabled}
            onChange={(value) => setTransferDiscount(sanitizePercentInput(value))}
          />
        </AdminFormField>
        <AdminFormField label="Impuestos nacionales" help="Sólo para la leyenda legal." labelClassName={fieldLabelClassName} helpClassName={fieldHelpClassName}>
          <AdminTextInput
            title="Incidencia de impuestos nacionales"
            ariaLabel="Incidencia de impuestos nacionales para exhibición"
            value={withInputSymbol(taxesIncidence, "%")}
            placeholder="% 21"
            inputMode="decimal"
            className={inputClassName}
            disabled={inputsDisabled}
            onChange={(value) => setTaxesIncidence(sanitizePercentInput(value))}
          />
        </AdminFormField>
      </div>
      <ConfigSummary className="mt-3">
        Contado de {formatARS(PRICING_PREVIEW_AMOUNT)} →{" "}
        <strong className="text-beyonix-cyan">
          {formatARS(getTransferPrice(PRICING_PREVIEW_AMOUNT, next.transferDiscountPercent))}
        </strong>{" "}
        por transferencia. La incidencia de impuestos sólo calcula la leyenda &quot;Precio sin impuestos
        nacionales&quot;: confirmala con tu contador.
      </ConfigSummary>
    </ConfigSection>
  )
}

// ─────────────────────────────────────────────────────────────
// Recargas de saldo
// ─────────────────────────────────────────────────────────────

export function CustomerCreditSection({
  saved,
  disabled,
  saving,
  feedback,
  onSave,
}: ConfigSectionProps<CustomerCreditPaymentSettings>) {
  const [surcharge, setSurcharge] = useState(String(saved.mercadoPagoSurchargePercent))
  const [minimum, setMinimum] = useState(String(saved.mercadoPagoMinimumAmount))
  const next: CustomerCreditPaymentSettings = {
    mercadoPagoSurchargePercent: parsePercentage(surcharge),
    mercadoPagoMinimumAmount: parseAmount(minimum),
  }
  const dirty =
    next.mercadoPagoSurchargePercent !== saved.mercadoPagoSurchargePercent ||
    next.mercadoPagoMinimumAmount !== saved.mercadoPagoMinimumAmount
  const inputsDisabled = disabled || saving

  return (
    <ConfigSection
      icon={<Wallet className="size-3.5" />}
      eyebrow="Pagos"
      title="Recargas de saldo"
      description="Condiciones de las recargas con Mercado Pago."
      feedback={feedback}
      actions={<ConfigSaveActions dirty={dirty} saving={saving} disabled={disabled} onSave={() => onSave(next)} />}
    >
      <div className="grid grid-cols-2 gap-3">
        <AdminFormField label="Recargo" help="Entre 0 y 100%." labelClassName={fieldLabelClassName} helpClassName={fieldHelpClassName}>
          <AdminTextInput
            title="Recargo de recargas MP"
            ariaLabel="Recargo de las recargas de saldo con Mercado Pago"
            value={withInputSymbol(surcharge, "%")}
            placeholder="% 0"
            inputMode="decimal"
            className={inputClassName}
            disabled={inputsDisabled}
            onChange={(value) => setSurcharge(sanitizePercentInput(value))}
          />
        </AdminFormField>
        <AdminFormField label="Importe mínimo" help="Por recarga." labelClassName={fieldLabelClassName} helpClassName={fieldHelpClassName}>
          <AdminTextInput
            title="Importe mínimo MP"
            ariaLabel="Importe mínimo de recarga con Mercado Pago"
            value={withInputSymbol(minimum, "$")}
            placeholder="$ 0"
            inputMode="numeric"
            className={inputClassName}
            disabled={inputsDisabled}
            onChange={(value) => setMinimum(sanitizeAmountInput(value))}
          />
        </AdminFormField>
      </div>
      <p className="mt-2 text-12px leading-4 text-white/58">No modifica credenciales ni la integración de pagos.</p>
    </ConfigSection>
  )
}
