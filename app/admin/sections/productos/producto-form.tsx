"use client"

import { useEffect, useRef, useState } from "react"
import {
  ArrowLeft,
  Boxes,
  Eye,
  Info,
  ListChecks,
  Loader2,
  Play,
  ToggleLeft,
  ToggleRight,
} from "lucide-react"

import type {
  SupabaseProducto,
  SupabaseProductoEspecificacion,
  SupabaseProductoVariante,
} from "@/lib/supabase/types"

import type {
  DraftProductoEspecificacion,
  DraftProductoVariante,
} from "./types"
import { ProductSpecificationsEditor } from "./product-specifications-editor"
import { ProductVariantsEditor } from "./product-variants-editor"
import { AdminProductPreviewModal } from "./admin-product-preview-modal"
import { useProductoForm } from "./use-producto-form"
import {
  adminControlClassName,
  adminPageClassName,
  AdminInfoBlock,
  AdminPageHeader,
  AdminPrimaryButton,
  AdminSecondaryButton,
  AdminSelect,
} from "../../components/admin-controls"
import { getProductVideoSource } from "@/lib/products/product-video"

interface ProductoFormProps {
  producto?: SupabaseProducto | null
  onSaved: () => void
  onCancel: () => void
}

const inputCls =
  adminControlClassName

const labelCls =
  "mb-1.5 block text-10px font-semibold uppercase tracking-widest text-white/50"

export function ProductoForm({ producto, onSaved, onCancel }: ProductoFormProps) {
  const [draftVariants, setDraftVariants] = useState<DraftProductoVariante[]>([])
  const [
    draftSpecifications,
    setDraftSpecifications,
  ] = useState<DraftProductoEspecificacion[]>([])
  const [persistedVariants, setPersistedVariants] = useState<
    SupabaseProductoVariante[]
  >(producto?.producto_variantes ?? [])
  const [persistedSpecifications, setPersistedSpecifications] = useState<
    SupabaseProductoEspecificacion[]
  >(producto?.producto_especificaciones ?? [])
  const [previewProduct, setPreviewProduct] =
    useState<SupabaseProducto | null>(null)
  const previewObjectUrls = useRef<string[]>([])

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

  const releasePreviewObjectUrls = () => {
    previewObjectUrls.current.forEach((url) => URL.revokeObjectURL(url))
    previewObjectUrls.current = []
  }

  useEffect(
    () => () => {
      previewObjectUrls.current.forEach((url) => URL.revokeObjectURL(url))
    },
    [],
  )

  const openProductPreview = () => {
    releasePreviewObjectUrls()

    const now = new Date().toISOString()
    const previewId = producto?.id ?? 2_000_000_000
    const price = Number(form.precio)
    const previousPrice = form.precio_anterior
      ? Number(form.precio_anterior)
      : null
    const safePrice = Number.isFinite(price) ? Math.max(0, price) : 0
    const safePreviousPrice =
      previousPrice != null && Number.isFinite(previousPrice)
        ? Math.max(0, previousPrice)
        : null
    const selectedCategory = categorias.find(
      (category) => String(category.id) === form.categoria_id,
    )

    const previewVariants: SupabaseProductoVariante[] = currentProductoId
      ? persistedVariants
      : draftVariants.map((variant, index) => {
          const images = variant.imagenes.map((file) => {
            const url = URL.createObjectURL(file)
            previewObjectUrls.current.push(url)
            return url
          })

          return {
            id: 2_000_000_000 + index + 1,
            producto_id: previewId,
            nombre: variant.nombre.trim() || `Variante ${index + 1}`,
            sku: variant.sku.trim() || null,
            color_hex: variant.color_hex || "#000000",
            stock: 0,
            imagenes: images,
            activo: true,
            orden: index + 1,
            created_at: now,
          }
        })

    const previewSpecifications: SupabaseProductoEspecificacion[] =
      currentProductoId
        ? persistedSpecifications
        : draftSpecifications.map((specification, index) => ({
            id: 2_000_000_000 + index + 1,
            producto_id: previewId,
            icono: specification.icono,
            texto: specification.texto,
            orden: specification.orden,
            activo: specification.activo,
            created_at: now,
          }))
    const principalImage =
      [...previewVariants]
        .sort((a, b) => a.orden - b.orden)
        .flatMap((variant) => variant.imagenes ?? [])[0] ??
      producto?.imagen_principal ??
      null
    const stock = producto?.stock ?? 0

    setPreviewProduct({
      ...(producto ?? {
        id: previewId,
        created_at: now,
      }),
      id: previewId,
      nombre: form.nombre.trim() || "Producto sin nombre",
      slug: form.slug.trim() || "producto-sin-nombre",
      descripcion: form.descripcion.trim() || null,
      video_url: form.video_url.trim() || null,
      precio: safePrice,
      precio_anterior: safePreviousPrice,
      descuento:
        safePreviousPrice && safePreviousPrice > safePrice
          ? Math.round(
              ((safePreviousPrice - safePrice) / safePreviousPrice) * 100,
            )
          : null,
      cuotas_sin_interes: form.cuotas !== "sin_cuotas",
      cuotas_maximas:
        form.cuotas === "3" ? 3 : form.cuotas === "6" ? 6 : null,
      stock,
      categoria_id: form.categoria_id ? Number(form.categoria_id) : null,
      destacado: form.destacado,
      activo: form.activo,
      imagen_principal: principalImage,
      categorias: selectedCategory ?? null,
      producto_variantes: previewVariants,
      producto_especificaciones: previewSpecifications,
    })
  }

  const closeProductPreview = () => {
    setPreviewProduct(null)
    releasePreviewObjectUrls()
  }

  return (
    <div className={`${adminPageClassName} admin-product-page`}>
      <div className="w-full">
        <AdminPageHeader
          className="admin-product-header"
          eyebrow="Productos"
          title={producto ? "Editar producto" : "Nuevo producto"}
          actions={
            <AdminSecondaryButton
              title="Volver"
              aria-label="Volver"
              onClick={onCancel}
              className="min-w-120px"
            >
              <ArrowLeft className="size-4" />
              Volver
            </AdminSecondaryButton>
          }
        />

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
          className="admin-product-form admin-ds-surface mt-3 min-w-0 overflow-hidden p-2.5 sm:p-3"
        >
          <div className="grid min-w-0 items-start gap-3 xl:grid-cols-2 2xl:grid-cols-[minmax(320px,0.92fr)_minmax(470px,1.25fr)_minmax(300px,0.82fr)]">
            <section className="admin-product-section admin-product-section-info admin-ds-card min-w-0 space-y-2.5 overflow-hidden border-t-2 border-t-sky-400/55 p-3.5">
              <div className="flex items-center gap-2 border-b border-white/7 pb-2.5">
                <span className="flex size-7 items-center justify-center rounded-lg border border-sky-400/20 bg-sky-400/10 text-sky-300">
                  <Info className="size-3.5" />
                </span>
                <div>
                  <p className="text-10px font-semibold uppercase tracking-widest text-sky-300/85">
                    Información general
                  </p>
                  <p className="text-10px text-white/35">Datos comerciales y visibilidad</p>
                </div>
              </div>
              <div>
                <label htmlFor="video_url" className={labelCls}>
                  Video del producto
                </label>
                <input
                  id="video_url"
                  type="url"
                  value={form.video_url}
                  placeholder="https://..."
                  onChange={(event) => setField("video_url", event.target.value)}
                  className={inputCls}
                />
                <p className="mt-1 text-11px leading-4 text-white/40">
                  Opcional · YouTube, Vimeo o archivo HTTPS.
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
                  <div className="admin-ds-card mt-3 flex items-center gap-2 px-3 py-2 text-xs text-white/55">
                    <Play className="size-3.5 text-beyonix-cyan" />
                    La URL es HTTPS, pero no corresponde a un proveedor o archivo compatible.
                  </div>
                ) : null}
              </div>

              <div className="min-w-0">
                <label htmlFor="nombre" className={labelCls}>
                  Nombre *
                </label>
                <input
                  id="nombre"
                  type="text"
                  value={form.nombre}
                  placeholder="Auriculares..."
                  onChange={(event) => handleNombreChange(event.target.value)}
                  className={inputCls}
                />
              </div>

              <div>
                <label htmlFor="descripcion" className={labelCls}>
                  Descripción
                </label>
                <textarea
                  id="descripcion"
                  value={form.descripcion}
                  placeholder="Descripción del producto..."
                  onChange={(event) => setField("descripcion", event.target.value)}
                  className={`${inputCls} min-h-60px resize-none py-2.5 leading-5`}
                />
              </div>

              <div className="grid min-w-0 gap-2.5 sm:grid-cols-2">
                <div>
                  <label htmlFor="precio" className={labelCls}>
                    Precio
                  </label>
                  <div className="relative">
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute left-3.5 top-1/2 z-10 -translate-y-1/2 text-sm font-black text-emerald-300"
                    >
                      $
                    </span>
                    <input
                      min="0"
                      type="number"
                      id="precio"
                      placeholder="0"
                      value={form.precio}
                      onChange={(event) => setField("precio", event.target.value)}
                      className={`${inputCls} !pl-8 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none`}
                    />
                  </div>
                </div>

                <div>
                  <label htmlFor="precio_anterior" className={labelCls}>
                    Precio anterior
                  </label>
                  <div className="relative">
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute left-3.5 top-1/2 z-10 -translate-y-1/2 text-sm font-black text-emerald-300"
                    >
                      $
                    </span>
                    <input
                      min="0"
                      type="number"
                      id="precio_anterior"
                      placeholder="0"
                      value={form.precio_anterior}
                      onChange={(event) =>
                        setField("precio_anterior", event.target.value)
                      }
                      className={`${inputCls} !pl-8 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none`}
                    />
                  </div>
                </div>
              </div>

              <div className="grid min-w-0 gap-2.5 sm:grid-cols-2">
                <div className="min-w-0">
                  <label htmlFor="cuotas" className={labelCls}>
                    Cuotas
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

                <div className="min-w-0">
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
                    aria-label={toggle.label}
                    onClick={() => setField(toggle.key, !toggle.active)}
                    className={`admin-ds-button flex min-h-10 min-w-0 items-center gap-2.5 border px-3 text-left ${
                      toggle.key === "activo"
                        ? "border-emerald-400/20 bg-emerald-400/8"
                        : "border-sky-400/20 bg-sky-400/8"
                    }`}
                  >
                    {toggle.active ? (
                      <ToggleRight className={`size-6 ${toggle.color}`} />
                    ) : (
                      <ToggleLeft className="size-6 text-white/45" />
                    )}
                    <span className="min-w-0 truncate text-xs font-bold text-white/80">
                      {toggle.label}
                    </span>
                  </button>
                ))}
              </div>
            </section>

            <section className="admin-product-section admin-product-section-variants admin-ds-card min-w-0 overflow-hidden border-t-2 border-t-cyan-400/55 p-3.5">
              <div className="min-w-0">
                <div className="mb-3 flex items-center gap-2 border-b border-white/7 pb-2.5">
                  <span className="flex size-7 items-center justify-center rounded-lg border border-cyan-400/20 bg-cyan-400/10 text-cyan-300">
                    <Boxes className="size-3.5" />
                  </span>
                  <div>
                    <p className="text-10px font-semibold uppercase tracking-widest text-cyan-300/85">
                      Variantes
                    </p>
                    <p className="text-10px text-white/35">Color, SKU, stock e imágenes</p>
                  </div>
                </div>
                <ProductVariantsEditor
                  productoId={currentProductoId || undefined}
                  draftVariants={draftVariants}
                  onDraftVariantsChange={setDraftVariants}
                  onPersistedVariantsChange={setPersistedVariants}
                />
              </div>
            </section>

            <section className="admin-product-section admin-product-section-specs admin-ds-card min-w-0 overflow-visible border-t-2 border-t-blue-400/55 p-3.5 xl:col-span-2 2xl:col-span-1">
              <div className="min-w-0">
                <div className="mb-3 flex items-center gap-2 border-b border-white/7 pb-2.5">
                  <span className="flex size-7 items-center justify-center rounded-lg border border-blue-400/25 bg-blue-400/10 text-blue-200">
                    <ListChecks className="size-3.5" />
                  </span>
                  <div>
                    <p className="text-10px font-semibold uppercase tracking-widest text-blue-200/85">
                      Especificaciones
                    </p>
                    <p className="text-10px text-white/35">Características visibles del producto</p>
                  </div>
                </div>
                <ProductSpecificationsEditor
                  productoId={currentProductoId || undefined}
                  draftSpecifications={draftSpecifications}
                  onDraftSpecificationsChange={setDraftSpecifications}
                  onPersistedSpecificationsChange={setPersistedSpecifications}
                />
              </div>
            </section>
          </div>

          <div className="mt-3 space-y-2.5">
            {error && (
              <AdminInfoBlock tone="danger">{error}</AdminInfoBlock>
            )}

            {success && (
              <AdminInfoBlock tone="success">{success}</AdminInfoBlock>
            )}

            <div className="admin-product-actions -mx-2.5 -mb-2.5 flex flex-col gap-2 border-t border-white/8 bg-[#040a11]/95 px-3 py-2.5 backdrop-blur-xl sm:flex-row sm:items-center sm:justify-end">
              <AdminSecondaryButton
                title="Vista previa del producto"
                aria-label="Vista previa del producto"
                onClick={openProductPreview}
                disabled={saving}
                className="w-full border-sky-400/25 bg-sky-400/8 text-white sm:w-auto sm:min-w-150px"
              >
                <Eye className="size-4 text-beyonix-sky" />
                Vista previa
              </AdminSecondaryButton>

              <AdminPrimaryButton
                type="submit"
                disabled={saving}
                title="Guardar producto"
                aria-label="Guardar producto"
                className="w-full sm:w-auto sm:min-w-160px"
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
              </AdminPrimaryButton>

              <AdminSecondaryButton
                title="Cancelar"
                aria-label="Cancelar"
                onClick={onCancel}
                className="w-full sm:w-auto sm:min-w-120px"
              >
                Cancelar
              </AdminSecondaryButton>
            </div>
          </div>
        </form>
      </div>

      {previewProduct && (
        <AdminProductPreviewModal
          product={previewProduct}
          readOnly
          onClose={closeProductPreview}
        />
      )}
    </div>
  )
}
