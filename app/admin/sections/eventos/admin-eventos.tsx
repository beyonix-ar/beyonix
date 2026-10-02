"use client"

import { useCallback, useEffect, useState } from "react"
import {
  AlertTriangle,
  CalendarClock,
  Check,
  Edit3,
  Pause,
  Play,
  RotateCcw,
  Save,
  Search,
  Square,
  Trash2,
  X,
} from "lucide-react"

import {
  AdminButton,
  AdminFormField,
  AdminInfoBlock,
  AdminModal,
  AdminPageHeader,
  AdminPrimaryButton,
  AdminSecondaryButton,
  AdminSection,
  AdminSelect,
  AdminTextInput,
  adminPageClassName,
} from "@/app/admin/components/admin-controls"
import { AdminDatePicker } from "@/app/admin/components/admin-date-picker"
import { supabase } from "@/lib/supabase/client"
import type { SupabaseCategoria, SupabaseProducto } from "@/lib/supabase/types"
import {
  BULK_PRICE_ACTION_KINDS,
  BULK_PRICE_ACTION_LABELS,
  BULK_PRICE_PERCENT_ACTIONS,
  BULK_PRICE_AMOUNT_ACTIONS,
  type BulkPriceActionKind,
} from "@/lib/pricing/bulk-price-engine"
import {
  FINANCED_PRICE_POLICY_LABELS,
  SAME_AS_CASH_WARNING,
} from "@/lib/pricing/financed-price-policy"
import {
  formatArgentinaDateTime,
  toArgentinaLocalParts,
} from "@/lib/commercial-events/argentina-time"
import {
  COMMERCIAL_EVENT_STATUS_LABELS,
  describeCommercialEvent,
  isLegacyEvent,
  type CommercialEventRow,
  type CommercialEventScope,
  type CommercialEventTarget,
  type CommercialEventType,
} from "@/lib/commercial-events/scheduled-events"

type CategoryOption = Pick<SupabaseCategoria, "id" | "nombre" | "slug">
type ProductOption = Pick<SupabaseProducto, "id" | "nombre" | "slug" | "activo" | "sku">

type EventForm = {
  id: string
  eventType: CommercialEventType
  internalName: string
  startsDate: string
  startsTime: string
  revert: boolean
  endsDate: string
  endsTime: string
  actionKind: BulkPriceActionKind
  value: string
  scope: CommercialEventScope
  targetItems: CommercialEventTarget[]
}

const EMPTY_FORM: EventForm = {
  id: "",
  eventType: "price_change",
  internalName: "",
  startsDate: "",
  startsTime: "03:00",
  revert: false,
  endsDate: "",
  endsTime: "23:59",
  actionKind: "price_increase_percent",
  value: "5",
  scope: "store",
  targetItems: [],
}

const EVENT_TYPE_LABELS: Record<CommercialEventType, string> = {
  price_change: "Cambio de precios",
  financing_policy: "Financiación promocional",
}

const ACTION_HELP: Record<BulkPriceActionKind, string> = {
  discount_percent: "Baja el precio y guarda el anterior para mostrar el % OFF.",
  price_decrease_percent: "Reduce precios en porcentaje y deja visible el precio anterior.",
  price_increase_percent: "Aumenta precios en porcentaje y limpia descuentos previos.",
  clear_offer: "Limpia descuentos y precio anterior.",
  price_decrease_amount: "Resta un monto fijo y deja visible el precio anterior.",
  price_increase_amount: "Suma un monto fijo y limpia descuentos previos.",
}

const STATUS_TONES: Record<CommercialEventRow["status"], string> = {
  draft: "neutral",
  scheduled: "info",
  active: "success",
  finished: "neutral",
  cancelled: "neutral",
  error: "danger",
}

async function getAdminToken() {
  const {
    data: { session },
  } = await supabase.auth.getSession()
  return session?.access_token ?? ""
}

function getTodayInputDate() {
  return toArgentinaLocalParts(new Date()).date
}

function formatLegacyDate(value: string | null) {
  if (!value) return "Sin inicio"
  const [year, month, day] = value.split("-")
  return year && month && day ? `${day}/${month}/${year}` : "Sin inicio"
}

function eventRange(event: CommercialEventRow) {
  if (isLegacyEvent(event)) {
    return `${formatLegacyDate(event.starts_on)}${event.duration_days ? ` · ${event.duration_days} días` : ""}`
  }
  return event.ends_at
    ? `${formatArgentinaDateTime(event.starts_at)} → ${formatArgentinaDateTime(event.ends_at)}`
    : `${formatArgentinaDateTime(event.starts_at)} · Permanente`
}

/** Qué pasa (o pasó) al terminar, en una línea. */
function eventEnding(event: CommercialEventRow) {
  if (isLegacyEvent(event)) return "Evento manual: se pausa a mano."
  if (event.event_type === "financing_policy") {
    const back = event.previous_financing_policy
      ? FINANCED_PRICE_POLICY_LABELS[event.previous_financing_policy]
      : "la política vigente al empezar"
    return event.status === "finished" || (event.status === "cancelled" && event.executed_at)
      ? `Volvió a: ${back}`
      : `Al finalizar: ${back}`
  }
  if (!event.ends_at) return "Cambio permanente: se aplica una vez y queda."
  const kept = Number(event.result?.keptManualChange ?? 0)
  if (event.restored_at) {
    return kept > 0
      ? `Precios restaurados (${kept} con cambio manual posterior se respetaron).`
      : "Precios restaurados a sus valores exactos."
  }
  return "Al finalizar: restaura los precios exactos anteriores."
}

function toForm(event: CommercialEventRow): EventForm {
  const start = event.starts_at ? toArgentinaLocalParts(event.starts_at) : { date: "", time: "03:00" }
  const end = event.ends_at ? toArgentinaLocalParts(event.ends_at) : { date: "", time: "23:59" }
  const actionKind = BULK_PRICE_ACTION_KINDS.find((kind) => kind === event.action_kind) ?? "price_increase_percent"
  return {
    id: event.id,
    eventType: event.event_type,
    internalName: event.internal_name,
    startsDate: start.date,
    startsTime: start.time,
    revert: Boolean(event.ends_at),
    endsDate: end.date,
    endsTime: end.time,
    actionKind,
    value: event.value == null ? "" : String(event.value),
    scope: event.scope,
    targetItems: event.target_items ?? [],
  }
}

type ConfirmAction = { event: CommercialEventRow; kind: "cancel" | "finish" | "delete" }

export function AdminEventos() {
  const [form, setForm] = useState<EventForm>(EMPTY_FORM)
  const [categories, setCategories] = useState<CategoryOption[]>([])
  const [products, setProducts] = useState<ProductOption[]>([])
  const [productSearch, setProductSearch] = useState("")
  const [events, setEvents] = useState<CommercialEventRow[]>([])
  const [saving, setSaving] = useState(false)
  const [busyId, setBusyId] = useState("")
  const [cleaningOrphans, setCleaningOrphans] = useState(false)
  const [confirm, setConfirm] = useState<ConfirmAction | null>(null)
  const [feedback, setFeedback] = useState("")
  const [error, setError] = useState("")

  const isPriceEvent = form.eventType === "price_change"
  const isPercentAction = BULK_PRICE_PERCENT_ACTIONS.includes(form.actionKind)
  const showsEnd = !isPriceEvent || form.revert
  const todayInputDate = getTodayInputDate()
  const normalizedProductSearch = productSearch
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLocaleLowerCase("es")
  const filteredProducts = products.filter((product) =>
    `${product.nombre} ${product.sku ?? ""}`
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
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
      setCategories((categoriesResult.data ?? []) as CategoryOption[])
      setProducts((productsResult.data ?? []) as ProductOption[])
    }
    void loadCatalog()
    return () => {
      active = false
    }
  }, [])

  const request = useCallback(async (method: "GET" | "POST" | "PATCH" | "DELETE", body?: unknown, query = "") => {
    const token = await getAdminToken()
    const response = await fetch(`/api/admin/product-bulk-events${query}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    })
    const data = (await response.json()) as {
      events?: CommercialEventRow[]
      event?: CommercialEventRow
      affectedCount?: number
      restoredCount?: number
      cleanedCount?: number
      error?: string
    }
    return { ok: response.ok, data }
  }, [])

  const loadEvents = useCallback(async () => {
    try {
      const { ok, data } = await request("GET")
      if (!ok) throw new Error(data.error ?? "No se pudieron cargar los eventos.")
      setEvents(data.events ?? [])
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "No se pudieron cargar los eventos.")
    }
  }, [request])

  useEffect(() => {
    void loadEvents()
  }, [loadEvents])

  const upsertEvent = (event: CommercialEventRow) =>
    setEvents((current) => [event, ...current.filter((item) => item.id !== event.id)])

  const setScope = (scope: CommercialEventScope) => setForm((current) => ({ ...current, scope, targetItems: [] }))

  const toggleTarget = (item: CommercialEventTarget) =>
    setForm((current) => ({
      ...current,
      scope: item.type,
      targetItems: current.targetItems.some((target) => target.url === item.url)
        ? current.targetItems.filter((target) => target.url !== item.url)
        : [...current.targetItems, item],
    }))

  const removeTarget = (url: string) =>
    setForm((current) => ({ ...current, targetItems: current.targetItems.filter((target) => target.url !== url) }))

  const saveEvent = async () => {
    setSaving(true)
    setFeedback("")
    setError("")
    try {
      const { ok, data } = await request(form.id ? "PATCH" : "POST", {
        id: form.id || undefined,
        event_type: form.eventType,
        internal_name: form.internalName,
        starts_date: form.startsDate,
        starts_time: form.startsTime,
        revert: isPriceEvent ? form.revert : true,
        ends_date: showsEnd ? form.endsDate : "",
        ends_time: showsEnd ? form.endsTime : "",
        action_kind: form.actionKind,
        value: isPercentAction || BULK_PRICE_AMOUNT_ACTIONS.includes(form.actionKind) ? form.value : null,
        scope: form.scope,
        target_items: form.targetItems,
        financing_policy: "same_as_cash",
      })
      if (!ok || !data.event) throw new Error(data.error ?? "No se pudo guardar el evento.")
      upsertEvent(data.event)
      setFeedback(form.id ? "Evento actualizado." : "Evento programado.")
      setForm(EMPTY_FORM)
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "No se pudo guardar el evento.")
    } finally {
      setSaving(false)
    }
  }

  const runAction = async (event: CommercialEventRow, action: "activate" | "pause" | "cancel" | "retry") => {
    setBusyId(event.id)
    setFeedback("")
    setError("")
    try {
      const { ok, data } = await request("PATCH", { id: event.id, action })
      if (data.event) upsertEvent(data.event)
      if (!ok) throw new Error(data.error ?? "No se pudo completar la acción.")
      setFeedback(
        action === "activate"
          ? `Evento activado sobre ${data.affectedCount ?? 0} productos.`
          : action === "pause"
            ? `Evento pausado. Se restauraron ${data.restoredCount ?? 0} productos.`
            : action === "retry"
              ? "Evento reintentado."
              : event.status === "active"
                ? "Evento finalizado. Se restauró el estado anterior."
                : "Evento cancelado.",
      )
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "No se pudo completar la acción.")
    } finally {
      setBusyId("")
    }
  }

  const deleteEvent = async (event: CommercialEventRow) => {
    setBusyId(event.id)
    setFeedback("")
    setError("")
    try {
      const { ok, data } = await request("DELETE", undefined, `?id=${event.id}`)
      if (!ok) throw new Error(data.error ?? "No se pudo eliminar el evento.")
      setEvents((current) => current.filter((item) => item.id !== event.id))
      if (form.id === event.id) setForm(EMPTY_FORM)
      setFeedback(data.restoredCount ? `Evento eliminado. Se restauraron ${data.restoredCount} productos.` : "Evento eliminado.")
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "No se pudo eliminar el evento.")
    } finally {
      setBusyId("")
    }
  }

  const confirmAction = async () => {
    if (!confirm) return
    const { event, kind } = confirm
    setConfirm(null)
    if (kind === "delete") await deleteEvent(event)
    else await runAction(event, "cancel")
  }

  const cleanupOrphanOffers = async () => {
    setCleaningOrphans(true)
    setFeedback("")
    setError("")
    try {
      const { ok, data } = await request("PATCH", { action: "cleanup_orphan_offers" })
      if (!ok) throw new Error(data.error ?? "No se pudieron limpiar las ofertas fantasma.")
      setFeedback(data.cleanedCount ? `Se limpiaron ${data.cleanedCount} ofertas fantasma.` : "No encontramos ofertas fantasma para limpiar.")
    } catch (cleanupError) {
      setError(cleanupError instanceof Error ? cleanupError.message : "No se pudieron limpiar las ofertas fantasma.")
    } finally {
      setCleaningOrphans(false)
    }
  }

  const dateTimeFields = (prefix: "starts" | "ends", label: string) => (
    <AdminFormField label={label}>
      <div className="flex flex-wrap gap-2">
        <div className="w-[150px]">
          <AdminDatePicker
            title={`${label} (fecha)`}
            ariaLabel={`${label}: fecha`}
            placeholder="Fecha"
            value={prefix === "starts" ? form.startsDate : form.endsDate}
            minDate={prefix === "starts" ? todayInputDate : form.startsDate || todayInputDate}
            onChange={(value) =>
              setForm((current) => (prefix === "starts" ? { ...current, startsDate: value } : { ...current, endsDate: value }))
            }
          />
        </div>
        <div className="w-[110px]">
          <AdminTextInput
            title={`${label} (hora)`}
            ariaLabel={`${label}: hora`}
            type="time"
            placeholder="HH:MM"
            value={prefix === "starts" ? form.startsTime : form.endsTime}
            onChange={(value) =>
              setForm((current) => (prefix === "starts" ? { ...current, startsTime: value } : { ...current, endsTime: value }))
            }
          />
        </div>
      </div>
    </AdminFormField>
  )

  return (
    <div className={adminPageClassName}>
      <AdminPageHeader
        eyebrow="Comercial"
        title="Eventos"
        description="Programá cambios de precios y financiación promocional. Se ejecutan solos a la hora indicada (hora de Argentina). El nombre nunca se muestra al cliente."
      />

      {(feedback || error) && (
        <AdminInfoBlock tone={error ? "danger" : "success"}>
          <span data-events-message>{error || feedback}</span>
        </AdminInfoBlock>
      )}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,0.9fr)_minmax(360px,0.7fr)]">
        <AdminSection eyebrow="Evento" title={form.id ? "Editar evento programado" : "Programar evento"} className="p-3 sm:p-4">
          <div className={isPriceEvent ? "grid gap-4 lg:grid-cols-[minmax(260px,390px)_minmax(320px,1fr)]" : "grid gap-4"}>
            <div className="grid content-start gap-3" data-event-form={form.eventType}>
              <div role="radiogroup" aria-label="Tipo de evento" className="flex flex-wrap gap-2">
                {(Object.keys(EVENT_TYPE_LABELS) as CommercialEventType[]).map((type) => (
                  <AdminButton
                    key={type}
                    size="sm"
                    role="radio"
                    aria-checked={form.eventType === type}
                    variant={form.eventType === type ? "primary" : "secondary"}
                    disabled={Boolean(form.id) && form.eventType !== type}
                    data-event-type-option={type}
                    onClick={() => setForm((current) => ({ ...current, eventType: type }))}
                  >
                    {EVENT_TYPE_LABELS[type]}
                  </AdminButton>
                ))}
              </div>

              <AdminFormField label="Nombre interno">
                <AdminTextInput
                  title="Nombre interno"
                  placeholder={isPriceEvent ? "Aumento lunes" : "Promo financiación fin de semana"}
                  value={form.internalName}
                  onChange={(value) => setForm((current) => ({ ...current, internalName: value }))}
                />
              </AdminFormField>

              {dateTimeFields("starts", "Inicio")}

              {isPriceEvent ? (
                <label className="flex cursor-pointer items-center gap-2 text-sm text-white/80">
                  <input
                    type="checkbox"
                    checked={form.revert}
                    data-event-revert
                    onChange={(event) => setForm((current) => ({ ...current, revert: event.target.checked }))}
                    className="size-4 accent-sky-400"
                  />
                  Revertir automáticamente
                </label>
              ) : null}

              {showsEnd ? dateTimeFields("ends", isPriceEvent ? "Revertir" : "Fin") : (
                <p className="text-xs text-white/62" data-event-permanent>
                  Cambio permanente: se aplica una vez a esa hora y queda.
                </p>
              )}

              {isPriceEvent ? (
                <>
                  <AdminFormField label="Acción" help={ACTION_HELP[form.actionKind]}>
                    <AdminSelect
                      title="Acción"
                      value={form.actionKind}
                      onChange={(value) =>
                        setForm((current) => ({
                          ...current,
                          actionKind: BULK_PRICE_ACTION_KINDS.find((kind) => kind === value) ?? current.actionKind,
                        }))
                      }
                    >
                      {BULK_PRICE_ACTION_KINDS.map((kind) => (
                        <option key={kind} value={kind}>
                          {BULK_PRICE_ACTION_LABELS[kind]}
                        </option>
                      ))}
                    </AdminSelect>
                  </AdminFormField>

                  {form.actionKind !== "clear_offer" && (
                    <AdminFormField label={isPercentAction ? "Porcentaje" : "Monto ($)"} className="max-w-[140px]">
                      <AdminTextInput
                        title={isPercentAction ? "Porcentaje" : "Monto en pesos"}
                        type="number"
                        inputMode="decimal"
                        min="0.01"
                        step={isPercentAction ? "1" : "0.01"}
                        placeholder="5"
                        value={form.value}
                        onChange={(value) => setForm((current) => ({ ...current, value }))}
                      />
                    </AdminFormField>
                  )}

                  <AdminFormField label="Alcance">
                    <AdminSelect title="Alcance" value={form.scope} onChange={(value) => setScope(value as CommercialEventScope)}>
                      <option value="store">Toda la tienda</option>
                      <option value="category">Categorías</option>
                      <option value="product">Selección de productos</option>
                    </AdminSelect>
                  </AdminFormField>

                  {form.scope !== "store" && (
                    <div>
                      <p className="mb-2 text-11px font-black uppercase tracking-widest text-white/48">
                        Selección {form.targetItems.length ? `· ${form.targetItems.length}` : ""}
                      </p>
                      {form.targetItems.length ? (
                        <div className="beyonix-product-picker-scroll flex max-h-[58px] min-h-[44px] flex-wrap items-center gap-1.5 overflow-y-auto rounded-lg border border-beyonix-blue-light/14 bg-black/12 px-2 py-1.5 pr-2.5">
                          {form.targetItems.map((item) => (
                            <span
                              key={item.url}
                              className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-md border border-beyonix-blue-light/20 bg-[#0d2236] px-2 text-11px font-medium text-white/86"
                            >
                              <span className="max-w-28 truncate sm:max-w-36">{item.label}</span>
                              <button
                                type="button"
                                aria-label={`Quitar ${item.label}`}
                                onClick={() => removeTarget(item.url)}
                                className="grid size-4 shrink-0 cursor-pointer place-items-center rounded-full text-white/50 transition hover:text-red-300"
                              >
                                <X className="size-2.5" strokeWidth={2.4} />
                              </button>
                            </span>
                          ))}
                        </div>
                      ) : (
                        <div className="rounded-xl border border-beyonix-blue-light/14 bg-black/18 px-3 py-2 text-sm text-white/55">
                          Agregá al menos un elemento.
                        </div>
                      )}
                    </div>
                  )}
                </>
              ) : (
                <div className="space-y-2" data-financing-event-summary>
                  <p className="text-sm text-white/80">
                    Durante el evento: <strong className="text-white">{FINANCED_PRICE_POLICY_LABELS.same_as_cash}</strong>{" "}
                    (cuotas sin interés al mismo total que contado, siempre sujeto a lo que confirme Mercado Pago).
                  </p>
                  <p className="text-sm text-white/80">Al finalizar: vuelve a la política vigente al empezar.</p>
                  <p className="flex items-start gap-1.5 rounded-lg border border-amber-300/30 bg-amber-300/10 px-3 py-2 text-xs font-semibold text-amber-100" data-same-as-cash-warning>
                    <AlertTriangle className="mt-px size-3.5 shrink-0" />
                    {SAME_AS_CASH_WARNING}
                  </p>
                </div>
              )}

              <div className="flex flex-wrap gap-2 pt-1">
                <AdminPrimaryButton
                  size="sm"
                  icon={<Save className="size-3.5" />}
                  disabled={saving}
                  className="font-medium"
                  data-event-save
                  onClick={() => void saveEvent()}
                >
                  {saving ? "Guardando" : form.id ? "Guardar cambios" : "Programar evento"}
                </AdminPrimaryButton>
                {form.id && (
                  <AdminButton size="sm" className="font-medium" onClick={() => setForm(EMPTY_FORM)}>
                    Nuevo
                  </AdminButton>
                )}
              </div>
            </div>

            {isPriceEvent ? (
              <div className="rounded-2xl border border-beyonix-blue-light/14 bg-black/12 p-3">
                {form.scope === "product" && (
                  <>
                    <p className="mb-2 text-11px font-black uppercase tracking-widest text-white/48">Productos</p>
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
                        const item: CommercialEventTarget = { type: "product", label: product.nombre, url: `/productos/${product.slug}` }
                        const checked = form.targetItems.some((target) => target.url === item.url)
                        return (
                          <button
                            key={product.id}
                            type="button"
                            onClick={() => toggleTarget(item)}
                            className="grid w-full cursor-pointer grid-cols-[18px_minmax(0,1fr)] items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left transition hover:bg-[#1E4D7B]/32"
                          >
                            <span className={`grid size-4 shrink-0 place-items-center rounded border transition ${checked ? "border-beyonix-sky bg-beyonix-sky text-[#06111d]" : "border-beyonix-blue-light/36 bg-[#07111d]"}`}>
                              {checked && <Check className="size-3" strokeWidth={3} />}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-xs font-medium text-white/86">{product.nombre}</span>
                              {product.sku && <span className="block truncate text-10px text-white/50">SKU: {product.sku}</span>}
                              {!product.activo && <span className="mt-0.5 block text-11px text-amber-200/80">Producto inactivo</span>}
                            </span>
                          </button>
                        )
                      })}
                      {!filteredProducts.length && <div className="px-3 py-3 text-sm text-white/55">No se encontraron productos.</div>}
                    </div>
                  </>
                )}

                {form.scope === "category" && (
                  <>
                    <p className="mb-2 text-11px font-black uppercase tracking-widest text-white/48">Categorías</p>
                    <div className="beyonix-product-picker-scroll h-72 overflow-y-scroll rounded-xl border border-beyonix-blue-light/14 bg-black/18 p-1.5 pr-2">
                      {categories.map((category) => {
                        const item: CommercialEventTarget = { type: "category", label: category.nombre, url: `/categorias/${category.slug}` }
                        const checked = form.targetItems.some((target) => target.url === item.url)
                        return (
                          <button
                            key={category.id}
                            type="button"
                            onClick={() => toggleTarget(item)}
                            className="grid w-full cursor-pointer grid-cols-[18px_minmax(0,1fr)] items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left transition hover:bg-[#1E4D7B]/32"
                          >
                            <span className={`grid size-4 shrink-0 place-items-center rounded border transition ${checked ? "border-beyonix-sky bg-beyonix-sky text-[#06111d]" : "border-beyonix-blue-light/36 bg-[#07111d]"}`}>
                              {checked && <Check className="size-3" strokeWidth={3} />}
                            </span>
                            <span className="block truncate text-xs font-medium text-white/86">{category.nombre}</span>
                          </button>
                        )
                      })}
                    </div>
                  </>
                )}

                {form.scope === "store" && (
                  <div className="rounded-xl border border-emerald-300/18 bg-emerald-400/10 px-4 py-4 text-sm text-emerald-100/80">
                    El cambio se aplicará sobre toda la tienda, con el mismo cálculo que el Editor masivo.
                  </div>
                )}
              </div>
            ) : null}
          </div>
        </AdminSection>

        <AdminSection eyebrow="Agenda" title="Eventos" className="p-3 sm:p-4">
          {events.length ? (
            <div className="custom-scrollbar grid max-h-[620px] gap-2 overflow-y-auto pr-1" data-events-list>
              {events.map((event) => {
                const legacy = isLegacyEvent(event)
                const busy = busyId === event.id
                return (
                  <div
                    key={event.id}
                    data-event-card={event.id}
                    data-event-status={event.status}
                    className="grid gap-2 rounded-xl border border-beyonix-blue-light/14 bg-black/18 p-3"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <CalendarClock className="size-4 shrink-0 text-beyonix-sky" />
                      <p className="min-w-0 flex-1 truncate text-sm font-bold text-white">{event.internal_name}</p>
                      <span
                        className="rounded-full border border-beyonix-blue-light/24 px-2 py-0.5 text-11px font-bold text-white/80"
                        data-event-status-label
                        data-tone={STATUS_TONES[event.status]}
                      >
                        {legacy && event.status === "draft" ? "Manual" : COMMERCIAL_EVENT_STATUS_LABELS[event.status]}
                      </span>
                    </div>
                    <p className="text-xs leading-5 text-white/72">
                      <span className="font-semibold text-white/88">{legacy ? "Evento manual" : EVENT_TYPE_LABELS[event.event_type]}</span>
                      {" · "}
                      {describeCommercialEvent(event)}
                      {event.event_type === "price_change"
                        ? event.scope === "store"
                          ? " · Toda la tienda"
                          : ` · ${event.target_items.length} seleccionados`
                        : ""}
                    </p>
                    <p className="text-xs font-semibold text-white/85" data-event-range>{eventRange(event)}</p>
                    <p className="text-xs text-white/72" data-event-ending>{eventEnding(event)}</p>
                    {event.status === "error" && event.last_error ? (
                      <p className="flex items-start gap-1.5 text-xs font-semibold text-red-200" data-event-error>
                        <AlertTriangle className="mt-px size-3.5 shrink-0" />
                        {event.last_error}
                      </p>
                    ) : null}

                    <div className="flex flex-wrap items-center gap-1.5">
                      {legacy ? (
                        <>
                          <AdminPrimaryButton
                            size="sm"
                            icon={event.status === "active" ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
                            disabled={busy}
                            className="h-8 min-h-0 px-3 py-0 text-xs font-medium"
                            onClick={() => void runAction(event, event.status === "active" ? "pause" : "activate")}
                          >
                            {event.status === "active" ? "Pausar" : "Activar"}
                          </AdminPrimaryButton>
                          <AdminButton size="sm" variant="destructive" icon={<Trash2 className="size-3.5" />} disabled={busy} className="h-8 min-h-0 px-3 py-0 text-xs font-medium" onClick={() => setConfirm({ event, kind: "delete" })}>
                            Eliminar
                          </AdminButton>
                        </>
                      ) : null}
                      {!legacy && event.status === "scheduled" ? (
                        <>
                          <AdminSecondaryButton size="sm" icon={<Edit3 className="size-3.5" />} disabled={busy} className="h-8 min-h-0 px-3 py-0 text-xs font-medium" onClick={() => setForm(toForm(event))}>
                            Editar
                          </AdminSecondaryButton>
                          <AdminSecondaryButton size="sm" icon={<X className="size-3.5" />} disabled={busy} className="h-8 min-h-0 px-3 py-0 text-xs font-medium" data-event-cancel onClick={() => setConfirm({ event, kind: "cancel" })}>
                            Cancelar
                          </AdminSecondaryButton>
                        </>
                      ) : null}
                      {!legacy && event.status === "active" && event.ends_at ? (
                        <AdminSecondaryButton size="sm" icon={<Square className="size-3.5" />} disabled={busy} className="h-8 min-h-0 px-3 py-0 text-xs font-medium" data-event-finish onClick={() => setConfirm({ event, kind: "finish" })}>
                          Finalizar ahora
                        </AdminSecondaryButton>
                      ) : null}
                      {!legacy && event.status === "error" ? (
                        <>
                          <AdminPrimaryButton size="sm" icon={<RotateCcw className="size-3.5" />} disabled={busy} className="h-8 min-h-0 px-3 py-0 text-xs font-medium" data-event-retry onClick={() => void runAction(event, "retry")}>
                            Reintentar
                          </AdminPrimaryButton>
                          {event.failed_phase === "apply" ? (
                            <AdminSecondaryButton size="sm" icon={<X className="size-3.5" />} disabled={busy} className="h-8 min-h-0 px-3 py-0 text-xs font-medium" onClick={() => setConfirm({ event, kind: "cancel" })}>
                              Cancelar
                            </AdminSecondaryButton>
                          ) : null}
                        </>
                      ) : null}
                      {!legacy && !event.executed_at && (event.status === "scheduled" || event.status === "cancelled" || event.status === "error") ? (
                        <AdminButton size="sm" variant="destructive" icon={<Trash2 className="size-3.5" />} disabled={busy} className="h-8 min-h-0 px-3 py-0 text-xs font-medium" onClick={() => setConfirm({ event, kind: "delete" })}>
                          Eliminar
                        </AdminButton>
                      ) : null}
                    </div>
                  </div>
                )
              })}
            </div>
          ) : (
            <div className="space-y-3 rounded-xl border border-beyonix-blue-light/14 bg-black/18 px-3 py-3">
              <p className="text-sm text-white/60">Todavía no hay eventos.</p>
              <div className="rounded-xl border border-amber-300/16 bg-amber-300/8 px-3 py-3">
                <p className="text-xs leading-5 text-amber-100/80">
                  Si quedó alguna oferta aplicada por un evento eliminado, podés limpiar esos descuentos fantasma.
                </p>
                <AdminButton size="sm" icon={<RotateCcw className="size-3.5" />} disabled={cleaningOrphans} className="mt-3 font-medium" onClick={() => void cleanupOrphanOffers()}>
                  {cleaningOrphans ? "Limpiando" : "Limpiar ofertas fantasma"}
                </AdminButton>
              </div>
            </div>
          )}
        </AdminSection>
      </div>

      <AdminModal
        open={confirm !== null}
        title={
          confirm?.kind === "finish" ? "Finalizar evento ahora" : confirm?.kind === "delete" ? "Eliminar evento" : "Cancelar evento"
        }
        onClose={() => setConfirm(null)}
        footer={
          <div className="flex gap-2">
            <AdminSecondaryButton onClick={() => setConfirm(null)}>Volver</AdminSecondaryButton>
            <AdminPrimaryButton data-event-confirm onClick={() => void confirmAction()}>
              Confirmar
            </AdminPrimaryButton>
          </div>
        }
      >
        <p>
          {confirm?.kind === "finish"
            ? confirm.event.event_type === "financing_policy"
              ? "Termina la promoción ya y vuelve a la política anterior."
              : "Termina el evento ya y restaura los precios exactos anteriores."
            : confirm?.kind === "delete"
              ? isLegacyEvent(confirm.event)
                ? "El evento se elimina y, si estaba activo, sus productos vuelven a los precios anteriores."
                : "El evento se elimina. No cambia ningún precio ni la financiación."
              : "El evento no se va a ejecutar. No cambia nada."}
        </p>
      </AdminModal>
    </div>
  )
}
