"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  ArrowLeft,
  Check,
  Eye,
  Loader2,
  Play,
  ToggleLeft,
  ToggleRight,
  X,
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
import { getProductActivationStatus } from "@/lib/products/product-activation"
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
  "product-editor-field-label text-xs normal-case tracking-normal text-white/68"

const productPriceFormatter = new Intl.NumberFormat("es-AR", {
  style: "currency",
  currency: "ARS",
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
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
  const [persistedVariantAllocations, setPersistedVariantAllocations] = useState<
    Record<number, number>
  >({})
  const [pendingVariantStates, setPendingVariantStates] = useState<
    Record<number, boolean>
  >(() =>
    Object.fromEntries(
      (producto?.producto_variantes ?? []).map((variant) => [
        variant.id,
        variant.activo !== false,
      ]),
    ),
  )
  const [previewProduct, setPreviewProduct] =
    useState<SupabaseProducto | null>(null)
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
    showError,
    submit,
    handleNombreChange,
  } = useProductoForm({
    producto,
    onSaved: finishProductSave,
  })

  const currentProductoId = producto?.id || savedId
  const handlePersistedVariantsChange = useCallback(
    (variants: SupabaseProductoVariante[]) => {
      setPersistedVariants(variants)
      setPendingVariantStates((current) =>
        Object.fromEntries(
          variants.map((variant) => [
            variant.id,
            current[variant.id] ?? variant.activo !== false,
          ]),
        ),
      )
    },
    [],
  )
  const productFallbackImage = firstUsableImage(
    producto?.imagen_principal,
    [...(producto?.imagenes_producto ?? [])]
      .sort((left, right) => left.orden - right.orden || left.id - right.id)
      .map((image) => image.url),
  )
  const videoSource = getProductVideoSource(form.video_url)
  const canPreviewVideo =
    videoSource && videoSource.kind !== "unsupported"
  const selectedCategoryName = categorias.find(
    (category) => String(category.id) === form.categoria_id,
  )?.nombre
  const currentPrice = Number(form.precio)
  const productSubtitle = [
    selectedCategoryName,
    form.sku.trim() || null,
    form.precio.trim() && Number.isFinite(currentPrice)
      ? productPriceFormatter.format(currentPrice)
      : null,
    form.cuotas === "3"
      ? "3 cuotas sin interés"
      : form.cuotas === "6"
        ? "6 cuotas sin interés"
        : null,
  ].filter((item): item is string => Boolean(item))
  const activationStatus = useMemo(() => {
    const parseLogisticsValue = (value: string) => {
      if (!value.trim()) return null
      const parsed = Number(value.replace(",", "."))
      return Number.isFinite(parsed) ? parsed : null
    }
    const sourceVariants = currentProductoId
      ? persistedVariants.map((variant) => ({
          id: variant.id,
          orden: variant.orden,
          active: pendingVariantStates[variant.id] ?? variant.activo !== false,
          nombre: variant.nombre,
          sku: variant.sku ?? null,
          colorHex: variant.color_hex,
          images: variant.imagenes ?? [],
          assignedStock: persistedVariantAllocations[variant.id] ?? 0,
        }))
      : draftVariants.map((variant, index) => ({
          id: variant.tempId,
          orden: index + 1,
          active: false,
          nombre: variant.nombre,
          sku: index === 0 ? form.sku : variant.sku,
          colorHex: variant.color_hex,
          images: variant.imagenes,
          assignedStock: 0,
        }))
    const primaryVariant = [...sourceVariants].sort((left, right) => {
      if (left.orden !== right.orden) return left.orden - right.orden
      return typeof left.id === "number" && typeof right.id === "number"
        ? left.id - right.id
        : 0
    })[0]
    const variants = sourceVariants.map((variant) =>
      primaryVariant && variant.id === primaryVariant.id
        ? { ...variant, sku: form.sku }
        : variant,
    )

    return getProductActivationStatus({
      title: form.nombre,
      sku: form.sku,
      price: Number(form.precio),
      categoryId: form.categoria_id ? Number(form.categoria_id) : null,
      categoryExists: categorias.some(
        (category) => String(category.id) === form.categoria_id,
      ),
      description: form.descripcion,
      specifications: (currentProductoId
        ? persistedSpecifications
        : draftSpecifications
      ).map((specification) => ({
        activo: specification.activo,
        icono: specification.icono,
        texto: specification.texto,
      })),
      logistics: {
        weight: parseLogisticsValue(form.peso_empaquetado_kg),
        depth: parseLogisticsValue(form.alto_paquete_cm),
        width: parseLogisticsValue(form.ancho_paquete_cm),
        length: parseLogisticsValue(form.largo_paquete_cm),
      },
      variants,
    })
  }, [
    categorias,
    currentProductoId,
    draftSpecifications,
    draftVariants,
    form,
    persistedSpecifications,
    persistedVariantAllocations,
    persistedVariants,
    pendingVariantStates,
  ])
  const busy = saving

  const saveProduct = async () => {
    if (form.activo && !activationStatus.ready) {
      showError(activationStatus.firstError ?? "Revisá los requisitos para activar el producto.")
      return
    }

    await submit({
      draftVariants,
      draftSpecifications,
      primarySku: form.sku,
      variantStates: pendingVariantStates,
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
      ? persistedVariants.map((variant) => ({
          ...variant,
          activo:
            pendingVariantStates[variant.id] ?? variant.activo !== false,
        }))
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
            activo: false,
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
    <div className={`${adminPageClassName} product-editor-screen !space-y-2 !p-2.5 sm:!p-3 lg:!p-4`}>
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
            {productSubtitle.length > 0 && (
              <p className="mt-0.5 truncate text-10px text-white/50 sm:text-xs">
                {productSubtitle.join(" · ")}
              </p>
            )}
          </div>
        </div>
      </header>

      <form
        onSubmit={(event) => {
          event.preventDefault()
          void saveProduct()
        }}
        className="product-editor-form min-w-0 space-y-2"
      >
        <div className="product-editor-workspace min-w-0 items-start gap-2.5">
          <section
            aria-labelledby="product-information-title"
            className="product-editor-primary-column min-w-0 space-y-2"
          >
            <AdminCard className="product-editor-panel space-y-2 p-2.5">
              <div className="product-editor-panel-heading">
                <h2 id="product-information-title" className="text-base font-black text-white">
                  Información del producto
                </h2>
              </div>

              <div className="grid min-w-0 gap-x-2.5 gap-y-2 sm:grid-cols-2">
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

            <AdminCard className="product-editor-panel space-y-2 p-2.5">
              <div className="product-editor-panel-heading">
                <h2 className="text-base font-black text-white">Contenido</h2>
              </div>
              <AdminFormField label="URL del video" labelClassName={productFieldLabelClassName}>
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
                  <div className="relative aspect-video w-full sm:h-28 sm:aspect-auto">
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
                  className={`${inputCls} h-14 min-h-14 resize-y py-2 leading-5 sm:h-16 sm:min-h-16`}
                />
              </AdminFormField>
            </AdminCard>

            <AdminCard className="product-editor-panel space-y-2 p-2.5">
              <div className="product-editor-panel-heading">
                <h2 className="text-base font-black text-white">Estado comercial</h2>
              </div>
              <div className="grid gap-2">
                {[
                  {
                    key: "activo" as const,
                    label: "Estado",
                    value: form.activo ? "Activo" : "Inactivo",
                    description: "Define si el producto puede mostrarse y venderse.",
                    active: form.activo,
                  },
                  {
                    key: "destacado" as const,
                    label: "Destacado",
                    value: form.destacado ? "Sí" : "No",
                    description: "Visible en espacios promocionales.",
                    active: form.destacado,
                  },
                ].map((toggle) => (
                  <AdminSecondaryButton
                    key={toggle.key}
                    title={`${toggle.label}: ${toggle.value}`}
                    aria-label={`${toggle.label}: ${toggle.value}`}
                    aria-pressed={toggle.active}
                    onClick={() => {
                      if (toggle.key === "activo" && toggle.active) {
                        setPendingVariantStates(
                          Object.fromEntries(
                            persistedVariants.map((variant) => [
                              variant.id,
                              false,
                            ]),
                          ),
                        )
                      }

                      setField(toggle.key, !toggle.active)
                    }}
                    className={`product-editor-toggle grid min-h-11 w-full grid-cols-[auto_minmax(0,1fr)_4.5rem] items-center gap-x-2.5 border px-2.5 py-1.5 text-left ${toggle.active ? "product-editor-toggle-active border-emerald-400/25 bg-emerald-400/[0.07]" : "border-white/8 bg-transparent"}`}
                  >
                    {toggle.active ? (
                      <ToggleRight className="product-editor-toggle-icon size-5 shrink-0 text-emerald-300" />
                    ) : (
                      <ToggleLeft className="product-editor-inactive-icon size-5 shrink-0 text-white/42" />
                    )}
                    <span className="min-w-0 self-center">
                      <span className="block text-xs font-black text-white/82">{toggle.label}</span>
                      <span className="mt-0.5 block text-10px font-medium leading-4 text-white/46">{toggle.description}</span>
                    </span>
                    <span className={`w-full text-right text-xs font-black ${toggle.active ? "text-emerald-300" : "text-white/52"}`}>
                      {toggle.value}
                    </span>
                  </AdminSecondaryButton>
                ))}
              </div>
              {producto && form.activo !== producto.activo && (
                <p className="rounded-lg border border-amber-300/18 bg-amber-300/7 px-3 py-2 text-10px font-semibold leading-4 text-amber-100/80">
                  El cambio de estado está pendiente. Se aplicará al guardar el producto.
                </p>
              )}
              {!activationStatus.ready && (
                <div className="rounded-lg border border-white/8 bg-black/18 px-2.5 py-2">
                  <p className="text-10px font-black uppercase tracking-[0.12em] text-white/45">
                    Requisitos para activar
                  </p>
                  <div className="mt-1.5 grid grid-cols-2 gap-x-2 gap-y-1">
                    {activationStatus.requirements.map((requirement) => (
                      <span
                        key={requirement.key}
                        className={`flex min-w-0 items-center gap-1.5 text-10px font-semibold ${
                          requirement.complete ? "text-emerald-200/75" : "text-white/48"
                        }`}
                      >
                        {requirement.complete ? (
                          <Check className="size-3 shrink-0 text-emerald-300" aria-hidden="true" />
                        ) : (
                          <X className="size-3 shrink-0 text-rose-300/80" aria-hidden="true" />
                        )}
                        <span className="truncate">{requirement.label}</span>
                      </span>
                    ))}
                  </div>
                  {activationStatus.firstError && (
                    <p className="mt-1.5 text-10px font-semibold leading-4 text-amber-100/72">
                      {activationStatus.firstError}
                    </p>
                  )}
                </div>
              )}
            </AdminCard>

          </section>

          <main className="product-editor-inventory-column min-w-0">
            <ProductVariantsEditor
              productoId={currentProductoId || undefined}
              productActive={form.activo}
              primarySku={form.sku}
              videoUrl={form.video_url}
              onPrimarySkuChange={(value) => setField("sku", value)}
              fallbackImage={productFallbackImage}
              draftVariants={draftVariants}
              onDraftVariantsChange={setDraftVariants}
              persistedVariantStates={pendingVariantStates}
              onPersistedVariantStatesChange={setPendingVariantStates}
              onPersistedVariantsChange={handlePersistedVariantsChange}
              onVariantAllocationsChange={setPersistedVariantAllocations}
            />
          </main>

          <aside className="product-editor-specifications-column min-w-0 space-y-2">
            <ProductSpecificationsEditor
              productoId={currentProductoId || undefined}
              draftSpecifications={draftSpecifications}
              onDraftSpecificationsChange={setDraftSpecifications}
              onPersistedSpecificationsChange={setPersistedSpecifications}
            />

            <AdminCard className="product-editor-panel space-y-2 p-2.5">
              <div className="product-editor-panel-heading">
                <h2 className="text-base font-black text-white">
                  Dimensiones y peso
                </h2>
                <p className="mt-0.5 text-10px leading-4 text-white/44">
                  Andreani utiliza estos datos para calcular el costo del paquete.
                </p>
              </div>
              <div className="product-editor-logistics-grid grid gap-1.5">
                {PRODUCT_LOGISTICS_FIELDS.map(({ key, unit }) => {
                  const label = {
                    peso_empaquetado_kg: "Peso",
                    alto_paquete_cm: "Profundidad",
                    ancho_paquete_cm: "Ancho",
                    largo_paquete_cm: "Largo",
                  }[key]

                  return (
                    <AdminFormField
                      key={key}
                      label={label}
                      labelClassName={productFieldLabelClassName}
                    >
                      <span className="relative block">
                        <input
                          id={key}
                          type="text"
                          inputMode="decimal"
                          value={form[key]}
                          placeholder="Opcional"
                          aria-label={`${label} en ${unit}`}
                          onChange={(event) =>
                            setField(
                              key,
                              normalizeLogisticsDecimalInput(event.target.value),
                            )
                          }
                          className={`${inputCls} !pr-9`}
                        />
                        <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-10px font-black text-white/50">
                          {unit}
                        </span>
                      </span>
                    </AdminFormField>
                  )
                })}
              </div>
            </AdminCard>
          </aside>
        </div>

        {(error || success) && (
          <div aria-live="polite" className="space-y-2">
            {error && <AdminInfoBlock tone="danger">{error}</AdminInfoBlock>}
            {success && <AdminInfoBlock tone="success">{success}</AdminInfoBlock>}
          </div>
        )}

        <div className="product-editor-actions flex flex-col-reverse gap-2 rounded-xl border p-1.5 sm:flex-row sm:items-center sm:justify-end">
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
