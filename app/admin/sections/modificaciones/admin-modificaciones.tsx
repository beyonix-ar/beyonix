"use client"

import { useEffect, useState, type ReactNode } from "react"
import { ImageIcon, Save, Truck } from "lucide-react"

import { supabase } from "@/lib/supabase/client"
import {
  DEFAULT_SHIPPING_SETTINGS,
  type ShippingBonusSettings,
} from "@/lib/store-config"
import {
  adminPageClassName,
  AdminCard,
  AdminInfoBlock,
  AdminPageHeader,
  AdminPrimaryButton,
  AdminSecondaryButton,
  AdminSelect,
  AdminTextInput,
} from "../../components/admin-controls"
import { AdminBanners } from "../banners/admin-banners"

interface SettingsResponse {
  settings?: {
    shipping?: ShippingBonusSettings
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

const formatARS = (value: number) =>
  new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    maximumFractionDigits: 0,
  }).format(value)

function SettingField({
  title,
  description,
  preview,
  children,
}: {
  title: string
  description: string
  preview?: string
  children: ReactNode
}) {
  return (
    <div className="flex min-h-186px flex-col rounded-2xl border border-beyonix-blue-light/14 bg-black/20 p-4">
      <div className="min-h-104px">
        <div className="flex items-start justify-between gap-3">
          <h3 className="text-sm font-black text-white">{title}</h3>
          {preview ? (
            <span className="shrink-0 rounded-full border border-beyonix-blue-light/18 bg-beyonix-blue/16 px-2.5 py-1 text-10px font-bold text-beyonix-cyan">
              {preview}
            </span>
          ) : null}
        </div>
        <p className="mt-2 text-xs leading-5 text-white/52">{description}</p>
      </div>
      <div className="mt-auto pt-3">{children}</div>
    </div>
  )
}

export function AdminModificaciones() {
  const [shipping, setShipping] = useState<ShippingBonusSettings>(
    DEFAULT_SHIPPING_SETTINGS,
  )
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
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState("")
  const [error, setError] = useState("")

  const applyShipping = (nextShipping: ShippingBonusSettings) => {
    setShipping(nextShipping)
    setDefaultShippingCost(toInputValue(nextShipping.defaultShippingCost))
    setFreeShippingMinAmount(toInputValue(nextShipping.freeShippingMinAmount))
    setShippingBonusMax(toInputValue(nextShipping.shippingBonusMax))
    setFreeShippingMode(nextShipping.freeShippingMode)
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
      }),
    })
    const data = (await response.json()) as SettingsResponse

    if (!response.ok || !data.settings?.shipping) {
      setError(data.error ?? "No se pudo guardar la configuración.")
      setSaving(false)
      return
    }

    applyShipping(data.settings.shipping)
    setMessage("Configuración actualizada. Los textos y cálculos ya usan estos valores.")
    setSaving(false)
  }

  const previewMin = normalizeAmount(freeShippingMinAmount)
  const previewBonus = normalizeAmount(shippingBonusMax)

  return (
    <div className={adminPageClassName}>
      <AdminPageHeader
        eyebrow="Control global"
        title="Modificaciones"
        description="Ajustes generales que impactan en textos públicos, carrito, checkout y creación de pedidos."
        actions={
          <AdminSecondaryButton
            type="button"
            onClick={() => void loadSettings()}
            disabled={loading || saving}
          >
            Actualizar
          </AdminSecondaryButton>
        }
      />

      {message ? (
        <AdminInfoBlock tone="success">{message}</AdminInfoBlock>
      ) : null}
      {error ? <AdminInfoBlock tone="danger">{error}</AdminInfoBlock> : null}

      <AdminCard className="space-y-5 p-5">
        <div className="flex flex-col gap-3 border-b border-white/10 pb-5 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="flex items-center gap-2 text-11px font-black uppercase tracking-widest text-beyonix-cyan">
              <Truck className="size-4" />
              Envío bonificado
            </p>
            <h2 className="mt-2 text-xl font-black text-white">
              Reglas de bonificación
            </h2>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-white/58">
              Estos valores se usan en el texto de términos, barra del carrito,
              opciones de checkout y cálculo final de pedidos.
            </p>
          </div>
          <div className="rounded-2xl border border-beyonix-blue-light/18 bg-black/30 px-4 py-3 text-sm text-white/72">
            Desde <strong className="text-white">{formatARS(previewMin)}</strong>, bonifica hasta{" "}
            <strong className="text-white">{formatARS(previewBonus)}</strong>.
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <SettingField
            title="Costo base de envío"
            description="Valor de referencia que usa la tienda si Andreani no devuelve una cotización real. No es la bonificación: es el costo fallback del envío."
            preview={formatARS(normalizeAmount(defaultShippingCost))}
          >
            <AdminTextInput
              title="Costo base de envío"
              ariaLabel="Costo base de envío"
              value={defaultShippingCost}
              placeholder="15000"
              inputMode="numeric"
              disabled={loading || saving}
              onChange={setDefaultShippingCost}
            />
          </SettingField>

          <SettingField
            title="La bonificación empieza desde"
            description="Subtotal mínimo de productos para que BEYONIX empiece a cubrir parte del envío. Este texto aparece en carrito, checkout y términos."
            preview={formatARS(previewMin)}
          >
            <AdminTextInput
              title="La bonificación empieza desde"
              ariaLabel="Monto mínimo para acceder a envío bonificado"
              value={freeShippingMinAmount}
              placeholder="75000"
              inputMode="numeric"
              disabled={loading || saving}
              onChange={setFreeShippingMinAmount}
            />
          </SettingField>

          <SettingField
            title="Máximo que bonifica BEYONIX"
            description="Tope que BEYONIX descuenta del costo real del envío. Si Andreani cuesta más, el cliente paga solo la diferencia."
            preview={formatARS(previewBonus)}
          >
            <AdminTextInput
              title="Máximo que bonifica BEYONIX"
              ariaLabel="Tope máximo de bonificación de envío"
              value={shippingBonusMax}
              placeholder="12000"
              inputMode="numeric"
              disabled={loading || saving}
              onChange={setShippingBonusMax}
            />
          </SettingField>

          <SettingField
            title="Estado de la bonificación"
            description="Activá o pausá la promoción. Si está desactivada, no se muestra la barra del carrito ni se aplica descuento automático al envío."
          >
            <AdminSelect
              title="Estado de la bonificación"
              value={freeShippingMode}
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

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs leading-5 text-white/48">
            Valor activo guardado: desde {formatARS(shipping.freeShippingMinAmount)} y hasta{" "}
            {formatARS(shipping.shippingBonusMax)} de bonificación.
          </p>
          <AdminPrimaryButton
            type="button"
            onClick={() => void saveSettings()}
            disabled={loading || saving}
          >
            <Save className="size-4" />
            {saving ? "Guardando..." : "Guardar cambios"}
          </AdminPrimaryButton>
        </div>
      </AdminCard>

      <section className="space-y-4">
        <div>
          <p className="flex items-center gap-2 text-11px font-black uppercase tracking-widest text-beyonix-cyan">
            <ImageIcon className="size-4" />
            Banners
          </p>
          <h2 className="mt-2 text-xl font-black text-white">
            Promociones visuales
          </h2>
          <p className="mt-1 text-sm leading-6 text-white/58">
            Controlá desde acá los banners principales que ya estaban disponibles en el panel.
          </p>
        </div>
        <AdminBanners embedded />
      </section>

    </div>
  )
}
