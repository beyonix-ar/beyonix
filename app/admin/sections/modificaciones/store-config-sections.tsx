"use client"

import { Boxes, Percent, Truck, Wallet } from "lucide-react"

import type { ShippingBonusSettings } from "@/lib/store-config"
import type {
  CustomerCreditPaymentSettings,
  PricingSettings,
  StockSettings,
} from "@/lib/site-settings"
import { getTransferPrice } from "@/lib/pricing/financed-pricing"
import type { ShippingQuoteSettings } from "@/lib/shipping/shipping-quote-settings"
import {
  buildShippingPriceBreakdown,
  markupPercentToBasisPoints,
  SHIPPING_MARKUP_MAX_PERCENT,
} from "@/lib/shipping/shipping-pricing"
import { AdminSelect, AdminTextInput } from "../../components/admin-controls"
import { AdminHelpTip } from "../../components/admin-help-tip"
import {
  ConfigChip,
  ConfigDisclosure,
  ConfigEditActions,
  ConfigSection,
  ConfigValueList,
  ConfigValueRow,
  formatARS,
  formatPercent,
  parseAmount,
  parsePercentage,
  sanitizeAmountInput,
  sanitizePercentInput,
  useConfigEditing,
  withInputSymbol,
  type ConfigFeedback,
} from "./config-ui"

export interface ConfigSectionProps<T> {
  saved: T
  disabled: boolean
  saving: boolean
  feedback: ConfigFeedback | null
  onSave: (value: T) => void
}

const iconClassName = "size-3.5"
/** Controles de edición: angostos en desktop, a ancho completo en mobile. */
const fieldClassName = "h-8 w-full text-right text-sm font-bold sm:w-36"

function MoneyInput({
  ariaLabel,
  value,
  disabled,
  onChange,
}: {
  ariaLabel: string
  value: string
  disabled: boolean
  onChange: (value: string) => void
}) {
  return (
    <AdminTextInput
      title={ariaLabel}
      ariaLabel={ariaLabel}
      value={withInputSymbol(value, "$")}
      placeholder="$ 0"
      inputMode="numeric"
      className={fieldClassName}
      disabled={disabled}
      onChange={(nextValue) => onChange(sanitizeAmountInput(nextValue))}
    />
  )
}

function PercentInput({
  ariaLabel,
  placeholder,
  value,
  disabled,
  onChange,
}: {
  ariaLabel: string
  placeholder: string
  value: string
  disabled: boolean
  onChange: (value: string) => void
}) {
  return (
    <AdminTextInput
      title={ariaLabel}
      ariaLabel={ariaLabel}
      value={withInputSymbol(value, "%")}
      placeholder={placeholder}
      inputMode="decimal"
      className={fieldClassName}
      disabled={disabled}
      onChange={(nextValue) => onChange(sanitizePercentInput(nextValue))}
    />
  )
}

// ─────────────────────────────────────────────────────────────
// Stock
// ─────────────────────────────────────────────────────────────

export function StockSection({ saved, disabled, saving, feedback, onSave }: ConfigSectionProps<StockSettings>) {
  const block = useConfigEditing({
    critical: String(saved.criticalStockThreshold),
    low: String(saved.lowStockThreshold),
  })
  const { critical, low } = block.draft
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
  const inputsDisabled = disabled || saving
  // Agrupado: un número de 2 dígitos no necesita un input a ancho completo.
  const stockInput = (label: "Crítico" | "Bajo", key: "critical" | "low") => (
    <span className="flex items-center gap-1.5">
      <span className="text-12px font-semibold text-white/62">hasta</span>
      <AdminTextInput
        title={`Stock ${label.toLowerCase()} hasta`}
        ariaLabel={label}
        value={block.draft[key]}
        placeholder="0"
        inputMode="numeric"
        maxLength={2}
        className="h-8 w-16 text-center text-sm font-bold"
        disabled={inputsDisabled}
        onChange={(value) => block.setField(key, value.replace(/\D/g, "").slice(0, 2))}
      />
      <span className="text-12px font-semibold text-white/62">u.</span>
    </span>
  )

  return (
    <ConfigSection
      icon={<Boxes className={iconClassName} />}
      title="Stock"
      feedback={feedback}
      data-config-block="stock"
      data-config-mode={block.editing ? "edit" : "read"}
      actions={
        <ConfigEditActions
          editing={block.editing}
          dirty={dirty}
          saving={saving}
          disabled={disabled}
          canSave={!invalid}
          onEdit={block.start}
          onCancel={block.cancel}
          onSave={() => onSave(next)}
        />
      }
    >
      <ConfigValueList>
        <ConfigValueRow label="Crítico" tone="danger" editing={block.editing} data-stock-state="critical">
          {block.editing ? stockInput("Crítico", "critical") : criticalValue > 0 ? `1 a ${criticalValue}` : "Sin rango"}
        </ConfigValueRow>
        <ConfigValueRow label="Bajo" tone="warning" editing={block.editing} data-stock-state="low">
          {block.editing ? stockInput("Bajo", "low") : lowValue > criticalValue ? `${criticalValue + 1} a ${lowValue}` : "Revisar"}
        </ConfigValueRow>
        <ConfigValueRow label="Disponible" tone="success" data-stock-state="available">
          {low ? `${lowValue + 1}+` : "—"}
        </ConfigValueRow>
      </ConfigValueList>
      {block.editing && invalid ? (
        <p role="alert" className="admin-config-feedback mt-1.5 text-12px font-semibold leading-4" data-tone="danger">
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
  const block = useConfigEditing({
    defaultCost: String(saved.defaultShippingCost),
    minAmount: String(saved.freeShippingMinAmount),
    bonusMax: String(saved.shippingBonusMax),
    baseSubsidy: String(saved.logisticsBaseSubsidy),
    mode: saved.freeShippingMode,
  })
  const { draft } = block
  const next: ShippingBonusSettings = {
    defaultShippingCost: parseAmount(draft.defaultCost),
    freeShippingMinAmount: parseAmount(draft.minAmount),
    shippingBonusMax: parseAmount(draft.bonusMax),
    freeShippingMode: draft.mode,
    logisticsBaseSubsidy: parseAmount(draft.baseSubsidy),
  }
  const dirty = (Object.keys(next) as Array<keyof ShippingBonusSettings>).some((key) => next[key] !== saved[key])
  const inputsDisabled = disabled || saving
  const active = next.freeShippingMode === "full"
  const { editing } = block

  return (
    <ConfigSection
      icon={<Truck className={iconClassName} />}
      title="Envíos"
      feedback={feedback}
      data-config-block="shipping"
      data-config-mode={editing ? "edit" : "read"}
      actions={
        <ConfigEditActions
          editing={editing}
          dirty={dirty}
          saving={saving}
          disabled={disabled}
          onEdit={block.start}
          onCancel={block.cancel}
          onSave={() => onSave(next)}
        />
      }
    >
      <p data-shipping-summary className="admin-config-callout mb-2 px-2.5 py-1.5 text-sm leading-5 text-white/80">
        {active ? (
          <>
            Desde <strong className="text-white">{formatARS(next.freeShippingMinAmount)}</strong> de compra, BEYONIX bonifica
            hasta <strong className="text-white">{formatARS(next.shippingBonusMax)}</strong> del envío.
          </>
        ) : next.logisticsBaseSubsidy > 0 ? (
          <>
            Sólo se aplica la bonificación base de <strong className="text-white">{formatARS(next.logisticsBaseSubsidy)}</strong>.
          </>
        ) : (
          "El cliente paga el costo real del envío."
        )}
      </p>

      <ConfigValueList>
        <ConfigValueRow label="Compra mínima" editing={editing}>
          {editing ? (
            <MoneyInput
              ariaLabel="Monto mínimo para acceder a envío bonificado"
              value={draft.minAmount}
              disabled={inputsDisabled}
              onChange={(value) => block.setField("minAmount", value)}
            />
          ) : (
            formatARS(next.freeShippingMinAmount)
          )}
        </ConfigValueRow>
        <ConfigValueRow label="Bonificación máxima" editing={editing}>
          {editing ? (
            <MoneyInput
              ariaLabel="Tope máximo de bonificación de envío"
              value={draft.bonusMax}
              disabled={inputsDisabled}
              onChange={(value) => block.setField("bonusMax", value)}
            />
          ) : (
            formatARS(next.shippingBonusMax)
          )}
        </ConfigValueRow>
        <ConfigValueRow label="Bonificación base" editing={editing}>
          {editing ? (
            <MoneyInput
              ariaLabel="Bonificación base de envío para compras por debajo del mínimo"
              value={draft.baseSubsidy}
              disabled={inputsDisabled}
              onChange={(value) => block.setField("baseSubsidy", value)}
            />
          ) : (
            formatARS(next.logisticsBaseSubsidy)
          )}
        </ConfigValueRow>
        <ConfigValueRow label="Estado" editing={editing}>
          {editing ? (
            <AdminSelect
              title="Estado de la bonificación"
              value={draft.mode}
              centered
              leadingIcon={<span className="admin-config-dot size-2 rounded-full" data-tone={active ? "success" : "neutral"} />}
              wrapperClassName="w-full sm:w-36"
              triggerClassName="admin-modifications-status-select !h-8 !min-h-8 !text-sm !font-bold"
              optionClassName="font-bold hover:!bg-beyonix-blue/25"
              disabled={inputsDisabled}
              onChange={(value) => block.setField("mode", value === "off" ? "off" : "full")}
            >
              <option value="full">Activa</option>
              <option value="off">Desactivada</option>
            </AdminSelect>
          ) : (
            <ConfigChip tone={active ? "success" : "neutral"} data-shipping-state={active ? "active" : "inactive"}>
              {active ? "Activa" : "Desactivada"}
            </ConfigChip>
          )}
        </ConfigValueRow>
      </ConfigValueList>

      <ConfigDisclosure summary="Ver costo de referencia" className="mt-1.5" data-shipping-reference>
        <ConfigValueList>
          <ConfigValueRow label="Costo predeterminado" editing={editing}>
            {editing ? (
              <MoneyInput
                ariaLabel="Costo de envío predeterminado"
                value={draft.defaultCost}
                disabled={inputsDisabled}
                onChange={(value) => block.setField("defaultCost", value)}
              />
            ) : (
              formatARS(next.defaultShippingCost)
            )}
          </ConfigValueRow>
        </ConfigValueList>
        <p className="text-white/62">Se usa sin cotización; Andreani informa su costo real.</p>
      </ConfigDisclosure>
    </ConfigSection>
  )
}

// ─────────────────────────────────────────────────────────────
// Precios y transferencia
// ─────────────────────────────────────────────────────────────

const PRICING_PREVIEW_AMOUNT = 75_000

export function PricingSection({ saved, disabled, saving, feedback, onSave }: ConfigSectionProps<PricingSettings>) {
  const block = useConfigEditing({
    transferDiscount: String(saved.transferDiscountPercent),
    taxesIncidence: String(saved.nationalTaxesIncidencePercent),
  })
  const { draft, editing } = block
  const next: PricingSettings = {
    transferDiscountPercent: parsePercentage(draft.transferDiscount),
    nationalTaxesIncidencePercent: parsePercentage(draft.taxesIncidence),
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
      data-config-mode={editing ? "edit" : "read"}
      actions={
        <ConfigEditActions
          editing={editing}
          dirty={dirty}
          saving={saving}
          disabled={disabled}
          onEdit={block.start}
          onCancel={block.cancel}
          onSave={() => onSave(next)}
        />
      }
    >
      <ConfigValueList>
        <ConfigValueRow label="Transferencia" editing={editing}>
          {editing ? (
            <PercentInput
              ariaLabel="Descuento por transferencia"
              placeholder="% 10"
              value={draft.transferDiscount}
              disabled={inputsDisabled}
              onChange={(value) => block.setField("transferDiscount", value)}
            />
          ) : (
            `${formatPercent(next.transferDiscountPercent)} OFF`
          )}
        </ConfigValueRow>
        <ConfigValueRow label="Impuestos nacionales (leyenda legal)" editing={editing}>
          {editing ? (
            <PercentInput
              ariaLabel="Incidencia de impuestos nacionales para exhibición"
              placeholder="% 21"
              value={draft.taxesIncidence}
              disabled={inputsDisabled}
              onChange={(value) => block.setField("taxesIncidence", value)}
            />
          ) : (
            formatPercent(next.nationalTaxesIncidencePercent)
          )}
        </ConfigValueRow>
        <ConfigValueRow label="Ejemplo" data-pricing-example>
          {formatARS(PRICING_PREVIEW_AMOUNT)} → {formatARS(getTransferPrice(PRICING_PREVIEW_AMOUNT, next.transferDiscountPercent))}
        </ConfigValueRow>
      </ConfigValueList>
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
  const block = useConfigEditing({
    surcharge: String(saved.mercadoPagoSurchargePercent),
    minimum: String(saved.mercadoPagoMinimumAmount),
  })
  const { draft, editing } = block
  const next: CustomerCreditPaymentSettings = {
    mercadoPagoSurchargePercent: parsePercentage(draft.surcharge),
    mercadoPagoMinimumAmount: parseAmount(draft.minimum),
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
      data-config-mode={editing ? "edit" : "read"}
      actions={
        <ConfigEditActions
          editing={editing}
          dirty={dirty}
          saving={saving}
          disabled={disabled}
          onEdit={block.start}
          onCancel={block.cancel}
          onSave={() => onSave(next)}
        />
      }
    >
      <ConfigValueList>
        <ConfigValueRow label="Recargo" editing={editing}>
          {editing ? (
            <PercentInput
              ariaLabel="Recargo de las recargas de saldo con Mercado Pago"
              placeholder="% 0"
              value={draft.surcharge}
              disabled={inputsDisabled}
              onChange={(value) => block.setField("surcharge", value)}
            />
          ) : (
            formatPercent(next.mercadoPagoSurchargePercent)
          )}
        </ConfigValueRow>
        <ConfigValueRow label="Importe mínimo" editing={editing}>
          {editing ? (
            <MoneyInput
              ariaLabel="Importe mínimo de recarga con Mercado Pago"
              value={draft.minimum}
              disabled={inputsDisabled}
              onChange={(value) => block.setField("minimum", value)}
            />
          ) : (
            formatARS(next.mercadoPagoMinimumAmount)
          )}
        </ConfigValueRow>
      </ConfigValueList>
    </ConfigSection>
  )
}

// ─────────────────────────────────────────────────────────────
// Cotización de envíos
// ─────────────────────────────────────────────────────────────

const MARKUP_PREVIEW_PROVIDER_AMOUNT = 10_000
const MARKUP_HELP =
  "Porcentaje adicional aplicado a la tarifa de Andreani para cubrir embalaje, traslados y costos operativos."

/** Mismo cálculo que el servidor (centavos y puntos básicos). null si es inválido. */
function parseMarkupDraft(value: string): number | null {
  if (!value.trim()) return null
  try {
    return markupPercentToBasisPoints(value) / 100
  } catch {
    return null
  }
}

export function ShippingQuoteSection({ saved, disabled, saving, feedback, onSave }: ConfigSectionProps<ShippingQuoteSettings>) {
  const block = useConfigEditing({ markup: String(saved.logisticsMarkupPercent).replace(".", ",") })
  const { draft, editing } = block
  const markupPercent = parseMarkupDraft(draft.markup)
  const invalid = markupPercent === null
  const shownPercent = markupPercent ?? saved.logisticsMarkupPercent
  // Mismo cálculo que el servidor: tarifa + recargo exacto, redondeado a $10.
  const preview = buildShippingPriceBreakdown(MARKUP_PREVIEW_PROVIDER_AMOUNT, Math.round(shownPercent * 100))
  const dirty = !invalid && markupPercent !== saved.logisticsMarkupPercent
  const inputsDisabled = disabled || saving

  return (
    <ConfigSection
      icon={<Truck className={iconClassName} />}
      title="Cotización de envíos"
      feedback={feedback}
      data-config-block="shipping-quote"
      data-config-mode={editing ? "edit" : "read"}
      actions={
        <ConfigEditActions
          editing={editing}
          dirty={dirty}
          saving={saving}
          disabled={disabled}
          canSave={!invalid}
          onEdit={block.start}
          onCancel={block.cancel}
          onSave={() => markupPercent !== null && onSave({ logisticsMarkupPercent: markupPercent })}
        />
      }
    >
      <p className="mb-2 text-12px leading-4 text-white/62">{MARKUP_HELP}</p>
      <ConfigValueList>
        <ConfigValueRow
          label={<>Recargo logístico <AdminHelpTip label="Recargo logístico" text="Se suma a la tarifa de Andreani en cada cotización. Las órdenes ya creadas conservan su porcentaje." /></>}
          editing={editing}
        >
          {editing ? (
            <PercentInput
              ariaLabel="Recargo logístico sobre la tarifa de Andreani"
              placeholder="% 0"
              value={draft.markup}
              disabled={inputsDisabled}
              onChange={(value) => block.setField("markup", value)}
            />
          ) : (
            formatPercent(saved.logisticsMarkupPercent)
          )}
        </ConfigValueRow>
        <ConfigValueRow label="Ejemplo" data-shipping-quote-example>
          {formatARS(MARKUP_PREVIEW_PROVIDER_AMOUNT)} → {formatARS(preview.logisticsCents / 100)}
        </ConfigValueRow>
      </ConfigValueList>
      {editing && invalid ? (
        <p role="alert" className="admin-config-feedback mt-1.5 text-12px font-semibold leading-4" data-tone="danger">
          Ingresá un porcentaje entre 0 y {SHIPPING_MARKUP_MAX_PERCENT}, con hasta 2 decimales.
        </p>
      ) : (
        <p className="mt-1.5 text-12px leading-4 text-white/62">
          El resultado se redondea al múltiplo de $10 y después se aplica la bonificación de envío vigente.
        </p>
      )}
    </ConfigSection>
  )
}
