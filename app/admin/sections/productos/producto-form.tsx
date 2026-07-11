"use client"

import { useState } from "react"
import { ArrowLeft, Loader2, Play, ToggleLeft, ToggleRight } from "lucide-react"

import type { SupabaseProducto } from "@/lib/supabase/types"

import type {
  DraftProductoEspecificacion,
  DraftProductoVariante,
} from "./types"
import { ProductSpecificationsEditor } from "./product-specifications-editor"
import { ProductVariantsEditor } from "./product-variants-editor"
import { useProductoForm } from "./use-producto-form"
import { AdminSelect } from "../../components/admin-controls"
import { getProductVideoSource } from "@/lib/products/product-video"

interface ProductoFormProps {
  producto?: SupabaseProducto | null
  onSaved: () => void
  onCancel: () => void
}

const inputCls =
  "h-10 w-full rounded-xl border border-white/8 bg-[#141414] px-3.5 text-sm text-white outline-none transition-colors placeholder:text-white/25 hover:border-[#112A43] focus:border-beyonix-blue-light"

const labelCls =
  "mb-2 block text-xs font-semibold uppercase tracking-widest text-white/50"

export function ProductoForm({ producto, onSaved, onCancel }: ProductoFormProps) {
  const [draftVariants, setDraftVariants] = useState<DraftProductoVariante[]>([])
  const [
    draftSpecifications,
    setDraftSpecifications,
  ] = useState<DraftProductoEspecificacion[]>([])

  const {
    form,
    error,
    success,
    saving,
    savedId,
    categorias,
    setField,
    submit,
    handleNombreChange,
  } = useProductoForm({
    producto,
    onSaved,
  })

  const currentProductoId = producto?.id || savedId
  const videoSource = getProductVideoSource(form.video_url)
  const canPreviewVideo =
    videoSource && videoSource.kind !== "unsupported"
  const cleanSlug = form.slug.trim()
  const cleanVideoUrl = form.video_url.trim()
  const cleanPrice = Number(form.precio)
  const hasValidDraftVariants =
    draftVariants.length > 0 &&
    draftVariants.every(
      (variant) =>
        variant.nombre.trim() &&
        /^#[0-9A-F]{6}$/i.test(variant.color_hex) &&
        Number.isFinite(Number(variant.stock)) &&
        Number(variant.stock) >= 0
    )
  const hasValidDraftSpecifications =
    draftSpecifications.every(
      (specification) =>
        specification.icono.trim() &&
        specification.texto.trim() &&
        Number.isFinite(Number(specification.orden))
    )
  const isSubmitReady = Boolean(
    form.nombre.trim() &&
    cleanSlug &&
    Number.isFinite(cleanPrice) &&
    cleanPrice > 0 &&
    (!cleanVideoUrl ||
      (videoSource && videoSource.kind !== "unsupported")) &&
    (producto || savedId || hasValidDraftVariants) &&
    hasValidDraftSpecifications
  )
  const submitButtonStateClass = isSubmitReady
    ? "hover:border-emerald-400/55 hover:bg-emerald-500 hover:text-white hover:shadow-[0_0_24px_rgba(16,185,129,0.28)]"
    : "hover:border-red-400/55 hover:bg-red-500 hover:text-white hover:shadow-[0_0_24px_rgba(239,68,68,0.24)]"

  return (
    <div className="min-h-screen px-4 py-5 sm:px-6 lg:px-7 lg:py-6">
      <div className="mx-auto w-full max-w-[1720px]">
        <div className="mb-4 flex items-center justify-between gap-4">
          <div>
            <p className="mb-1 text-11px font-semibold uppercase tracking-widest text-beyonix-cyan">
              Productos
            </p>
            <h1 className="text-3xl font-bold text-white">
              {producto ? "Editar producto" : "Nuevo producto"}
            </h1>
          </div>

          <button
            type="button"
            title="Volver"
            aria-label="Volver"
            onClick={onCancel}
            className="inline-flex h-10 min-w-120px items-center justify-center gap-2 rounded-xl border border-white/8 bg-[#141414] px-5 text-sm text-white/70 transition-colors hover:border-[#112A43] hover:bg-[#112A43] hover:text-white cursor-pointer"
          >
            <ArrowLeft className="size-4" />
            Volver
          </button>
        </div>

        <form
          onSubmit={(event) => {
            event.preventDefault()
            submit({
              draftVariants,
              draftSpecifications,
              onDraftSaved: () => {
                setDraftVariants([])
                setDraftSpecifications([])
              },
            })
          }}
          className="admin-product-form rounded-3xl border border-white/8 bg-[#0d0d0d] p-3 shadow-2xl shadow-black/30 sm:p-4"
        >
          <div className="grid gap-4 xl:grid-cols-2 xl:items-start 2xl:grid-cols-12">
            <section className="admin-product-section space-y-3 rounded-2xl border border-white/7 bg-[#141414] p-4 2xl:col-span-4">
              <div className="border-b border-white/7 pb-3">
                <p className="text-10px font-semibold uppercase tracking-[0.18em] text-beyonix-cyan/75">
                  Información general
                </p>
              </div>
              <div>
                <label htmlFor="video_url" className={labelCls}>
                  Video del producto
                </label>
                <input
                  id="video_url"
                  type="url"
                  title="Video del producto"
                  value={form.video_url}
                  placeholder="https://..."
                  onChange={(event) => setField("video_url", event.target.value)}
                  className={inputCls}
                />
                <p className="mt-2 text-xs leading-5 text-white/45">
                  Opcional. Pegá un enlace externo al video.
                </p>

                {canPreviewVideo ? (
                  <div className="mt-3 overflow-hidden rounded-xl border border-white/8 bg-black">
                    <div className="relative aspect-video w-full">
                      {videoSource.kind === "direct" ? (
                        <video
                          controls
                          preload="metadata"
                          src={videoSource.videoUrl}
                          className="size-full bg-black object-contain"
                        />
                      ) : (
                        <iframe
                          title="Previsualización del video del producto"
                          src={videoSource.embedUrl}
                          loading="lazy"
                          allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                          allowFullScreen
                          referrerPolicy="strict-origin-when-cross-origin"
                          className="size-full"
                        />
                      )}
                    </div>
                  </div>
                ) : form.video_url.trim() ? (
                  <div className="mt-3 flex items-center gap-2 rounded-xl border border-white/8 bg-[#181818] px-3 py-2 text-xs text-white/55">
                    <Play className="size-3.5 text-beyonix-cyan" />
                    La URL es HTTPS, pero no corresponde a un proveedor o archivo compatible.
                  </div>
                ) : null}
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <div>
                  <label htmlFor="nombre" className={labelCls}>
                    Nombre *
                  </label>
                  <input
                    id="nombre"
                    type="text"
                    title="Nombre"
                    value={form.nombre}
                    placeholder="Auriculares..."
                    onChange={(event) => handleNombreChange(event.target.value)}
                    className={inputCls}
                  />
                </div>

                <div>
                  <label htmlFor="slug" className={labelCls}>
                    Slug
                  </label>
                  <input
                    id="slug"
                    type="text"
                    title="Slug"
                    value={form.slug}
                    placeholder="auriculares..."
                    onChange={(event) => setField("slug", event.target.value)}
                    className={inputCls}
                  />
                </div>
              </div>

              <div>
                <label htmlFor="descripcion" className={labelCls}>
                  Descripción
                </label>
                <textarea
                  id="descripcion"
                  title="Descripción"
                  value={form.descripcion}
                  placeholder="Descripción del producto..."
                  onChange={(event) => setField("descripcion", event.target.value)}
                  className={`${inputCls} min-h-88px resize-none py-3 leading-5`}
                />
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <div>
                  <label htmlFor="precio" className={labelCls}>
                    Precio
                  </label>
                  <input
                    min="0"
                    type="number"
                    id="precio"
                    title="Precio"
                    placeholder="0"
                    value={form.precio}
                    onChange={(event) => setField("precio", event.target.value)}
                    className={inputCls}
                  />
                </div>

                <div>
                  <label htmlFor="precio_anterior" className={labelCls}>
                    Precio anterior
                  </label>
                  <input
                    min="0"
                    type="number"
                    id="precio_anterior"
                    title="Precio anterior"
                    placeholder="0"
                    value={form.precio_anterior}
                    onChange={(event) =>
                      setField("precio_anterior", event.target.value)
                    }
                    className={inputCls}
                  />
                </div>
              </div>

              <div>
                <label htmlFor="cuotas" className={labelCls}>
                  Cuotas sin interés
                </label>
                <AdminSelect
                  title="Cuotas sin interés"
                  value={form.cuotas}
                  onChange={(value) => setField("cuotas", value)}
                >
                  <option value="sin_cuotas">Sin cuotas</option>
                  <option value="3">3 cuotas sin interés</option>
                  <option value="6">6 cuotas sin interés</option>
                </AdminSelect>
              </div>

              <div>
                <label htmlFor="categoria" className={labelCls}>
                  Categoría
                </label>
                <AdminSelect
                  title="Categoría"
                  value={form.categoria_id}
                  onChange={(value) => setField("categoria_id", value)}
                >
                  <option value="">Sin categoría</option>
                  {categorias.map((cat) => (
                    <option key={cat.id} value={cat.id}>
                      {cat.nombre}
                    </option>
                  ))}
                </AdminSelect>
              </div>

              <div className="grid gap-2 sm:grid-cols-2">
                {[
                  {
                    key: "destacado" as const,
                    label: "Producto destacado",
                    active: form.destacado,
                    color: "text-beyonix-cyan",
                  },
                  {
                    key: "activo" as const,
                    label: form.activo ? "Producto activo" : "Producto inactivo",
                    active: form.activo,
                    color: "text-green-400",
                  },
                ].map((toggle) => (
                  <button
                    key={toggle.key}
                    type="button"
                    title={toggle.label}
                    aria-label={toggle.label}
                    onClick={() => setField(toggle.key, !toggle.active)}
                    className="flex min-h-10 items-center gap-3 rounded-xl border border-white/8 bg-[#181818] px-3.5 text-left transition-colors hover:border-[#112A43] hover:bg-[#112A43] cursor-pointer"
                  >
                    {toggle.active ? (
                      <ToggleRight className={`size-6 ${toggle.color}`} />
                    ) : (
                      <ToggleLeft className="size-6 text-white/45" />
                    )}
                    <span className="text-sm text-white/80">{toggle.label}</span>
                  </button>
                ))}
              </div>
            </section>

            <section className="admin-product-section rounded-2xl border border-white/7 bg-[#141414] p-4 2xl:col-span-4">
              <div>
                <label className={labelCls}>Variantes</label>
                <ProductVariantsEditor
                  productoId={currentProductoId || undefined}
                  draftVariants={draftVariants}
                  onDraftVariantsChange={setDraftVariants}
                />
              </div>
            </section>

            <section className="admin-product-section rounded-2xl border border-white/7 bg-[#141414] p-4 2xl:col-span-4">
              <div>
                <label className={labelCls}>Especificaciones</label>
                <ProductSpecificationsEditor
                  productoId={currentProductoId || undefined}
                  draftSpecifications={draftSpecifications}
                  onDraftSpecificationsChange={setDraftSpecifications}
                />
              </div>
            </section>
          </div>

          <div className="mt-4 space-y-3">
            {error && (
              <div className="rounded-2xl border border-red-500/20 bg-red-500/8 px-4 py-3">
                <p className="text-sm text-red-400">{error}</p>
              </div>
            )}

            {success && (
              <div className="rounded-2xl border border-green-500/20 bg-green-500/8 px-4 py-3">
                <p className="text-sm text-green-300">{success}</p>
              </div>
            )}

            <div className="flex flex-col gap-3 border-t border-white/7 pt-4 sm:flex-row sm:justify-end">
              <button
                type="submit"
                disabled={saving}
                title="Guardar producto"
                aria-label="Guardar producto"
                className={`flex h-10 w-full items-center justify-center rounded-xl border border-white bg-white px-7 text-sm font-semibold text-black transition-all disabled:opacity-50 cursor-pointer sm:w-auto sm:min-w-180px ${submitButtonStateClass}`}
              >
                {saving ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : producto ? (
                  "Guardar cambios"
                ) : savedId ? (
                  "Finalizar producto"
                ) : (
                  "Crear producto"
                )}
              </button>

              <button
                type="button"
                title="Cancelar"
                aria-label="Cancelar"
                onClick={onCancel}
                className="h-11 w-full rounded-xl border border-white/10 bg-[#141414] px-6 text-sm text-white/70 transition-colors hover:border-[#112A43] hover:bg-[#112A43] hover:text-white cursor-pointer sm:w-auto sm:min-w-140px"
              >
                Cancelar
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  )
}
