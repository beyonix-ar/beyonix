"use client"

import { useEffect, useState, type ReactNode } from "react"
import { Boxes, ImageIcon, Save, Truck, WalletCards } from "lucide-react"

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
import {
  AdminCard,
  AdminInfoBlock,
  AdminPageHeader,
  AdminPrimaryButton,
  AdminSelect,
  AdminTextInput,
} from "../../components/admin-controls"
import { AdminBanners } from "../banners/admin-banners"

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

function normalizeDecimalInput(value: string) {
  const cleaned = value.replace(/[^\d,.]/g, "")
  const separatorIndex = cleaned.search(/[,.]/)

  if (separatorIndex < 0) return cleaned

  return `${cleaned.slice(0, separatorIndex + 1)}${cleaned
    .slice(separatorIndex + 1)
    .replace(/[,.]/g, "")}`
}

const formatARS = (value: number) =>
  new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    maximumFractionDigits: 0,
  }).format(value)

function SettingField({
  title,
  children,
}: {
  title: string
  children: ReactNode
}) {
  return (
    <div className="flex h-20 w-full items-center justify-center rounded-xl bg-white/[0.025] px-4 ring-1 ring-inset ring-beyonix-blue-light/14 transition-colors hover:bg-white/[0.04] hover:ring-beyonix-blue-light/24">
      <div className="w-full max-w-48">
        <h3 className="mb-1.5 text-center text-sm font-black text-white/82">{title}</h3>
        {children}
      </div>
    </div>
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
  const previewMercadoPagoMinimum = normalizeAmount(mercadoPagoMinimumAmount)
  const previewMercadoPagoSurcharge = normalizePercentage(
    mercadoPagoSurchargePercent,
  )
  const previewMercadoPagoTotal =
    previewMercadoPagoMinimum * (1 + previewMercadoPagoSurcharge / 100)
  const previewCriticalStock = normalizeAmount(criticalStockThreshold)
  const previewLowStock = normalizeAmount(lowStockThreshold)
  const previewAvailableStock = normalizeAmount(availableStockThreshold)
  const previewLowStockStart = previewCriticalStock + 1

  return (
    <div className="space-y-4 p-4 sm:p-6 lg:p-8">
      <AdminPageHeader
        title="Modificaciones"
        className="gap-2"
      />

      {message ? (
        <AdminInfoBlock tone="success">{message}</AdminInfoBlock>
      ) : null}
      {error ? <AdminInfoBlock tone="danger">{error}</AdminInfoBlock> : null}

      <AdminCard className="space-y-3 p-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="flex items-center gap-2 text-base font-black text-white">
            <Boxes className="size-4 text-beyonix-cyan" />
            Stock
          </h2>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs font-bold sm:justify-end sm:text-sm">
            <span className="text-red-300">
              Crítico: {previewCriticalStock > 0 ? `1 a ${previewCriticalStock}` : "sin rango"}
            </span>
            <span className="text-amber-200">
              Bajo: {previewLowStock >= previewLowStockStart ? `${previewLowStockStart} a ${previewLowStock}` : "revisar"}
            </span>
            <span className="text-green-300">
              Disponible: desde {previewAvailableStock}
            </span>
          </div>
        </div>

        <div className="grid items-center gap-3 xl:grid-cols-[minmax(0,1fr)_190px]">
          <div className="grid gap-3 md:grid-cols-3">
            <div className="flex h-20 w-full items-center justify-center rounded-xl bg-red-400/[0.035] px-4 ring-1 ring-inset ring-red-400/20 transition-colors hover:bg-red-400/[0.055] hover:ring-red-400/32">
              <div className="w-full max-w-36">
                <label className="mb-1.5 block text-center text-sm font-black text-red-300">Stock crítico</label>
                <AdminTextInput
                  title="Stock crítico"
                  ariaLabel="Cantidad máxima para stock crítico"
                  value={criticalStockThreshold}
                  placeholder="3"
                  inputMode="numeric"
                  maxLength={2}
                  className="h-9 text-center text-base font-black"
                  disabled={loading || saving}
                  onChange={(value) => setCriticalStockThreshold(normalizeTwoDigits(value))}
                />
              </div>
            </div>

            <div className="flex h-20 w-full items-center justify-center rounded-xl bg-amber-400/[0.035] px-4 ring-1 ring-inset ring-amber-400/20 transition-colors hover:bg-amber-400/[0.055] hover:ring-amber-400/32">
              <div className="w-full max-w-36">
                <label className="mb-1.5 block text-center text-sm font-black text-amber-200">Stock bajo</label>
                <AdminTextInput
                  title="Stock bajo"
                  ariaLabel="Cantidad máxima para stock bajo"
                  value={lowStockThreshold}
                  placeholder="6"
                  inputMode="numeric"
                  maxLength={2}
                  className="h-9 text-center text-base font-black"
                  disabled={loading || saving}
                  onChange={(value) => {
                    const normalized = normalizeTwoDigits(value)
                    const nextValue = Math.min(98, normalizeAmount(normalized))
                    setLowStockThreshold(normalized ? String(nextValue) : "")
                    setAvailableStockThreshold(normalized ? String(nextValue + 1) : "")
                  }}
                />
              </div>
            </div>

            <div className="flex h-20 w-full items-center justify-center rounded-xl bg-green-400/[0.035] px-4 ring-1 ring-inset ring-green-400/20 transition-colors hover:bg-green-400/[0.055] hover:ring-green-400/32">
              <div className="w-full max-w-36">
                <label className="mb-1.5 block text-center text-sm font-black text-green-300">Stock disponible</label>
                <AdminTextInput
                  title="Stock disponible"
                  ariaLabel="Cantidad mínima para stock disponible"
                  value={availableStockThreshold}
                  placeholder="7"
                  inputMode="numeric"
                  maxLength={2}
                  className="h-9 text-center text-base font-black"
                  disabled={loading || saving}
                  onChange={(value) => {
                    const normalized = normalizeTwoDigits(value)
                    const nextValue = Math.max(2, normalizeAmount(normalized))
                    setAvailableStockThreshold(normalized ? String(nextValue) : "")
                    setLowStockThreshold(normalized ? String(nextValue - 1) : "")
                  }}
                />
              </div>
            </div>
          </div>
          <div className="flex h-20 items-center xl:border-l xl:border-white/8 xl:pl-3">
            <AdminPrimaryButton
              type="button"
              onClick={() => void saveSettings()}
              disabled={loading || saving}
              className="w-full whitespace-nowrap"
            >
              <Save className="size-4" />
              {saving ? "Guardando..." : "Guardar"}
            </AdminPrimaryButton>
          </div>
        </div>
      </AdminCard>

      <AdminCard className="space-y-3 p-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="flex items-center gap-2 text-base font-black text-white">
            <Truck className="size-4 text-beyonix-cyan" />
            Envíos
          </h2>
          <p className="text-xs font-bold text-white/58 sm:text-sm">
            Compra desde <strong className="text-white">{formatARS(previewMin)}</strong>
            <span className="mx-2 text-white/24">·</span>
            Bonifica hasta <strong className="text-beyonix-cyan">{formatARS(previewBonus)}</strong>
          </p>
        </div>

        <div className="grid items-center gap-3 xl:grid-cols-[minmax(0,1fr)_190px]">
          <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-4">
            <SettingField title="Costo base">
            <AdminTextInput
              title="Costo base de envío"
              ariaLabel="Costo base de envío"
              value={withInputSymbol(defaultShippingCost, "$")}
              placeholder="$ 15000"
              inputMode="numeric"
              className="h-9 text-center text-base font-black"
              disabled={loading || saving}
              onChange={(value) => setDefaultShippingCost(normalizeNumericInput(value))}
            />
            </SettingField>

            <SettingField title="Inicio bono">
            <AdminTextInput
              title="Inicio bono"
              ariaLabel="Monto mínimo para acceder a envío bonificado"
              value={withInputSymbol(freeShippingMinAmount, "$")}
              placeholder="$ 75000"
              inputMode="numeric"
              className="h-9 text-center text-base font-black"
              disabled={loading || saving}
              onChange={(value) => setFreeShippingMinAmount(normalizeNumericInput(value))}
            />
            </SettingField>

            <SettingField title="Tope bono">
            <AdminTextInput
              title="Tope bono"
              ariaLabel="Tope máximo de bonificación de envío"
              value={withInputSymbol(shippingBonusMax, "$")}
              placeholder="$ 12000"
              inputMode="numeric"
              className="h-9 text-center text-base font-black"
              disabled={loading || saving}
              onChange={(value) => setShippingBonusMax(normalizeNumericInput(value))}
            />
            </SettingField>

            <SettingField title="Estado">
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
              triggerClassName="admin-modifications-status-select !h-9 !px-3 !text-base !font-black"
              optionClassName="font-bold hover:!bg-beyonix-blue/25"
              disabled={loading || saving}
              onChange={(value) =>
                setFreeShippingMode(value === "off" ? "off" : "full")
              }
            >
              <option value="full">Activo</option>
              <option value="off">Desactivado</option>
            </AdminSelect>
            </SettingField>
          </div>
          <div className="flex h-20 items-center xl:border-l xl:border-white/8 xl:pl-3">
            <AdminPrimaryButton
              type="button"
              onClick={() => void saveSettings()}
              disabled={loading || saving}
              className="w-full whitespace-nowrap"
            >
              <Save className="size-4" />
              {saving ? "Guardando..." : "Guardar"}
            </AdminPrimaryButton>
          </div>
        </div>
      </AdminCard>

      <AdminCard className="space-y-3 p-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="flex items-center gap-2 text-base font-black text-white">
            <WalletCards className="size-4 text-beyonix-cyan" />
            Cargas de saldo
          </h2>
          <p className="text-xs font-bold text-white/58 sm:text-sm">
            Carga mínima <strong className="text-white">{formatARS(previewMercadoPagoMinimum)}</strong>
            <span className="mx-2 text-white/24">·</span>
            Recargo <strong className="text-beyonix-cyan">{previewMercadoPagoSurcharge}%</strong>
          </p>
        </div>

        <div className="grid items-center gap-3 xl:grid-cols-[minmax(0,1fr)_190px]">
          <div className="grid gap-3 md:grid-cols-3">
            <SettingField title="Recargo MP">
            <AdminTextInput
              title="Recargo MP"
              ariaLabel="Porcentaje de recargo de Mercado Pago"
              value={withInputSymbol(mercadoPagoSurchargePercent, "%")}
              placeholder="% 8"
              inputMode="decimal"
              className="h-9 text-center text-base font-black"
              disabled={loading || saving}
              onChange={(value) =>
                setMercadoPagoSurchargePercent(normalizeDecimalInput(value))
              }
            />
            </SettingField>
            <SettingField title="Mínimo MP">
            <AdminTextInput
              title="Mínimo MP"
              ariaLabel="Importe mínimo de carga por Mercado Pago"
              value={withInputSymbol(mercadoPagoMinimumAmount, "$")}
              placeholder="$ 10000"
              inputMode="numeric"
              className="h-9 text-center text-base font-black"
              disabled={loading || saving}
              onChange={(value) => setMercadoPagoMinimumAmount(normalizeNumericInput(value))}
            />
            </SettingField>
            <div className="flex h-20 w-full items-center justify-center rounded-xl bg-beyonix-blue/8 px-4 ring-1 ring-inset ring-beyonix-blue-light/16">
              <div className="w-full max-w-48">
                <p className="mb-1 text-center text-sm font-black text-white/82">Resultado</p>
                <p className="text-center text-lg font-black text-beyonix-cyan">
                  {formatARS(previewMercadoPagoTotal)}
                </p>
              </div>
            </div>
          </div>
          <div className="flex h-20 items-center xl:border-l xl:border-white/8 xl:pl-3">
            <AdminPrimaryButton
              type="button"
              onClick={() => void saveSettings()}
              disabled={loading || saving}
              className="w-full whitespace-nowrap"
            >
              <Save className="size-4" />
              {saving ? "Guardando..." : "Guardar"}
            </AdminPrimaryButton>
          </div>
        </div>
      </AdminCard>

      <section className="space-y-3">
        <h2 className="flex items-center gap-2 text-base font-black text-white">
          <ImageIcon className="size-4 text-beyonix-cyan" />
          Banners
        </h2>
        <AdminBanners embedded />
      </section>

    </div>
  )
}
