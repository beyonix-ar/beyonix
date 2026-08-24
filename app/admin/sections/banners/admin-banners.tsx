"use client"

import { useEffect, useRef, useState, type ChangeEvent } from "react"
import {
  ImageIcon,
  Pencil,
  Plus,
  RotateCcw,
  Save,
  Trash2,
  Upload,
} from "lucide-react"

import { supabase } from "@/lib/supabase/client"
import {
  adminPageClassName,
  AdminBadge,
  AdminCard,
  AdminDangerButton,
  AdminEmptyState,
  AdminFormField,
  AdminGhostButton,
  AdminInfoBlock,
  AdminPageHeader,
  AdminPrimaryButton,
  AdminSecondaryButton,
  AdminTextInput,
} from "../../components/admin-controls"

interface AdminBanner {
  id: string
  placement: "products"
  image_url: string
  alt_text: string | null
  active: boolean
  sort_order: number
  updated_at: string | null
  legacy?: boolean
}

const PRODUCTS_PLACEMENT = "products"
const DEFAULT_ALT_TEXT = "Banner de productos BEYONIX"
const BANNER_SIZE_HELP = "1920 × 520 px"
const STORAGE_BUCKET = "site-banners"

function getCleanFileName(fileName: string) {
  return fileName
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .toLowerCase()
}

export function AdminBanners({ embedded = false }: { embedded?: boolean } = {}) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [banners, setBanners] = useState<AdminBanner[]>([])
  const [editingId, setEditingId] = useState<string | null>(null)
  const [imageUrl, setImageUrl] = useState("")
  const [altText, setAltText] = useState(DEFAULT_ALT_TEXT)
  const [active, setActive] = useState(true)
  const [sortOrder, setSortOrder] = useState("0")
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [message, setMessage] = useState("")
  const [error, setError] = useState("")

  const loadBanners = async () => {
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

    const response = await fetch(
      `/api/admin/banners?placement=${PRODUCTS_PLACEMENT}`,
      {
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
      }
    )
    const data = (await response.json()) as {
      banners?: AdminBanner[]
      error?: string
    }

    if (!response.ok) {
      setError(data.error ?? "No se pudieron cargar los banners.")
      setLoading(false)
      return
    }

    setBanners(data.banners ?? [])
    setLoading(false)
  }

  useEffect(() => {
    void loadBanners()
  }, [])

  const resetForm = () => {
    setEditingId(null)
    setImageUrl("")
    setAltText(DEFAULT_ALT_TEXT)
    setActive(true)
    setSortOrder(String((banners.at(-1)?.sort_order ?? -1) + 1))
    setMessage("")
    setError("")
  }

  const handleEdit = (banner: AdminBanner) => {
    setEditingId(banner.legacy ? null : banner.id)
    setImageUrl(banner.image_url)
    setAltText(banner.alt_text || DEFAULT_ALT_TEXT)
    setActive(banner.active)
    setSortOrder(String(banner.sort_order ?? 0))
    setMessage(banner.legacy ? "Este banner anterior se guardará como banner múltiple." : "")
    setError("")
  }

  const persistBanner = async (nextImageUrl: string) => {
    setSaving(true)
    setMessage("")
    setError("")

    const {
      data: { session },
    } = await supabase.auth.getSession()

    if (!session?.access_token) {
      setError("No se pudo validar la sesión.")
      setSaving(false)
      return false
    }

    const method = editingId ? "PATCH" : "POST"
    const response = await fetch("/api/admin/banners", {
      method,
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: editingId,
        placement: PRODUCTS_PLACEMENT,
        image_url: nextImageUrl,
        alt_text: altText,
        active,
        sort_order: sortOrder,
      }),
    })
    const data = (await response.json()) as {
      banner?: AdminBanner
      error?: string
    }

    if (!response.ok || !data.banner) {
      setError(data.error ?? "No se pudo guardar el banner.")
      setSaving(false)
      return false
    }

    setMessage(editingId ? "Banner actualizado." : "Banner creado.")
    setEditingId(data.banner.id)
    await loadBanners()
    setSaving(false)
    return true
  }

  const handleSave = async () => {
    const nextImageUrl = imageUrl.trim()

    if (!nextImageUrl) {
      setError("Cargá una imagen o pegá una URL.")
      return
    }

    await persistBanner(nextImageUrl)
  }

  const handleUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ""

    if (!file) return

    setUploading(true)
    setMessage("")
    setError("")

    const extension = file.name.split(".").pop() || "jpg"
    const path = `${PRODUCTS_PLACEMENT}/${Date.now()}-${getCleanFileName(
      file.name.replace(new RegExp(`\\.${extension}$`, "i"), "")
    )}.${extension.toLowerCase()}`
    const { error: uploadError } = await supabase.storage
      .from(STORAGE_BUCKET)
      .upload(path, file, {
        cacheControl: "3600",
        upsert: false,
      })

    if (uploadError) {
      setError(uploadError.message)
      setUploading(false)
      return
    }

    const { data } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(path)
    const publicUrl = data.publicUrl

    setImageUrl(publicUrl)
    const saved = await persistBanner(publicUrl)

    if (saved) {
      setMessage("Imagen subida y banner guardado.")
    }

    setUploading(false)
  }

  const handleDelete = async (banner: AdminBanner) => {
    if (banner.legacy) {
      setError("El banner anterior no se elimina desde esta lista. Guardá uno nuevo para migrarlo.")
      return
    }

    const ok = confirm("¿Eliminar este banner?")
    if (!ok) return

    setError("")
    setMessage("")

    const {
      data: { session },
    } = await supabase.auth.getSession()

    if (!session?.access_token) {
      setError("No se pudo validar la sesión.")
      return
    }

    const response = await fetch(`/api/admin/banners?id=${banner.id}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${session.access_token}`,
      },
    })
    const data = (await response.json()) as { error?: string }

    if (!response.ok) {
      setError(data.error ?? "No se pudo eliminar el banner.")
      return
    }

    if (editingId === banner.id) {
      resetForm()
    }

    setMessage("Banner eliminado.")
    await loadBanners()
  }

  const handleToggleBanner = async (banner: AdminBanner) => {
    if (banner.legacy) {
      handleEdit(banner)
      return
    }

    const {
      data: { session },
    } = await supabase.auth.getSession()

    if (!session?.access_token) {
      setError("No se pudo validar la sesión.")
      return
    }

    const response = await fetch("/api/admin/banners", {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: banner.id,
        placement: banner.placement,
        image_url: banner.image_url,
        alt_text: banner.alt_text,
        active: !banner.active,
        sort_order: banner.sort_order,
      }),
    })
    const data = (await response.json()) as { error?: string }

    if (!response.ok) {
      setError(data.error ?? "No se pudo cambiar el estado del banner.")
      return
    }

    setMessage(!banner.active ? "Banner activado." : "Banner desactivado.")
    await loadBanners()
  }

  return (
    <div className={embedded ? "space-y-3" : adminPageClassName}>
      {!embedded ? (
        <AdminPageHeader
        eyebrow="Visuales"
        title="Banners"
        actions={
          <AdminPrimaryButton
            title="Nuevo banner"
            aria-label="Nuevo banner"
            size="lg"
            onClick={resetForm}
            className="min-w-160px"
          >
            <Plus className="size-4" />
            Nuevo banner
          </AdminPrimaryButton>
        }
        />
      ) : null}

      {error ? (
        <AdminInfoBlock tone="danger">
          {error}
        </AdminInfoBlock>
      ) : null}

      {message ? (
        <AdminInfoBlock tone="success">
          {message}
        </AdminInfoBlock>
      ) : null}

      <section className="space-y-2.5">
        <div className="grid gap-2.5 xl:grid-cols-[minmax(0,1fr)_minmax(360px,1fr)]">
          <AdminCard className="space-y-2.5 p-3.5">
            <h3 className="text-sm font-black text-white">
              {editingId ? "Editar banner" : "Nuevo banner"}
            </h3>

            <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleUpload} />

            <div>
              <p className="mb-1.5 text-12px font-black uppercase tracking-widest text-white/52">
                Imagen
              </p>
              <button
                type="button"
                title="Subir imagen"
                aria-label="Subir imagen"
                disabled={uploading || saving}
                onClick={() => fileInputRef.current?.click()}
                className="flex h-11 w-full items-center gap-2.5 rounded-lg border border-dashed border-beyonix-blue-light/28 bg-white/[0.015] px-3 text-left transition hover:border-beyonix-sky/45 hover:bg-white/[0.03] disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-beyonix-blue-light/20 bg-beyonix-blue/16 text-beyonix-cyan">
                  {uploading ? (
                    <Upload className="size-3.5 animate-pulse" />
                  ) : imageUrl ? (
                    <ImageIcon className="size-3.5" />
                  ) : (
                    <Upload className="size-3.5" />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-bold text-white/85">
                    {uploading
                      ? "Subiendo…"
                      : imageUrl
                        ? "Imagen cargada"
                        : "Sin imagen seleccionada"}
                  </span>
                  <span className="block truncate text-12px text-white/42">
                    {imageUrl || "Hacé clic para elegir un archivo"}
                  </span>
                </span>
              </button>
              <p className="mt-1.5 text-12px text-white/40">
                Recomendado {BANNER_SIZE_HELP} · también podés pegar una URL:
              </p>
              <AdminTextInput
                title="Imagen URL"
                ariaLabel="URL de imagen"
                value={imageUrl}
                placeholder="https://…"
                className="mt-1 h-9 text-xs"
                onChange={setImageUrl}
              />
            </div>

            <div className="flex flex-wrap items-end gap-2.5">
              <AdminFormField label="Descripción" className="min-w-[160px] flex-1" labelClassName="mb-1.5 text-12px">
                <AdminTextInput
                  title="Descripción"
                  ariaLabel="Descripción del banner"
                  value={altText}
                  placeholder="Descripción accesible"
                  className="h-9 text-sm"
                  onChange={setAltText}
                />
              </AdminFormField>
              <AdminFormField label="Orden" className="w-16" labelClassName="mb-1.5 text-12px">
                <AdminTextInput
                  title="Orden"
                  ariaLabel="Orden del banner"
                  value={sortOrder}
                  placeholder="0"
                  inputMode="numeric"
                  className="h-9 text-center text-sm"
                  onChange={setSortOrder}
                />
              </AdminFormField>
              <AdminFormField label="Estado" className="w-32" labelClassName="mb-1.5 text-12px">
                <AdminSecondaryButton
                  title={active ? "Banner activo" : "Banner inactivo"}
                  aria-label={active ? "Banner activo" : "Banner inactivo"}
                  onClick={() => setActive((current) => !current)}
                  size="sm"
                  className="h-9 w-full justify-between"
                >
                  <span>{active ? "Activo" : "Oculto"}</span>
                  <span className={`h-4 w-7 rounded-full p-0.5 transition ${active ? "bg-beyonix-sky/80" : "bg-white/18"}`}>
                    <span className={`block size-3 rounded-full bg-white transition ${active ? "translate-x-3" : ""}`} />
                  </span>
                </AdminSecondaryButton>
              </AdminFormField>

              <div className="ml-auto flex gap-2">
                <AdminGhostButton title="Limpiar formulario" aria-label="Limpiar formulario" size="sm" onClick={resetForm}>
                  <RotateCcw className="size-3.5" />
                  Limpiar
                </AdminGhostButton>
                <AdminPrimaryButton title="Guardar banner" aria-label="Guardar banner" disabled={saving || uploading} onClick={handleSave} size="sm">
                  <Save className="size-3.5" />
                  {saving ? "Guardando" : "Guardar banner"}
                </AdminPrimaryButton>
              </div>
            </div>
          </AdminCard>

          <AdminCard className="self-start p-2.5">
            <div className="relative aspect-[48/13] w-full overflow-hidden rounded-xl border border-beyonix-blue-light/20 bg-[#03070D]">
              <span className="absolute left-2 top-2 z-10 rounded-full border border-beyonix-blue-light/16 bg-black/55 px-2 py-0.5 text-10px font-black uppercase tracking-wider text-white/58 backdrop-blur-sm">
                Vista previa
              </span>
              {imageUrl ? (
                <img src={imageUrl} alt={altText || DEFAULT_ALT_TEXT} className="absolute inset-0 size-full object-contain object-center" />
              ) : (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-1">
                  <ImageIcon className="size-5 text-beyonix-sky/45" />
                  <p className="text-12px font-bold text-white/58">Sin imagen</p>
                </div>
              )}
            </div>
          </AdminCard>
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-xs font-black text-white">Banners cargados</h3>
            <span className="text-12px font-bold text-white/45">{loading ? "Cargando" : banners.length}</span>
          </div>

          {banners.length ? (
            banners.map((banner) => (
              <AdminCard key={banner.id} className="grid items-center gap-3 p-2.5 lg:grid-cols-[200px_1fr_auto]">
                <div className="relative aspect-[48/13] w-full overflow-hidden rounded-lg border border-beyonix-blue-light/20 bg-[#03070D] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
                  <img src={banner.image_url} alt={banner.alt_text || DEFAULT_ALT_TEXT} className="absolute inset-0 size-full object-contain object-center" />
                </div>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <AdminSecondaryButton
                      title={banner.active ? "Desactivar banner" : "Activar banner"}
                      aria-label={banner.active ? "Desactivar banner" : "Activar banner"}
                      size="sm"
                      onClick={() => void handleToggleBanner(banner)}
                      className="min-h-0 border-0 bg-transparent p-0 hover:bg-transparent"
                    >
                      <AdminBadge tone={banner.active ? "success" : "neutral"}>{banner.active ? "Activo" : "Inactivo"}</AdminBadge>
                    </AdminSecondaryButton>
                    <AdminBadge tone="neutral">Orden {banner.sort_order}</AdminBadge>
                  </div>
                  <p className="mt-1.5 truncate text-sm font-black text-white/90">{banner.alt_text || DEFAULT_ALT_TEXT}</p>
                  <p className="truncate text-12px text-white/38">{banner.image_url}</p>
                </div>
                <div className="flex items-center gap-1.5">
                  <AdminGhostButton title="Editar banner" aria-label="Editar banner" size="icon" onClick={() => handleEdit(banner)}>
                    <Pencil className="size-3.5" />
                  </AdminGhostButton>
                  <AdminDangerButton title="Eliminar banner" aria-label="Eliminar banner" size="icon" onClick={() => void handleDelete(banner)}>
                    <Trash2 className="size-3.5" />
                  </AdminDangerButton>
                </div>
              </AdminCard>
            ))
          ) : (
            <AdminEmptyState icon={<ImageIcon className="size-4" />} title="Sin banners" className="py-4" />
          )}
        </div>
      </section>
    </div>
  )
}
