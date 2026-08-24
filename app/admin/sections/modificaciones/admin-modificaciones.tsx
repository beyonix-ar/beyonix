"use client"

import { useEffect, useState } from "react"
import { Boxes, ImageIcon, Save, Truck } from "lucide-react"

import { supabase } from "@/lib/supabase/client"
import {
  DEFAULT_SHIPPING_SETTINGS,
  type ShippingBonusSettings,
} from "@/lib/store-config"
import {
  DEFAULT_CUSTOMER_CREDIT_PAYMENT_SETTINGS,
  DEFAULT_STOCK_SETTINGS,
  type CustomerCreditPaymentSettings,
  type StockSettings,
} from "@/lib/site-settings"
import { invalidateSiteSettingsClientCache } from "@/hooks/use-site-settings"
import {
  AdminFormField,
  AdminInfoBlock,
  AdminPageHeader,
  AdminPrimaryButton,
  AdminSection,
  AdminSelect,
  AdminTextInput,
} from "../../components/admin-controls"
import { AdminBanners } from "../banners/admin-banners"
import { AndreaniIntegrationCard } from "./andreani-integration-card"

interface SettingsResponse {
  settings?: {
    shipping?: ShippingBonusSettings
    customerCreditPayments?: CustomerCreditPaymentSettings
    stock?: StockSettings
  }
  error?: string
}

function toInputValue(value: number) {
  return Number.isFinite(value) ? String(Math.round(value)) : "0"
}

function normalizeAmount(value: string) {
  const amount = Number.parseInt(value.replace(/[^\d]/g, ""), 10)

  return Number.isFinite(amount) && amount >= 0 ? amount : 0
}

function normalizePercentage(value: string) {
  const percentage = Number(value.replace(",", "."))
  return Number.isFinite(percentage)
    ? Math.min(100, Math.max(0, Math.round(percentage * 100) / 100))
    : 0
}

function normalizeTwoDigits(value: string) {
  return value.replace(/\D/g, "").slice(0, 2)
}

function withInputSymbol(value: string, symbol: "$" | "%") {
  return value ? `${symbol} ${value}` : ""
}

function normalizeNumericInput(value: string) {
  return value.replace(/\D/g, "")
}

const formatARS = (value: number) =>
  new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    maximumFractionDigits: 0,
  }).format(value)

const compactInputClassName = "h-9 text-sm"
const compactLabelClassName = "mb-1.5 text-12px"
const compactHelpClassName = "mt-1 text-12px leading-4"

type StockTone = "critical" | "low" | "available"

const stockToneClassNames: Record<StockTone, { border: string; text: string }> = {
  critical: {
    border: "border-red-500/40 focus-within:border-red-400/75",
    text: "text-red-200",
  },
  low: {
    border: "border-amber-500/40 focus-within:border-amber-400/75",
    text: "text-amber-200",
  },
  available: {
    border: "border-emerald-500/40 focus-within:border-emerald-400/75",
    text: "text-emerald-200",
  },
}

interface StockThresholdBoxProps {
  label: string
  value: string
  tone: StockTone
  disabled: boolean
  onChange: (value: string) => void
}

function StockThresholdBox({ label, value, tone, disabled, onChange }: StockThresholdBoxProps) {
  const toneClassNames = stockToneClassNames[tone]

  return (
    <label
      className={`admin-stock-threshold-box flex w-auto min-w-28 shrink-0 flex-col items-center justify-center gap-1 rounded-lg border bg-white/[0.02] px-3.5 py-2 transition-colors ${toneClassNames.border}`}
    >
      <span className="whitespace-nowrap text-11px font-bold uppercase tracking-wide text-white/50">{label}</span>
      <input
        type="text"
        aria-label={label}
        inputMode="numeric"
        maxLength={2}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className={`w-full min-w-0 bg-transparent text-center text-lg font-black outline-none disabled:opacity-45 ${toneClassNames.text}`}
      />
    </label>
  )
}

export function AdminModificaciones() {
  const [defaultShippingCost, setDefaultShippingCost] = useState(
    toInputValue(DEFAULT_SHIPPING_SETTINGS.defaultShippingCost),
  )
  const [freeShippingMinAmount, setFreeShippingMinAmount] = useState(
    toInputValue(DEFAULT_SHIPPING_SETTINGS.freeShippingMinAmount),
  )
  const [shippingBonusMax, setShippingBonusMax] = useState(
    toInputValue(DEFAULT_SHIPPING_SETTINGS.shippingBonusMax),
  )
  const [freeShippingMode, setFreeShippingMode] = useState(
    DEFAULT_SHIPPING_SETTINGS.freeShippingMode,
  )
  const [logisticsBaseSubsidy, setLogisticsBaseSubsidy] = useState(
    toInputValue(DEFAULT_SHIPPING_SETTINGS.logisticsBaseSubsidy),
  )
  const [mercadoPagoSurchargePercent, setMercadoPagoSurchargePercent] = useState(
    String(DEFAULT_CUSTOMER_CREDIT_PAYMENT_SETTINGS.mercadoPagoSurchargePercent),
  )
  const [mercadoPagoMinimumAmount, setMercadoPagoMinimumAmount] = useState(
    toInputValue(DEFAULT_CUSTOMER_CREDIT_PAYMENT_SETTINGS.mercadoPagoMinimumAmount),
  )
  const [criticalStockThreshold, setCriticalStockThreshold] = useState(
    String(DEFAULT_STOCK_SETTINGS.criticalStockThreshold),
  )
  const [lowStockThreshold, setLowStockThreshold] = useState(
    String(DEFAULT_STOCK_SETTINGS.lowStockThreshold),
  )
  const [availableStockThreshold, setAvailableStockThreshold] = useState(
    String(DEFAULT_STOCK_SETTINGS.availableStockThreshold),
  )
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState("")
  const [error, setError] = useState("")

  const applyShipping = (nextShipping: ShippingBonusSettings) => {
    setDefaultShippingCost(toInputValue(nextShipping.defaultShippingCost))
    setFreeShippingMinAmount(toInputValue(nextShipping.freeShippingMinAmount))
    setShippingBonusMax(toInputValue(nextShipping.shippingBonusMax))
    setFreeShippingMode(nextShipping.freeShippingMode)
    setLogisticsBaseSubsidy(toInputValue(nextShipping.logisticsBaseSubsidy))
  }

  const applyStock = (nextStock: StockSettings) => {
    setCriticalStockThreshold(String(nextStock.criticalStockThreshold))
    setLowStockThreshold(String(nextStock.lowStockThreshold))
    setAvailableStockThreshold(String(nextStock.availableStockThreshold))
  }

  const loadSettings = async () => {
    setLoading(true)
    setError("")

    const {
      data: { session },
    } = await supabase.auth.getSession()

    if (!session?.access_token) {
      setError("No se pudo validar la sesión.")
      setLoading(false)
      return
    }

    const response = await fetch("/api/admin/settings", {
      headers: {
        Authorization: `Bearer ${session.access_token}`,
      },
    })
    const data = (await response.json()) as SettingsResponse

    if (!response.ok || !data.settings?.shipping) {
      setError(data.error ?? "No se pudo cargar la configuración.")
      setLoading(false)
      return
    }

    applyShipping(data.settings.shipping)
    const nextCustomerCreditPayments =
      data.settings.customerCreditPayments ??
      DEFAULT_CUSTOMER_CREDIT_PAYMENT_SETTINGS
    setMercadoPagoSurchargePercent(
      String(nextCustomerCreditPayments.mercadoPagoSurchargePercent),
    )
    setMercadoPagoMinimumAmount(
      toInputValue(nextCustomerCreditPayments.mercadoPagoMinimumAmount),
    )
    applyStock(data.settings.stock ?? DEFAULT_STOCK_SETTINGS)
    setLoading(false)
  }

  useEffect(() => {
    void loadSettings()
  }, [])

  const saveSettings = async () => {
    setSaving(true)
    setMessage("")
    setError("")

    const nextShipping: ShippingBonusSettings = {
      defaultShippingCost: normalizeAmount(defaultShippingCost),
      freeShippingMinAmount: normalizeAmount(freeShippingMinAmount),
      shippingBonusMax: normalizeAmount(shippingBonusMax),
      freeShippingMode,
      logisticsBaseSubsidy: normalizeAmount(logisticsBaseSubsidy),
    }
    const nextCustomerCreditPayments: CustomerCreditPaymentSettings = {
      mercadoPagoSurchargePercent: normalizePercentage(
        mercadoPagoSurchargePercent,
      ),
      mercadoPagoMinimumAmount: normalizeAmount(mercadoPagoMinimumAmount),
    }
    const nextStock: StockSettings = {
      criticalStockThreshold: normalizeAmount(criticalStockThreshold),
      lowStockThreshold: normalizeAmount(lowStockThreshold),
      availableStockThreshold: normalizeAmount(availableStockThreshold),
    }

    if (nextStock.criticalStockThreshold >= nextStock.lowStockThreshold) {
      setError("El límite de stock crítico debe ser menor que el de stock bajo.")
      setSaving(false)
      return
    }

    const {
      data: { session },
    } = await supabase.auth.getSession()

    if (!session?.access_token) {
      setError("No se pudo validar la sesión.")
      setSaving(false)
      return
    }

    const response = await fetch("/api/admin/settings", {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        shipping: nextShipping,
        customerCreditPayments: nextCustomerCreditPayments,
        stock: nextStock,
      }),
    })
    const data = (await response.json()) as SettingsResponse

    if (!response.ok || !data.settings?.shipping) {
      setError(data.error ?? "No se pudo guardar la configuración.")
      setSaving(false)
      return
    }

    invalidateSiteSettingsClientCache()
    applyShipping(data.settings.shipping)
    const savedCustomerCreditPayments =
      data.settings.customerCreditPayments ?? nextCustomerCreditPayments
    setMercadoPagoSurchargePercent(
      String(savedCustomerCreditPayments.mercadoPagoSurchargePercent),
    )
    setMercadoPagoMinimumAmount(
      toInputValue(savedCustomerCreditPayments.mercadoPagoMinimumAmount),
    )
    applyStock(data.settings.stock ?? nextStock)
    setMessage("Configuración actualizada. Los textos y cálculos ya usan estos valores.")
    setSaving(false)
  }

  const previewMin = normalizeAmount(freeShippingMinAmount)
  const previewBonus = normalizeAmount(shippingBonusMax)
  const previewLogisticsBaseSubsidy = normalizeAmount(logisticsBaseSubsidy)
  const previewCriticalStock = normalizeAmount(criticalStockThreshold)
  const previewLowStock = normalizeAmount(lowStockThreshold)
  const previewAvailableStock = normalizeAmount(availableStockThreshold)
  const previewLowStockStart = previewCriticalStock + 1

  const saveButton = (
    <AdminPrimaryButton
      type="button"
      size="sm"
      onClick={() => void saveSettings()}
      disabled={loading || saving}
      className="shrink-0"
    >
      <Save className="size-3.5" />
      {saving ? "Guardando…" : "Guardar cambios"}
    </AdminPrimaryButton>
  )

  return (
    <div className="admin-config-page space-y-3 p-4 sm:p-6 lg:p-8">
      <AdminPageHeader
        title="Configuración"
        className="gap-2"
      />

      {message ? (
        <AdminInfoBlock tone="success" className="py-2 text-xs">{message}</AdminInfoBlock>
      ) : null}
      {error ? <AdminInfoBlock tone="danger" className="py-2 text-xs">{error}</AdminInfoBlock> : null}

      <AndreaniIntegrationCard />

      <AdminSection
        compact
        icon={<Boxes className="size-3.5" />}
        eyebrow="Inventario"
        title="Stock"
        description="Cuándo cambia el estado visual del inventario."
        actions={saveButton}
      >
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <StockThresholdBox
              label="Stock crítico"
              tone="critical"
              value={criticalStockThreshold}
              disabled={loading || saving}
              onChange={(value) => setCriticalStockThreshold(normalizeTwoDigits(value))}
            />

            <StockThresholdBox
              label="Stock bajo"
              tone="low"
              value={lowStockThreshold}
              disabled={loading || saving}
              onChange={(value) => {
                const normalized = normalizeTwoDigits(value)
                const nextValue = Math.min(98, normalizeAmount(normalized))
                setLowStockThreshold(normalized ? String(nextValue) : "")
                setAvailableStockThreshold(normalized ? String(nextValue + 1) : "")
              }}
            />

            <StockThresholdBox
              label="Disponible desde"
              tone="available"
              value={availableStockThreshold}
              disabled={loading || saving}
              onChange={(value) => {
                const normalized = normalizeTwoDigits(value)
                const nextValue = Math.max(2, normalizeAmount(normalized))
                setAvailableStockThreshold(normalized ? String(nextValue) : "")
                setLowStockThreshold(normalized ? String(nextValue - 1) : "")
              }}
            />
          </div>

          <span className="hidden h-10 w-px shrink-0 bg-white/8 sm:block" />

          <p className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-12px font-semibold text-white/55">
            <span className="inline-flex items-center gap-1.5">
              <span className="size-1.5 rounded-full bg-red-400" />
              Crítico: {previewCriticalStock > 0 ? `1 a ${previewCriticalStock}` : "sin rango"}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="size-1.5 rounded-full bg-amber-400" />
              Bajo: {previewLowStock >= previewLowStockStart ? `${previewLowStockStart} a ${previewLowStock}` : "revisar"}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="size-1.5 rounded-full bg-emerald-400" />
              Disponible: desde {previewAvailableStock}
            </span>
          </p>
        </div>
      </AdminSection>

      <AdminSection
        compact
        icon={<Truck className="size-3.5" />}
        eyebrow="Comercial"
        title="Envíos"
        description="Costo y bonificación de envío."
        actions={saveButton}
      >
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <AdminFormField
            label="Compra mínima"
            help="Activa la bonificación."
            labelClassName={compactLabelClassName}
            helpClassName={compactHelpClassName}
          >
            <AdminTextInput
              title="Compra mínima"
              ariaLabel="Monto mínimo para acceder a envío bonificado"
              value={withInputSymbol(freeShippingMinAmount, "$")}
              placeholder="$ 75000"
              inputMode="numeric"
              className={`text-center font-bold ${compactInputClassName}`}
              disabled={loading || saving}
              onChange={(value) => setFreeShippingMinAmount(normalizeNumericInput(value))}
            />
          </AdminFormField>

          <AdminFormField
            label="Bonif. máxima"
            help="Tope de BEYONIX."
            labelClassName={compactLabelClassName}
            helpClassName={compactHelpClassName}
          >
            <AdminTextInput
              title="Bonificación máxima"
              ariaLabel="Tope máximo de bonificación de envío"
              value={withInputSymbol(shippingBonusMax, "$")}
              placeholder="$ 12000"
              inputMode="numeric"
              className={`text-center font-bold text-beyonix-cyan ${compactInputClassName}`}
              disabled={loading || saving}
              onChange={(value) => setShippingBonusMax(normalizeNumericInput(value))}
            />
          </AdminFormField>

          <AdminFormField
            label="Bonif. base"
            help="Antes del mínimo."
            labelClassName={compactLabelClassName}
            helpClassName={compactHelpClassName}
          >
            <AdminTextInput
              title="Bonificación base"
              ariaLabel="Bonificación base de envío para compras por debajo del mínimo"
              value={withInputSymbol(logisticsBaseSubsidy, "$")}
              placeholder="$ 3000"
              inputMode="numeric"
              className={`text-center font-bold text-beyonix-cyan ${compactInputClassName}`}
              disabled={loading || saving}
              onChange={(value) => setLogisticsBaseSubsidy(normalizeNumericInput(value))}
            />
          </AdminFormField>

          <AdminFormField
            label="Estado"
            labelClassName={compactLabelClassName}
          >
            <AdminSelect
              title="Estado"
              value={freeShippingMode}
              centered
              leadingIcon={
                <span
                  className={`size-2 rounded-full shadow-[0_0_10px_currentColor] ${
                    freeShippingMode === "full"
                      ? "bg-emerald-400 text-emerald-400"
                      : "bg-white/35 text-white/35"
                  }`}
                />
              }
              triggerClassName="admin-modifications-status-select !text-sm !font-bold"
              optionClassName="font-bold hover:!bg-beyonix-blue/25"
              disabled={loading || saving}
              onChange={(value) =>
                setFreeShippingMode(value === "off" ? "off" : "full")
              }
            >
              <option value="full">Activo</option>
              <option value="off">Desactivado</option>
            </AdminSelect>
          </AdminFormField>
        </div>

        <p className="mt-3 rounded-lg border border-beyonix-blue-light/16 bg-beyonix-blue/8 px-3 py-2 text-xs leading-5 text-white/74">
          Desde <strong className="text-white">{formatARS(previewMin)}</strong> de
          compra, BEYONIX bonifica hasta{" "}
          <strong className="text-beyonix-cyan">{formatARS(previewBonus)}</strong>{" "}
          del envío.
          {previewLogisticsBaseSubsidy > 0 && (
            <>
              {" "}Por debajo de ese monto, absorbe una bonificación base de{" "}
              <strong className="text-beyonix-cyan">
                {formatARS(previewLogisticsBaseSubsidy)}
              </strong>
              .
            </>
          )}
        </p>
      </AdminSection>

      <AdminSection
        compact
        icon={<ImageIcon className="size-3.5" />}
        eyebrow="Visuales"
        title="Banners"
        description="Imagen destacada que se muestra en la tienda."
      >
        <AdminBanners embedded />
      </AdminSection>
    </div>
  )
}
