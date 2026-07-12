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
import {
  adminPageClassName,
  AdminBadge,
  AdminCard,
  AdminDangerButton,
  AdminEmptyState,
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
    <div className={adminPageClassName}>
      <AdminPageHeader
        eyebrow="Comunicación visual"
        title="Banners"
        description="Administrá las imágenes promocionales visibles en la tienda."
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

      <section className="grid gap-5 xl:grid-cols-[minmax(0,420px)_1fr]">
        <AdminCard className="space-y-4">
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

          <AdminSecondaryButton
            title="Subir imagen"
            aria-label="Subir imagen"
            disabled={uploading || saving}
            onClick={() => fileInputRef.current?.click()}
            size="lg"
            className="w-full"
          >
            <Upload className="size-4" />
            {uploading ? "Subiendo" : "Subir imagen"}
          </AdminSecondaryButton>

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

          <AdminSecondaryButton
            title={active ? "Banner activo" : "Banner inactivo"}
            aria-label={active ? "Banner activo" : "Banner inactivo"}
            onClick={() => setActive((current) => !current)}
            size="lg"
            className="w-full justify-between"
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
          </AdminSecondaryButton>

          <div className="flex gap-3">
            <AdminPrimaryButton
              title="Guardar banner"
              aria-label="Guardar banner"
              disabled={saving || uploading}
              onClick={handleSave}
              size="lg"
              className="flex-1"
            >
              <Save className="size-4" />
              {saving ? "Guardando" : "Guardar"}
            </AdminPrimaryButton>
            <AdminGhostButton
              title="Limpiar formulario"
              aria-label="Limpiar formulario"
              size="icon"
              onClick={resetForm}
            >
              <X className="size-4" />
            </AdminGhostButton>
          </div>

          <p className="text-xs leading-relaxed text-white/45">
            Podés subir una imagen, pegar una URL externa o usar una ruta local
            como /images/banners/banner-productos.png.
          </p>
        </AdminCard>

        <div className="space-y-4">
          <AdminCard>
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
          </AdminCard>

          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-lg font-black text-white">Banners cargados</h2>
              <span className="text-xs font-bold text-white/45">
                {loading ? "Cargando" : `${banners.length} banners`}
              </span>
            </div>

            {banners.length ? (
              banners.map((banner) => (
                <AdminCard
                  key={banner.id}
                  className="grid gap-4 lg:grid-cols-[220px_1fr_auto]"
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
                      <AdminBadge tone="info">
                        Productos
                      </AdminBadge>
                      <AdminSecondaryButton
                        title={banner.active ? "Desactivar banner" : "Activar banner"}
                        aria-label={banner.active ? "Desactivar banner" : "Activar banner"}
                        size="sm"
                        onClick={() => void handleToggleBanner(banner)}
                        className="min-h-0 border-0 bg-transparent p-0 hover:bg-transparent"
                      >
                        <AdminBadge tone={banner.active ? "success" : "neutral"}>
                          {banner.active ? "Activo" : "Inactivo"}
                        </AdminBadge>
                      </AdminSecondaryButton>
                      <AdminBadge tone="neutral">
                        Orden {banner.sort_order}
                      </AdminBadge>
                    </div>

                    <p className="mt-3 truncate text-sm font-bold text-white/86">
                      {banner.alt_text || DEFAULT_ALT_TEXT}
                    </p>
                    <p className="mt-1 truncate text-xs text-white/42">
                      {banner.image_url}
                    </p>
                  </div>

                  <div className="flex items-center gap-2 lg:flex-col lg:items-end">
                    <AdminGhostButton
                      title="Editar banner"
                      aria-label="Editar banner"
                      size="icon"
                      onClick={() => handleEdit(banner)}
                    >
                      <Pencil className="size-4" />
                    </AdminGhostButton>
                    <AdminDangerButton
                      title="Eliminar banner"
                      aria-label="Eliminar banner"
                      size="icon"
                      onClick={() => void handleDelete(banner)}
                    >
                      <Trash2 className="size-4" />
                    </AdminDangerButton>
                  </div>
                </AdminCard>
              ))
            ) : (
              <AdminEmptyState
                icon={<ImageIcon className="size-5" />}
                title="No hay banners cargados."
                description="El espacio de Productos queda reservado y vacío."
              />
            )}
          </div>
        </div>
      </section>
    </div>
  )
}
