"use client"

import { useEffect, useRef, useState } from "react"
import {
  ArrowLeft,
  Eye,
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
  AdminCard,
  AdminFormField,
  AdminInfoBlock,
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
import { updateProductoVariante } from "@/lib/supabase/queries/producto-variantes"

interface ProductoFormProps {
  producto?: SupabaseProducto | null
  onSaved: () => void
  onCancel: () => void
}

const inputCls =
  `${adminControlClassName} text-base`

const productFieldLabelClassName =
  "product-editor-field-label text-xs normal-case tracking-normal text-white/68"

const productPriceFormatter = new Intl.NumberFormat("es-AR", {
  maximumFractionDigits: 2,
  minimumFractionDigits: 0,
})

export function ProductoForm({
  producto,
  onSaved,
  onCancel,
}: ProductoFormProps) {
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
  const [primarySkuError, setPrimarySkuError] = useState("")
  const [savingPrimarySku, setSavingPrimarySku] = useState(false)
  const previewObjectUrls = useRef<string[]>([])
  const leaveEditor = onCancel
  const finishProductSave = onSaved

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
    onSaved: finishProductSave,
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
  const selectedCategoryName =
    categorias.find((category) => String(category.id) === form.categoria_id)
      ?.nombre ?? "Sin categoría"
  const numericPrice = Number(form.precio)
  const formattedPrice =
    form.precio.trim() && Number.isFinite(numericPrice)
      ? `$ ${productPriceFormatter.format(numericPrice)}`
      : "Precio pendiente"

  const primaryVariant = [...persistedVariants].sort(
    (left, right) => left.orden - right.orden || left.id - right.id,
  )[0]
  const busy = saving || savingPrimarySku

  const saveProduct = async () => {
    setPrimarySkuError("")

    if (
      currentProductoId &&
      primaryVariant &&
      (primaryVariant.sku?.trim() || "") !== form.sku.trim()
    ) {
      try {
        setSavingPrimarySku(true)
        const updated = await updateProductoVariante(
          currentProductoId,
          primaryVariant.id,
          { sku: form.sku.trim() || null },
        )
        setPersistedVariants((current) =>
          current.map((variant) =>
            variant.id === updated.id ? updated : variant,
          ),
        )
      } catch (skuError) {
        setPrimarySkuError(
          skuError instanceof Error
            ? skuError.message
            : "No se pudo guardar el SKU principal.",
        )
        return
      } finally {
        setSavingPrimarySku(false)
      }
    }

    await submit({
      draftVariants,
      draftSpecifications,
      onDraftSaved: () => {
        setDraftVariants([])
        setDraftSpecifications([])
      },
    })
  }

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
      sku: form.sku.trim() || null,
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
    <div className={`${adminPageClassName} product-editor-screen !space-y-3 !p-3 sm:!p-4 lg:!p-5`}>
      <header className="product-editor-header flex min-w-0 items-center gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <AdminSecondaryButton
            size="icon"
            title="Volver a productos"
            aria-label="Volver a productos"
            onClick={leaveEditor}
          >
            <ArrowLeft className="size-4 text-white" />
          </AdminSecondaryButton>
          <div className="min-w-0">
            <p className="text-10px font-bold text-white/48 sm:text-xs">
              {producto ? "Editar producto" : "Crear producto"}
            </p>
            <h1 className="truncate text-xl font-black text-white sm:text-2xl">
              {form.nombre.trim() || "Producto sin nombre"}
            </h1>
            <p className="mt-0.5 truncate text-10px text-white/50 sm:text-xs">
              {selectedCategoryName} · {formattedPrice}
            </p>
          </div>
        </div>
      </header>

      <form
        onSubmit={(event) => {
          event.preventDefault()
          void saveProduct()
        }}
        className="product-editor-form min-w-0 space-y-3"
      >
        <div className="product-editor-workspace grid min-w-0 items-start gap-3 xl:grid-cols-[minmax(30rem,0.78fr)_minmax(0,1.22fr)]">
          <section aria-labelledby="product-information-title" className="min-w-0 space-y-3">
            <AdminCard className="product-editor-panel space-y-4 p-4">
              <div className="product-editor-panel-heading">
                <h2 id="product-information-title" className="text-base font-black text-white">
                  Información del producto
                </h2>
              </div>

              <div className="grid min-w-0 gap-x-3 gap-y-3 sm:grid-cols-2">
                <AdminFormField label="Nombre del producto" labelClassName={productFieldLabelClassName}>
                  <input
                    id="nombre"
                    type="text"
                    value={form.nombre}
                    placeholder="Ej.: Apoyabrazos de escritorio"
                    onChange={(event) => handleNombreChange(event.target.value)}
                    className={inputCls}
                  />
                </AdminFormField>

                <AdminFormField
                  label="SKU principal"
                  labelClassName={productFieldLabelClassName}
                >
                  <input
                    id="sku"
                    type="text"
                    maxLength={120}
                    value={form.sku}
                    placeholder="Ej.: AP-001"
                    onChange={(event) => setField("sku", event.target.value)}
                    className={inputCls}
                  />
                </AdminFormField>

                <AdminFormField label="Precio actual" labelClassName={productFieldLabelClassName}>
                  <span className="relative block">
                    <span className="pointer-events-none absolute left-3 top-1/2 z-10 -translate-y-1/2 text-sm font-black text-white/60">$</span>
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

                <AdminFormField label="Precio anterior" labelClassName={productFieldLabelClassName}>
                  <span className="relative block">
                    <span className="pointer-events-none absolute left-3 top-1/2 z-10 -translate-y-1/2 text-sm font-black text-white/60">$</span>
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

                <AdminFormField label="Categoría" labelClassName={productFieldLabelClassName}>
                  <AdminSelect title="Categoría" value={form.categoria_id} onChange={(value) => setField("categoria_id", value)}>
                    <option value="">Sin categoría</option>
                    {categorias.map((category) => (
                      <option key={category.id} value={category.id}>{category.nombre}</option>
                    ))}
                  </AdminSelect>
                </AdminFormField>

                <AdminFormField label="Cuotas sin interés" labelClassName={productFieldLabelClassName}>
                  <AdminSelect title="Cuotas sin interés" value={form.cuotas} onChange={(value) => setField("cuotas", value)}>
                    <option value="sin_cuotas">No ofrecer cuotas</option>
                    <option value="3">3 cuotas sin interés</option>
                    <option value="6">6 cuotas sin interés</option>
                  </AdminSelect>
                </AdminFormField>
              </div>
            </AdminCard>

            <AdminCard className="product-editor-panel space-y-3 p-4">
              <div className="product-editor-panel-heading">
                <h2 className="text-base font-black text-white">Contenido</h2>
              </div>
              <AdminFormField label="URL del video" help="Opcional · YouTube, Vimeo o archivo HTTPS." labelClassName={productFieldLabelClassName}>
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
                  <div className="relative aspect-video w-full sm:h-40 sm:aspect-auto">
                    {videoSource.kind === "direct" ? (
                      <video controls preload="metadata" src={videoSource.videoUrl} className="size-full bg-black object-contain" />
                    ) : (
                      <iframe
                        src={videoSource.embedUrl}
                        title="Vista previa del video del producto"
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
                <AdminInfoBlock tone="neutral" icon={<Play className="size-4 text-white" />}>
                  La URL es HTTPS, pero no corresponde a un video compatible.
                </AdminInfoBlock>
              ) : null}

              <AdminFormField label="Descripción" labelClassName={productFieldLabelClassName}>
                <textarea
                  id="descripcion"
                  value={form.descripcion}
                  placeholder="Describí el producto y, si agregaste un video, su contenido."
                  onChange={(event) => setField("descripcion", event.target.value)}
                  className={`${inputCls} h-20 min-h-20 resize-y py-2.5 leading-5 sm:h-24 sm:min-h-24`}
                />
              </AdminFormField>
            </AdminCard>

            <div className="grid min-w-0 gap-3 2xl:grid-cols-[minmax(15rem,0.78fr)_minmax(0,1.22fr)]">
            <AdminCard className="product-editor-panel space-y-3 p-4">
              <div className="product-editor-panel-heading">
                <h2 className="text-base font-black text-white">Estado comercial</h2>
              </div>
              <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-1">
                {[
                  {
                    key: "activo" as const,
                    label: form.activo ? "Producto activo" : "Producto inactivo",
                    description: "Disponible para ver y comprar.",
                    active: form.activo,
                  },
                  {
                    key: "destacado" as const,
                    label: form.destacado ? "Producto destacado" : "Producto no destacado",
                    description: "Visible en espacios promocionales.",
                    active: form.destacado,
                  },
                ].map((toggle) => (
                  <AdminSecondaryButton
                    key={toggle.key}
                    title={toggle.label}
                    aria-label={toggle.label}
                    aria-pressed={toggle.active}
                    onClick={() => setField(toggle.key, !toggle.active)}
                    className={`product-editor-toggle min-h-11 w-full justify-start border px-3 py-2 text-left ${toggle.active ? "border-white/20 bg-white/6" : "border-white/8 bg-transparent"}`}
                  >
                    {toggle.active ? <ToggleRight className="size-5 shrink-0 text-white" /> : <ToggleLeft className="size-5 shrink-0 text-white" />}
                    <span className="min-w-0">
                      <span className="block text-xs font-black text-white/82">{toggle.label}</span>
                      <span className="mt-0.5 block text-10px font-medium leading-4 text-white/46">{toggle.description}</span>
                    </span>
                  </AdminSecondaryButton>
                ))}
              </div>
            </AdminCard>

            <AdminCard className="product-editor-panel space-y-3 p-4">
              <div className="product-editor-panel-heading">
                <h2 className="text-base font-black text-white">Dimensiones y peso</h2>
                <p className="mt-0.5 text-10px leading-4 text-white/44">Andreani utiliza estos datos para calcular el costo del paquete.</p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                {PRODUCT_LOGISTICS_FIELDS.map(({ key, unit }) => {
                  const label = {
                    peso_empaquetado_kg: "Peso",
                    alto_paquete_cm: "Profundidad",
                    ancho_paquete_cm: "Ancho",
                    largo_paquete_cm: "Largo",
                  }[key]

                  return (
                    <AdminFormField key={key} label={label} labelClassName={productFieldLabelClassName}>
                      <span className="relative block">
                        <input
                          id={key}
                          type="text"
                          inputMode="decimal"
                          value={form[key]}
                          placeholder="Opcional"
                          aria-label={`${label} en ${unit}`}
                          onChange={(event) => setField(key, normalizeLogisticsDecimalInput(event.target.value))}
                          className={`${inputCls} !pr-11`}
                        />
                        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs font-black text-white/50">{unit}</span>
                      </span>
                    </AdminFormField>
                  )
                })}
              </div>
            </AdminCard>
            </div>
          </section>

          <main className="min-w-0 space-y-4">
            <ProductVariantsEditor
              productoId={currentProductoId || undefined}
              productActive={producto?.activo === true}
              primarySku={form.sku}
              videoUrl={form.video_url}
              onPrimarySkuChange={(value) => setField("sku", value)}
              fallbackImage={productFallbackImage}
              draftVariants={draftVariants}
              onDraftVariantsChange={setDraftVariants}
              onPersistedVariantsChange={setPersistedVariants}
            />
            <ProductSpecificationsEditor
              productoId={currentProductoId || undefined}
              draftSpecifications={draftSpecifications}
              onDraftSpecificationsChange={setDraftSpecifications}
              onPersistedSpecificationsChange={setPersistedSpecifications}
            />
          </main>
        </div>

        {(error || primarySkuError || success) && (
          <div aria-live="polite" className="space-y-2">
            {error && <AdminInfoBlock tone="danger">{error}</AdminInfoBlock>}
            {primarySkuError && <AdminInfoBlock tone="danger">{primarySkuError}</AdminInfoBlock>}
            {success && <AdminInfoBlock tone="success">{success}</AdminInfoBlock>}
          </div>
        )}

        <div className="product-editor-actions flex flex-col-reverse gap-2 rounded-xl border p-2 sm:flex-row sm:items-center sm:justify-end">
            <AdminSecondaryButton
              title="Cancelar"
              aria-label="Cancelar"
              onClick={leaveEditor}
              className="w-full sm:w-auto"
            >
              Cancelar
            </AdminSecondaryButton>
            <AdminSecondaryButton
              title="Vista previa del producto"
              aria-label="Vista previa del producto"
              onClick={openProductPreview}
              disabled={busy}
              className="w-full sm:w-auto"
            >
              <Eye className="size-4 text-white" />
              Vista previa
            </AdminSecondaryButton>
            <AdminPrimaryButton
              type="submit"
              disabled={busy}
              title="Guardar producto"
              aria-label="Guardar producto"
              className="w-full sm:min-w-40 sm:w-auto"
            >
              {busy ? (
                <Loader2 className="size-4 animate-spin text-white" />
              ) : producto ? (
                "Guardar cambios"
              ) : savedId ? (
                "Finalizar producto"
              ) : (
                "Crear producto"
              )}
            </AdminPrimaryButton>
        </div>
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
