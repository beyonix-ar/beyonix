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
  Loader2,
  Play,
  Plus,
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
  setProductoVarianteActivo,
  updateProductoVariantWithAllocation,
  updateProductoVariante,
  type ProductVariantDistribution,
} from "@/lib/supabase/queries/producto-variantes"

import {
  updateProducto,
} from "@/lib/supabase/queries/productos"
import { TransparencyAwareImage } from "@/components/transparency-aware-image"
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
  parseOptionalProductLogistics,
  ProductLogisticsValidationError,
} from "@/lib/shipping/logistics-validation"
interface ProductVariantsEditorProps {
  productoId?: number
  productActive?: boolean
  primarySku?: string
  videoUrl?: string
  onPrimarySkuChange?: (sku: string) => void
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

const MAX_VARIANT_IMAGES = 9

const normalizeHex = (value: string) => {
  const clean = value.trim()

  if (/^#[0-9a-fA-F]{6}$/.test(clean)) {
    return clean.toUpperCase()
  }

  return "#000000"
}

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
  productActive = false,
  primarySku = "",
  videoUrl = "",
  onPrimarySkuChange,
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
  const [savingVariantStateId, setSavingVariantStateId] =
    useState<number | null>(null)
  const [uploadingVariantId, setUploadingVariantId] =
    useState<number | null>(null)
  const [savingVariantImagesId, setSavingVariantImagesId] =
    useState<number | null>(null)
  const [savingVariantDetailsId, setSavingVariantDetailsId] =
    useState<number | null>(null)
  const formPanelRef = useRef<HTMLElement>(null)

  const [error, setError] =
    useState("")
  const orderedVariantes = useMemo(
    () =>
      [...variantes].sort(
        (left, right) => left.orden - right.orden || left.id - right.id,
      ),
    [variantes],
  )
  const primaryVariantId = orderedVariantes[0]?.id

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
  }, [formOpen])

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
          : "Las dimensiones y el peso de la variante no son válidos.",
      )
      return
    }

    const nextVariant = {
      nombre: cleanName,
      sku: sku.trim() || null,
      color_hex:
        normalizeHex(colorHex),
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
      if (!draftVariants.length) onPrimarySkuChange?.(nextVariant.sku ?? "")

      resetFields()
      return
    }

    try {
      setSaving(true)

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
      if (!variantes.length) onPrimarySkuChange?.(created.sku ?? "")
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
        if (id === primaryVariantId) {
          const nextPrimary = [...nextVariantes].sort(
            (left, right) => left.orden - right.orden || left.id - right.id,
          )[0]
          onPrimarySkuChange?.(nextPrimary?.sku ?? "")
        }
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
    const nextVariants = draftVariants.filter(
      (variant) => variant.tempId !== tempId,
    )
    onDraftVariantsChange?.(nextVariants)
    if (draftVariants[0]?.tempId === tempId) {
      onPrimarySkuChange?.(nextVariants[0]?.sku ?? "")
    }
  }

  const uploadImagesToVariant = async (
    variant: SupabaseProductoVariante,
    files: File[],
  ) => {
    if (!productoId) return

    const availableSlots = Math.max(
      0,
      MAX_VARIANT_IMAGES - (variant.imagenes?.length ?? 0),
    )
    const validFiles = files
      .filter((file) => file.type.startsWith("image/"))
      .slice(0, availableSlots)
    if (!availableSlots) {
      setError(`Cada variante admite hasta ${MAX_VARIANT_IMAGES} imágenes.`)
      return
    }
    if (!validFiles.length) {
      setError("Seleccioná uno o más archivos de imagen válidos.")
      return
    }

    let uploadedUrls: string[] = []
    try {
      setUploadingVariantId(variant.id)
      setError("")
      uploadedUrls = await uploadProductoImages(
        productoId,
        validFiles,
        variantes.reduce(
          (total, item) => total + (item.imagenes?.length || 0),
          0,
        ),
      )
      const updated = await updateProductoVariante(
        productoId,
        variant.id,
        { imagenes: [...(variant.imagenes ?? []), ...uploadedUrls] },
      )
      const nextVariantes = variantes.map((item) =>
        item.id === updated.id ? updated : item,
      )
      setVariantes(nextVariantes)
      try {
        await syncPrincipalImage(nextVariantes)
      } catch (syncError) {
        console.error("No se pudo sincronizar la imagen principal:", syncError)
        setError(
          "Las imágenes se cargaron, pero no se pudo sincronizar la imagen principal.",
        )
      }
    } catch (uploadError) {
      for (const url of uploadedUrls) {
        try {
          await deleteProductoImageByUrl(url)
        } catch (cleanupError) {
          console.error("No se pudo limpiar una imagen de variante:", cleanupError)
        }
      }
      setError(
        uploadError instanceof Error
          ? uploadError.message
          : "No se pudieron subir las imágenes de la variante.",
      )
    } finally {
      setUploadingVariantId(null)
    }
  }

  const moveVariantImage = async (
    variant: SupabaseProductoVariante,
    fromIndex: number,
    toIndex: number,
  ) => {
    if (!productoId || fromIndex === toIndex) return

    const previousImages = variant.imagenes ?? []
    const nextImages = [...previousImages]
    const [movedImage] = nextImages.splice(fromIndex, 1)
    if (!movedImage) return
    nextImages.splice(toIndex, 0, movedImage)

    const optimisticVariants = variantes.map((item) =>
      item.id === variant.id ? { ...item, imagenes: nextImages } : item,
    )

    try {
      setSavingVariantImagesId(variant.id)
      setError("")
      setVariantes(optimisticVariants)
      const updated = await updateProductoVariante(productoId, variant.id, {
        imagenes: nextImages,
      })
      await updateProductoImageOrder(nextImages)
      const nextVariants = optimisticVariants.map((item) =>
        item.id === updated.id ? updated : item,
      )
      setVariantes(nextVariants)
      await syncPrincipalImage(nextVariants)
    } catch (moveError) {
      setVariantes((current) =>
        current.map((item) =>
          item.id === variant.id ? { ...item, imagenes: previousImages } : item,
        ),
      )
      setError(
        moveError instanceof Error
          ? moveError.message
          : "No se pudo cambiar el orden de las imágenes.",
      )
    } finally {
      setSavingVariantImagesId(null)
    }
  }

  const removeVariantImage = async (
    variant: SupabaseProductoVariante,
    imageIndex: number,
  ) => {
    if (!productoId) return

    const previousImages = variant.imagenes ?? []
    const imageUrl = previousImages[imageIndex]
    if (!imageUrl) return
    const nextImages = previousImages.filter((_, index) => index !== imageIndex)

    try {
      setSavingVariantImagesId(variant.id)
      setError("")
      await deleteProductoImageByUrl(imageUrl)
      const updated = await updateProductoVariante(productoId, variant.id, {
        imagenes: nextImages,
      })
      const nextVariants = variantes.map((item) =>
        item.id === updated.id ? updated : item,
      )
      setVariantes(nextVariants)
      await syncPrincipalImage(nextVariants)
    } catch (removeError) {
      setError(
        removeError instanceof Error
          ? removeError.message
          : "No se pudo eliminar la imagen.",
      )
    } finally {
      setSavingVariantImagesId(null)
    }
  }

  const addImagesToDraftVariant = (tempId: string, files: File[]) => {
    const currentVariant = draftVariants.find((variant) => variant.tempId === tempId)
    const availableSlots = Math.max(
      0,
      MAX_VARIANT_IMAGES - (currentVariant?.imagenes.length ?? 0),
    )
    const validFiles = files
      .filter((file) => file.type.startsWith("image/"))
      .slice(0, availableSlots)
    if (!availableSlots) {
      setError(`Cada variante admite hasta ${MAX_VARIANT_IMAGES} imágenes.`)
      return
    }
    if (!validFiles.length) {
      setError("Seleccioná uno o más archivos de imagen válidos.")
      return
    }

    setError("")
    onDraftVariantsChange?.(
      draftVariants.map((variant) =>
        variant.tempId === tempId
          ? { ...variant, imagenes: [...variant.imagenes, ...validFiles] }
          : variant,
      ),
    )
  }

  const moveDraftVariantImage = (
    tempId: string,
    fromIndex: number,
    toIndex: number,
  ) => {
    if (fromIndex === toIndex) return

    onDraftVariantsChange?.(
      draftVariants.map((variant) => {
        if (variant.tempId !== tempId) return variant
        const nextImages = [...variant.imagenes]
        const [movedImage] = nextImages.splice(fromIndex, 1)
        if (!movedImage) return variant
        nextImages.splice(toIndex, 0, movedImage)
        return { ...variant, imagenes: nextImages }
      }),
    )
  }

  const removeDraftVariantImage = (tempId: string, imageIndex: number) => {
    onDraftVariantsChange?.(
      draftVariants.map((variant) =>
        variant.tempId === tempId
          ? {
              ...variant,
              imagenes: variant.imagenes.filter((_, index) => index !== imageIndex),
            }
          : variant,
      ),
    )
  }

  const openCreateForm = () => {
    resetFields()
    setNombre(`Variante ${variantes.length + draftVariants.length + 1}`)
    if (!variantes.length && !draftVariants.length) setSku(primarySku)
    setFormOpen(true)
  }

  const saveVariantDetails = async (
    variant: SupabaseProductoVariante,
    details: { sku: string; colorHex: string; stock: number },
  ) => {
    if (!productoId) return

    if (!Number.isInteger(details.stock) || details.stock < 0) {
      setError("El stock debe ser un número entero igual o mayor que cero.")
      return
    }

    try {
      setSavingVariantDetailsId(variant.id)
      setError("")
      const updated = await updateProductoVariantWithAllocation(
        productoId,
        variant.id,
        {
          name: variant.nombre,
          sku: details.sku.trim() || null,
          color: normalizeHex(details.colorHex),
          quantity: details.stock,
          images: variant.imagenes ?? [],
          peso_empaquetado_kg: variant.peso_empaquetado_kg ?? null,
          alto_paquete_cm: variant.alto_paquete_cm ?? null,
          ancho_paquete_cm: variant.ancho_paquete_cm ?? null,
          largo_paquete_cm: variant.largo_paquete_cm ?? null,
        },
      )

      setVariantes((current) =>
        current.map((item) => (item.id === updated.id ? updated : item)),
      )
      setAllocations((current) => ({
        ...current,
        [updated.id]: details.stock,
      }))
      if (updated.id === primaryVariantId) {
        onPrimarySkuChange?.(updated.sku ?? "")
      }
      await loadVariantes()
    } catch (detailsError) {
      setError(
        detailsError instanceof Error
          ? detailsError.message
          : "No se pudieron guardar los datos de la variante.",
      )
    } finally {
      setSavingVariantDetailsId(null)
    }
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

  const toggleVariantState = async (variant: SupabaseProductoVariante) => {
    if (!productoId) return

    const nextActive = variant.activo === false
    if (nextActive && !productActive) {
      setError("Activá primero el producto principal para habilitar esta variante.")
      return
    }

    try {
      setSavingVariantStateId(variant.id)
      setError("")
      const updated = await setProductoVarianteActivo(
        productoId,
        variant.id,
        nextActive,
      )
      setVariantes((current) =>
        current.map((item) => (item.id === updated.id ? updated : item)),
      )
    } catch (stateError) {
      setError(
        stateError instanceof Error
          ? stateError.message
          : "No se pudo cambiar el estado de la variante.",
      )
    } finally {
      setSavingVariantStateId(null)
    }
  }

  const renderPersistedVariant = (variante: SupabaseProductoVariante) => (
    <VariantCard
      key={variante.id}
      nombre={variante.nombre}
      sku={variante.sku}
      colorHex={variante.color_hex}
      stock={allocations[variante.id] ?? 0}
      active={variante.activo !== false}
      images={variante.imagenes ?? []}
      videoUrl={videoUrl}
      fallbackImage={fallbackImage}
      onRemove={() => setPendingDelete({ kind: "persisted", variant: variante })}
      onToggleState={() => void toggleVariantState(variante)}
      onUploadImages={(files) => void uploadImagesToVariant(variante, files)}
      onMoveImage={(fromIndex, toIndex) => void moveVariantImage(variante, fromIndex, toIndex)}
      onRemoveImage={(imageIndex) => void removeVariantImage(variante, imageIndex)}
      onDetailsChange={(details) => void saveVariantDetails(variante, details)}
      uploadingImages={uploadingVariantId === variante.id}
      savingImages={savingVariantImagesId === variante.id}
      changingState={savingVariantStateId === variante.id}
      savingDetails={savingVariantDetailsId === variante.id}
    />
  )

  const renderDraftVariant = (variant: DraftProductoVariante) => (
    <VariantCard
      key={variant.tempId}
      nombre={variant.nombre}
      sku={variant.sku}
      colorHex={variant.color_hex}
      stock={null}
      active
      draftImages={variant.imagenes}
      videoUrl={videoUrl}
      fallbackImage={fallbackImage}
      onRemove={() => setPendingDelete({ kind: "draft", variant })}
      onUploadImages={(files) => addImagesToDraftVariant(variant.tempId, files)}
      onMoveImage={(fromIndex, toIndex) => moveDraftVariantImage(variant.tempId, fromIndex, toIndex)}
      onRemoveImage={(imageIndex) => removeDraftVariantImage(variant.tempId, imageIndex)}
      onDetailsChange={(details) => {
        onDraftVariantsChange?.(
          draftVariants.map((item) =>
            item.tempId === variant.tempId
              ? {
                  ...item,
                  sku: details.sku,
                  color_hex: normalizeHex(details.colorHex),
                }
              : item,
          ),
        )
      }}
      uploadingImages={false}
      savingImages={false}
      changingState={false}
      savingDetails={false}
    />
  )

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
      <AdminCard className="product-editor-panel min-w-0 space-y-3 p-4">
        <div className="product-editor-panel-heading">
          <h2 id="product-variants-title" className="text-base font-black text-white">
            Stock
          </h2>
        </div>

        <div
          id="variant-stock-summary"
          aria-label="Resumen del inventario"
          className="grid grid-cols-2 gap-2 2xl:grid-cols-4"
        >
          <StockSummaryItem
            label="Stock total"
            value={distribution?.physicalStock}
          />
          <StockSummaryItem
            label="Stock normal"
            value={distribution?.normalStock}
          />
          <StockSummaryItem
            label="Stock con descuento"
            value={distribution?.discountedStock}
          />
          <StockSummaryItem
            label="Stock pendiente de resolver"
            value={distribution?.pendingReviewStock}
          />
        </div>
      </AdminCard>

      {distribution && distribution.allocationOverflow > 0 && (
        <div className="col-span-full">
        <AdminInfoBlock tone="danger" icon={<AlertTriangle className="size-4 text-white" />}>
          <p>
            Hay {distribution.allocationOverflow} {distribution.allocationOverflow === 1 ? "unidad asignada" : "unidades asignadas"} de más. No edites el stock hasta revisar esta diferencia.
          </p>
        </AdminInfoBlock>
        </div>
      )}

      {error && (
        <div className="col-span-full">
        <AdminInfoBlock role="alert" tone="danger">{error}</AdminInfoBlock>
        </div>
      )}

      <AdminCard className="product-editor-panel min-w-0 space-y-3 p-4">
        <div className="product-editor-panel-heading flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="text-base font-black text-white">Variantes</h2>
          {!formOpen && (
            <AdminPrimaryButton
              title="Agregar una nueva variante"
              aria-label="Agregar una variante"
              onClick={openCreateForm}
              className="w-full sm:w-auto"
            >
              <Plus className="size-4 text-white" />
              Agregar variante
            </AdminPrimaryButton>
          )}
        </div>
        {loading ? (
          <div className="flex h-20 items-center justify-center rounded-xl border border-white/8 bg-black/15 text-white/45">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : (
          <div className="grid min-w-0 items-start gap-3 lg:grid-cols-[minmax(0,32rem)_minmax(0,1fr)]">
            <div className="min-w-0">
              {productoId
                ? orderedVariantes[0]
                  ? renderPersistedVariant(orderedVariantes[0])
                  : <EmptyVariants />
                : draftVariants[0]
                  ? renderDraftVariant(draftVariants[0])
                  : <EmptyVariants />}
            </div>

            <div
              className="product-editor-variants-scroll max-h-96 min-w-0 space-y-2 overflow-y-auto pr-2"
              aria-label="Variantes adicionales"
            >
              {productoId
                ? orderedVariantes.slice(1).map(renderPersistedVariant)
                : draftVariants.slice(1).map(renderDraftVariant)}
            </div>
          </div>
        )}
      {formOpen && (
        <section ref={formPanelRef} className="product-editor-variant-form scroll-mt-6 border-t border-white/8 pt-3">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-base font-black text-white">
                Nueva variante
              </h2>
              <p className="mt-0.5 text-xs text-white/42">
                Completá los tres datos básicos y agregá sus imágenes.
              </p>
            </div>
            <AdminGhostButton
              title="Cerrar sin guardar"
              aria-label="Cerrar formulario de variante"
              size="icon"
              onClick={resetFields}
            >
              <X className="size-4 text-white" />
            </AdminGhostButton>
          </div>

          <div className="space-y-3 border-t border-white/8 pt-3">
              <div className="grid gap-3 lg:grid-cols-[minmax(0,15rem)_minmax(220px,20rem)] lg:justify-start">
                <div className="min-w-0 rounded-xl border border-white/8 bg-black/15 p-3">
                  <p className="mb-2 text-xs font-black text-white/72">
                    Imágenes <span className="font-normal text-white/38">({variantImages.length}/{MAX_VARIANT_IMAGES})</span>
                  </p>
                  <DraftImageUploader
                    compact
                    maxFiles={MAX_VARIANT_IMAGES}
                    files={variantImages}
                    onChange={setVariantImages}
                    emptyMessage="Podés agregarlas ahora o más adelante."
                  />
                </div>

                <div className="grid content-start gap-3 rounded-xl border border-white/8 bg-black/15 p-3">
                  <VariantFields
                    sku={sku}
                    colorHex={colorHex}
                    stock={cantidad}
                    onSkuChange={setSku}
                    onColorChange={setColorHex}
                    onStockChange={setCantidad}
                  />
                </div>
              </div>

            <div className="flex flex-col-reverse gap-2 border-t border-white/8 pt-3 sm:flex-row sm:justify-end">
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
                title="Agregar esta variante al producto"
                aria-label="Crear variante"
                onClick={addVariant}
                disabled={saving}
                className="w-full sm:w-auto"
              >
                {saving ? <Loader2 className="size-4 animate-spin text-white" /> : <Plus className="size-4 text-white" />}
                Crear variante
              </AdminPrimaryButton>
            </div>
          </div>
        </section>
      )}
      </AdminCard>

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
    <div className="product-editor-empty rounded-lg border border-dashed border-white/10 px-4 py-5 text-center">
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
}: {
  label: string
  value?: number
}) {
  return (
    <div className="product-editor-metric min-w-0 rounded-lg border border-white/9 px-3 py-2.5">
      <p className="truncate text-10px font-bold text-white/50 sm:text-xs">{label}</p>
      <p className="mt-1 text-xl font-black leading-none tabular-nums text-white">
        {value ?? "—"}
      </p>
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
  videoUrl?: string
  fallbackImage?: string | null
  onRemove: () => void
  onToggleState?: () => void
  onUploadImages: (files: File[]) => void
  onMoveImage: (fromIndex: number, toIndex: number) => void
  onRemoveImage: (imageIndex: number) => void
  onDetailsChange: (details: {
    sku: string
    colorHex: string
    stock: number
  }) => void
  uploadingImages: boolean
  savingImages: boolean
  changingState: boolean
  savingDetails: boolean
}

function VariantCard({
  nombre,
  sku,
  colorHex,
  stock,
  active,
  images = [],
  draftImages = [],
  videoUrl = "",
  fallbackImage = null,
  onRemove,
  onToggleState,
  onUploadImages,
  onMoveImage,
  onRemoveImage,
  onDetailsChange,
  uploadingImages,
  savingImages,
  changingState,
  savingDetails,
}: VariantCardProps) {
  const imageInputRef = useRef<HTMLInputElement>(null)
  const [localSku, setLocalSku] = useState(sku ?? "")
  const [localColor, setLocalColor] = useState(normalizeHex(colorHex))
  const [localStock, setLocalStock] = useState(String(stock ?? 0))
  const [draggedImageIndex, setDraggedImageIndex] = useState<number | null>(null)
  const draftUrls = useMemo(
    () => draftImages.map((file) => URL.createObjectURL(file)),
    [draftImages],
  )

  useEffect(() => {
    return () => draftUrls.forEach((url) => URL.revokeObjectURL(url))
  }, [draftUrls])

  useEffect(() => {
    setLocalSku(sku ?? "")
    setLocalColor(normalizeHex(colorHex))
    setLocalStock(String(stock ?? 0))
  }, [colorHex, sku, stock])

  const ownImageCount = images.length + draftUrls.length
  const availableImages = [...images, ...draftUrls].slice(0, MAX_VARIANT_IMAGES)
  const galleryImages = availableImages
  const hasOwnImages = ownImageCount > 0
  const hasVideo = Boolean(videoUrl.trim())
  const canAddImages = ownImageCount < MAX_VARIANT_IMAGES
  const stateLabel =
    !onToggleState
      ? "Sin guardar"
      : changingState
        ? "Guardando…"
        : active
          ? "Activa"
          : "Inactiva"

  const commitDetails = () => {
    onDetailsChange({
      sku: localSku,
      colorHex: normalizeHex(localColor),
      stock: Number(localStock || 0),
    })
  }

  return (
    <article className="product-editor-variant-card rounded-xl border border-white/10 bg-[#0c1219] p-3">
      <div className="mb-3 flex min-w-0 items-center justify-between gap-3 border-b border-white/8 pb-2.5">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-black text-white" title={nombre}>{nombre}</p>
          <p className="mt-0.5 text-10px text-white/42">
            {hasOwnImages
              ? ownImageCount > MAX_VARIANT_IMAGES
                ? `${ownImageCount} imágenes existentes · máximo ${MAX_VARIANT_IMAGES}`
                : `${ownImageCount}/${MAX_VARIANT_IMAGES} imágenes`
              : fallbackImage
                ? "Usa la imagen general"
                : "Sin imágenes"}
            {hasVideo ? " · video general incluido" : ""}
          </p>
        </div>

        {onToggleState ? (
          <AdminSecondaryButton
            size="sm"
            title={`${active ? "Desactivar" : "Activar"} variante ${nombre}`}
            aria-label={`${active ? "Desactivar" : "Activar"} variante ${nombre}`}
            onClick={onToggleState}
            disabled={changingState}
            className="shrink-0"
          >
            <span className={`size-1.5 rounded-full ${active ? "bg-emerald-300" : "bg-white/35"}`} />
            {stateLabel}
          </AdminSecondaryButton>
        ) : (
          <span className="shrink-0 rounded-lg border border-white/10 px-2.5 py-1.5 text-xs font-bold text-white/48">
            {stateLabel}
          </span>
        )}
      </div>

      <div className="grid min-w-0 gap-3 lg:grid-cols-[minmax(0,15rem)_minmax(220px,1fr)] lg:justify-start">
        <div className="min-w-0">
          <div className="mb-2 flex items-center gap-2">
            <p className="text-xs font-black text-white/68">Imágenes</p>
          </div>

          <div className={`grid w-full max-w-60 grid-cols-3 gap-2 ${savingImages ? "pointer-events-none opacity-60" : ""}`}>
            {galleryImages.map((image, index) => (
              <div key={`${image}-${index}`} className="contents">
                <div
                  draggable
                  onDragStart={(event) => {
                    setDraggedImageIndex(index)
                    event.dataTransfer.effectAllowed = "move"
                  }}
                  onDragOver={(event) => {
                    event.preventDefault()
                    event.dataTransfer.dropEffect = "move"
                  }}
                  onDrop={(event) => {
                    event.preventDefault()
                    if (draggedImageIndex !== null) {
                      onMoveImage(draggedImageIndex, index)
                    }
                    setDraggedImageIndex(null)
                  }}
                  onDragEnd={() => setDraggedImageIndex(null)}
                  className={`group relative aspect-square min-w-0 cursor-grab overflow-hidden rounded-lg border bg-[#07111b] p-0.5 transition active:cursor-grabbing ${
                    draggedImageIndex === index
                      ? "border-beyonix-sky/70 opacity-45"
                      : "border-white/10 hover:border-beyonix-sky/55"
                  }`}
                >
                  <TransparencyAwareImage
                    src={image}
                    alt={`Imagen ${index + 1} de ${nombre}`}
                    className="size-full rounded-md object-contain"
                  />
                  {index === 0 && hasOwnImages && (
                    <span className="absolute bottom-1 left-1 rounded bg-black/80 px-1 py-0.5 text-8px font-bold text-white">
                      Principal
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation()
                      onRemoveImage(index)
                    }}
                    aria-label={`Eliminar imagen ${index + 1} de ${nombre}`}
                    title={`Eliminar imagen ${index + 1}`}
                    className="absolute right-1.5 top-1.5 flex size-7 cursor-pointer items-center justify-center rounded-lg border border-red-300/35 bg-red-600/95 text-white opacity-0 shadow-lg shadow-black/35 transition hover:bg-red-500 group-hover:opacity-100 focus-visible:opacity-100"
                  >
                    <Trash2 className="size-3.5 text-white" />
                  </button>
                </div>

                {index === 0 && hasVideo && (
                  <a
                    href={videoUrl}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`Abrir video de ${nombre}`}
                    className="flex aspect-square min-w-0 items-center justify-center rounded-lg border border-beyonix-sky/20 bg-beyonix-blue/20 transition hover:border-beyonix-sky/55"
                  >
                    <span className="flex flex-col items-center gap-1 text-9px font-bold text-white/65">
                      <Play className="size-4 fill-white text-white" />
                      Video
                    </span>
                  </a>
                )}
              </div>
            ))}

            {!galleryImages.length && hasVideo && (
              <>
                <button
                  type="button"
                  onClick={() => imageInputRef.current?.click()}
                  disabled={uploadingImages}
                  aria-label={`Agregar la imagen principal de ${nombre}`}
                  className="flex aspect-square min-w-0 cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-white/15 bg-white/[0.02] text-9px font-bold text-white/48 transition hover:border-beyonix-sky/55 hover:text-white disabled:cursor-wait"
                >
                  {uploadingImages
                    ? <Loader2 className="size-4 animate-spin text-white" />
                    : <Plus className="size-4 text-white" />}
                  Imagen
                </button>
                <a
                  href={videoUrl}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={`Abrir video de ${nombre}`}
                  className="flex aspect-square min-w-0 items-center justify-center rounded-lg border border-beyonix-sky/20 bg-beyonix-blue/20"
                >
                  <span className="flex flex-col items-center gap-1 text-9px font-bold text-white/65">
                    <Play className="size-4 fill-white text-white" />
                    Video
                  </span>
                </a>
              </>
            )}

            {canAddImages && (galleryImages.length > 0 || !hasVideo) && (
              <button
                type="button"
                onClick={() => imageInputRef.current?.click()}
                disabled={uploadingImages}
                aria-label={`Agregar imágenes a ${nombre}`}
                className="flex aspect-square min-w-0 cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-white/15 bg-white/[0.02] text-9px font-bold text-white/48 transition hover:border-beyonix-sky/55 hover:text-white disabled:cursor-wait"
              >
                {uploadingImages
                  ? <Loader2 className="size-4 animate-spin text-white" />
                  : <Plus className="size-4 text-white" />}
                Agregar
              </button>
            )}
          </div>
        </div>

        <div className="min-w-0 border-t border-white/8 pt-3 lg:border-l lg:border-t-0 lg:pl-4 lg:pt-0">
          <VariantFields
            sku={localSku}
            colorHex={localColor}
            stock={localStock}
            disabled={savingDetails}
            onSkuChange={setLocalSku}
            onColorChange={setLocalColor}
            onStockChange={setLocalStock}
            onCommit={commitDetails}
          />
          <div className="mt-2 flex justify-end">
            <AdminPrimaryButton
              size="sm"
              onClick={commitDetails}
              disabled={savingDetails}
              title="Guardar SKU, color y stock"
            >
              {savingDetails && <Loader2 className="size-3.5 animate-spin text-white" />}
              {savingDetails ? "Guardando…" : "Guardar datos"}
            </AdminPrimaryButton>
          </div>
        </div>
      </div>

      <div className="mt-3 flex justify-end border-t border-white/8 pt-2.5">
        <AdminDangerButton
          size="sm"
          title={`Eliminar variante ${nombre}`}
          aria-label={`Eliminar variante ${nombre}`}
          onClick={onRemove}
        >
          <Trash2 className="size-3.5 text-white" />
          Eliminar variante
        </AdminDangerButton>
      </div>

      <input
        ref={imageInputRef}
        hidden
        multiple
        type="file"
        accept="image/*"
        aria-label={`Seleccionar imágenes para ${nombre}`}
        onChange={(event) => {
          if (event.target.files) onUploadImages(Array.from(event.target.files))
          event.target.value = ""
        }}
      />
    </article>
  )
}

interface VariantFieldsProps {
  sku: string
  colorHex: string
  stock: string
  disabled?: boolean
  onSkuChange: (value: string) => void
  onColorChange: (value: string) => void
  onStockChange: (value: string) => void
  onCommit?: () => void
}

function VariantFields({
  sku,
  colorHex,
  stock,
  disabled = false,
  onSkuChange,
  onColorChange,
  onStockChange,
  onCommit,
}: VariantFieldsProps) {
  const commitOnEnter = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault()
      onCommit?.()
    }
  }

  return (
    <div className="grid gap-2.5">
      <label className="grid min-w-0 grid-cols-[64px_minmax(0,1fr)] items-center gap-3">
        <span className="text-sm font-black text-white/72">SKU</span>
        <input
          type="text"
          value={sku}
          maxLength={120}
          placeholder="Ej.: AP01-NEGRO"
          disabled={disabled}
          onChange={(event) => onSkuChange(event.target.value)}
          onKeyDown={commitOnEnter}
          className={`${inputCls} !h-10 !text-sm`}
        />
      </label>

      <label className="grid min-w-0 grid-cols-[64px_minmax(0,1fr)] items-center gap-3">
        <span className="text-sm font-black text-white/72">Color</span>
        <span className="relative block min-w-0">
          <input
            type="text"
            value={colorHex}
            placeholder="#000000"
            aria-label="Código del color"
            disabled={disabled}
            onChange={(event) => onColorChange(event.target.value)}
            onKeyDown={commitOnEnter}
            className={`${inputCls} !h-10 !pl-12 !text-sm`}
          />
          <span
            className="absolute left-2 top-1/2 size-7 -translate-y-1/2 cursor-pointer overflow-hidden rounded-lg border-2 border-white/20"
            style={{ backgroundColor: normalizeHex(colorHex) }}
          >
            <input
              type="color"
              value={normalizeHex(colorHex)}
              aria-label="Elegir color de la variante"
              disabled={disabled}
              onChange={(event) => onColorChange(normalizeHex(event.target.value))}
              className="absolute inset-0 size-full cursor-pointer opacity-0"
            />
          </span>
        </span>
      </label>

      <label className="grid min-w-0 grid-cols-[64px_minmax(0,1fr)] items-center gap-3">
        <span className="text-sm font-black text-white/72">Stock</span>
        <input
          type="text"
          inputMode="numeric"
          value={stock}
          placeholder="0"
          disabled={disabled}
          onChange={(event) => onStockChange(event.target.value.replace(/\D/g, ""))}
          onKeyDown={commitOnEnter}
          className={`${inputCls} !h-10 !text-sm tabular-nums`}
        />
      </label>
    </div>
  )
}
