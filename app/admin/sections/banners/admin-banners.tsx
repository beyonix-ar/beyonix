"use client"

import { useEffect, useRef, useState, type ChangeEvent } from "react"
import {
  ImageIcon,
  Pencil,
  Plus,
  Save,
  Trash2,
  Upload,
  X,
} from "lucide-react"

import { supabase } from "@/lib/supabase/client"
import { AdminTextInput } from "../../components/admin-controls"
import { beyonixHoverBorder, cn } from "@/lib/utils"

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
const STORAGE_BUCKET = "site-banners"

function getCleanFileName(fileName: string) {
  return fileName
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .toLowerCase()
}

export function AdminBanners() {
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
    <div className="space-y-6 p-4 sm:p-6 lg:p-8">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <p className="mb-1 text-11px font-bold uppercase tracking-widest text-beyonix-cyan">
            Comunicación visual
          </p>
          <h1 className="text-3xl font-black text-white/95">Banners</h1>
          <p className="mt-2 text-sm text-white/68">
            Administrá las imágenes promocionales visibles en la tienda.
          </p>
        </div>

        <button
          type="button"
          title="Nuevo banner"
          aria-label="Nuevo banner"
          onClick={resetForm}
          className={cn(
            "inline-flex h-12 min-w-160px cursor-pointer items-center justify-center gap-2 rounded-2xl bg-white px-6 text-sm font-black text-black transition hover:bg-white/90",
            beyonixHoverBorder
          )}
        >
          <Plus className="size-4" />
          Nuevo banner
        </button>
      </div>

      {error ? (
        <div className="rounded-2xl border border-red-400/20 bg-red-400/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      ) : null}

      {message ? (
        <div className="rounded-2xl border border-emerald-300/20 bg-emerald-300/10 px-4 py-3 text-sm text-emerald-100">
          {message}
        </div>
      ) : null}

      <section className="grid gap-5 xl:grid-cols-[minmax(0,420px)_1fr]">
        <div className="space-y-4 rounded-3xl border border-white/8 bg-black/20 p-4">
          <div>
            <p className="text-11px font-black uppercase tracking-widest text-beyonix-cyan">
              Productos
            </p>
            <h2 className="mt-1 text-lg font-black text-white">
              {editingId ? "Editar banner" : "Nuevo banner"}
            </h2>
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={handleUpload}
          />

          <button
            type="button"
            title="Subir imagen"
            aria-label="Subir imagen"
            disabled={uploading || saving}
            onClick={() => fileInputRef.current?.click()}
            className="flex h-12 w-full cursor-pointer items-center justify-center gap-2 rounded-2xl border border-beyonix-blue-light/35 bg-beyonix-blue/45 px-4 text-sm font-black text-beyonix-sky transition disabled:cursor-not-allowed disabled:opacity-45 hover:border-beyonix-sky/60 hover:bg-beyonix-blue"
          >
            <Upload className="size-4" />
            {uploading ? "Subiendo" : "Subir imagen"}
          </button>

          <AdminTextInput
            title="URL de imagen"
            ariaLabel="URL de imagen"
            value={imageUrl}
            placeholder="/images/banners/banner-productos.png o https://..."
            icon={<ImageIcon className="size-4" />}
            onChange={setImageUrl}
          />

          <AdminTextInput
            title="Texto alternativo"
            ariaLabel="Texto alternativo"
            value={altText}
            placeholder="Descripción del banner"
            onChange={setAltText}
          />

          <AdminTextInput
            title="Orden de aparición"
            ariaLabel="Orden de aparición"
            value={sortOrder}
            placeholder="0"
            inputMode="numeric"
            onChange={setSortOrder}
          />

          <button
            type="button"
            title={active ? "Banner activo" : "Banner inactivo"}
            aria-label={active ? "Banner activo" : "Banner inactivo"}
            onClick={() => setActive((current) => !current)}
            className="flex h-12 w-full cursor-pointer items-center justify-between rounded-2xl border border-white/10 bg-[#141414] px-4 text-left text-sm font-bold text-white/78 transition hover:border-beyonix-blue-light/45 hover:text-white"
          >
            <span>{active ? "Activo en Productos" : "Oculto en Productos"}</span>
            <span
              className={`h-5 w-9 rounded-full p-0.5 transition ${
                active ? "bg-beyonix-sky/80" : "bg-white/18"
              }`}
            >
              <span
                className={`block size-4 rounded-full bg-white transition ${
                  active ? "translate-x-4" : ""
                }`}
              />
            </span>
          </button>

          <div className="flex gap-3">
            <button
              type="button"
              title="Guardar banner"
              aria-label="Guardar banner"
              disabled={saving || uploading}
              onClick={handleSave}
              className={cn(
                "inline-flex h-11 flex-1 cursor-pointer items-center justify-center gap-2 rounded-2xl bg-white px-4 text-sm font-black text-black transition disabled:cursor-not-allowed disabled:opacity-45 hover:bg-white/90",
                beyonixHoverBorder
              )}
            >
              <Save className="size-4" />
              {saving ? "Guardando" : "Guardar"}
            </button>
            <button
              type="button"
              title="Limpiar formulario"
              aria-label="Limpiar formulario"
              onClick={resetForm}
              className="inline-flex h-11 w-12 cursor-pointer items-center justify-center rounded-2xl border border-white/10 text-white/62 transition hover:border-white/22 hover:text-white"
            >
              <X className="size-4" />
            </button>
          </div>

          <p className="text-xs leading-relaxed text-white/45">
            Podés subir una imagen, pegar una URL externa o usar una ruta local
            como /images/banners/banner-productos.png.
          </p>
        </div>

        <div className="space-y-4">
          <div className="rounded-3xl border border-white/8 bg-black/20 p-4">
            <p className="mb-3 text-11px font-black uppercase tracking-widest text-beyonix-cyan">
              Vista previa del formulario
            </p>
            <div className="relative flex min-h-260px items-center justify-center overflow-hidden rounded-xl border border-beyonix-blue-light/20 bg-[#03070D]">
              {imageUrl ? (
                <img
                  src={imageUrl}
                  alt={altText || DEFAULT_ALT_TEXT}
                  className="absolute inset-0 size-full object-cover object-center opacity-80"
                />
              ) : (
                <div className="px-6 text-center">
                  <ImageIcon className="mx-auto mb-3 size-9 text-beyonix-sky/45" />
                  <p className="text-sm font-bold text-white/68">
                    Espacio reservado sin imagen.
                  </p>
                </div>
              )}
            </div>
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-lg font-black text-white">Banners cargados</h2>
              <span className="text-xs font-bold text-white/45">
                {loading ? "Cargando" : `${banners.length} banners`}
              </span>
            </div>

            {banners.length ? (
              banners.map((banner) => (
                <article
                  key={banner.id}
                  className="grid gap-4 rounded-3xl border border-white/8 bg-black/20 p-4 lg:grid-cols-[220px_1fr_auto]"
                >
                  <div className="relative min-h-120px overflow-hidden rounded-xl border border-beyonix-blue-light/20 bg-[#03070D]">
                    <img
                      src={banner.image_url}
                      alt={banner.alt_text || DEFAULT_ALT_TEXT}
                      className="absolute inset-0 size-full object-cover object-center"
                    />
                  </div>

                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded-full border border-beyonix-blue-light/30 bg-beyonix-blue/40 px-2.5 py-1 text-10px font-black uppercase tracking-widest text-beyonix-sky">
                        Productos
                      </span>
                      <button
                        type="button"
                        title={banner.active ? "Desactivar banner" : "Activar banner"}
                        aria-label={banner.active ? "Desactivar banner" : "Activar banner"}
                        onClick={() => void handleToggleBanner(banner)}
                        className={`rounded-full border px-2.5 py-1 text-10px font-black uppercase tracking-widest ${
                          banner.active
                            ? "border-emerald-300/25 bg-emerald-300/10 text-emerald-100"
                            : "border-white/10 bg-white/5 text-white/45"
                        }`}
                      >
                        {banner.active ? "Activo" : "Inactivo"}
                      </button>
                      <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-10px font-black uppercase tracking-widest text-white/52">
                        Orden {banner.sort_order}
                      </span>
                    </div>

                    <p className="mt-3 truncate text-sm font-bold text-white/86">
                      {banner.alt_text || DEFAULT_ALT_TEXT}
                    </p>
                    <p className="mt-1 truncate text-xs text-white/42">
                      {banner.image_url}
                    </p>
                  </div>

                  <div className="flex items-center gap-2 lg:flex-col lg:items-end">
                    <button
                      type="button"
                      title="Editar banner"
                      aria-label="Editar banner"
                      onClick={() => handleEdit(banner)}
                      className="inline-flex size-10 cursor-pointer items-center justify-center rounded-xl border border-white/10 text-white/62 transition hover:border-beyonix-blue-light/40 hover:text-beyonix-sky"
                    >
                      <Pencil className="size-4" />
                    </button>
                    <button
                      type="button"
                      title="Eliminar banner"
                      aria-label="Eliminar banner"
                      onClick={() => void handleDelete(banner)}
                      className="inline-flex size-10 cursor-pointer items-center justify-center rounded-xl border border-red-300/15 text-red-200/70 transition hover:border-red-300/35 hover:text-red-100"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </div>
                </article>
              ))
            ) : (
              <div className="rounded-3xl border border-white/8 bg-black/20 p-6 text-center text-sm text-white/55">
                No hay banners cargados. El espacio de Productos queda reservado
                y vacío.
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  )
}
