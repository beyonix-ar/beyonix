"use client"

import { useEffect, useState } from "react"
import {
  BadgePercent,
  CalendarDays,
  Check,
  CheckCircle2,
  Edit3,
  Package,
  Pause,
  Play,
  RotateCcw,
  Save,
  Search,
  Trash2,
  TrendingDown,
  TrendingUp,
  X,
} from "lucide-react"

import {
  AdminButton,
  AdminFormField,
  AdminInfoBlock,
  AdminPageHeader,
  AdminPrimaryButton,
  AdminSection,
  AdminSelect,
  AdminTextInput,
  adminPageClassName,
} from "@/app/admin/components/admin-controls"
import { AdminDatePicker } from "@/app/admin/components/admin-date-picker"
import { supabase } from "@/lib/supabase/client"
import type {
  SupabaseCategoria,
  SupabaseProducto,
  SupabaseProductBulkEvent,
} from "@/lib/supabase/types"

type EventScope = "store" | "category" | "product"
type EventActionKind =
  | "discount_percent"
  | "installments"

type TargetItem = {
  type: "category" | "product"
  label: string
  url: string
}

type CategoryOption = Pick<SupabaseCategoria, "id" | "nombre" | "slug">
type ProductOption = Pick<SupabaseProducto, "id" | "nombre" | "slug" | "activo" | "sku">

type EventForm = {
  id: string
  internalName: string
  startsOn: string
  endsOn: string
  scope: EventScope
  targetItems: TargetItem[]
  actionKind: EventActionKind
  value: string
  installments: string
}

const EMPTY_FORM: EventForm = {
  id: "",
  internalName: "",
  startsOn: "",
  endsOn: "",
  scope: "product",
  targetItems: [],
  actionKind: "discount_percent",
  value: "10",
  installments: "3",
}

const ACTION_OPTIONS: Array<{
  value: EventActionKind
  label: string
  help: string
}> = [
  {
    value: "discount_percent",
    label: "Descuento especial",
    help: "Baja el precio y guarda el anterior para mostrar el % OFF.",
  },
  {
    value: "installments",
    label: "Cuotas sin interés",
    help: "Activa 3 o 6 cuotas sin interés.",
  },
]

const PERCENT_ACTIONS: EventActionKind[] = ["discount_percent"]

async function getAdminToken() {
  const {
    data: { session },
  } = await supabase.auth.getSession()

  return session?.access_token ?? ""
}

function getActionLabel(kind: EventActionKind) {
  return ACTION_OPTIONS.find((option) => option.value === kind)?.label ?? "Evento"
}

function normalizeEventActionKind(value: string | null | undefined): EventActionKind {
  return value === "installments" ? "installments" : "discount_percent"
}

function formatEventDate(value: string | null) {
  if (!value) return "Sin inicio"

  const [year, month, day] = value.split("-")
  if (!year || !month || !day) return "Sin inicio"

  return `${day}/${month}/${year}`
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

function isFutureEvent(event: SupabaseProductBulkEvent) {
  return Boolean(event.starts_on && event.starts_on > getTodayInputDate())
}

function toInputDate(date: Date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")

  return `${year}-${month}-${day}`
}

function getEventEndDate(startsOn: string | null, durationDays: number | null) {
  if (!startsOn || !durationDays) return ""

  const date = new Date(`${startsOn}T00:00:00`)
  if (Number.isNaN(date.getTime())) return ""

  date.setDate(date.getDate() + durationDays - 1)

  return toInputDate(date)
}

function getDurationDays(startsOn: string, endsOn: string) {
  if (!startsOn || !endsOn) return null

  const start = new Date(`${startsOn}T00:00:00`)
  const end = new Date(`${endsOn}T00:00:00`)

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null

  const diff = Math.round((end.getTime() - start.getTime()) / 86400000) + 1

  return diff > 0 ? diff : 0
}

function formatEventDetail(event: SupabaseProductBulkEvent) {
  const actionKind = normalizeEventActionKind(event.action_kind)

  if (PERCENT_ACTIONS.includes(actionKind)) {
    return `${getActionLabel(actionKind)} ${event.value ?? 0}%`
  }

  if (actionKind === "installments") {
    return `${event.installments ?? 3} cuotas sin interés`
  }

  return getActionLabel(actionKind)
}

export function AdminEventos() {
  const [form, setForm] = useState<EventForm>(EMPTY_FORM)
  const [categories, setCategories] = useState<CategoryOption[]>([])
  const [products, setProducts] = useState<ProductOption[]>([])
  const [productSearch, setProductSearch] = useState("")
  const [events, setEvents] = useState<SupabaseProductBulkEvent[]>([])
  const [saving, setSaving] = useState(false)
  const [activatingId, setActivatingId] = useState("")
  const [deletingId, setDeletingId] = useState("")
  const [cleaningOrphans, setCleaningOrphans] = useState(false)
  const [feedback, setFeedback] = useState("")
  const [error, setError] = useState("")

  const selectedAction = ACTION_OPTIONS.find((item) => item.value === form.actionKind)
  const isPercentAction = PERCENT_ACTIONS.includes(form.actionKind)
  const todayInputDate = getTodayInputDate()
  const normalizedProductSearch = productSearch
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLocaleLowerCase("es")
  const filteredProducts = products.filter((product) =>
    `${product.nombre} ${product.sku ?? ""}`
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLocaleLowerCase("es")
      .includes(normalizedProductSearch),
  )

  useEffect(() => {
    let active = true

    async function loadCatalog() {
      const [categoriesResult, productsResult] = await Promise.all([
        supabase.from("categorias").select("id, nombre, slug").order("nombre"),
        supabase.from("productos").select("id, nombre, slug, activo, sku").order("nombre"),
      ])

      if (!active) return

      const nextCategories = (categoriesResult.data ?? []) as CategoryOption[]
      const nextProducts = (productsResult.data ?? []) as ProductOption[]

      setCategories(nextCategories)
      setProducts(nextProducts)
    }

    void loadCatalog()

    return () => {
      active = false
    }
  }, [])

  const loadEvents = async () => {
    try {
      const token = await getAdminToken()
      const response = await fetch("/api/admin/product-bulk-events", {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = (await response.json()) as {
        events?: SupabaseProductBulkEvent[]
        error?: string
      }

      if (!response.ok) {
        throw new Error(data.error ?? "No se pudieron cargar los eventos.")
      }

      setEvents(data.events ?? [])
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : "No se pudieron cargar los eventos.",
      )
    }
  }

  useEffect(() => {
    void loadEvents()
  }, [])

  const getProductTargetItem = (product: ProductOption): TargetItem => ({
    type: "product",
    label: product.nombre,
    url: `/productos/${product.slug}`,
  })

  const getCategoryTargetItem = (category: CategoryOption): TargetItem => ({
    type: "category",
    label: category.nombre,
    url: `/categorias/${category.slug}`,
  })

  const setScope = (scope: EventScope) => {
    setForm((current) => ({ ...current, scope, targetItems: [] }))
  }

  const toggleProduct = (product: ProductOption) => {
    const item = getProductTargetItem(product)

    setForm((current) => ({
      ...current,
      scope: "product",
      targetItems: current.targetItems.some((target) => target.url === item.url)
        ? current.targetItems.filter((target) => target.url !== item.url)
        : [...current.targetItems, item],
    }))
  }

  const toggleCategory = (category: CategoryOption) => {
    const item = getCategoryTargetItem(category)

    setForm((current) => ({
      ...current,
      scope: "category",
      targetItems: current.targetItems.some((target) => target.url === item.url)
        ? current.targetItems.filter((target) => target.url !== item.url)
        : [...current.targetItems, item],
    }))
  }

  const removeTarget = (url: string) => {
    setForm((current) => ({
      ...current,
      targetItems: current.targetItems.filter((target) => target.url !== url),
    }))
  }

  const resetForm = () => {
    setForm(EMPTY_FORM)
  }

  const saveEvent = async () => {
    setSaving(true)
    setFeedback("")
    setError("")

    try {
      const durationDays = getDurationDays(form.startsOn, form.endsOn)

      if (form.startsOn && form.startsOn < todayInputDate) {
        throw new Error("La fecha de inicio no puede ser anterior al día actual.")
      }

      if (form.endsOn && form.endsOn < todayInputDate) {
        throw new Error("La fecha Hasta no puede ser anterior al día actual.")
      }

      if (form.startsOn && form.endsOn && durationDays === 0) {
        throw new Error("La fecha Hasta no puede ser anterior al inicio.")
      }

      const token = await getAdminToken()
      const response = await fetch("/api/admin/product-bulk-events", {
        method: form.id ? "PATCH" : "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          id: form.id || undefined,
          internal_name: form.internalName,
          starts_on: form.startsOn,
          duration_days: durationDays,
          scope: form.scope,
          target_items: form.targetItems,
          action_kind: form.actionKind,
          value: form.value ? Number(form.value) : null,
          installments: Number(form.installments),
        }),
      })
      const data = (await response.json()) as {
        event?: SupabaseProductBulkEvent
        restoredCount?: number
        error?: string
      }

      if (!response.ok || !data.event) {
        throw new Error(data.error ?? "No se pudo guardar el evento.")
      }

      setEvents((current) => {
        const withoutEvent = current.filter((event) => event.id !== data.event?.id)
        return [data.event!, ...withoutEvent].sort(
          (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
        )
      })
      setFeedback(
        form.id && data.restoredCount
          ? `Evento actualizado. Se restauraron ${data.restoredCount} productos y quedó guardado para la nueva fecha.`
          : form.id
            ? "Evento actualizado."
            : "Evento guardado.",
      )
      setForm({
        id: data.event.id,
        internalName: data.event.internal_name,
        startsOn: data.event.starts_on ?? "",
        endsOn: getEventEndDate(data.event.starts_on, data.event.duration_days),
        scope: data.event.scope,
        targetItems: data.event.target_items ?? [],
        actionKind: normalizeEventActionKind(data.event.action_kind),
        value: String(data.event.value ?? ""),
        installments: String(data.event.installments ?? "3"),
      })
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "No se pudo guardar el evento.")
    } finally {
      setSaving(false)
    }
  }

  const editEvent = (event: SupabaseProductBulkEvent) => {
    setForm({
      id: event.id,
      internalName: event.internal_name,
      startsOn: event.starts_on ?? "",
      endsOn: getEventEndDate(event.starts_on, event.duration_days),
      scope: event.scope,
      targetItems: event.target_items ?? [],
      actionKind: normalizeEventActionKind(event.action_kind),
      value: String(event.value ?? ""),
      installments: String(event.installments ?? "3"),
    })
  }

  const activateEvent = async (event: SupabaseProductBulkEvent) => {
    const active = event.status === "active"

    if (!active && isFutureEvent(event)) {
      setError(`Este evento empieza el ${formatEventDate(event.starts_on)}. No se puede activar antes de esa fecha.`)
      setFeedback("")
      return
    }

    setActivatingId(event.id)
    setFeedback("")
    setError("")

    try {
      const token = await getAdminToken()
      const response = await fetch("/api/admin/product-bulk-events", {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ id: event.id, action: active ? "pause" : "activate" }),
      })
      const data = (await response.json()) as {
        event?: SupabaseProductBulkEvent
        affectedCount?: number
        restoredCount?: number
        error?: string
      }

      if (!response.ok || !data.event) {
        throw new Error(data.error ?? (active ? "No se pudo pausar el evento." : "No se pudo activar el evento."))
      }

      setEvents((current) =>
        current.map((item) => (item.id === data.event?.id ? data.event : item)),
      )
      setFeedback(
        active
          ? `Evento pausado. Se restauraron ${data.restoredCount ?? 0} productos.`
          : `Evento activado sobre ${data.affectedCount ?? 0} productos.`,
      )
    } catch (activateError) {
      setError(
        activateError instanceof Error
          ? activateError.message
          : active
            ? "No se pudo pausar el evento."
            : "No se pudo activar el evento.",
      )
    } finally {
      setActivatingId("")
    }
  }

  const deleteEvent = async (event: SupabaseProductBulkEvent) => {
    setDeletingId(event.id)
    setFeedback("")
    setError("")

    try {
      const token = await getAdminToken()
      const response = await fetch(`/api/admin/product-bulk-events?id=${event.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = (await response.json()) as { error?: string; restoredCount?: number }

      if (!response.ok) {
        throw new Error(data.error ?? "No se pudo eliminar el evento.")
      }

      setEvents((current) => current.filter((item) => item.id !== event.id))
      if (form.id === event.id) resetForm()
      setFeedback(
        data.restoredCount
          ? `Evento eliminado. Se restauraron ${data.restoredCount} productos.`
          : "Evento eliminado.",
      )
    } catch (deleteError) {
      setError(
        deleteError instanceof Error ? deleteError.message : "No se pudo eliminar el evento.",
      )
    } finally {
      setDeletingId("")
    }
  }

  const cleanupOrphanOffers = async () => {
    setCleaningOrphans(true)
    setFeedback("")
    setError("")

    try {
      const token = await getAdminToken()
      const response = await fetch("/api/admin/product-bulk-events", {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action: "cleanup_orphan_offers" }),
      })
      const data = (await response.json()) as { cleanedCount?: number; error?: string }

      if (!response.ok) {
        throw new Error(data.error ?? "No se pudieron limpiar las ofertas fantasma.")
      }

      setFeedback(
        data.cleanedCount
          ? `Se limpiaron ${data.cleanedCount} ofertas fantasma.`
          : "No encontramos ofertas fantasma para limpiar.",
      )
    } catch (cleanupError) {
      setError(
        cleanupError instanceof Error
          ? cleanupError.message
          : "No se pudieron limpiar las ofertas fantasma.",
      )
    } finally {
      setCleaningOrphans(false)
    }
  }

  return (
    <div className={adminPageClassName}>
      <AdminPageHeader
        eyebrow="Comercial"
        title="Eventos"
        description="Programá campañas internas y activalas cuando lo necesites. El nombre del evento nunca se muestra al cliente."
      />

      {(feedback || error) && (
        <AdminInfoBlock tone={error ? "danger" : "success"}>
          {error || feedback}
        </AdminInfoBlock>
      )}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,0.9fr)_minmax(360px,0.7fr)]">
        <AdminSection
          eyebrow="Evento"
          title={form.id ? "Editar evento" : "Crear evento"}
          className="p-3 sm:p-4"
        >
          <div className="grid gap-4 lg:grid-cols-[minmax(260px,390px)_minmax(320px,1fr)]">
            <div className="grid content-start gap-3">
              <AdminFormField label="Nombre interno">
                <AdminTextInput
                  title="Nombre interno"
                  placeholder="Hot Sale mayo"
                  value={form.internalName}
                  onChange={(value) =>
                    setForm((current) => ({ ...current, internalName: value }))
                  }
                />
              </AdminFormField>

              <div className="grid gap-3 sm:grid-cols-[150px_150px]">
                <AdminFormField label="Inicio">
                  <div className="max-w-[150px]">
                    <AdminDatePicker
                      title="Inicio del evento"
                      ariaLabel="Inicio del evento"
                      placeholder="Inicio"
                      value={form.startsOn}
                      minDate={todayInputDate}
                      onChange={(value) =>
                        setForm((current) => ({
                          ...current,
                          startsOn: value,
                          endsOn: current.endsOn && value && current.endsOn < value ? "" : current.endsOn,
                        }))
                      }
                    />
                  </div>
                </AdminFormField>

                <AdminFormField label="Hasta">
                  <div className="max-w-[150px]">
                    <AdminDatePicker
                      title="Hasta del evento"
                      ariaLabel="Hasta del evento"
                      placeholder="Hasta"
                      value={form.endsOn}
                      minDate={form.startsOn || todayInputDate}
                      onChange={(value) =>
                        setForm((current) => ({ ...current, endsOn: value }))
                      }
                    />
                  </div>
                </AdminFormField>
              </div>

              <AdminFormField label="Promoción" help={selectedAction?.help}>
                <AdminSelect
                  title="Promoción"
                  value={form.actionKind}
                  onChange={(value) =>
                    setForm((current) => ({ ...current, actionKind: value as EventActionKind }))
                  }
                >
                  {ACTION_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </AdminSelect>
              </AdminFormField>

              {isPercentAction && (
                <AdminFormField label="Porcentaje" className="max-w-[104px]">
                  <AdminTextInput
                    title="Porcentaje"
                    type="number"
                    inputMode="numeric"
                    placeholder="10"
                    value={form.value}
                    onChange={(value) => setForm((current) => ({ ...current, value }))}
                  />
                </AdminFormField>
              )}

              {form.actionKind === "installments" && (
                <AdminFormField label="Cuotas">
                  <AdminSelect
                    title="Cuotas"
                    value={form.installments}
                    onChange={(value) =>
                      setForm((current) => ({ ...current, installments: value }))
                    }
                  >
                    <option value="3">3 cuotas sin interés</option>
                    <option value="6">6 cuotas sin interés</option>
                  </AdminSelect>
                </AdminFormField>
              )}

              <AdminFormField label="Alcance">
                <AdminSelect
                  title="Alcance"
                  value={form.scope}
                  onChange={(value) => setScope(value as EventScope)}
                >
                  <option value="product">Productos del evento</option>
                  <option value="category">Categorías del evento</option>
                  <option value="store">Toda la tienda</option>
                </AdminSelect>
              </AdminFormField>

              {form.scope !== "store" && (
                <div>
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <p className="text-11px font-black uppercase tracking-widest text-white/48">
                      Selección
                    </p>
                    {form.targetItems.length > 0 && (
                      <span className="rounded-full border border-beyonix-blue-light/18 bg-beyonix-blue/12 px-2 py-0.5 text-10px uppercase tracking-widest text-beyonix-sky/80">
                        {form.targetItems.length} seleccionados
                      </span>
                    )}
                  </div>
                  {form.targetItems.length ? (
                    <div className="beyonix-product-picker-scroll flex max-h-[58px] min-h-[44px] flex-wrap items-center gap-1.5 overflow-y-auto rounded-lg border border-beyonix-blue-light/14 bg-black/12 px-2 py-1.5 pr-2.5">
                      {form.targetItems.map((item) => (
                        <span
                          key={item.url}
                          className="group inline-flex h-7 max-w-full items-center gap-1.5 rounded-md border border-beyonix-blue-light/20 bg-[#0d2236] px-2 text-11px font-medium text-white/86 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] transition hover:border-beyonix-sky/38 hover:bg-[#12365a]"
                        >
                          <span className="max-w-28 truncate sm:max-w-36">{item.label}</span>
                          <button
                            type="button"
                            aria-label={`Quitar ${item.label}`}
                            onClick={() => removeTarget(item.url)}
                            className="grid size-4 shrink-0 cursor-pointer place-items-center rounded-full text-white/38 transition hover:text-red-300"
                          >
                            <X className="size-2.5" strokeWidth={2.4} />
                          </button>
                        </span>
                      ))}
                    </div>
                  ) : (
                    <div className="rounded-xl border border-beyonix-blue-light/14 bg-black/18 px-3 py-2 text-sm text-white/45">
                      Agregá al menos un elemento.
                    </div>
                  )}
                </div>
              )}

              <div className="flex flex-wrap gap-2 pt-1">
                <AdminPrimaryButton
                  size="sm"
                  icon={<Save className="size-3.5" />}
                  disabled={saving}
                  className="font-medium"
                  onClick={() => void saveEvent()}
                >
                  {saving ? "Guardando" : form.id ? "Guardar cambios" : "Guardar evento"}
                </AdminPrimaryButton>
                {form.id && (
                  <AdminButton size="sm" className="font-medium" onClick={resetForm}>
                    Nuevo
                  </AdminButton>
                )}
              </div>
            </div>

            <div className="rounded-2xl border border-beyonix-blue-light/14 bg-black/12 p-3">
              {form.scope === "product" && (
                <>
                  <p className="mb-2 text-11px font-black uppercase tracking-widest text-white/48">
                    Productos
                  </p>
                  <AdminTextInput
                    title="Buscar productos"
                    ariaLabel="Buscar productos por nombre o SKU"
                    value={productSearch}
                    onChange={setProductSearch}
                    placeholder="Buscar por nombre o SKU..."
                    icon={<Search className="size-4" />}
                    className="mb-2 h-9 text-xs"
                  />
                  <div className="beyonix-product-picker-scroll h-72 overflow-y-scroll rounded-xl border border-beyonix-blue-light/14 bg-black/18 p-1.5 pr-2">
                    {filteredProducts.map((product) => {
                      const item = getProductTargetItem(product)
                      const checked = form.targetItems.some((target) => target.url === item.url)

                      return (
                        <button
                          key={product.id}
                          type="button"
                          onClick={() => toggleProduct(product)}
                          className="grid w-full cursor-pointer grid-cols-[18px_minmax(0,1fr)] items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left transition hover:bg-[#1E4D7B]/32"
                        >
                          <span
                            className={`grid size-4 shrink-0 place-items-center rounded border transition ${
                              checked
                                ? "border-beyonix-sky bg-beyonix-sky text-[#06111d] shadow-[0_0_0_2px_rgba(140,200,242,0.12)]"
                                : "border-beyonix-blue-light/36 bg-[#07111d]"
                            }`}
                          >
                            {checked && <Check className="size-3" strokeWidth={3} />}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-xs font-medium text-white/86">
                              {product.nombre}
                            </span>
                            {product.sku && (
                              <span className="block truncate text-10px text-white/40">
                                SKU: {product.sku}
                              </span>
                            )}
                            {!product.activo && (
                              <span className="mt-0.5 block text-11px text-amber-200/70">
                                Producto inactivo
                              </span>
                            )}
                          </span>
                        </button>
                      )
                    })}
                    {!filteredProducts.length && (
                      <div className="px-3 py-3 text-sm text-white/45">
                        No se encontraron productos.
                      </div>
                    )}
                  </div>
                </>
              )}

              {form.scope === "category" && (
                <>
                  <p className="mb-2 text-11px font-black uppercase tracking-widest text-white/48">
                    Categorías
                  </p>
                  <div className="beyonix-product-picker-scroll h-72 overflow-y-scroll rounded-xl border border-beyonix-blue-light/14 bg-black/18 p-1.5 pr-2">
                    {categories.map((category) => {
                      const item = getCategoryTargetItem(category)
                      const checked = form.targetItems.some((target) => target.url === item.url)

                      return (
                        <button
                          key={category.id}
                          type="button"
                          onClick={() => toggleCategory(category)}
                          className="grid w-full cursor-pointer grid-cols-[18px_minmax(0,1fr)] items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left transition hover:bg-[#1E4D7B]/32"
                        >
                          <span
                            className={`grid size-4 shrink-0 place-items-center rounded border transition ${
                              checked
                                ? "border-beyonix-sky bg-beyonix-sky text-[#06111d] shadow-[0_0_0_2px_rgba(140,200,242,0.12)]"
                                : "border-beyonix-blue-light/36 bg-[#07111d]"
                            }`}
                          >
                            {checked && <Check className="size-3" strokeWidth={3} />}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-xs font-medium text-white/86">
                              {category.nombre}
                            </span>
                          </span>
                        </button>
                      )
                    })}
                  </div>
                </>
              )}

              {form.scope === "store" && (
                <div className="rounded-xl border border-emerald-300/18 bg-emerald-400/10 px-4 py-4 text-sm text-emerald-100/80">
                  El evento se aplicará sobre toda la tienda.
                </div>
              )}
            </div>
          </div>
        </AdminSection>

        <AdminSection eyebrow="Historial" title="Eventos guardados" className="p-3 sm:p-4">
          {events.length ? (
            <div className="custom-scrollbar grid max-h-[520px] gap-2 overflow-y-auto pr-1">
              {events.map((event) => {
                const future = isFutureEvent(event)
                const active = event.status === "active"
                const activationDisabled = (!active && future) || activatingId === event.id

                return (
                  <div
                    key={event.id}
                    className="grid gap-3 rounded-xl border border-beyonix-blue-light/14 bg-black/18 p-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center"
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <CalendarDays className="size-4 text-beyonix-sky" />
                        <p className="truncate text-sm font-medium text-white">
                          {event.internal_name}
                        </p>
                        <span className="rounded-full border border-beyonix-blue-light/18 px-2 py-1 text-10px uppercase tracking-widest text-white/45">
                          {active ? "Activo" : future ? "Programado" : "Guardado"}
                        </span>
                      </div>
                      <p className="mt-1.5 text-xs leading-5 text-white/55">
                        {formatEventDetail(event)} {" · "} {formatEventDate(event.starts_on)}
                        {event.duration_days ? ` · ${event.duration_days} días` : ""}
                        {event.scope !== "store"
                          ? ` · ${event.target_items.length} alcanzados`
                          : " · Toda la tienda"}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5 lg:justify-end">
                      <AdminButton
                        size="sm"
                        icon={<Edit3 className="size-3.5" />}
                        className="h-9 min-h-0 px-3 py-0 text-xs font-medium"
                        onClick={() => editEvent(event)}
                      >
                        Editar
                      </AdminButton>
                      <AdminPrimaryButton
                        size="sm"
                        icon={active ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
                        disabled={activationDisabled}
                        className="h-9 min-h-0 px-3 py-0 text-xs font-medium"
                        onClick={() => void activateEvent(event)}
                      >
                        {activatingId === event.id
                          ? active
                            ? "Pausando"
                            : "Activando"
                          : active
                            ? "Pausar"
                            : future
                              ? "Programado"
                              : "Activar"}
                      </AdminPrimaryButton>
                      <AdminButton
                        size="sm"
                        variant="destructive"
                        icon={<Trash2 className="size-3.5" />}
                        disabled={deletingId === event.id}
                        className="h-9 min-h-0 px-3 py-0 text-xs font-medium"
                        onClick={() => void deleteEvent(event)}
                      >
                        Eliminar
                      </AdminButton>
                    </div>
                  </div>
                )
              })}
            </div>
          ) : (
            <div className="space-y-3 rounded-xl border border-beyonix-blue-light/14 bg-black/18 px-3 py-3">
              <p className="text-sm text-white/45">Todavía no hay eventos guardados.</p>
              <div className="rounded-xl border border-amber-300/16 bg-amber-300/8 px-3 py-3">
                <p className="text-xs leading-5 text-amber-100/72">
                  Si quedó alguna oferta aplicada por un evento eliminado, podés limpiar esos
                  descuentos fantasma.
                </p>
                <AdminButton
                  size="sm"
                  icon={<RotateCcw className="size-3.5" />}
                  disabled={cleaningOrphans}
                  className="mt-3 font-medium"
                  onClick={() => void cleanupOrphanOffers()}
                >
                  {cleaningOrphans ? "Limpiando" : "Limpiar ofertas fantasma"}
                </AdminButton>
              </div>
            </div>
          )}
        </AdminSection>
      </div>
    </div>
  )
}
