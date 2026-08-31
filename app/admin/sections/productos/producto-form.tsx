"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  ArrowLeft,
  Check,
  Eye,
  Loader2,
  Play,
  Save,
  ToggleLeft,
  ToggleRight,
  X,
} from "lucide-react"

import {
  calculateTargetMarginPrice,
  simulateProductProfitability,
} from "@/lib/pricing/product-pricing"
import type { InstallmentCount } from "@/lib/products/installments"

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
import { ProductVariantsEditor, StockSummaryItem } from "./product-variants-editor"
import type { ProductVariantDistribution } from "@/lib/supabase/queries/producto-variantes"
import { AdminProductPreviewModal } from "./admin-product-preview-modal"
import { ProductPriceCard } from "./product-price-card"
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
  calculateInstallmentPlan,
  getEffectiveInstallmentPercent,
} from "@/lib/products/installments"
import { useSiteSettings } from "@/hooks/use-site-settings"
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
  "product-editor-field-label text-xs normal-case tracking-normal text-white"

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
  const [variantDistribution, setVariantDistribution] =
    useState<ProductVariantDistribution | null>(null)
  const previewObjectUrls = useRef<string[]>([])
  const leaveEditor = onCancel
  const finishProductSave = onSaved
  const { installmentsFinancing } = useSiteSettings()

  const {
    form,
    error,
    success,
    saving,
    savedId,
    categorias,
    logisticsFieldError,
    knownUnitCost,
    variantCosts,
    setField,
    showError,
    submit,
    handleNombreChange,
  } = useProductoForm({
    producto,
    onSaved: finishProductSave,
  })

  const currentProductoId = producto?.id || savedId
  // El SKU pertenece a la variante en cuanto el producto tiene al menos una:
  // la DB ya fuerza productos.sku a null en ese caso (validate_product_sku_ownership).
  // "SKU principal" sólo tiene sentido para un producto que nunca tendrá variantes.
  const hasAnyVariants = currentProductoId
    ? persistedVariants.length > 0
    : draftVariants.length > 0
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
  const eligibleInstallmentCounts: InstallmentCount[] = useMemo(
    () => [
      ...(form.cuotas2 ? [2 as const] : []),
      ...(form.cuotas3 ? [3 as const] : []),
      ...(form.cuotas6 ? [6 as const] : []),
    ],
    [form.cuotas2, form.cuotas3, form.cuotas6],
  )
  const targetMarginPercentValue = form.targetMarginPercent
    ? Number(form.targetMarginPercent)
    : null
  // Memoizado: calculateTargetMarginPrice devuelve un objeto nuevo en cada
  // llamada. Sin useMemo, el efecto de sincronización de abajo vería una
  // dependencia "distinta" en cada render (aunque el precio calculado no
  // cambie) y volvería a ejecutar setField -> nuevo render -> loop infinito.
  const targetMarginResult = useMemo(
    () =>
      form.pricingMode === "target_margin" &&
      knownUnitCost != null &&
      targetMarginPercentValue != null &&
      Number.isFinite(targetMarginPercentValue)
        ? calculateTargetMarginPrice({
            cost: knownUnitCost,
            targetMarginPercent: targetMarginPercentValue,
            eligibleInstallmentCounts,
            config: installmentsFinancing,
          })
        : null,
    [
      form.pricingMode,
      knownUnitCost,
      targetMarginPercentValue,
      eligibleInstallmentCounts,
      installmentsFinancing,
    ],
  )
  // En modo margen objetivo, el precio público es SIEMPRE el que calcula el
  // servidor -- este sync sólo mantiene la UI (y el campo que se manda al
  // guardar) reflejando esa misma cuenta en vivo, para que el admin vea el
  // mismo número que después va a persistir el backend autoritativamente.
  useEffect(() => {
    if (form.pricingMode !== "target_margin" || !targetMarginResult) return
    setField("precio", String(targetMarginResult.commercialPrice))
  }, [form.pricingMode, targetMarginResult, setField])
  const profitabilityPrice =
    form.pricingMode === "target_margin"
      ? (targetMarginResult?.commercialPrice ?? null)
      : Number.isFinite(currentPrice) && currentPrice > 0
        ? currentPrice
        : null
  const profitabilitySimulation =
    profitabilityPrice != null
      ? simulateProductProfitability({
          price: profitabilityPrice,
          cost: knownUnitCost ?? null,
          eligibleInstallmentCounts,
          config: installmentsFinancing,
        })
      : null
  // Regla de negocio puramente de UI: el precio anterior (el que se muestra
  // tachado) nunca puede ser menor al precio actual, o el "descuento"
  // mostrado en la tienda sería negativo. No hay CHECK constraint en DB para
  // esto -- se valida acá y se bloquea el guardado antes de llamar a submit().
  const precioAnteriorNumber = form.precio_anterior.trim()
    ? Number(form.precio_anterior)
    : null
  const precioAnteriorBelowCurrent =
    precioAnteriorNumber != null &&
    Number.isFinite(precioAnteriorNumber) &&
    Number.isFinite(currentPrice) &&
    precioAnteriorNumber < currentPrice
  const precioAnteriorError = precioAnteriorBelowCurrent
    ? "El precio anterior no puede ser menor al precio actual."
    : null
  // Costo distinto entre variantes reales (>1 fila con variantId no-null):
  // nunca se colapsa en un solo número, se muestra el detalle completo.
  const realVariantCosts = variantCosts.filter((entry) => entry.variantId != null)
  const variantCostsDiffer =
    realVariantCosts.length > 1 &&
    new Set(realVariantCosts.map((entry) => entry.unitCost)).size > 1
  const productSubtitle = [
    selectedCategoryName,
    form.sku.trim() || null,
    form.precio.trim() && Number.isFinite(currentPrice)
      ? productPriceFormatter.format(currentPrice)
      : null,
    [
      form.cuotas2 && "2 cuotas",
      form.cuotas3 && "3 cuotas",
      form.cuotas6 && "6 cuotas",
    ]
      .filter(Boolean)
      .join(" · ") || null,
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
          assignedStock: variant.stock ?? 0,
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
    persistedVariants,
    pendingVariantStates,
  ])
  const busy = saving

  const saveProduct = async () => {
    if (precioAnteriorBelowCurrent) {
      showError(precioAnteriorError ?? "El precio anterior no puede ser menor al precio actual.")
      return
    }

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
      cuotas_2_habilitadas: form.cuotas2,
      cuotas_3_habilitadas: form.cuotas3,
      cuotas_6_habilitadas: form.cuotas6,
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
    <div className={`${adminPageClassName} product-editor-screen !space-y-2.5 !p-2.5 sm:!p-3 lg:!p-4`}>
      <header className="product-editor-header flex min-w-0 items-center justify-between gap-3">
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
            <p className="text-10px font-bold text-white sm:text-xs">
              {producto ? "Editar producto" : "Crear producto"}
            </p>
            <h1 className="truncate text-xl font-black text-white sm:text-2xl">
              {form.nombre.trim() || "Producto sin nombre"}
            </h1>
            {productSubtitle.length > 0 && (
              <p className="mt-0.5 truncate text-10px text-white sm:text-xs">
                {productSubtitle.join(" · ")}
              </p>
            )}
          </div>
        </div>

        <div className="product-editor-window-actions flex shrink-0 items-center gap-1.5">
          <AdminSecondaryButton
            size="icon"
            title="Vista previa"
            aria-label="Vista previa"
            onClick={openProductPreview}
            disabled={busy}
          >
            <Eye className="size-4 text-white" />
          </AdminSecondaryButton>
          <AdminPrimaryButton
            size="icon"
            title="Guardar cambios"
            aria-label="Guardar cambios"
            onClick={() => void saveProduct()}
            disabled={busy}
          >
            {busy ? (
              <Loader2 className="size-4 animate-spin text-white" />
            ) : (
              <Save className="size-4 text-white" />
            )}
          </AdminPrimaryButton>
          <AdminSecondaryButton
            size="icon"
            title="Cancelar"
            aria-label="Cancelar"
            onClick={leaveEditor}
            className="product-editor-close-button"
          >
            <X className="size-4 text-white" />
          </AdminSecondaryButton>
        </div>
      </header>

      <form
        onSubmit={(event) => {
          event.preventDefault()
          void saveProduct()
        }}
        className="product-editor-form min-w-0 space-y-2.5"
      >
        <div className="product-editor-workspace min-w-0 gap-2.5">
          {/*
            Fila 1: Información del producto (identidad) + Precio (modo $/%,
            inputs compactos de ancho fijo, rentabilidad bajo demanda vía
            Eye) + Financiación -- las tres juntas porque Financiación afecta
            directamente cómo se calcula/vende el precio. Proporciones
            ~27/25/48 por container query sobre el ancho real del workspace
            (ver .product-editor-row-top en globals.css); 1 columna por
            debajo del umbral.
          */}
          <div className="product-editor-row-top grid min-w-0 gap-2.5 items-start">
            <div className="product-editor-cell">
              <AdminCard className="product-editor-panel flex min-w-0 flex-col space-y-2 p-2.5">
                <div className="product-editor-panel-heading">
                  <h2 id="product-information-title" className="text-base font-black text-white">
                    Información del producto
                  </h2>
                </div>

                <div className="grid min-w-0 gap-x-2.5 gap-y-1.5 sm:grid-cols-2">
                  <AdminFormField
                    label="Nombre del producto"
                    labelClassName={productFieldLabelClassName}
                    className="sm:col-span-2"
                  >
                    <input
                      id="nombre"
                      type="text"
                      value={form.nombre}
                      placeholder="Ej.: Apoyabrazos de escritorio"
                      onChange={(event) => handleNombreChange(event.target.value)}
                      className={inputCls}
                    />
                  </AdminFormField>

                  {!hasAnyVariants && (
                    <AdminFormField
                      label="SKU"
                      labelClassName={productFieldLabelClassName}
                      className="sm:col-span-2"
                    >
                      <input
                        id="sku"
                        type="text"
                        maxLength={120}
                        value={form.sku}
                        placeholder="Ej.: AP-001"
                        onChange={(event) => setField("sku", event.target.value.toUpperCase())}
                        className={inputCls}
                      />
                    </AdminFormField>
                  )}

                  <AdminFormField label="Categoría" labelClassName={productFieldLabelClassName} className="sm:col-span-2">
                    <AdminSelect title="Categoría" value={form.categoria_id} onChange={(value) => setField("categoria_id", value)}>
                      <option value="">Sin categoría</option>
                      {categorias.map((category) => (
                        <option key={category.id} value={category.id}>{category.nombre}</option>
                      ))}
                    </AdminSelect>
                  </AdminFormField>
                </div>
              </AdminCard>
            </div>

            <div className="product-editor-cell">
              <ProductPriceCard
                pricingMode={form.pricingMode}
                onPricingModeChange={(mode) => setField("pricingMode", mode)}
                precio={form.precio}
                onPrecioChange={(value) => setField("precio", value)}
                precioAnterior={form.precio_anterior}
                onPrecioAnteriorChange={(value) => setField("precio_anterior", value)}
                precioAnteriorError={precioAnteriorError}
                targetMarginPercent={form.targetMarginPercent}
                onTargetMarginPercentChange={(value) => setField("targetMarginPercent", value)}
                knownUnitCost={knownUnitCost}
                targetMarginResult={targetMarginResult}
                profitabilitySimulation={profitabilitySimulation}
                profitabilityPrice={profitabilityPrice}
                priceFormatter={productPriceFormatter}
                variantCostsDiffer={variantCostsDiffer}
                realVariantCosts={realVariantCosts}
              />
            </div>

            <div className="product-editor-cell">
              <AdminCard className="product-editor-panel flex min-w-0 flex-col space-y-2 p-2.5">
                <div className="product-editor-panel-heading">
                  <h2 className="text-base font-black text-white">Financiación</h2>
                </div>
                <div className="product-editor-financing-grid grid gap-1.5">
                  {(
                    [
                      { key: "cuotas2" as const, count: 2 as const, label: "2 cuotas" },
                      { key: "cuotas3" as const, count: 3 as const, label: "3 cuotas" },
                      { key: "cuotas6" as const, count: 6 as const, label: "6 cuotas" },
                    ]
                  ).map((toggle) => {
                    const active = form[toggle.key]
                    const plan =
                      active && Number.isFinite(currentPrice) && currentPrice > 0
                        ? calculateInstallmentPlan(currentPrice, toggle.count, installmentsFinancing)
                        : null

                    return (
                      <AdminSecondaryButton
                        key={toggle.key}
                        title={`${toggle.label} sin interés: ${active ? "habilitado" : "deshabilitado"}`}
                        aria-label={`${toggle.label} sin interés: ${active ? "habilitado" : "deshabilitado"}`}
                        aria-pressed={active}
                        onClick={() => setField(toggle.key, !active)}
                        className={`product-editor-toggle grid w-full min-h-10 grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2.5 border px-2.5 py-1.5 text-left ${active ? "product-editor-toggle-active border-emerald-400/25 bg-emerald-400/[0.07]" : "border-white/8 bg-transparent"}`}
                      >
                        {active ? (
                          <ToggleRight className="product-editor-toggle-icon size-5 shrink-0 text-emerald-300" />
                        ) : (
                          <ToggleLeft className="product-editor-inactive-icon size-5 shrink-0 text-white/42" />
                        )}
                        <span className="min-w-0 self-center">
                          <span className="block text-sm font-black text-white">
                            {toggle.label} sin interés
                          </span>
                          <span className="mt-0.5 block text-xs font-medium leading-5 text-white">
                            {plan
                              ? `${productPriceFormatter.format(plan.installmentAmount)} por cuota`
                              : "Deshabilitado"}
                          </span>
                        </span>
                      </AdminSecondaryButton>
                    )
                  })}
                </div>
                {(form.cuotas2 || form.cuotas3 || form.cuotas6) && (
                  <p className="text-xs font-medium leading-5 text-white">
                    {[
                      form.cuotas2 && `2 cuotas · costo ${getEffectiveInstallmentPercent(2, installmentsFinancing)}%`,
                      form.cuotas3 && `3 cuotas · costo ${getEffectiveInstallmentPercent(3, installmentsFinancing)}%`,
                      form.cuotas6 && `6 cuotas · costo ${getEffectiveInstallmentPercent(6, installmentsFinancing)}%`,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                )}
              </AdminCard>
            </div>
          </div>

          {/*
            Fila 2: Estado comercial + Stock -- ~38/62 por container query
            (ver .product-editor-row-commercial en globals.css). items-start
            porque Estado comercial puede crecer (bloque de "Requisitos para
            activar") mientras Stock es siempre la misma altura fija.
          */}
          <div className="product-editor-row-commercial grid min-w-0 gap-2.5 items-start">
            <div className="product-editor-cell">
              <AdminCard className="product-editor-panel flex min-w-0 flex-col space-y-2 p-2.5">
                <div className="product-editor-panel-heading">
                  <h2 className="text-base font-black text-white">Estado comercial</h2>
                </div>
                <div className="product-editor-status-grid grid gap-2">
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
                        <span className="block text-sm font-black text-white">{toggle.label}</span>
                        <span className="mt-0.5 block text-xs font-medium leading-5 text-white">{toggle.description}</span>
                      </span>
                      <span className={`w-full text-right text-sm font-black ${toggle.active ? "text-emerald-300" : "text-white"}`}>
                        {toggle.value}
                      </span>
                    </AdminSecondaryButton>
                  ))}
                </div>
                {producto && form.activo !== producto.activo && (
                  <p className="rounded-lg border border-amber-300/18 bg-amber-300/7 px-3 py-2 text-xs font-semibold leading-5 text-white">
                    El cambio de estado está pendiente. Se aplicará al guardar el producto.
                  </p>
                )}
                {!activationStatus.ready && (
                  <div className="rounded-lg border border-white/8 bg-black/18 px-2.5 py-2">
                    <p className="text-10px font-black uppercase tracking-[0.12em] text-white">
                      Requisitos para activar
                    </p>
                    <div className="mt-1.5 grid grid-cols-2 gap-x-2 gap-y-1">
                      {activationStatus.requirements.map((requirement) => (
                        <span
                          key={requirement.key}
                          className={`flex min-w-0 items-center gap-1.5 text-10px font-semibold ${
                            requirement.complete ? "text-emerald-300" : "text-white"
                          }`}
                        >
                          {requirement.complete ? (
                            <Check className="size-3 shrink-0 text-emerald-300" aria-hidden="true" />
                          ) : (
                            <X className="size-3 shrink-0 text-rose-300" aria-hidden="true" />
                          )}
                          <span className="truncate">{requirement.label}</span>
                        </span>
                      ))}
                    </div>
                    {activationStatus.firstError && (
                      <p className="mt-1.5 text-10px font-semibold leading-4 text-white">
                        {activationStatus.firstError}
                      </p>
                    )}
                  </div>
                )}
              </AdminCard>
            </div>

            <div className="product-editor-cell">
              <AdminCard className="product-editor-panel flex min-w-0 flex-col space-y-2 p-2.5">
                <div className="product-editor-panel-heading">
                  <h2 id="product-variants-title" className="text-base font-black text-white">
                    Stock
                  </h2>
                </div>
                <div
                  aria-label="Resumen del inventario"
                  className="product-editor-stock-grid grid gap-1.5"
                >
                  <StockSummaryItem label="Stock físico" value={variantDistribution?.physicalStock} />
                  <StockSummaryItem label="Stock normal" value={variantDistribution?.normalStock} />
                  <StockSummaryItem label="Stock con descuento" value={variantDistribution?.discountedStock} />
                  <StockSummaryItem label="Fallado / no vendible" value={variantDistribution?.nonSellableStock} />
                  <StockSummaryItem label="Pendiente de revisión" value={variantDistribution?.pendingReviewStock} />
                </div>
              </AdminCard>
            </div>
          </div>

          {/*
            Fila 3: Variantes (ancha) + Dimensiones y peso (angosta) -- ~68/32
            por container query (ver .product-editor-row-catalog en
            globals.css). items-start: Dimensiones es una grilla 2x2 fija,
            mucho más baja que la lista de variantes.
          */}
          <div className="product-editor-row-catalog grid min-w-0 gap-2.5 items-start">
            <div className="product-editor-cell min-w-0">
              <ProductVariantsEditor
                productoId={currentProductoId || undefined}
                productName={form.nombre}
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
                onDistributionChange={setVariantDistribution}
              />
            </div>

            <div className="product-editor-cell">
              <AdminCard className="product-editor-panel flex min-w-0 flex-col space-y-2 p-2.5">
                <div className="product-editor-panel-heading">
                  <h2 className="text-base font-black text-white">
                    Dimensiones y peso
                  </h2>
                  <p className="mt-0.5 text-xs leading-5 text-white">
                    Obligatorios: Andreani los necesita para calcular el costo del paquete.
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
                    const fieldError =
                      logisticsFieldError?.field === key
                        ? logisticsFieldError.message
                        : undefined

                    return (
                      <AdminFormField
                        key={key}
                        label={`${label} *`}
                        labelClassName={productFieldLabelClassName}
                        error={fieldError}
                      >
                        <span className="relative block">
                          <input
                            id={key}
                            type="text"
                            inputMode="decimal"
                            required
                            value={form[key]}
                            placeholder="Requerido"
                            aria-label={`${label} en ${unit} (obligatorio)`}
                            aria-required="true"
                            aria-invalid={fieldError ? "true" : undefined}
                            onChange={(event) =>
                              setField(
                                key,
                                normalizeLogisticsDecimalInput(event.target.value),
                              )
                            }
                            className={`${inputCls} !pr-9 ${fieldError ? "!border-red-400/60" : ""}`}
                          />
                          <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs font-black text-white">
                            {unit}
                          </span>
                        </span>
                      </AdminFormField>
                    )
                  })}
                </div>
              </AdminCard>
            </div>
          </div>

          {/*
            Fila 4: Especificaciones + Contenido -- 50/50 por container query
            (ver .product-editor-row-content en globals.css).
          */}
          <div className="product-editor-row-content grid min-w-0 gap-2.5 items-start">
            <div className="product-editor-cell">
              <ProductSpecificationsEditor
                productoId={currentProductoId || undefined}
                draftSpecifications={draftSpecifications}
                onDraftSpecificationsChange={setDraftSpecifications}
                onPersistedSpecificationsChange={setPersistedSpecifications}
              />
            </div>

            <div className="product-editor-cell">
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
                    <div className="relative aspect-video w-full">
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
                    className={`${inputCls} h-24 min-h-24 w-full resize-y py-2 leading-5`}
                  />
                </AdminFormField>
              </AdminCard>
            </div>
          </div>
        </div>

        {(error || success) && (
          <div aria-live="polite" className="space-y-2">
            {error && <AdminInfoBlock tone="danger">{error}</AdminInfoBlock>}
            {success && <AdminInfoBlock tone="success">{success}</AdminInfoBlock>}
          </div>
        )}
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
