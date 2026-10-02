"use client"

import { useEffect, useState } from "react"
import { ImageIcon } from "lucide-react"

import { supabase } from "@/lib/supabase/client"
import {
  DEFAULT_SHIPPING_SETTINGS,
  type ShippingBonusSettings,
} from "@/lib/store-config"
import {
  DEFAULT_ANDREANI_COMMERCIAL_SETTINGS,
  DEFAULT_CUSTOMER_CREDIT_PAYMENT_SETTINGS,
  DEFAULT_PRICING_SETTINGS,
  DEFAULT_STOCK_SETTINGS,
  type AndreaniCommercialSettings,
  type CustomerCreditPaymentSettings,
  type MercadoPagoCostsOverview,
  type PricingSettings,
  type StockSettings,
} from "@/lib/site-settings"
import { invalidateSiteSettingsClientCache } from "@/hooks/use-site-settings"
import {
  AdminInfoBlock,
  AdminPageHeader,
  AdminSection,
} from "../../components/admin-controls"
import { AdminBanners } from "../banners/admin-banners"
import { AndreaniIntegrationCard } from "./andreani-integration-card"
import { ConfigGroup, type ConfigFeedback } from "./config-ui"
import { FinancingShortcutCard } from "./financing-shortcut-card"
import {
  CustomerCreditSection,
  PricingSection,
  ShippingSection,
  StockSection,
} from "./store-config-sections"

interface AdminSettings {
  shipping: ShippingBonusSettings
  customerCreditPayments: CustomerCreditPaymentSettings
  stock: StockSettings
  pricing: PricingSettings
  andreaniCommercial: AndreaniCommercialSettings
}

interface SettingsResponse {
  settings?: Partial<AdminSettings>
  mercadoPagoCosts?: MercadoPagoCostsOverview
  error?: string
}

interface SettingsPatch {
  shipping?: ShippingBonusSettings
  customerCreditPayments?: CustomerCreditPaymentSettings
  stock?: StockSettings
  pricing?: PricingSettings
}

type SectionId = "stock" | "shipping" | "pricing" | "customerCredit"

const SECTION_IDS: SectionId[] = ["stock", "shipping", "pricing", "customerCredit"]

const DEFAULT_ADMIN_SETTINGS: AdminSettings = {
  shipping: DEFAULT_SHIPPING_SETTINGS,
  customerCreditPayments: DEFAULT_CUSTOMER_CREDIT_PAYMENT_SETTINGS,
  stock: DEFAULT_STOCK_SETTINGS,
  pricing: DEFAULT_PRICING_SETTINGS,
  andreaniCommercial: DEFAULT_ANDREANI_COMMERCIAL_SETTINGS,
}

function toAdminSettings(settings: Partial<AdminSettings>): AdminSettings {
  return { ...DEFAULT_ADMIN_SETTINGS, ...settings }
}

async function getAccessToken() {
  const {
    data: { session },
  } = await supabase.auth.getSession()
  return session?.access_token ?? null
}

const SAVED_MESSAGE = "Guardado. Los textos y cálculos ya usan estos valores."

export function AdminModificaciones() {
  const [settings, setSettings] = useState<AdminSettings>(DEFAULT_ADMIN_SETTINGS)
  const [mercadoPagoCosts, setMercadoPagoCosts] = useState<MercadoPagoCostsOverview | null>(null)
  const [loading, setLoading] = useState(true)
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState("")
  const [savingSection, setSavingSection] = useState<SectionId | null>(null)
  const [feedback, setFeedback] = useState<Partial<Record<SectionId, ConfigFeedback>>>({})
  // Cada bloque edita un borrador propio; al cargar o guardar su versión
  // cambia y el borrador se reinicia con los valores confirmados por el server.
  const [versions, setVersions] = useState<Record<SectionId, number>>({
    stock: 0,
    shipping: 0,
    pricing: 0,
    customerCredit: 0,
  })

  const bumpVersions = (ids: SectionId[]) =>
    setVersions((current) => {
      const next = { ...current }
      for (const id of ids) next[id] += 1
      return next
    })

  const applyResponse = (data: SettingsResponse) => {
    setSettings(toAdminSettings(data.settings ?? {}))
    if (data.mercadoPagoCosts) setMercadoPagoCosts(data.mercadoPagoCosts)
  }

  const loadSettings = async () => {
    setLoading(true)
    setLoaded(false)
    setLoadError("")
    try {
      const token = await getAccessToken()
      if (!token) {
        setLoadError("No se pudo validar la sesión.")
        return
      }

      const response = await fetch("/api/admin/settings", {
        signal: AbortSignal.timeout(25_000),
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = (await response.json()) as SettingsResponse

      if (!response.ok || !data.settings?.shipping) {
        setLoadError(data.error ?? "No se pudo cargar la configuración.")
        return
      }

      applyResponse(data)
      setFeedback({})
      bumpVersions(SECTION_IDS)
      setLoaded(true)
    } catch {
      setLoadError("No se pudo cargar la configuración. Revisá la conexión y reintentá.")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadSettings()
  }, [])

  const saveSection = async (section: SectionId, patch: SettingsPatch) => {
    if (!loaded || loading || savingSection) return
    setSavingSection(section)
    setFeedback((current) => ({ ...current, [section]: undefined }))
    try {
      const token = await getAccessToken()
      if (!token) {
        setFeedback((current) => ({ ...current, [section]: { tone: "danger", text: "No se pudo validar la sesión." } }))
        return
      }

      const response = await fetch("/api/admin/settings", {
        method: "PATCH",
        signal: AbortSignal.timeout(25_000),
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(patch),
      })
      const data = (await response.json()) as SettingsResponse

      if (!response.ok || !data.settings?.shipping) {
        setFeedback((current) => ({
          ...current,
          [section]: { tone: "danger", text: data.error ?? "No se pudo guardar este bloque." },
        }))
        return
      }

      invalidateSiteSettingsClientCache()
      applyResponse(data)
      bumpVersions([section])
      setFeedback((current) => ({ ...current, [section]: { tone: "success", text: SAVED_MESSAGE } }))
    } catch {
      setFeedback((current) => ({
        ...current,
        [section]: {
          tone: "danger",
          text: "No se pudo confirmar el guardado. Recargá la configuración para comprobar los valores antes de reintentar.",
        },
      }))
    } finally {
      setSavingSection(null)
    }
  }

  const disabled = !loaded || loading
  const sectionProps = (section: SectionId) => ({
    disabled: disabled || (savingSection !== null && savingSection !== section),
    saving: savingSection === section,
    feedback: feedback[section] ?? null,
  })

  return (
    <div className="admin-config-page space-y-4 p-4 sm:p-6 lg:p-8">
      <AdminPageHeader
        title="Configuración"
        description="Cada bloque se guarda por separado."
        className="gap-2"
      />

      {loadError ? (
        <AdminInfoBlock tone="danger" className="py-2 text-xs">
          {loadError}
          <button
            type="button"
            disabled={loading}
            onClick={() => void loadSettings()}
            className="ml-3 underline"
          >
            Recargar configuración
          </button>
        </AdminInfoBlock>
      ) : null}

      {/* Dos columnas en desktop: integraciones e inventario arriba,
          comercial y pagos abajo; una sola columna en mobile. */}
      <div className="grid items-start gap-x-4 gap-y-4 xl:grid-cols-2">
        <ConfigGroup id="integraciones" label="Integraciones">
          <AndreaniIntegrationCard commercialEnabled={loaded ? settings.andreaniCommercial.enabled : null} />
        </ConfigGroup>

        <ConfigGroup id="inventario" label="Inventario">
          <StockSection
            key={`stock-${versions.stock}`}
            saved={settings.stock}
            {...sectionProps("stock")}
            onSave={(stock) => void saveSection("stock", { stock })}
          />
        </ConfigGroup>

        <ConfigGroup id="comercial" label="Comercial">
          <ShippingSection
            key={`shipping-${versions.shipping}`}
            saved={settings.shipping}
            {...sectionProps("shipping")}
            onSave={(shipping) => void saveSection("shipping", { shipping })}
          />
          <PricingSection
            key={`pricing-${versions.pricing}`}
            saved={settings.pricing}
            {...sectionProps("pricing")}
            onSave={(pricing) => void saveSection("pricing", { pricing })}
          />
        </ConfigGroup>

        <ConfigGroup id="pagos" label="Pagos">
          <FinancingShortcutCard overview={mercadoPagoCosts} />
          <CustomerCreditSection
            key={`credit-${versions.customerCredit}`}
            saved={settings.customerCreditPayments}
            {...sectionProps("customerCredit")}
            onSave={(customerCreditPayments) => void saveSection("customerCredit", { customerCreditPayments })}
          />
        </ConfigGroup>
      </div>

      <ConfigGroup id="visuales" label="Visuales">
        <AdminSection compact icon={<ImageIcon className="size-3.5" />} title="Banners">
          <AdminBanners embedded />
        </AdminSection>
      </ConfigGroup>
    </div>
  )
}
