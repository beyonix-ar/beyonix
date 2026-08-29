"use client"

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react"
import {
  GripVertical,
  ImageIcon,
  Loader2,
  Pencil,
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
  uploadProductoVariantImages,
} from "@/lib/supabase/queries/producto-imagenes"

import {
  createProductoVariantWithAllocation,
  deleteProductoVariante,
  getProductVariantDistribution,
  getProductoVariantes,
  reorderProductoVariantes,
  updateProductoVariante,
  type ProductVariantDistribution,
} from "@/lib/supabase/queries/producto-variantes"

import { TransparencyAwareImage } from "@/components/transparency-aware-image"
import { getVariantActivationError } from "@/lib/products/product-activation"
import { deriveVariantNameFromColor, getColorName } from "@/lib/products/variant-color"
import { useStockAdjustment } from "./use-stock-adjustment"
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
  productName?: string
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
  persistedVariantStates?: Record<number, boolean>
  onPersistedVariantStatesChange?: (states: Record<number, boolean>) => void
  onDistributionChange?: (distribution: ProductVariantDistribution | null) => void
}

const inputCls =
  `${adminControlClassName} text-base`

const MAX_VARIANT_IMAGES = 9

type VariantCommercialState = "active" | "inactive"

const VARIANT_COMMERCIAL_STATE_LABELS: Record<VariantCommercialState, string> = {
  active: "Activa",
  inactive: "Inactiva",
}

const getVariantCommercialState = (
  variantActive: boolean,
  productActive: boolean,
): VariantCommercialState => {
  return variantActive && productActive ? "active" : "inactive"
}

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
  productName = "",
  productActive = false,
  primarySku = "",
  videoUrl = "",
  onPrimarySkuChange,
  fallbackImage = null,
  draftVariants = [],
  onDraftVariantsChange,
  onPersistedVariantsChange,
  persistedVariantStates = {},
  onPersistedVariantStatesChange,
  onDistributionChange,
}: ProductVariantsEditorProps) {
  const [variantes, setVariantes] =
    useState<SupabaseProductoVariante[]>([])

  const [sku, setSku] =
    useState("")

  const [colorHex, setColorHex] =
    useState("#000000")
  const [colorName, setColorName] =
    useState("")
  const [barcode, setBarcode] =
    useState("")
  const [shippingValues, setShippingValues] = useState({
    peso_empaquetado_kg: "",
    alto_paquete_cm: "",
    ancho_paquete_cm: "",
    largo_paquete_cm: "",
  })
  const [distribution, setDistribution] =
    useState<ProductVariantDistribution | null>(null)

  const [variantImages, setVariantImages] =
    useState<File[]>([])

  const [loading, setLoading] =
    useState(Boolean(productoId))
  const [variantsLoaded, setVariantsLoaded] =
    useState(!productoId)

  const [saving, setSaving] =
    useState(false)

  const [formOpen, setFormOpen] =
    useState(false)

  const [pendingDelete, setPendingDelete] =
    useState<PendingVariantDelete>(null)

  const [deleting, setDeleting] =
    useState(false)
  const [uploadingVariantId, setUploadingVariantId] =
    useState<number | null>(null)
  const [savingVariantImagesId, setSavingVariantImagesId] =
    useState<number | null>(null)
  const [savingVariantDetailsId, setSavingVariantDetailsId] =
    useState<number | null>(null)
  const [draggedVariantKey, setDraggedVariantKey] = useState<string | null>(null)
  const [reorderingVariants, setReorderingVariants] = useState(false)
  const [editingVariantKeys, setEditingVariantKeys] = useState<Set<string>>(
    () => new Set(),
  )
  const formPanelRef = useRef<HTMLElement>(null)

  const [error, setError] =
    useState("")
  const [successMessage, setSuccessMessage] =
    useState("")
  const orderedVariantes = useMemo(
    () =>
      [...variantes].sort(
        (left, right) => left.orden - right.orden || left.id - right.id,
      ),
    [variantes],
  )
  const hasVariants = productoId
    ? orderedVariantes.length > 0
    : draftVariants.length > 0
  const showCreateForm =
    formOpen || (!loading && variantsLoaded && !hasVariants)
  const primaryVariantId = orderedVariantes[0]?.id

  const loadVariantes =
    useCallback(async () => {
      if (!productoId) {
        setLoading(false)
        setVariantsLoaded(true)
        return
      }

      try {
        setLoading(true)
        setVariantsLoaded(false)
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
        setVariantsLoaded(true)
        setDistribution(stockDistribution)
      } catch (err) {
        setVariantsLoaded(false)
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

  // El resumen de Stock se renderiza en producto-form.tsx (comparte fila con
  // Financiación/Dimensiones/Estado comercial) -- se levanta el mismo estado
  // ya validado acá arriba (loadVariantes) en vez de volver a pedirlo, para
  // no duplicar el fetch ni arriesgar que muestre un número distinto al que
  // pasó el chequeo de integridad.
  useEffect(() => {
    onDistributionChange?.(distribution)
  }, [distribution, onDistributionChange])

  useEffect(() => {
    if (!formOpen || !hasVariants) return

    const frame = window.requestAnimationFrame(() => {
      formPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
    })

    return () => window.cancelAnimationFrame(frame)
  }, [formOpen, hasVariants])

  const resetFields = () => {
    setSku("")
    setColorHex("#000000")
    setColorName("")
    setBarcode("")
    setShippingValues({
      peso_empaquetado_kg: "",
      alto_paquete_cm: "",
      ancho_paquete_cm: "",
      largo_paquete_cm: "",
    })
    setVariantImages([])
    setFormOpen(false)
  }

  const closeCreateForm = () => {
    resetFields()
  }

  const addVariant = async () => {
    setError("")
    setSuccessMessage("")
    const normalizedColor = normalizeHex(colorHex)
    const cleanName = colorName.trim().toUpperCase() || deriveVariantNameFromColor(normalizedColor)

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
      color_hex: normalizedColor,
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
      setSuccessMessage("Variante agregada al borrador.")
      return
    }

    try {
      setSaving(true)

      const urls =
        variantImages.length
          ? await uploadProductoVariantImages(
              productoId,
              variantImages,
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
            // El stock nunca se asigna al crear la variante: llega
            // exclusivamente por una compra tagueada a esta variante, o por
            // un ajuste manual explícito.
            quantity: 0,
            images: urls,
            ...logistics,
          },
        )
        if (barcode.trim()) {
          created = await updateProductoVariante(productoId, created.id, {
            codigo_barra: barcode.trim(),
          })
        }
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
      resetFields()
      await loadVariantes()
      setSuccessMessage("Variante creada correctamente.")
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
        setSuccessMessage("")
        await deleteProductoVariante(productoId, id)

        const nextVariantes =
          variantes.filter(
            (variante) =>
              variante.id !== id
          )

        setVariantes(nextVariantes)
        setEditingVariantKeys((current) => {
          if (!current.has(String(id))) return current
          const next = new Set(current)
          next.delete(String(id))
          return next
        })
        if (id === primaryVariantId) {
          const nextPrimary = [...nextVariantes].sort(
            (left, right) => left.orden - right.orden || left.id - right.id,
          )[0]
          onPrimarySkuChange?.(nextPrimary?.sku ?? "")
        }
        await loadVariantes()
        setSuccessMessage("Variante eliminada correctamente.")
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
    setEditingVariantKeys((current) => {
      if (!current.has(tempId)) return current
      const next = new Set(current)
      next.delete(tempId)
      return next
    })
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
      uploadedUrls = await uploadProductoVariantImages(
        productoId,
        validFiles,
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
      const nextVariants = optimisticVariants.map((item) =>
        item.id === updated.id ? updated : item,
      )
      setVariantes(nextVariants)
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
    if (productActive && variant.activo !== false && nextImages.length === 0) {
      setError("La variante necesita al menos una imagen.")
      return
    }

    try {
      setSavingVariantImagesId(variant.id)
      setError("")
      // Se persiste primero el array sin la imagen eliminada: recién cuando
      // el catálogo confirma ese estado se borra el archivo de Storage, para
      // no dejar nunca una URL referenciada apuntando a un archivo inexistente.
      const updated = await updateProductoVariante(productoId, variant.id, {
        imagenes: nextImages,
      })
      const nextVariants = variantes.map((item) =>
        item.id === updated.id ? updated : item,
      )
      setVariantes(nextVariants)
      try {
        await deleteProductoImageByUrl(imageUrl)
      } catch (cleanupError) {
        console.error(
          "No se pudo limpiar en Storage la imagen eliminada de la variante:",
          cleanupError,
        )
      }
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
    if (!variantes.length && !draftVariants.length) setSku(primarySku)
    setFormOpen(true)
  }

  const saveVariantDetails = async (
    variant: SupabaseProductoVariante,
    details: { sku: string; colorHex: string; colorName: string; barcode: string },
  ): Promise<boolean> => {
    if (!productoId) return false

    const normalizedColor = normalizeHex(details.colorHex)
    const cleanColorName = details.colorName.trim().toUpperCase()
    if (!cleanColorName) {
      setError("El nombre del color no puede quedar vacío.")
      return false
    }

    try {
      setSavingVariantDetailsId(variant.id)
      setError("")
      setSuccessMessage("")
      // Metadata pura (SKU/color/código de barra): nunca toca stock ni pasa
      // por el sistema de asignación de pool genérico.
      const updated = await updateProductoVariante(productoId, variant.id, {
        nombre: cleanColorName,
        sku: details.sku.trim() || null,
        color_hex: normalizedColor,
        codigo_barra: details.barcode.trim() || null,
      })

      setVariantes((current) =>
        current.map((item) => (item.id === updated.id ? updated : item)),
      )
      if (updated.id === primaryVariantId) {
        onPrimarySkuChange?.(updated.sku ?? "")
      }
      setSuccessMessage("Variante actualizada correctamente.")
      return true
    } catch (detailsError) {
      setError(
        detailsError instanceof Error
          ? detailsError.message
          : "No se pudieron guardar los datos de la variante.",
      )
      return false
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

  const toggleVariantState = (variant: SupabaseProductoVariante) => {
    if (!productoId) return

    const currentActive =
      persistedVariantStates[variant.id] ?? variant.activo !== false
    const nextActive = !currentActive
    if (nextActive && !productActive) {
      setSuccessMessage("")
      setError(
        "No podés activar esta variante mientras el producto esté configurado como inactivo.",
      )
      return
    }
    if (nextActive) {
      const activationError = getVariantActivationError({
        id: variant.id,
        orden: variant.orden,
        nombre: variant.nombre,
        sku: variant.sku ?? null,
        colorHex: variant.color_hex,
        images: variant.imagenes ?? [],
        assignedStock: variant.stock ?? 0,
      })
      if (activationError) {
        setSuccessMessage("")
        setError(activationError)
        return
      }
    }

    onPersistedVariantStatesChange?.({
      ...persistedVariantStates,
      [variant.id]: nextActive,
    })
    setError("")
    setSuccessMessage("El cambio de estado está pendiente de guardar.")
  }

  const reorderVariant = async (sourceKey: string, targetKey: string) => {
    if (sourceKey === targetKey) return

    if (!productoId) {
      const sourceIndex = draftVariants.findIndex(
        (variant) => variant.tempId === sourceKey,
      )
      const targetIndex = draftVariants.findIndex(
        (variant) => variant.tempId === targetKey,
      )
      if (sourceIndex < 0 || targetIndex < 0) return

      const reordered = [...draftVariants]
      const [moved] = reordered.splice(sourceIndex, 1)
      if (!moved) return
      reordered.splice(targetIndex, 0, moved)
      onDraftVariantsChange?.(reordered)
      onPrimarySkuChange?.(reordered[0]?.sku ?? "")
      return
    }

    const sourceId = Number(sourceKey)
    const targetId = Number(targetKey)
    const sourceIndex = orderedVariantes.findIndex((variant) => variant.id === sourceId)
    const targetIndex = orderedVariantes.findIndex((variant) => variant.id === targetId)
    if (sourceIndex < 0 || targetIndex < 0) return

    const previousVariants = variantes
    const reordered = [...orderedVariantes]
    const [moved] = reordered.splice(sourceIndex, 1)
    if (!moved) return
    reordered.splice(targetIndex, 0, moved)
    const optimisticVariants = reordered.map((variant, index) => ({
      ...variant,
      orden: index + 1,
    }))

    try {
      setReorderingVariants(true)
      setError("")
      setSuccessMessage("")
      setVariantes(optimisticVariants)
      const persisted = await reorderProductoVariantes(
        productoId,
        optimisticVariants.map((variant) => variant.id),
      )
      setVariantes(persisted)
      onPrimarySkuChange?.(persisted[0]?.sku ?? "")
      setSuccessMessage("Orden de variantes actualizado.")
    } catch (reorderError) {
      setVariantes(previousVariants)
      setError(
        reorderError instanceof Error
          ? reorderError.message
          : "No se pudo actualizar el orden de las variantes.",
      )
    } finally {
      setReorderingVariants(false)
    }
  }

  const stopVariantReorder = () => {
    setDraggedVariantKey(null)
    document.body.style.cursor = ""
  }

  const handleVariantPointerDown = (
    event: ReactPointerEvent<HTMLButtonElement>,
    variantKey: string,
  ) => {
    event.preventDefault()
    setDraggedVariantKey(variantKey)
    document.body.style.cursor = "grabbing"
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const handleVariantPointerUp = async (
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => {
    event.preventDefault()
    const sourceKey = draggedVariantKey
    stopVariantReorder()

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }

    const target = document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>("[data-variant-drop-key]")
    const targetKey = target?.dataset.variantDropKey
    if (!sourceKey || !targetKey) return

    await reorderVariant(sourceKey, targetKey)
  }

  const renderVariantHandle = (variantKey: string, variantName: string) => {
    const orderedKeys = productoId
      ? orderedVariantes.map((variant) => String(variant.id))
      : draftVariants.map((variant) => variant.tempId)
    if (orderedKeys.length <= 1) {
      return null
    }
    const currentIndex = orderedKeys.indexOf(variantKey)
    const handleVariantKeyDown = (
      event: ReactKeyboardEvent<HTMLButtonElement>,
    ) => {
      const direction = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0
      if (!direction) return
      const targetKey = orderedKeys[currentIndex + direction]
      if (!targetKey) return
      event.preventDefault()
      void reorderVariant(variantKey, targetKey)
    }

    return (
      <button
        type="button"
        title="Arrastrar para cambiar el orden"
        aria-label={`Reordenar variante ${variantName}. Usá las flechas arriba y abajo.`}
        onPointerDown={(event) => handleVariantPointerDown(event, variantKey)}
        onPointerUp={handleVariantPointerUp}
        onPointerCancel={stopVariantReorder}
        onKeyDown={handleVariantKeyDown}
        disabled={reorderingVariants}
        className={`flex size-8 shrink-0 cursor-grab touch-none items-center justify-center rounded-lg border transition active:cursor-grabbing ${
          draggedVariantKey === variantKey
            ? "border-cyan-300/40 bg-cyan-300/10 text-cyan-200"
            : "border-white/8 text-white/38 hover:border-cyan-300/25 hover:text-cyan-200"
        }`}
      >
        <GripVertical className="size-3.5" aria-hidden="true" />
      </button>
    )
  }

  const { openStockAdjustment, stockAdjustmentModal } = useStockAdjustment(
    productoId,
    (updated) => {
      setVariantes((current) =>
        current.map((item) => (item.id === updated.id ? updated : item)),
      )
    },
  )

  const setVariantEditing = useCallback((key: string, editing: boolean) => {
    setEditingVariantKeys((current) => {
      const next = new Set(current)
      if (editing) next.add(key)
      else next.delete(key)
      return next
    })
  }, [])

  const renderPersistedVariant = (variante: SupabaseProductoVariante) => {
    const desiredActive =
      persistedVariantStates[variante.id] ?? variante.activo !== false

    return (
      <VariantCard
      key={variante.id}
      nombre={variante.nombre}
      productName={productName}
      sku={variante.sku}
      colorHex={variante.color_hex}
      colorName={getColorName(variante.color_hex, variante.nombre)}
      barcode={variante.codigo_barra}
      stock={variante.stock ?? 0}
      active={desiredActive}
      parentActive={productActive}
      statePending={desiredActive !== (variante.activo !== false)}
      images={variante.imagenes ?? []}
      videoUrl={videoUrl}
      fallbackImage={fallbackImage}
      onRemove={() => setPendingDelete({ kind: "persisted", variant: variante })}
      onToggleState={() => toggleVariantState(variante)}
      onAdjustStock={() => openStockAdjustment(variante)}
      onUploadImages={(files) => void uploadImagesToVariant(variante, files)}
      onMoveImage={(fromIndex, toIndex) => void moveVariantImage(variante, fromIndex, toIndex)}
      onRemoveImage={(imageIndex) => void removeVariantImage(variante, imageIndex)}
      onDetailsChange={(details) => saveVariantDetails(variante, details)}
      onEditingChange={(editing) => setVariantEditing(String(variante.id), editing)}
      uploadingImages={uploadingVariantId === variante.id}
      savingImages={savingVariantImagesId === variante.id}
      changingState={false}
      savingDetails={savingVariantDetailsId === variante.id}
      dropKey={String(variante.id)}
      leadingAccessory={renderVariantHandle(String(variante.id), variante.nombre)}
      />
    )
  }

  const renderDraftVariant = (variant: DraftProductoVariante) => (
    <VariantCard
      key={variant.tempId}
      nombre={variant.nombre}
      productName={productName}
      sku={variant.sku}
      colorHex={variant.color_hex}
      colorName={getColorName(variant.color_hex, variant.nombre)}
      barcode={null}
      stock={0}
      active
      parentActive={productActive}
      draftImages={variant.imagenes}
      videoUrl={videoUrl}
      fallbackImage={fallbackImage}
      onRemove={() => setPendingDelete({ kind: "draft", variant })}
      onUploadImages={(files) => addImagesToDraftVariant(variant.tempId, files)}
      onMoveImage={(fromIndex, toIndex) => moveDraftVariantImage(variant.tempId, fromIndex, toIndex)}
      onRemoveImage={(imageIndex) => removeDraftVariantImage(variant.tempId, imageIndex)}
      onDetailsChange={(details) => {
        const normalizedColor = normalizeHex(details.colorHex)
        onDraftVariantsChange?.(
          draftVariants.map((item) =>
            item.tempId === variant.tempId
              ? {
                  ...item,
                  nombre: details.colorName.trim().toUpperCase() || deriveVariantNameFromColor(normalizedColor),
                  sku: details.sku,
                  color_hex: normalizedColor,
                }
              : item,
          ),
        )
        return true
      }}
      onEditingChange={(editing) => setVariantEditing(variant.tempId, editing)}
      uploadingImages={false}
      savingImages={false}
      changingState={false}
      savingDetails={false}
      dropKey={variant.tempId}
      leadingAccessory={renderVariantHandle(variant.tempId, variant.nombre)}
    />
  )

  return (
    <div className="flex w-full min-w-0 flex-col gap-2.5">
      {stockAdjustmentModal}

      {error && (
        <AdminInfoBlock role="alert" tone="danger">
          {error}
        </AdminInfoBlock>
      )}

      {successMessage && (
        <AdminInfoBlock role="status" tone="success">
          {successMessage}
        </AdminInfoBlock>
      )}

      {/*
        Variantes a ancho completo: es un listado que crece con la cantidad
        de variantes, así que no comparte fila con tarjetas de altura fija
        (quedarían descalineadas apenas hubiera más de 1-2 variantes). El
        resumen de Stock, antes acá al lado, ahora se renderiza en
        producto-form.tsx junto a Financiación/Dimensiones/Estado comercial
        (ver onDistributionChange más arriba).
      */}
      <AdminCard className="product-editor-panel min-w-0 space-y-2 p-2.5">
        <div className="product-editor-panel-heading flex items-center justify-between gap-2">
          <h2 className="text-base font-black text-white">Variantes</h2>
          {!showCreateForm && hasVariants && (
            <AdminPrimaryButton
              title="Agregar una nueva variante"
              aria-label="Agregar una variante"
              onClick={openCreateForm}
              size="sm"
              className="shrink-0"
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
        ) : hasVariants ? (
          <div
            className={`product-editor-scroll-panel min-w-0 space-y-1.5 pr-1 ${
              editingVariantKeys.size > 0
                ? ""
                : "max-h-[36rem] overflow-y-auto"
            }`}
            aria-label="Variantes del producto"
          >
            {productoId
              ? orderedVariantes.map(renderPersistedVariant)
              : draftVariants.map(renderDraftVariant)}
          </div>
        ) : null}
        {showCreateForm && (
          <section
            ref={formPanelRef}
            className="product-editor-variant-form scroll-mt-6 border-t border-white/8 pt-2.5"
          >
          <div className="mb-2 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-base font-black text-white">
                Nueva variante
              </h2>
              <p className="mt-0.5 text-xs text-white">
                Completá los datos básicos y agregá sus imágenes.
              </p>
            </div>
            {hasVariants && (
              <AdminGhostButton
                title="Cerrar sin guardar"
                aria-label="Cerrar formulario de variante"
                size="icon"
                onClick={closeCreateForm}
              >
                <X className="size-4 text-white" />
              </AdminGhostButton>
            )}
          </div>

            <div className="space-y-2.5 border-t border-white/8 pt-2.5">
              <div className="grid min-w-0 gap-2.5 md:grid-cols-[minmax(180px,0.8fr)_minmax(0,2fr)]">
                <div className="min-w-0 rounded-xl border border-white/8 bg-black/15 p-2.5">
                  <p className="mb-2 text-xs font-black text-white">
                    Imágenes{" "}
                    <span className="font-normal text-white">
                      ({variantImages.length}/{MAX_VARIANT_IMAGES})
                    </span>
                  </p>
                  <DraftImageUploader
                    compact
                    maxFiles={MAX_VARIANT_IMAGES}
                    files={variantImages}
                    onChange={setVariantImages}
                    emptyMessage="Podés agregarlas ahora o más adelante."
                  />
                </div>

                <div className="grid min-w-0 content-start rounded-xl border border-white/8 bg-black/15 p-2.5">
                  <VariantFields
                    twoColumn
                    sku={sku}
                    colorHex={colorHex}
                    colorName={colorName}
                    barcode={barcode}
                    onSkuChange={setSku}
                    onColorChange={setColorHex}
                    onColorNameChange={setColorName}
                    onBarcodeChange={setBarcode}
                  />
                </div>
              </div>

            <div className="flex flex-col-reverse gap-2 border-t border-white/8 pt-2.5 sm:flex-row sm:justify-end">
              {hasVariants && (
                <AdminSecondaryButton
                  title="Cerrar sin guardar los cambios"
                  aria-label="Cancelar edición de variante"
                  onClick={closeCreateForm}
                  disabled={saving}
                  className="w-full sm:w-auto"
                >
                  Cancelar
                </AdminSecondaryButton>
              )}
              <AdminPrimaryButton
                title="Agregar esta variante al producto"
                aria-label="Crear variante"
                onClick={addVariant}
                disabled={saving}
                className="w-full sm:w-auto"
              >
                {saving ? (
                  <Loader2 className="size-4 animate-spin text-white" />
                ) : (
                  <Plus className="size-4 text-white" />
                )}
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
          <p className="mt-2 text-xs leading-5 text-white">
            {pendingDelete?.kind === "persisted"
              ? "Si tiene compras, ventas o movimientos asociados, el sistema impedirá eliminarla para proteger el inventario."
              : "Esta variante todavía no fue guardada y se quitará del formulario."}
          </p>
        </div>
      </AdminModal>
    </div>
  )
}

export function StockSummaryItem({
  label,
  value,
}: {
  label: string
  value?: number
}) {
  return (
    <div className="product-editor-metric min-w-0 rounded-lg border border-white/9 px-2 py-1.5">
      <p className="truncate text-xs font-bold leading-4 text-white">{label}</p>
      <p className="mt-0.5 text-xl font-black leading-none tabular-nums text-white">
        {value ?? "—"}
      </p>
    </div>
  )
}

interface VariantCardProps {
  nombre: string
  productName: string
  sku?: string | null
  colorHex: string
  colorName: string
  barcode?: string | null
  stock: number
  active: boolean
  parentActive?: boolean
  statePending?: boolean
  images?: string[]
  draftImages?: File[]
  videoUrl?: string
  fallbackImage?: string | null
  onRemove: () => void
  onToggleState?: () => void
  onAdjustStock?: () => void
  onUploadImages: (files: File[]) => void
  onMoveImage: (fromIndex: number, toIndex: number) => void
  onRemoveImage: (imageIndex: number) => void
  onDetailsChange: (details: {
    sku: string
    colorHex: string
    colorName: string
    barcode: string
  }) => boolean | Promise<boolean>
  onEditingChange?: (editing: boolean) => void
  uploadingImages: boolean
  savingImages: boolean
  changingState: boolean
  savingDetails: boolean
  dropKey?: string
  leadingAccessory?: ReactNode
}

function VariantCard({
  nombre,
  productName,
  sku,
  colorHex,
  colorName,
  barcode,
  stock,
  active,
  parentActive = true,
  statePending = false,
  images = [],
  draftImages = [],
  videoUrl = "",
  fallbackImage = null,
  onRemove,
  onToggleState,
  onAdjustStock,
  onUploadImages,
  onMoveImage,
  onRemoveImage,
  onDetailsChange,
  onEditingChange,
  uploadingImages,
  savingImages,
  changingState,
  savingDetails,
  dropKey,
  leadingAccessory,
}: VariantCardProps) {
  const imageInputRef = useRef<HTMLInputElement>(null)
  const [isEditing, setIsEditingState] = useState(false)
  const setIsEditing = (editing: boolean) => {
    setIsEditingState(editing)
    onEditingChange?.(editing)
  }
  const [localSku, setLocalSku] = useState((sku ?? "").toUpperCase())
  const [localColor, setLocalColor] = useState(normalizeHex(colorHex))
  const [localColorName, setLocalColorName] = useState(colorName.toUpperCase())
  const [localBarcode, setLocalBarcode] = useState(barcode ?? "")
  const [draggedImageIndex, setDraggedImageIndex] = useState<number | null>(null)
  const draftUrls = useMemo(
    () => draftImages.map((file) => URL.createObjectURL(file)),
    [draftImages],
  )

  useEffect(() => {
    return () => draftUrls.forEach((url) => URL.revokeObjectURL(url))
  }, [draftUrls])

  useEffect(() => {
    setLocalSku((sku ?? "").toUpperCase())
    setLocalColor(normalizeHex(colorHex))
    setLocalColorName(colorName.toUpperCase())
    setLocalBarcode(barcode ?? "")
  }, [colorHex, colorName, barcode, sku])

  // El nombre visible de la variante es siempre el del producto general; el
  // "nombre" propio de la variante (nombre/color) sólo identifica atributos
  // como color o SKU, nunca reemplaza el título.
  const displayName = productName.trim() || nombre
  // Agregar, borrar y reordenar imágenes leen y reescriben el array completo
  // de la variante: si dos de estas operaciones quedaran en vuelo a la vez,
  // la que responda última pisaría silenciosamente a la otra (o resucitaría
  // una URL ya borrada de Storage). Por eso se bloquean todas mientras
  // cualquiera esté en curso, no sólo la propia.
  const imagesBusy = uploadingImages || savingImages
  const ownImageCount = images.length + draftUrls.length
  const availableImages = [...images, ...draftUrls].slice(0, MAX_VARIANT_IMAGES)
  const galleryImages = availableImages
  const hasOwnImages = ownImageCount > 0
  const hasVideo = Boolean(videoUrl.trim())
  const canAddImages = ownImageCount < MAX_VARIANT_IMAGES
  const commercialState = getVariantCommercialState(active, parentActive)
  const commerciallyActive = commercialState === "active"
  const stateTooltip = !parentActive
    ? "No podés activar esta variante mientras el producto esté configurado como inactivo."
    : statePending
      ? "El cambio de estado se aplicará al guardar el producto."
      : `${commerciallyActive ? "Desactivar" : "Activar"} variante ${nombre}`
  const stateTextClassName =
    commercialState === "active"
      ? "text-emerald-300"
      : "text-white"
  const stateDotClassName =
    commercialState === "active"
      ? "bg-emerald-300"
      : "bg-white/35"
  const stateLabel =
    !onToggleState
      ? "Sin guardar"
      : changingState
        ? "Guardando…"
        : `${VARIANT_COMMERCIAL_STATE_LABELS[commercialState]}${
            statePending ? " · Pendiente" : ""
          }`

  const commitDetails = async () => {
    const success = await onDetailsChange({
      sku: localSku,
      colorHex: normalizeHex(localColor),
      colorName: localColorName,
      barcode: localBarcode,
    })
    if (success) setIsEditing(false)
  }

  if (!isEditing) {
    const summaryImage = availableImages[0] || fallbackImage

    return (
      <article
        data-variant-drop-key={dropKey}
        className="product-editor-variant-card grid min-w-0 justify-start grid-cols-[auto_auto_minmax(0,1fr)] items-center gap-x-4 gap-y-2.5 rounded-xl border border-white/10 bg-[#0c1219] p-3"
      >
        <span className="flex size-8 shrink-0 items-center justify-center" aria-hidden={!leadingAccessory}>
          {leadingAccessory}
        </span>
        <span className="relative flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-white/10 bg-[#07111b]">
          {summaryImage ? (
            <TransparencyAwareImage
              src={summaryImage}
              alt={`Imagen de ${nombre}`}
              className="size-full object-contain"
            />
          ) : (
            <ImageIcon className="size-4 text-white/25" />
          )}
        </span>

        <div className="min-w-0">
          <p className="truncate text-sm font-black text-white" title={sku?.trim() || "SKU pendiente"}>
            {sku?.trim() || "SKU pendiente"}
          </p>
        </div>

        <div className="product-editor-variant-color hidden min-w-0 items-center gap-2">
          <span
            className="size-3.5 shrink-0 rounded-full border border-white/25"
            style={{ backgroundColor: normalizeHex(colorHex) }}
          />
          <span className="truncate text-xs font-bold text-white">{colorName}</span>
        </div>

        <div className="product-editor-variant-stock hidden text-center">
          <p className="text-10px font-bold text-white">Stock</p>
          <button
            type="button"
            title={onAdjustStock ? `Ajustar stock de ${nombre}` : undefined}
            aria-label={onAdjustStock ? `Ajustar stock de ${nombre}` : undefined}
            onClick={onAdjustStock}
            disabled={!onAdjustStock}
            className={`mt-0.5 text-sm font-black tabular-nums text-white ${
              onAdjustStock ? "cursor-pointer underline decoration-white/25 decoration-dashed underline-offset-4 hover:text-beyonix-sky" : ""
            }`}
          >
            {stock}
          </button>
        </div>

        {onToggleState ? (
          <AdminSecondaryButton
            size="sm"
            title={stateTooltip}
            aria-label={`${commerciallyActive ? "Desactivar" : "Activar"} variante ${nombre}`}
            onClick={onToggleState}
            disabled={changingState}
            className="col-span-1 shrink-0"
          >
            <span className={`size-1.5 rounded-full ${stateDotClassName}`} />
            <span className={stateTextClassName}>{stateLabel}</span>
          </AdminSecondaryButton>
        ) : (
          <span className="rounded-lg border border-white/10 px-2.5 py-1.5 text-center text-xs font-bold text-white">
            {stateLabel}
          </span>
        )}

        <div className="flex items-center justify-end gap-1.5">
          <AdminSecondaryButton
            size="icon"
            title={`Editar variante ${nombre}`}
            aria-label={`Editar variante ${nombre}`}
            onClick={() => setIsEditing(true)}
          >
            <Pencil className="size-3.5 text-white" />
          </AdminSecondaryButton>
          <AdminDangerButton
            size="icon"
            title={`Eliminar variante ${nombre}`}
            aria-label={`Eliminar variante ${nombre}`}
            onClick={onRemove}
          >
            <Trash2 className="size-3.5 text-white" />
          </AdminDangerButton>
        </div>
      </article>
    )
  }

  return (
    <article className="product-editor-variant-card rounded-xl border border-white/10 bg-[#0c1219] p-3">
      <div className="mb-3 flex min-w-0 items-center justify-between gap-3 border-b border-white/8 pb-2.5">
        <div className="min-w-0 flex-1">
          <p className="text-9px font-black uppercase tracking-widest text-beyonix-sky">
            Editando variante
          </p>
          <p className="mt-0.5 flex min-w-0 items-center gap-2 truncate text-sm font-black text-white" title={nombre}>
            <span
              className="size-3 shrink-0 rounded-full border border-white/25"
              style={{ backgroundColor: normalizeHex(colorHex) }}
              aria-hidden="true"
            />
            <span className="truncate">{displayName}</span>
          </p>
          <p className="mt-0.5 text-10px text-white">
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
            title={stateTooltip}
            aria-label={`${commerciallyActive ? "Desactivar" : "Activar"} variante ${nombre}`}
            onClick={onToggleState}
            disabled={changingState}
            className="shrink-0"
          >
            <span className={`size-1.5 rounded-full ${stateDotClassName}`} />
            <span className={stateTextClassName}>{stateLabel}</span>
          </AdminSecondaryButton>
        ) : (
          <span className="shrink-0 rounded-lg border border-white/10 px-2.5 py-1.5 text-xs font-bold text-white">
            {stateLabel}
          </span>
        )}
      </div>

      <div className="grid min-w-0 gap-3 lg:grid-cols-[minmax(0,15rem)_minmax(220px,1fr)] lg:justify-start">
        <div className="min-w-0">
          <div className="mb-2 flex items-center gap-2">
            <p className="text-xs font-black text-white">Imágenes</p>
          </div>

          <div className={`grid w-full max-w-60 grid-cols-3 gap-2 ${imagesBusy ? "pointer-events-none opacity-60" : ""}`}>
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
                    <span className="flex flex-col items-center gap-1 text-9px font-bold text-white">
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
                  disabled={imagesBusy}
                  aria-label={`Agregar la imagen principal de ${nombre}`}
                  className="flex aspect-square min-w-0 cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-white/15 bg-white/[0.02] text-9px font-bold text-white transition hover:border-beyonix-sky/55 disabled:cursor-wait"
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
                  <span className="flex flex-col items-center gap-1 text-9px font-bold text-white">
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
                disabled={imagesBusy}
                aria-label={`Agregar imágenes a ${nombre}`}
                className="flex aspect-square min-w-0 cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-white/15 bg-white/[0.02] text-9px font-bold text-white transition hover:border-beyonix-sky/55 disabled:cursor-wait"
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
          <p className="mb-2 text-xs font-black text-white">Datos de la variante</p>
          <VariantFields
            sku={localSku}
            colorHex={localColor}
            colorName={localColorName}
            barcode={localBarcode}
            disabled={savingDetails}
            onSkuChange={setLocalSku}
            onColorChange={setLocalColor}
            onColorNameChange={setLocalColorName}
            onBarcodeChange={setLocalBarcode}
            onCommit={commitDetails}
            stock={stock}
            onAdjustStock={onAdjustStock}
          />
        </div>
      </div>

      <div className="mt-3 flex flex-col-reverse gap-2 border-t border-white/8 pt-2.5 sm:flex-row sm:items-center sm:justify-between">
        <AdminDangerButton
          size="sm"
          title={`Eliminar variante ${nombre}`}
          aria-label={`Eliminar variante ${nombre}`}
          onClick={onRemove}
        >
          <Trash2 className="size-3.5 text-white" />
          Eliminar variante
        </AdminDangerButton>
        <div className="flex flex-col-reverse gap-2 sm:flex-row">
          <AdminSecondaryButton
            size="sm"
            onClick={() => setIsEditing(false)}
            disabled={savingDetails || savingImages || uploadingImages}
          >
            Cerrar edición
          </AdminSecondaryButton>
          <AdminPrimaryButton
            size="sm"
            onClick={commitDetails}
            disabled={savingDetails}
            title="Guardar SKU, color y código de barra"
          >
            {savingDetails && <Loader2 className="size-3.5 animate-spin text-white" />}
            {savingDetails ? "Guardando…" : "Guardar datos"}
          </AdminPrimaryButton>
        </div>
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
  colorName: string
  barcode: string
  disabled?: boolean
  twoColumn?: boolean
  onSkuChange: (value: string) => void
  onColorChange: (value: string) => void
  onColorNameChange: (value: string) => void
  onBarcodeChange: (value: string) => void
  onCommit?: () => void
  stock?: number
  onAdjustStock?: () => void
}

function VariantFields({
  sku,
  colorHex,
  colorName,
  barcode,
  disabled = false,
  twoColumn = false,
  onSkuChange,
  onColorChange,
  onColorNameChange,
  onBarcodeChange,
  onCommit,
  stock,
  onAdjustStock,
}: VariantFieldsProps) {
  const commitOnEnter = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault()
      onCommit?.()
    }
  }
  const fieldClassName = twoColumn
    ? "block min-w-0"
    : "grid min-w-0 grid-cols-[7rem_minmax(0,22rem)] items-center gap-3"
  const fieldLabelClassName = twoColumn
    ? "mb-1 block text-xs font-black text-white"
    : "shrink-0 whitespace-nowrap text-xs font-black uppercase tracking-wide text-white"

  return (
    <div className={`grid gap-2 ${twoColumn ? "sm:grid-cols-2 sm:gap-2.5" : ""}`}>
      <label className={fieldClassName}>
        <span className={fieldLabelClassName}>SKU</span>
        <input
          type="text"
          value={sku}
          maxLength={120}
          placeholder="Ej.: AP01-NEGRO"
          disabled={disabled}
          onChange={(event) => onSkuChange(event.target.value.toUpperCase())}
          onKeyDown={commitOnEnter}
          className={`${inputCls} !h-10 !text-sm`}
        />
      </label>

      <label className={fieldClassName}>
        <span className={fieldLabelClassName}>Color</span>
        <span className="relative block min-w-0">
          <input
            type="text"
            value={colorName}
            placeholder="Ej.: Negro"
            aria-label="Nombre del color"
            maxLength={80}
            disabled={disabled}
            onChange={(event) => onColorNameChange(event.target.value.toUpperCase())}
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

      <label className={fieldClassName}>
        <span className={fieldLabelClassName}>Cód. de barra</span>
        <input
          type="text"
          value={barcode}
          placeholder="Opcional"
          maxLength={64}
          disabled={disabled}
          onChange={(event) => onBarcodeChange(event.target.value)}
          onKeyDown={commitOnEnter}
          className={`${inputCls} !h-10 !text-sm`}
        />
      </label>

      {!twoColumn && onAdjustStock && (
        <div className={fieldClassName}>
          <span className={fieldLabelClassName}>Stock</span>
          <div className="flex min-w-0 items-center gap-2">
            <span className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-lg border border-white/8 bg-black/15 px-3 text-sm font-black tabular-nums text-white">
              {stock ?? 0} <span className="text-xs font-bold text-white">unidades</span>
            </span>
            <AdminSecondaryButton size="sm" onClick={onAdjustStock}>
              Ajustar stock
            </AdminSecondaryButton>
          </div>
        </div>
      )}
    </div>
  )
}
