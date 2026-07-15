"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import {
  BadgePercent,
  BellRing,
  CalendarDays,
  CheckCircle2,
  Edit3,
  Megaphone,
  Pause,
  Play,
  Plus,
  Send,
  Sparkles,
  Tag,
  Trash2,
  X,
} from "lucide-react"

import {
  AdminBadge,
  AdminButton,
  AdminDangerButton,
  AdminEmptyState,
  AdminFormField,
  AdminGhostButton,
  AdminInfoBlock,
  AdminModal,
  AdminPageHeader,
  AdminPrimaryButton,
  AdminSection,
  AdminSelect,
  AdminSkeleton,
  AdminStatCard,
  AdminTable,
  AdminTextInput,
  AdminTextarea,
  adminPageClassName,
} from "@/app/admin/components/admin-controls"
import { AdminDatePicker } from "@/app/admin/components/admin-date-picker"
import { supabase } from "@/lib/supabase/client"
import type {
  SupabaseCategoria,
  SupabaseCustomerNotificationCampaign,
  SupabaseCustomerNotificationCampaignType,
  SupabaseProducto,
} from "@/lib/supabase/types"
import { cn } from "@/lib/utils"

type CampaignForm = {
  id: string
  type: SupabaseCustomerNotificationCampaignType
  title: string
  body: string
  action_url: string
  target_scope: CommercialScope
  target_items: CampaignTargetItem[]
  starts_at: string
  ends_at: string
}

type CommercialScope = "store" | "category" | "product"

type CampaignTargetItem = {
  type: "category" | "product"
  label: string
  url: string
}

type NotificationCategory = Pick<SupabaseCategoria, "id" | "nombre" | "slug">

type NotificationProduct = Pick<SupabaseProducto, "id" | "nombre" | "slug" | "activo">

const EMPTY_FORM: CampaignForm = {
  id: "",
  type: "oferta",
  title: "",
  body: "",
  action_url: "/productos",
  target_scope: "store",
  target_items: [],
  starts_at: "",
  ends_at: "",
}

const TYPE_OPTIONS: Array<{
  value: SupabaseCustomerNotificationCampaignType
  label: string
  description: string
  icon: typeof Megaphone
}> = [
  {
    value: "oferta",
    label: "Oferta",
    description: "Aviso comercial general",
    icon: Tag,
  },
  {
    value: "descuento",
    label: "Descuento",
    description: "Promoción con rebaja",
    icon: BadgePercent,
  },
  {
    value: "cuotas",
    label: "Cuotas",
    description: "Financiación sin interés",
    icon: CheckCircle2,
  },
  {
    value: "producto_destacado",
    label: "Producto destacado",
    description: "Empujar una ficha o categoría",
    icon: Sparkles,
  },
  {
    value: "evento",
    label: "Evento",
    description: "Fechas especiales o lanzamientos",
    icon: CalendarDays,
  },
  {
    value: "promocion",
    label: "Promoción",
    description: "Campaña temporal",
    icon: Megaphone,
  },
  {
    value: "mensaje",
    label: "Mensaje",
    description: "Comunicación institucional",
    icon: BellRing,
  },
]

const TYPE_LABELS = TYPE_OPTIONS.reduce(
  (labels, option) => ({ ...labels, [option.value]: option.label }),
  {} as Record<SupabaseCustomerNotificationCampaignType, string>,
)

const ACTION_DESTINATIONS = [
  {
    value: "/productos",
    label: "Tienda de productos",
    preview: "Abrirá la tienda de productos.",
  },
  {
    value: "/categorias",
    label: "Categorías",
    preview: "Abrirá el listado de categorías.",
  },
  {
    value: "/",
    label: "Inicio",
    preview: "Abrirá la página principal.",
  },
  {
    value: "/contacto",
    label: "Contacto",
    preview: "Abrirá la sección de contacto.",
  },
  {
    value: "",
    label: "Sin enlace",
    preview: "Solo mostrará el aviso, sin redirección.",
  },
] as const

const COMMERCIAL_SCOPE_OPTIONS: Array<{
  value: CommercialScope
  label: string
  help: string
}> = [
  {
    value: "store",
    label: "Toda la tienda",
    help: "La notificación lleva a productos.",
  },
  {
    value: "category",
    label: "Categoría alcanzada",
    help: "La notificación lleva a una categoría específica.",
  },
  {
    value: "product",
    label: "Producto alcanzado",
    help: "La notificación lleva a un producto específico.",
  },
]

function formatDate(value: string | null) {
  if (!value) return "Sin publicar"

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "Sin fecha"

  return new Intl.DateTimeFormat("es-AR", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "America/Argentina/Buenos_Aires",
  }).format(date)
}

function toDateInput(value?: string | null) {
  if (!value) return ""

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ""

  const offsetMs = date.getTimezoneOffset() * 60 * 1000

  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 10)
}

function fromDateInput(value: string, endOfDay = false) {
  if (!value) return null

  const date = new Date(`${value}T${endOfDay ? "23:59:59" : "00:00:00"}`)

  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function getTodayInputDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Argentina/Buenos_Aires",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date())
  const year = parts.find((part) => part.type === "year")?.value
  const month = parts.find((part) => part.type === "month")?.value
  const day = parts.find((part) => part.type === "day")?.value

  return year && month && day ? `${year}-${month}-${day}` : new Date().toISOString().slice(0, 10)
}

function getCampaignIcon(type: SupabaseCustomerNotificationCampaignType) {
  return TYPE_OPTIONS.find((option) => option.value === type)?.icon ?? BellRing
}

function normalizeActionDestination(value?: string | null) {
  const destination = ACTION_DESTINATIONS.find((option) => option.value === (value ?? ""))

  return destination?.value ?? "/productos"
}

function getCommercialScope(actionUrl: string): CommercialScope {
  if (actionUrl === "/categorias" || actionUrl.startsWith("/categorias/")) return "category"
  if (actionUrl.startsWith("/productos/")) return "product"
  if (actionUrl === "/productos") return "store"

  return "store"
}

function normalizeCommercialScope(value?: string | null, actionUrl = ""): CommercialScope {
  if (value === "store" || value === "category" || value === "product") return value

  return getCommercialScope(actionUrl)
}

function getActionDestinationLabel(
  actionUrl: string,
  categories: NotificationCategory[],
  products: NotificationProduct[],
) {
  const category = categories.find(
    (item) => actionUrl === `/categorias/${item.slug}`,
  )
  if (category) return `Categoría: ${category.nombre}`

  const product = products.find((item) => actionUrl === `/productos/${item.slug}`)
  if (product) return `Producto: ${product.nombre}`

  const destination = ACTION_DESTINATIONS.find((item) => item.value === actionUrl)

  return destination?.label ?? "Tienda de productos"
}

function normalizeCampaignActionUrl(value?: string | null) {
  const actionUrl = value ?? ""

  if (
    actionUrl.startsWith("/categorias/") ||
    actionUrl.startsWith("/productos/")
  ) {
    return actionUrl
  }

  return normalizeActionDestination(actionUrl)
}

function normalizeCampaignTargetItems(value: unknown): CampaignTargetItem[] {
  if (!Array.isArray(value)) return []

  return value
    .map((item) => {
      if (typeof item !== "object" || item === null) return null

      const candidate = item as Partial<CampaignTargetItem>

      if (
        (candidate.type !== "category" && candidate.type !== "product") ||
        !candidate.label ||
        !candidate.url?.startsWith("/")
      ) {
        return null
      }

      return {
        type: candidate.type,
        label: candidate.label,
        url: candidate.url,
      }
    })
    .filter((item): item is CampaignTargetItem => Boolean(item))
}

function getPrimaryActionUrl(scope: CommercialScope, items: CampaignTargetItem[]) {
  if (scope === "category" || scope === "product") {
    if (items.length === 1) return items[0].url

    return scope === "category" ? "/categorias" : "/productos"
  }

  if (scope === "store") return "/productos"

  return "/"
}

async function getAdminToken() {
  const {
    data: { session },
  } = await supabase.auth.getSession()

  return session?.access_token ?? ""
}

export function AdminNotificaciones() {
  const [campaigns, setCampaigns] = useState<SupabaseCustomerNotificationCampaign[]>([])
  const [form, setForm] = useState<CampaignForm>(EMPTY_FORM)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [publishingId, setPublishingId] = useState("")
  const [pausingId, setPausingId] = useState("")
  const [deletingId, setDeletingId] = useState("")
  const [campaignToDelete, setCampaignToDelete] =
    useState<SupabaseCustomerNotificationCampaign | null>(null)
  const [categories, setCategories] = useState<NotificationCategory[]>([])
  const [products, setProducts] = useState<NotificationProduct[]>([])
  const [categoryToAdd, setCategoryToAdd] = useState("")
  const [feedback, setFeedback] = useState("")
  const [error, setError] = useState("")

  const selectedType = TYPE_OPTIONS.find((option) => option.value === form.type) ?? TYPE_OPTIONS[0]
  const commercialScope = form.target_scope
  const selectedScope =
    COMMERCIAL_SCOPE_OPTIONS.find((option) => option.value === commercialScope) ??
    COMMERCIAL_SCOPE_OPTIONS[0]
  const previewDestinationLabel = getActionDestinationLabel(
    form.action_url,
    categories,
    products,
  )
  const previewTargetSummary =
    form.target_items.length > 1
      ? `${form.target_items.length} ${
          form.target_scope === "category" ? "categorías" : "productos"
        } alcanzados`
      : previewDestinationLabel
  const previewScopeCount =
    form.target_scope === "category" || form.target_scope === "product"
      ? form.target_items.length
      : 0
  const PreviewIcon = getCampaignIcon(form.type)
  const editing = Boolean(form.id)
  const todayInputDate = getTodayInputDate()

  const stats = useMemo(() => {
    const published = campaigns.filter((campaign) => campaign.status === "published").length

    return {
      total: campaigns.length,
      published,
      drafts: campaigns.length - published,
    }
  }, [campaigns])

  const loadCampaigns = useCallback(async () => {
    setLoading(true)
    setError("")

    try {
      if (form.starts_at && form.starts_at < todayInputDate) {
        throw new Error("La fecha Desde no puede ser anterior al día actual.")
      }

      if (form.ends_at && form.ends_at < todayInputDate) {
        throw new Error("La fecha Hasta no puede ser anterior al día actual.")
      }

      if (form.starts_at && form.ends_at && form.ends_at < form.starts_at) {
        throw new Error("La fecha Hasta no puede ser anterior a la fecha Desde.")
      }

      const token = await getAdminToken()
      const response = await fetch("/api/admin/notifications", {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = (await response.json()) as {
        campaigns?: SupabaseCustomerNotificationCampaign[]
        error?: string
      }

      if (!response.ok) {
        throw new Error(data.error ?? "No se pudieron cargar las notificaciones.")
      }

      setCampaigns(data.campaigns ?? [])
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "No se pudieron cargar las notificaciones.",
      )
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadCampaigns()
  }, [loadCampaigns])

  useEffect(() => {
    let active = true

    async function loadCatalogTargets() {
      const [categoriesResult, productsResult] = await Promise.all([
        supabase.from("categorias").select("id, nombre, slug").order("nombre"),
        supabase
          .from("productos")
          .select("id, nombre, slug, activo")
          .order("nombre"),
      ])

      if (!active) return

      if (!categoriesResult.error) {
        const nextCategories = (categoriesResult.data ?? []) as NotificationCategory[]
        setCategories(nextCategories)
        setCategoryToAdd((current) => current || String(nextCategories[0]?.id ?? ""))
      }

      if (!productsResult.error) {
        const nextProducts = (productsResult.data ?? []) as NotificationProduct[]
        setProducts(nextProducts)
      }
    }

    void loadCatalogTargets()

    return () => {
      active = false
    }
  }, [])

  const resetForm = () => {
    setForm(EMPTY_FORM)
    setFeedback("")
    setError("")
  }

  const updateCommercialScope = (scope: CommercialScope) => {
    setForm((current) => {
      if (scope === "store") {
        return { ...current, target_scope: scope, target_items: [], action_url: "/productos" }
      }

      if (scope === "category") {
        const firstCategory = categories.find(
          (category) => String(category.id) === categoryToAdd,
        ) ?? categories[0]
        const targetItems = firstCategory
          ? [
              {
                type: "category" as const,
                label: firstCategory.nombre,
                url: `/categorias/${firstCategory.slug}`,
              },
            ]
          : []
        return {
          ...current,
          target_scope: scope,
          target_items: targetItems,
          action_url: getPrimaryActionUrl(scope, targetItems),
        }
      }

      if (scope === "product") {
        return {
          ...current,
          target_scope: scope,
          target_items: [],
          action_url: "/productos",
        }
      }

      return { ...current, target_scope: "store", target_items: [], action_url: "/productos" }
    })
  }

  const addCategoryTarget = () => {
    const category = categories.find((item) => String(item.id) === categoryToAdd)
    if (!category) return

    const nextItem: CampaignTargetItem = {
      type: "category",
      label: category.nombre,
      url: `/categorias/${category.slug}`,
    }

    setForm((current) => {
      if (current.target_items.some((item) => item.url === nextItem.url)) {
        return current
      }

      const targetItems = [...current.target_items, nextItem]

      return {
        ...current,
        target_scope: "category",
        target_items: targetItems,
        action_url: getPrimaryActionUrl("category", targetItems),
      }
    })
  }

  const getProductTargetItem = (product: NotificationProduct): CampaignTargetItem => ({
    type: "product",
    label: product.nombre,
    url: `/productos/${product.slug}`,
  })

  const toggleProductTarget = (product: NotificationProduct) => {
    const nextItem = getProductTargetItem(product)

    setForm((current) => {
      if (current.target_items.some((item) => item.url === nextItem.url)) {
        const targetItems = current.target_items.filter((item) => item.url !== nextItem.url)

        return {
          ...current,
          target_scope: "product",
          target_items: targetItems,
          action_url: getPrimaryActionUrl("product", targetItems),
        }
      }

      const targetItems = [...current.target_items, nextItem]

      return {
        ...current,
        target_scope: "product",
        target_items: targetItems,
        action_url: getPrimaryActionUrl("product", targetItems),
      }
    })
  }

  const removeTargetItem = (url: string) => {
    setForm((current) => {
      const targetItems = current.target_items.filter((item) => item.url !== url)

      return {
        ...current,
        target_items: targetItems,
        action_url: getPrimaryActionUrl(current.target_scope, targetItems),
      }
    })
  }

  const saveCampaign = async (publish: boolean) => {
    setSaving(true)
    setFeedback("")
    setError("")

    try {
      const token = await getAdminToken()
      const response = await fetch("/api/admin/notifications", {
        method: form.id ? "PATCH" : "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          id: form.id || undefined,
          type: form.type,
          title: form.title,
          body: form.body,
          action_url: form.action_url,
          target_scope: form.target_scope,
          target_items: form.target_items,
          starts_at: fromDateInput(form.starts_at),
          ends_at: fromDateInput(form.ends_at, true),
          publish,
        }),
      })
      const data = (await response.json()) as {
        campaign?: SupabaseCustomerNotificationCampaign
        publishedCount?: number
        error?: string
      }

      if (!response.ok || !data.campaign) {
        throw new Error(data.error ?? "No se pudo guardar la notificación.")
      }

      setCampaigns((current) => {
        const withoutCurrent = current.filter((campaign) => campaign.id !== data.campaign?.id)
        return [data.campaign!, ...withoutCurrent].sort(
          (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
        )
      })
      setForm({
        id: data.campaign.id,
        type: data.campaign.type,
        title: data.campaign.title,
        body: data.campaign.body,
        action_url: normalizeCampaignActionUrl(data.campaign.action_url),
        target_scope: normalizeCommercialScope(
          data.campaign.target_scope,
          data.campaign.action_url ?? "",
        ),
        target_items: normalizeCampaignTargetItems(data.campaign.target_items),
        starts_at: toDateInput(data.campaign.starts_at),
        ends_at: toDateInput(data.campaign.ends_at),
      })
      setFeedback(
        publish
          ? `Notificación publicada para ${data.publishedCount ?? 0} clientes.`
          : "Notificación guardada.",
      )
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "No se pudo guardar la notificación.",
      )
    } finally {
      setSaving(false)
    }
  }

  const pauseCampaign = async (campaign: SupabaseCustomerNotificationCampaign) => {
    setPausingId(campaign.id)
    setFeedback("")
    setError("")

    try {
      const token = await getAdminToken()
      const response = await fetch("/api/admin/notifications", {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ id: campaign.id, action: "pause" }),
      })
      const data = (await response.json()) as {
        campaign?: SupabaseCustomerNotificationCampaign
        error?: string
      }

      if (!response.ok || !data.campaign) {
        throw new Error(data.error ?? "No se pudo pausar la notificación.")
      }

      setCampaigns((current) =>
        current.map((item) => (item.id === data.campaign?.id ? data.campaign : item)),
      )
      setFeedback("Notificación pausada.")
    } catch (pauseError) {
      setError(
        pauseError instanceof Error
          ? pauseError.message
          : "No se pudo pausar la notificación.",
      )
    } finally {
      setPausingId("")
    }
  }

  const publishCampaign = async (campaign: SupabaseCustomerNotificationCampaign) => {
    setPublishingId(campaign.id)
    setFeedback("")
    setError("")

    try {
      const token = await getAdminToken()
      const response = await fetch("/api/admin/notifications", {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ id: campaign.id, action: "publish" }),
      })
      const data = (await response.json()) as {
        campaign?: SupabaseCustomerNotificationCampaign
        publishedCount?: number
        error?: string
      }

      if (!response.ok || !data.campaign) {
        throw new Error(data.error ?? "No se pudo publicar la notificación.")
      }

      setCampaigns((current) =>
        current.map((item) => (item.id === data.campaign?.id ? data.campaign : item)),
      )
      setFeedback(`Notificación publicada para ${data.publishedCount ?? 0} clientes.`)
    } catch (publishError) {
      setError(
        publishError instanceof Error
          ? publishError.message
          : "No se pudo publicar la notificación.",
      )
    } finally {
      setPublishingId("")
    }
  }

  const deleteCampaign = async (campaign: SupabaseCustomerNotificationCampaign) => {
    setDeletingId(campaign.id)
    setFeedback("")
    setError("")

    try {
      const token = await getAdminToken()
      const response = await fetch(`/api/admin/notifications?id=${campaign.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = (await response.json()) as { error?: string }

      if (!response.ok) {
        throw new Error(data.error ?? "No se pudo eliminar la notificación.")
      }

      setCampaigns((current) => current.filter((item) => item.id !== campaign.id))
      if (form.id === campaign.id) resetForm()
      setCampaignToDelete(null)
      setFeedback("Notificación eliminada.")
    } catch (deleteError) {
      setError(
        deleteError instanceof Error
          ? deleteError.message
          : "No se pudo eliminar la notificación.",
      )
    } finally {
      setDeletingId("")
    }
  }

  const editCampaign = (campaign: SupabaseCustomerNotificationCampaign) => {
    setForm({
      id: campaign.id,
      type: campaign.type,
      title: campaign.title,
      body: campaign.body,
      action_url: normalizeCampaignActionUrl(campaign.action_url),
      target_scope: normalizeCommercialScope(campaign.target_scope, campaign.action_url ?? ""),
      target_items: normalizeCampaignTargetItems(campaign.target_items),
      starts_at: toDateInput(campaign.starts_at),
      ends_at: toDateInput(campaign.ends_at),
    })
    setFeedback("")
    setError("")
  }

  const compactStatCardClassName =
    "min-h-0 p-3 [&_span:last-child]:size-8 [&_p:nth-child(2)]:mt-1 [&_p:nth-child(2)]:text-lg [&_p:nth-child(3)]:mt-0.5 [&_p:nth-child(3)]:text-11px [&_p:nth-child(3)]:leading-4"
  const compactSectionClassName =
    "p-4 [&>div:first-child]:mb-3 [&>div:first-child_h2]:text-base [&>div:first-child_p]:text-xs [&>div:first-child_p]:leading-5"
  const compactInputClassName = "h-8 px-3 text-xs"

  return (
    <div className={cn(adminPageClassName, "w-full max-w-none space-y-4")}>
      <AdminPageHeader
        eyebrow="Comunicación"
        title="Notificaciones"
        description="Creá campañas breves para promociones, eventos, descuentos, cuotas sin interés o productos destacados. Las publicaciones llegan al panel de notificaciones de cada cliente."
        className="[&_h1]:text-2xl [&_p:last-child]:max-w-2xl [&_p:last-child]:text-xs [&_p:last-child]:leading-5"
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <AdminStatCard
          title="Campañas"
          value={stats.total}
          helper="Total creadas en el panel"
          icon={<Megaphone className="size-4" />}
          className={compactStatCardClassName}
        />
        <AdminStatCard
          title="Publicadas"
          value={stats.published}
          helper="Visibles para clientes"
          icon={<Send className="size-4" />}
          tone="success"
          className={compactStatCardClassName}
        />
        <AdminStatCard
          title="Borradores"
          value={stats.drafts}
          helper="Pendientes de enviar"
          icon={<Edit3 className="size-4" />}
          tone="warning"
          className={compactStatCardClassName}
        />
      </div>

      {(feedback || error) && (
        <AdminInfoBlock tone={error ? "danger" : "success"}>
          {error || feedback}
        </AdminInfoBlock>
      )}

      <div className="grid items-start gap-4 2xl:grid-cols-[minmax(0,1fr)_300px]">
        <AdminSection
          eyebrow={editing ? "Editando" : "Nueva campaña"}
          title={editing ? "Modificar notificación" : "Crear notificación"}
          description="Usá textos cortos y una acción clara. Si la publicás, se envía a todos los clientes registrados."
          className={compactSectionClassName}
        >
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-[150px_220px_150px_150px_minmax(260px,1fr)] xl:items-start">
            <AdminFormField label="Tipo" className="xl:col-start-1">
              <AdminSelect
                title="Tipo de notificación"
                value={form.type}
                compact
                triggerClassName="h-8 text-xs"
                onChange={(value) =>
                  setForm((current) => ({
                    ...current,
                    type: value as SupabaseCustomerNotificationCampaignType,
                  }))
                }
              >
                {TYPE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </AdminSelect>
            </AdminFormField>

            <AdminFormField label="Alcance comercial" className="xl:col-start-2" help={selectedScope.help}>
              <AdminSelect
                title="Alcance comercial"
                value={commercialScope}
                compact
                triggerClassName="h-8 text-xs"
                onChange={(value) => updateCommercialScope(value as CommercialScope)}
              >
                {COMMERCIAL_SCOPE_OPTIONS.map((scope) => (
                  <option key={scope.value} value={scope.value}>
                    {scope.label}
                  </option>
                ))}
              </AdminSelect>
            </AdminFormField>

            {commercialScope === "category" && (
              <AdminFormField label="Categorías alcanzadas" className="sm:col-span-2 xl:col-span-2 xl:col-start-1 xl:row-start-3" help="Podés agregar más de una categoría afectada por la promoción.">
                <div className="flex gap-2">
                  <AdminSelect
                    title="Categoría para agregar"
                    value={categoryToAdd}
                    disabled={categories.length === 0}
                    compact
                    triggerClassName="h-8 text-xs"
                    onChange={setCategoryToAdd}
                  >
                    {categories.length ? (
                      categories.map((category) => (
                        <option key={category.id} value={String(category.id)}>
                          {category.nombre}
                        </option>
                      ))
                    ) : (
                      <option value="">Sin categorías disponibles</option>
                    )}
                  </AdminSelect>
                  <AdminButton
                    size="icon"
                    title="Agregar categoría"
                    aria-label="Agregar categoría"
                    disabled={categories.length === 0}
                    className="size-8 min-h-0 font-medium"
                    onClick={addCategoryTarget}
                  >
                    <Plus className="size-4" />
                  </AdminButton>
                </div>
              </AdminFormField>
            )}

            {commercialScope === "product" && (
              <div className="sm:col-span-2 xl:col-span-3 xl:col-start-1 xl:row-start-3">
                <p className="mb-2 text-11px font-black uppercase tracking-widest text-white/48">
                  Productos alcanzados
                </p>
                <div className="custom-scrollbar max-h-36 max-w-[520px] overflow-y-auto rounded-xl border border-beyonix-blue-light/14 bg-black/18 p-1.5">
                  {products.length === 0 ? (
                    <div className="px-3 py-3 text-xs text-white/45">
                      No hay productos disponibles para seleccionar.
                    </div>
                  ) : (
                    products.map((product) => {
                      const item = getProductTargetItem(product)
                      const checked = form.target_items.some((target) => target.url === item.url)

                      return (
                        <button
                          key={product.id}
                          type="button"
                          onClick={() => toggleProductTarget(product)}
                          className="grid w-full cursor-pointer grid-cols-[18px_minmax(0,1fr)] items-center gap-2 rounded-lg px-2.5 py-2 text-left transition hover:bg-beyonix-blue/18"
                        >
                          <span
                            className={`grid size-4 shrink-0 place-items-center rounded border ${
                              checked
                                ? "border-beyonix-sky bg-beyonix-blue text-white"
                                : "border-beyonix-blue-light/24 bg-black/20 text-transparent"
                            }`}
                          >
                            <CheckCircle2 className="size-3" />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-xs font-medium text-white/86">
                              {product.nombre}
                            </span>
                            {!product.activo && (
                              <span className="mt-0.5 block text-11px text-amber-200/70">
                                Producto inactivo
                              </span>
                            )}
                          </span>
                        </button>
                      )
                    })
                  )}
                </div>
                <p className="mt-1.5 text-11px leading-4 text-white/45">
                  Marcá uno o varios productos afectados por la promoción.
                </p>
              </div>
            )}

            {(commercialScope === "category" || commercialScope === "product") && (
              <div className="sm:col-span-2 xl:col-span-2 xl:col-start-4 xl:row-start-3">
                <p className="mb-2 text-11px font-black uppercase tracking-widest text-white/48">
                  {commercialScope === "category"
                    ? "Categorías agregadas"
                    : "Productos agregados"}
                </p>
                {form.target_items.length ? (
                  <div className="flex flex-wrap gap-2 rounded-xl border border-beyonix-blue-light/14 bg-black/18 p-2.5">
                    {form.target_items.map((item) => (
                      <span
                        key={item.url}
                        className="inline-flex max-w-full items-center gap-2 rounded-full border border-beyonix-blue-light/24 bg-beyonix-blue/18 px-3 py-1.5 text-xs font-medium text-white/82"
                      >
                        <span className="truncate">{item.label}</span>
                        <button
                          type="button"
                          aria-label={`Quitar ${item.label}`}
                          onClick={() => removeTargetItem(item.url)}
                          className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-full text-white/50 transition hover:bg-white/10 hover:text-white"
                        >
                          <X className="size-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                ) : (
                  <div className="rounded-xl border border-beyonix-blue-light/14 bg-black/18 px-3 py-2 text-xs text-white/45">
                    Todavía no agregaste ningún alcance.
                  </div>
              )}
            </div>
          )}

          <AdminFormField label="Desde" className="xl:col-start-3 [&_input]:h-8 [&_input]:px-3 [&_input]:text-xs [&_button]:size-7" help="Opcional.">
              <AdminDatePicker
                title="Desde"
                ariaLabel="Desde"
                placeholder="Desde"
                value={form.starts_at}
                minDate={todayInputDate}
                onChange={(value) =>
                  setForm((current) => ({
                    ...current,
                    starts_at: value,
                    ends_at: current.ends_at && value && current.ends_at < value ? "" : current.ends_at,
                  }))
                }
              />
            </AdminFormField>

            <AdminFormField label="Hasta" className="xl:col-start-4 [&_input]:h-8 [&_input]:px-3 [&_input]:text-xs [&_button]:size-7" help="Opcional.">
              <AdminDatePicker
                title="Hasta"
                ariaLabel="Hasta"
                placeholder="Hasta"
                value={form.ends_at}
                minDate={form.starts_at || todayInputDate}
                onChange={(value) =>
                  setForm((current) => ({ ...current, ends_at: value }))
                }
              />
            </AdminFormField>

            <AdminFormField label="Título" className="sm:col-span-2 xl:col-span-1 xl:col-start-5" help={`${form.title.length}/80 caracteres`}>
              <AdminTextInput
                title="Título"
                placeholder="Cyber BEYONIX: descuentos activos"
                value={form.title}
                className={compactInputClassName}
                onChange={(value) =>
                  setForm((current) => ({ ...current, title: value.slice(0, 80) }))
                }
              />
            </AdminFormField>

            <AdminFormField label="Mensaje" className="sm:col-span-2 xl:col-span-5" help={`${form.body.length}/220 caracteres`}>
              <AdminTextarea
                title="Mensaje"
                placeholder="Aprovechá ofertas seleccionadas por tiempo limitado."
                value={form.body}
                className="min-h-12 py-2 text-xs leading-5"
                onChange={(value) =>
                  setForm((current) => ({ ...current, body: value.slice(0, 220) }))
                }
              />
            </AdminFormField>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <AdminPrimaryButton
              icon={<Send className="size-4" />}
              disabled={saving}
              size="sm"
              className="font-medium"
              onClick={() => void saveCampaign(true)}
            >
              {saving ? "Guardando" : editing ? "Guardar y publicar" : "Crear y publicar"}
            </AdminPrimaryButton>
            <AdminButton
              icon={<Edit3 className="size-4" />}
              disabled={saving}
              size="sm"
              className="font-medium"
              onClick={() => void saveCampaign(false)}
            >
              Guardar borrador
            </AdminButton>
            {editing && (
              <AdminButton disabled={saving} size="sm" className="font-medium" onClick={resetForm}>
                Cancelar edición
              </AdminButton>
            )}
          </div>
        </AdminSection>

        <AdminSection
          eyebrow="Vista previa"
          title="Así lo verá el cliente"
          description={selectedType.description}
          className={compactSectionClassName}
        >
          <div className="rounded-xl border border-beyonix-blue-light/20 bg-[rgba(4,10,18,0.72)] p-3">
            <div className="flex items-start gap-2.5">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-beyonix-blue-light/30 bg-beyonix-blue/25 text-beyonix-sky">
                <PreviewIcon className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <AdminBadge tone="info">{selectedType.label}</AdminBadge>
                  <span className="text-10px font-black uppercase tracking-widest text-white/35">
                    BEYONIX
                  </span>
                </div>
                <p className="mt-2 text-sm font-black text-white">
                  {form.title || "Título de la notificación"}
                </p>
                <p className="mt-1 text-xs leading-5 text-white/62">
                  {form.body || "Mensaje breve para que el cliente entienda la novedad sin saturar el panel."}
                </p>
                <p className="mt-2 text-11px font-black text-beyonix-sky">
                  {previewTargetSummary}
                </p>
                {previewScopeCount > 1 && (
                  <p className="mt-1 text-11px font-bold text-white/42">
                    + {previewScopeCount - 1} más en esta promoción
                  </p>
                )}
              </div>
            </div>
          </div>
        </AdminSection>
      </div>

      <AdminSection
        eyebrow="Historial"
        title="Campañas creadas"
        description="Editá, publicá o eliminá notificaciones comerciales desde un solo lugar."
        className={cn(
          compactSectionClassName,
          "p-3 [&>div:first-child]:mb-2 [&>div:first-child_h2]:text-sm [&>div:first-child_p]:mt-0.5 [&>div:first-child_p]:leading-4",
        )}
      >
        {loading ? (
          <AdminSkeleton rows={4} />
        ) : campaigns.length === 0 ? (
          <AdminEmptyState
            icon={<BellRing className="size-5" />}
            title="Todavía no hay notificaciones."
            description="Cuando crees la primera campaña va a aparecer en este listado."
          />
        ) : (
          <AdminTable
            headers={["Campaña", "Estado", "Actualización", "Acciones"]}
            columnsClassName="grid-cols-[minmax(0,1fr)_132px_150px_112px]"
            className="[&_.admin-ds-table-header]:px-3 [&_.admin-ds-table-header]:py-2 [&_.admin-ds-table-header>*:nth-child(n+2)]:text-center"
          >
            {campaigns.map((campaign) => {
              const Icon = getCampaignIcon(campaign.type)
              const isPublished = campaign.status === "published"

              return (
                <div
                  key={campaign.id}
                  className="grid gap-2 border-t border-beyonix-blue-light/12 px-3 py-2 first:border-t-0 xl:grid-cols-[minmax(0,1fr)_132px_150px_112px] xl:items-center"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-beyonix-blue-light/22 bg-beyonix-blue/18 text-beyonix-sky">
                      <Icon className="size-3" />
                    </span>
                    <div className="min-w-0">
                      <p className="truncate text-xs font-black text-white">{campaign.title}</p>
                      <p className="mt-0.5 truncate text-11px leading-4 text-white/52">
                        {campaign.body}
                      </p>
                      <p className="mt-0.5 text-10px font-bold text-beyonix-sky/80">
                        {TYPE_LABELS[campaign.type]}
                      </p>
                    </div>
                  </div>

                  <div className="flex xl:justify-center">
                    <AdminBadge tone={isPublished ? "success" : "warning"} className="w-fit text-10px">
                      {isPublished ? "Publicada" : "Borrador"}
                    </AdminBadge>
                  </div>

                  <span className="text-11px font-bold text-white/50 xl:text-center">
                    {formatDate(campaign.published_at ?? campaign.updated_at)}
                  </span>

                  <div className="flex flex-wrap items-center gap-1.5 xl:flex-nowrap xl:justify-end">
                    <AdminButton
                      size="icon"
                      title="Editar"
                      aria-label="Editar"
                      className="size-8 min-h-0"
                      onClick={() => editCampaign(campaign)}
                    >
                      <Edit3 className="size-3.5" />
                    </AdminButton>
                    {isPublished && (
                      <AdminButton
                        size="icon"
                        title="Pausar"
                        aria-label="Pausar"
                        disabled={pausingId === campaign.id}
                        className={cn("size-8 min-h-0", pausingId === campaign.id && "opacity-60")}
                        onClick={() => void pauseCampaign(campaign)}
                      >
                        <Pause className="size-3.5" />
                      </AdminButton>
                    )}
                    {!isPublished && (
                      <AdminButton
                        size="icon"
                        title={campaign.published_at ? "Reanudar" : "Publicar"}
                        aria-label={campaign.published_at ? "Reanudar" : "Publicar"}
                        disabled={publishingId === campaign.id}
                        className={cn("size-8 min-h-0", publishingId === campaign.id && "opacity-60")}
                        onClick={() => void publishCampaign(campaign)}
                      >
                        <Play className="size-3.5" />
                      </AdminButton>
                    )}
                    <AdminButton
                      variant="destructive"
                      size="icon"
                      title="Eliminar"
                      aria-label="Eliminar"
                      disabled={deletingId === campaign.id}
                      className={cn(
                        "size-8 min-h-0",
                        deletingId === campaign.id && "opacity-60",
                      )}
                      onClick={() => setCampaignToDelete(campaign)}
                    >
                      <Trash2 className="size-3.5" />
                    </AdminButton>
                  </div>
                </div>
              )
            })}
          </AdminTable>
        )}
      </AdminSection>

      <AdminModal
        open={Boolean(campaignToDelete)}
        eyebrow="Confirmación"
        title="Eliminar notificación"
        description={
          campaignToDelete
            ? `Se quitará "${campaignToDelete.title}" y dejará de aparecer en los clientes que la recibieron.`
            : undefined
        }
        onClose={() => {
          if (deletingId) return
          setCampaignToDelete(null)
        }}
        footer={
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <AdminGhostButton
              disabled={Boolean(deletingId)}
              className="font-medium"
              onClick={() => setCampaignToDelete(null)}
            >
              Cancelar
            </AdminGhostButton>
            <AdminDangerButton
              icon={<Trash2 className="size-4" />}
              disabled={!campaignToDelete || Boolean(deletingId)}
              className="font-medium"
              onClick={() => {
                if (!campaignToDelete) return
                void deleteCampaign(campaignToDelete)
              }}
            >
              {deletingId ? "Eliminando" : "Eliminar"}
            </AdminDangerButton>
          </div>
        }
      >
        <div className="rounded-2xl border border-red-400/16 bg-red-500/8 px-4 py-3 text-sm leading-6 text-red-100/82">
          Esta acción no afecta pedidos ni cuentas. Solo borra la campaña y sus
          notificaciones promocionales asociadas.
        </div>
      </AdminModal>
    </div>
  )
}
