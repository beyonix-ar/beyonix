"use client"

import { useEffect, useState } from "react"
import {
  BadgePercent,
  CheckCircle2,
  Edit3,
  Package,
  Play,
  Plus,
  RotateCcw,
  Save,
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

type BulkScope = "store" | "category" | "product"
type BulkActionKind =
  | "discount_percent"
  | "price_decrease_percent"
  | "price_increase_percent"
  | "installments"
  | "clear_offer"

type TargetItem = {
  type: "category" | "product"
  label: string
  url: string
}

type CategoryOption = Pick<SupabaseCategoria, "id" | "nombre" | "slug">
type ProductOption = Pick<SupabaseProducto, "id" | "nombre" | "slug" | "activo">

type BulkEventForm = {
  id: string
  internalName: string
  startsOn: string
  durationDays: string
}

const EMPTY_EVENT_FORM: BulkEventForm = {
  id: "",
  internalName: "",
  startsOn: "",
  durationDays: "7",
}

const ACTION_OPTIONS: Array<{
  value: BulkActionKind
  label: string
  help: string
}> = [
  {
    value: "discount_percent",
    label: "Descuento especial",
    help: "Baja el precio y guarda el precio anterior para mostrar el % OFF.",
  },
  {
    value: "price_decrease_percent",
    label: "Baja de precio",
    help: "Reduce precios en porcentaje y deja visible el precio anterior.",
  },
  {
    value: "price_increase_percent",
    label: "Aumento de precio",
    help: "Aumenta precios en porcentaje y limpia descuentos previos.",
  },
  {
    value: "installments",
    label: "Cuotas sin interés",
    help: "Activa 3 o 6 cuotas sin interés en los productos alcanzados.",
  },
  {
    value: "clear_offer",
    label: "Quitar oferta",
    help: "Limpia descuentos, precio anterior y cuotas especiales.",
  },
]

const PERCENT_ACTIONS: BulkActionKind[] = [
  "discount_percent",
  "price_decrease_percent",
  "price_increase_percent",
]

async function getAdminToken() {
  const {
    data: { session },
  } = await supabase.auth.getSession()

  return session?.access_token ?? ""
}

export function AdminAccionesMasivas() {
  const [scope, setScope] = useState<BulkScope>("product")
  const [actionKind, setActionKind] = useState<BulkActionKind>("discount_percent")
  const [value, setValue] = useState("10")
  const [installments, setInstallments] = useState("3")
  const [categories, setCategories] = useState<CategoryOption[]>([])
  const [products, setProducts] = useState<ProductOption[]>([])
  const [events, setEvents] = useState<SupabaseProductBulkEvent[]>([])
  const [categoryToAdd, setCategoryToAdd] = useState("")
  const [targetItems, setTargetItems] = useState<TargetItem[]>([])
  const [eventForm, setEventForm] = useState<BulkEventForm>(EMPTY_EVENT_FORM)
  const [saving, setSaving] = useState(false)
  const [savingEvent, setSavingEvent] = useState(false)
  const [activatingEventId, setActivatingEventId] = useState("")
  const [deletingEventId, setDeletingEventId] = useState("")
  const [feedback, setFeedback] = useState("")
  const [error, setError] = useState("")

  const selectedAction = ACTION_OPTIONS.find((item) => item.value === actionKind)
  const isPercentAction = PERCENT_ACTIONS.includes(actionKind)

  useEffect(() => {
    let active = true

    async function loadCatalog() {
      const [categoriesResult, productsResult] = await Promise.all([
        supabase.from("categorias").select("id, nombre, slug").order("nombre"),
        supabase.from("productos").select("id, nombre, slug, activo").order("nombre"),
      ])

      if (!active) return

      const nextCategories = (categoriesResult.data ?? []) as CategoryOption[]
      const nextProducts = (productsResult.data ?? []) as ProductOption[]

      setCategories(nextCategories)
      setProducts(nextProducts)
      setCategoryToAdd(String(nextCategories[0]?.id ?? ""))
    }

    void loadCatalog()

    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    async function loadEvents() {
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
          loadError instanceof Error
            ? loadError.message
            : "No se pudieron cargar los eventos.",
        )
      }
    }

    void loadEvents()
  }, [])

  const setNextScope = (value: string) => {
    const nextScope = value as BulkScope
    setScope(nextScope)
    setTargetItems([])
  }

  const addCategory = () => {
    const category = categories.find((item) => String(item.id) === categoryToAdd)
    if (!category) return

    const item: TargetItem = {
      type: "category",
      label: category.nombre,
      url: `/categorias/${category.slug}`,
    }

    setTargetItems((current) =>
      current.some((target) => target.url === item.url) ? current : [...current, item],
    )
  }

  const getProductTargetItem = (product: ProductOption): TargetItem => ({
    type: "product",
    label: product.nombre,
    url: `/productos/${product.slug}`,
  })

  const toggleProduct = (product: ProductOption) => {
    const item = getProductTargetItem(product)

    setTargetItems((current) =>
      current.some((target) => target.url === item.url)
        ? current.filter((target) => target.url !== item.url)
        : [...current, item],
    )
  }

  const resetEventForm = () => {
    setEventForm(EMPTY_EVENT_FORM)
  }

  const applyBulkAction = async () => {
    setSaving(true)
    setFeedback("")
    setError("")

    try {
      const token = await getAdminToken()
      const response = await fetch("/api/admin/product-bulk-actions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          scope,
          target_items: targetItems,
          action_kind: actionKind,
          value: Number(value),
          installments: Number(installments),
        }),
      })
      const data = (await response.json()) as {
        affectedCount?: number
        error?: string
      }

      if (!response.ok) {
        throw new Error(data.error ?? "No se pudo aplicar la acción masiva.")
      }

      setFeedback(`Acción aplicada sobre ${data.affectedCount ?? 0} productos.`)
    } catch (applyError) {
      setError(
        applyError instanceof Error
          ? applyError.message
          : "No se pudo aplicar la acción masiva.",
      )
    } finally {
      setSaving(false)
    }
  }

  const saveEvent = async () => {
    setSavingEvent(true)
    setFeedback("")
    setError("")

    try {
      const token = await getAdminToken()
      const response = await fetch("/api/admin/product-bulk-events", {
        method: eventForm.id ? "PATCH" : "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          id: eventForm.id || undefined,
          internal_name: eventForm.internalName,
          starts_on: eventForm.startsOn,
          duration_days: eventForm.durationDays ? Number(eventForm.durationDays) : null,
          scope,
          target_items: targetItems,
          action_kind: actionKind,
          value: value ? Number(value) : null,
          installments: Number(installments),
        }),
      })
      const data = (await response.json()) as {
        event?: SupabaseProductBulkEvent
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
      setFeedback(eventForm.id ? "Evento actualizado." : "Evento guardado.")
      setEventForm({
        id: data.event.id,
        internalName: data.event.internal_name,
        startsOn: data.event.starts_on ?? "",
        durationDays: String(data.event.duration_days ?? ""),
      })
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "No se pudo guardar el evento.")
    } finally {
      setSavingEvent(false)
    }
  }

  const editEvent = (event: SupabaseProductBulkEvent) => {
    setEventForm({
      id: event.id,
      internalName: event.internal_name,
      startsOn: event.starts_on ?? "",
      durationDays: String(event.duration_days ?? ""),
    })
    setScope(event.scope)
    setTargetItems(event.target_items ?? [])
    setActionKind(event.action_kind)
    setValue(String(event.value ?? ""))
    setInstallments(String(event.installments ?? "3"))
  }

  const activateEvent = async (event: SupabaseProductBulkEvent) => {
    setActivatingEventId(event.id)
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
        body: JSON.stringify({ id: event.id, action: "activate" }),
      })
      const data = (await response.json()) as {
        event?: SupabaseProductBulkEvent
        affectedCount?: number
        error?: string
      }

      if (!response.ok || !data.event) {
        throw new Error(data.error ?? "No se pudo activar el evento.")
      }

      setEvents((current) =>
        current.map((item) => (item.id === data.event?.id ? data.event : item)),
      )
      setFeedback(`Evento activado sobre ${data.affectedCount ?? 0} productos.`)
    } catch (activateError) {
      setError(
        activateError instanceof Error
          ? activateError.message
          : "No se pudo activar el evento.",
      )
    } finally {
      setActivatingEventId("")
    }
  }

  const deleteEvent = async (event: SupabaseProductBulkEvent) => {
    setDeletingEventId(event.id)
    setFeedback("")
    setError("")

    try {
      const token = await getAdminToken()
      const response = await fetch(`/api/admin/product-bulk-events?id=${event.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = (await response.json()) as { error?: string }

      if (!response.ok) {
        throw new Error(data.error ?? "No se pudo eliminar el evento.")
      }

      setEvents((current) => current.filter((item) => item.id !== event.id))
      if (eventForm.id === event.id) resetEventForm()
      setFeedback("Evento eliminado.")
    } catch (deleteError) {
      setError(
        deleteError instanceof Error ? deleteError.message : "No se pudo eliminar el evento.",
      )
    } finally {
      setDeletingEventId("")
    }
  }

  const getActionLabel = (kind: BulkActionKind) =>
    ACTION_OPTIONS.find((option) => option.value === kind)?.label ?? "Promoción"

  const formatEventDetail = (event: SupabaseProductBulkEvent) => {
    if (PERCENT_ACTIONS.includes(event.action_kind)) {
      return `${getActionLabel(event.action_kind)} ${event.value ?? 0}%`
    }

    if (event.action_kind === "installments") {
      return `${event.installments ?? 3} cuotas sin interés`
    }

    return getActionLabel(event.action_kind)
  }

  const formatEventDate = (value: string | null) => {
    if (!value) return "Sin inicio"

    const [year, month, day] = value.split("-")
    if (!year || !month || !day) return "Sin inicio"

    return `${day}/${month}/${year}`
  }

  return (
    <div className={adminPageClassName}>
      <AdminPageHeader
        eyebrow="Comercial"
        title="Acciones masivas"
        description="Aplicá descuentos, aumentos, bajas de precio o cuotas sin interés a muchos productos sin editarlos uno por uno."
      />

      {(feedback || error) && (
        <AdminInfoBlock tone={error ? "danger" : "success"}>
          {error || feedback}
        </AdminInfoBlock>
      )}

      <AdminSection
        eyebrow="Regla"
        title="Acción masiva"
        className="p-3 sm:p-4"
      >
        <div className="grid gap-4 xl:grid-cols-[minmax(280px,420px)_minmax(320px,1fr)]">
          <div className="grid content-start gap-3">
            <AdminFormField label="Alcance">
              <AdminSelect title="Alcance" value={scope} onChange={setNextScope}>
                <option value="product">Productos seleccionados</option>
                <option value="category">Categorías seleccionadas</option>
                <option value="store">Toda la tienda</option>
              </AdminSelect>
            </AdminFormField>

            <AdminFormField label="Acción comercial" help={selectedAction?.help}>
              <AdminSelect
                title="Acción comercial"
                value={actionKind}
                onChange={(nextValue) => setActionKind(nextValue as BulkActionKind)}
              >
                {ACTION_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </AdminSelect>
            </AdminFormField>

            {isPercentAction && (
              <AdminFormField label="Porcentaje" className="max-w-[220px]">
                <AdminTextInput
                  title="Porcentaje"
                  type="number"
                  inputMode="numeric"
                  placeholder="10"
                  value={value}
                  onChange={setValue}
                />
              </AdminFormField>
            )}

            {actionKind === "installments" && (
              <AdminFormField label="Cuotas">
                <AdminSelect title="Cuotas" value={installments} onChange={setInstallments}>
                  <option value="3">3 cuotas sin interés</option>
                  <option value="6">6 cuotas sin interés</option>
                </AdminSelect>
              </AdminFormField>
            )}

            {scope !== "store" && (
              <div>
                <p className="mb-2 text-11px font-black uppercase tracking-widest text-white/48">
                  Selección
                </p>
                {targetItems.length ? (
                  <div className="flex min-h-10 flex-wrap gap-2 rounded-xl border border-beyonix-blue-light/14 bg-black/18 p-2">
                    {targetItems.map((item) => (
                      <span
                        key={item.url}
                        className="inline-flex max-w-full items-center gap-2 rounded-full border border-beyonix-blue-light/24 bg-beyonix-blue/18 px-2.5 py-1 text-xs font-medium text-white/82"
                      >
                        <span className="truncate">{item.label}</span>
                        <button
                          type="button"
                          aria-label={`Quitar ${item.label}`}
                          onClick={() =>
                            setTargetItems((current) =>
                              current.filter((target) => target.url !== item.url),
                            )
                          }
                          className="flex size-5 cursor-pointer items-center justify-center rounded-full text-white/50 transition hover:bg-white/10 hover:text-white"
                        >
                          <X className="size-3" />
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
                icon={
                  actionKind === "price_increase_percent" ? (
                    <TrendingUp className="size-3.5" />
                  ) : actionKind === "price_decrease_percent" ? (
                    <TrendingDown className="size-3.5" />
                  ) : actionKind === "installments" ? (
                    <CheckCircle2 className="size-3.5" />
                  ) : actionKind === "clear_offer" ? (
                    <RotateCcw className="size-3.5" />
                  ) : (
                    <BadgePercent className="size-3.5" />
                  )
                }
                disabled={saving}
                className="font-medium"
                onClick={() => void applyBulkAction()}
              >
                {saving ? "Aplicando" : "Aplicar acción"}
              </AdminPrimaryButton>
              <AdminButton
                size="sm"
                icon={<Package className="size-3.5" />}
                className="font-medium"
                onClick={() => setTargetItems([])}
              >
                Limpiar selección
              </AdminButton>
            </div>
          </div>

          <div className="rounded-2xl border border-beyonix-blue-light/14 bg-black/12 p-3">
            {scope === "product" && (
              <>
              <p className="mb-2 text-11px font-black uppercase tracking-widest text-white/48">
                Productos
              </p>
              <div className="custom-scrollbar max-h-52 overflow-y-auto rounded-xl border border-beyonix-blue-light/14 bg-black/18 p-1.5">
                {products.length === 0 ? (
                  <div className="px-3 py-3 text-sm text-white/45">
                    No hay productos disponibles para seleccionar.
                  </div>
                ) : (
                  products.map((product) => {
                    const item = getProductTargetItem(product)
                    const checked = targetItems.some((target) => target.url === item.url)

                    return (
                      <button
                        key={product.id}
                        type="button"
                        onClick={() => toggleProduct(product)}
                        className="grid w-full cursor-pointer grid-cols-[18px_minmax(0,1fr)] items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left transition hover:bg-beyonix-blue/18"
                      >
                        <span
                          className={`grid size-4 shrink-0 place-items-center rounded-md border ${
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
              </>
            )}

            {scope === "category" && (
              <>
                <p className="mb-2 text-11px font-black uppercase tracking-widest text-white/48">
                  Categorías
                </p>
                <div className="flex gap-2">
                  <AdminSelect title="Categoría" value={categoryToAdd} onChange={setCategoryToAdd}>
                    {categories.map((category) => (
                      <option key={category.id} value={String(category.id)}>
                        {category.nombre}
                      </option>
                    ))}
                  </AdminSelect>
                  <AdminButton
                    size="icon"
                    aria-label="Agregar categoría"
                    className="font-medium"
                    onClick={addCategory}
                  >
                    <Plus className="size-4" />
                  </AdminButton>
                </div>
              </>
            )}

            {scope === "store" && (
              <div className="rounded-xl border border-emerald-300/18 bg-emerald-400/10 px-4 py-4 text-sm text-emerald-100/80">
                La acción se aplicará sobre toda la tienda.
              </div>
            )}
          </div>
        </div>
      </AdminSection>

      <AdminSection
        eyebrow="Evento"
        title={eventForm.id ? "Editar evento guardado" : "Guardar como evento"}
        className="p-3 sm:p-4"
      >
        <div className="grid gap-3 xl:grid-cols-[minmax(0,0.9fr)_minmax(360px,1.1fr)]">
          <div className="rounded-xl border border-beyonix-blue-light/14 bg-black/18 p-3">
            <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_150px_105px]">
              <AdminFormField label="Nombre interno">
                <AdminTextInput
                  title="Nombre interno del evento"
                  placeholder="Hot Sale mayo"
                  value={eventForm.internalName}
                  onChange={(nextValue) =>
                    setEventForm((current) => ({ ...current, internalName: nextValue }))
                  }
                />
              </AdminFormField>

              <AdminFormField label="Inicio">
                <AdminDatePicker
                  title="Inicio del evento"
                  ariaLabel="Inicio del evento"
                  placeholder="Inicio"
                  value={eventForm.startsOn}
                  onChange={(nextValue) =>
                    setEventForm((current) => ({ ...current, startsOn: nextValue }))
                  }
                />
              </AdminFormField>

              <AdminFormField label="Duración">
                <AdminTextInput
                  title="Duración del evento"
                  type="number"
                  inputMode="numeric"
                  placeholder="7"
                  value={eventForm.durationDays}
                  onChange={(nextValue) =>
                    setEventForm((current) => ({ ...current, durationDays: nextValue }))
                  }
                />
              </AdminFormField>
            </div>

            <div className="mt-2 flex flex-wrap gap-2">
              <span className="rounded-full border border-beyonix-sky/25 bg-beyonix-blue/22 px-3 py-1 text-xs font-medium text-beyonix-sky">
                {selectedAction?.label ?? "Acción"}
                {isPercentAction && value ? ` ${value}%` : ""}
                {actionKind === "installments" ? ` ${installments} cuotas` : ""}
              </span>
              <span className="rounded-full border border-emerald-300/18 bg-emerald-400/10 px-3 py-1 text-xs font-medium text-emerald-200">
                {scope === "store"
                  ? "Toda la tienda"
                  : `${targetItems.length} ${
                      scope === "category" ? "categorías" : "productos"
                    }`}
              </span>
            </div>

            <div className="mt-3 flex flex-wrap gap-2">
              <AdminPrimaryButton
                size="sm"
                icon={<Save className="size-4" />}
                disabled={savingEvent}
                className="font-medium"
                onClick={() => void saveEvent()}
              >
                {savingEvent ? "Guardando" : eventForm.id ? "Guardar cambios" : "Guardar evento"}
              </AdminPrimaryButton>
              {eventForm.id && (
                <AdminButton size="sm" className="font-medium" onClick={resetEventForm}>
                  Nuevo
                </AdminButton>
              )}
            </div>
          </div>

          <div>
            <p className="mb-2 text-11px font-black uppercase tracking-widest text-white/48">
              Eventos guardados
            </p>
            {events.length ? (
              <div className="custom-scrollbar grid max-h-56 gap-2 overflow-y-auto pr-1">
                {events.map((event) => (
                  <div
                    key={event.id}
                    className="grid gap-2 rounded-xl border border-beyonix-blue-light/14 bg-black/18 p-2.5 lg:grid-cols-[minmax(0,1fr)_auto]"
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate text-sm font-medium text-white">
                          {event.internal_name}
                        </p>
                        <span className="rounded-full border border-beyonix-blue-light/18 px-2 py-1 text-10px uppercase tracking-widest text-white/45">
                          {event.status === "active" ? "Activo" : "Guardado"}
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
                    <div className="flex flex-wrap gap-1.5">
                      <AdminButton
                        size="sm"
                        icon={<Edit3 className="size-3.5" />}
                        className="font-medium"
                        onClick={() => editEvent(event)}
                      >
                        Editar
                      </AdminButton>
                      <AdminPrimaryButton
                        size="sm"
                        icon={<Play className="size-3.5" />}
                        disabled={activatingEventId === event.id}
                        className="font-medium"
                        onClick={() => void activateEvent(event)}
                      >
                        {activatingEventId === event.id ? "Activando" : "Activar"}
                      </AdminPrimaryButton>
                      <AdminButton
                        size="sm"
                        variant="destructive"
                        icon={<Trash2 className="size-3.5" />}
                        disabled={deletingEventId === event.id}
                        className="font-medium"
                        onClick={() => void deleteEvent(event)}
                      >
                        Eliminar
                      </AdminButton>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-xl border border-beyonix-blue-light/14 bg-black/18 px-3 py-3 text-sm text-white/45">
                Todavía no hay eventos guardados.
              </div>
            )}
          </div>
        </div>
      </AdminSection>
    </div>
  )
}
