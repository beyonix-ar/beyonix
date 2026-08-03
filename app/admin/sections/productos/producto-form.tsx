"use client"

import { useEffect, useRef, useState } from "react"
import {
  ArrowLeft,
  BadgeDollarSign,
  Boxes,
  ChevronDown,
  Eye,
  FileText,
  Info,
  ListChecks,
  Loader2,
  PackageCheck,
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
  AdminCard,
  AdminFormField,
  AdminInfoBlock,
  AdminPageHeader,
  AdminPrimaryButton,
  AdminSecondaryButton,
  AdminSelect,
} from "../../components/admin-controls"
import { getProductVideoSource } from "@/lib/products/product-video"
import { firstUsableImage } from "@/lib/products/admin-product-visuals"
import {
  normalizeLogisticsDecimalInput,
  PRODUCT_LOGISTICS_FIELDS,
} from "@/lib/shipping/logistics-validation"

interface ProductoFormProps {
  producto?: SupabaseProducto | null
  onSaved: () => void
  onCancel: () => void
}

const inputCls =
  `${adminControlClassName} text-base`

const productFieldLabelClassName =
  "text-sm normal-case tracking-normal text-white/68"

export function ProductoForm({ producto, onSaved, onCancel }: ProductoFormProps) {
  const [activeSection, setActiveSection] = useState<
    "information" | "variants" | "specifications"
  >(producto ? "variants" : "information")
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
  const productFallbackImage = firstUsableImage(
    producto?.imagen_principal,
    [...(producto?.imagenes_producto ?? [])]
      .sort((left, right) => left.orden - right.orden || left.id - right.id)
      .map((image) => image.url),
  )
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
            peso_empaquetado_kg: variant.peso_empaquetado_kg
              ? Number(variant.peso_empaquetado_kg.replace(",", "."))
              : null,
            alto_paquete_cm: variant.alto_paquete_cm
              ? Number(variant.alto_paquete_cm.replace(",", "."))
              : null,
            ancho_paquete_cm: variant.ancho_paquete_cm
              ? Number(variant.ancho_paquete_cm.replace(",", "."))
              : null,
            largo_paquete_cm: variant.largo_paquete_cm
              ? Number(variant.largo_paquete_cm.replace(",", "."))
              : null,
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
      peso_empaquetado_kg: form.peso_empaquetado_kg
        ? Number(form.peso_empaquetado_kg.replace(",", "."))
        : null,
      alto_paquete_cm: form.alto_paquete_cm
        ? Number(form.alto_paquete_cm.replace(",", "."))
        : null,
      ancho_paquete_cm: form.ancho_paquete_cm
        ? Number(form.ancho_paquete_cm.replace(",", "."))
        : null,
      largo_paquete_cm: form.largo_paquete_cm
        ? Number(form.largo_paquete_cm.replace(",", "."))
        : null,
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
      <AdminPageHeader
        className="admin-product-header"
        eyebrow="Productos"
        title={producto ? "Editar producto" : "Nuevo producto"}
        description="Administrá la publicación y sus opciones de venta desde un único lugar."
        actions={
          <AdminSecondaryButton
            title="Volver a productos"
            aria-label="Volver a productos"
            onClick={onCancel}
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
        className="admin-product-editor min-w-0 space-y-4"
      >
        <AdminCard className="flex flex-col gap-4 p-4 sm:p-5 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 items-start gap-3.5">
            <span className="flex size-12 shrink-0 items-center justify-center rounded-xl border border-beyonix-sky/25 bg-beyonix-blue/28 text-beyonix-cyan">
              <PackageCheck className="size-5.5" />
            </span>
            <div className="min-w-0">
              <p className="text-xs font-black uppercase tracking-[0.16em] text-beyonix-cyan">
                Ficha comercial
              </p>
              <h2 className="mt-1 truncate text-xl font-black text-white sm:text-2xl">
                {form.nombre.trim() || "Producto sin nombre"}
              </h2>
              <p className="mt-1 text-sm leading-5 text-white/54">
                {producto
                  ? "Administrá la publicación y sus opciones de venta."
                  : "Completá la información y agregá las opciones que vas a vender."}
              </p>
            </div>
          </div>
          <span
            className={`inline-flex w-fit shrink-0 items-center gap-2 rounded-full border px-3 py-1.5 text-sm font-black ${
              form.activo
                ? "border-emerald-400/25 bg-emerald-400/10 text-emerald-200"
                : "border-white/10 bg-white/4 text-white/58"
            }`}
          >
            <span className="size-1.5 rounded-full bg-current" />
            {form.activo ? "Producto activo" : "Producto inactivo"}
          </span>
        </AdminCard>

        <AdminCard className="custom-scrollbar min-w-0 overflow-x-auto p-2">
          <nav
            aria-label="Secciones del producto"
            className="admin-product-tabs grid min-w-[42rem] grid-cols-3 gap-2 overflow-x-auto"
          >
            {[
              {
                key: "variants" as const,
                title: "Variantes",
                description: `${currentProductoId ? persistedVariants.length : draftVariants.length} cargadas`,
                icon: Boxes,
              },
              {
                key: "information" as const,
                title: "Información",
                description: "Datos generales",
                icon: Info,
              },
              {
                key: "specifications" as const,
                title: "Especificaciones",
                description: "Características de venta",
                icon: ListChecks,
              },
            ].map((section) => {
              const Icon = section.icon
              const active = activeSection === section.key

              return (
                <button
                  key={section.key}
                  type="button"
                  aria-current={active ? "page" : undefined}
                  onClick={() => setActiveSection(section.key)}
                  className={`flex min-h-16 cursor-pointer items-center gap-3 rounded-xl border px-4 text-left transition ${
                    active
                      ? "border-beyonix-sky/45 bg-beyonix-blue/35 text-white shadow-[inset_0_0_0_1px_rgba(72,183,255,0.08)]"
                      : "border-transparent bg-transparent text-white/55 hover:border-white/8 hover:bg-white/3 hover:text-white/82"
                  }`}
                >
                  <span className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${active ? "bg-beyonix-sky/13 text-beyonix-cyan" : "bg-white/4 text-white/38"}`}>
                    <Icon className="size-4.5" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-base font-black">{section.title}</span>
                    <span className="mt-0.5 block text-xs font-medium text-white/43">
                      {section.description}
                    </span>
                  </span>
                </button>
              )
            })}
          </nav>
        </AdminCard>

        <div className="min-w-0">
          {activeSection === "variants" && (
            <ProductVariantsEditor
              productoId={currentProductoId || undefined}
              fallbackImage={productFallbackImage}
              draftVariants={draftVariants}
              onDraftVariantsChange={setDraftVariants}
              onPersistedVariantsChange={setPersistedVariants}
            />
          )}

          {activeSection === "information" && (
            <section aria-labelledby="product-general-information" className="min-w-0 space-y-4">
              <AdminCard className="space-y-5 p-4 sm:p-5">
                <div className="flex items-start gap-3">
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-beyonix-sky/20 bg-beyonix-sky/8 text-beyonix-cyan">
                    <Info className="size-4.5" />
                  </span>
                  <div>
                    <h2 id="product-general-information" className="text-lg font-black text-white">
                      Datos comerciales
                    </h2>
                    <p className="mt-0.5 text-sm leading-5 text-white/52">
                      Información principal que se muestra en la tienda.
                    </p>
                  </div>
                </div>

                <div className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,18rem),1fr))] gap-4">
                <AdminFormField label="Nombre del producto" labelClassName={productFieldLabelClassName}>
                  <input
                    id="nombre"
                    type="text"
                    value={form.nombre}
                    placeholder="Ej.: Auriculares inalámbricos"
                    onChange={(event) => handleNombreChange(event.target.value)}
                    className={inputCls}
                  />
                </AdminFormField>

                <AdminFormField label="Categoría" labelClassName={productFieldLabelClassName}>
                  <AdminSelect
                    title="Categoría"
                    value={form.categoria_id}
                    onChange={(value) => setField("categoria_id", value)}
                    triggerClassName="text-base"
                  >
                    <option value="">Sin categoría</option>
                    {categorias.map((category) => (
                      <option key={category.id} value={category.id}>
                        {category.nombre}
                      </option>
                    ))}
                  </AdminSelect>
                </AdminFormField>

                <AdminFormField label="Precio actual" labelClassName={productFieldLabelClassName}>
                  <span className="relative block">
                    <span className="pointer-events-none absolute left-3 top-1/2 z-10 -translate-y-1/2 text-sm font-black text-emerald-300">
                      $
                    </span>
                    <input
                      id="precio"
                      min="0"
                      type="number"
                      value={form.precio}
                      placeholder="0"
                      onChange={(event) => setField("precio", event.target.value)}
                      className={`${inputCls} admin-product-price-input !pl-8 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none`}
                    />
                  </span>
                </AdminFormField>

                <AdminFormField label="Precio anterior" help="Opcional. Se utiliza para mostrar una rebaja." labelClassName={productFieldLabelClassName}>
                  <span className="relative block">
                    <span className="pointer-events-none absolute left-3 top-1/2 z-10 -translate-y-1/2 text-sm font-black text-emerald-300">
                      $
                    </span>
                    <input
                      id="precio_anterior"
                      min="0"
                      type="number"
                      value={form.precio_anterior}
                      placeholder="0"
                      onChange={(event) => setField("precio_anterior", event.target.value)}
                      className={`${inputCls} admin-product-price-input !pl-8 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none`}
                    />
                  </span>
                </AdminFormField>

                <AdminFormField label="Cuotas" labelClassName={productFieldLabelClassName}>
                  <AdminSelect
                    title="Cuotas sin interés"
                    value={form.cuotas}
                    onChange={(value) => setField("cuotas", value)}
                    triggerClassName="text-base"
                  >
                    <option value="sin_cuotas">Sin cuotas</option>
                    <option value="3">3 cuotas sin interés</option>
                    <option value="6">6 cuotas sin interés</option>
                  </AdminSelect>
                </AdminFormField>
                </div>
              </AdminCard>

              <AdminCard className="space-y-5 p-4 sm:p-5">
                <div className="flex items-start gap-3">
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-violet-400/20 bg-violet-400/8 text-violet-300">
                    <FileText className="size-4.5" />
                  </span>
                  <div>
                    <h2 className="text-lg font-black text-white">Contenido de la publicación</h2>
                    <p className="mt-0.5 text-sm leading-5 text-white/52">Descripción y contenido audiovisual del producto.</p>
                  </div>
                </div>
                <div className="grid min-w-0 gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(20rem,0.65fr)]">
                  <AdminFormField label="Descripción" labelClassName={productFieldLabelClassName}>
                    <textarea
                      id="descripcion"
                      value={form.descripcion}
                      placeholder="Descripción clara y breve del producto"
                      onChange={(event) => setField("descripcion", event.target.value)}
                      className={`${inputCls} h-36 min-h-36 resize-y py-3 leading-6`}
                    />
                  </AdminFormField>
                  <div className="min-w-0 space-y-3">
                    <AdminFormField label="Video" help="Opcional · YouTube, Vimeo o archivo HTTPS." labelClassName={productFieldLabelClassName}>
                      <input
                        id="video_url"
                        type="url"
                        value={form.video_url}
                        placeholder="https://..."
                        onChange={(event) => setField("video_url", event.target.value)}
                        className={inputCls}
                      />
                    </AdminFormField>
                    {canPreviewVideo ? (
                      <div className="overflow-hidden rounded-xl border border-white/8 bg-black">
                        <div className="relative aspect-video w-full">
                          {videoSource.kind === "direct" ? (
                            <video controls preload="metadata" src={videoSource.videoUrl} className="size-full bg-black object-contain" />
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
                      <AdminInfoBlock tone="neutral" icon={<Play className="size-4" />}>
                        La URL es HTTPS, pero no corresponde a un video compatible.
                      </AdminInfoBlock>
                    ) : null}
                  </div>
                </div>
              </AdminCard>

              <AdminCard className="space-y-4 p-4 sm:p-5">
                <div className="flex items-start gap-3">
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-emerald-400/20 bg-emerald-400/8 text-emerald-300">
                    <BadgeDollarSign className="size-4.5" />
                  </span>
                  <div>
                    <h2 className="text-lg font-black text-white">Estado comercial</h2>
                    <p className="mt-0.5 text-sm leading-5 text-white/52">Controlá su visibilidad y promoción en la tienda.</p>
                  </div>
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  {[
                    {
                      key: "activo" as const,
                      label: form.activo ? "Producto activo" : "Producto inactivo",
                      description: "Define si puede verse y venderse en la tienda.",
                      active: form.activo,
                      color: "text-emerald-300",
                    },
                    {
                      key: "destacado" as const,
                      label: form.destacado ? "Producto destacado" : "Producto no destacado",
                      description: "Controla su presencia en espacios promocionales.",
                      active: form.destacado,
                      color: "text-beyonix-cyan",
                    },
                  ].map((toggle) => (
                    <AdminSecondaryButton
                      key={toggle.key}
                      title={toggle.label}
                      aria-label={toggle.label}
                      onClick={() => setField(toggle.key, !toggle.active)}
                      className={`min-h-20 w-full justify-start border px-4 text-left ${toggle.active ? "border-emerald-400/20 bg-emerald-400/7" : "border-white/8 bg-black/12"}`}
                    >
                      {toggle.active ? (
                        <ToggleRight className={`size-6 shrink-0 ${toggle.color}`} />
                      ) : (
                        <ToggleLeft className="size-6 shrink-0 text-white/38" />
                      )}
                      <span className="min-w-0">
                        <span className="block text-sm font-black text-white/82">{toggle.label}</span>
                        <span className="mt-1 block text-xs font-medium leading-5 text-white/46">{toggle.description}</span>
                      </span>
                    </AdminSecondaryButton>
                  ))}
                </div>
              </AdminCard>

              <details className="admin-ds-card group overflow-hidden">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-4 py-4 sm:px-5">
                    <span className="flex min-w-0 items-center gap-3">
                      <PackageCheck className="size-5 shrink-0 text-beyonix-sky" />
                      <span className="min-w-0">
                        <span className="block text-sm font-black text-white/78">Opciones avanzadas</span>
                        <span className="mt-0.5 block text-xs text-white/40">Peso y medidas del paquete para el envío.</span>
                      </span>
                    </span>
                    <ChevronDown className="size-4 shrink-0 text-white/42 transition-transform group-open:rotate-180" />
                  </summary>
                  <div className="border-t border-white/8 p-4 sm:p-5">
                    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                      {PRODUCT_LOGISTICS_FIELDS.map(({ key, label, unit }) => (
                        <AdminFormField key={key} label={label} labelClassName={productFieldLabelClassName}>
                          <span className="relative block">
                            <input
                              id={key}
                              type="text"
                              inputMode="decimal"
                              value={form[key]}
                              placeholder="Opcional"
                              aria-label={`${label} en ${unit}`}
                              onChange={(event) =>
                                setField(key, normalizeLogisticsDecimalInput(event.target.value))
                              }
                              className={`${inputCls} !pr-11`}
                            />
                            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs font-black text-cyan-200/65">
                              {unit}
                            </span>
                          </span>
                        </AdminFormField>
                      ))}
                    </div>
                  </div>
                </details>
            </section>
          )}

          {activeSection === "specifications" && (
            <AdminCard className="min-w-0 space-y-5 p-4 sm:p-5">
              <div className="flex items-start gap-3">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-amber-400/20 bg-amber-400/8 text-amber-300">
                  <ListChecks className="size-4.5" />
                </span>
                <div>
                  <h2 id="product-specifications" className="text-lg font-black text-white">Especificaciones</h2>
                  <p className="mt-0.5 text-sm leading-5 text-white/52">Características que ayudan al cliente a comparar y elegir el producto.</p>
                </div>
              </div>
              <ProductSpecificationsEditor
                productoId={currentProductoId || undefined}
                draftSpecifications={draftSpecifications}
                onDraftSpecificationsChange={setDraftSpecifications}
                onPersistedSpecificationsChange={setPersistedSpecifications}
              />
            </AdminCard>
          )}
        </div>

        {(error || success) && (
          <div className="space-y-2">
            {error && <AdminInfoBlock tone="danger">{error}</AdminInfoBlock>}
            {success && <AdminInfoBlock tone="success">{success}</AdminInfoBlock>}
          </div>
        )}

        <AdminCard className="admin-product-save-actions flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-end sm:p-4">
          <AdminSecondaryButton
            title="Vista previa del producto"
            aria-label="Vista previa del producto"
            onClick={openProductPreview}
            disabled={saving}
            className="w-full sm:w-auto"
          >
            <Eye className="size-4 text-beyonix-sky" />
            Vista previa
          </AdminSecondaryButton>
          <AdminPrimaryButton
            type="submit"
            disabled={saving}
            title="Guardar producto"
            aria-label="Guardar producto"
            className="w-full sm:w-auto"
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
            className="w-full sm:w-auto"
          >
            Cancelar
          </AdminSecondaryButton>
        </AdminCard>
      </form>

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
