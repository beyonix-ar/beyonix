"use client"

import { useEffect, useRef, useState, type ChangeEvent } from "react"
import { ImageIcon, Pencil, RotateCcw, Save, Smartphone, Trash2, Upload, X } from "lucide-react"

import { supabase } from "@/lib/supabase/client"
import { AdminDatePicker } from "@/app/admin/components/admin-date-picker"
import { formatArgentinaDateTime } from "@/lib/commercial-events/argentina-time"
import {
  BANNER_STATUS_LABELS,
  bannerInclusiveEndParts,
  bannerInclusiveEndToUtc,
  bannerStartParts,
  bannerStartToUtc,
  CAMPAIGN_NAME_MAX,
  DEFAULT_ALT_TEXT,
  getBannerStatus,
  parseBannerSortOrder,
  HOME_BANNER_DESKTOP,
  HOME_BANNER_HELP,
  HOME_BANNER_MOBILE,
  pickVisibleBanner,
  validateBannerDestination,
  type BannerStatus,
} from "@/lib/banners/site-banners"
import {
  AdminBadge,
  AdminCard,
  AdminDangerButton,
  AdminEmptyState,
  AdminFormField,
  AdminGhostButton,
  AdminInfoBlock,
  AdminPrimaryButton,
  AdminSecondaryButton,
  AdminTextInput,
} from "../../components/admin-controls"
import { BANNER_FILE_ACCEPT, uploadBannerImage } from "./banner-upload"

export interface HomeCampaign {
  id: string
  placement: "home"
  campaign_name: string | null
  image_url: string
  mobile_image_url: string | null
  alt_text: string | null
  active: boolean
  sort_order: number
  starts_at: string | null
  ends_at: string | null
  destination_url: string | null
  created_at: string | null
  updated_at: string | null
}

interface FormState {
  campaignName: string
  imageUrl: string
  mobileImageUrl: string
  altText: string
  startsDate: string
  startsTime: string
  endsDate: string
  endsTime: string
  active: boolean
  sortOrder: string
  destinationUrl: string
}

const EMPTY_FORM: FormState = {
  campaignName: "",
  imageUrl: "",
  mobileImageUrl: "",
  altText: "",
  startsDate: "",
  startsTime: "",
  endsDate: "",
  endsTime: "",
  active: true,
  sortOrder: "0",
  destinationUrl: "",
}

const STATUS_TONE: Record<BannerStatus, "success" | "info" | "neutral" | "warning"> = {
  active: "success",
  scheduled: "info",
  ended: "neutral",
  disabled: "warning",
}

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/

/** "0930" → "09:30" mientras se escribe (siempre 24 horas). */
function formatTimeInput(value: string) {
  const digits = value.replace(/\D/g, "").slice(0, 4)
  return digits.length > 2 ? `${digits.slice(0, 2)}:${digits.slice(2)}` : digits
}

/** Aviso (no bloquea): la proporción no es la recomendada y la imagen se va a recortar. */
function ratioWarning(label: string, width: number | null, height: number | null, target: { width: number; height: number }) {
  if (!width || !height) return ""
  const ratio = width / height
  const expected = target.width / target.height
  return Math.abs(ratio - expected) / expected > 0.04
    ? `${label}: la imagen mide ${width} × ${height} px; se recomienda ${target.width} × ${target.height} px. Puede recortarse en los bordes.`
    : ""
}

function scheduleText(campaign: HomeCampaign) {
  const start = campaign.starts_at ? `Desde ${formatArgentinaDateTime(campaign.starts_at)}` : "Desde ya"
  if (!campaign.ends_at) return campaign.starts_at ? `${start} · sin fecha de fin` : "Permanente"
  const end = new Date(Date.parse(campaign.ends_at) - 60_000).toISOString()
  return `${start} · hasta ${formatArgentinaDateTime(end)} inclusive`
}

/** Error de la API con su estado HTTP (409 = otro administrador cambió el banner). */
class BannerRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

async function authorizedFetch(input: string, init: RequestInit = {}) {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session?.access_token) throw new Error("No se pudo validar la sesión.")
  const response = await fetch(input, {
    ...init,
    headers: { Authorization: `Bearer ${session.access_token}`, ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers },
  })
  const data = (await response.json().catch(() => ({}))) as { error?: string } & Record<string, unknown>
  if (!response.ok) throw new BannerRequestError(data.error ?? "No se pudo completar la operación.", response.status)
  return data
}

function ImagePreview({ src, alt, aspect, label, empty }: { src: string; alt: string; aspect: string; label: string; empty: string }) {
  return (
    <div className={`relative w-full overflow-hidden rounded-xl border border-beyonix-blue-light/20 bg-[#03070D] ${aspect}`}>
      <span className="absolute left-2 top-2 z-10 rounded-full border border-beyonix-blue-light/16 bg-black/70 px-2 py-0.5 text-10px font-black uppercase tracking-wider text-white/70">
        {label}
      </span>
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element -- vista previa de Admin antes de guardar (URL todavía no validada por el servidor)
        <img src={src} alt={alt} className="absolute inset-0 size-full object-cover object-center" />
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1">
          <ImageIcon className="size-5 text-beyonix-sky/45" />
          <p className="text-12px font-bold text-white/58">{empty}</p>
        </div>
      )}
    </div>
  )
}

/**
 * Campañas del HOME (Configuración → Visuales → Banners → Home). Una sola se
 * muestra a la vez: la vigente con menor orden (desempate estable). El estado
 * se calcula con la hora del servidor; la API vuelve a validar todo.
 */
export function AdminHomeCampaigns() {
  const desktopInputRef = useRef<HTMLInputElement>(null)
  const mobileInputRef = useRef<HTMLInputElement>(null)
  const [campaigns, setCampaigns] = useState<HomeCampaign[]>([])
  const [clock, setClock] = useState<{ serverMs: number; loadedAt: number } | null>(null)
  const [nowMs, setNowMs] = useState<number | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  // Versión (updated_at) que se abrió: la API rechaza guardar sobre una más nueva.
  const [editingVersion, setEditingVersion] = useState<string | null>(null)
  const [conflict, setConflict] = useState(false)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState<"desktop" | "mobile" | null>(null)
  const [message, setMessage] = useState("")
  const [error, setError] = useState("")
  const [warnings, setWarnings] = useState<{ desktop: string; mobile: string }>({ desktop: "", mobile: "" })

  const load = async () => {
    setLoading(true)
    try {
      const data = await authorizedFetch("/api/admin/banners?placement=home")
      const serverMs = Date.parse(String(data.server_now ?? ""))
      const rows = (Array.isArray(data.banners) ? data.banners : []) as HomeCampaign[]
      setCampaigns(rows)
      const loadedAt = Date.now()
      setClock({ serverMs: Number.isFinite(serverMs) ? serverMs : loadedAt, loadedAt })
      setNowMs(Number.isFinite(serverMs) ? serverMs : loadedAt)
      return rows
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudieron cargar las campañas.")
      return null
    } finally {
      setLoading(false)
    }
  }

  const showError = (cause: unknown, fallback: string) => {
    setConflict(cause instanceof BannerRequestError && cause.status === 409)
    setError(cause instanceof Error ? cause.message : fallback)
  }

  /** Tras un conflicto: trae lo guardado por el otro administrador (descarta lo no guardado). */
  const reloadAfterConflict = async () => {
    setConflict(false)
    setError("")
    const rows = await load()
    if (!rows || !editingId) return
    const fresh = rows.find((row) => row.id === editingId)
    if (fresh) {
      handleEdit(fresh)
      setMessage("Datos actualizados. Revisalos y volvé a guardar si hace falta.")
    } else {
      resetForm()
      setMessage("La campaña ya no existe (otro administrador la eliminó).")
    }
  }

  useEffect(() => {
    void load()
  }, [])

  // Hora del servidor que sigue corriendo: los estados cambian solos en la lista.
  useEffect(() => {
    if (!clock) return
    const timer = window.setInterval(() => setNowMs(clock.serverMs + Date.now() - clock.loadedAt), 30_000)
    return () => window.clearInterval(timer)
  }, [clock])

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((current) => ({ ...current, [key]: value }))

  const resetForm = () => {
    setEditingId(null)
    setEditingVersion(null)
    setConflict(false)
    setForm({ ...EMPTY_FORM, sortOrder: String((campaigns.at(-1)?.sort_order ?? -1) + 1) })
    setWarnings({ desktop: "", mobile: "" })
    setMessage("")
    setError("")
  }

  const handleEdit = (campaign: HomeCampaign) => {
    const start = bannerStartParts(campaign.starts_at)
    const end = bannerInclusiveEndParts(campaign.ends_at)
    setEditingId(campaign.id)
    setEditingVersion(campaign.updated_at)
    setConflict(false)
    setForm({
      campaignName: campaign.campaign_name ?? "",
      imageUrl: campaign.image_url,
      mobileImageUrl: campaign.mobile_image_url ?? "",
      altText: campaign.alt_text ?? "",
      startsDate: start.date,
      startsTime: start.time,
      endsDate: end.date,
      endsTime: end.time,
      active: campaign.active,
      sortOrder: String(campaign.sort_order),
      destinationUrl: campaign.destination_url ?? "",
    })
    setWarnings({ desktop: "", mobile: "" })
    setMessage("")
    setError("")
  }

  /** Vigencia en hora de Argentina: inicio inclusivo; "hasta" inclusive (se guarda el minuto siguiente). */
  const buildWindow = (): { startsAt: string | null; endsAt: string | null } | string => {
    for (const [date, time, label] of [[form.startsDate, form.startsTime, "inicio"], [form.endsDate, form.endsTime, "finalización"]] as const) {
      if (!date && time) return `Completá la fecha de ${label} o borrá la hora.`
      if (date && time && !TIME_PATTERN.test(time)) return `La hora de ${label} tiene que ser HH:MM (24 horas).`
    }
    const startsAt = form.startsDate ? bannerStartToUtc(form.startsDate, form.startsTime || "00:00") : null
    const endsAt = form.endsDate ? bannerInclusiveEndToUtc(form.endsDate, form.endsTime || "23:59") : null
    if ((form.startsDate && !startsAt) || (form.endsDate && !endsAt)) return "La fecha u hora no es válida."
    if (startsAt && endsAt && Date.parse(endsAt) <= Date.parse(startsAt)) return "La fecha de finalización tiene que ser posterior a la de inicio."
    return { startsAt, endsAt }
  }

  const handleSave = async () => {
    setMessage("")
    setError("")
    if (!form.campaignName.trim()) return setError("Ingresá el nombre de la campaña.")
    if (!form.imageUrl.trim()) return setError("Subí la imagen de escritorio.")
    const destination = validateBannerDestination(form.destinationUrl)
    if (!destination.ok) return setError(destination.error)
    const schedule = buildWindow()
    if (typeof schedule === "string") return setError(schedule)
    const sortOrder = parseBannerSortOrder(form.sortOrder)
    if (!sortOrder.ok) return setError(sortOrder.error)

    setSaving(true)
    try {
      const data = await authorizedFetch("/api/admin/banners", {
        method: editingId ? "PATCH" : "POST",
        body: JSON.stringify({
          id: editingId,
          placement: "home",
          campaign_name: form.campaignName,
          image_url: form.imageUrl,
          mobile_image_url: form.mobileImageUrl,
          alt_text: form.altText,
          active: form.active,
          sort_order: sortOrder.value,
          starts_at: schedule.startsAt,
          ends_at: schedule.endsAt,
          destination_url: destination.value ?? "",
          ...(editingId ? { expected_updated_at: editingVersion } : {}),
        }),
      })
      const saved = data.banner as HomeCampaign | undefined
      if (saved) {
        setEditingId(saved.id)
        setEditingVersion(saved.updated_at)
      }
      setConflict(false)
      setMessage(editingId ? "Campaña actualizada." : "Campaña creada.")
      await load()
    } catch (cause) {
      showError(cause, "No se pudo guardar la campaña.")
    } finally {
      setSaving(false)
    }
  }

  const handleUpload = (kind: "desktop" | "mobile") => async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ""
    if (!file) return
    setUploading(kind)
    setMessage("")
    setError("")
    const result = await uploadBannerImage(file, kind === "desktop" ? "home" : "home/mobile", "home")
    setUploading(null)
    if (!result.ok) return setError(result.error)
    set(kind === "desktop" ? "imageUrl" : "mobileImageUrl", result.url)
    setWarnings((current) => ({
      ...current,
      [kind]: ratioWarning(kind === "desktop" ? "Escritorio" : "Celular", result.width, result.height, kind === "desktop" ? HOME_BANNER_DESKTOP : HOME_BANNER_MOBILE),
    }))
    setMessage("Imagen subida. Guardá la campaña para aplicarla.")
  }

  const handleToggle = async (campaign: HomeCampaign) => {
    setMessage("")
    setError("")
    try {
      const data = await authorizedFetch("/api/admin/banners", {
        method: "PATCH",
        body: JSON.stringify({ id: campaign.id, active: !campaign.active, expected_updated_at: campaign.updated_at }),
      })
      // Si se estaba editando esta campaña, el formulario sigue la nueva versión.
      const saved = data.banner as HomeCampaign | undefined
      if (saved && editingId === saved.id) {
        setEditingVersion(saved.updated_at)
        set("active", saved.active)
      }
      setConflict(false)
      setMessage(campaign.active ? "Campaña desactivada." : "Campaña activada.")
      await load()
    } catch (cause) {
      showError(cause, "No se pudo cambiar el estado de la campaña.")
    }
  }

  const handleDelete = async (campaign: HomeCampaign) => {
    if (!confirm(`¿Eliminar la campaña "${campaign.campaign_name ?? "sin nombre"}"?`)) return
    setMessage("")
    setError("")
    try {
      // Versión vista en la lista: si otro administrador la cambió, la API no la elimina (409).
      const query = new URLSearchParams({ id: campaign.id, expected_updated_at: campaign.updated_at ?? "" })
      await authorizedFetch(`/api/admin/banners?${query}`, { method: "DELETE" })
      if (editingId === campaign.id) resetForm()
      setConflict(false)
      setMessage("Campaña eliminada.")
      await load()
    } catch (cause) {
      showError(cause, "No se pudo eliminar la campaña.")
    }
  }

  const visibleNow = nowMs === null ? null : pickVisibleBanner(campaigns, nowMs)
  const alt = form.altText || DEFAULT_ALT_TEXT.home

  return (
    <div className="space-y-2.5" data-home-campaigns="">
      {error ? (
        <AdminInfoBlock tone="danger">
          <span data-home-campaigns-error="">{error}</span>
          {conflict ? (
            <AdminSecondaryButton title="Recargar datos" size="sm" className="ml-2" onClick={() => void reloadAfterConflict()}>
              <RotateCcw className="size-3.5" />
              Recargar datos
            </AdminSecondaryButton>
          ) : null}
        </AdminInfoBlock>
      ) : null}
      {message ? <AdminInfoBlock tone="success">{message}</AdminInfoBlock> : null}

      <div className="grid gap-2.5 xl:grid-cols-[minmax(0,1fr)_minmax(360px,1fr)]">
        <AdminCard className="space-y-3 p-3.5">
          <h3 className="text-sm font-black text-white">{editingId ? "Editar campaña" : "Nueva campaña"}</h3>

          <AdminFormField label="Nombre de la campaña (interno)" labelClassName="mb-1.5 text-12px">
            <AdminTextInput title="Nombre de la campaña" value={form.campaignName} maxLength={CAMPAIGN_NAME_MAX}
              placeholder="Ej.: Navidad 2026" className="h-9 text-sm" onChange={(value) => set("campaignName", value)} />
          </AdminFormField>

          <input ref={desktopInputRef} type="file" accept={BANNER_FILE_ACCEPT.home} className="hidden" onChange={handleUpload("desktop")} data-home-campaign-file="desktop" />
          <input ref={mobileInputRef} type="file" accept={BANNER_FILE_ACCEPT.home} className="hidden" onChange={handleUpload("mobile")} data-home-campaign-file="mobile" />
          <div className="flex flex-wrap gap-2">
            <AdminSecondaryButton title="Subir imagen de escritorio" size="sm" disabled={Boolean(uploading) || saving} onClick={() => desktopInputRef.current?.click()}>
              <Upload className="size-3.5" />
              {uploading === "desktop" ? "Subiendo…" : form.imageUrl ? "Cambiar imagen de escritorio" : "Subir imagen de escritorio"}
            </AdminSecondaryButton>
            <AdminSecondaryButton title="Subir imagen para celular" size="sm" disabled={Boolean(uploading) || saving} onClick={() => mobileInputRef.current?.click()}>
              <Smartphone className="size-3.5" />
              {uploading === "mobile" ? "Subiendo…" : form.mobileImageUrl ? "Cambiar imagen para celular" : "Imagen para celular (opcional)"}
            </AdminSecondaryButton>
            {form.mobileImageUrl ? (
              <AdminGhostButton title="Quitar imagen para celular" size="sm" onClick={() => set("mobileImageUrl", "")}>
                <X className="size-3.5" />
                Quitar celular
              </AdminGhostButton>
            ) : null}
          </div>
          <p className="text-12px text-white/45">{HOME_BANNER_HELP}</p>
          {warnings.desktop || warnings.mobile ? (
            <AdminInfoBlock tone="warning">{[warnings.desktop, warnings.mobile].filter(Boolean).join(" ")}</AdminInfoBlock>
          ) : null}

          <div className="grid gap-2.5 sm:grid-cols-2">
            <AdminFormField label="Inicio" labelClassName="mb-1.5 text-12px" help="Vacío: desde que se guarda.">
              <div className="flex gap-2">
                <div className="min-w-0 flex-1">
                  <AdminDatePicker title="Inicio (fecha)" ariaLabel="Inicio: fecha" placeholder="dd/mm/aaaa" value={form.startsDate} onChange={(value) => set("startsDate", value)} />
                </div>
                <div className="w-[84px]">
                  <AdminTextInput title="Inicio (hora)" ariaLabel="Inicio: hora" placeholder="00:00" inputMode="numeric" maxLength={5}
                    value={form.startsTime} className="h-9 text-center text-sm tabular-nums" onChange={(value) => set("startsTime", formatTimeInput(value))} />
                </div>
              </div>
            </AdminFormField>
            <AdminFormField label="Visible hasta (inclusive)" labelClassName="mb-1.5 text-12px" help="Vacío: sin fecha de fin.">
              <div className="flex gap-2">
                <div className="min-w-0 flex-1">
                  <AdminDatePicker title="Fin (fecha)" ariaLabel="Fin: fecha" placeholder="dd/mm/aaaa" value={form.endsDate} minDate={form.startsDate || undefined} onChange={(value) => set("endsDate", value)} />
                </div>
                <div className="w-[84px]">
                  <AdminTextInput title="Fin (hora)" ariaLabel="Fin: hora" placeholder="23:59" inputMode="numeric" maxLength={5}
                    value={form.endsTime} className="h-9 text-center text-sm tabular-nums" onChange={(value) => set("endsTime", formatTimeInput(value))} />
                </div>
              </div>
            </AdminFormField>
          </div>
          <p className="text-12px text-white/45">Hora de Argentina, formato 24 horas. Sin fechas, la campaña es permanente.</p>

          <div className="flex flex-wrap items-end gap-2.5">
            <AdminFormField label="Enlace de destino (opcional)" className="min-w-[200px] flex-1" labelClassName="mb-1.5 text-12px">
              <AdminTextInput title="Enlace de destino" value={form.destinationUrl} placeholder="/productos o https://…" className="h-9 text-sm" onChange={(value) => set("destinationUrl", value)} />
            </AdminFormField>
            <AdminFormField label="Descripción" className="min-w-[160px] flex-1" labelClassName="mb-1.5 text-12px">
              <AdminTextInput title="Descripción de la imagen" value={form.altText} placeholder={DEFAULT_ALT_TEXT.home} className="h-9 text-sm" onChange={(value) => set("altText", value)} />
            </AdminFormField>
          </div>

          <div className="flex flex-wrap items-end gap-2.5">
            <AdminFormField label="Prioridad" className="w-24" labelClassName="mb-1.5 text-12px">
              <AdminTextInput title="Orden de prioridad" value={form.sortOrder} placeholder="0" inputMode="numeric" className="h-9 text-center text-sm" onChange={(value) => set("sortOrder", value)} />
            </AdminFormField>
            <AdminFormField label="Estado" className="w-32" labelClassName="mb-1.5 text-12px">
              <AdminSecondaryButton title={form.active ? "Campaña activada" : "Campaña desactivada"} onClick={() => set("active", !form.active)} size="sm" className="h-9 w-full justify-between">
                <span>{form.active ? "Activada" : "Desactivada"}</span>
                <span className={`h-4 w-7 rounded-full p-0.5 transition ${form.active ? "bg-beyonix-sky/80" : "bg-white/18"}`}>
                  <span className={`block size-3 rounded-full bg-white transition ${form.active ? "translate-x-3" : ""}`} />
                </span>
              </AdminSecondaryButton>
            </AdminFormField>
            <div className="ml-auto flex gap-2">
              <AdminGhostButton title="Limpiar formulario" size="sm" onClick={resetForm}>
                <RotateCcw className="size-3.5" />
                Limpiar
              </AdminGhostButton>
              <AdminPrimaryButton title="Guardar campaña" size="sm" disabled={saving || Boolean(uploading)} onClick={() => void handleSave()}>
                <Save className="size-3.5" />
                {saving ? "Guardando" : "Guardar campaña"}
              </AdminPrimaryButton>
            </div>
          </div>
          <p className="text-12px text-white/45">Si hay varias vigentes, el Home muestra sólo la de menor prioridad (a igual número, la más antigua).</p>
        </AdminCard>

        <AdminCard className="space-y-2.5 self-start p-2.5" data-home-campaign-previews="">
          <ImagePreview src={form.imageUrl} alt={alt} aspect="aspect-[4/1]" label="Escritorio" empty="Sin imagen de escritorio" />
          <div className="mx-auto w-full max-w-[260px]">
            <ImagePreview src={form.mobileImageUrl || form.imageUrl} alt={alt} aspect={form.mobileImageUrl || !form.imageUrl ? "aspect-[3/2]" : "aspect-[4/1]"} label="Celular" empty="Sin imagen" />
            {!form.mobileImageUrl && form.imageUrl ? <p className="mt-1 text-center text-12px text-white/45">Sin imagen para celular: se usa la de escritorio, sin recortar.</p> : null}
          </div>
        </AdminCard>
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-xs font-black text-white">Campañas del Home</h3>
          <span className="text-12px font-bold text-white/45">{loading ? "Cargando" : campaigns.length}</span>
        </div>
        {campaigns.length ? campaigns.map((campaign) => {
          const status = nowMs === null ? null : getBannerStatus(campaign, nowMs)
          const showing = visibleNow?.id === campaign.id
          return (
            <AdminCard key={campaign.id} className="grid items-center gap-3 p-2.5 lg:grid-cols-[200px_1fr_auto]" data-home-campaign-row={campaign.id} data-home-campaign-status={status ?? ""}>
              <div className="relative aspect-[4/1] w-full overflow-hidden rounded-lg border border-beyonix-blue-light/20 bg-[#03070D]">
                {/* eslint-disable-next-line @next/next/no-img-element -- miniatura de Admin */}
                <img src={campaign.image_url} alt={campaign.alt_text || DEFAULT_ALT_TEXT.home} className="absolute inset-0 size-full object-cover object-center" />
              </div>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  {status ? <AdminBadge tone={STATUS_TONE[status]}>{BANNER_STATUS_LABELS[status]}</AdminBadge> : null}
                  {showing ? <AdminBadge tone="success" data-home-campaign-showing="">En el Home ahora</AdminBadge> : null}
                  {status === "active" && !showing ? <AdminBadge tone="neutral">Vigente, con menor prioridad</AdminBadge> : null}
                  <AdminBadge tone="neutral">Prioridad {campaign.sort_order}</AdminBadge>
                  {campaign.mobile_image_url ? <AdminBadge tone="neutral">Con celular</AdminBadge> : null}
                </div>
                <p className="mt-1.5 truncate text-sm font-black text-white/90">{campaign.campaign_name || "Sin nombre"}</p>
                <p className="truncate text-12px text-white/55">{scheduleText(campaign)}</p>
                {campaign.destination_url ? <p className="truncate text-12px text-white/40">Enlace: {campaign.destination_url}</p> : null}
              </div>
              <div className="flex items-center gap-1.5">
                <AdminSecondaryButton title={campaign.active ? "Desactivar campaña" : "Activar campaña"} size="sm" onClick={() => void handleToggle(campaign)}>
                  {campaign.active ? "Desactivar" : "Activar"}
                </AdminSecondaryButton>
                <AdminGhostButton title="Editar campaña" size="icon" onClick={() => handleEdit(campaign)}>
                  <Pencil className="size-3.5" />
                </AdminGhostButton>
                <AdminDangerButton title="Eliminar campaña" size="icon" onClick={() => void handleDelete(campaign)}>
                  <Trash2 className="size-3.5" />
                </AdminDangerButton>
              </div>
            </AdminCard>
          )
        }) : (
          <AdminEmptyState icon={<ImageIcon className="size-4" />} title={loading ? "Cargando campañas" : "Sin campañas: el Home se ve como siempre"} className="py-4" />
        )}
      </div>
    </div>
  )
}
