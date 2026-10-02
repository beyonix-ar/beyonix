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
  ConfigChip,
  ConfigDisclosure,
  ConfigSaveActions,
  ConfigSection,
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

const fieldLabelClassName = "mb-1 text-11px"
const fieldHelpClassName = "mt-1 text-12px leading-4"
const inputClassName = "text-center text-sm font-bold"
const iconClassName = "size-3.5"

function MoneyField({
  label,
  help,
  ariaLabel,
  value,
  disabled,
  onChange,
}: {
  label: string
  help?: string
  ariaLabel: string
  value: string
  disabled: boolean
  onChange: (value: string) => void
}) {
  return (
    <AdminFormField label={label} help={help} labelClassName={fieldLabelClassName} helpClassName={fieldHelpClassName}>
      <AdminTextInput
        title={label}
        ariaLabel={ariaLabel}
        value={withInputSymbol(value, "$")}
        placeholder="$ 0"
        inputMode="numeric"
        className={inputClassName}
        disabled={disabled}
        onChange={(nextValue) => onChange(sanitizeAmountInput(nextValue))}
      />
    </AdminFormField>
  )
}

function PercentField({
  label,
  help,
  title,
  ariaLabel,
  placeholder,
  value,
  disabled,
  onChange,
}: {
  label: string
  help?: string
  title: string
  ariaLabel: string
  placeholder: string
  value: string
  disabled: boolean
  onChange: (value: string) => void
}) {
  return (
    <AdminFormField label={label} help={help} labelClassName={fieldLabelClassName} helpClassName={fieldHelpClassName}>
      <AdminTextInput
        title={title}
        ariaLabel={ariaLabel}
        value={withInputSymbol(value, "%")}
        placeholder={placeholder}
        inputMode="decimal"
        className={inputClassName}
        disabled={disabled}
        onChange={(nextValue) => onChange(sanitizePercentInput(nextValue))}
      />
    </AdminFormField>
  )
}

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
    <label className="admin-config-tile admin-stock-threshold-box flex min-w-0 flex-col items-center gap-0.5 px-2 py-1.5" data-tone={tone}>
      <span className="flex items-center gap-1.5 text-11px font-black text-white/70">
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
        className="admin-config-stock-input w-full min-w-0 bg-transparent text-center text-lg font-black text-white outline-none disabled:opacity-80"
      />
      <span className="text-12px font-semibold text-white/62">{range}</span>
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
      icon={<Boxes className={iconClassName} />}
      title="Stock"
      feedback={feedback}
      data-config-block="stock"
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
      {invalid ? (
        <p role="alert" className="admin-config-feedback mt-2 text-12px font-semibold leading-4" data-tone="danger">
          El stock crítico debe ser menor que el stock bajo.
        </p>
      ) : null}
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

  return (
    <ConfigSection
      icon={<Truck className={iconClassName} />}
      title="Envíos"
      summary={<ConfigChip tone={active ? "success" : "neutral"}>{active ? "Bonificación activa" : "Bonificación desactivada"}</ConfigChip>}
      feedback={feedback}
      data-config-block="shipping"
      actions={<ConfigSaveActions dirty={dirty} saving={saving} disabled={disabled} onSave={() => onSave(next)} />}
    >
      <p data-shipping-summary className="mb-3 text-sm leading-5 text-white/80">
        {active ? (
          <>
            Desde <strong className="text-white">{formatARS(next.freeShippingMinAmount)}</strong> de compra, BEYONIX bonifica
            hasta <strong className="text-white">{formatARS(next.shippingBonusMax)}</strong> del envío.
            {next.logisticsBaseSubsidy > 0 ? (
              <> Debajo, bonificación base de <strong className="text-white">{formatARS(next.logisticsBaseSubsidy)}</strong>.</>
            ) : null}
          </>
        ) : next.logisticsBaseSubsidy > 0 ? (
          <>
            Sólo se aplica la bonificación base de <strong className="text-white">{formatARS(next.logisticsBaseSubsidy)}</strong>.
          </>
        ) : (
          "El cliente paga el costo real del envío."
        )}
      </p>

      <div className="grid grid-cols-2 gap-x-3 gap-y-2.5">
        <MoneyField
          label="Compra mínima"
          ariaLabel="Monto mínimo para acceder a envío bonificado"
          value={minAmount}
          disabled={inputsDisabled}
          onChange={setMinAmount}
        />
        <MoneyField
          label="Bonificación máxima"
          ariaLabel="Tope máximo de bonificación de envío"
          value={bonusMax}
          disabled={inputsDisabled}
          onChange={setBonusMax}
        />
        <MoneyField
          label="Bonificación base"
          help="Debajo de la compra mínima."
          ariaLabel="Bonificación base de envío para compras por debajo del mínimo"
          value={baseSubsidy}
          disabled={inputsDisabled}
          onChange={setBaseSubsidy}
        />
        <AdminFormField label="Estado" labelClassName={fieldLabelClassName}>
          <AdminSelect
            title="Estado de la bonificación"
            value={mode}
            centered
            leadingIcon={<span className="admin-config-dot size-2 rounded-full" data-tone={active ? "success" : "neutral"} />}
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

      <ConfigDisclosure summary="Costo de envío de referencia" className="mt-2.5" data-shipping-reference>
        <div className="max-w-56">
          <MoneyField
            label="Costo predeterminado"
            help="Sin cotización; Andreani usa su costo real."
            ariaLabel="Costo de envío predeterminado"
            value={defaultCost}
            disabled={inputsDisabled}
            onChange={setDefaultCost}
          />
        </div>
      </ConfigDisclosure>
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
      icon={<Percent className={iconClassName} />}
      title="Precios y transferencia"
      feedback={feedback}
      data-config-block="pricing"
      actions={<ConfigSaveActions dirty={dirty} saving={saving} disabled={disabled} onSave={() => onSave(next)} />}
    >
      <div className="grid grid-cols-2 gap-x-3 gap-y-2.5">
        <PercentField
          label="Descuento transferencia"
          title="Descuento por transferencia"
          ariaLabel="Descuento por transferencia"
          placeholder="% 10"
          value={transferDiscount}
          disabled={inputsDisabled}
          onChange={setTransferDiscount}
        />
        <PercentField
          label="Impuestos nacionales"
          help="Sólo para la leyenda legal."
          title="Incidencia de impuestos nacionales"
          ariaLabel="Incidencia de impuestos nacionales para exhibición"
          placeholder="% 21"
          value={taxesIncidence}
          disabled={inputsDisabled}
          onChange={setTaxesIncidence}
        />
      </div>
      <p data-pricing-example className="mt-2.5 text-sm text-white/80">
        Contado {formatARS(PRICING_PREVIEW_AMOUNT)} → Transferencia{" "}
        <strong className="text-white">{formatARS(getTransferPrice(PRICING_PREVIEW_AMOUNT, next.transferDiscountPercent))}</strong>
      </p>
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
      icon={<Wallet className={iconClassName} />}
      title="Recargas de saldo"
      feedback={feedback}
      data-config-block="customer-credit"
      actions={<ConfigSaveActions dirty={dirty} saving={saving} disabled={disabled} onSave={() => onSave(next)} />}
    >
      <div className="grid grid-cols-2 gap-x-3 gap-y-2.5">
        <PercentField
          label="Recargo"
          title="Recargo de recargas MP"
          ariaLabel="Recargo de las recargas de saldo con Mercado Pago"
          placeholder="% 0"
          value={surcharge}
          disabled={inputsDisabled}
          onChange={setSurcharge}
        />
        <MoneyField
          label="Importe mínimo"
          ariaLabel="Importe mínimo de recarga con Mercado Pago"
          value={minimum}
          disabled={inputsDisabled}
          onChange={setMinimum}
        />
      </div>
    </ConfigSection>
  )
}
