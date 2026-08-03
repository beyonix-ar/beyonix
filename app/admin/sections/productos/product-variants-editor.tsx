"use client"

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import {
  AlertTriangle,
  Boxes,
  ChevronDown,
  Loader2,
  Pencil,
  Plus,
  GripVertical,
  ImageIcon,
  X,
  Trash2,
} from "lucide-react"

import type {
  SupabaseProductoVariante,
} from "@/lib/supabase/types"

import type {
  DraftProductoVariante,
} from "./types"

import { DraftImageUploader } from "./draft-image-uploader"

import {
  deleteProductoImageByUrl,
  updateProductoImageOrder,
  uploadProductoImages,
} from "@/lib/supabase/queries/producto-imagenes"

import {
  createProductoVariantWithAllocation,
  deleteProductoVariante,
  getProductVariantDistribution,
  getProductoVariantes,
  updateProductoVariantWithAllocation,
  updateProductoVariante,
  type ProductVariantDistribution,
} from "@/lib/supabase/queries/producto-variantes"

import {
  updateProducto,
} from "@/lib/supabase/queries/productos"
import { TransparencyAwareImage } from "@/components/transparency-aware-image"
import { AdminVariantItem } from "./admin-variant-item"
import {
  AdminDangerButton,
  AdminCard,
  AdminGhostButton,
  AdminInfoBlock,
  AdminModal,
  AdminPrimaryButton,
  AdminSecondaryButton,
  adminControlClassName,
} from "../../components/admin-controls"
import {
  normalizeLogisticsDecimalInput,
  parseOptionalProductLogistics,
  ProductLogisticsValidationError,
  PRODUCT_LOGISTICS_FIELDS,
} from "@/lib/shipping/logistics-validation"

interface ProductVariantsEditorProps {
  productoId?: number
  fallbackImage?: string | null
  draftVariants?: DraftProductoVariante[]
  onDraftVariantsChange?: (
    variants: DraftProductoVariante[]
  ) => void
  onPersistedVariantsChange?: (
    variants: SupabaseProductoVariante[]
  ) => void
}

const inputCls =
  `${adminControlClassName} text-base`

const normalizeHex = (value: string) => {
  const clean = value.trim()

  if (/^#[0-9a-fA-F]{6}$/.test(clean)) {
    return clean.toUpperCase()
  }

  return "#000000"
}

type EditingVariant =
  | {
      kind: "draft"
      id: string
    }
  | {
      kind: "persisted"
      id: number
      imagenes: string[]
    }
  | null

type PendingVariantDelete =
  | {
      kind: "persisted"
      variant: SupabaseProductoVariante
    }
  | {
      kind: "draft"
      variant: DraftProductoVariante
    }
  | null

export function ProductVariantsEditor({
  productoId,
  fallbackImage = null,
  draftVariants = [],
  onDraftVariantsChange,
  onPersistedVariantsChange,
}: ProductVariantsEditorProps) {
  const [variantes, setVariantes] =
    useState<SupabaseProductoVariante[]>([])

  const [nombre, setNombre] =
    useState("")
  const [sku, setSku] =
    useState("")

  const [colorHex, setColorHex] =
    useState("#000000")
  const [cantidad, setCantidad] =
    useState("0")
  const [shippingValues, setShippingValues] = useState({
    peso_empaquetado_kg: "",
    alto_paquete_cm: "",
    ancho_paquete_cm: "",
    largo_paquete_cm: "",
  })
  const [distribution, setDistribution] =
    useState<ProductVariantDistribution | null>(null)
  const [allocations, setAllocations] =
    useState<Record<number, number>>({})

  const [variantImages, setVariantImages] =
    useState<File[]>([])
  const [persistedVariantImages, setPersistedVariantImages] =
    useState<string[]>([])
  const [draggedImageIndex, setDraggedImageIndex] =
    useState<number | null>(null)

  const [
    editingVariant,
    setEditingVariant,
  ] = useState<EditingVariant>(null)

  const [loading, setLoading] =
    useState(Boolean(productoId))

  const [saving, setSaving] =
    useState(false)

  const [formOpen, setFormOpen] =
    useState(false)

  const [pendingDelete, setPendingDelete] =
    useState<PendingVariantDelete>(null)

  const [deleting, setDeleting] =
    useState(false)

  const [selectedVariantKey, setSelectedVariantKey] =
    useState<string | null>(null)
  const formPanelRef = useRef<HTMLElement>(null)

  const [error, setError] =
    useState("")

  const loadVariantes =
    useCallback(async () => {
      if (!productoId) {
        setLoading(false)
        return
      }

      try {
        setLoading(true)
        setError("")

        const [data, stockDistribution] = await Promise.all([
          getProductoVariantes(productoId),
          getProductVariantDistribution(productoId),
        ])
        const catalogVariantIds = new Set(
          data.map((variant) => Number(variant.id)),
        )
        const distributionVariantIds = new Set(
          stockDistribution.variants.map((variant) =>
            Number(variant.variant_id),
          ),
        )
        const inconsistentCatalog =
          catalogVariantIds.size !== distributionVariantIds.size ||
          [...catalogVariantIds].some(
            (variantId) => !distributionVariantIds.has(variantId),
          )
        if (inconsistentCatalog) {
          throw new Error(
            "Las variantes y su distribución no coinciden. Recargá la pantalla; si continúa, revisá la integridad del inventario.",
          )
        }

        setVariantes(data)
        setDistribution(stockDistribution)
        setAllocations(
          Object.fromEntries(
            stockDistribution.variants.map((variant) => [
              variant.variant_id,
              variant.allocated_quantity,
            ]),
          ),
        )
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : "No se pudieron cargar las variantes."
        )
      } finally {
        setLoading(false)
      }
    }, [productoId])

  useEffect(() => {
    loadVariantes()
  }, [loadVariantes])

  useEffect(() => {
    if (productoId && !loading) {
      onPersistedVariantsChange?.(variantes)
    }
  }, [loading, onPersistedVariantsChange, productoId, variantes])

  useEffect(() => {
    if (!formOpen) return

    const frame = window.requestAnimationFrame(() => {
      formPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
    })

    return () => window.cancelAnimationFrame(frame)
  }, [editingVariant, formOpen])

  const resetFields = () => {
    setNombre("")
    setSku("")
    setColorHex("#000000")
    setCantidad("0")
    setShippingValues({
      peso_empaquetado_kg: "",
      alto_paquete_cm: "",
      ancho_paquete_cm: "",
      largo_paquete_cm: "",
    })
    setVariantImages([])
    setPersistedVariantImages([])
    setDraggedImageIndex(null)
    setEditingVariant(null)
    setFormOpen(false)
  }

  const syncPrincipalImage = async (
    nextVariantes: SupabaseProductoVariante[]
  ) => {
    if (!productoId) {
      return
    }

    const principalImage =
      [...nextVariantes]
        .sort((a, b) => {
          if (a.orden !== b.orden) return a.orden - b.orden
          return a.id - b.id
        })
        .flatMap((variante) => variante.imagenes || [])[0] || null
    const currentPrincipalImage =
      [...variantes]
        .sort((a, b) => {
          if (a.orden !== b.orden) return a.orden - b.orden
          return a.id - b.id
        })
        .flatMap((variante) => variante.imagenes || [])[0] || null

    if (principalImage === currentPrincipalImage) {
      return
    }

    await updateProducto(productoId, {
      imagen_principal: principalImage,
    })
  }

  const movePersistedImage = async (
    fromIndex: number,
    toIndex: number
  ) => {
    if (fromIndex === toIndex) {
      return
    }

    const nextImages = [...persistedVariantImages]
    const [image] = nextImages.splice(fromIndex, 1)
    nextImages.splice(toIndex, 0, image)
    setPersistedVariantImages(nextImages)

    if (!productoId || editingVariant?.kind !== "persisted") {
      return
    }

    try {
      setError("")

      const updated =
        await updateProductoVariante(
          productoId,
          editingVariant.id,
          {
            imagenes: nextImages,
          }
        )

      await updateProductoImageOrder(nextImages)

      const nextVariantes =
        variantes.map((variante) =>
          variante.id === updated.id
            ? updated
            : variante
        )

      setVariantes(nextVariantes)
      await syncPrincipalImage(nextVariantes)
    } catch (err) {
      console.error(err)
      setError(
        "No se pudo actualizar el orden de imágenes."
      )
      setPersistedVariantImages(
        editingVariant.imagenes
      )
    }
  }

  const removePersistedImage = async (
    imageUrl: string
  ) => {
    if (!productoId || editingVariant?.kind !== "persisted") {
      return
    }

    try {
      setSaving(true)
      setError("")

      const nextImages =
        persistedVariantImages.filter(
          (image) => image !== imageUrl
        )

      await deleteProductoImageByUrl(imageUrl)

      const updated =
        await updateProductoVariante(
          productoId,
          editingVariant.id,
          {
            imagenes: nextImages,
          }
        )

      const nextVariantes =
        variantes.map((variante) =>
          variante.id === updated.id
            ? updated
            : variante
        )

      setPersistedVariantImages(nextImages)
      setVariantes(nextVariantes)
      await syncPrincipalImage(nextVariantes)
    } catch (err) {
      console.error(err)
      setError(
        "No se pudo eliminar la imagen."
      )
    } finally {
      setSaving(false)
    }
  }

  const addVariant = async () => {
    setError("")
    const cleanName =
      nombre.trim()

    if (!cleanName) {
      setError(
        "El nombre de la variante es obligatorio."
      )
      return
    }
    const allocationQuantity = Number(cantidad)
    if (
      !Number.isInteger(allocationQuantity) ||
      allocationQuantity < 0
    ) {
      setError("La asignación debe ser un número entero igual o mayor que cero.")
      return
    }

    let logistics
    try {
      logistics = parseOptionalProductLogistics(shippingValues)
    } catch (validationError) {
      setError(
        validationError instanceof ProductLogisticsValidationError
          ? validationError.message
          : "Los datos de envío de la variante no son válidos.",
      )
      return
    }

    const nextVariant = {
      nombre: cleanName,
      sku: sku.trim() || null,
      color_hex:
        normalizeHex(colorHex),
    }

    if (editingVariant?.kind === "draft") {
      onDraftVariantsChange?.(
        draftVariants.map((variant) =>
          variant.tempId ===
          editingVariant.id
            ? {
                ...variant,
                ...nextVariant,
                sku: nextVariant.sku ?? "",
                imagenes:
                  variantImages,
                ...shippingValues,
              }
            : variant
        )
      )

      resetFields()
      return
    }

    if (!productoId) {
      onDraftVariantsChange?.([
        ...draftVariants,
        {
          ...nextVariant,
          sku: nextVariant.sku ?? "",
          tempId:
            crypto.randomUUID(),
          imagenes:
            variantImages,
          ...shippingValues,
        },
      ])

      resetFields()
      return
    }

    try {
      setSaving(true)

      if (editingVariant?.kind === "persisted") {
        const urls =
          variantImages.length
            ? await uploadProductoImages(
                productoId,
                variantImages,
                variantes.reduce(
                  (total, variante) =>
                    total +
                    (variante.imagenes?.length || 0),
                  0
                )
              )
            : []

        const updated = await updateProductoVariantWithAllocation(
          productoId,
          editingVariant.id,
          {
            name: nextVariant.nombre,
            sku: nextVariant.sku,
            color: nextVariant.color_hex,
            quantity: allocationQuantity,
            images: [
              ...persistedVariantImages,
              ...urls,
            ],
            ...logistics,
          },
        )
        const nextVariantes =
          variantes.map((variante) =>
            variante.id === updated.id
              ? updated
              : variante
          )

        setVariantes(nextVariantes)
        setAllocations((current) => ({
          ...current,
          [updated.id]: allocationQuantity,
        }))
        resetFields()
        let secondaryUpdateWarning = ""
        try {
          await updateProductoImageOrder(updated.imagenes || [])
          await syncPrincipalImage(nextVariantes)
        } catch (secondaryError) {
          console.error(
            "VARIANT_SECONDARY_SYNC_ERROR",
            secondaryError,
          )
          secondaryUpdateWarning =
            "La variante se guardó, pero no se pudo sincronizar su imagen principal."
        }
        await loadVariantes()
        if (secondaryUpdateWarning) setError(secondaryUpdateWarning)
        return
      }

      const urls =
        variantImages.length
          ? await uploadProductoImages(
              productoId,
              variantImages,
              variantes.reduce(
                (total, variante) =>
                  total +
                  (variante.imagenes?.length || 0),
                0
              )
            )
          : []

      let created: SupabaseProductoVariante
      try {
        created = await createProductoVariantWithAllocation(
          productoId,
          {
            name: nextVariant.nombre,
            sku: nextVariant.sku,
            color: nextVariant.color_hex,
            quantity: allocationQuantity,
            images: urls,
            ...logistics,
          },
        )
      } catch (createError) {
        for (const url of urls) {
          try {
            await deleteProductoImageByUrl(url)
          } catch (cleanupError) {
            console.error(
              "No se pudo limpiar una imagen de la variante:",
              cleanupError,
            )
          }
        }
        throw createError
      }

      const nextVariantes = [...variantes, created]
      setVariantes(nextVariantes)
      setAllocations((current) => ({
        ...current,
        [created.id]: allocationQuantity,
      }))
      resetFields()
      let secondaryUpdateWarning = ""
      try {
        await syncPrincipalImage(nextVariantes)
      } catch (secondaryError) {
        console.error(
          "VARIANT_SECONDARY_SYNC_ERROR",
          secondaryError,
        )
        secondaryUpdateWarning =
          "La variante se guardó, pero no se pudo sincronizar su imagen principal."
      }
      await loadVariantes()
      if (secondaryUpdateWarning) setError(secondaryUpdateWarning)
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "No se pudo guardar la variante."
      )
    } finally {
      setSaving(false)
    }
  }

  const removePersistedVariant =
    async (id: number) => {
      if (!productoId) return false

      try {
        setDeleting(true)
        setError("")
        await deleteProductoVariante(productoId, id)

        const nextVariantes =
          variantes.filter(
            (variante) =>
              variante.id !== id
          )

        setVariantes(nextVariantes)
        await syncPrincipalImage(
          nextVariantes
        )
        await loadVariantes()
        return true
      } catch (err) {
        console.error(err)
        setError(
          err instanceof Error
            ? err.message
            : "No se pudo eliminar la variante."
        )
        return false
      } finally {
        setDeleting(false)
      }
    }

  const removeDraftVariant = (
    tempId: string
  ) => {
    onDraftVariantsChange?.(
      draftVariants.filter(
        (variant) =>
          variant.tempId !== tempId
      )
    )
  }

  const editDraftVariant = (
    variant: DraftProductoVariante
  ) => {
    setSelectedVariantKey(`draft-${variant.tempId}`)
    setNombre(variant.nombre)
    setSku(variant.sku)
    setColorHex(variant.color_hex)
    setCantidad("0")
    setVariantImages(variant.imagenes)
    setShippingValues({
      peso_empaquetado_kg: variant.peso_empaquetado_kg,
      alto_paquete_cm: variant.alto_paquete_cm,
      ancho_paquete_cm: variant.ancho_paquete_cm,
      largo_paquete_cm: variant.largo_paquete_cm,
    })
    setPersistedVariantImages([])
    setEditingVariant({
      kind: "draft",
      id: variant.tempId,
    })
    setFormOpen(true)
  }

  const editPersistedVariant = (
    variant: SupabaseProductoVariante
  ) => {
    setSelectedVariantKey(`persisted-${variant.id}`)
    setNombre(variant.nombre)
    setSku(variant.sku ?? "")
    setColorHex(variant.color_hex)
    setCantidad(String(allocations[variant.id] ?? 0))
    setVariantImages([])
    setPersistedVariantImages(variant.imagenes || [])
    setShippingValues({
      peso_empaquetado_kg:
        variant.peso_empaquetado_kg == null
          ? ""
          : String(variant.peso_empaquetado_kg),
      alto_paquete_cm:
        variant.alto_paquete_cm == null ? "" : String(variant.alto_paquete_cm),
      ancho_paquete_cm:
        variant.ancho_paquete_cm == null
          ? ""
          : String(variant.ancho_paquete_cm),
      largo_paquete_cm:
        variant.largo_paquete_cm == null
          ? ""
          : String(variant.largo_paquete_cm),
    })
    setEditingVariant({
      kind: "persisted",
      id: variant.id,
      imagenes:
        variant.imagenes || [],
    })
    setFormOpen(true)
  }

  const openCreateForm = () => {
    resetFields()
    setFormOpen(true)
  }

  const confirmVariantDelete = async () => {
    if (!pendingDelete) return

    if (pendingDelete.kind === "draft") {
      removeDraftVariant(pendingDelete.variant.tempId)
      setPendingDelete(null)
      return
    }

    const removed = await removePersistedVariant(pendingDelete.variant.id)
    if (removed) setPendingDelete(null)
  }
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4">
      <AdminCard className="min-w-0 space-y-4 p-4 sm:p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <span className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-beyonix-sky/22 bg-beyonix-blue/24 text-beyonix-cyan">
              <Boxes className="size-5" />
            </span>
            <div className="min-w-0">
              <p className="text-xs font-black uppercase tracking-[0.16em] text-beyonix-cyan">
                Inventario
              </p>
              <h2 id="product-variants-title" className="mt-0.5 text-lg font-black text-white">
                Resumen de stock
              </h2>
              <p className="mt-1 text-sm leading-5 text-white/54">
                Estado actual de todas las opciones del producto.
              </p>
            </div>
          </div>
          {!formOpen && (
            <AdminPrimaryButton
              title="Agregar una nueva opción de venta"
              aria-label="Crear una variante"
              onClick={openCreateForm}
              className="w-full sm:w-auto"
            >
              <Plus className="size-4" />
              Crear variante
            </AdminPrimaryButton>
          )}
        </div>

        <div
          id="variant-stock-summary"
          aria-label="Resumen del inventario"
          className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,14rem),1fr))] gap-3"
        >
          <StockSummaryItem
            label="Stock total"
            value={distribution?.physicalStock}
            help="Todas las unidades registradas."
            tone="sky"
          />
          <StockSummaryItem
            label="Stock normal"
            value={distribution?.normalStock}
            help="Se vende al precio habitual."
            tone="green"
          />
          <StockSummaryItem
            label="Con descuento"
            value={distribution?.discountedStock}
            help="Producto con detalle estético o similar."
            tone="amber"
          />
          {!!distribution?.quarantineStock && (
            <StockSummaryItem
              label="En cuarentena"
              value={distribution.quarantineStock}
              help="Pendiente de revisión."
              tone="red"
            />
          )}
          {!!distribution?.nonSellableStock && (
            <StockSummaryItem
              label="No vendibles"
              value={distribution.nonSellableStock}
              help="No pueden venderse."
              tone="red"
            />
          )}
        </div>
      </AdminCard>

      {distribution && distribution.allocationOverflow > 0 && (
        <AdminInfoBlock tone="danger" icon={<AlertTriangle className="size-4" />}>
          <p>
            Hay {distribution.allocationOverflow} {distribution.allocationOverflow === 1 ? "unidad asignada" : "unidades asignadas"} de más. No edites el stock hasta revisar esta diferencia.
          </p>
        </AdminInfoBlock>
      )}

      {error && (
        <AdminInfoBlock role="alert" tone="danger">{error}</AdminInfoBlock>
      )}

      <AdminCard className="min-w-0 space-y-4 p-4 sm:p-5">
        <div className="flex items-center gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-emerald-400/20 bg-emerald-400/8 text-emerald-300">
            <Boxes className="size-4.5" />
          </span>
          <div>
            <h2 className="text-base font-black text-white">Opciones del producto</h2>
            <p className="mt-0.5 text-sm text-white/52">Imagen, identificación, stock y estado de cada variante.</p>
          </div>
        </div>
        {loading ? (
          <div className="flex h-32 items-center justify-center rounded-2xl border border-white/8 bg-black/15 text-white/45">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,28rem),1fr))] gap-4">
            {productoId ? (
              variantes.length ? (
                variantes.map((variante) => (
                  <VariantCard
                    key={variante.id}
                    nombre={variante.nombre}
                    sku={variante.sku}
                    colorHex={variante.color_hex}
                    stock={variante.stock}
                    active={variante.activo !== false}
                    images={variante.imagenes ?? []}
                    fallbackImage={fallbackImage}
                    density="comfortable"
                    selected={selectedVariantKey === `persisted-${variante.id}`}
                    onSelect={() => setSelectedVariantKey(`persisted-${variante.id}`)}
                    onEdit={() => editPersistedVariant(variante)}
                    onRemove={() => setPendingDelete({ kind: "persisted", variant: variante })}
                  />
                ))
              ) : (
                <EmptyVariants />
              )
            ) : draftVariants.length ? (
              draftVariants.map((variant) => (
                <VariantCard
                  key={variant.tempId}
                  nombre={variant.nombre}
                  sku={variant.sku}
                  colorHex={variant.color_hex}
                  stock={null}
                  active
                  draftImages={variant.imagenes}
                  fallbackImage={fallbackImage}
                  density="comfortable"
                  selected={selectedVariantKey === `draft-${variant.tempId}`}
                  onSelect={() => setSelectedVariantKey(`draft-${variant.tempId}`)}
                  onEdit={() => editDraftVariant(variant)}
                  onRemove={() => setPendingDelete({ kind: "draft", variant })}
                />
              ))
            ) : (
              <EmptyVariants />
            )}
          </div>
        )}
      </AdminCard>

      {formOpen && (
        <section ref={formPanelRef} className="admin-ds-card scroll-mt-6 p-4 sm:p-5">
          <div className="mb-6 flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-xs font-black uppercase tracking-widest text-beyonix-cyan">
                {editingVariant ? "Edición" : "Nueva opción"}
              </p>
              <h2 className="mt-1 text-xl font-black text-white sm:text-2xl">
                {editingVariant ? "Editar variante" : "Crear variante"}
              </h2>
              <p className="mt-1.5 text-sm leading-6 text-white/52">
                Este panel modifica únicamente la opción seleccionada.
              </p>
            </div>
            <AdminGhostButton
              title="Cerrar sin guardar"
              aria-label="Cerrar formulario de variante"
              size="icon"
              onClick={resetFields}
            >
              <X className="size-4" />
            </AdminGhostButton>
          </div>

          <div className="space-y-6 border-t border-white/8 pt-5">
            <div>
              <p className="mb-4 text-sm font-black text-white/78">
                Datos de la variante
              </p>
              <div className="grid min-w-0 gap-4 lg:grid-cols-2">
                <label className="min-w-0">
                  <span className="mb-2 block text-sm font-black text-white/68">Nombre *</span>
                  <input
                    type="text"
                    value={nombre}
                    placeholder="Ej.: Negro"
                    onChange={(event) => setNombre(event.target.value)}
                    className={inputCls}
                  />
                </label>
                <label className="min-w-0">
                  <span className="mb-2 block text-sm font-black text-white/68">SKU</span>
                  <input
                    type="text"
                    value={sku}
                    placeholder="Opcional"
                    aria-label="SKU de la variante"
                    maxLength={120}
                    onChange={(event) => setSku(event.target.value)}
                    className={inputCls}
                  />
                </label>
                <label className="min-w-0 lg:col-span-2">
                  <span className="mb-2 block text-sm font-black text-white/68">Color</span>
                  <span className="admin-variant-color-control flex h-11 min-w-0 items-center gap-2 rounded-xl border border-beyonix-blue-light/28 bg-[#07111b] px-2 transition hover:border-beyonix-sky/45 focus-within:border-beyonix-sky/60">
                    <span
                      className="relative size-8 shrink-0 cursor-pointer overflow-hidden rounded-lg border-2 border-white/20"
                      style={{ backgroundColor: normalizeHex(colorHex) }}
                    >
                      <input
                        type="color"
                        value={normalizeHex(colorHex)}
                        aria-label="Elegir color de la variante"
                        onChange={(event) => setColorHex(normalizeHex(event.target.value))}
                        className="absolute inset-0 size-full cursor-pointer opacity-0"
                      />
                    </span>
                    <input
                      type="text"
                      value={colorHex}
                      placeholder="#000000"
                      aria-label="Código del color"
                      onChange={(event) => setColorHex(event.target.value)}
                      onBlur={() => setColorHex(normalizeHex(colorHex))}
                      className="admin-variant-hex-input min-w-0 flex-1 bg-transparent px-1 text-sm font-bold text-white outline-none"
                    />
                  </span>
                </label>
              </div>
            </div>

            <div className="border-t border-white/8 pt-5">
              <h3 className="mb-1 text-sm font-black text-white/78">Imágenes</h3>
              <p className="mb-4 text-xs leading-5 text-white/42">
                La primera imagen será la principal de esta variante.
              </p>
              {editingVariant?.kind === "persisted" && (
                <PersistedVariantImages
                  images={persistedVariantImages}
                  draggedIndex={draggedImageIndex}
                  onDragStart={setDraggedImageIndex}
                  onMove={movePersistedImage}
                  onDragEnd={() => setDraggedImageIndex(null)}
                  onRemove={removePersistedImage}
                />
              )}
              <DraftImageUploader
                files={variantImages}
                onChange={setVariantImages}
                emptyMessage={editingVariant?.kind === "persisted" ? "Agregá imágenes nuevas si las necesitás." : "Podés agregar imágenes ahora o más adelante."}
              />
            </div>

            <details className="group overflow-hidden rounded-2xl border border-white/8 bg-black/15">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-4 text-sm font-black text-white/72">
                <span className="min-w-0">
                  <span className="block">Opciones avanzadas</span>
                  <span className="mt-0.5 block text-xs font-normal text-white/38">Stock inicial y datos de envío de esta variante.</span>
                </span>
                <ChevronDown className="size-4 shrink-0 transition-transform group-open:rotate-180" />
              </summary>
              <div className="space-y-5 border-t border-white/7 p-4 sm:p-5">
                {productoId && (
                  <label className="block max-w-sm">
                    <span className="mb-2 block text-sm font-black text-white/68">Unidades a asignar</span>
                    <input
                      type="text"
                      inputMode="numeric"
                      value={cantidad}
                      placeholder="0"
                      aria-label="Unidades normales asignadas a la variante"
                      onChange={(event) => setCantidad(event.target.value.replace(/\D/g, ""))}
                      className={`${inputCls} text-center`}
                    />
                    <span className="mt-1.5 block text-xs leading-5 text-white/40">
                      Solo usa stock normal que todavía no está asignado.
                    </span>
                  </label>
                )}
                <div>
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-black text-white/72">Datos de envío propios</p>
                    <p className="text-xs text-white/38">Si quedan vacíos, usa los datos generales.</p>
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                    {PRODUCT_LOGISTICS_FIELDS.map(({ key, label, unit }) => (
                      <label key={key} className="min-w-0">
                        <span className="mb-2 block text-sm font-black text-white/68">{label}</span>
                        <span className="relative block">
                          <input
                            type="text"
                            inputMode="decimal"
                            value={shippingValues[key]}
                            placeholder="Usar general"
                            aria-label={`${label} propio de la variante en ${unit}`}
                            onChange={(event) => setShippingValues((current) => ({
                              ...current,
                              [key]: normalizeLogisticsDecimalInput(event.target.value),
                            }))}
                            className={`${inputCls} !pr-10`}
                          />
                          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs font-black text-cyan-200/60">{unit}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              </div>
            </details>

            <div className="flex flex-col-reverse gap-2 border-t border-white/8 pt-5 sm:flex-row sm:justify-end">
              <AdminSecondaryButton
                title="Cerrar sin guardar los cambios"
                aria-label="Cancelar edición de variante"
                onClick={resetFields}
                disabled={saving}
                className="w-full sm:w-auto"
              >
                Cancelar
              </AdminSecondaryButton>
              <AdminPrimaryButton
                title={editingVariant ? "Guardar los cambios de esta variante" : "Agregar esta variante al producto"}
                aria-label={editingVariant ? "Guardar variante" : "Crear variante"}
                onClick={addVariant}
                disabled={saving}
                className="w-full sm:w-auto"
              >
                {saving ? <Loader2 className="size-4 animate-spin" /> : editingVariant ? <Pencil className="size-4" /> : <Plus className="size-4" />}
                {editingVariant ? "Guardar cambios" : "Crear variante"}
              </AdminPrimaryButton>
            </div>
          </div>
        </section>
      )}

      {productoId && distribution && (
        <details className="admin-ds-card group overflow-hidden">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-4 py-4 sm:px-5">
            <span className="min-w-0">
              <span className="block text-sm font-black text-white/74">Opciones avanzadas</span>
              <span className="mt-0.5 block text-xs text-white/38">Distribución y métricas internas del inventario.</span>
            </span>
            <ChevronDown className="size-4 shrink-0 text-white/45 transition-transform group-open:rotate-180" />
          </summary>
          <div className="border-t border-white/7 p-4 sm:p-5">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <AdvancedMetric label="Stock normal" value={distribution.normalStock} />
              <AdvancedMetric label="Reservado" value={distribution.reservedStock} />
              <AdvancedMetric label="Disponible ahora" value={distribution.availableStock} />
              <AdvancedMetric label="Asignado" value={distribution.allocatedQuantity} />
              <AdvancedMetric label="Sin asignar" value={distribution.unassignedQuantity} />
              <AdvancedMetric label="Saldo sin variante" value={distribution.genericBalance} />
            </div>
            <p className="mt-3 rounded-lg border border-white/7 bg-white/3 px-3 py-2 text-xs leading-5 text-white/45">
              Stock normal: se vende al precio habitual. Las unidades con descuento, en cuarentena o no vendibles mantienen su clasificación y no se distribuyen desde acá.
            </p>
          </div>
        </details>
      )}

      <AdminModal
        open={Boolean(pendingDelete)}
        compact
        title="Eliminar variante"
        description="Esta acción afecta únicamente a la variante seleccionada."
        onClose={() => {
          if (!deleting) setPendingDelete(null)
        }}
        footer={
          <div className="flex justify-center gap-2">
            <AdminSecondaryButton
              size="sm"
              disabled={deleting}
              onClick={() => setPendingDelete(null)}
            >
              Cancelar
            </AdminSecondaryButton>
            <AdminDangerButton
              size="sm"
              disabled={!pendingDelete || deleting}
              onClick={() => void confirmVariantDelete()}
            >
              {deleting ? "Eliminando…" : "Eliminar variante"}
            </AdminDangerButton>
          </div>
        }
      >
        <div className="rounded-xl border border-red-400/18 bg-red-400/7 p-4 text-center">
          <p className="text-sm font-black text-white">
            {pendingDelete?.variant.nombre}
          </p>
          <p className="mt-2 text-xs leading-5 text-white/55">
            {pendingDelete?.kind === "persisted"
              ? "Si tiene compras, ventas o movimientos asociados, el sistema impedirá eliminarla para proteger el inventario."
              : "Esta variante todavía no fue guardada y se quitará del formulario."}
          </p>
        </div>
      </AdminModal>
    </div>
  )
}

function EmptyVariants() {
  return (
    <div className="rounded-xl border border-dashed border-white/10 bg-black/15 px-5 py-8 text-center">
      <p className="text-base font-bold text-white/70">
        Todavía no hay variantes cargadas.
      </p>
      <p className="mt-1.5 text-sm text-white/44">
        Usá “Crear variante” para agregar la primera.
      </p>
    </div>
  )
}

function StockSummaryItem({
  label,
  value,
  help,
  tone,
}: {
  label: string
  value?: number
  help: string
  tone: "sky" | "green" | "amber" | "red"
}) {
  const tones = {
    sky: "bg-sky-400/[0.045] ring-sky-400/20 text-sky-200",
    green: "bg-emerald-400/[0.045] ring-emerald-400/20 text-emerald-200",
    amber: "bg-amber-400/[0.045] ring-amber-400/20 text-amber-200",
    red: "bg-red-400/[0.045] ring-red-400/20 text-red-200",
  }

  return (
    <div className={`flex min-h-28 min-w-0 flex-col justify-center rounded-xl px-4 py-3 ring-1 ring-inset ${tones[tone]}`}>
      <p className="truncate text-sm font-black text-white/72">{label}</p>
      <p className="mt-1.5 text-2xl font-black leading-none tabular-nums">
        {value ?? "—"}
      </p>
      <p className="mt-2 text-xs leading-4 text-white/46">{help}</p>
    </div>
  )
}

function AdvancedMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-white/8 bg-white/3 px-3 py-3 text-center">
      <p className="text-xs font-bold text-white/48">{label}</p>
      <p className="mt-1 text-lg font-black tabular-nums text-white/78">{value}</p>
    </div>
  )
}

interface PersistedVariantImagesProps {
  images: string[]
  draggedIndex: number | null
  onDragStart: (index: number) => void
  onMove: (
    fromIndex: number,
    toIndex: number
  ) => void
  onDragEnd: () => void
  onRemove: (imageUrl: string) => void
}

function PersistedVariantImages({
  images,
  draggedIndex,
  onDragStart,
  onMove,
  onDragEnd,
  onRemove,
}: PersistedVariantImagesProps) {
  if (!images.length) {
    return (
      <div className="mb-2.5 flex items-center gap-2 rounded-xl border border-white/6 bg-black/15 px-3 py-2.5">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-white/7 bg-white/3">
          <ImageIcon className="size-3.5 text-white/20" />
        </span>
        <p className="text-xs text-white/48">
          Esta variante no tiene imágenes cargadas.
        </p>
      </div>
    )
  }

  return (
    <div className="mb-3 grid grid-cols-3 gap-2 sm:grid-cols-4">
      {images.map((image, index) => (
        <div
          key={`${image}-${index}`}
          draggable
          onDragStart={(event) => {
            onDragStart(index)
            event.dataTransfer.effectAllowed = "move"
          }}
          onDragOver={(event) => {
            event.preventDefault()
          }}
          onDrop={(event) => {
            event.preventDefault()

            if (draggedIndex !== null) {
              onMove(draggedIndex, index)
            }

            onDragEnd()
          }}
          onDragEnd={onDragEnd}
          className="group relative aspect-square cursor-grab overflow-hidden rounded-xl border border-white/8 bg-beyonix-surface-3 p-1 transition-colors hover:border-[#112A43] active:cursor-grabbing"
        >
          <TransparencyAwareImage
            src={image}
            alt={`Imagen ${index + 1}`}
            className="h-full w-full rounded-xl object-contain"
          />

          {index === 0 && (
            <span className="absolute left-2 top-2 rounded-full border border-beyonix-sky/25 bg-beyonix-blue/70 px-2 py-1 text-xs font-semibold uppercase tracking-wide text-beyonix-sky">
              Principal
            </span>
          )}

          <div className="absolute inset-0 flex items-center justify-center bg-black/65 opacity-0 transition-opacity group-hover:opacity-100">
            <span className="absolute bottom-2 left-2 flex size-7 items-center justify-center rounded-lg border border-white/10 bg-black/70 text-white/60">
              <GripVertical className="size-4" />
            </span>

            <AdminDangerButton
              size="icon"
              aria-label={`Eliminar imagen ${index + 1}`}
              title={`Eliminar imagen ${index + 1}`}
              onClick={() => onRemove(image)}
            >
              <Trash2 className="size-4" />
            </AdminDangerButton>
          </div>
        </div>
      ))}
    </div>
  )
}

interface VariantCardProps {
  nombre: string
  sku?: string | null
  colorHex: string
  stock: number | null
  active: boolean
  images?: string[]
  draftImages?: File[]
  fallbackImage?: string | null
  density?: "compact" | "comfortable"
  selected: boolean
  onSelect: () => void
  onEdit: () => void
  onRemove: () => void
}

function VariantCard({
  nombre,
  sku,
  colorHex,
  stock,
  active,
  images = [],
  draftImages = [],
  fallbackImage = null,
  density = "compact",
  selected,
  onSelect,
  onEdit,
  onRemove,
}: VariantCardProps) {
  const draftUrls = useMemo(
    () => draftImages.map((file) => URL.createObjectURL(file)),
    [draftImages],
  )

  useEffect(() => {
    return () => draftUrls.forEach((url) => URL.revokeObjectURL(url))
  }, [draftUrls])

  const availableImages = [...images, ...draftUrls]

  return (
    <AdminVariantItem
      image={availableImages[0] ?? fallbackImage}
      imageCount={availableImages.length}
      name={nombre}
      subtitle={
        availableImages.length
          ? `${availableImages.length} ${availableImages.length === 1 ? "imagen" : "imágenes"}`
          : fallbackImage
            ? "Imagen del producto"
            : "Sin imagen"
      }
      sku={sku}
      colorHex={colorHex}
      colorLabel={colorHex}
      stock={typeof stock === "number" ? stock : 0}
      stateLabel={typeof stock === "number" ? (active ? "Activa" : "Inactiva") : "Sin guardar"}
      stateTone={typeof stock === "number" ? (active ? "active" : "inactive") : "warning"}
      selected={selected}
      density={density}
      actions={
        <>
          <AdminSecondaryButton
            size="sm"
            title={selected ? "Variante seleccionada" : `Seleccionar ${nombre}`}
            aria-label={selected ? `${nombre} seleccionada` : `Seleccionar variante ${nombre}`}
            onClick={onSelect}
            className={selected ? "border-cyan-300/35 bg-cyan-300/12 text-cyan-100" : ""}
          >
            {selected ? "Seleccionada" : "Seleccionar"}
          </AdminSecondaryButton>
          <AdminSecondaryButton
            size="icon"
            title={`Abrir el formulario completo de ${nombre}`}
            aria-label={`Editar variante ${nombre}`}
            onClick={onEdit}
          >
            <Pencil className="size-3.5" />
          </AdminSecondaryButton>
          <AdminDangerButton
            size="icon"
            title={`Eliminar únicamente la variante ${nombre}`}
            aria-label={`Eliminar variante ${nombre}`}
            onClick={onRemove}
          >
            <Trash2 className="size-3.5" />
          </AdminDangerButton>
        </>
      }
    />
  )
}
